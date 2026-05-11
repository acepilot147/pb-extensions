export {};

/**
 * Build the de-VM'd Comix request signer from a locally extracted secure.js.
 *
 * Self-validating: extracts keys/stages, then runs the static signer against
 * the live VM's ns.qi() to confirm correctness. Tries both pipeline orderings
 * (RC4-then-insert and insert-then-RC4) and picks the one that matches.
 *
 * Run:
 *   node -r ts-node/register/transpile-only experiment/BuildComixFastSigner.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const RUNTIME = JSON.parse(readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/runtime.json"), "utf8"));
const SECURE_TEXT = readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/secure.js"), "utf8");
const OUT_FILE = resolve(ROOT, "src/ComixTo/ComixFastSigner.ts");

const TEST_PATH = "/chapters/9000025";

type PipelineOrder = "rc4-then-insert" | "insert-then-rc4";

interface InsertTable {
    prefix: number;
    prefixBytes: number[];
    ops: number[];
}

const OP_XOR = 0;
const OP_ADD_XOR = 1;
const OP_ROTL1_XOR = 2;
const OP_ROTR1_XOR = 3;
const OP_ROTL2_XOR = 4;
const OP_ROTR2_XOR = 5;
const OP_NIBSWAP_XOR = 6;
const OP_ROTL3_XOR = 7;
const OP_ROTR3_XOR = 8;

const rotL1 = (n: number) => ((n << 1) | (n >>> 7)) & 0xff;
const rotR1 = (n: number) => ((n >>> 1) | (n << 7)) & 0xff;
const rotL2 = (n: number) => ((n << 2) | (n >>> 6)) & 0xff;
const rotR2 = (n: number) => ((n >>> 2) | (n << 6)) & 0xff;
const rotL3 = (n: number) => ((n << 3) | (n >>> 5)) & 0xff;
const rotR3 = (n: number) => ((n >>> 3) | (n << 5)) & 0xff;
const nibSwap = (n: number) => ((n << 4) | (n >>> 4)) & 0xff;

const realTimers = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
};

/**
 * Patch secure.js to expose __vmBytecode/__vmEnv/__vmThisArg on every VM
 * closure created by the bundle. Uses structural regex so the patcher survives
 * the bundle renaming its own minified identifiers.
 */
function patchSecure(text: string): { patched: string; count: number } {
    let count = 0;

    // Pattern 1: the "gm" closure factory.
    // return X=(...Y)=>(void 0!==Z&&(NS._$A=!0,NS._$B=Z),P(Q,Y,R,X,void 0,S)),X}
    const pattern1 = /return ([A-Za-z_$]\w*)=\(\.\.\.([A-Za-z_$]\w*)\)=>\(void 0!==([A-Za-z_$]\w*)&&\(([A-Za-z_$]\w*)\._\$\w+=!0,\4\._\$\w+=\3\),([A-Za-z_$]\w*)\(([A-Za-z_$]\w*),\2,([A-Za-z_$]\w*),\1,void 0,([A-Za-z_$]\w*)\)\),\1\}/g;
    let patched = text.replace(pattern1, (match, closure, _args, _qf, _ns, _invoker, bytecode, env, thisArg) => {
        count++;
        const oldSuffix = `),${closure}}`;
        const newSuffix = `),${closure}.__vmBytecode=${bytecode},${closure}.__vmEnv=${env},${closure}.__vmThisArg=${thisArg},${closure}}`;
        return match.slice(0, -oldSuffix.length) + newSuffix;
    });

    // Pattern 2: direct closure registered via d.call(O,Qd,{b:Qi,e:Qx}).
    const pattern2 = /return ([A-Za-z_$]\w*)\.call\(([A-Za-z_$]\w*),([A-Za-z_$]\w*),\{b:([A-Za-z_$]\w*),e:([A-Za-z_$]\w*)\}\),\3\}/g;
    patched = patched.replace(pattern2, (_match, d, O, qd, qi, qx) => {
        count++;
        return `return ${qd}.__vmBytecode=${qi},${qd}.__vmEnv=${qx},${qd}.__vmThisArg=this,${d}.call(${O},${qd},{b:${qi},e:${qx}}),${qd}}`;
    });

    return { patched, count };
}

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

/**
 * Find the VM namespace on globalThis. Bundles use names matching
 * /^vm[a-z]_[a-f0-9]+$/; the structurally invariant check is `.qi` (signer) and `.v`
 * (installer) both being functions.
 */
