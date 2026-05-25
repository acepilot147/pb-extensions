/**
 * Comix bundle runtime.
 *
 * comix.to ships a 146 KB obfuscated JS bundle (secure-*.js) containing the
 * URL-signing and response-decryption algorithms. In the browser, the
 * frontend imports it as a module, hands its installer the project's axios
 * instance, and the installer registers a request interceptor (which writes
 * `_=<token>` into the request's params) and a response interceptor (which
 * decrypts `{e: "..."}` payloads).
 *
 * We do the same thing here: evaluate the bundle once, capture the two
 * interceptors via a fake axios, and call them ourselves when we need to
 * sign or decrypt. Re-encoding into a TS port is not viable because the
 * bundle is control-flow-flattened and the keys/S-boxes are inlined; running
 * the live bundle is the durable seam.
 *
 * The non-trivial part is that the bundle creates ~50 obfuscated globals at
 * boot (e.g. `q3q7pK = setInterval`) by `Object.defineProperty(globalThis,
 * <name>, {get, set})` calls. Paperback's runtime appears to reject those
 * writes (the bundle wraps them in try/catch and swallows the failure),
 * which leaves later reads of those names resolving to undefined and the
 * bundle dies with "X is not a function".
 *
 * The fix: wrap the bundle in `with(sandbox) { ... }`. Our Proxy-based
 * sandbox claims to "have" every identifier, so undeclared reads and writes
 * inside the bundle resolve against the sandbox instead of against
 * Paperback's real globalThis. The bundle's own defineProperty calls then
 * operate on the sandbox (a plain backing object we fully control), and the
 * obfuscated globals stick exactly where later reads look for them. Real
 * built-ins (`Object`, `Date`, `Array`, etc.) fall through the sandbox to
 * the real globalThis for read-only references.
 *
 * `arguments` is denied from the Proxy's `has` because every function in the
 * bundle uses `arguments` as a magic identifier and we must not intercept
 * those.
 */

import { BUNDLE_CODE, BUNDLE_INFO } from "./ComixBundle";
import { reportProbeOnce } from "./ComixProbe";
import {
    BlobShim,
    TextDecoderShim,
    TextEncoderShim,
    URLSearchParamsShim,
    URLShim,
    atobShim,
    btoaShim,
    cryptoShim,
} from "./ComixPolyfills";

type Interceptor = (input: any) => any;

interface BundleExports {
    r: (axios: any) => void;
    [k: string]: unknown;
}

let _exports: BundleExports | null = null;
let _reqIntercept: Interceptor | null = null;
let _resIntercept: Interceptor | null = null;
let _initError: string | null = null;

/**
 * Pre-populate the sandbox with browser-like globals the bundle relies on
 * before its name-mangler runs. Anything the bundle reads from `globalThis`
 * (via our Proxy fallback) ends up here unless we provide our own version.
 */
