export {};

/**
 * Comix.to URL-signing relay (local prototype).
 *
 *   GET /sign?path=/chapters/9000025
 *     → { ok: true, signedUrl: "https://comix.to/api/v1/chapters/9000025?_=..." }
 *
 *   GET /health
 *     → { ok: true, bundleId, cfgPrefix, lastBootstrap }
 *
 * Strategy:
 *   1. On boot, scrape https://comix.to/title/xlyyj-eleceed for:
 *        <meta name="cfg" content="...">
 *        <script src=".../main-<id>.js">
 *      Fetch main.js, parse its `import "./secure-<id>.js"` to get the secure URL.
 *      Download the secure bundle to a unique temp file and dynamic-import it.
 *      Install DOM stub (just navigator.appCodeName="Mozilla" + cfg meta) and
 *      attach the bundle's interceptor to a single shared axios instance.
 *   2. /sign uses that axios instance. On 403 "Invalid token", trigger a
 *      bootstrap retry (treat as bundle rotation) and try once more.
 *   3. setTimeout is stubbed so the bundle's recurring background work never
 *      fires — keeps logs quiet and avoids leaking timers.
 *
 * Run:
 *   npx tsx --env-file=.env experiment/relay/Server.ts
 */

import axios, { type AxiosInstance } from "axios";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const PORT       = Number(process.env.RELAY_PORT ?? 9091);
const HOMEPAGE   = process.env.RELAY_PROBE_URL ?? "https://comix.to/title/xlyyj-eleceed";
const UA         = process.env.USER_AGENT  ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ----- DOM stub ----------------------------------------------------------
let installed = false;
const stubbedTimers: Set<number> = new Set();
function installDomStub(cfg: string): void {
    if (installed) {
        // update cfg in place
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

    // Bundle's ce() anti-tamper check requires querySelector.toString() to
    // match a native-function regex; if it fails, every key-loading function
    // silently corrupts its key bytes and signing produces useless tokens.
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
            appCodeName: "Mozilla",   // VM decryption-key seed
            appName: "Netscape",
            language: "en-US",
            languages: ["en-US", "en"],
            platform: "Win32",
            cookieEnabled: true,
        },
        addEventListener() {}, dispatchEvent() { return true; },
        // Stub timers so the bundle's recurring background work never fires.
        // We still return ids so any clearTimeout call from the bundle works.
        setTimeout: (_fn: () => void, _ms?: number) => {
            const id = ++stubTimerSeq;
            stubbedTimers.add(id);
            return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (id: number) => { stubbedTimers.delete(id); },
        setInterval: (_fn: () => void, _ms?: number) => {
            const id = ++stubTimerSeq;
            stubbedTimers.add(id);
            return id as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: (id: number) => { stubbedTimers.delete(id); },
        atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    };

    const set = (k: string, v: unknown) =>
        Object.defineProperty(G, k, { value: v, writable: true, configurable: true });
    set("window", win);
    set("document", doc);
    set("location", loc);
    set("navigator", win.navigator);
    // Override the real timers globally too, so the bundle picks them up
    // whether it reads via window.setTimeout or bare setTimeout.
    set("setTimeout",  win.setTimeout);
    set("clearTimeout",  win.clearTimeout);
    set("setInterval", win.setInterval);
    set("clearInterval", win.clearInterval);

    process.on("uncaughtException", (e) => {
        console.log("[relay] uncaughtException (suppressed):", (e as any)?.message ?? e);
    });
}
let stubTimerSeq = 0;

// ----- bootstrap: download and load live bundle --------------------------
type BundleState = {
    cfg: string;
    mainUrl: string;
    secureUrl: string;
    bundleId: string;       // hash of secure source
    bootstrappedAt: number;
    axios: AxiosInstance;
};

let state: BundleState | null = null;
let bootstrapInFlight: Promise<BundleState> | null = null;

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept": url.endsWith(".js") ? "application/javascript,*/*;q=0.9" : "text/html,*/*;q=0.9",
            "Cookie": [
                process.env.SESSION ? `session=${process.env.SESSION}` : "",
                process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
            ].filter(Boolean).join("; "),
            "Referer": "https://comix.to/",
        },
    });
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    return await res.text();
}