function findVmNamespace(): { name: string; ns: any } {
    for (const name of Object.getOwnPropertyNames(globalThis)) {
        if (!/^vm[a-z]_[a-f0-9]+$/.test(name)) continue;
        const ns = (globalThis as any)[name];
        if (ns && (typeof ns === "object" || typeof ns === "function") && typeof ns.qi === "function" && typeof ns.v === "function") {
            return { name, ns };
        }
    }
    throw new Error("Could not find VM namespace (expected /^vm[a-z]_[a-f0-9]+$/ with .qi and .v)");
}

function detectInsertPrefix(fn: any): number | null {
    // Verify with two input sizes so we don't match helper functions that
    // ignore arguments and return a constant-length array.
    for (const p of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        try {
            const r1 = fn(new Array(20).fill(0x42));
            const r2 = fn(new Array(30).fill(0x42));
            if (
                Array.isArray(r1) && r1.length === 20 + p &&
                Array.isArray(r2) && r2.length === 30 + p
            ) return p;
        } catch {}
    }
    return null;
}

function isRc4KeyGetter(fn: any): boolean {
    try {
        const r = fn();
        return typeof r === "string" && r.length === 32;
    } catch { return false; }
}

/**
 * Walk the namespace looking for the closure whose __vmEnv contains the
 * signer's locals dict: a record with at least 5 insert stages and 5 RC4 key
 * getters. This is structurally invariant across bundle rotations.
 */
function findSignerLocals(ns: any): Record<string, any> {
    const seen = new Set<any>();

    function walk(obj: any, depth: number): Record<string, any> | null {
        if (!obj || seen.has(obj) || depth > 6) return null;
        if (typeof obj !== "object" && typeof obj !== "function") return null;
        seen.add(obj);

        const env = (obj as any).__vmEnv;
        if (env && typeof env === "object") {
            for (const envKey of Object.keys(env)) {
                const candidate = env[envKey];
                if (!candidate || typeof candidate !== "object") continue;
                const keys = Object.getOwnPropertyNames(candidate);
                if (keys.length < 20) continue;
                let insertCount = 0;
                let rc4Count = 0;
                for (const k of keys) {
                    const fn = candidate[k];
                    if (typeof fn !== "function") continue;
                    if (detectInsertPrefix(fn) !== null) insertCount++;
                    else if (isRc4KeyGetter(fn)) rc4Count++;
                    if (insertCount >= 5 && rc4Count >= 5) return candidate;
                }
            }
        }

        try {
            for (const key of Object.getOwnPropertyNames(obj)) {
                if (key === "constructor" || key === "prototype" || key === "caller" || key === "arguments") continue;
                try {
                    const result = walk((obj as any)[key], depth + 1);
                    if (result) return result;
                } catch {}
            }
        } catch {}
        return null;
    }
    const result = walk(ns, 0);
    if (!result) throw new Error("Could not find signer locals (need >=5 insert stages and >=5 RC4 getters under some .__vmEnv)");
    return result;
}

