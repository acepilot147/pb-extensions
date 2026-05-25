export {};

/**
 * Wrap globalThis in a Proxy to log every property write the bundle performs
 * while booting. Reveals which obfuscated names the bundle creates as globals
 * (e.g. `q3q7pK = setInterval`) so we can pre-populate them in Paperback's
 * runtime, where the bundle's own write may not reach globalThis.
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
    const nav = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36", appCodeName: "Mozilla", appName: "Netscape", language: "en-US", languages: ["en-US","en"], platform: "Win32", cookieEnabled: true };
    const win: any = { document: doc, location: loc, navigator: nav, addEventListener: () => {}, dispatchEvent: () => true, atob: (s: string) => Buffer.from(s, "base64").toString("binary"), btoa: (s: string) => Buffer.from(s, "binary").toString("base64") };
    for (const [k, v] of Object.entries({ window: win, document: doc, location: loc, navigator: nav, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })) {
        Object.defineProperty(G, k, { value: v, writable: true, configurable: true });
    }
    Object.defineProperty(G, "global", { value: G, writable: true, configurable: true });
}

async function main(): Promise<void> {
    process.on("uncaughtException", (e) => log("uncaughtException:", (e as any)?.message ?? e));
    installDomStub();
    const G: any = globalThis;
    const baseline = new Set(Object.getOwnPropertyNames(G));

    // Intercept property *creation* on globalThis by sniffing for novel keys.
    // We poll-write a sentinel before/after, then diff.
    const baselineProps = new Set(Object.getOwnPropertyNames(G));
    log("baseline globals count:", baselineProps.size);

    const bootFn = new Function(BUNDLE_CODE) as () => any;
    try {
        const exp = bootFn.call(G);
        log("bundle ok. exports:", Object.keys(exp || {}).join(","));
    } catch (e: any) {
        log("bundle error:", e?.message ?? e);
    }

    const after = Object.getOwnPropertyNames(G);
    const created = after.filter(k => !baselineProps.has(k));
    log("new globals after bundle ran:", JSON.stringify(created));
    for (const k of created) {
        const v = G[k];
        const t = typeof v;
        const desc = t === "function"
            ? `function ${v.name || "(anon)"} (length=${v.length})`
            : t === "object" && v !== null
              ? `object (keys=${Object.keys(v).slice(0, 8).join(",")})`
              : `${t}: ${String(v).slice(0, 100)}`;
        log(`  ${k} = ${desc}`);
    }

    log("---");
    log("baseline ∋ ", baseline.size, "vs new ∋", created.length);

    process.exit(0);
}
main();
