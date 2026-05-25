export {};

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const RUNTIME = JSON.parse(readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/runtime.json"), "utf8"));
const SECURE_PATCHED_TEXT = readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/secure-patched.js"), "utf8");
const FIXTURES = JSON.parse(readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/fixtures.json"), "utf8")) as Fixture[];
const OUT_FILE = resolve(ROOT, "src/ComixTo/ComixFastDecrypt.ts");

type PipelineOrder = "mutation-then-rc4" | "rc4-then-mutation";

interface Fixture {
    path: string;
    headers?: Record<string, string>;
    encryptedPayload: any;
    decrypted: any;
}

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

function binaryStringToBytes(s: string): number[] {
    const out = new Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

function b64Decode(s: string): number[] {
    const lookup: number[] = new Array(128).fill(-1);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (let i = 0; i < 64; i++) lookup[chars.charCodeAt(i)] = i;
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const out: number[] = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < normalized.length; i++) {
        const c = normalized.charCodeAt(i);
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

function bytesToBinaryString(bytes: number[]): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 8192) {
        out += String.fromCharCode(...bytes.slice(i, i + 8192));
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

function encodedIndexForOutput(outputIndex: number, prefixLimit: number): number {
    return outputIndex < prefixLimit ? outputIndex * 2 + 1 : outputIndex + prefixLimit;
}

interface MutationOps {
    prefix: number;
    tableB64: string;
}

// ===== sbox-cbc inverse (new algorithm in bundle 3a0786b685ca onward) =====

interface SboxCbcInverseStage {
    table: number[];      // forward sbox (256-byte permutation)
    inverseTable: number[]; // inverse permutation
    key: number[];
    iv: number;
}

interface SboxRoundTrace {
    tableB64: string;
    keyB64: string;
    decodeFn: Function;
    stageFn: (data: number[]) => number[];
    stageThis: any;
    stageIndex: number;
    sampleIn: number[];
    sampleOut: number[];
}

function applySboxCbcInverseStage(data: number[], stage: SboxCbcInverseStage): number[] {
    const out: number[] = new Array(data.length);
    let prev = stage.iv & 0xff;
    for (let i = 0; i < data.length; i++) {
        const cipherByte = data[i]! & 0xff;
        const idx = stage.inverseTable[cipherByte]! & 0xff;
        out[i] = (idx ^ stage.key[i % stage.key.length]! ^ prev) & 0xff;
        prev = cipherByte;
    }
    return out;
}

/**
 * Find the array field in a __vmEnv object. The VM rotates the property name
 * each build, so locate it structurally by finding the first own property
 * whose value is a JS array.
 */
function getVmEnvArray(envObj: any): any[] | null {
    if (!envObj || typeof envObj !== "object") return null;
    for (const key of Object.getOwnPropertyNames(envObj)) {
        if (Array.isArray(envObj[key])) return envObj[key];
    }
    return null;
}

/**
 * Find a decrypt method whose __vmEnv contains the stage primitives array.
 * Scans all VM-method-bearing objects in the namespace; the method we want is
 * the one whose output on the encrypted fixture equals expectedJsonString.
 */
function findSboxCbcDecryptMethod(ns: any, encryptedB64: string, expectedJsonString: string): { fn: Function; thisArg: any } | null {
    for (const k of Object.getOwnPropertyNames(ns)) {
        let obj: any;
        try { obj = (ns as any)[k]; } catch { continue; }
        if (!obj || typeof obj !== "object") continue;
        for (const k2 of Object.getOwnPropertyNames(obj)) {
            let fn: any;
            try { fn = obj[k2]; } catch { continue; }
            if (typeof fn !== "function" || !getVmEnvArray(fn.__vmEnv)) continue;
            try {
                const out = fn.call(obj, encryptedB64);
                if (typeof out === "string" && out === expectedJsonString) {
                    return { fn, thisArg: obj };
                }
            } catch {}
        }
    }

    const seen = new Set<any>();
    function walk(obj: any, depth: number): { fn: Function; thisArg: any } | null {
        if (!obj || seen.has(obj) || depth > 5) return null;
        if (typeof obj !== "object" && typeof obj !== "function") return null;
        seen.add(obj);
        for (const key of Object.getOwnPropertyNames(obj)) {
            if (key === "constructor" || key === "prototype" || key === "caller" || key === "arguments") continue;
            let value: any;
            try { value = obj[key]; } catch { continue; }
            if (typeof value === "function" && getVmEnvArray((value as any).__vmEnv)) {
                try {
                    const out = value.call(obj, encryptedB64);
                    if (typeof out === "string" && out === expectedJsonString) {
                        return { fn: value, thisArg: obj };
                    }
                } catch {}
            }
            const nested = walk(value, depth + 1);
            if (nested) return nested;
        }
        return null;
    }
    return walk(ns, 0);
}

/**
 * Capture (table, key, sample-in, sample-out) for each round by intercepting
 * the env array fns. Watches for decoded 256-byte tables, decoded small keys,
 * and array→array stage invocations of matching length. Insensitive to which
 * env slot is the decoder vs which is the stage applier.
 */
function captureSboxCbcDecryptRounds(method: Function, encryptedB64: string, thisArg?: any): SboxRoundTrace[] {
    const envArray = getVmEnvArray((method as any).__vmEnv);
    if (!envArray) throw new Error("decrypt method has no VM env function array");

    const originals = envArray.slice();
    const rounds: SboxRoundTrace[] = [];
    let pendingTable: { b64: string; decodeFn: Function } | null = null;
    let pendingKey: { b64: string; decodeFn: Function } | null = null;
    const encryptedByteLen = b64Decode(encryptedB64).length;

    for (let i = 0; i < envArray.length; i++) {
        const original = originals[i];
        if (typeof original !== "function") continue;
        envArray[i] = function (...args: any[]) {
            const ret = original.apply(this, args);
            if (typeof args[0] === "string") {
                let decodedLen = 0;
                try { decodedLen = b64Decode(args[0]).length; } catch {}
                if (decodedLen === 256) {
                    pendingTable = { b64: args[0], decodeFn: original };
                    pendingKey = null;
                } else if (pendingTable && decodedLen > 0 && decodedLen <= 64) {
                    pendingKey = { b64: args[0], decodeFn: original };
                }
            } else if (
                pendingTable &&
                pendingKey &&
                Array.isArray(args[0]) &&
                Array.isArray(ret) &&
                ret.length === args[0].length &&
                args[0].length >= Math.min(encryptedByteLen, 16)
            ) {
                rounds.push({
                    tableB64: pendingTable.b64,
                    keyB64: pendingKey.b64,
                    decodeFn: pendingKey.decodeFn,
                    stageFn: original as (data: number[]) => number[],
                    stageThis: this,
                    stageIndex: i,
                    sampleIn: args[0].slice(),
                    sampleOut: ret.slice(),
                });
                pendingTable = null;
                pendingKey = null;
            }
            return ret;
        };
    }

    try {
        method.call(thisArg, encryptedB64);
    } finally {
        for (let i = 0; i < originals.length; i++) envArray[i] = originals[i];
    }

    return rounds;
}

/**
 * Build inverse stages from observed rounds. The decrypt method applies rounds
 * in reverse order from sign, but we record them in the order traced — which
 * IS the application order for the inverse pipeline.
 */
function buildSboxCbcInverseStages(rounds: SboxRoundTrace[]): SboxCbcInverseStage[] {
    return rounds.map(round => {
        const table = b64Decode(round.tableB64);
        const key = b64Decode(round.keyB64);
        if (table.length !== 256) throw new Error(`sbox table for stage ${round.stageIndex} decoded to ${table.length} bytes`);
        if (key.length === 0) throw new Error(`sbox key for stage ${round.stageIndex} is empty`);

        const inverse = new Array(256).fill(-1);
        for (let i = 0; i < 256; i++) inverse[table[i]!] = i;
        if (inverse.some(v => v < 0)) throw new Error(`sbox table for stage ${round.stageIndex} is not a permutation`);

        // Recover iv from observed sample.
        // Inverse stage: out[0] = inverse[in[0]] ^ key[0] ^ iv  =>  iv = inverse[in[0]] ^ key[0] ^ out[0]
        const idx0 = inverse[round.sampleIn[0]! & 0xff]!;
        const iv = (idx0 ^ key[0]! ^ (round.sampleOut[0]! & 0xff)) & 0xff;

        // Sanity-check against the full trace
        const recomputed = applySboxCbcInverseStage(round.sampleIn.slice(), { table, inverseTable: inverse, key, iv });
        const expected = round.sampleOut.map(b => b & 0xff);
        if (JSON.stringify(recomputed) !== JSON.stringify(expected)) {
            throw new Error(`sbox-cbc inverse formula mismatch for stage ${round.stageIndex}`);
        }

        return { table, inverseTable: inverse, key, iv };
    });
}

function buildSboxCbcDecryptSource(stages: SboxCbcInverseStage[]): string {
    const compact = stages.map(s => ({
        tableB64: Buffer.from(s.table).toString("base64"),
        keyB64: Buffer.from(s.key).toString("base64"),
        iv: s.iv,
    }));

    return `/* Generated by experiment/BuildComixFastDecrypt.ts.
 * Bundle ID: ${RUNTIME.bundleId}
 * Algorithm: sbox-cbc-inverse
 * Pipeline order: sbox-cbc-inverse
 * This is the de-VM'd Comix response decrypt pipeline.
 */

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SBOX_INVERSE_STAGES = ${JSON.stringify(compact, null, 4)};
let SBOX_INVERSE_RUNTIME: { table: number[]; inverseTable: number[]; key: number[]; iv: number }[] | null = null;

function b64Decode(s: string): number[] {
    const lookup: number[] = new Array(128).fill(-1);
    for (let i = 0; i < 64; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const out: number[] = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < normalized.length; i++) {
        const c = normalized.charCodeAt(i);
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

function bytesToBinaryString(bytes: number[]): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 8192) {
        out += String.fromCharCode(...bytes.slice(i, i + 8192));
    }
    return out;
}

function getSboxInverseRuntime() {
    if (SBOX_INVERSE_RUNTIME === null) {
        SBOX_INVERSE_RUNTIME = SBOX_INVERSE_STAGES.map(stage => {
            const table = b64Decode(stage.tableB64);
            const inverseTable: number[] = new Array(256).fill(0);
            for (let i = 0; i < 256; i++) inverseTable[table[i]!] = i;
            return { table, inverseTable, key: b64Decode(stage.keyB64), iv: stage.iv };
        });
    }
    return SBOX_INVERSE_RUNTIME;
}

function applySboxCbcInverseStage(data: number[], stage: { inverseTable: number[]; key: number[]; iv: number }): number[] {
    const out: number[] = new Array(data.length);
    let prev = stage.iv & 0xff;
    for (let i = 0; i < data.length; i++) {
        const cipherByte = data[i]! & 0xff;
        const idx = stage.inverseTable[cipherByte]! & 0xff;
        out[i] = (idx ^ stage.key[i % stage.key.length]! ^ prev) & 0xff;
        prev = cipherByte;
    }
    return out;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(headers ?? {})) out[key.toLowerCase()] = String(headers[key]);
    return out;
}

export function fastDecryptComixPayload(rawPath: string, payload: any, headers: Record<string, string> = {}): any {
    void rawPath;
    if (!(payload && typeof payload === "object" && "e" in payload)) return payload;
    const normalizedHeaders = normalizeHeaders(headers);
    if (normalizedHeaders["x-enc"] && normalizedHeaders["x-enc"] !== "1") return payload;

    let data = b64Decode(String(payload.e ?? ""));
    const stages = getSboxInverseRuntime();
    for (const stage of stages) data = applySboxCbcInverseStage(data, stage);

    const parsed = JSON.parse(decodeURIComponent(bytesToBinaryString(data)));
    return parsed && typeof parsed === "object" && parsed.status === "ok" ? parsed.result : parsed;
}
`;
}

function tryBuildSboxCbcDecrypt(ns: any): boolean {
    if (!Array.isArray(FIXTURES) || FIXTURES.length === 0) return false;
    const fixture = FIXTURES[0]!;
    const encryptedB64 = String(fixture.encryptedPayload?.e ?? "");
    if (!encryptedB64) return false;
    // Probe via direct decrypt to derive the expected raw plaintext (UTF-8 JSON string with status wrapping).
    // Container/method names rotate (Ai.I -> yi.J -> wi.J); scan all VM-method-bearing objects in the namespace.
    let expectedRaw: string | null = null;
    outer: for (const k of Object.getOwnPropertyNames(ns)) {
        let obj: any;
        try { obj = (ns as any)[k]; } catch { continue; }
        if (!obj || typeof obj !== "object") continue;
        for (const k2 of Object.getOwnPropertyNames(obj)) {
            let fn: any;
            try { fn = obj[k2]; } catch { continue; }
            if (typeof fn !== "function" || !getVmEnvArray(fn.__vmEnv)) continue;
            try {
                const direct = fn.call(obj, encryptedB64);
                if (typeof direct === "string" && direct.length > 0 && (direct.startsWith("{") || direct.startsWith("[") || direct.startsWith("\""))) {
                    expectedRaw = direct;
                    break outer;
                }
            } catch {}
        }
    }
    if (expectedRaw === null) return false;

    const method = findSboxCbcDecryptMethod(ns, encryptedB64, expectedRaw);
    if (!method) return false;

    const rounds = captureSboxCbcDecryptRounds(method.fn, encryptedB64, method.thisArg);
    if (rounds.length === 0) {
        console.log("sbox-cbc decrypt: no rounds captured, falling back");
        return false;
    }
    console.log(`Detected decrypt algorithm: sbox-cbc-inverse (${rounds.length} rounds)`);

    const stages = buildSboxCbcInverseStages(rounds);

    // Validate against all fixtures
    for (const fx of FIXTURES) {
        const cipherBytes = b64Decode(String(fx.encryptedPayload?.e ?? ""));
        let data = cipherBytes.slice();
        for (const stage of stages) data = applySboxCbcInverseStage(data, stage);
        const rawJson = decodeURIComponent(bytesToBinaryString(data));
        const parsed = JSON.parse(rawJson);
        const result = parsed && typeof parsed === "object" && parsed.status === "ok" ? parsed.result : parsed;
        if (stable(result) !== stable(fx.decrypted)) {
            throw new Error(`sbox-cbc inverse mismatch on ${fx.path}`);
        }
        console.log(`  OK  ${fx.path}`);
    }

    writeFileSync(OUT_FILE, buildSboxCbcDecryptSource(stages));
    console.log(`wrote ${OUT_FILE}`);
    return true;
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
const OP_XOR_ADD = 9;
const OP_XOR_ROTL1 = 10;
const OP_XOR_ROTR1 = 11;
const OP_XOR_ROTL2 = 12;
const OP_XOR_ROTR2 = 13;
const OP_XOR_NIBSWAP = 14;
const OP_XOR_ROTL3 = 15;
const OP_XOR_ROTR3 = 16;

const rotL1 = (n: number) => ((n << 1) | (n >>> 7)) & 0xff;
const rotR1 = (n: number) => ((n >>> 1) | (n << 7)) & 0xff;
const rotL2 = (n: number) => ((n << 2) | (n >>> 6)) & 0xff;
const rotR2 = (n: number) => ((n >>> 2) | (n << 6)) & 0xff;
const rotL3 = (n: number) => ((n << 3) | (n >>> 5)) & 0xff;
const rotR3 = (n: number) => ((n >>> 3) | (n << 5)) & 0xff;
const nibSwap = (n: number) => ((n << 4) | (n >>> 4)) & 0xff;

function matches(map: number[], fn: (b: number) => number): boolean {
    for (let b = 0; b < 256; b++) {
        if ((fn(b) & 0xff) !== map[b]) return false;
    }
    return true;
}

function inferOp(map: number[]): [number, number, number] {
    const xorKey = map[0] & 0xff;
    if (matches(map, b => b ^ xorKey)) return [OP_XOR, xorKey, 0];

    for (let add = 0; add < 256; add++) {
        const key = (map[0] - add) & 0xff;
        if (matches(map, b => (((b + add) & 0xff) ^ key))) return [OP_ADD_XOR, key, add];
    }

    for (let add = 0; add < 256; add++) {
        const key = ((map[0] - add) & 0xff);
        if (matches(map, b => (((b ^ key) + add) & 0xff))) return [OP_XOR_ADD, key, add];
    }

    const rotCandidates: Array<[number, (n: number) => number]> = [
        [OP_ROTL1_XOR, rotL1],
        [OP_ROTR1_XOR, rotR1],
        [OP_ROTL2_XOR, rotL2],
        [OP_ROTR2_XOR, rotR2],
        [OP_NIBSWAP_XOR, nibSwap],
        [OP_ROTL3_XOR, rotL3],
        [OP_ROTR3_XOR, rotR3],
    ];
    for (const [op, transform] of rotCandidates) {
        const key = transform(0) ^ map[0];
        if (matches(map, b => transform(b) ^ key)) return [op, key, 0];
    }

    const xorThenRotCandidates: Array<[number, (n: number) => number, (n: number) => number]> = [
        [OP_XOR_ROTL1, rotL1, rotR1],
        [OP_XOR_ROTR1, rotR1, rotL1],
        [OP_XOR_ROTL2, rotL2, rotR2],
        [OP_XOR_ROTR2, rotR2, rotL2],
        [OP_XOR_NIBSWAP, nibSwap, nibSwap],
        [OP_XOR_ROTL3, rotL3, rotR3],
        [OP_XOR_ROTR3, rotR3, rotL3],
    ];
    for (const [op, transform, inverse] of xorThenRotCandidates) {
        const key = inverse(map[0] & 0xff);
        if (matches(map, b => transform(b ^ key))) return [op, key, 0];
    }

    throw new Error(`unmatched decrypt transform: ${map.slice(0, 16).join(",")}`);
}

function buildMutationOps(stage: (data: number[]) => number[], prefixLimit: number): MutationOps {
    const period = 160;
    const table = new Array(period * 256);
    const inputLen = period + prefixLimit;
    for (let b = 0; b < 256; b++) {
        const input = new Array(inputLen).fill(0);
        for (let residue = 0; residue < period; residue++) {
            input[encodedIndexForOutput(residue, prefixLimit)] = b;
        }
        const out = stage(input);
        for (let residue = 0; residue < period; residue++) {
            table[residue * 256 + b] = out[residue] & 0xff;
        }
    }
    return { prefix: prefixLimit, tableB64: Buffer.from(table).toString("base64") };
}

function buildSource(keys: string[], stages: MutationOps[], order: PipelineOrder): string {
    const loopBody = order === "mutation-then-rc4"
        ? `        data = applyMutationStage(data, MUTATION_STAGES[i]!, mutationTables[i]!);
        data = rc4(b64Decode(RC4_KEYS[i]!), data);`
        : `        data = rc4(b64Decode(RC4_KEYS[i]!), data);
        data = applyMutationStage(data, MUTATION_STAGES[i]!, mutationTables[i]!);`;

    return `/* Generated by experiment/BuildComixFastDecrypt.ts.
 * Bundle ID: ${RUNTIME.bundleId}
 * Pipeline order: ${order}
 * This is the de-VM'd Comix response decrypt pipeline.
 */

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const RC4_KEYS: string[] = ${JSON.stringify(keys, null, 4)};
const MUTATION_STAGES = [
${stages.map(stage => `    { prefix: ${stage.prefix}, table: "${stage.tableB64}" }`).join(",\n")}
];
let MUTATION_TABLES: number[][] | null = null;

function b64Decode(s: string): number[] {
    const lookup: number[] = new Array(128).fill(-1);
    for (let i = 0; i < 64; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const out: number[] = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < normalized.length; i++) {
        const c = normalized.charCodeAt(i);
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

function bytesToBinaryString(bytes: number[]): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 8192) {
        out += String.fromCharCode(...bytes.slice(i, i + 8192));
    }
    return out;
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

function encodedIndexForOutput(outputIndex: number, prefixLimit: number): number {
    return outputIndex < prefixLimit ? outputIndex * 2 + 1 : outputIndex + prefixLimit;
}

function getMutationTables(): number[][] {
    if (MUTATION_TABLES === null) {
        MUTATION_TABLES = MUTATION_STAGES.map(stage => b64Decode(stage.table));
    }
    return MUTATION_TABLES;
}

function applyMutationStage(data: number[], stage: { prefix: number; table: string }, table: number[]): number[] {
    const outLen = data.length - stage.prefix;
    if (outLen < 0) throw new Error("Comix encrypted payload is too short");
    const out: number[] = new Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const encoded = data[encodedIndexForOutput(i, stage.prefix)] & 0xff;
        out[i] = table[(i % 160) * 256 + encoded]!;
    }
    return out;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(headers ?? {})) out[key.toLowerCase()] = String(headers[key]);
    return out;
}

export function fastDecryptComixPayload(rawPath: string, payload: any, headers: Record<string, string> = {}): any {
    void rawPath;
    if (!(payload && typeof payload === "object" && "e" in payload)) return payload;
    const normalizedHeaders = normalizeHeaders(headers);
    if (normalizedHeaders["x-enc"] && normalizedHeaders["x-enc"] !== "1") return payload;

    let data = b64Decode(String(payload.e ?? ""));
    const mutationTables = getMutationTables();
    for (let i = 0; i < RC4_KEYS.length; i++) {
${loopBody}
    }

    const parsed = JSON.parse(decodeURIComponent(bytesToBinaryString(data)));
    return parsed && typeof parsed === "object" && parsed.status === "ok" ? parsed.result : parsed;
}
`;
}

function isRc4KeyGetter(fn: any): boolean {
    try {
        const result = fn();
        return typeof result === "string" && result.length === 32;
    } catch {}
    return false;
}

function detectMutationPrefix(fn: any): number | null {
    for (const prefix of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        try {
            const r1 = fn(new Array(20 + prefix).fill(0x42));
            const r2 = fn(new Array(30 + prefix).fill(0x42));
            if (
                Array.isArray(r1) && r1.length === 20 &&
                Array.isArray(r2) && r2.length === 30
            ) return prefix;
        } catch {}
    }
    return null;
}

function isMutationStage(fn: any): boolean {
    return detectMutationPrefix(fn) !== null;
}

function parseRef(ref: string): { ns: string; prop: string } {
    const m = ref.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
    if (!m) throw new Error(`Cannot parse ref "${ref}"`);
    return { ns: m[1]!, prop: m[2]! };
}

const INSTALLER_REF = parseRef(RUNTIME.installerRef);
const INSTALLER_PROP = INSTALLER_REF.prop;

function findVmNamespace(): { name: string; ns: any } {
    const expected = INSTALLER_REF.ns;
    const direct = (globalThis as any)[expected];
    if (direct && (typeof direct === "object" || typeof direct === "function") && typeof direct[INSTALLER_PROP] === "function") {
        return { name: expected, ns: direct };
    }
    for (const name of Object.getOwnPropertyNames(globalThis)) {
        if (!/^vm[a-zA-Z]_[a-f0-9]+$/.test(name)) continue;
        const ns = (globalThis as any)[name];
        if (ns && (typeof ns === "object" || typeof ns === "function") && typeof ns[INSTALLER_PROP] === "function") {
            return { name, ns };
        }
    }
    throw new Error(`Could not find VM namespace (expected ${expected} with .${INSTALLER_PROP})`);
}

function captureResponseHandler(ns: any): any {
    let responseHandler: any = null;
    ns[INSTALLER_PROP]({
        interceptors: { request: { use() {} }, response: { use: (h: any) => { responseHandler = h; } } },
        defaults: { headers: { common: {}, get: {}, post: {}, put: {}, delete: {}, patch: {}, head: {} }, transformRequest: [], transformResponse: [] },
    });
    if (!responseHandler) throw new Error(`No response handler captured from ns.${INSTALLER_PROP}`);
    return responseHandler;
}

function findDecryptLocals(root: any): Record<string, any> {
    const seen = new Set<any>();
    function walk(obj: any, depth: number): Record<string, any> | null {
        if (!obj || seen.has(obj) || depth > 8) return null;
        if (typeof obj !== "object" && typeof obj !== "function") return null;
        seen.add(obj);

        if (typeof obj === "object") {
            const keys = Object.getOwnPropertyNames(obj);
            let rc4Count = 0;
            let mutationCount = 0;
            for (const key of keys) {
                const fn = obj[key];
                if (typeof fn !== "function") continue;
                if (isRc4KeyGetter(fn)) rc4Count++;
                else if (isMutationStage(fn)) mutationCount++;
            }
            if (rc4Count >= 5 && mutationCount >= 5) return obj;
        }

        const env = (obj as any).__vmEnv;
        if (env && typeof env === "object") {
            const result = walk(env, depth + 1);
            if (result) return result;
        }

        for (const key of Object.getOwnPropertyNames(obj)) {
            if (key === "constructor" || key === "prototype" || key === "caller" || key === "arguments") continue;
            try {
                const result = walk((obj as any)[key], depth + 1);
                if (result) return result;
            } catch {}
        }
        return null;
    }

    const locals = walk(root, 0);
    if (!locals) throw new Error("Could not find decrypt locals (need >=5 mutation stages and >=5 RC4 getters)");
    return locals;
}

function applyMutationStage(data: number[], stage: MutationOps, table: number[]): number[] {
    const outLen = data.length - stage.prefix;
    if (outLen < 0) throw new Error("Comix encrypted payload is too short");
    const out: number[] = new Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const encoded = data[encodedIndexForOutput(i, stage.prefix)]! & 0xff;
        out[i] = table[(i % 160) * 256 + encoded]!;
    }
    return out;
}

function computeDecrypt(payload: any, headers: Record<string, string> | undefined, rc4Keys: string[], stages: MutationOps[], order: PipelineOrder): any {
    const normalizedHeaders: Record<string, string> = {};
    for (const key of Object.keys(headers ?? {})) normalizedHeaders[key.toLowerCase()] = String((headers ?? {})[key]);
    if (!(payload && typeof payload === "object" && "e" in payload)) return payload;
    if (normalizedHeaders["x-enc"] && normalizedHeaders["x-enc"] !== "1") return payload;

    let data = b64Decode(String(payload.e ?? ""));
    const mutationTables = stages.map(stage => b64Decode(stage.tableB64));
    for (let i = 0; i < rc4Keys.length; i++) {
        if (order === "mutation-then-rc4") {
            data = applyMutationStage(data, stages[i]!, mutationTables[i]!);
            data = rc4(b64Decode(rc4Keys[i]!), data);
        } else {
            data = rc4(b64Decode(rc4Keys[i]!), data);
            data = applyMutationStage(data, stages[i]!, mutationTables[i]!);
        }
    }

    const parsed = JSON.parse(decodeURIComponent(bytesToBinaryString(data)));
    return parsed && typeof parsed === "object" && parsed.status === "ok" ? parsed.result : parsed;
}

function stable(value: any): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function validateAgainstFixtures(rc4Keys: string[], stages: MutationOps[]): PipelineOrder {
    if (!Array.isArray(FIXTURES) || FIXTURES.length === 0) {
        throw new Error("No decrypt fixtures found. Run ExtractComixRuntime.ts first.");
    }

    const orders: PipelineOrder[] = ["mutation-then-rc4", "rc4-then-mutation"];
    const failures: string[] = [];
    for (const order of orders) {
        let ok = true;
        for (const fixture of FIXTURES) {
            try {
                const got = computeDecrypt(fixture.encryptedPayload, fixture.headers, rc4Keys, stages, order);
                if (stable(got) !== stable(fixture.decrypted)) {
                    ok = false;
                    failures.push(`${order} mismatch on ${fixture.path}`);
                    break;
                }
            } catch (e: any) {
                ok = false;
                failures.push(`${order} threw on ${fixture.path}: ${e?.message ?? String(e)}`);
                break;
            }
        }
        if (ok) return order;
    }
    throw new Error(`Neither decrypt pipeline order matched fixtures:\n${failures.join("\n")}`);
}

async function main(): Promise<void> {
    installDomStub(RUNTIME.cfg);
    const file = join(tmpdir(), `secure-fast-build-${RUNTIME.bundleId}.mjs`);
    writeFileSync(file, SECURE_PATCHED_TEXT);
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport(pathToFileURL(file).href);
    restoreNodeTimers();

    const { name: nsName, ns } = findVmNamespace();
    console.log(`VM namespace: ${nsName}`);

    // Try the new sbox-cbc-inverse path first; fall back to legacy mutation+RC4.
    try {
        if (tryBuildSboxCbcDecrypt(ns)) return;
    } catch (e: any) {
        console.log(`sbox-cbc decrypt build failed: ${e?.message ?? e}; falling back to legacy detection`);
    }

    const responseHandler = captureResponseHandler(ns);
    const locals = findDecryptLocals(responseHandler);
    const keys = Object.getOwnPropertyNames(locals);

    const rc4KeyCandidates = new Map<string, () => string>();
    const mutationCandidates = new Map<string, { fn: (data: number[]) => number[]; prefix: number }>();
    for (const key of keys) {
        const fn = locals[key];
        if (typeof fn !== "function") continue;
        if (isRc4KeyGetter(fn)) rc4KeyCandidates.set(key, fn);
        else {
            const prefix = detectMutationPrefix(fn);
            if (prefix !== null) mutationCandidates.set(key, { fn, prefix });
        }
    }
    if (rc4KeyCandidates.size === 0) throw new Error("No RC4 key getters discovered");
    if (mutationCandidates.size === 0) throw new Error("No mutation stages discovered");
    if (rc4KeyCandidates.size !== mutationCandidates.size) {
        throw new Error(`Candidate count mismatch: ${rc4KeyCandidates.size} RC4 keys vs ${mutationCandidates.size} mutation stages`);
    }
    console.log(`RC4 key getters: ${[...rc4KeyCandidates.keys()].join(", ")}`);
    console.log(`Mutation stages: ${[...mutationCandidates.keys()].join(", ")}`);

    const rc4CallLog: string[] = [];
    const mutCallLog: string[] = [];
    for (const [name, fn] of rc4KeyCandidates) {
        locals[name] = (...args: any[]) => { rc4CallLog.push(name); return (fn as any)(...args); };
    }
    for (const [name, { fn }] of mutationCandidates) {
        locals[name] = (...args: any[]) => { mutCallLog.push(name); return (fn as any)(...args); };
    }

    // Trigger decrypt with a synthetic payload large enough to survive 5 rounds (total prefix overhead = 38 bytes)
    const syntheticData = new Array(200).fill(0x42);
    const fakeResponse = {
        data: { e: Buffer.from(syntheticData).toString("base64") },
        headers: { "x-enc": "1" },
        status: 200,
        config: { url: "/chapters/0" },
    };
    try { responseHandler(fakeResponse); } catch {}

    const orderedRc4 = [...new Set(rc4CallLog)];
    const orderedMut = [...new Set(mutCallLog)];
    if (orderedRc4.length === 0) throw new Error("No RC4 calls observed during decrypt trace");
    if (orderedMut.length === 0) throw new Error("No mutation calls observed during decrypt trace");
    if (orderedRc4.length !== orderedMut.length) {
        throw new Error(`Call-order mismatch: ${orderedRc4.length} RC4 calls vs ${orderedMut.length} mutation calls`);
    }
    console.log(`Rounds: ${orderedRc4.length}`);
    console.log(`RC4 call order: ${orderedRc4.join(", ")}`);
    console.log(`Mutation call order: ${orderedMut.join(", ")}`);

    const rc4Keys = orderedRc4.map(name => Buffer.from(binaryStringToBytes(rc4KeyCandidates.get(name)!())).toString("base64"));
    const stages = orderedMut.map(name => {
        const stage = mutationCandidates.get(name)!;
        return buildMutationOps(stage.fn, stage.prefix);
    });

    const order = validateAgainstFixtures(rc4Keys, stages);
    console.log(`Validated pipeline order: ${order}`);

    writeFileSync(OUT_FILE, buildSource(rc4Keys, stages, order));
    console.log(`wrote ${OUT_FILE}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
