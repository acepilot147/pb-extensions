export {};

import { readFileSync } from "node:fs";

function log(...a: any[]) { process.stdout.write("[bench] " + a.map(String).join(" ") + "\n"); }

const SECURE = "experiment/extracted/comix-runtime-latest/secure.js";
const UA = process.env.USER_AGENT ?? "Mozilla/5.0";
const COOKIE = [
    process.env.SESSION ? `session=${process.env.SESSION}` : "",
    process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
].filter(Boolean).join("; ");

async function fetchCfg(): Promise<string> {
    const res = await fetch("https://comix.to/title/xlyyj-eleceed", { headers: { "User-Agent": UA, "Cookie": COOKIE, "Referer": "https://comix.to/" } });
    const html = await res.text();
    return html.match(/<meta\s+name="cfg"\s+content="([^"]+)"/)![1]!;
}
function transformBundle(text: string) {
    const m = text.match(/export\s*\{([^}]+)\}\s*;?/)!;
    const pairs = m[1]!.split(",").map(p => { const [local, exp] = p.trim().split(/\s+as\s+/); return { local: local!.trim(), exp: exp!.trim() }; });
    const obj = pairs.map(p => `${JSON.stringify(p.exp)}:${p.local}`).join(",");
    return text.replace(m[0], `;globalThis.__comixBundleExports={${obj}};`);
}
function installStub(cfg: string) {
    const G = globalThis as any;
    const metaCfg = { get content() { return cfg; }, getAttribute: (n: string) => n === "content" ? cfg : n === "name" ? "cfg" : null, name: "cfg" };
    const qs = (s: string) => s && s.includes("cfg") ? metaCfg : null;
    const qsa = (s: string) => s && s.toLowerCase() === "meta" ? [metaCfg] : [];
    Object.defineProperty(qs, "toString", { value: () => "function querySelector() { [native code] }" });
    Object.defineProperty(qsa, "toString", { value: () => "function querySelectorAll() { [native code] }" });
    const realTimers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) };
    const doc = { querySelector: qs, querySelectorAll: qsa, getElementsByTagName: () => [metaCfg], cookie: "", readyState: "complete", addEventListener: () => {}, createElement: () => ({}), head: { appendChild: () => {}, removeChild: () => {} } };
    const loc = { href: "https://comix.to/", origin: "https://comix.to", host: "comix.to", hostname: "comix.to", pathname: "/", protocol: "https:", search: "" };
    const nav = { userAgent: UA, appCodeName: "Mozilla", appName: "Netscape", language: "en-US", languages: ["en-US", "en"], platform: "Win32", cookieEnabled: true };
    const win: any = {
        document: doc, location: loc, navigator: nav, addEventListener: () => {}, dispatchEvent: () => true,
        atob: (s: string) => Buffer.from(s, "base64").toString("binary"), btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
        setTimeout: (_fn: () => void, ms?: number) => { const t = realTimers.setTimeout(() => {}, ms ?? 0); (t as any).unref?.(); return t; },
        clearTimeout: (t: any) => realTimers.clearTimeout(t), setInterval: (_fn: () => void, ms?: number) => { const t = realTimers.setInterval(() => {}, ms ?? 1000); (t as any).unref?.(); return t; }, clearInterval: (t: any) => realTimers.clearInterval(t),
    };
    for (const [k, v] of Object.entries({ window: win, document: doc, location: loc, navigator: nav, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout, setInterval: win.setInterval, clearInterval: win.clearInterval, atob: win.atob, btoa: win.btoa, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })) {
        Object.defineProperty(G, k, { value: v, writable: true, configurable: true });
    }
    Object.defineProperty(G, "global", { value: G, writable: true, configurable: true });
}

async function main() {
    process.on("uncaughtException", () => {});
    const cfg = await fetchCfg();
    installStub(cfg);

    let text = readFileSync(SECURE, "utf8");
    text = transformBundle(text);

    const t0 = performance.now();
    new Function(text).call(globalThis);
    const t1 = performance.now();
    log(`bundle eval+init: ${(t1 - t0).toFixed(1)}ms (one-time)`);

    const installer = (globalThis as any).__comixBundleExports.r;
    let req: any = null, res: any = null;
    installer({
        interceptors: { request: { use: (h: any) => { req = h; } }, response: { use: (h: any) => { res = h; } } },
        defaults: { headers: { common: {}, get: {}, post: {}, put: {}, delete: {}, patch: {}, head: {} }, transformRequest: [], transformResponse: [] },
        get: () => {}, post: () => {}, put: () => {}, delete: () => {}, patch: () => {}, head: () => {},
    });

    // Warm-up
    req({ url: "/manga/xlyyj/chapters", method: "get", baseURL: "https://comix.to/api/v1", headers: {}, params: {} });

    // Benchmark signing
    const N = 100;
    const ts0 = performance.now();
    for (let i = 0; i < N; i++) {
        req({ url: `/chapters/9000${i}`, method: "get", baseURL: "https://comix.to/api/v1", headers: {}, params: {} });
    }
    const ts1 = performance.now();
    log(`sign ${N} URLs: ${(ts1 - ts0).toFixed(1)}ms total, ${((ts1 - ts0) / N).toFixed(2)}ms/op`);

    // Fetch one to benchmark decrypt
    const cfg2: any = { url: "/chapters/9000025", method: "get", baseURL: "https://comix.to/api/v1", headers: {}, params: {} };
    const cfgOut = req(cfg2);
    const token = cfgOut.params._;
    const apiRes = await fetch(`https://comix.to/api/v1/chapters/9000025?_=${encodeURIComponent(token)}`, {
        headers: { "User-Agent": UA, "Cookie": COOKIE, "Referer": "https://comix.to/", "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" },
    });
    const respJson = JSON.parse(await apiRes.text());
    const headers: Record<string, string> = {};
    apiRes.headers.forEach((v, k) => { headers[k] = v; });
    const fakeResp: any = { data: respJson, status: 200, headers, config: { url: "/chapters/9000025" }, request: {} };

    const td0 = performance.now();
    for (let i = 0; i < 50; i++) {
        await res({ ...fakeResp, data: { ...respJson } });
    }
    const td1 = performance.now();
    log(`decrypt 50 responses (~${respJson.e.length}b each): ${(td1 - td0).toFixed(1)}ms total, ${((td1 - td0) / 50).toFixed(2)}ms/op`);

    process.exit(0);
}
main();
