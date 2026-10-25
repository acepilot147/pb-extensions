// Offline regression tests for the generated, JavaScriptCore-safe crypto API.
// Run: node --test experiment/live/test-crypto-keys.mjs
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { hmacMidstateSign, xorOffsetEncrypt } from "../crypto-pipeline/lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const constants = JSON.parse(readFileSync(resolve(ROOT, "experiment/crypto-pipeline/constants.json"), "utf8"));
const bakedKeys = {
    prefix: constants.signer.prefix,
    macBytes: constants.signer.macBytes,
    istate: constants.signer.istate.map(Number),
    ostate: constants.signer.ostate.map(Number),
};
const bakedTable = Array.from(Buffer.from(constants.decrypt.keyB64, "base64"));

function loadCrypto(root = ROOT) {
    // Deliberately omit Node/browser APIs required by neither shipped module.
    const realm = vm.createContext({});
    assert.equal(vm.runInContext("typeof Buffer + ',' + typeof TextEncoder + ',' + typeof TextDecoder + ',' + typeof URL + ',' + typeof atob", realm), "undefined,undefined,undefined,undefined,undefined");
    function load(name) {
        const source = readFileSync(resolve(root, "src/ComixTo", name + ".ts"), "utf8");
        const js = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
        }).outputText;
        const exports = {};
        vm.runInContext(`(function(exports) { ${js}\n})`, realm)(exports);
        return exports;
    }
    return { ...load("ComixFastSigner"), ...load("ComixFastDecrypt") };
}

const crypto = loadCrypto();
const plain = (value) => JSON.parse(JSON.stringify(value));
function envelope(payload, table, header = [255, 255]) {
    return { e: Buffer.from(xorOffsetEncrypt(Buffer.from(JSON.stringify(payload), "utf8"), table, header)).toString("base64") };
}
function rotatedKeys(macBytes = 19) {
    return {
        prefix: "rotated_2.", macBytes,
        istate: bakedKeys.istate.map((word, i) => (word ^ (0xa5a5a5a5 + i)) >>> 0),
        ostate: bakedKeys.ostate.map((word, i) => (word ^ (0x5a5a5a5a + i)) >>> 0),
    };
}

const signVectors = [
    ["/manga/abc/chapters", "/manga/abc/chapters"],
    ["https://comix.to/api/v1/manga?b=2&a=1", "/manga?a=1&b=2"],
    ["/api/v1/manga?z=last&keyword=%E6%97%A5%E6%9C%AC%E8%AA%9E+%F0%9F%98%80&genres[]=8&genres[]=3&order[number]=desc", "/manga?genres[0]=8&genres[1]=3&keyword=日本語 😀&order[number]=desc&z=last"],
    ["/manga?keyword=a%2Bb+%26+x%3Dy&empty&n=1&n=2", "/manga?empty=&keyword=a+b & x=y&n=1&n=2"],
    ["/日本語/😀?z=é&a=✓", "/日本語/😀?a=✓&z=é"],
    ["/manga?&&", "/manga"],
    ["/manga?x=" + "é😀".repeat(90), "/manga?x=" + "é😀".repeat(90)],
];

test("baked signer remains compatible with independent reference vectors", () => {
    for (const [raw, canonical] of signVectors) {
        const expected = hmacMidstateSign(canonical, bakedKeys);
        assert.equal(crypto.fastGenerateHash(raw), expected, raw);
        assert.equal(crypto.fastGenerateHash(raw, undefined), expected, raw);
    }
});

