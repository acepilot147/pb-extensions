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
const SECURE_PATCHED_TEXT = readFileSync(resolve(ROOT, "experiment/extracted/comix-runtime-latest/secure-patched.js"), "utf8");
const OUT_FILE = resolve(ROOT, "src/ComixTo/ComixFastSigner.ts");

const TEST_PATH: string = RUNTIME.signChecks?.[0]?.signPath ?? "/chapters/9000025";

type PipelineOrder = "rc4-then-insert" | "insert-then-rc4";
interface InsertTable {
    prefix: number;
    prefixBytes: number[];
    ops: number[];
}

interface SboxCbcStage {
    table: number[];
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
 * Find the VM namespace on globalThis. The signer/installer property names
 * rotate (e.g. qi/v -> Hi/Li); we read them from runtime.json's signerRef
 * and installerRef ("vmy_7ad57b.Hi" / "vmy_7ad57b.Li"). The namespace name
 * matches /^vm[a-zA-Z]_[a-f0-9]+$/ now that upper-case suffixes appear.
 */
function parseRef(ref: string): { ns: string; prop: string } {
    const m = ref.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
    if (!m) throw new Error(`Cannot parse ref "${ref}"`);
    return { ns: m[1]!, prop: m[2]! };
}

const SIGNER_REF = parseRef(RUNTIME.signerRef);
const INSTALLER_REF = parseRef(RUNTIME.installerRef);
if (SIGNER_REF.ns !== INSTALLER_REF.ns) {
    throw new Error(`Signer/installer in different namespaces: ${RUNTIME.signerRef} vs ${RUNTIME.installerRef}`);
}
const SIGNER_PROP = SIGNER_REF.prop;
const INSTALLER_PROP = INSTALLER_REF.prop;

function findVmNamespace(): { name: string; ns: any } {
    const expected = SIGNER_REF.ns;
    const direct = (globalThis as any)[expected];
    if (direct && (typeof direct === "object" || typeof direct === "function") && typeof direct[SIGNER_PROP] === "function" && typeof direct[INSTALLER_PROP] === "function") {
        return { name: expected, ns: direct };
    }
    for (const name of Object.getOwnPropertyNames(globalThis)) {
        if (!/^vm[a-zA-Z]_[a-f0-9]+$/.test(name)) continue;
        const ns = (globalThis as any)[name];
        if (ns && (typeof ns === "object" || typeof ns === "function") && typeof ns[SIGNER_PROP] === "function" && typeof ns[INSTALLER_PROP] === "function") {
            return { name, ns };
        }
    }
    throw new Error(`Could not find VM namespace (expected ${expected} with .${SIGNER_PROP} and .${INSTALLER_PROP})`);
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

function bytesFromString(s: string): number[] {
    const out: number[] = new Array(s.length);
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

function b64Encode(bytes: number[]): string {
    return Buffer.from(bytes).toString("base64");
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

    for (let i = 0; i < rc4KeysB64.length; i++) {
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

function applySboxCbcStage(data: number[], stage: SboxCbcStage): number[] {
    const out: number[] = new Array(data.length);
    let prev = stage.iv & 0xff;
    for (let i = 0; i < data.length; i++) {
        const idx = ((data[i]! & 0xff) ^ stage.key[i % stage.key.length]! ^ prev) & 0xff;
        const next = stage.table[idx]! & 0xff;
        out[i] = next;
        prev = next;
    }
    return out;
}

function computeSboxCbcHash(path: string, stages: SboxCbcStage[]): string {
    let data = bytesFromString(path);
    for (const stage of stages) data = applySboxCbcStage(data, stage);
    return b64UrlEncode(data);
}

function findSboxCbcMethod(root: any, testPath: string, liveToken: string): Function | null {
    const seen = new Set<any>();

    for (const objKey of Object.getOwnPropertyNames(root)) {
        let obj: any;
        try { obj = root[objKey]; } catch { continue; }
        if (!obj || typeof obj !== "object") continue;
        for (const fnKey of Object.getOwnPropertyNames(obj)) {
            let fn: any;
            try { fn = obj[fnKey]; } catch { continue; }
            if (typeof fn !== "function" || !Array.isArray(fn.__vmEnv?._$lW6rn8)) continue;
            try {
                if (fn(testPath) === liveToken) return fn;
            } catch {}
        }
    }

    function walk(obj: any, depth: number): Function | null {
        if (!obj || seen.has(obj) || depth > 5) return null;
        if (typeof obj !== "object" && typeof obj !== "function") return null;
        seen.add(obj);

        for (const key of Object.getOwnPropertyNames(obj)) {
            if (key === "constructor" || key === "prototype" || key === "caller" || key === "arguments") continue;
            let value: any;
            try { value = obj[key]; } catch { continue; }
            if (typeof value === "function") {
                const envArray = value.__vmEnv?._$lW6rn8;
                if (Array.isArray(envArray)) {
                    try {
                        if (value(testPath) === liveToken) return value;
                    } catch {}
                }
            }
            const nested = walk(value, depth + 1);
            if (nested) return nested;
        }
        return null;
    }

    return walk(root, 0);
}

function captureSboxCbcRounds(method: Function, testPath: string, thisArg?: any): SboxRoundTrace[] {
    const envArray = method.__vmEnv?._$lW6rn8;
    if (!Array.isArray(envArray)) throw new Error("S-box signer method has no VM env function array");

    const originals = envArray.slice();
    const rounds: SboxRoundTrace[] = [];
    const knownStageIndexes = [16, 6, 11, 3, 5];
    const pendingStrings: string[] = [];
    let pendingTable: { b64: string; decodeFn: Function } | null = null;
    let pendingKey: { b64: string; decodeFn: Function } | null = null;

    for (let i = 0; i < envArray.length; i++) {
        const original = originals[i];
        if (typeof original !== "function") continue;
        envArray[i] = function (...args: any[]) {
            const ret = original.apply(this, args);
            if (i === 12 && typeof args[0] === "string") pendingStrings.push(args[0]);
            if (knownStageIndexes.includes(i) && pendingStrings.length >= 2 && Array.isArray(args[0]) && Array.isArray(ret)) {
                rounds.push({
                    tableB64: pendingStrings[pendingStrings.length - 2]!,
                    keyB64: pendingStrings[pendingStrings.length - 1]!,
                    decodeFn: originals[12] as Function,
                    stageFn: original as (data: number[]) => number[],
                    stageThis: this,
                    stageIndex: i,
                    sampleIn: args[0].slice(),
                    sampleOut: ret.slice(),
                });
                return ret;
            }
            if (typeof args[0] === "string") {
                const decodedLen = b64Decode(args[0]).length;
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
                args[0].length === bytesFromString(testPath).length
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
        method.call(thisArg, testPath);
    } finally {
        for (let i = 0; i < originals.length; i++) envArray[i] = originals[i];
    }

    return rounds;
}

function buildSboxCbcStages(rounds: SboxRoundTrace[]): SboxCbcStage[] {
    return rounds.map((round) => {
        const table = b64Decode(round.tableB64);
        const key = b64Decode(round.keyB64);
        if (table.length !== 256) throw new Error(`S-box table for stage ${round.stageIndex} decoded to ${table.length} bytes`);
        if (key.length === 0) throw new Error(`S-box key for stage ${round.stageIndex} is empty`);

        const inverse = new Array(256).fill(-1);
        for (let i = 0; i < table.length; i++) inverse[table[i]!] = i;
        if (inverse.some(v => v < 0)) throw new Error(`S-box table for stage ${round.stageIndex} is not a permutation`);

        round.decodeFn(round.tableB64);
        round.decodeFn(round.keyB64);
        const first = round.stageFn.call(round.stageThis, [0])[0]! & 0xff;
        const iv = (inverse[first]! ^ key[0]!) & 0xff;

        for (const sample of [
            round.sampleIn,
            new Array(32).fill(0),
            new Array(32).fill(0x42),
            Array.from({ length: 32 }, (_, i) => (i * 17 + 3) & 0xff),
        ]) {
            round.decodeFn(round.tableB64);
            round.decodeFn(round.keyB64);
            const live = round.stageFn.call(round.stageThis, sample.slice()).map(b => b & 0xff);
            const staticOut = applySboxCbcStage(sample.slice(), { table, key, iv });
            if (JSON.stringify(live) !== JSON.stringify(staticOut)) {
                throw new Error(`S-box/CBC formula mismatch for stage ${round.stageIndex}`);
            }
        }
        const tracedStatic = applySboxCbcStage(round.sampleIn.slice(), { table, key, iv });
        if (JSON.stringify(tracedStatic) !== JSON.stringify(round.sampleOut.map(b => b & 0xff))) {
            console.error(`trace in  ${round.sampleIn.slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join(" ")}`);
            console.error(`trace out ${round.sampleOut.slice(0, 12).map(b => (b & 0xff).toString(16).padStart(2, "0")).join(" ")}`);
            console.error(`static    ${tracedStatic.slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join(" ")}`);
            throw new Error(`S-box/CBC traced round mismatch for stage ${round.stageIndex}`);
        }

        return { table, key, iv };
    });
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
    for (let i = 0; i < RC4_KEYS.length; i++) {
${loopBody}
    }
    return b64UrlEncode(data);
}
`;
}

function buildSboxCbcSource(stages: SboxCbcStage[]): string {
    const compactStages = stages.map(stage => ({
        tableB64: b64Encode(stage.table),
        keyB64: b64Encode(stage.key),
        iv: stage.iv,
    }));

    return `/* Generated by experiment/BuildComixFastSigner.ts.
 * Bundle ID: ${RUNTIME.bundleId}
 * Algorithm: sbox-cbc
 * Pipeline order: sbox-cbc
 * This is the de-VM'd Comix request signer.
 */

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SBOX_CBC_STAGES = ${JSON.stringify(compactStages, null, 4)};

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

function bytesFromString(s: string): number[] {
    const out: number[] = new Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

function normalizeSignPath(rawPath: string): string {
    return rawPath
        .replace(/^https?:\\/\\/[^/]+/, "")
        .replace(/^\\/api\\/v1/, "")
        .split("?")[0]!;
}

function applySboxCbcStage(data: number[], stage: { tableB64: string; keyB64: string; iv: number }): number[] {
    const table = b64Decode(stage.tableB64);
    const key = b64Decode(stage.keyB64);
    const out: number[] = new Array(data.length);
    let prev = stage.iv & 0xff;
    for (let i = 0; i < data.length; i++) {
        const idx = ((data[i] & 0xff) ^ key[i % key.length] ^ prev) & 0xff;
        const next = table[idx] & 0xff;
        out[i] = next;
        prev = next;
    }
    return out;
}

export function fastGenerateHash(rawPath: string): string {
    const path = normalizeSignPath(rawPath);
    let data = bytesFromString(path);
    for (const stage of SBOX_CBC_STAGES) data = applySboxCbcStage(data, stage);
    return b64UrlEncode(data);
}
`;
}

async function main(): Promise<void> {
    installDomStub(RUNTIME.cfg);

    const file = join(tmpdir(), `secure-fast-signer-${RUNTIME.bundleId}.mjs`);
    writeFileSync(file, SECURE_PATCHED_TEXT);
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport(pathToFileURL(file).href);
    restoreNodeTimers();

    const { name: nsName, ns } = findVmNamespace();
    console.log(`VM namespace: ${nsName}`);

    const liveToken = ns[SIGNER_PROP](TEST_PATH) as string;
    let sboxMethod: Function | null = null;
    let sboxThisArg: any = undefined;
    try {
        if (typeof ns.Ai?.T === "function") {
            sboxMethod = ns.Ai.T;
            sboxThisArg = ns.Ai;
        }
    } catch {}
    if (!sboxMethod) sboxMethod = findSboxCbcMethod(ns, TEST_PATH, liveToken);
    if (sboxMethod) {
        const rounds = captureSboxCbcRounds(sboxMethod, TEST_PATH, sboxThisArg);
        if (rounds.length >= 1) {
            console.log(`Detected signer algorithm: sbox-cbc (${rounds.length} rounds)`);
            const stages = buildSboxCbcStages(rounds);

            const checks = (RUNTIME.signChecks ?? [{ signPath: TEST_PATH, liveToken }]).map((check: any) => {
                const staticToken = computeSboxCbcHash(check.signPath, stages);
                return { path: check.signPath, liveToken: check.liveToken, staticToken, ok: staticToken === check.liveToken };
            });
            for (const check of checks) {
                console.log(`  ${check.ok ? "OK " : "BAD"} ${check.path}: ${check.staticToken}`);
            }
            if (!checks.every((check: any) => check.ok)) {
                throw new Error("S-box/CBC signer failed live-token validation");
            }

            writeFileSync(OUT_FILE, buildSboxCbcSource(stages));
            console.log(`wrote ${OUT_FILE}`);
            return;
        }
    }

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
    ns[SIGNER_PROP](TEST_PATH);
    for (const [k, fn] of originals) locals[k] = fn;

    const orderedStageKeys = [...new Set(stageCallLog)];
    const orderedRc4Keys = [...new Set(rc4CallLog)];
    if (orderedStageKeys.length === 0) throw new Error("No insert stages observed in call trace");
    if (orderedRc4Keys.length === 0) throw new Error("No RC4 keys observed in call trace");
    if (orderedStageKeys.length !== orderedRc4Keys.length) {
        throw new Error(`Stage/key count mismatch: ${orderedStageKeys.length} insert stages vs ${orderedRc4Keys.length} RC4 keys`);
    }
    console.log(`Rounds: ${orderedRc4Keys.length}`);

    const insertStages = orderedStageKeys.map(key => {
        const { fn, prefix } = insertStageCandidates.get(key)!;
        return buildInsertTable(fn as (data: number[]) => number[], prefix);
    });
    const rc4KeysB64 = orderedRc4Keys.map(key => {
        const fn = rc4KeyCandidates.get(key)! as () => string;
        return Buffer.from(binaryStringToBytes(fn())).toString("base64");
    });

    // Self-validate: try both pipeline orders against the live VM
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