function binaryStringToBytes(s: string): number[] {
    const out = new Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

function encodedIndexForInput(inputIndex: number, prefixLimit: number): number {
    return inputIndex < prefixLimit ? inputIndex * 2 + 1 : inputIndex + prefixLimit;
}

function matches(map: number[], fn: (b: number) => number): boolean {
    for (let b = 0; b < 256; b++) {
        if ((fn(b) & 0xff) !== map[b]) return false;
    }
    return true;
}

function inferOp(map: number[]): [number, number, number] {
    const xorKey = map[0]! & 0xff;
    if (matches(map, b => b ^ xorKey)) return [OP_XOR, xorKey, 0];

    for (let add = 0; add < 256; add++) {
        const key = (map[0]! - add) & 0xff;
        if (matches(map, b => ((b ^ key) + add) & 0xff)) return [OP_ADD_XOR, key, add];
    }

    const rotCandidates: Array<[number, (n: number) => number, (n: number) => number]> = [
        [OP_ROTL1_XOR, rotL1, rotR1],
        [OP_ROTR1_XOR, rotR1, rotL1],
        [OP_ROTL2_XOR, rotL2, rotR2],
        [OP_ROTR2_XOR, rotR2, rotL2],
        [OP_NIBSWAP_XOR, nibSwap, nibSwap],
        [OP_ROTL3_XOR, rotL3, rotR3],
        [OP_ROTR3_XOR, rotR3, rotL3],
    ];
    for (const [op, forward, inverse] of rotCandidates) {
        const key = inverse(map[0]! & 0xff);
        if (matches(map, b => forward(b ^ key))) return [op, key, 0];
    }

    throw new Error(`unmatched transform: ${map.slice(0, 16).join(",")}`);
}

function buildInsertTable(stage: (data: number[]) => number[], prefixLimit: number): InsertTable {
    const period = 160;
    const table: number[][] = Array.from({ length: period }, () => new Array(256));
    const zeroOut = stage(new Array(period).fill(0));
    const prefixBytes: number[] = [];
    for (let i = 0; i < prefixLimit; i++) prefixBytes.push(zeroOut[i * 2]! & 0xff);
    for (let b = 0; b < 256; b++) {
        const input = new Array(period).fill(b);
        const out = stage(input);
        for (let residue = 0; residue < period; residue++) {
            table[residue]![b] = out[encodedIndexForInput(residue, prefixLimit)]! & 0xff;
        }
    }
    const ops = table.flatMap(inferOp);
    return { prefix: prefixLimit, prefixBytes, ops };
}

// In-process implementations matching the generated source — used for self-validation.
function transformByte(b: number, op: number, key: number, extra: number): number {
    const n = b ^ key;
    switch (op) {
        case OP_XOR: return n;
        case OP_ADD_XOR: return (n + extra) & 0xff;
        case OP_ROTL1_XOR: return rotL1(n);
        case OP_ROTR1_XOR: return rotR1(n);
        case OP_ROTL2_XOR: return rotL2(n);
        case OP_ROTR2_XOR: return rotR2(n);
        case OP_NIBSWAP_XOR: return nibSwap(n);
        case OP_ROTL3_XOR: return rotL3(n);
        case OP_ROTR3_XOR: return rotR3(n);
        default: return n;
    }
}

function applyInsertStage(data: number[], stage: InsertTable): number[] {
    const out: number[] = new Array(data.length + stage.prefix);
    for (let i = 0; i < data.length; i++) {
        if (i < stage.prefix) out[i * 2] = stage.prefixBytes[i]!;
        const opIndex = (i % 160) * 3;
        out[i < stage.prefix ? i * 2 + 1 : i + stage.prefix] = transformByte(
            data[i]! & 0xff,
            stage.ops[opIndex]!,
            stage.ops[opIndex + 1]!,
            stage.ops[opIndex + 2]!,
        );
    }
    return out;
}

function rc4(key: number[], data: number[]): number[] {
    const s: number[] = new Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i]! + key[i % key.length]!) & 255;
        const t = s[i]!; s[i] = s[j]!; s[j] = t;
    }
    const out: number[] = new Array(data.length);
    let i = 0; j = 0;
    for (let n = 0; n < data.length; n++) {
        i = (i + 1) & 255;
        j = (j + s[i]!) & 255;
        const t = s[i]!; s[i] = s[j]!; s[j] = t;
        out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!;
    }
    return out;
}

function b64Decode(s: string): number[] {
    const lookup: number[] = new Array(128).fill(-1);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (let i = 0; i < 64; i++) lookup[chars.charCodeAt(i)] = i;
    const out: number[] = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 61) break;
        const v = lookup[c] ?? -1;
        if (v < 0) continue;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 0xff);
        }
    }
    return out;
}

function b64UrlEncode(bytes: number[]): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "", i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
        out += chars[(n >> 18) & 63]! + chars[(n >> 12) & 63]! + chars[(n >> 6) & 63]! + chars[n & 63]!;
    }
    if (i + 1 === bytes.length) {
        const n = bytes[i]! << 16;
        out += chars[(n >> 18) & 63]! + chars[(n >> 12) & 63]!;
    } else if (i + 2 === bytes.length) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
        out += chars[(n >> 18) & 63]! + chars[(n >> 12) & 63]! + chars[(n >> 6) & 63]!;
    }
    return out.replace(/\+/g, "-").replace(/\//g, "_");
}

function computeHash(path: string, rc4KeysB64: string[], insertStages: InsertTable[], order: PipelineOrder): string {
    let data: number[] = [];
    for (let i = 0; i < path.length; i++) data.push(path.charCodeAt(i) & 0xff);
    // Match the generated source's behavior: encodeURIComponent before signing.
    const enc = encodeURIComponent(path);
    data = [];
    for (let i = 0; i < enc.length; i++) data.push(enc.charCodeAt(i) & 0xff);

    for (let i = 0; i < 5; i++) {
        if (order === "rc4-then-insert") {
            data = rc4(b64Decode(rc4KeysB64[i]!), data);
            data = applyInsertStage(data, insertStages[i]!);
        } else {
            data = applyInsertStage(data, insertStages[i]!);
            data = rc4(b64Decode(rc4KeysB64[i]!), data);
        }
    }
    return b64UrlEncode(data);
}

