// Run comix's apicore-*.js inside the source to pull out its signing and
// decryption keys, so a key rotation can be followed in-app.
//
// Since build tnd60v (2026-10-23) comix builds its keys at runtime inside
// apicore-*.js (javascript-obfuscator, plain JS): one Uint8Array of
// [inner HMAC midstate 32 B][outer midstate 32 B][XOR table 1024 B]. The
// algorithms are the ones in ComixFastSigner / ComixFastDecrypt; only the keys
// change. Rather than parse the obfuscation, we evaluate the module with fake
// browser objects and a fake XHR transport. This is compatibility emulation,
// NOT a security sandbox: evaluated same-origin code can still reach shared JS
// intrinsics and must be trusted like an executable dependency. JSC provides no
// isolated realm or pre-emptive execution deadline here. Never broaden discovery
// to arbitrary hosts, and never persist downloaded code. The extraction flow:
//   1. every browser global it touches is a stub passed in as a parameter of
//      `new Function`, and Uint8Array / Proxy are wrapped to watch buffers and
//      the (key-hiding Proxy) API tables it creates;
//   2. its own raw GET client signs a few paths: the buffer whose midstates
//      reproduce every one of its tokens is the key;
//   3. it must decrypt a body we encrypted with that buffer's table back to the
//      plaintext we planted.
// Prototype and tests: experiment/live/apicore-sandbox.mjs.

import { fastGenerateHash, SignerKeys } from "./ComixFastSigner";
import { TextEncoderShim, TextDecoderShim, URLShim, URLSearchParamsShim, BlobShim, atobShim, btoaShim } from "./ComixPolyfills";

export interface ApicoreKeys extends SignerKeys {
    table: number[];
}

interface FakeResponse { status: number; headers: Record<string, string>; body: string }
type Net = (url: string, method: string) => FakeResponse | undefined;

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const OK: FakeResponse = { status: 200, headers: { "content-type": "application/json" }, body: "{\"status\":\"ok\",\"result\":{}}" };

const GLOBALS = [
    "App", "window", "self", "globalThis", "document", "navigator", "location", "history", "screen",
    "fetch", "XMLHttpRequest", "Request", "Response", "Headers", "ReadableStream", "FormData", "Blob", "AbortController",
    "localStorage", "sessionStorage", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate",
    "queueMicrotask", "addEventListener", "removeEventListener", "dispatchEvent", "postMessage", "reportError",
    "WorkerGlobalScope", "process", "Function", "Uint8Array", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
    "atob", "btoa", "Proxy", "_wb_wombat", "_WBWombat", "crypto",
];

/**
 * An ES module as a function body: `import {a as b} from "./x.js"` becomes a
 * destructure of `importVar`, the trailing `export {x as y}` becomes a return.
 */
