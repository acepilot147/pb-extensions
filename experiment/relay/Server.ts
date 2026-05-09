export {};

/**
 * Comix.to URL-signing + response-decryption relay.
 *
 *   GET /sign?path=/manga/xxx/chapters
 *     → { ok: true, signedUrl: "https://comix.to/api/v1/manga/xxx/chapters?_=..." }
 *
 *   GET /fetch?path=/manga/xxx/chapters
 *     → { ok: true, status: 200, data: <decrypted plaintext JSON> }
 *
 *   POST /decrypt
 *     body { path, payload } where payload is the encrypted comix.to JSON
 *     → { ok: true, data: <decrypted plaintext JSON> }
 *
 *   GET /health
 *     → { ok: true, bundleId, secureUrl, cfgPrefix, hasSigner, hasResInterceptor }
 *
 *   GET /rebootstrap
 *     → forces a fresh scrape + bundle re-load (use after suspected rotation).
 *
 * Bootstrap (matches the Keiyoushi Tachiyomi extension's behavior probe so
 * we survive name rotation and signing-algorithm rewrites for free):
 *
 *   1. Scrape https://comix.to/title/<probe> for `<meta name="cfg">` and the
 *      `main-*.js` URL. Parse main-*.js for the `secure-*.js` import.
 *   2. Install a DOM stub (defeats the bundle's `ce()` anti-tamper check by
 *      stubbing `document.querySelector.toString()` to look native) and
 *      dynamic-import the bundle. The bundle attaches its hoisted globals to
 *      `globalThis.vmf_<id>` and to bare `globalThis.<name>`.
 *   3. Walk `globalThis.vmf_*` namespaces, identify two functions by
 *      behavior:
 *        - signer:     fn(probePath) returns a base64url-shaped token
 *        - installer:  fn(fakeAxios) registers a request interceptor and
 *                      a response interceptor on the fake axios's
 *                      .interceptors.{request,response}.use
 *      The fake-axios trick captures both interceptor handlers so we can
 *      call them directly later (no real axios needed).
 *
 * Why this is more robust than the previous `mod.n(ax)` approach: the
 * bundle's exported names rotated 3× already this month (was `n`,
 * could become anything). Probing by behavior — "the function whose output
 * for a known path looks like a base64url token" — is name-independent.
 *
 * Run:
 *   npx tsx --env-file=.env experiment/relay/Server.ts
 */

import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Worker, parentPort } from "node:worker_threads";

// Render / Railway / Fly / etc. inject $PORT; local dev defaults to 9091.
const PORT       = Number(process.env.PORT ?? process.env.RELAY_PORT ?? 9091);
const HOMEPAGE   = process.env.RELAY_PROBE_URL ?? "https://comix.to/title/xlyyj-eleceed";
const PROBE_PATH = "/manga/xlyyj/chapters";
const UA         = process.env.USER_AGENT  ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const IS_DECRYPT_WORKER = process.env.RELAY_WORKER === "decrypt";
const CURRENT_FILE = fileURLToPath(import.meta.url);

// Capture real timer functions before the DOM stub overrides them. The
// stubbed timers must return real Node Timer objects (not plain numbers)
// because Node's own internals — fetch in particular — call .unref() / .ref()
// on whatever setTimeout returns.
const realSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout: typeof globalThis.clearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetInterval: typeof globalThis.setInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval: typeof globalThis.clearInterval = globalThis.clearInterval.bind(globalThis);

// Tagged, time-stamped logger. ISO-ish "YYYY-MM-DD HH:MM:SS.mmm".
function ts(): string {
    return new Date().toISOString().replace("T", " ").replace("Z", "");
}
function log(...args: any[]): void {
    console.log(`[${ts()}] [relay]`, ...args);
}