function buildSource(keys: string[], inserts: InsertTable[], order: PipelineOrder): string {
    const loopBody = order === "rc4-then-insert"
        ? `        data = rc4(b64Decode(RC4_KEYS[i]!), data);
        data = applyInsertStage(data, INSERT_STAGES[i]!);`
        : `        data = applyInsertStage(data, INSERT_STAGES[i]!);
        data = rc4(b64Decode(RC4_KEYS[i]!), data);`;

    return `/* Generated by experiment/BuildComixFastSigner.ts.
 * Bundle ID: ${RUNTIME.bundleId}
 * Pipeline order: ${order}
 * This is the de-VM'd Comix request signer.
 */

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const RC4_KEYS: string[] = ${JSON.stringify(keys, null, 4)};
const INSERT_STAGES = [
${inserts.map(stage => `    { prefix: ${stage.prefix}, prefixBytes: [${stage.prefixBytes.join(",")}], ops: [${stage.ops.join(",")}] }`).join(",\n")}
];

function b64Decode(s: string): number[] {
    const lookup: number[] = new Array(128).fill(-1);
    for (let i = 0; i < 64; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
    const out: number[] = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 61) break;
        const v = lookup[c] ?? -1;
        if (v < 0) continue;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 0xff);
        }
    }
    return out;
}

function b64UrlEncode(bytes: number[]): string {
    let out = "", i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
    }
    if (i + 1 === bytes.length) {
        const n = bytes[i] << 16;
        out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63];
    } else if (i + 2 === bytes.length) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63];
    }
    return out.replace(/\\+/g, "-").replace(/\\//g, "_");
}

function rc4(key: number[], data: number[]): number[] {
    const s: number[] = new Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i] + key[i % key.length]) & 255;
        const t = s[i]; s[i] = s[j]; s[j] = t;
    }
    const out: number[] = new Array(data.length);
    let i = 0; j = 0;
    for (let n = 0; n < data.length; n++) {
        i = (i + 1) & 255;
        j = (j + s[i]) & 255;
        const t = s[i]; s[i] = s[j]; s[j] = t;
        out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
    }
    return out;
}

function bytesFromString(s: string): number[] {
    const out: number[] = new Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

function rotL1(n: number): number { return ((n << 1) | (n >>> 7)) & 0xff; }
function rotR1(n: number): number { return ((n >>> 1) | (n << 7)) & 0xff; }
function rotL2(n: number): number { return ((n << 2) | (n >>> 6)) & 0xff; }
function rotR2(n: number): number { return ((n >>> 2) | (n << 6)) & 0xff; }
function rotL3(n: number): number { return ((n << 3) | (n >>> 5)) & 0xff; }
function rotR3(n: number): number { return ((n >>> 3) | (n << 5)) & 0xff; }
function nibSwap(n: number): number { return ((n << 4) | (n >>> 4)) & 0xff; }

function transformByte(b: number, op: number, key: number, extra: number): number {
    const n = b ^ key;
    switch (op) {
        case ${OP_XOR}: return n;
        case ${OP_ADD_XOR}: return (n + extra) & 0xff;
        case ${OP_ROTL1_XOR}: return rotL1(n);
        case ${OP_ROTR1_XOR}: return rotR1(n);
        case ${OP_ROTL2_XOR}: return rotL2(n);
        case ${OP_ROTR2_XOR}: return rotR2(n);
        case ${OP_NIBSWAP_XOR}: return nibSwap(n);
        case ${OP_ROTL3_XOR}: return rotL3(n);
        case ${OP_ROTR3_XOR}: return rotR3(n);
        default: return n;
    }
}

function applyInsertStage(data: number[], stage: { prefix: number; prefixBytes: number[]; ops: number[] }): number[] {
    const out: number[] = new Array(data.length + stage.prefix);
    for (let i = 0; i < data.length; i++) {
        if (i < stage.prefix) out[i * 2] = stage.prefixBytes[i]!;
        const opIndex = (i % 160) * 3;
        out[i < stage.prefix ? i * 2 + 1 : i + stage.prefix] = transformByte(
            data[i] & 0xff,
            stage.ops[opIndex]!,
            stage.ops[opIndex + 1]!,
            stage.ops[opIndex + 2]!,
        );
    }
    return out;
}

function normalizeSignPath(rawPath: string): string {
    return rawPath
        .replace(/^https?:\\/\\/[^/]+/, "")
        .replace(/^\\/api\\/v1/, "")
        .split("?")[0]!;
}

export function fastGenerateHash(rawPath: string): string {
    const path = normalizeSignPath(rawPath);
    let data = bytesFromString(encodeURIComponent(path));
    for (let i = 0; i < 5; i++) {
${loopBody}
    }
    return b64UrlEncode(data);
}
`;
}