export function moduleBody(src: string, importVar = "__chunk"): string {
    const m = /export\{([^}]*)\};?\s*$/.exec(src);
    if (!m) throw new Error("apicore: no trailing export");
    const ret = m[1]!.split(",").map((p) => {
        const [local, exported] = p.trim().split(/\s+as\s+/);
        return `${JSON.stringify(exported ?? local)}:${local}`;
    }).join(",");
    const body = (src.slice(0, m.index) + `;return {${ret}};`).replace(/import\{([^}]*)\}from"[^"]*";/g, (_, names: string) =>
        "const {" + names.split(",").map((p) => {
            const [imported, local] = p.trim().split(/\s+as\s+/);
            return `${imported}:${local ?? imported}`;
        }).join(",") + `}=${importVar};`);
    if (/\bimport(?:\s|[{(*"']|\.meta)/.test(body)) throw new Error("apicore: unexpected extra imports");
    return body;
}

/** The relative module apicore imports its runtime helpers from (e.g. "./tnf4oa-Bs8I3sZv.js"). */
export function apicoreImport(src: string): string | null {
    return /import\{[^}]*\}from"([^"]+)"/.exec(src)?.[1] ?? null;
}

const noop = () => undefined;

function boot(apicoreSrc: string, chunkSrc: string, net: Net, onBuffer: (u: Uint8Array) => void): { apis: any[] } {
    const apis: any[] = [];
    const RealProxy = Proxy;
    const ProxyWatch = new RealProxy(RealProxy, {
        construct(target, args, newTarget) {
            const t = args[0];
            if (t && typeof t === "object" && Object.keys(t).some((k) => typeof t[k] === "function")) {
                if (apis.length >= 128) throw new Error("apicore resource limit: API tables");
                apis.push(t);
            }
            return Reflect.construct(target, args, newTarget);
        },
    });
    const U8 = new RealProxy(Uint8Array, {
        construct(target, args, newTarget) {
            const r = Reflect.construct(target, args, newTarget) as Uint8Array;
            if (r.length >= 1024 && r.length <= 8192) onBuffer(r);
            return r;
        },
    });
    const storage = () => {
        const m: Record<string, string> = {};
        return { getItem: (k: string) => (k in m ? m[k] : null), setItem: (k: string, v: any) => { m[k] = String(v); }, removeItem: (k: string) => { delete m[k]; }, clear: noop, key: () => null, length: 0 };
    };
    const element = () => ({ style: {}, setAttribute: noop, appendChild: noop, removeChild: noop, addEventListener: noop, removeEventListener: noop, remove: noop, contentWindow: null });

    // axios uses its xhr adapter when XMLHttpRequest exists; answer from `net`.
    class XHR {
        readyState = 0; status = 0; statusText = ""; responseText = ""; response = ""; responseURL = "";
        onloadend: any = null; onerror: any = null; onabort: any = null; ontimeout: any = null; onreadystatechange: any = null; onload: any = null;
        upload = { addEventListener: noop };
        private method = "GET"; private url = ""; private headers: Record<string, string> = {};
        open(method: string, url: string) { this.method = method; this.url = String(url); this.readyState = 1; }
        setRequestHeader() { /* not needed */ }
        getAllResponseHeaders() { return Object.keys(this.headers).map((k) => `${k}: ${this.headers[k]}`).join("\r\n"); }
        getResponseHeader(k: string) { return this.headers[k.toLowerCase()] ?? null; }
        addEventListener(type: string, fn: any) { (this as any)["on" + type] = fn; }
        removeEventListener() { /* not needed */ }
        abort() { /* not needed */ }
        send() {
            Promise.resolve().then(() => {
                const url = /^https?:/.test(this.url) ? this.url : "https://comix.to" + (this.url.startsWith("/") ? "" : "/") + this.url;
                const r = net(url, this.method.toUpperCase()) ?? OK;
                this.status = r.status; this.statusText = "OK";
                this.headers = {};
                for (const k of Object.keys(r.headers)) this.headers[k.toLowerCase()] = r.headers[k]!;
                this.responseText = this.response = r.body; this.responseURL = url; this.readyState = 4;
                this.onreadystatechange?.(); this.onload?.(); this.onloadend?.();
            });
        }
    }

    const win: any = {
        document: {
            cookie: "", readyState: "complete", visibilityState: "visible", hidden: false, referrer: "", title: "Comix",
            body: element(), head: element(), documentElement: element(),
            createElement: element, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            getElementsByTagName: () => [], addEventListener: noop, removeEventListener: noop,
        },
        navigator: { userAgent: UA, language: "en-US", languages: ["en-US"], cookieEnabled: true, webdriver: false, product: "Gecko", platform: "iPhone", onLine: true },
        location: { href: "https://comix.to/", origin: "https://comix.to", protocol: "https:", host: "comix.to", hostname: "comix.to", port: "", pathname: "/", search: "", hash: "", reload: noop, assign: noop, replace: noop },
        history: { pushState: noop, replaceState: noop, back: noop },
        screen: { width: 390, height: 844 },
        XMLHttpRequest: XHR,
        localStorage: storage(), sessionStorage: storage(),
        // No timers: apicore's delayed work (WAF reload checks, retries) never runs.
        setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
        queueMicrotask: (f: () => void) => { Promise.resolve().then(f); },
        addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true, postMessage: noop, reportError: noop,
        Blob: BlobShim, Uint8Array: U8, Proxy: ProxyWatch,
        TextEncoder: TextEncoderShim, TextDecoder: TextDecoderShim, URL: URLShim, URLSearchParams: URLSearchParamsShim,
        atob: atobShim, btoa: btoaShim,
        crypto: { getRandomValues: (b: any) => { for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0; return b; } },
        // `Function("return this")()` must find the fake window, not the source's global.
        Function: new RealProxy(Function, {
            apply(target, thisArg, args) { return /return this/.test(String(args[args.length - 1])) ? () => win : Reflect.apply(target, thisArg, args); },
            construct(target, args) { return /return this/.test(String(args[args.length - 1])) ? () => win : Reflect.construct(target, args); },
        }),
    };
    win.window = win.self = win.globalThis = win;

    const chunk = new Function(...GLOBALS, `"use strict";${moduleBody(chunkSrc)}`)(...GLOBALS.map((g) => win[g]));
    const factory = new Function("__chunk", ...GLOBALS, `"use strict";${moduleBody(apicoreSrc)}`);
    factory(chunk, ...GLOBALS.map((g) => win[g]));
    return { apis };
}

// Wait for `p`, but give up after a bounded number of microtask turns (there
// are no timers in Paperback; the fake network only ever uses microtasks).
async function settle<T>(p: Promise<T>, turns = 5000): Promise<{ done: boolean; value?: T }> {
    const state: { done: boolean; value?: T } = { done: false };
    p.then((v) => { state.done = true; state.value = v; }, () => { state.done = true; });
    for (let i = 0; i < turns && !state.done; i++) await Promise.resolve();
    return state;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToB64(bytes: number[]): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=") + (i + 2 < bytes.length ? B64[n & 63]! : "=");
    }
    return out;
}

