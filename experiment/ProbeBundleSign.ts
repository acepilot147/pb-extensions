export {};

/**
 * Path-2 (hybrid) probe: load comix.to's secure-*.js bundle in Node with a
 * minimal DOM/window stub, attach its request interceptor to a real axios
 * instance, fire a /chapters/9000025 request, and capture the URL the
 * interceptor produced (with the `_=` token).
 *
 * Goal: confirm we can drive the bundle headlessly and reproduce the browser
 * token *outside the browser*. If that works, the next step is to port the
 * VM interpreter (vmR_67c653) + the bytecode array to plain TypeScript so it
 * runs in Paperback's JSC.
 *
 * Run:
 *   npx tsx --env-file=.env experiment/ProbeBundleSign.ts
 *
 * Required env (already in .env):
 *   USER_AGENT, SESSION, CF_CLEARANCE  (only used to send the *signed* URL
 *   back to comix.to to confirm the token is accepted; not needed to *produce*
 *   a token).
 */

import axios from "axios";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

// ----- known fixtures (browser-captured) ---------------------------------
// (these are tied to a *previous* session; cfg likely changes per build)
const KNOWN_PATH  = "/chapters/9000025";
const KNOWN_TOKEN = "bemJ-0y5bduXT9upsFZyqV4s6RO7JKSqdGy_wtVw2MsEpRV3yl8xub6LeSndTeuS_h7dCQtn";

// fallback cfg from a previous capture; only used if live fetch fails.
const CFG_FALLBACK =
    "ZZYdbXagjEpeaRwTE56mTpBkKVnnIBmAB3gdwWXXjEM7ZqAcLgonw0ylNjY621zM0zefn1Qg_jIQEn0oAIFnaXeGk3K4XZgY6S1Ldadwahluwgs-siIh0m-Lbw";

const SECURE_BUNDLE_TAG = "tepbo3";  // build tag in our local secure file

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SECURE_PATH = resolve(__dirname, "comix-js", "secure-tepbo3-D-azrxPk.js");

// ----- DOM/window stub ---------------------------------------------------
function installDomStub(cfg: string): void {
    const metaCfg = {
        getAttribute(name: string): string | null {
            return name === "content" ? cfg : name === "name" ? "cfg" : null;
        },
        content: cfg,
        name: "cfg",
    };

    const doc = {
        querySelector(sel: string): unknown {
            if (sel.includes('meta[name="cfg"]') || sel.includes("meta[name='cfg']")) return metaCfg;
            return null;
        },
        querySelectorAll(_sel: string): unknown[] { return []; },
        getElementsByTagName(tag: string): unknown[] {
            if (tag.toLowerCase() === "meta") return [metaCfg];
            return [];
        },
        cookie: "",
        readyState: "complete",
        addEventListener() {},
    };

    const loc = {
        href: "https://comix.to/",
        origin: "https://comix.to",
        host: "comix.to",
        hostname: "comix.to",
        pathname: "/",
        protocol: "https:",
        search: "",
    };

    const win: any = {
        document: doc,
        location: loc,
        // VM decryption key derives from navigator.appCodeName — always "Mozilla"
        // in any real browser. Bundle throws "VM decryption key not available"
        // if this is missing.
        navigator: {
            userAgent: process.env.USER_AGENT ?? "Mozilla/5.0",
            appCodeName: "Mozilla",
            appName: "Netscape",
            language: "en-US",
            languages: ["en-US", "en"],
            platform: "Win32",
            cookieEnabled: true,
        },
        addEventListener() {},
        dispatchEvent() { return true; },
        setTimeout, clearTimeout, setInterval, clearInterval,
        // axios uses XHR under Node only if available — let's leave undefined so it falls back.
        XMLHttpRequest: undefined,
        fetch: globalThis.fetch?.bind(globalThis),
        atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    };

    // Install on globalThis. Use defineProperty to override any pre-existing
    // getters Node may have set (e.g. process-shadowed `navigator`).
    const G = globalThis as any;
    const set = (k: string, v: unknown) =>
        Object.defineProperty(G, k, { value: v, writable: true, configurable: true });
    set("window", win);
    set("document", doc);
    set("location", loc);
    set("navigator", win.navigator);
}

// Fetch a live page from comix.to and pull out the current `<meta name="cfg">`
// content + the main bundle URL. Lets us prove the local secure bundle still
// matches what the site is serving.
async function fetchLiveCfg(): Promise<{ cfg: string; mainSrc: string } | null> {
    const ua = process.env.USER_AGENT ?? "Mozilla/5.0";
    const cookie = [
        process.env.SESSION ? `session=${process.env.SESSION}` : "",
        process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
    ].filter(Boolean).join("; ");
    try {
        const res = await fetch("https://comix.to/title/xlyyj-eleceed", {
            headers: { "User-Agent": ua, "Cookie": cookie, "Accept": "text/html" },
        });
        const html = await res.text();
        const cfgM  = html.match(/<meta\s+name="cfg"\s+content="([^"]+)"/);
        const mainM = html.match(/src="([^"]*main-[a-zA-Z0-9-]+\.js)"/);
        if (!cfgM) return null;
        return { cfg: cfgM[1]!, mainSrc: mainM?.[1] ?? "(not found)" };
    } catch (e: any) {
        console.log("[!] live fetch failed:", e?.message ?? e);
        return null;
    }
}

