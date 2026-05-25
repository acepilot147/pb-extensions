/**
 * One-shot probe of Paperback's JavaScriptCore runtime.
 *
 * The Comix bundle's name-mangler aliases ~50 obfuscated identifiers to
 * browser/JS built-ins (TextEncoder, Blob, fetch, queueMicrotask, etc.).
 * If Paperback doesn't expose one of those built-ins on globalThis, the
 * alias resolves to undefined and the bundle dies with "undefined is not
 * a function/constructor" later.
 *
 * Rather than discover what's missing one error at a time, this probe
 * checks every built-in the bundle uses, plus a few runtime-semantics
 * questions (does Object.defineProperty(globalThis, ...) work? Is
 * `new Function` body strict mode? Does `with()` work?), and POSTs the
 * results to a local log server on the LAN.
 *
 * Usage:
 *   1. On your PC: `node experiment/log-server.js`
 *      Note the LAN URL it prints (e.g. http://192.168.1.123:9090/log).
 *   2. Put that URL in PROBE_LOG_URL below.
 *   3. Rebuild the extension (`npm run bundle`) and sideload v1.9.0.
 *   4. Open the source in Paperback (anything that triggers a signed
 *      request — opening a chapter, the home page, etc.).
 *   5. The probe payload appears in the log-server terminal.
 *
 * Set PROBE_LOG_URL to "" to disable.
 */

// CHANGE THIS to the LAN URL your log server prints when you start it.
const PROBE_LOG_URL = "http://192.168.0.215:9090/log";

const BUILTIN_NAMES = [
    // Core ES built-ins (should exist everywhere)
    "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
    "Date", "RegExp", "Math", "JSON",
    "Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "URIError",
    "Promise", "Proxy", "Reflect",
    "Map", "Set", "WeakMap", "WeakSet",
    "ArrayBuffer", "SharedArrayBuffer", "DataView",
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
    "BigInt64Array", "BigUint64Array",
    // Global functions
    "escape", "unescape", "parseInt", "parseFloat", "isNaN", "isFinite",
    "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent",
    "atob", "btoa",
    // Browser-ish (these are the ones we suspect Paperback may not have)
    "TextEncoder", "TextDecoder",
    "Blob", "File", "FileReader",
    "URL", "URLSearchParams",
    "fetch", "Request", "Response", "Headers",
    "WebAssembly",
    "console",
    // Timers
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
    // Globals
    "globalThis", "window", "self", "document", "navigator", "location",
    "localStorage", "sessionStorage",
    // Less common
    "Intl", "DOMException", "AbortController", "AbortSignal",
    "structuredClone", "crypto",
];

function describe(value: any): string {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    const t = typeof value;
    if (t === "function") {
        const n = (value as any).name || "(anon)";
        const len = (value as any).length;
        return `function:${n}(len=${len})`;
    }
    if (t === "object") {
        const ctor = (value as any).constructor?.name ?? "?";
        const keys = Object.keys(value).slice(0, 4).join(",");
        return `object:${ctor}{${keys}}`;
    }
    return `${t}:${String(value).slice(0, 40)}`;
}

function tryConstruct(ctor: any, args: any[]): string {
    try {
        const instance = new (ctor as any)(...args);
        const ctorName = (instance && instance.constructor?.name) ?? "?";
        return `ok:${ctorName}`;
    } catch (e: any) {
        return `fail:${(e?.message ?? String(e)).slice(0, 80)}`;
    }
}

function tryCall(fn: any, args: any[]): string {
    try {
        const r = (fn as any)(...args);
        return `ok:${describe(r)}`;
    } catch (e: any) {
        return `fail:${(e?.message ?? String(e)).slice(0, 80)}`;
    }
}