test("baked decrypt preserves Unicode, unwrapping, headers and passthrough", () => {
    const payload = { status: "ok", result: { title: "日本語 é ✓ 😀", text: "x".repeat(2050) } };
    const encrypted = envelope(payload, bakedTable);
    assert.deepEqual(plain(crypto.fastDecryptComixPayload("/manga", encrypted, { "X-Enc": "2" })), payload.result);
    assert.deepEqual(plain(crypto.fastDecryptComixPayload("/manga", encrypted)), payload.result);
    assert.deepEqual(plain(crypto.fastDecryptComixPayload("/manga", encrypted, {}, undefined)), payload.result);
    assert.throws(() => crypto.fastDecryptComixPayload("/manga", encrypted, { "x-enc": "99" }), /not supported/);
    for (const value of [null, 17, "plain", { status: "ok", result: 1 }, { e: 5 }]) {
        assert.equal(crypto.fastDecryptComixPayload("/manga", value), value);
    }
    const error = { status: "error", message: "missing" };
    assert.deepEqual(plain(crypto.fastDecryptComixPayload("/manga", envelope(error, bakedTable))), error);
});

test("per-request signer keys change midstates, prefix and MAC without changing defaults", () => {
    const keys = rotatedKeys();
    const before = structuredClone(keys);
    for (const [raw, canonical] of signVectors) {
        assert.equal(crypto.fastGenerateHash(raw, keys), hmacMidstateSign(canonical, keys), raw);
        assert.equal(crypto.fastGenerateHash(raw), hmacMidstateSign(canonical, bakedKeys), raw);
    }
    assert.deepEqual(keys, before, "signing must not mutate caller keys");
});

test("signer rejects invalid key shapes instead of signing or falling back", () => {
    const invalid = [{ ...rotatedKeys(), macBytes: 0 }, null, false, 0, "keys", [], {},
        ...["", "bad prefix", "x&injected=1", "x?", "x/", "x%20", "x\n", "x\r\n", "日本.", 123, null].map((prefix) => ({ ...rotatedKeys(), prefix })),
        ...[0, -1, 33, 1.5, NaN, Infinity, "12", null, undefined].map((macBytes) => ({ ...rotatedKeys(), macBytes })),
    ];
    for (const field of ["istate", "ostate"]) {
        for (const state of [null, undefined, {}, new Uint32Array(8), [], Array(7).fill(0), Array(9).fill(0), Array(8),
            ...[-1, 0x100000000, 0.5, NaN, Infinity, "1", null, undefined].map((value) => [value, ...Array(7).fill(0)])]) {
            invalid.push({ ...rotatedKeys(), [field]: state });
        }
    }
    for (const keys of invalid) {
        assert.throws(() => crypto.fastGenerateHash("/manga", keys), /Invalid Comix signer keys/, JSON.stringify(keys));
    }
});

test("signer accepts full uint32 states and every MAC length from 1 through 32", () => {
    for (let macBytes = 1; macBytes <= 32; macBytes++) {
        const keys = { prefix: "aA0._~-", macBytes, istate: Array(8).fill(0), ostate: Array(8).fill(0xffffffff) };
        assert.equal(crypto.fastGenerateHash("/manga", keys), hmacMidstateSign("/manga", keys));
    }
});

test("baked signer helper returns detached snapshots, not global switches", () => {
    assert.equal(typeof crypto.getBakedSignerKeys, "function");
    const first = crypto.getBakedSignerKeys();
    assert.deepEqual(plain(first), bakedKeys);
    first.prefix = "changed.";
    first.macBytes = 1;
    first.istate[0] = 0;
    first.ostate[0] = 0;
    const second = crypto.getBakedSignerKeys();
    assert.deepEqual(plain(second), bakedKeys);
    assert.equal(crypto.fastGenerateHash("/manga", second), hmacMidstateSign("/manga", bakedKeys));
    assert.equal(crypto.fastGenerateHash("/manga"), hmacMidstateSign("/manga", bakedKeys));
});