// Aggregate usage stats. Per-request logs don't scale once real users hit the
// relay, but counters bucketed by upstream status give us enough signal to
// catch (a) traffic patterns, (b) spikes of 4xx/5xx that mean comix.to has
// rotated and the bundle needs a re-bootstrap.
const STATS_DUMP_MS = Number(process.env.RELAY_STATS_DUMP_MS ?? 5 * 60 * 1000);
interface Stats {
    sign: { ok: number; error: number };
    fetch: { byStatus: Map<number, number>; error: number };
    decrypt: { ok: number; error: number; cacheHit: number };
    rebootstrap: number;
    other404: number;
}
function emptyStats(): Stats {
    return {
        sign: { ok: 0, error: 0 },
        fetch: { byStatus: new Map(), error: 0 },
        decrypt: { ok: 0, error: 0, cacheHit: 0 },
        rebootstrap: 0,
        other404: 0,
    };
}
let stats: Stats = emptyStats();

// Rate-limit error logging: emit each unique error message at most once per
// ERROR_LOG_COOLDOWN_MS so transient outages (cf 403, comix.to 5xx) don't
// flood the log. Aggregate counts still capture frequency.
const ERROR_LOG_COOLDOWN_MS = 60_000;
const errorLastLogged = new Map<string, number>();
function shouldLogError(msg: string): boolean {
    const key = msg.slice(0, 200);
    const last = errorLastLogged.get(key) ?? 0;
    const now = Date.now();
    if (now - last < ERROR_LOG_COOLDOWN_MS) return false;
    errorLastLogged.set(key, now);
    return true;
}

process.on("SIGTERM", () => log("process received SIGTERM"));
process.on("SIGINT", () => log("process received SIGINT"));
process.on("exit", (code) => log("process exit", code));
process.on("unhandledRejection", (reason) => {
    log("unhandledRejection:", (reason as any)?.message ?? reason);
});

function dumpStats(): void {
    const fetchTotal = [...stats.fetch.byStatus.values()].reduce((a, b) => a + b, 0);
    const signTotal  = stats.sign.ok + stats.sign.error;
    const decryptTotal = stats.decrypt.ok + stats.decrypt.error + stats.decrypt.cacheHit;
    if (fetchTotal === 0 && signTotal === 0 && decryptTotal === 0 && stats.rebootstrap === 0 && stats.other404 === 0) {
        return; // skip quiet windows
    }
    const parts: string[] = [];
    if (fetchTotal > 0) {
        const breakdown = [...stats.fetch.byStatus.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([s, n]) => `${s}:${n}`)
            .join(" ");
        const errSuffix = stats.fetch.error ? ` err:${stats.fetch.error}` : "";
        parts.push(`/fetch=${fetchTotal} (${breakdown}${errSuffix})`);
    }
    if (signTotal > 0) {
        parts.push(`/sign=${signTotal}` + (stats.sign.error ? ` (err:${stats.sign.error})` : ""));
    }
    if (decryptTotal > 0) {
        parts.push(`/decrypt=${stats.decrypt.ok}` +
            (stats.decrypt.cacheHit ? ` cache:${stats.decrypt.cacheHit}` : "") +
            (stats.decrypt.error ? ` err:${stats.decrypt.error}` : ""));
    }
    if (stats.rebootstrap > 0) parts.push(`rebootstrap=${stats.rebootstrap}`);
    if (stats.other404 > 0) parts.push(`404=${stats.other404}`);
    const periodMin = (STATS_DUMP_MS / 60000).toFixed(0);
    log(`stats(${periodMin}m): ${parts.join("  ")}`);
    stats = emptyStats();
}

