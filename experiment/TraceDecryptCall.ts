export {};
/**
 * Verify Ai.I is the inverse of Ai.T (round-trip test) and inspect what
 * argument shape it expects. Also dump Ai.A and Ai.O briefly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const RUNTIME = JSON.parse(readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/runtime.json"), "utf8"));
const SECURE_PATCHED = readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/secure-patched.js"), "utf8");

const realTimers = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
};

function installDomStub(cfg: string): void {
    const G = globalThis as any;
    const metaCfg = { get content() { return cfg; }, getAttribute: (n: string) => n === "content" ? cfg : n === "name" ? "cfg" : null, name: "cfg" };
    function querySelector(sel: string): unknown { return sel.includes("cfg") ? metaCfg : null; }
    function querySelectorAll(sel: string): unknown[] { return sel.toLowerCase() === "meta" ? [metaCfg] : []; }
    Object.defineProperty(querySelector, "toString", { value: () => "function querySelector() { [native code] }" });
    Object.defineProperty(querySelectorAll, "toString", { value: () => "function querySelectorAll() { [native code] }" });
    const doc = { querySelector, querySelectorAll, getElementsByTagName: () => [metaCfg], cookie: "", readyState: "complete", addEventListener() {} };
    const loc = { href: "https://comix.to/", origin: "https://comix.to", host: "comix.to", hostname: "comix.to", pathname: "/", protocol: "https:", search: "" };
    const win: any = {
        document: doc, location: loc,
        navigator: { userAgent: "Mozilla/5.0", appCodeName: "Mozilla", appName: "Netscape", language: "en-US", languages: ["en-US", "en"], platform: "Win32", cookieEnabled: true },
        addEventListener() {}, dispatchEvent: () => true,
        setTimeout: (_fn: () => void, ms?: number) => { const t = realTimers.setTimeout(() => {}, ms ?? 0); t.unref?.(); return t; },
        clearTimeout: (t: any) => realTimers.clearTimeout(t),
        setInterval: (_fn: () => void, ms?: number) => { const t = realTimers.setInterval(() => {}, ms ?? 1000); t.unref?.(); return t; },
        clearInterval: (t: any) => realTimers.clearInterval(t),
        atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    };
    for (const [k, v] of Object.entries({ window: win, document: doc, location: loc, navigator: win.navigator, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout, setInterval: win.setInterval, clearInterval: win.clearInterval, atob: win.atob, btoa: win.btoa })) {
        Object.defineProperty(G, k, { value: v, writable: true, configurable: true });
    }
    Object.defineProperty(G, "global", { value: G, writable: true, configurable: true });
    Object.defineProperty(G, "localStorage", { value: { getItem: () => null, setItem() {}, removeItem() {} }, writable: true, configurable: true });
}
function restoreNodeTimers(): void {
    for (const [k, v] of Object.entries(realTimers)) Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
}

async function main(): Promise<void> {
    installDomStub(RUNTIME.cfg);
    const file = join(tmpdir(), `trace-decrypt-${RUNTIME.bundleId}.mjs`);
    writeFileSync(file, SECURE_PATCHED);
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport(pathToFileURL(file).href);
    restoreNodeTimers();

    const G = globalThis as any;
    const Ai = G.Ai;
    const path = "/manga/xlyyj/chapters";

    console.log("Test Ai.T then Ai.I roundtrip:");
    const signed = Ai.T(path);
    console.log(`  Ai.T("${path}") = ${signed}`);

    for (const methodName of ["I", "A", "O"]) {
        for (const arg of [signed, path]) {
            try {
                const out = Ai[methodName](arg);
                console.log(`  Ai.${methodName}(${JSON.stringify(arg).slice(0, 40)}) = ${typeof out === "string" ? JSON.stringify(out.slice(0, 40)) : typeof out}`);
            } catch (e: any) {
                console.log(`  Ai.${methodName}(${JSON.stringify(arg).slice(0, 40)}) THREW: ${e?.message?.slice(0, 80)}`);
            }
        }
    }

    // Roundtrip test
    try {
        const r = Ai.I(signed);
        console.log(`\nAi.I(Ai.T(${JSON.stringify(path)})) = ${JSON.stringify(r)}`);
    } catch (e: any) {
        console.log(`\nAi.I(signed) threw: ${e?.message}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