test("per-request decrypt table supports Unicode and wraps independently of defaults", () => {
    const table = bakedTable.map((byte, i) => (byte + i + 1) & 255);
    const before = [...table];
    const payload = { status: "ok", result: { unicode: "日本語 é ✓ 😀", body: "🌏".repeat(800) } };
    for (const header of [[0, 0], [3, 255], [255, 255]]) {
        for (const value of [payload, { status: "error", message: "非公開" }, [1, "😀"], null, true, 17, "é"]) {
            const encrypted = envelope(value, table, header);
            const expected = value?.status === "ok" ? value.result : value;
            assert.deepEqual(plain(crypto.fastDecryptComixPayload("/manga?keyword=日本語", encrypted, { "X-Enc": "2" }, table)), expected);
            assert.deepEqual(plain(crypto.fastDecryptComixPayload("/manga", encrypted, {}, table)), expected);
        }
        assert.deepEqual(plain(crypto.fastDecryptComixPayload("/manga", envelope(payload, bakedTable, header))), payload.result);
    }
    assert.deepEqual(table, before, "decrypt must not mutate caller table");
    assert.throws(() => crypto.fastDecryptComixPayload("/manga", envelope(payload, table), { "x-enc": "99" }, table), /not supported/);
});

test("decrypt rejects invalid tables even for plaintext instead of silently falling back", () => {
    const tables = [[], null, false, 1, "table", {}, new Uint8Array(1024), Array(1023).fill(0), Array(1025).fill(0), Array(1024),
        ...[-1, 256, 0.5, NaN, Infinity, "1", null, undefined].map((value) => [value, ...bakedTable.slice(1)]),
    ];
    for (const table of tables) {
        for (const payload of [{ status: "ok", result: 1 }, envelope({ status: "ok", result: 1 }, bakedTable)]) {
            assert.throws(() => crypto.fastDecryptComixPayload("/manga", payload, {}, table), /Invalid Comix decrypt table/);
        }
    }
    for (const table of [Array(1024).fill(0), Array(1024).fill(255)]) {
        assert.equal(crypto.fastDecryptComixPayload("/manga", envelope({ status: "ok", result: 123 }, table), {}, table), 123);
    }
});

test("baked decrypt helper returns detached snapshots, not a mutable global key", () => {
    assert.equal(typeof crypto.getBakedDecryptTable, "function");
    const first = crypto.getBakedDecryptTable();
    assert.deepEqual(plain(first), bakedTable);
    first[0] ^= 255;
    first.length = 1;
    const second = crypto.getBakedDecryptTable();
    assert.deepEqual(plain(second), bakedTable);
    const payload = envelope({ status: "ok", result: "untouched" }, bakedTable, [0, 0]);
    assert.equal(crypto.fastDecryptComixPayload("/manga", payload), "untouched");
    assert.equal(crypto.fastDecryptComixPayload("/manga", payload, {}, second), "untouched");
});

test("canonical query handles prototype property names as data for baked and injected keys", () => {
    const raw = "/manga?toString[]=last&__proto__[]=first&constructor[a]=nested&__proto__[]=second&hasOwnProperty=value&toString[]=again";
    const canonical = "/manga?__proto__[0]=first&__proto__[1]=second&constructor[a]=nested&hasOwnProperty=value&toString[0]=last&toString[1]=again";
    for (const keys of [undefined, rotatedKeys()]) {
        assert.equal(crypto.fastGenerateHash(raw, keys), hmacMidstateSign(canonical, keys ?? bakedKeys));
    }
});

test("signer replaces lone UTF-16 surrogates like the reference UTF-8 encoder", () => {
    for (const text of ["\ud800", "\udc00", "a\ud800b", "\ud800\ud800", "😀\udc00"]) {
        for (const keys of [undefined, rotatedKeys()]) {
            const raw = "/manga?keyword=" + text;
            assert.equal(crypto.fastGenerateHash(raw, keys), hmacMidstateSign(raw, keys ?? bakedKeys));
        }
    }
});