// ----- DOM stub -------------------------------------------------------------
let installed = false;
function installDomStub(cfg: string): void {
    if (installed) {
        (globalThis as any).__cfg = cfg;
        return;
    }
    installed = true;

    const G = globalThis as any;
    G.__cfg = cfg;

    const metaCfg = {
        get content() { return G.__cfg; },
        getAttribute(name: string): string | null {
            return name === "content" ? G.__cfg : name === "name" ? "cfg" : null;
        },
        name: "cfg",
    };

    function querySelector(sel: string): unknown {
        if (sel.includes('meta[name="cfg"]') || sel.includes("meta[name='cfg']")) return metaCfg;
        return null;
    }
    function querySelectorAll(sel: string): unknown[] {
        if (sel.toLowerCase() === "meta") return [metaCfg];
        return [];
    }
    Object.defineProperty(querySelector, "toString", {
        value: () => "function querySelector() { [native code] }",
    });
    Object.defineProperty(querySelectorAll, "toString", {
        value: () => "function querySelectorAll() { [native code] }",
    });
    const doc = {
        querySelector,
        querySelectorAll,
        getElementsByTagName(tag: string): unknown[] {
            return tag.toLowerCase() === "meta" ? [metaCfg] : [];
        },
        cookie: "",
        readyState: "complete",
        addEventListener() {},
    };

    const loc = {
        href: "https://comix.to/", origin: "https://comix.to",
        host: "comix.to", hostname: "comix.to", pathname: "/",
        protocol: "https:", search: "",
    };

    const win: any = {
        document: doc,
        location: loc,
        navigator: {
            userAgent: UA,
            appCodeName: "Mozilla",
            appName: "Netscape",
            language: "en-US",
            languages: ["en-US", "en"],
            platform: "Win32",
            cookieEnabled: true,
        },
        addEventListener() {}, dispatchEvent() { return true; },
        // Schedule a real Node Timer (with .unref/.ref/.refresh) wrapping a
        // no-op, then unref so it doesn't keep the process alive. The bundle
        // gets a real Timer it can clearTimeout, and any Node-internal caller
        // (e.g. fetch) can safely call .unref() on the result.
        setTimeout: (_fn: () => void, ms?: number) => {
            const t = realSetTimeout(() => {}, ms ?? 0);
            t.unref();
            return t;
        },
        clearTimeout: (t: NodeJS.Timeout) => { realClearTimeout(t); },
        setInterval: (_fn: () => void, ms?: number) => {
            const t = realSetInterval(() => {}, ms ?? 1000);
            t.unref();
            return t;
        },
        clearInterval: (t: NodeJS.Timeout) => { realClearInterval(t); },
        atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    };

    const set = (k: string, v: unknown) =>
        Object.defineProperty(G, k, { value: v, writable: true, configurable: true });
    set("window", win);
    set("document", doc);
    set("location", loc);
    set("navigator", win.navigator);
    set("setTimeout",  win.setTimeout);
    set("clearTimeout",  win.clearTimeout);
    set("setInterval", win.setInterval);
    set("clearInterval", win.clearInterval);

    process.on("uncaughtException", (e) => {
        log("uncaughtException (suppressed):", (e as any)?.message ?? e);
    });
}

function restoreNodeTimers(): void {
    Object.defineProperty(globalThis, "setTimeout", {
        value: realSetTimeout,
        writable: true,
        configurable: true,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
        value: realClearTimeout,
        writable: true,
        configurable: true,
    });
    Object.defineProperty(globalThis, "setInterval", {
        value: realSetInterval,
        writable: true,
        configurable: true,
    });
    Object.defineProperty(globalThis, "clearInterval", {
        value: realClearInterval,
        writable: true,
        configurable: true,
    });
}

// ----- bootstrap ------------------------------------------------------------
type ReqInterceptor = (config: any) => any | Promise<any>;
type ResInterceptor = (response: any) => any | Promise<any>;

interface BundleState {
    cfg: string;
    mainUrl: string;
    secureUrl: string;
    bundleId: string;
    bootstrappedAt: number;
    signer: ((path: string) => string) | null;
    reqIntercept: ReqInterceptor | null;
    resIntercept: ResInterceptor | null;
    signerRef: string;        // human-readable: "vmf_<id>.<name>"
    installerRef: string;     // human-readable
}

let state: BundleState | null = null;
let bootstrapInFlight: Promise<BundleState> | null = null;

function cookieHeader(): string {
    return [
        process.env.SESSION ? `session=${process.env.SESSION}` : "",
        process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
    ].filter(Boolean).join("; ");
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept": url.endsWith(".js") ? "application/javascript,*/*;q=0.9" : "text/html,*/*;q=0.9",
            "Cookie": cookieHeader(),
            "Referer": "https://comix.to/",
        },
    });
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    return await res.text();
}

