export {};
/**
 * Hypothesis: the new signing algorithm uses mutation+RC4 (same primitives
 * as the old decrypt), instead of insert+RC4. Walk the namespace looking for
 * RC4 key getters (parameterless fn returning 32-char string) and mutation
 * stages (fn(arr) returning arr of same length).
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

function isRc4KeyGetter(fn: any): boolean {
    try {
        const r = fn();
        return typeof r === "string" && r.length === 32;
    } catch { return false; }
}

function isMutationStage(fn: any): boolean {
    // fn(arr) returns arr of same length (no prefix added)
    try {
        const r1 = fn(new Array(20).fill(0x42));
        const r2 = fn(new Array(30).fill(0x42));
        if (Array.isArray(r1) && r1.length === 20 && Array.isArray(r2) && r2.length === 30) {
            // Sanity: at least one element transformed (otherwise might be identity)
            return r1.some((b, i) => b !== 0x42) || r2.some((b, i) => b !== 0x42);
        }
    } catch {}
    return false;
}

function isInsertStage(fn: any): number | null {
    for (const p of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        try {
            const r1 = fn(new Array(20).fill(0x42));
            const r2 = fn(new Array(30).fill(0x42));
            if (Array.isArray(r1) && r1.length === 20 + p && Array.isArray(r2) && r2.length === 30 + p) {
                return p;
            }
        } catch {}
    }
    return null;
}

function walkEnv(root: any, depth = 0, seen = new Set<any>(), pathLabel = "root"): { obj: any; pathLabel: string }[] {
    const results: { obj: any; pathLabel: string }[] = [];
    if (!root || seen.has(root) || depth > 8) return results;
    if (typeof root !== "object" && typeof root !== "function") return results;
    seen.add(root);

    const env = (root as any).__vmEnv;
    if (env && typeof env === "object") {
        results.push({ obj: env, pathLabel: `${pathLabel}.__vmEnv` });
        for (const k of Object.keys(env)) {
            results.push(...walkEnv(env[k], depth + 1, seen, `${pathLabel}.__vmEnv.${k}`));
        }
    }
    if (typeof root === "object") {
        for (const k of Object.keys(root)) {
            results.push(...walkEnv(root[k], depth + 1, seen, `${pathLabel}.${k}`));
        }
    }
    return results;
}

async function main(): Promise<void> {
    installDomStub(RUNTIME.cfg);
    const file = join(tmpdir(), `probe-mut-${RUNTIME.bundleId}.mjs`);
    writeFileSync(file, SECURE_PATCHED);
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport(pathToFileURL(file).href);
    restoreNodeTimers();

    const G = globalThis as any;
    const ns = G.vmP_64c63e;
    const signer = ns.Bi;
    // Trigger one signing so any lazy state is initialized
    signer("/manga/xlyyj/chapters");

    // Find all functions on the namespace and classify
    const fnKeys = Object.getOwnPropertyNames(ns).filter(k => typeof ns[k] === "function");
    console.log(`Total namespace fns: ${fnKeys.length}`);

    const rc4Keys: { key: string; sample: string }[] = [];
    const mutStages: { key: string }[] = [];
    const insStages: { key: string; prefix: number }[] = [];
    for (const k of fnKeys) {
        const fn = ns[k];
        if (isRc4KeyGetter(fn)) {
            try { rc4Keys.push({ key: k, sample: fn().slice(0, 16) }); } catch {}
            continue;
        }
        const ip = isInsertStage(fn);
        if (ip !== null && ip > 0) {
            insStages.push({ key: k, prefix: ip });
            continue;
        }
        if (isMutationStage(fn)) {
            mutStages.push({ key: k });
        }
    }
    console.log(`RC4 key getters: ${rc4Keys.length}`);
    for (const r of rc4Keys.slice(0, 10)) console.log(`  ${r.key}: ${JSON.stringify(r.sample)}...`);
    console.log(`Mutation stages: ${mutStages.length}`);
    for (const m of mutStages.slice(0, 10)) console.log(`  ${m.key}`);
    console.log(`Insert stages: ${insStages.length}`);
    for (const i of insStages.slice(0, 10)) console.log(`  ${i.key} prefix=${i.prefix}`);

    // Also walk env chains
    console.log("\n=== Walking __vmEnv chains under namespace ===");
    const visited = walkEnv(ns, 0, new Set(), "ns");
    console.log(`reachable envs: ${visited.length}`);
    let bestEnv: any = null;
    let bestCounts = { rc4: 0, mut: 0, ins: 0 };
    for (const { obj, pathLabel } of visited) {
        if (!obj || typeof obj !== "object") continue;
        const keys = Object.getOwnPropertyNames(obj);
        if (keys.length < 8) continue;
        let r = 0, m = 0, i = 0;
        for (const k of keys) {
            const fn = obj[k];
            if (typeof fn !== "function") continue;
            if (isRc4KeyGetter(fn)) { r++; continue; }
            const ip = isInsertStage(fn);
            if (ip !== null && ip > 0) { i++; continue; }
            if (isMutationStage(fn)) m++;
        }
        if (r + m + i >= 5) {
            console.log(`  env ${pathLabel} keys=${keys.length} rc4=${r} mut=${m} ins=${i}`);
            if (r + m > bestCounts.rc4 + bestCounts.mut) {
                bestEnv = { obj, pathLabel };
                bestCounts = { rc4: r, mut: m, ins: i };
            }
        }
    }
    if (bestEnv) console.log(`Best env: ${bestEnv.pathLabel} rc4=${bestCounts.rc4} mut=${bestCounts.mut} ins=${bestCounts.ins}`);
}

main().catch(e => { console.error(e); process.exit(1); });