async function main(): Promise<void> {
    installDomStub(RUNTIME.cfg);

    const { patched, count } = patchSecure(SECURE_TEXT);
    if (count === 0) throw new Error("patchSecure made no patches - bundle closure patterns may have changed");
    console.log(`patchSecure applied ${count} patches`);

    const file = join(tmpdir(), `secure-fast-signer-${RUNTIME.bundleId}.mjs`);
    writeFileSync(file, patched);
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport(pathToFileURL(file).href);
    restoreNodeTimers();

    const { name: nsName, ns } = findVmNamespace();
    console.log(`VM namespace: ${nsName}`);

    const locals = findSignerLocals(ns);
    console.log(`Signer locals: ${Object.getOwnPropertyNames(locals).length} keys`);

    const insertStageCandidates = new Map<string, { fn: Function; prefix: number }>();
    const rc4KeyCandidates = new Map<string, Function>();
    for (const key of Object.getOwnPropertyNames(locals)) {
        const fn = locals[key];
        if (typeof fn !== "function") continue;
        const p = detectInsertPrefix(fn);
        if (p !== null) { insertStageCandidates.set(key, { fn, prefix: p }); continue; }
        if (isRc4KeyGetter(fn)) rc4KeyCandidates.set(key, fn);
    }
    console.log(`Candidates: ${insertStageCandidates.size} insert stages, ${rc4KeyCandidates.size} RC4 key getters`);

    // Discover call order by intercepting candidates during a real qi() call
    const stageCallLog: string[] = [];
    const rc4CallLog: string[] = [];
    const originals = new Map<string, Function>();
    for (const [key, { fn }] of insertStageCandidates) {
        originals.set(key, fn);
        locals[key] = function (input: number[]) { stageCallLog.push(key); return fn(input); };
    }
    for (const [key, fn] of rc4KeyCandidates) {
        originals.set(key, fn);
        locals[key] = function () { rc4CallLog.push(key); return fn(); };
    }
    ns.qi(TEST_PATH);
    for (const [k, fn] of originals) locals[k] = fn;

    const orderedStageKeys = [...new Set(stageCallLog)];
    const orderedRc4Keys = [...new Set(rc4CallLog)];
    if (orderedStageKeys.length !== 5) throw new Error(`Expected 5 insert stages in call trace, got ${orderedStageKeys.length}: ${orderedStageKeys.join(",")}`);
    if (orderedRc4Keys.length !== 5) throw new Error(`Expected 5 RC4 keys in call trace, got ${orderedRc4Keys.length}: ${orderedRc4Keys.join(",")}`);

    const insertStages = orderedStageKeys.map(key => {
        const { fn, prefix } = insertStageCandidates.get(key)!;
        return buildInsertTable(fn as (data: number[]) => number[], prefix);
    });
    const rc4KeysB64 = orderedRc4Keys.map(key => {
        const fn = rc4KeyCandidates.get(key)! as () => string;
        return Buffer.from(binaryStringToBytes(fn())).toString("base64");
    });

    // Self-validate: try both pipeline orders against the live VM
    const liveToken = ns.qi(TEST_PATH) as string;
    const orders: PipelineOrder[] = ["rc4-then-insert", "insert-then-rc4"];
    let workingOrder: PipelineOrder | null = null;
    for (const order of orders) {
        if (computeHash(TEST_PATH, rc4KeysB64, insertStages, order) === liveToken) {
            workingOrder = order;
            break;
        }
    }
    if (!workingOrder) {
        console.error(`Live token:        ${liveToken}`);
        for (const order of orders) {
            console.error(`  Order ${order.padEnd(20)} ${computeHash(TEST_PATH, rc4KeysB64, insertStages, order)}`);
        }
        throw new Error("Neither pipeline order matches live token - algorithm structure has changed");
    }
    console.log(`Validated pipeline order: ${workingOrder}`);

    writeFileSync(OUT_FILE, buildSource(rc4KeysB64, insertStages, workingOrder));
    console.log(`wrote ${OUT_FILE}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
