export {};

/**
 * Extract the current Comix.to signing/decryption runtime for manual porting.
 *
 * This does not modify Paperback source. It writes a small extraction bundle:
 *
 *   experiment/extracted/comix-runtime-latest/
 *     report.md
 *     runtime.json
 *     main.js
 *     secure.js
 *     signer-function.js
 *     installer-function.js
 *     request-interceptor.js
 *     response-interceptor.js
 *     fixtures.json
 *
 * Run:
 *   npx tsx experiment/ExtractComixRuntime.ts
 *   npx tsx experiment/ExtractComixRuntime.ts --strict-sign
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://comix.to/api/v1";
const HOMEPAGE = process.env.RELAY_PROBE_URL ?? "https://comix.to/title/xlyyj-eleceed";
const UA = process.env.USER_AGENT ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const OUT_DIR = resolve(process.cwd(), "experiment", "extracted", "comix-runtime-latest");
const STRICT_SIGN = process.argv.includes("--strict-sign");

const SIGN_PATHS = [
    "/chapters/9000025",
    "/manga/xlyyj/chapters",
    "/manga/xlyyj/chapters?page=1&limit=3&order[number]=desc",
    "/manga/k927/chapters?page=1&limit=3&order[number]=desc",
];

const FIXTURE_PATHS = [
    "/manga/xlyyj/chapters?page=1&limit=3&order[number]=desc",
    "/chapters/9000025",
];

type ReqInterceptor = (config: any) => any | Promise<any>;
type ResInterceptor = (response: any) => any | Promise<any>;

interface ProbeResult {
    signer: ((path: string) => string) | null;
    signerRef: string;
    signerSource: string;
    installer: ((axios: any) => void) | null;
    installerRef: string;
    installerSource: string;
    reqIntercept: ReqInterceptor | null;
    reqInterceptSource: string;
    resIntercept: ResInterceptor | null;
    resInterceptSource: string;
}

interface SourceReference {
    label: string;
    ref: string;
    source: string;
    vmEntryIds: number[];
    identifiers: string[];
}

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
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return await res.text();
}

function stripApi(path: string): string {
    return path.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "");
}

function pathWithoutQuery(path: string): string {
    return stripApi(path).split("?")[0]!;
}

function installDomStub(cfg: string): void {
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const realSetInterval = globalThis.setInterval.bind(globalThis);
    const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const realClearInterval = globalThis.clearInterval.bind(globalThis);
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
        navigator: {
            userAgent: UA,
            appCodeName: "Mozilla",
            appName: "Netscape",
            language: "en-US",
            languages: ["en-US", "en"],
            platform: "Win32",
            cookieEnabled: true,
        },
        addEventListener() {},
        dispatchEvent() { return true; },
        setTimeout: (_fn: () => void, ms?: number) => {
            const t = realSetTimeout(() => {}, ms ?? 0);
            t.unref?.();
            return t;
        },
        clearTimeout: (t: NodeJS.Timeout) => realClearTimeout(t),
        setInterval: (_fn: () => void, ms?: number) => {
            const t = realSetInterval(() => {}, ms ?? 1000);
            t.unref?.();
            return t;
        },
        clearInterval: (t: NodeJS.Timeout) => realClearInterval(t),
        atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    };

    const set = (k: string, v: unknown) =>
        Object.defineProperty(G, k, { value: v, writable: true, configurable: true });
    set("window", win);
    set("document", doc);
    set("location", loc);
    set("navigator", win.navigator);
    set("setTimeout", win.setTimeout);
    set("clearTimeout", win.clearTimeout);
    set("setInterval", win.setInterval);
    set("clearInterval", win.clearInterval);
}

function restoreNodeTimers(): void {
    const timers = awaitTimers;
    Object.defineProperty(globalThis, "setTimeout", { value: timers.setTimeout, writable: true, configurable: true });
    Object.defineProperty(globalThis, "clearTimeout", { value: timers.clearTimeout, writable: true, configurable: true });
    Object.defineProperty(globalThis, "setInterval", { value: timers.setInterval, writable: true, configurable: true });
    Object.defineProperty(globalThis, "clearInterval", { value: timers.clearInterval, writable: true, configurable: true });
}

const awaitTimers = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
};

const TOKEN_RE = /^[A-Za-z0-9_-]{40,220}$/;

function probeBundle(): ProbeResult {
    const G = globalThis as any;
    let signer: ((p: string) => string) | null = null;
    let signerRef = "";
    let signerSource = "";
    let installer: ((axios: any) => void) | null = null;
    let installerRef = "";
    let installerSource = "";
    let reqIntercept: ReqInterceptor | null = null;
    let reqInterceptSource = "";
    let resIntercept: ResInterceptor | null = null;
    let resInterceptSource = "";

    const nsNames = Object.keys(G).filter(k => /^vm[a-z]_[a-f0-9]+$/.test(k));
    if (nsNames.length === 0) nsNames.push("__globalThis_fallback__");

    for (const ns of nsNames) {
        const obj = ns === "__globalThis_fallback__" ? G : G[ns];
        if (!obj || typeof obj !== "object") continue;

        for (const key of Object.keys(obj)) {
            const fn = obj[key];
            if (typeof fn !== "function") continue;
            const ref = ns === "__globalThis_fallback__" ? `globalThis.${key}` : `${ns}.${key}`;

            if (!signer) {
                try {
                    const out = fn("/manga/xlyyj/chapters");
                    if (typeof out === "string" && out !== "/manga/xlyyj/chapters" && TOKEN_RE.test(out)) {
                        signer = fn.bind(null);
                        signerRef = ref;
                        signerSource = Function.prototype.toString.call(fn);
                    }
                } catch {}
            }

            if (!installer) {
                let gotRes = false;
                let req: ReqInterceptor | null = null;
                let res: ResInterceptor | null = null;
                const fakeAxios: any = {
                    interceptors: {
                        request: { use: (h: ReqInterceptor) => { req = h; } },
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
                        installerSource = Function.prototype.toString.call(fn);
                        reqIntercept = req;
                        resIntercept = res;
                        reqInterceptSource = req ? Function.prototype.toString.call(req) : "";
                        resInterceptSource = res ? Function.prototype.toString.call(res) : "";
                    }
                } catch {}
            }

            if (signer && installer) break;
        }
        if (signer && installer) break;
    }

    return {
        signer,
        signerRef,
        signerSource,
        installer,
        installerRef,
        installerSource,
        reqIntercept,
        reqInterceptSource,
        resIntercept,
        resInterceptSource,
    };
}

async function signedUrl(path: string, signer: (path: string) => string): Promise<string> {
    const clean = stripApi(path);
    const justPath = clean.split("?")[0]!;
    const query = clean.includes("?") ? clean.slice(clean.indexOf("?") + 1) : "";
    const sep = query ? "&" : "?";
    const qs = query ? `?${query}` : "";
    return `${API_BASE}${justPath}${qs}${sep}_=${encodeURIComponent(signer(justPath))}`;
}

async function fetchEncryptedFixture(path: string, signer: (path: string) => string, resIntercept: ResInterceptor): Promise<any> {
    const url = await signedUrl(path, signer);
    const upstream = await fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Cookie": cookieHeader(),
            "Referer": "https://comix.to/",
        },
    });
    const text = await upstream.text();
    let payload: any;
    try { payload = JSON.parse(text); }
    catch { payload = { parseError: true, text: text.slice(0, 500) }; }

    let decrypted: any = null;
    let decryptError = "";
    if (payload && typeof payload === "object" && "e" in payload) {
        try {
            const fakeResp = {
                data: payload,
                status: upstream.status,
                statusText: upstream.statusText,
                headers: Object.fromEntries(upstream.headers.entries()),
                config: { url, method: "get", baseURL: API_BASE },
                request: {},
            };
            const out: any = await resIntercept(fakeResp);
            decrypted = out?.data ?? out;
        } catch (e: any) {
            decryptError = e?.message ?? String(e);
        }
    }

    return {
        path,
        signedUrl: url,
        status: upstream.status,
        headers: Object.fromEntries(upstream.headers.entries()),
        encryptedPayload: payload,
        decrypted,
        decryptError,
    };
}

function jsonPreview(value: any, max = 4000): any {
    const text = JSON.stringify(value);
    if (text.length <= max) return value;
    return {
        truncated: true,
        bytes: text.length,
        preview: text.slice(0, max),
    };
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function extractVmEntryIds(source: string): number[] {
    return unique([...source.matchAll(/\bvmE_[A-Za-z0-9_]+\((\d+)/g)].map(m => Number(m[1])));
}

function extractIdentifiers(source: string): string[] {
    const ids = [...source.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]{1,}\b/g)].map(m => m[0]);
    const skip = new Set([
        "function", "return", "void", "new", "target", "this", "arguments", "Object",
        "defineProperties", "get", "set", "enumerable", "true", "false", "undefined",
    ]);
    return unique(ids.filter(id => !skip.has(id))).slice(0, 80);
}

function extractWindow(text: string, needle: string, radius = 5000): string {
    const idx = text.indexOf(needle);
    if (idx < 0) return "";
    const start = Math.max(0, idx - radius);
    const end = Math.min(text.length, idx + needle.length + radius);
    return text.slice(start, end);
}

function makeSourceReferences(probed: ProbeResult): SourceReference[] {
    return [
        { label: "signer", ref: probed.signerRef, source: probed.signerSource },
        { label: "installer", ref: probed.installerRef, source: probed.installerSource },
        { label: "requestInterceptor", ref: "captured request interceptor", source: probed.reqInterceptSource },
        { label: "responseInterceptor", ref: "captured response interceptor", source: probed.resInterceptSource },
    ].map(item => ({
        ...item,
        vmEntryIds: extractVmEntryIds(item.source),
        identifiers: extractIdentifiers(item.source),
    }));
}

function writeSourceNeighborhoods(secureText: string, references: SourceReference[]): void {
    const chunks: string[] = [];
    for (const ref of references) {
        chunks.push(`===== ${ref.label}: ${ref.ref} =====`);
        chunks.push(`vmEntryIds: ${ref.vmEntryIds.join(", ") || "(none)"}`);
        chunks.push(`identifiers: ${ref.identifiers.join(", ") || "(none)"}`);
        chunks.push("");

        for (const id of ref.identifiers.slice(0, 24)) {
            for (const pattern of [`function ${id}`, `var ${id}=`, `let ${id}=`, `const ${id}=`, `${id}=`, `${id}:`]) {
                const window = extractWindow(secureText, pattern);
                if (window) {
                    chunks.push(`--- around ${pattern} ---`);
                    chunks.push(window);
                    chunks.push("");
                    break;
                }
            }
        }
        for (const vmId of ref.vmEntryIds) {
            const window = extractWindow(secureText, `case ${vmId}:`) || extractWindow(secureText, `(${vmId},`);
            if (window) {
                chunks.push(`--- around vm entry ${vmId} ---`);
                chunks.push(window);
                chunks.push("");
            }
        }
    }
    writeFileSync(join(OUT_DIR, "source-neighborhoods.txt"), chunks.join("\n"));
}

async function main(): Promise<void> {
    process.on("uncaughtException", (e) => {
        console.log("[extract] suppressed bundle background error:", (e as any)?.message ?? e);
    });

    console.log("[extract] fetching homepage", HOMEPAGE);
    const html = await fetchText(HOMEPAGE);
    const cfgM = html.match(/<meta\s+name="cfg"\s+content="([^"]+)"/);
    const mainM = html.match(/src="([^"]*main-[a-zA-Z0-9_-]+\.js)"/);
    if (!cfgM || !mainM) throw new Error("could not parse cfg or main bundle URL");

    const cfg = cfgM[1]!;
    const mainUrl = mainM[1]!;
    console.log("[extract] main", mainUrl);
    const mainText = await fetchText(mainUrl);
    const secureM = mainText.match(/from\s*["']([^"']*secure-[a-zA-Z0-9_-]+\.js)["']/);
    if (!secureM) throw new Error("could not find secure bundle import");

    const secureUrl = new URL(secureM[1]!, mainUrl).href;
    console.log("[extract] secure", secureUrl);
    const secureText = await fetchText(secureUrl);
    const bundleId = createHash("sha256").update(secureText).digest("hex").slice(0, 12);

    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "main.js"), mainText);
    writeFileSync(join(OUT_DIR, "secure.js"), secureText);

    installDomStub(cfg);
    const tmpFile = join(tmpdir(), `comix-secure-${bundleId}.mjs`);
    writeFileSync(tmpFile, secureText);
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport(pathToFileURL(tmpFile).href);
    restoreNodeTimers();

    const probed = probeBundle();
    if (!probed.signer) throw new Error("could not identify live signer function");
    if (!probed.resIntercept) throw new Error("could not identify response decrypt interceptor");

    console.log("[extract] signer", probed.signerRef);
    console.log("[extract] installer", probed.installerRef);
    const { generateHash } = await import("../src/ComixTo/ComixHash");

    const signChecks = SIGN_PATHS.map((path) => {
        const signPath = pathWithoutQuery(path);
        const liveToken = probed.signer!(signPath);
        const staticToken = generateHash(signPath);
        return {
            path,
            signPath,
            staticMatchesLive: staticToken === liveToken,
            staticToken,
            liveToken,
        };
    });
    const staticSignerOk = signChecks.every(c => c.staticMatchesLive);

    const fixtures = [];
    for (const path of FIXTURE_PATHS) {
        console.log("[extract] fixture", path);
        fixtures.push(await fetchEncryptedFixture(path, probed.signer, probed.resIntercept));
    }

    writeFileSync(join(OUT_DIR, "signer-function.js"), probed.signerSource);
    writeFileSync(join(OUT_DIR, "installer-function.js"), probed.installerSource);
    writeFileSync(join(OUT_DIR, "request-interceptor.js"), probed.reqInterceptSource);
    writeFileSync(join(OUT_DIR, "response-interceptor.js"), probed.resInterceptSource);
    const sourceReferences = makeSourceReferences(probed);
    writeFileSync(join(OUT_DIR, "source-references.json"), JSON.stringify(sourceReferences, null, 2));
    writeSourceNeighborhoods(secureText, sourceReferences);
    writeFileSync(join(OUT_DIR, "fixtures.json"), JSON.stringify(fixtures.map(f => ({
        ...f,
        decrypted: jsonPreview(f.decrypted),
    })), null, 2));

    const runtime = {
        generatedAt: new Date().toISOString(),
        homepage: HOMEPAGE,
        cfg,
        cfgLength: cfg.length,
        mainUrl,
        secureUrl,
        bundleId,
        signerRef: probed.signerRef,
        installerRef: probed.installerRef,
        hasRequestInterceptor: !!probed.reqIntercept,
        hasResponseInterceptor: !!probed.resIntercept,
        sourceReferences: sourceReferences.map(ref => ({
            label: ref.label,
            ref: ref.ref,
            vmEntryIds: ref.vmEntryIds,
            identifiers: ref.identifiers,
        })),
        staticSignerOk,
        signChecks,
        fixturePaths: FIXTURE_PATHS,
    };
    writeFileSync(join(OUT_DIR, "runtime.json"), JSON.stringify(runtime, null, 2));

    const report = [
        "# Comix Runtime Extraction",
        "",
        `Generated: ${runtime.generatedAt}`,
        `Bundle ID: \`${bundleId}\``,
        `Main: ${mainUrl}`,
        `Secure: ${secureUrl}`,
        `CFG length: ${cfg.length}`,
        `Signer: \`${probed.signerRef}\``,
        `Installer: \`${probed.installerRef}\``,
        `Static signer matches live: ${staticSignerOk ? "yes" : "no"}`,
        "",
        "## Sign Checks",
        "",
        ...signChecks.flatMap(c => [
            `- \`${c.signPath}\`: ${c.staticMatchesLive ? "match" : "MISMATCH"}`,
            `  - static: \`${c.staticToken}\``,
            `  - live:   \`${c.liveToken}\``,
        ]),
        "",
        "## Files",
        "",
        "- `secure.js`: live bundle to inspect.",
        "- `signer-function.js`: behavior-identified signer source.",
        "- `response-interceptor.js`: behavior-identified decrypt interceptor source.",
        "- `source-references.json`: VM entry ids and helper identifiers seen in extracted functions.",
        "- `source-neighborhoods.txt`: nearby minified bundle source around those identifiers.",
        "- `fixtures.json`: encrypted payloads plus live decrypted outputs for port validation.",
        "",
        "Next step: port `response-interceptor.js` and the helper functions it references from `secure.js` into Paperback-safe code, then validate against `fixtures.json`.",
        "",
    ].join("\n");
    writeFileSync(join(OUT_DIR, "report.md"), report);

    console.log("");
    console.log(`[extract] wrote ${OUT_DIR}`);
    console.log(`[extract] static signer matches live: ${staticSignerOk ? "yes" : "no"}`);
    if (!staticSignerOk && STRICT_SIGN) process.exitCode = 2;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