test("public injectable API and exported SignerKeys type-check in strict ES2020", () => {
    const file = resolve(ROOT, "src/ComixTo/__crypto_api_contract__.ts");
    const source = `
        import { fastGenerateHash, getBakedSignerKeys, SignerKeys } from "./ComixFastSigner";
        import { fastDecryptComixPayload, getBakedDecryptTable } from "./ComixFastDecrypt";
        const keys: SignerKeys = { prefix: "test.", macBytes: 32, istate: [], ostate: [] };
        const token: string = fastGenerateHash("/manga", keys);
        const defaultToken: string = fastGenerateHash("/manga");
        const snapshot: SignerKeys = getBakedSignerKeys();
        const table: number[] = getBakedDecryptTable();
        fastGenerateHash("/manga", undefined);
        fastDecryptComixPayload("/manga", {}, {}, table);
        fastDecryptComixPayload("/manga", {}, {}, undefined);
        fastDecryptComixPayload("/manga", {});
        // @ts-expect-error wrong key shape must not become an any-typed API
        fastGenerateHash("/manga", { prefix: "missing states" });
        // @ts-expect-error table elements must be numbers
        fastDecryptComixPayload("/manga", {}, {}, ["not a byte"]);
    `;
    const options = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true, types: [], lib: ["lib.es2020.d.ts"], skipLibCheck: true };
    const host = ts.createCompilerHost(options);
    const originalGetSource = host.getSourceFile.bind(host);
    host.getSourceFile = (name, ...args) => resolve(name) === file ? ts.createSourceFile(name, source, options.target, true) : originalGetSource(name, ...args);
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
    assert.deepEqual(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});

test("regeneration preserves checked-in output and injectable API across baked key rotations", () => {
    // Never regenerate the working checkout from a test. Fixtures live in Hermes
    // scratch (TMPDIR), or the platform's normal temp directory outside Hermes.
    const root = mkdtempSync(resolve(process.env.TMPDIR || tmpdir(), "comix-crypto-keys-"));
    try {
        mkdirSync(resolve(root, "experiment/crypto-pipeline"), { recursive: true });
        mkdirSync(resolve(root, "src/ComixTo"), { recursive: true });
        const constantsPath = resolve(root, "experiment/crypto-pipeline/constants.json");
        copyFileSync(resolve(ROOT, "experiment/crypto-pipeline/constants.json"), constantsPath);
        const generate = () => {
            const result = spawnSync(process.execPath, [resolve(ROOT, "experiment/crypto-pipeline/generate.mjs")], { cwd: root, encoding: "utf8" });
            assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
        };
        generate();
        for (const name of ["ComixFastSigner", "ComixFastDecrypt"]) {
            const relative = `src/ComixTo/${name}.ts`;
            const normalizeEol = (text) => text.replace(/\r\n/g, "\n");
            assert.equal(normalizeEol(readFileSync(resolve(root, relative), "utf8")), normalizeEol(readFileSync(resolve(ROOT, relative), "utf8")), "generated file drift: " + name);
        }

        const keys = rotatedKeys(32);
        const table = bakedTable.map((byte) => byte ^ 255);
        const next = structuredClone(constants);
        next.signer = { ...next.signer, ...keys };
        next.decrypt.keyB64 = Buffer.from(table).toString("base64");
        writeFileSync(constantsPath, JSON.stringify(next));
        generate();
        const generated = loadCrypto(root);
        assert.deepEqual(plain(generated.getBakedSignerKeys()), keys);
        assert.deepEqual(plain(generated.getBakedDecryptTable()), table);
        for (const [raw, canonical] of signVectors) {
            assert.equal(generated.fastGenerateHash(raw), hmacMidstateSign(canonical, keys));
            assert.equal(generated.fastGenerateHash(raw, bakedKeys), hmacMidstateSign(canonical, bakedKeys));
        }
        const payload = { status: "ok", result: "日本語 😀" };
        assert.equal(generated.fastDecryptComixPayload("/manga", envelope(payload, table)), payload.result);
        assert.equal(generated.fastDecryptComixPayload("/manga", envelope(payload, bakedTable), {}, bakedTable), payload.result);
        assert.throws(() => generated.fastGenerateHash("/manga", { ...keys, macBytes: 0 }), /Invalid Comix signer keys/);
        assert.throws(() => generated.fastDecryptComixPayload("/manga", {}, {}, []), /Invalid Comix decrypt table/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