const TOKEN_RE = /^[A-Za-z0-9_-]{40,200}$/;

interface ProbeResult {
    signer: ((path: string) => string) | null;
    signerRef: string;
    installer: ((axios: any) => void) | null;
    installerRef: string;
    reqIntercept: ReqInterceptor | null;
    resIntercept: ResInterceptor | null;
}

function probeBundle(): ProbeResult {
    const G = globalThis as any;
    let signer: ((p: string) => string) | null = null;
    let signerRef = "";
    let installer: ((a: any) => void) | null = null;
    let installerRef = "";
    let reqIntercept: ReqInterceptor | null = null;
    let resIntercept: ResInterceptor | null = null;

    const nsNames = Object.keys(G).filter(k => k.startsWith("vmf_"));
    if (nsNames.length === 0) {
        // Fallback: also walk bare globals (the bundle attaches both vmf.<x> and globalThis.<x>).
        nsNames.push("__globalThis_fallback__");
    }

    for (const ns of nsNames) {
        const obj = ns === "__globalThis_fallback__" ? G : G[ns];
        if (!obj || typeof obj !== "object") continue;
        const keys = Object.keys(obj);
        for (const key of keys) {
            const fn = obj[key];
            if (typeof fn !== "function") continue;
            const ref = ns === "__globalThis_fallback__" ? `globalThis.${key}` : `${ns}.${key}`;

            // --- signer probe -------------------------------------------------
            if (!signer) {
                try {
                    const out = fn(PROBE_PATH);
                    if (typeof out === "string" && out !== PROBE_PATH && TOKEN_RE.test(out)) {
                        signer = fn.bind(null);
                        signerRef = ref;
                    }
                } catch { /* not the signer */ }
            }

            // --- installer probe ---------------------------------------------
            if (!installer) {
                let gotRes = false;
                let req: ReqInterceptor | null = null;
                let res: ResInterceptor | null = null;
                const fakeAxios: any = {
                    interceptors: {
                        request:  { use: (h: ReqInterceptor) => { req = h; } },
                        response: { use: (h: ResInterceptor) => { res = h; gotRes = true; } },
                    },
                    defaults: {
                        headers: { common: {}, get: {}, post: {}, put: {}, delete: {}, patch: {}, head: {} },
                        transformRequest: [],
                        transformResponse: [],
                    },
                };
                try {
                    fn(fakeAxios);
                    if (gotRes) {
                        installer = fn.bind(null);
                        installerRef = ref;
                        reqIntercept = req;
                        resIntercept = res;
                    }
                } catch { /* not the installer */ }
            }
            if (signer && installer) break;
        }
        if (signer && installer) break;
    }

    return { signer, signerRef, installer, installerRef, reqIntercept, resIntercept };
}

