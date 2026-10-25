// Offline compatibility tests: only the host test runner has Node/browser APIs.
// The production module executes in a bare vm realm, like Paperback's JSC.
// Run: node --test experiment/live/test-polyfills.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(join(root, "package.json"))("typescript");
const realm = vm.createContext({});
const absent = ["URL", "URLSearchParams", "TextEncoder", "TextDecoder", "Blob", "atob", "btoa", "Buffer", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "process", "require", "fetch"];
assert.equal(vm.runInContext(`${JSON.stringify(absent)}.filter(name => typeof globalThis[name] !== 'undefined').length`, realm), 0, "bare realm prerequisites");
const snapshot = () => vm.runInContext(`(() => {
    const targets = [globalThis];
    for (const name of ["Object", "Array", "Function", "String", "Number", "Boolean", "Promise", "JSON", "Math", "Reflect", "Symbol", "Uint8Array", "ArrayBuffer", "DataView", "RegExp", "Date", "Map", "Set", "Proxy", "Error", "TypeError"]) {
        const value = globalThis[name]; targets.push(value);
        if (value.prototype) targets.push(value.prototype);
    }
    return targets.map(target => ({ target, proto: Object.getPrototypeOf(target), descriptors: Object.getOwnPropertyDescriptors(target) }));
})()`, realm);
const before = snapshot();
const filename = join(root, "src/ComixTo/ComixPolyfills.ts");
const shims = {};
if (existsSync(filename)) {
    const source = readFileSync(filename, "utf8");
    const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
    assert.equal(result.diagnostics.length, 0, "transpilation diagnostics");
    vm.runInContext(`(function(exports) { ${result.outputText}\n })`, realm, { filename })(shims);
}
const run = (body) => vm.runInContext(`(function({TextEncoderShim, TextDecoderShim, URLShim, URLSearchParamsShim, BlobShim, atobShim, btoaShim}) { ${body}\n })`, realm)(shims);
const plain = (value) => JSON.parse(JSON.stringify(value));

// Host-native APIs are independent reference oracles, never injected into vm.
test("production realm has none of the forbidden host APIs", () => {
    assert.deepEqual(plain(vm.runInContext(`${JSON.stringify(absent)}.filter(name => typeof globalThis[name] !== 'undefined')`, realm)), []);
});

test("module exports every shim required by ComixApicore", () => {
    assert.deepEqual(Object.keys(shims).sort(), ["TextEncoderShim", "TextDecoderShim", "URLShim", "URLSearchParamsShim", "BlobShim", "atobShim", "btoaShim"].sort());
});

test("TextEncoder encodes Unicode scalars and replaces unpaired surrogates", () => {
    assert.equal(typeof shims.TextEncoderShim, "function", "missing TextEncoderShim");
    for (const input of ["", "ASCII\0", "café ✓ 中文 😀", "\ud800x\udfff", "\ud800\ud800\udc00", null, 42]) {
        assert.deepEqual(Array.from(new shims.TextEncoderShim().encode(input)), Array.from(new TextEncoder().encode(input)));
    }
    assert.deepEqual(Array.from(new shims.TextEncoderShim().encode()), []);
    assert.equal(new shims.TextEncoderShim().encoding, "utf-8");
});

test("encodeInto never splits a scalar and reports UTF-16 units consumed", () => {
    for (const input of ["😀éZ", "a\ud800中", "\udfff", ""]) {
        for (let size = 0; size <= 12; size++) {
            const dest = new Uint8Array(size).fill(0x55);
            const expected = new TextEncoder().encodeInto(input, dest);
            const actual = run(`const dest = new Uint8Array(${size}).fill(0x55); const result = new TextEncoderShim().encodeInto(${JSON.stringify(input)}, dest); return {result, bytes: Array.from(dest)};`);
            assert.deepEqual(plain(actual), { result: expected, bytes: Array.from(dest) });
        }
    }
});

