export {};

/**
 * Compare de-VM'd fast modules against the live secure.js VM loaded locally.
 *
 * Run:
 *   node -r ts-node/register/transpile-only experiment/BenchmarkComixMethods.ts
 */

import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fastDecryptComixPayload } from "../src/ComixTo/ComixFastDecrypt";
import { fastGenerateHash } from "../src/ComixTo/ComixFastSigner";

const ROOT = process.cwd();
const RUNTIME = JSON.parse(readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/runtime.json"), "utf8"));
const FIXTURES = JSON.parse(readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/fixtures.json"), "utf8"));
const SECURE_TEXT = readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/secure.js"), "utf8");

const realTimers = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
};

function installDomStub(cfg: string): void {
    const G = globalThis as any;
    const metaCfg = { get content() { return cfg; }, getAttribute: (name: string) => name === "content" ? cfg : name === "name" ? "cfg" : null, name: "cfg" };
    function querySelector(sel: string): unknown { return sel.includes("cfg") ? metaCfg : null; }
    function querySelectorAll(sel: string): unknown[] { return sel.toLowerCase() === "meta" ? [metaCfg] : []; }
    Object.defineProperty(querySelector, "toString", { value: () => "function querySelector() { [native code] }" });
    Object.defineProperty(querySelectorAll, "toString", { value: () => "function querySelectorAll() { [native code] }" });
    const doc = { querySelector, querySelectorAll, getElementsByTagName: () => [metaCfg], cookie: "", readyState: "complete", addEventListener() {} };
    const loc = { href: "https://comix.to/", origin: "https://comix.to", host: "comix.to", hostname: "comix.to", pathname: "/", protocol: "https:", search: "" };
    const win: any = {
        document: doc,
        location: loc,
        navigator: { userAgent: "Mozilla/5.0", appCodeName: "Mozilla", appName: "Netscape", language: "en-US", languages: ["en-US", "en"], platform: "Win32", cookieEnabled: true },
        addEventListener() {},
        dispatchEvent() { return true; },
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

function findVmNamespace(): { name: string; ns: any } {
    for (const name of Object.getOwnPropertyNames(globalThis)) {
        if (!/^vm[a-z]_[a-f0-9]+$/.test(name)) continue;
        const ns = (globalThis as any)[name];
        if (ns && typeof ns.qi === "function" && typeof ns.v === "function") return { name, ns };
    }
    throw new Error("Could not find VM namespace");
}

function captureResponseHandler(ns: any): any {
    let responseHandler: any = null;
    ns.v({
        interceptors: { request: { use() {} }, response: { use: (h: any) => { responseHandler = h; } } },
        defaults: { headers: { common: {}, get: {}, post: {}, put: {}, delete: {}, patch: {}, head: {} }, transformRequest: [], transformResponse: [] },
    });
    if (!responseHandler) throw new Error("No response handler captured from ns.v");
    return responseHandler;
}

async function loadVm(): Promise<{ nsName: string; signer: (path: string) => string; decryptResponse: (fixture: any) => any }> {
    installDomStub(RUNTIME.cfg);
    const file = join(tmpdir(), `comix-benchmark-${RUNTIME.bundleId}-${Date.now()}.mjs`);
    writeFileSync(file, SECURE_TEXT);
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport(pathToFileURL(file).href);
    restoreNodeTimers();

    const { name, ns } = findVmNamespace();
    const responseHandler = captureResponseHandler(ns);
    return {
        nsName: name,
        signer: (path: string) => ns.qi(path),
        decryptResponse: (fixture: any) => {
            const response = {
                data: { e: fixture.encryptedPayload.e },
                status: 200,
                statusText: "OK",
                headers: fixture.headers ?? { "x-enc": "1" },
                config: { url: fixture.path, method: "get", baseURL: "https://comix.to/api/v1" },
                request: {},
            };
            const out = responseHandler(response);
            return out?.data ?? out;
        },
    };
}

function average(numbers: number[]): number {
    return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function percentile(numbers: number[], pct: number): number {
    const sorted = [...numbers].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))]!;
}

function bench(label: string, iterations: number, fn: () => unknown): { avg: number; p95: number; total: number } {
    for (let i = 0; i < Math.min(20, iterations); i++) fn();
    const times: number[] = [];
    const totalStart = performance.now();
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        fn();
        times.push(performance.now() - start);
    }
    return { avg: average(times), p95: percentile(times, 95), total: performance.now() - totalStart };
}

function printRow(name: string, result: { avg: number; p95: number; total: number }, baseline?: { avg: number }): void {
    const speedup = baseline ? `  ${Math.round(baseline.avg / result.avg)}x faster` : "";
    console.log(`${name.padEnd(42)} avg=${result.avg.toFixed(3)}ms  p95=${result.p95.toFixed(3)}ms  total=${result.total.toFixed(1)}ms${speedup}`);
}

async function main(): Promise<void> {
    const vm = await loadVm();
    const signPath = RUNTIME.signChecks?.[0]?.signPath ?? "/chapters/9000025";

    console.log(`bundle: ${RUNTIME.bundleId}`);
    console.log(`vm namespace: ${vm.nsName}`);
    console.log("");
    console.log("signer:");
    const vmSign = bench("VM secure.js ns.qi", 5000, () => vm.signer(signPath));
    const fastSign = bench("fastGenerateHash", 5000, () => fastGenerateHash(signPath));
    printRow("VM secure.js ns.qi", vmSign);
    printRow("fastGenerateHash", fastSign, vmSign);

    console.log("");
    console.log("decrypt:");
    for (const fixture of FIXTURES) {
        const bytes = String(fixture.encryptedPayload?.e ?? "").length;
        const vmIterations = bytes > 5000 ? 15 : 60;
        const fastIterations = bytes > 5000 ? 150 : 600;
        console.log(`${fixture.path} (${bytes} encrypted chars)`);
        const vmDecrypt = bench("VM secure.js response interceptor", vmIterations, () => vm.decryptResponse(fixture));
        const fastDecrypt = bench("fastDecryptComixPayload", fastIterations, () => fastDecryptComixPayload(fixture.path, { e: fixture.encryptedPayload.e }, fixture.headers ?? {}));
        printRow("  VM secure.js response interceptor", vmDecrypt);
        printRow("  fastDecryptComixPayload", fastDecrypt, vmDecrypt);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