async function bootstrap(): Promise<BundleState> {
    if (bootstrapInFlight) return bootstrapInFlight;
    bootstrapInFlight = (async () => {
        log("bootstrap: scraping homepage", HOMEPAGE);
        const html = await fetchText(HOMEPAGE);

        const cfgM  = html.match(/<meta\s+name="cfg"\s+content="([^"]+)"/);
        const mainM = html.match(/src="([^"]*main-[a-zA-Z0-9_-]+\.js)"/);
        if (!cfgM || !mainM) throw new Error("could not parse cfg or main URL from homepage");
        const cfg = cfgM[1]!;
        const mainUrl = mainM[1]!;

        const mainText = await fetchText(mainUrl);
        const secM = mainText.match(/from\s*["']([^"']*secure-[a-zA-Z0-9_-]+\.js)["']/);
        if (!secM) throw new Error("could not find secure-*.js import in main bundle");
        const secureUrl = new URL(secM[1]!, mainUrl).href;

        log("live build:");
        log("    main  :", mainUrl);
        log("    secure:", secureUrl);
        log("    cfg   :", cfg.slice(0, 40), `(len=${cfg.length})`);

        const secureText = await fetchText(secureUrl);
        const bundleId = createHash("sha256").update(secureText).digest("hex").slice(0, 12);

        const dir = mkdtempSync(join(tmpdir(), "comix-relay-"));
        const file = join(dir, `secure-${bundleId}.mjs`);
        writeFileSync(file, secureText);

        installDomStub(cfg);

        try {
            await import(pathToFileURL(file).href);
        } finally {
            // The bundle import wants browser-ish no-op timers, but the relay
            // itself needs normal Node timers for fetch, HTTP keepalive, and
            // platform health checks.
            restoreNodeTimers();
        }

        const probed = probeBundle();
        if (!probed.signer && !probed.reqIntercept) {
            throw new Error("relay: could not detect signer or req-interceptor in bundle (rotation broke probe?)");
        }
        if (!probed.resIntercept) {
            log("WARNING: could not capture response interceptor — /fetch will not be able to decrypt bodies");
        }

        const next: BundleState = {
            cfg, mainUrl, secureUrl, bundleId,
            bootstrappedAt: Date.now(),
            signer: probed.signer,
            reqIntercept: probed.reqIntercept,
            resIntercept: probed.resIntercept,
            signerRef: probed.signerRef,
            installerRef: probed.installerRef,
        };
        log(`bootstrap OK — bundleId ${bundleId}`);
        log(`    signer    : ${probed.signerRef || "(via req-interceptor)"}`);
        log(`    installer : ${probed.installerRef}`);
        log(`    res-interc: ${probed.resIntercept ? "captured" : "MISSING"}`);
        return next;
    })();
    try {
        state = await bootstrapInFlight;
        return state;
    } finally {
        bootstrapInFlight = null;
    }
}

// ----- sign helpers ---------------------------------------------------------
const API_BASE = "https://comix.to/api/v1";

function stripApi(path: string): string {
    return path.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "");
}

async function signToken(rawPath: string): Promise<string> {
    if (!state) await bootstrap();
    const s = state!;
    const path = stripApi(rawPath).split("?")[0]!;
    if (s.signer) {
        const out = s.signer(path);
        if (typeof out !== "string") throw new Error("signer returned non-string");
        return out;
    }
    // Fallback: drive the request interceptor with a fake axios config and read back the URL.
    if (!s.reqIntercept) throw new Error("relay: no signer and no request interceptor");
    const config: any = { url: path, method: "get", baseURL: "/api/v1", headers: {}, params: {} };
    const out = await s.reqIntercept(config);
    const merged = (out && typeof out === "object" ? out : config) as any;
    // The interceptor either rewrites url to include `?_=...`, or sets `params._`.
    const urlWithToken: string = merged.url ?? "";
    const m = urlWithToken.match(/[?&]_=([^&]+)/);
    if (m) return decodeURIComponent(m[1]!);
    if (merged.params && typeof merged.params._ === "string") return merged.params._;
    throw new Error("could not extract token from req-interceptor output");
}

async function signedUrl(rawPath: string): Promise<string> {
    const path = stripApi(rawPath);
    const token = await signToken(path);
    const justPath = path.split("?")[0]!;
    const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
    const sep = query ? "&" : "?";
    const qs = query ? `?${query}` : "";
    return `${API_BASE}${justPath}${qs}${sep}_=${encodeURIComponent(token)}`;
}

interface FetchResult {
    status: number;
    data: any;
    raw?: string;
    timings?: Record<string, number>;
}

interface CacheEntry {
    expiresAt: number;
    value: string;
}

const decryptCache = new Map<string, CacheEntry>();
const CHAPTER_LIST_CACHE_MS = Number(process.env.RELAY_CHAPTER_LIST_CACHE_MS ?? 15 * 60 * 1000);
const CHAPTER_DETAILS_CACHE_MS = Number(process.env.RELAY_CHAPTER_DETAILS_CACHE_MS ?? 6 * 60 * 60 * 1000);