test("UTF-8 decoder matches replacement, fatal, BOM and view-offset semantics", () => {
    assert.equal(typeof shims.TextDecoderShim, "function", "missing TextDecoderShim");
    const vectors = [[], [65, 0], Array.from(new TextEncoder().encode("café ✓ 中文 😀")),
        [0xef, 0xbb, 0xbf, 65], [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf],
        [0x80, 0xff, 0xc0, 0xaf], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80],
        [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x28, 0xa1], [0xe2, 0x82],
        [0xf0, 0x9f, 65, 0x80], [0xf0, 0x9f, 0x98, 0x80]];
    for (const bytes of vectors) {
        for (const options of [{}, { ignoreBOM: true }, { fatal: true }]) {
            let expected, error;
            try { expected = new TextDecoder("utf-8", options).decode(new Uint8Array(bytes)); } catch (e) { error = e; }
            const decode = () => run(`return new TextDecoderShim("utf-8", ${JSON.stringify(options)}).decode(new Uint8Array(${JSON.stringify(bytes)}));`);
            if (error) assert.throws(decode, { name: "TypeError" });
            else assert.equal(decode(), expected, JSON.stringify({bytes, options}));
        }
    }
    assert.equal(run('return new TextDecoderShim(" UTF8 ").decode(new DataView(new Uint8Array([0, 65, 66, 0]).buffer, 1, 2));'), "AB");
    assert.equal(run('return new TextDecoderShim().decode(new Uint8Array([65]).buffer);'), "A");
    assert.equal(run('return new TextDecoderShim().decode();'), "");
    assert.throws(() => new shims.TextDecoderShim("utf-16"), { name: "RangeError" });
    assert.throws(() => run('return new TextDecoderShim().decode([65]);'), { name: "TypeError" });
});

test("UTF-8 decoder rejects streaming explicitly instead of corrupting chunks", () => {
    assert.throws(() => run('return new TextDecoderShim().decode(new Uint8Array([0xe2]), {stream:true});'), /stream/i);
});

test("base64 helpers match binary-string encoding and forgiving-base64 validation", () => {
    assert.equal(typeof shims.atobShim, "function", "missing atobShim");
    assert.equal(typeof shims.btoaShim, "function", "missing btoaShim");
    for (const value of ["", "f", "fo", "foo", "\0\xff\x80", Array.from({length: 256}, (_, i) => String.fromCharCode(i)).join(""), null, 123]) {
        assert.equal(shims.btoaShim(value), btoa(value));
        assert.equal(shims.atobShim(btoa(value)), String(value));
    }
    for (const value of ["Zg", "Zg==", "Zm8", "Zm8=", "Zm9v", " Z\tf\n=\r=\f", "Zh==", "", "   "]) {
        assert.equal(shims.atobShim(value), atob(value));
    }
    for (const value of ["a", "Zg=", "=Zg=", "Zg===", "Zm9v=", "Zg==tail", "Z!g==", "_w==", "-w==", "Zg==\u00a0", "===="]) {
        assert.throws(() => shims.atobShim(value), {name: "InvalidCharacterError"}, value);
    }
    for (const value of ["✓", "😀", "\ud800", "\u0100"]) {
        assert.throws(() => shims.btoaShim(value), {name: "InvalidCharacterError"});
    }
    assert.throws(() => shims.atobShim(), {name: "TypeError"});
    assert.throws(() => shims.btoaShim(), {name: "TypeError"});
});

test("query parsing preserves repeats, decodes plus and tolerates malformed escapes", () => {
    assert.equal(typeof shims.URLSearchParamsShim, "function", "missing URLSearchParamsShim");
    const inputs = ["?q=caf%C3%A9+%2B+tea&genres[]=8&genres[]=9&&bare&=x", "x=%E2%82&y=%ZZ&z=%ED%A0%80&bom=%EF%BB%BF", "x=😀&q=\ud800", "a=b=c&&&", "", { tags: [8, 9], q: "a + b", empty: null }, [["genre[]", 8], ["genre[]", 9], ["q", " !~'()*"]]];
    for (const input of inputs) {
        const actual = new shims.URLSearchParamsShim(input);
        const expected = new URLSearchParams(input);
        assert.equal(actual.toString(), expected.toString());
        assert.deepEqual(Array.from(actual, p => Array.from(p)), Array.from(expected));
        assert.equal(actual.get("q"), expected.get("q"));
        assert.deepEqual(Array.from(actual.getAll("genre[]")), expected.getAll("genre[]"));
        assert.equal(actual.get("absent"), null);
        assert.equal(Object.prototype.toString.call(actual), "[object URLSearchParams]");
    }
    assert.equal(run('return new URLSearchParamsShim(new Map([["a", "b"]])).toString();'), "a=b");
    assert.throws(() => new shims.URLSearchParamsShim([["x"]]), { name: "TypeError" });
    assert.throws(() => new shims.URLSearchParamsShim([["x", "y", "z"]]), { name: "TypeError" });
});