async function bootstrap(): Promise<BundleState> {
    if (bootstrapInFlight) return bootstrapInFlight;
    bootstrapInFlight = (async () => {
        console.log("[relay] bootstrap: scraping homepage", HOMEPAGE);
        const html = await fetchText(HOMEPAGE);

        const cfgM  = html.match(/<meta\s+name="cfg"\s+content="([^"]+)"/);
        const mainM = html.match(/src="([^"]*main-[a-zA-Z0-9_-]+\.js)"/);
        if (!cfgM || !mainM) throw new Error("could not parse cfg or main URL from homepage");
        const cfg = cfgM[1]!;
        const mainUrl = mainM[1]!;

        const mainText = await fetchText(mainUrl);
        const secM = mainText.match(/from\s*["']([^"']*secure-[a-zA-Z0-9_-]+\.js)["']/);
        if (!secM) throw new Error("could not find secure-*.js import in main bundle");
        const secureUrlRel = secM[1]!;
        const secureUrl = new URL(secureUrlRel, mainUrl).href;

        console.log("[relay] live build:");
        console.log("    main  :", mainUrl);
        console.log("    secure:", secureUrl);
        console.log("    cfg   :", cfg.slice(0, 40), `(len=${cfg.length})`);

        const secureText = await fetchText(secureUrl);
        const bundleId = createHash("sha256").update(secureText).digest("hex").slice(0, 12);

        // Save under unique filename so dynamic import isn't cached against an old version.
        const dir = mkdtempSync(join(tmpdir(), "comix-relay-"));
        const file = join(dir, `secure-${bundleId}.mjs`);
        writeFileSync(file, secureText);

        installDomStub(cfg);

        const mod: any = await import(pathToFileURL(file).href);
        if (typeof mod.n !== "function") throw new Error("secure bundle missing export `n`");

        const ax = axios.create({
            baseURL: "https://comix.to/api/v1",
            withCredentials: true,
            timeout: 15000,
            headers: {
                "Accept": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                "User-Agent": UA,
                "Referer": "https://comix.to/",
                "Cookie": [
                    process.env.SESSION ? `session=${process.env.SESSION}` : "",
                    process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
                ].filter(Boolean).join("; "),
            },
        });
        mod.n(ax);

        const next: BundleState = {
            cfg, mainUrl, secureUrl, bundleId,
            bootstrappedAt: Date.now(),
            axios: ax,
        };
        console.log("[relay] bootstrap OK — bundleId", bundleId);
        return next;
    })();
    try {
        state = await bootstrapInFlight;
        return state;
    } finally {
        bootstrapInFlight = null;
    }
}

// ----- sign --------------------------------------------------------------
async function signPath(path: string): Promise<string> {
    if (!state) await bootstrap();
    let s = state!;

    // Capture the URL the interceptor produces by short-circuiting via a custom adapter
    // on a per-request basis (we don't want to fight the shared instance's adapter).
    // Easiest: fire the request and read response.config.url after.
    let signed = "";
    s.axios.defaults.adapter = (config: any) => {
        const params = config.params ?? {};
        const qs: string[] = [];
        for (const k of Object.keys(params)) qs.push(`${k}=${encodeURIComponent(String(params[k]))}`);
        const sep = config.url.includes("?") ? "&" : (qs.length ? "?" : "");
        signed = `${s.axios.defaults.baseURL ?? ""}${config.url}${qs.length ? sep + qs.join("&") : ""}`;
        return Promise.resolve({ data: {}, status: 200, statusText: "OK", headers: {}, config, request: {} });
    };
    await s.axios.get(path);
    return signed;
}

// ----- HTTP server -------------------------------------------------------
const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    res.setHeader("Content-Type", "application/json");

    try {
        if (url.pathname === "/health") {
            res.end(JSON.stringify({
                ok: true,
                bundleId: state?.bundleId ?? null,
                bundleSecureUrl: state?.secureUrl ?? null,
                cfgPrefix: state?.cfg.slice(0, 40) ?? null,
                bootstrappedAt: state?.bootstrappedAt ?? null,
            }));
            return;
        }
        if (url.pathname === "/sign") {
            const path = url.searchParams.get("path");
            if (!path) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "missing ?path" })); return; }
            const signed = await signPath(path);
            res.end(JSON.stringify({ ok: true, signedUrl: signed, bundleId: state!.bundleId }));
            return;
        }
        if (url.pathname === "/rebootstrap") {
            state = null;
            await bootstrap();
            res.end(JSON.stringify({ ok: true, bundleId: state!.bundleId }));
            return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) }));
    }
});

server.listen(PORT, async () => {
    console.log(`[relay] listening on http://0.0.0.0:${PORT}`);
    try { await bootstrap(); }
    catch (e: any) { console.log("[relay] bootstrap failed:", e?.message ?? e); }
});