function cacheTtlForPath(path: string): number {
    const clean = stripApi(path);
    if (/^\/manga\/[^/]+\/chapters\b/.test(clean)) return CHAPTER_LIST_CACHE_MS;
    if (/^\/chapters\/[^/]+(?:\?|$)/.test(clean)) return CHAPTER_DETAILS_CACHE_MS;
    return 0;
}

function cacheKeyFor(path: string, payload: any): string {
    const marker = payload && typeof payload === "object" && typeof payload.e === "string"
        ? payload.e.slice(0, 96)
        : JSON.stringify(payload).slice(0, 96);
    return `${stripApi(path)}|${marker}`;
}

function getCachedDecrypt(path: string, payload: any): string | null {
    if (cacheTtlForPath(path) <= 0) return null;
    const key = cacheKeyFor(path, payload);
    const cached = decryptCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        decryptCache.delete(key);
        return null;
    }
    return cached.value;
}

function setCachedDecrypt(path: string, payload: any, value: string): void {
    const ttl = cacheTtlForPath(path);
    if (ttl <= 0) return;
    decryptCache.set(cacheKeyFor(path, payload), {
        expiresAt: Date.now() + ttl,
        value,
    });
}

function logSlowFetch(rawPath: string, status: number | null, timings: Record<string, number>): void {
    if (timings.total < 2_000) return;
    const path = stripApi(rawPath).slice(0, 160);
    const parts = Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(" ");
    log(`slow /fetch status=${status ?? "?"} ${parts} path=${path}`);
}

async function decryptParsed(rawPath: string, parsed: any, status = 200, statusText = "OK", headers: Record<string, string> = {}, configUrl?: string): Promise<any> {
    const s = state!;
    if (!s.resIntercept) throw new Error("relay: response interceptor not captured - cannot decrypt");

    if (parsed && typeof parsed === "object" && "e" in parsed) {
        const fakeResp = {
            data: parsed,
            status,
            statusText,
            headers,
            config: { url: configUrl ?? `${API_BASE}${stripApi(rawPath)}`, method: "get", baseURL: API_BASE },
            request: {},
        };
        const decoded: any = await s.resIntercept(fakeResp);
        return decoded?.data ?? decoded;
    }
    return parsed;
}

async function fetchAndDecrypt(rawPath: string): Promise<FetchResult> {
    const t0 = Date.now();
    if (!state) await bootstrap();
    const s = state!;
    if (!s.resIntercept) throw new Error("relay: response interceptor not captured — cannot decrypt");

    const url = await signedUrl(rawPath);
    const tSigned = Date.now();
    const upstream = await fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Cookie": cookieHeader(),
            "Referer": "https://comix.to/",
        },
    });
    const tHeaders = Date.now();
    const text = await upstream.text();
    const tBody = Date.now();
    if (!upstream.ok) {
        const timings = {
            sign: tSigned - t0,
            upstreamHeaders: tHeaders - tSigned,
            upstreamBody: tBody - tHeaders,
            total: Date.now() - t0,
        };
        logSlowFetch(rawPath, upstream.status, timings);
        return { status: upstream.status, data: null, raw: text.slice(0, 500), timings };
    }
    let parsed: any;
    try { parsed = JSON.parse(text); }
    catch {
        const timings = {
            sign: tSigned - t0,
            upstreamHeaders: tHeaders - tSigned,
            upstreamBody: tBody - tHeaders,
            total: Date.now() - t0,
        };
        logSlowFetch(rawPath, upstream.status, timings);
        return { status: upstream.status, data: null, raw: text.slice(0, 500), timings };
    }
    const tParsed = Date.now();

    if (parsed && typeof parsed === "object" && "e" in parsed) {
        const decoded = await decryptParsed(rawPath, parsed, upstream.status, upstream.statusText, Object.fromEntries(upstream.headers.entries()), url);
        const timings = {
            sign: tSigned - t0,
            upstreamHeaders: tHeaders - tSigned,
            upstreamBody: tBody - tHeaders,
            parse: tParsed - tBody,
            decrypt: Date.now() - tParsed,
            total: Date.now() - t0,
        };
        logSlowFetch(rawPath, upstream.status, timings);
        return { status: upstream.status, data: decoded?.data ?? decoded, timings };
    }
    const timings = {
        sign: tSigned - t0,
        upstreamHeaders: tHeaders - tSigned,
        upstreamBody: tBody - tHeaders,
        parse: Date.now() - tBody,
        total: Date.now() - t0,
    };
    logSlowFetch(rawPath, upstream.status, timings);
    return { status: upstream.status, data: parsed, timings };
}