// ----- harness -----------------------------------------------------------
async function main(): Promise<void> {
    // Bundle schedules background work via setTimeout that hits stub gaps —
    // surfaces as "TypeError: undefined is not a function" and crashes Node.
    // We only care about the synchronous interceptor path, so swallow.
    process.on("uncaughtException", (e) => {
        console.log("[!] (suppressed) bundle background error:", (e as any)?.message ?? e);
    });

    console.log("[*] fetching live cfg from comix.to title page");
    const live = await fetchLiveCfg();
    let cfg = CFG_FALLBACK;
    if (live) {
        const buildMatches = live.mainSrc.includes(SECURE_BUNDLE_TAG);
        console.log("    live main bundle:", live.mainSrc);
        console.log("    local secure tag:", SECURE_BUNDLE_TAG, "=>", buildMatches ? "✅ live still serves our bundle" : "⚠ build rotated; signed URLs may not validate");
        console.log("    live cfg (first 40):", live.cfg.slice(0, 40), `(len=${live.cfg.length})`);
        cfg = live.cfg;
    } else {
        console.log("    using fallback cfg (offline)");
    }

    installDomStub(cfg);

    console.log("[*] loading secure bundle:", SECURE_PATH);
    const mod: any = await import(pathToFileURL(SECURE_PATH).href);
    console.log("[*] secure bundle exports:", Object.keys(mod));
    console.log("    n is", typeof mod.n, "  r is", typeof mod.r, "  t is", typeof mod.t);

    // Build a real axios instance just like main.js does (line 38-46).
    const L = axios.create({
        baseURL: "https://comix.to/api/v1",
        withCredentials: true,
        timeout: 15000,
        headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" },
    });

    // Capture the final URL via a mock adapter — we don't actually want to
    // hit the network during the signing experiment. We'll do a separate
    // verification request afterward.
    let signedUrlSeen: string | null = null;
    let signedConfig: any = null;
    L.defaults.adapter = (config: any) => {
        signedConfig = config;
        const params = config.params ?? {};
        const qs: string[] = [];
        for (const k of Object.keys(params)) qs.push(`${k}=${encodeURIComponent(String(params[k]))}`);
        const sep = config.url.includes("?") ? "&" : (qs.length ? "?" : "");
        signedUrlSeen = config.url + (qs.length ? sep + qs.join("&") : "");
        return Promise.resolve({
            data: {}, status: 200, statusText: "OK",
            headers: {}, config, request: {},
        });
    };

    console.log("[*] calling secure.n(axiosInstance) to install interceptor");
    try {
        mod.n(L);
    } catch (e: any) {
        console.log("[!] secure.n threw:", e?.message ?? e);
        console.log("    stack:", e?.stack?.split("\n").slice(0, 6).join("\n    "));
    }

    console.log("[*] firing GET", KNOWN_PATH);
    try {
        await L.get(KNOWN_PATH);
    } catch (e: any) {
        console.log("[!] axios threw:", e?.message ?? e);
    }

    console.log("\n========== RESULT ==========");
    console.log("captured signed URL:", signedUrlSeen);
    console.log("captured config.params:", signedConfig?.params);

    if (!signedUrlSeen) {
        console.log("\n❌ adapter never fired — request was dropped before adapter stage");
        return;
    }
    const m = signedUrlSeen.match(/[?&]_=([^&]+)/);
    if (!m) {
        console.log("\n❌ no `_=` token found on URL — interceptor didn't run or used a different param");
        return;
    }
    const tokenWeProduced = decodeURIComponent(m[1]!);
    console.log("\nour token  :", tokenWeProduced, `(len=${tokenWeProduced.length})`);
    console.log("known token:", KNOWN_TOKEN, `(len=${KNOWN_TOKEN.length})`);
    console.log(`  ours pfx  : ${tokenWeProduced.slice(0, 44)}`);
    console.log(`  known pfx : ${KNOWN_TOKEN.slice(0, 44)}`);

    // Real validation: send signed URL to comix.to and check the response.
    const ua = process.env.USER_AGENT ?? "Mozilla/5.0";
    const cookie = [
        process.env.SESSION ? `session=${process.env.SESSION}` : "",
        process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
    ].filter(Boolean).join("; ");
    const fullUrl = `https://comix.to/api/v1${KNOWN_PATH}?_=${encodeURIComponent(tokenWeProduced)}`;
    console.log("\n[*] hitting comix.to with our signed URL:", fullUrl);
    const res = await fetch(fullUrl, {
        headers: {
            "User-Agent": ua,
            "Cookie": cookie,
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://comix.to/",
        },
    });
    const text = await res.text();
    let parsed: any = null; try { parsed = JSON.parse(text); } catch {}
    const verdict =
        res.status >= 200 && res.status < 300 && parsed?.status === "ok" ? "✅ ACCEPTED — token works against live API"
        : parsed?.message === "Invalid token." ? "❌ rejected — Invalid token"
        : `⚠ other (${res.status}): ${text.slice(0, 120).replace(/\s+/g, " ")}`;
    console.log("    status:", res.status);
    console.log("    body  :", text.slice(0, 180).replace(/\s+/g, " "));
    console.log("\n========== VERDICT ==========");
    console.log(verdict);
}

main().catch(e => { console.error(e); process.exit(1); });
