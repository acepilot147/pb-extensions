export {};
/**
 * Intercept every namespace fn and log what the signer calls during one
 * invocation. Reveals the actual primitives used.
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

function summarizeValue(v: any): string {
    if (v === null) return "null";
    if (v === undefined) return "undef";
    if (typeof v === "string") return `s[${v.length}]=${JSON.stringify(v.slice(0, 30))}`;
    if (typeof v === "number") return `n=${v}`;
    if (typeof v === "boolean") return `b=${v}`;
    if (Array.isArray(v)) return `arr[${v.length}]`;
    if (v instanceof Uint8Array) return `u8[${v.length}]`;
    if (typeof v === "function") return `fn`;
    if (typeof v === "object") return `obj{${Object.keys(v).slice(0,4).join(",")}}`;
    return typeof v;
}

async function main(): Promise<void> {
    installDomStub(RUNTIME.cfg);
    const file = join(tmpdir(), `trace-signer-${RUNTIME.bundleId}.mjs`);
    writeFileSync(file, SECURE_PATCHED);
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport(pathToFileURL(file).href);
    restoreNodeTimers();

    const G = globalThis as any;
    const ns = G.vmP_64c63e;
    const signer = ns.Bi;

    // Warm up
    signer("/manga/xlyyj/chapters");

    type CallRec = { name: string; argSummary: string; retSummary: string; argsRaw?: any[]; retRaw?: any };
    const log: CallRec[] = [];
    const origs = new Map<string, Function>();
    for (const k of Object.getOwnPropertyNames(ns)) {
        const v = ns[k];
        if (typeof v !== "function") continue;
        if (k === "Bi") continue;
        // Skip natives that get hammered
        if (k === "btoa" || k === "atob" || k === "Object" || k === "Array" || k === "String" || k === "Date" || k === "Math" || k === "JSON" || k === "Symbol" || k === "Proxy" || k === "Reflect" || k === "RegExp" || k === "Boolean" || k === "TextEncoder" || k === "TextDecoder" || k === "Uint8Array" || k === "TypeError" || k === "ReferenceError" || k === "setTimeout" || k === "setInterval" || k === "encodeURIComponent" || k === "decodeURIComponent" || k === "escape" || k === "unescape" || k === "parseInt") continue;
        origs.set(k, v);
        ns[k] = function (...args: any[]) {
            const ret = v.apply(this, args);
            log.push({
                name: k,
                argSummary: args.map(summarizeValue).join(", "),
                retSummary: summarizeValue(ret),
                argsRaw: args.length === 1 && typeof args[0] === "string" ? args : undefined,
                retRaw: typeof ret === "string" && ret.length <= 60 ? ret : undefined,
            });
            return ret;
        };
    }
    // Also patch atob/btoa to count distinct calls
    const realAtob = (globalThis as any).atob;
    const realBtoa = (globalThis as any).btoa;
    const atobCalls: string[] = [];
    const btoaCalls: string[] = [];
    (globalThis as any).atob = (s: string) => { atobCalls.push(s); return realAtob(s); };
    (globalThis as any).btoa = (s: string) => { btoaCalls.push(s); return realBtoa(s); };

    const out = signer("/manga/xlyyj/chapters");
    for (const [k, v] of origs) ns[k] = v;

    console.log(`signer output: ${out}`);
    console.log(`\natob called ${atobCalls.length} times:`);
    for (const s of atobCalls.slice(0, 12)) console.log(`  atob(${JSON.stringify(s.slice(0, 60))}${s.length > 60 ? "..." : ""}) [len=${s.length}]`);
    console.log(`\nbtoa called ${btoaCalls.length} times:`);
    for (const s of btoaCalls.slice(0, 5)) console.log(`  btoa(<${s.length} bytes>)`);

    console.log(`\n=== Namespace fn calls during signing (${log.length} total) ===`);
    const byName = new Map<string, number>();
    for (const r of log) byName.set(r.name, (byName.get(r.name) || 0) + 1);
    for (const [k, n] of [...byName.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k}: ${n} calls`);
    }
    console.log(`\nFirst 30 calls in order:`);
    for (const r of log.slice(0, 30)) {
        console.log(`  ${r.name}(${r.argSummary}) -> ${r.retSummary}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