const words = (b: Uint8Array, off: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 8; i++) out.push(((b[off + 4 * i]! << 24) | (b[off + 4 * i + 1]! << 16) | (b[off + 4 * i + 2]! << 8) | b[off + 4 * i + 3]!) >>> 0);
    return out;
};

/**
 * Evaluate apicore and return its keys, verified against its own tokens and
 * its own decryption of a body encrypted with the extracted table.
 */
export async function extractApicoreKeys(apicoreSrc: string, chunkSrc: string): Promise<ApicoreKeys> {
    const candidates: Uint8Array[] = [];
    const requests: { url: string; method: string }[] = [];
    let respond: ((url: string) => FakeResponse) | null = null;
    const { apis } = boot(apicoreSrc, chunkSrc, (url, method) => {
        requests.push({ url, method });
        return respond?.(url);
    }, (u) => {
        if (candidates.length >= 256) throw new Error("apicore resource limit: key buffers");
        candidates.push(u);
    });

    // The raw client: the function that GETs /api/v1/<its argument> and signs it.
    const probe = "/manga/__probe__";
    let get: ((path: string, config?: any) => Promise<any>) | null = null;
    let attempts = 0;
    for (const table of apis) {
        for (const key of Object.keys(table)) {
            const f = table[key];
            if (get || typeof f !== "function") continue;
            if (++attempts > 256) throw new Error("apicore resource limit: client probes");
            requests.length = 0;
            try { await settle(Promise.resolve().then(() => f(probe))); } catch { /* not it */ }
            const r = requests[0];
            if (r && r.method === "GET" && r.url.split("?")[0] === "https://comix.to/api/v1" + probe && /[?&]_=/.test(r.url)) get = f;
        }
        if (get) break;
    }
    if (!get) throw new Error("apicore layout changed (no signing client found)");

    // 1. Tokens: apicore signs path + params (like the site calls it); our
    //    signer with the candidate keys must reproduce every token.
    const probes: [string, any?][] = [
        ["/manga/abc12"],
        ["/manga/abc12/chapters", { page: 1, limit: 20, order: { number: "desc" } }],
        ["/chapters/12345678"],
        ["/manga", { keyword: "café", genres_ex: [8, 9], page: 2 }],
    ];
    const signed: string[] = [];
    for (const [path, params] of probes) {
        requests.length = 0;
        const r = await settle(get(path, params ? { params } : undefined));
        if (!r.done || !requests[0]) throw new Error("apicore did not issue its request");
        signed.push(requests[0].url);
    }
    const tokenOf = (url: string) => /[?&]_=([^&]*)/.exec(url)?.[1] ?? "";
    const first = tokenOf(signed[0]!);
    const dot = first.indexOf(".");
    if (dot < 1) throw new Error("apicore token has an unexpected shape");
    const prefix = first.slice(0, dot + 1);
    const macBytes = Math.floor(((first.length - prefix.length) * 6) / 8);
    let keys: ApicoreKeys | null = null;
    for (const buf of candidates) {
        if (buf.length < 64 + 1024) continue;
        const k = { prefix, macBytes, istate: words(buf, 0), ostate: words(buf, 32), table: Array.from(buf.subarray(64, 64 + 1024)) };
        if (signed.every((u) => fastGenerateHash(u.replace(/[?&]_=[^&]*/, ""), k) === tokenOf(u))) { keys = k; break; }
    }
    if (!keys) throw new Error(`no buffer reproduces apicore's tokens (${candidates.length} candidates) - storage or algorithm changed`);

    // 2. Decryption: answer with a body encrypted under the table; apicore must hand back what we planted.
    const marker = "probe-" + Math.floor(Math.random() * 1e9).toString(36);
    const plain = JSON.stringify({ status: "ok", result: { probe: marker, text: "héllo ✓" } });
    const pt = Array.from(new TextEncoderShim().encode(plain));
    const h0 = (Math.random() * 256) | 0, h1 = (Math.random() * 256) | 0;
    const K = keys.table;
    let off = ((h0 << 8) | h1) % K.length;
    const ct = [h0, h1];
    for (let i = 0; i < pt.length; i++) { ct.push(pt[i]! ^ K[off]!); if (++off === K.length) off = 0; }
    respond = () => ({ status: 200, headers: { "content-type": "application/json", "x-enc": "2" }, body: JSON.stringify({ e: bytesToB64(ct) }) });
    const r = await settle(get("/manga/abc12"));
    respond = null;
    const got = r.value?.data ?? r.value;
    const result = got?.result ?? got;
    if (!r.done || result?.probe !== marker || result?.text !== "héllo ✓") throw new Error("apicore did not decrypt our test body with the extracted table");
    return keys;
}