function runChecks(): Record<string, any> {
    const G: any = globalThis;
    const results: Record<string, any> = {};

    results.__platform = {
        userAgent: (G.navigator && G.navigator.userAgent) ?? "(no navigator.userAgent)",
        globalThisType: typeof G,
        hasWindow: typeof G.window,
        hasDocument: typeof G.document,
    };

    // Type of every built-in we care about
    const types: Record<string, string> = {};
    for (const name of BUILTIN_NAMES) {
        try {
            types[name] = describe(G[name]);
        } catch (e: any) {
            types[name] = `THROW:${e?.message?.slice(0, 60)}`;
        }
    }
    results.builtins = types;

    // Specific spot-checks for things we strongly suspect to be missing
    results.spotChecks = {
        TextEncoder_construct: typeof G.TextEncoder === "function" ? tryConstruct(G.TextEncoder, []) : "no-symbol",
        TextDecoder_construct: typeof G.TextDecoder === "function" ? tryConstruct(G.TextDecoder, []) : "no-symbol",
        Blob_construct: typeof G.Blob === "function" ? tryConstruct(G.Blob, [["hi"]]) : "no-symbol",
        URL_construct: typeof G.URL === "function" ? tryConstruct(G.URL, ["https://example.com/path"]) : "no-symbol",
        queueMicrotask_call: typeof G.queueMicrotask === "function" ? "callable" : "no-symbol",
        Proxy_construct: typeof G.Proxy === "function" ? tryConstruct(G.Proxy, [{}, {}]) : "no-symbol",
        Reflect_get: typeof G.Reflect === "object" ? tryCall(G.Reflect.get, [{ a: 1 }, "a"]) : "no-symbol",
        WebAssembly_validate: typeof G.WebAssembly === "object" ? "exists" : "no-symbol",
        crypto_getRandomValues: G.crypto && typeof G.crypto.getRandomValues === "function" ? "ok" : "missing",
        setInterval_call: typeof G.setInterval === "function" ? tryCall(G.setInterval, [() => {}, 999999]) : "no-symbol",
        fetch_exists: typeof G.fetch === "function" ? "yes" : "no",
    };

    // Runtime semantics: defineProperty on globalThis
    const dpResults: Record<string, string> = {};
    try {
        Object.defineProperty(G, "__probe_data_prop", { value: 1, writable: true, configurable: true });
        dpResults.dataProperty = G.__probe_data_prop === 1 ? "ok" : "silent-fail";
        try { delete G.__probe_data_prop; } catch {}
    } catch (e: any) {
        dpResults.dataProperty = `throw:${e?.message?.slice(0, 80)}`;
    }
    try {
        let stored = 0;
        Object.defineProperty(G, "__probe_accessor_prop", {
            get() { return stored; },
            set(v: any) { stored = v; },
            configurable: true,
        });
        G.__probe_accessor_prop = 42;
        dpResults.accessorProperty = G.__probe_accessor_prop === 42 ? "ok" : "silent-fail";
        try { delete G.__probe_accessor_prop; } catch {}
    } catch (e: any) {
        dpResults.accessorProperty = `throw:${e?.message?.slice(0, 80)}`;
    }
    try {
        G.__probe_direct_assign = "hello";
        dpResults.directAssignment = G.__probe_direct_assign === "hello" ? "ok" : "silent-fail";
        try { delete G.__probe_direct_assign; } catch {}
    } catch (e: any) {
        dpResults.directAssignment = `throw:${e?.message?.slice(0, 80)}`;
    }
    results.globalThisMutation = dpResults;

    // Mode + with()
    try {
        // Sloppy implicit global creation
        const sloppyImplicit = new Function("__probe_sloppy_var = 7; return typeof __probe_sloppy_var;");
        results.implicitGlobalsAllowed = sloppyImplicit();
        try { delete (G as any).__probe_sloppy_var; } catch {}
    } catch (e: any) {
        results.implicitGlobalsAllowed = `fail:${e?.message?.slice(0, 80)}`;
    }
    try {
        const isStrict = new Function("return (function(){ return this === undefined ? 'strict' : 'sloppy'; })()");
        results.newFunctionBodyMode = isStrict();
    } catch (e: any) {
        results.newFunctionBodyMode = `fail:${e?.message?.slice(0, 80)}`;
    }
    try {
        const withTest = new Function("sb", "with(sb){ return typeof someVar; }");
        results.withStatement = withTest({ someVar: "x" });
    } catch (e: any) {
        results.withStatement = `fail:${e?.message?.slice(0, 80)}`;
    }

    // Function declaration hoisting inside new Function (the bundle's Y4 mechanic)
    try {
        const hoistTest = new Function("Y4[1] = 'set'; return Y4[1]; function Y4(){}");
        results.functionDeclHoisting = hoistTest();
    } catch (e: any) {
        results.functionDeclHoisting = `fail:${e?.message?.slice(0, 80)}`;
    }

    return results;
}

let _reported = false;
export function reportProbeOnce(label: string): void {
    if (_reported) return;
    _reported = true;
    if (!PROBE_LOG_URL) return;

    let payload: Record<string, any> = { label };
    try {
        payload = { label, runtime: runChecks() };
    } catch (e: any) {
        payload.probeError = e?.message ?? String(e);
    }

    try {
        const rm = App.createRequestManager({ requestsPerSecond: 5, requestTimeout: 5000 });
        const req = App.createRequest({
            url: PROBE_LOG_URL,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(payload, null, 2),
        });
        // Fire-and-forget
        rm.schedule(req, 1).catch(() => {});
    } catch {}

    try { console.log("[ComixProbe] " + JSON.stringify(payload).slice(0, 4000)); } catch {}
}