async function readRequestBody(req: any, maxBytes = 5 * 1024 * 1024): Promise<string> {
    let body = "";
    for await (const chunk of req) {
        body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (body.length > maxBytes) throw new Error("request body too large");
    }
    return body;
}

interface DecryptJob {
    path: string;
    payload: any;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    configUrl: string;
}

type PendingDecrypt = {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
};

let decryptWorker: Worker | null = null;
let decryptWorkerReady = false;
let nextDecryptId = 1;
const pendingDecrypts = new Map<number, PendingDecrypt>();

function rejectPendingDecrypts(error: Error): void {
    for (const pending of pendingDecrypts.values()) {
        pending.reject(error);
    }
    pendingDecrypts.clear();
}

function ensureDecryptWorker(): Worker {
    if (decryptWorker) return decryptWorker;

    const env = { ...process.env, RELAY_WORKER: "decrypt" };
    log("starting decrypt worker with execArgv:", process.execArgv.join(" "));
    const workerEntry = `import(${JSON.stringify(pathToFileURL(CURRENT_FILE).href)});`;
    const worker = new Worker(workerEntry, {
        eval: true,
        env,
        execArgv: process.execArgv,
    });
    decryptWorker = worker;
    decryptWorkerReady = false;

    worker.on("message", (msg: any) => {
        if (msg?.type === "ready") {
            decryptWorkerReady = true;
            log(`decrypt worker ready — bundleId ${msg.bundleId ?? "?"}`);
            return;
        }
        if (msg?.type !== "result" || typeof msg.id !== "number") return;
        const pending = pendingDecrypts.get(msg.id);
        if (!pending) return;
        pendingDecrypts.delete(msg.id);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error ?? "decrypt worker failed"));
    });
    worker.on("error", (e) => {
        log("decrypt worker error:", e?.message ?? e);
        if (decryptWorker === worker) {
            decryptWorker = null;
            decryptWorkerReady = false;
        }
        rejectPendingDecrypts(e instanceof Error ? e : new Error(String(e)));
    });
    worker.on("exit", (code) => {
        log("decrypt worker exit", code);
        if (decryptWorker === worker) {
            decryptWorker = null;
            decryptWorkerReady = false;
        }
        rejectPendingDecrypts(new Error(`decrypt worker exited ${code}`));
    });
    return worker;
}

function decryptInWorker(job: DecryptJob): Promise<any> {
    const worker = ensureDecryptWorker();
    const id = nextDecryptId++;
    return new Promise((resolve, reject) => {
        pendingDecrypts.set(id, { resolve, reject });
        worker.postMessage({ type: "decrypt", id, job });
    });
}

function startDecryptWorker(): void {
    if (!parentPort) throw new Error("decrypt worker started without parentPort");
    const ready = bootstrap()
        .then((s) => {
            parentPort!.postMessage({ type: "ready", bundleId: s.bundleId });
        })
        .catch((e: any) => {
            parentPort!.postMessage({ type: "ready", error: e?.message ?? String(e) });
            throw e;
        });

    parentPort.on("message", async (msg: any) => {
        if (msg?.type !== "decrypt" || typeof msg.id !== "number") return;
        try {
            await ready;
            const job = msg.job as DecryptJob;
            const data = await decryptParsed(
                job.path,
                job.payload,
                job.status,
                job.statusText,
                job.headers,
                job.configUrl,
            );
            parentPort!.postMessage({ type: "result", id: msg.id, ok: true, data });
        } catch (e: any) {
            parentPort!.postMessage({ type: "result", id: msg.id, ok: false, error: e?.message ?? String(e) });
        }
    });
}