function buildSandboxBacking(): Record<string, any> {
    const G: any = globalThis;
    const cfg = BUNDLE_INFO.cfg;

    const metaCfg = {
        get content() { return cfg; },
        getAttribute(name: string): string | null {
            return name === "content" ? cfg : name === "name" ? "cfg" : null;
        },
        name: "cfg",
    };

    const querySelector = (selector: string): unknown => {
        if (typeof selector !== "string") return null;
        return selector.indexOf("cfg") >= 0 ? metaCfg : null;
    };
    const querySelectorAll = (selector: string): unknown[] => {
        if (typeof selector !== "string") return [];
        return selector.toLowerCase() === "meta" ? [metaCfg] : [];
    };
    try {
        Object.defineProperty(querySelector, "toString", { value: () => "function querySelector() { [native code] }" });
        Object.defineProperty(querySelectorAll, "toString", { value: () => "function querySelectorAll() { [native code] }" });
    } catch {}

    const dummyCanvas = {
        width: 300, height: 150, style: {},
        getContext: () => ({
            fillRect() {}, clearRect() {}, fillText() {},
            getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]), width: 1, height: 1 }),
            putImageData() {},
            createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
        }),
        toDataURL: () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    };

    const doc = {
        querySelector,
        querySelectorAll,
        getElementsByTagName(tag: string): unknown[] {
            return tag && tag.toLowerCase() === "meta" ? [metaCfg] : [];
        },
        createElement(tagName: string): unknown {
            if (typeof tagName !== "string") return { style: {} };
            const tag = tagName.toLowerCase();
            if (tag === "canvas") return dummyCanvas;
            if (tag === "a") {
                const anchor: any = { href: "", style: {} };
                Object.defineProperty(anchor, "hostname", { get() { try { return new URL(anchor.href, "https://comix.to").hostname; } catch { return "comix.to"; } } });
                Object.defineProperty(anchor, "pathname", { get() { try { return new URL(anchor.href, "https://comix.to").pathname; } catch { return "/"; } } });
                Object.defineProperty(anchor, "protocol", { get() { try { return new URL(anchor.href, "https://comix.to").protocol; } catch { return "https:"; } } });
                Object.defineProperty(anchor, "host", { get() { try { return new URL(anchor.href, "https://comix.to").host; } catch { return "comix.to"; } } });
                return anchor;
            }
            return { style: {} };
        },
        head: { appendChild() {}, removeChild() {} },
        body: { appendChild() {}, removeChild() {} },
        cookie: "",
        readyState: "complete",
        addEventListener() {},
        removeEventListener() {},
    };

    const loc = {
        href: "https://comix.to/",
        origin: "https://comix.to",
        host: "comix.to",
        hostname: "comix.to",
        pathname: "/",
        protocol: "https:",
        search: "",
        hash: "",
    };

    const nav = {
        userAgent: typeof G.navigator?.userAgent === "string" && G.navigator.userAgent
            ? G.navigator.userAgent
            : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        appCodeName: "Mozilla",
        appName: "Netscape",
        language: "en-US",
        languages: ["en-US", "en"],
        platform: "Win32",
        cookieEnabled: true,
    };

    const noop = () => 0;
    const realSetTimeout = typeof G.setTimeout === "function" ? G.setTimeout.bind(G) : noop;
    const realClearTimeout = typeof G.clearTimeout === "function" ? G.clearTimeout.bind(G) : (() => {});
    const realSetInterval = typeof G.setInterval === "function" ? G.setInterval.bind(G) : noop;
    const realClearInterval = typeof G.clearInterval === "function" ? G.clearInterval.bind(G) : (() => {});

    // Polyfills for built-ins Paperback's runtime doesn't expose. The
    // bundle's name-mangler aliases these by reading `globalThis[name]`,
    // and the sandbox proxy's get-trap returns sandbox[name] before
    // falling back to real globalThis — so populating these here makes
    // the bundle's aliases resolve to working implementations.
    return {
        document: doc,
        location: loc,
        navigator: nav,
        screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
        atob: typeof G.atob === "function" ? G.atob.bind(G) : atobShim,
        btoa: typeof G.btoa === "function" ? G.btoa.bind(G) : btoaShim,
        TextEncoder: typeof G.TextEncoder === "function" ? G.TextEncoder : TextEncoderShim,
        TextDecoder: typeof G.TextDecoder === "function" ? G.TextDecoder : TextDecoderShim,
        Blob: typeof G.Blob === "function" ? G.Blob : BlobShim,
        URL: typeof G.URL === "function" ? G.URL : URLShim,
        URLSearchParams: typeof G.URLSearchParams === "function" ? G.URLSearchParams : URLSearchParamsShim,
        crypto: G.crypto ?? cryptoShim,
        setTimeout: realSetTimeout,
        clearTimeout: realClearTimeout,
        setInterval: realSetInterval,
        clearInterval: realClearInterval,
        queueMicrotask: typeof G.queueMicrotask === "function" ? G.queueMicrotask.bind(G) : (cb: () => void) => Promise.resolve().then(cb),
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    };
}

/** Keys that the Proxy's `has` MUST NOT claim, or the bundle breaks. */
const HAS_DENYLIST = new Set([
    // `arguments` is a per-function magic binding; if we shadow it via has(),
    // bundle functions can't read their own arguments.
    "arguments",
]);