test("query mutation, stable sorting and live iteration match browser semantics", () => {
    const exercise = (Ctor) => {
        const p = new Ctor("b=2&a=1&b=3");
        p.append("sp ace", "+😀"); p.set("b", "4"); p.append("a", "0");
        const result = [p.size, p.has("b"), p.has("b", "3"), p.has("b", "4")];
        p.delete("a", "1"); p.sort();
        result.push(p.toString(), Array.from(p.keys()), Array.from(p.values()), Array.from(p.entries(), pair => Array.from(pair)));
        const seen = [];
        const receiver = {};
        p.forEach(function(value, key, owner) { seen.push([value, key, owner === p, this === receiver]); }, receiver);
        result.push(seen);
        p.delete("a"); p.set("new", "x");
        const iterator = p.entries(); iterator.next(); p.append("last", "yes");
        result.push(Array.from(iterator, pair => Array.from(pair)), p.toString());
        return result;
    };
    assert.deepEqual(plain(exercise(shims.URLSearchParamsShim)), exercise(URLSearchParams));
});

test("HTTP URL resolution normalizes relative paths without losing query or fragment", () => {
    assert.equal(typeof shims.URLShim, "function", "missing URLShim");
    const base = "https://Comix.to:443/a/b/index.html?old=1#old";
    const cases = [
        ["https://EXAMPLE.com:443"], ["http://example.com:80/x"], ["https://example.com:8443/x"],
        ["../chapters?q=café+tea#héllo", base], ["/api/v1/manga?genres[]=8&genres[]=9", base],
        ["//CDN.example.com/images/a b.png", base], ["?q=new+query", base], ["#new", base], ["", base], ["?", base], ["#", base],
        ["./a/../b/./", base], ["../../../../x", base], ["/%2e/a/%2e%2e/b", base],
        ["https://user:p%40ss@example.com/a b/😀?q=' x#héllo"],
        ["/a//b/..", base], ["\\\\cdn.example.com\\image", base]
    ];
    const fields = ["href", "protocol", "hostname", "host", "port", "origin", "pathname", "search", "hash", "username", "password"];
    for (const args of cases) {
        const actual = new shims.URLShim(...args), expected = new URL(...args);
        for (const field of fields) assert.equal(actual[field], expected[field], `${JSON.stringify(args)} ${field}`);
        assert.equal(actual.toString(), expected.toString());
        assert.equal(actual.toJSON(), expected.toJSON());
        assert.equal(actual.searchParams.toString(), expected.searchParams.toString());
    }
    for (const value of ["relative", "https://", "https://bad host/", "https://x:65536/", "https://x:abc/"]) {
        assert.throws(() => new shims.URLShim(value), { name: "TypeError" }, value);
    }
    assert.throws(() => new shims.URLShim("/x", "not a URL"), { name: "TypeError" });
    assert.throws(() => new shims.URLShim("data:text/plain,x"), /HTTP/i);
    assert.throws(() => new shims.URLShim("https://例え.com"), /ASCII/i);
});

test("URL query mutations stay linked while href/search assignment preserves params identity", () => {
    const exercise = (Ctor) => {
        const url = new Ctor("https://comix.to/a?q=a%20b~#x");
        const params = url.searchParams;
        params.append("genre[]", "8"); params.append("genre[]", "9");
        const out = [url.href];
        url.search = "?new=café+tea";
        out.push(url.href, params.get("new"), params === url.searchParams);
        params.delete("new"); out.push(url.href);
        url.hash = "#héllo world"; url.pathname = "/api/../manga/😀";
        out.push(url.href);
        url.href = "http://EXAMPLE.com:80/x?a=2&a=1";
        params.sort(); out.push(url.href, params === url.searchParams, params.getAll("a"));
        url.hash = ""; url.search = ""; out.push(url.href, params.size);
        return out;
    };
    assert.deepEqual(plain(exercise(shims.URLShim)), exercise(URL));
});

test("Blob stores immutable UTF-8 and view bytes rather than zero-filled placeholders", async () => {
    assert.equal(typeof shims.BlobShim, "function", "missing BlobShim");
    const actual = await run(`return (async () => {
        const bytes = new Uint8Array([0, 255, 65, 0]);
        const blob = new BlobShim(["hé 😀", new DataView(bytes.buffer, 1, 2), new Uint8Array([66, 67]).buffer, new BlobShim(["✓"]), "\\ud800"], {type: "Text/PLAIN"});
        bytes.fill(0);
        const first = new Uint8Array(await blob.arrayBuffer()); const original = Array.from(first); first.fill(0);
        return {size: blob.size, type: blob.type, text: await blob.text(), original, second: Array.from(new Uint8Array(await blob.arrayBuffer())), tag: Object.prototype.toString.call(blob)};
    })();`);
    const bytes = new Uint8Array([0, 255, 65, 0]);
    const expected = new Blob(["hé 😀", new DataView(bytes.buffer, 1, 2), new Uint8Array([66, 67]).buffer, new Blob(["✓"]), "\ud800"], {type: "Text/PLAIN"});
    const original = Array.from(new Uint8Array(await expected.arrayBuffer()));
    assert.deepEqual(plain(actual), { size: expected.size, type: expected.type, text: await expected.text(), original, second: original, tag: "[object Blob]" });
    assert.equal(new shims.BlobShim([], {type: "a\nb"}).type, "");
    assert.equal(new shims.BlobShim().size, 0);
    assert.throws(() => new shims.BlobShim("abc"), {name: "TypeError"});
});