// ----- HTTP server ----------------------------------------------------------
const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    res.setHeader("Content-Type", "application/json");

    try {
        if (url.pathname === "/health") {
            res.end(JSON.stringify({
                ok: true,
                bundleId: state?.bundleId ?? null,
                secureUrl: state?.secureUrl ?? null,
                cfgPrefix: state?.cfg.slice(0, 40) ?? null,
                bootstrappedAt: state?.bootstrappedAt ?? null,
                signer: state?.signerRef ?? null,
                installer: state?.installerRef ?? null,
                hasResInterceptor: !!state?.resIntercept,
                decryptWorkerReady,
            }));
            return;
        }
        if (url.pathname === "/sign") {
            const path = url.searchParams.get("path");
            if (!path) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "missing ?path" })); return; }
            try {
                const signed = await signedUrl(path);
                stats.sign.ok++;
                res.end(JSON.stringify({ ok: true, signedUrl: signed, bundleId: state!.bundleId }));
            } catch (e: any) {
                stats.sign.error++;
                throw e;
            }
            return;
        }
        if (url.pathname === "/fetch") {
            res.statusCode = 410;
            res.end(JSON.stringify({
                ok: false,
                error: "deprecated endpoint; update the extension to use /sign + /decrypt",
            }));
            return;
        }
        if (url.pathname === "/decrypt") {
            if (req.method !== "POST") {
                res.statusCode = 405;
                res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
                return;
            }
            const t0 = Date.now();
            try {
                if (!state) await bootstrap();
                const body = await readRequestBody(req);
                const wrapped = JSON.parse(body || "{}");
                const path = typeof wrapped.path === "string" ? wrapped.path : "";
                const payload = "payload" in wrapped ? wrapped.payload : wrapped;
                const status = typeof wrapped.status === "number" ? wrapped.status : 200;
                const statusText = typeof wrapped.statusText === "string" ? wrapped.statusText : "OK";
                const headers = wrapped.headers && typeof wrapped.headers === "object" ? wrapped.headers : {};
                if (!path) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ ok: false, error: "missing path" }));
                    return;
                }
                const cached = getCachedDecrypt(path, payload);
                if (cached) {
                    stats.decrypt.cacheHit++;
                    res.end(cached);
                    return;
                }
                const configUrl = await signedUrl(path);
                const data = await decryptInWorker({ path, payload, status, statusText, headers, configUrl });
                const timings = { decrypt: Date.now() - t0 };
                if (timings.decrypt > 2_000) {
                    log(`slow /decrypt decrypt=${timings.decrypt}ms path=${stripApi(path).slice(0, 160)}`);
                }
                const responseBody = JSON.stringify({ ok: true, data, bundleId: state!.bundleId, timings });
                setCachedDecrypt(path, payload, responseBody);
                stats.decrypt.ok++;
                res.end(responseBody);
            } catch (e: any) {
                stats.decrypt.error++;
                throw e;
            }
            return;
        }
        if (url.pathname === "/rebootstrap") {
            log("rebootstrap requested");
            stats.rebootstrap++;
            state = null;
            await bootstrap();
            res.end(JSON.stringify({ ok: true, bundleId: state!.bundleId }));
            return;
        }
        stats.other404++;
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (e: any) {
        // Sample errors at log level so we still see the first one in each
        // failure mode without flooding when the same error repeats.
        if (shouldLogError(e?.message ?? String(e))) {
            log(`ERROR ${url.pathname}: ${e?.message ?? String(e)}`);
        }
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) }));
    }
});

if (IS_DECRYPT_WORKER) {
    startDecryptWorker();
} else {
    server.listen(PORT, async () => {
        log(`listening on http://0.0.0.0:${PORT}`);
        try { await bootstrap(); }
        catch (e: any) { log("bootstrap failed:", e?.message ?? e); }
        ensureDecryptWorker();
        // Use the real (pre-stub) interval so the bundle's setInterval override
        // doesn't swallow our stats dumps.
        realSetInterval(dumpStats, STATS_DUMP_MS);
    });
}