function buildSandbox(): any {
    const backing = buildSandboxBacking();
    const G: any = globalThis;

    const proxy = new Proxy(backing, {
        has(_target, key) {
            if (typeof key === "symbol") return false;
            if (HAS_DENYLIST.has(key as string)) return false;
            return true;
        },
        get(target, key) {
            if (typeof key === "symbol") return (target as any)[key];
            if (key in target) return (target as any)[key];
            // Fall back to the real globalThis for built-ins (Object, Array,
            // Promise, Math, console, ...). Reads that should land on real
            // built-ins don't need to be sandboxed; only the bundle's
            // synthesized aliases do.
            return G[key as string];
        },
        set(target, key, value) {
            (target as any)[key] = value;
            return true;
        },
    });

    // The bundle reads `globalThis` and `window` to find the target of its
    // defineProperty-based name-mangler. Make both resolve to the sandbox so
    // its writes land where its later reads look.
    backing.globalThis = proxy;
    backing.window = proxy;
    backing.self = proxy;
    backing.global = proxy;

    return proxy;
}

function initBundle(): void {
    if (_exports || _initError) return;
    // Probe Paperback's runtime once, BEFORE attempting bundle init, so the
    // probe report lands even when the bundle blows up downstream.
    reportProbeOnce("pre-init");
    try {
        const sandbox = buildSandbox();

        // `with(__sb)` is illegal in strict mode, but `new Function` bodies
        // are non-strict by default in standard JS engines.
        const bootFn = new Function("__sb", `with(__sb){\n${BUNDLE_CODE}\n}`) as (sb: any) => BundleExports;
        _exports = bootFn(sandbox);
        if (!_exports || typeof _exports.r !== "function") {
            throw new Error("bundle did not return expected exports (missing installer 'r')");
        }

        const fakeAxios: any = {
            interceptors: {
                request: { use: (h: Interceptor) => { _reqIntercept = h; } },
                response: { use: (h: Interceptor) => { _resIntercept = h; } },
            },
            defaults: {
                headers: { common: {}, get: {}, post: {}, put: {}, delete: {}, patch: {}, head: {} },
                transformRequest: [],
                transformResponse: [],
            },
            get() {}, post() {}, put() {}, delete() {}, patch() {}, head() {},
        };
        _exports.r(fakeAxios);

        if (!_reqIntercept) throw new Error("bundle did not register a request interceptor");
        if (!_resIntercept) throw new Error("bundle did not register a response interceptor");
    } catch (error: any) {
        _initError = error?.message ?? String(error);
        try { console.error(`[ComixBundle] init failed: ${_initError}`); } catch {}
    }
}

export function getBundleInfo(): typeof BUNDLE_INFO {
    return BUNDLE_INFO;
}

export function signPath(rawPath: string): string {
    initBundle();
    if (_initError) throw new Error(`Comix bundle unavailable: ${_initError}`);
    const path = rawPath.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "").split("?")[0]!;
    const cfg: any = {
        url: path,
        method: "get",
        baseURL: "https://comix.to/api/v1",
        headers: {},
        params: {},
    };
    const out = _reqIntercept!(cfg) ?? cfg;
    const token = out?.params?._;
    if (typeof token !== "string" || token.length === 0) return "";
    return token;
}

export function decryptPayload(payload: any, headers: Record<string, string | undefined>): any {
    initBundle();
    if (_initError) throw new Error(`Comix bundle unavailable: ${_initError}`);
    const normalizedHeaders: Record<string, string> = {};
    for (const k of Object.keys(headers ?? {})) {
        const v = headers[k];
        if (typeof v === "string") normalizedHeaders[k.toLowerCase()] = v;
    }
    const fakeResp: any = {
        data: payload,
        status: 200,
        statusText: "OK",
        headers: normalizedHeaders,
        config: { url: "/", method: "get", baseURL: "https://comix.to/api/v1" },
        request: {},
    };
    const out = _resIntercept!(fakeResp) ?? fakeResp;
    return out?.data ?? out;
}