test("Blob slicing uses byte offsets, clamps bounds, and does not inherit MIME type", async () => {
    for (const [start, end, type] of [[undefined, undefined, undefined], [1, 5, "TEXT/PLAIN"], [-4, -1, ""], [99, 100, "x"], [5, 1, "x"], [-Infinity, Infinity, "x"], [NaN, 2.9, "x"], [0, 1, "x\ny"]]) {
        const blob = run('return new BlobShim(["é😀Z"], {type: "original/type"});').slice(start, end, type);
        const native = new Blob(["é😀Z"], {type: "original/type"}).slice(start, end, type);
        assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), Array.from(new Uint8Array(await native.arrayBuffer())));
        assert.equal(await blob.text(), await native.text());
        assert.equal(blob.type, native.type);
        assert.equal(blob.size, native.size);
    }
    assert.throws(() => new shims.BlobShim().stream(), /stream/i);
    assert.throws(() => new shims.BlobShim([], {endings:"native"}), /endings/i);
});

test("URL searchParams keeps a literal leading question mark in query names", () => {
    const url = new shims.URLShim("https://comix.to/??q=x");
    assert.equal(url.searchParams.get("?q"), "x");
    url.search = "??other=y";
    assert.equal(url.searchParams.get("?other"), "y");
    url.href = "https://comix.to/??last=z";
    assert.equal(url.searchParams.get("?last"), "z");
});

test("URL rejects unsupported numeric-host forms rather than misrepresenting the origin", () => {
    assert.equal(new shims.URLShim("http://127.0.0.1:3000").origin, "http://127.0.0.1:3000");
    for (const host of ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "999.999.999.999", "example.123", "[::1]"]) {
        assert.throws(() => new shims.URLShim(`http://${host}/`), {name: "TypeError"}, host);
    }
});

test("UTF-8 replacement agrees with the native oracle for all two-byte inputs", () => {
    const decoder = new shims.TextDecoderShim(), oracle = new TextDecoder();
    for (let a = 0; a < 256; a++) {
        for (let b = 0; b < 256; b++) {
            const bytes = new Uint8Array([a, b]);
            assert.equal(decoder.decode(bytes), oracle.decode(bytes), `bytes ${a},${b}`);
        }
    }
    let seed = 0x12345678;
    for (let i = 0; i < 4096; i++) {
        const bytes = Uint8Array.from({length: 3 + i % 6}, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; });
        assert.equal(decoder.decode(bytes), oracle.decode(bytes), `bytes ${bytes}`);
    }
});

const assertUnchanged = (after, baseline) => {
    assert.equal(after.length, baseline.length);
    for (let i = 0; i < after.length; i++) {
        assert.equal(after[i].target, baseline[i].target, `target ${i}`);
        assert.equal(after[i].proto, baseline[i].proto, `prototype ${i}`);
        assert.deepEqual(Reflect.ownKeys(after[i].descriptors), Reflect.ownKeys(baseline[i].descriptors));
        for (const key of Reflect.ownKeys(after[i].descriptors)) {
            for (const field of ["value", "get", "set", "writable", "enumerable", "configurable"]) {
                assert.ok(Object.is(after[i].descriptors[key][field], baseline[i].descriptors[key][field]), `target ${i}, ${String(key)}.${field} changed`);
            }
        }
    }
};
test("integrity detector catches replacement of an existing built-in method", () => {
    const restore = vm.runInContext(`(() => {
        const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "trim");
        Object.defineProperty(String.prototype, "trim", {...descriptor, value: function() { return "mutated"; }});
        return () => Object.defineProperty(String.prototype, "trim", descriptor);
    })()`, realm);
    try { assert.throws(() => assertUnchanged(snapshot(), before), /trim.value changed/); }
    finally { restore(); }
});

test("loading and exercising shims does not modify globals or built-ins", () => {
    assertUnchanged(snapshot(), before);
});
