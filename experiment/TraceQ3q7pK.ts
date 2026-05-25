export {};

/**
 * Trace what `q3q7pK` resolves to during bundle execution in Node so we can
 * figure out what stub Paperback's runtime is missing.
 */

import { BUNDLE_CODE, BUNDLE_INFO } from "../src/ComixTo/ComixBundle";

function log(...a: any[]) { process.stdout.write("[trace] " + a.map(String).join(" ") + "\n"); }

function installDomStub(): void {
    const G: any = globalThis;
    const cfg = BUNDLE_INFO.cfg;
    const metaCfg = { get content() { return cfg; }, getAttribute: (n: string) => n === "content" ? cfg : n === "name" ? "cfg" : null, name: "cfg" };
    const qs = (s: string) => s && s.includes("cfg") ? metaCfg : null;
    const qsa = (s: string) => s && s.toLowerCase() === "meta" ? [metaCfg] : [];
    Object.defineProperty(qs, "toString", { value: () => "function querySelector() { [native code] }" });
    Object.defineProperty(qsa, "toString", { value: () => "function querySelectorAll() { [native code] }" });
    const doc = { querySelector: qs, querySelectorAll: qsa, getElementsByTagName: () => [metaCfg], cookie: "", readyState: "complete", addEventListener: () => {}, createElement: () => ({}), head: { appendChild: () => {}, removeChild: () => {} } };
    const loc = { href: "https://comix.to/", origin: "https://comix.to", host: "comix.to", hostname: "comix.to", pathname: "/", protocol: "https:", search: "" };
    const nav = { userAgent: "Mozilla/5.0 ... Chrome/148.0.0.0 Safari/537.36", appCodeName: "Mozilla", appName: "Netscape", language: "en-US", languages: ["en-US","en"], platform: "Win32", cookieEnabled: true };
    const win: any = { document: doc, location: loc, navigator: nav, addEventListener: () => {}, dispatchEvent: () => true, atob: (s: string) => Buffer.from(s, "base64").toString("binary"), btoa: (s: string) => Buffer.from(s, "binary").toString("base64") };
    for (const [k, v] of Object.entries({ window: win, document: doc, location: loc, navigator: nav, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })) {
        Object.defineProperty(G, k, { value: v, writable: true, configurable: true });
    }
    Object.defineProperty(G, "global", { value: G, writable: true, configurable: true });

    // INSTRUMENT: trap reads of q3q7pK and a few likely suspects via Proxy on global
    // Can't proxy globalThis directly, but we can pre-define q3q7pK and log when it's accessed.
    let trapped: any = null;
    Object.defineProperty(G, "q3q7pK", {
        get() { trapped = "GET"; log("q3q7pK GET stack:"); log(new Error().stack?.split("\n").slice(0, 5).join("\n")); return trapped; },
        set(v) { trapped = v; log("q3q7pK SET to:", typeof v, String(v).slice(0, 100)); },
        configurable: true,
    });
}

async function main(): Promise<void> {
    process.on("uncaughtException", (e) => log("uncaughtException:", (e as any)?.message ?? e));
    installDomStub();
    const bootFn = new Function(BUNDLE_CODE) as () => any;
    try {
        const exports = bootFn.call(globalThis);
        log("exports keys:", Object.keys(exports || {}).join(","));
    } catch (e: any) {
        log("error during bundle exec:", e?.message ?? e);
    }
    log("after run, q3q7pK on global:", typeof (globalThis as any).q3q7pK);
    process.exit(0);
}
main();
