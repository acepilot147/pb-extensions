export {};

/**
 * Compare the pasted old source.js crypto against the current generated fast
 * runtime. This intentionally keeps the old fixed-round implementation local:
 * it is a candidate/proof harness, not production code.
 *
 * Run:
 *   node -r ts-node/register/transpile-only experiment/TestComixCryptoCandidates.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fastDecryptComixPayload } from "../src/ComixTo/ComixFastDecrypt";
import { fastGenerateHash } from "../src/ComixTo/ComixFastSigner";

type LegacyOrder = "legacy-mut-then-rc4" | "swapped-rc4-then-mut";

interface RuntimeJson {
    bundleId?: string;
    signChecks?: Array<{
        signPath: string;
        liveToken: string;
    }>;
}

interface Fixture {
    path: string;
    headers?: Record<string, string>;
    encryptedPayload: any;
    decrypted: any;
}

const RUNTIME_PATH = resolve(process.cwd(), "experiment", "extracted", "comix-runtime-latest", "runtime.json");
const FIXTURES_PATH = resolve(process.cwd(), "experiment", "extracted", "comix-runtime-latest", "fixtures.json");

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// From the pasted broken source.js. These belong to an older Comix bundle and
// are expected to fail against the current fixtures.
const OLD_COMIX_HASH_KEYS = [
    "22D604qPJ3iZyib4WaXX4bhRjo4eLGzPS8NI/5kBg5o=",
    "1sp9w8c67MpO",
    "Q9TdwuMw/MxVqi3O5uAg5xRarTM3LqwWMYOMGE/+1CA=",
    "AXESAx7UvxKF55ykpvLcnvj2T7+nlXxWhq0XXJrzXJY=",
    "qLHSPpfPyw==",
    "+QKAlsdnzXGBRSCDX8DHsF0YFZMWRzrDmY0GpLYJJKY=",
    "njh2h71NUbtQaemzhwD0bCgKFyQc928JMEES3DzVPRA=",
    "FdvbFojh",
    "nKvB9ym8/F1C9wFG78p8DQJ6LyzrQ//hQTs5MpOJr5I=",
    "jxi8Q+dayEjqxPL51wfhKjE6QDwcsoueGNu0ijoNw64=",
    "+UTnB4G+MtwH",
    "QMSq6NACRC5GKB5OiU5fHJjQ9KTTDezj9d0cthqNiRs=",
    "X46a7RgXUAAEwht+w1UAiuH2OmPGdjabVUTIZoa3iaY=",
    "iOAFX0i0iA==",
    "mmlfRKf+YlUdIQzFKeWLP/Xt6xTAPZZQaR3AHp+5vdY=",
];

function loadJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

function stable(value: any): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function short(value: string, max = 72): string {
    return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function b64Decode(value: string): number[] {
    const lookup: number[] = [];
    const output: number[] = [];
    let buffer = 0;
    let bits = 0;

    for (let i = 0; i < 64; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");

    for (let i = 0; i < normalized.length; i++) {
        const code = normalized.charCodeAt(i);
        if (code === 61) break;
        const charValue = lookup[code];
        if (charValue === undefined) continue;
        buffer = (buffer << 6) | charValue;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            output.push((buffer >> bits) & 255);
        }
    }

    return output;
}

function b64UrlEncode(bytes: number[]): string {
    let output = "";
    let i = 0;
    let n = 0;

    for (; i + 2 < bytes.length; i += 3) {
        n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
        output += B64_CHARS[(n >> 18) & 63];
        output += B64_CHARS[(n >> 12) & 63];
        output += B64_CHARS[(n >> 6) & 63];
        output += B64_CHARS[n & 63];
    }

    if (i + 1 === bytes.length) {
        n = bytes[i]! << 16;
        output += B64_CHARS[(n >> 18) & 63];
        output += B64_CHARS[(n >> 12) & 63];
    } else if (i + 2 === bytes.length) {
        n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
        output += B64_CHARS[(n >> 18) & 63];
        output += B64_CHARS[(n >> 12) & 63];
        output += B64_CHARS[(n >> 6) & 63];
    }

    return output.replace(/\+/g, "-").replace(/\//g, "_");
}

function bytesToString(bytes: number[]): string {
    let output = "";
    for (let index = 0; index < bytes.length; index += 4096) {
        output += String.fromCharCode.apply(null, bytes.slice(index, index + 4096));
    }
    return output;
}

function getOldKeyBytes(index: number): number[] {
    return b64Decode(OLD_COMIX_HASH_KEYS[index] || "");
}

function rc4(key: number[], data: number[]): number[] {
    const s: number[] = [];
    const output: number[] = [];
    let j = 0;
    let i2 = 0;
    let j2 = 0;
    let tmp = 0;

    if (!Array.isArray(key) || key.length === 0) return data.slice();

    for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i]! + key[i % key.length]!) & 255;
        tmp = s[i]!;
        s[i] = s[j]!;
        s[j] = tmp;
    }

    for (let k = 0; k < data.length; k++) {
        i2 = (i2 + 1) & 255;
        j2 = (j2 + s[i2]!) & 255;
        tmp = s[i2]!;
        s[i2] = s[j2]!;
        s[j2] = tmp;
        output[k] = data[k]! ^ s[(s[i2]! + s[j2]!) & 255]!;
    }

    return output;
}

function getMutKey(mutKey: number[], index: number): number {
    return mutKey.length > 0 && index % 32 < mutKey.length ? mutKey[index % 32]! : 0;
}

function rotL(value: number, bits: number): number {
    return ((value << bits) | (value >>> (8 - bits))) & 255;
}

function rotR(value: number, bits: number): number {
    return ((value >>> bits) | (value << (8 - bits))) & 255;
}

function addByte(value: number, amount: number): number {
    return (value + amount) & 255;
}

function subByte(value: number, amount: number): number {
    return (value - amount) & 255;
}

function transformHashByte(value: number, index: number, round: number): number {
    switch (round) {
        case 1:
            switch (index % 10) {
                case 0: return addByte(value, 104);
                case 1:
                case 6: return value ^ 84;
                case 2:
                case 5: return rotL(value, 5);
                case 3: return addByte(value, 110);
                case 4: return rotL(value, 1);
                case 7: return addByte(value, 253);
                case 8: return rotL(value, 6);
                case 9: return value ^ 123;
            }
            break;
        case 2:
            switch (index % 10) {
                case 0:
                case 4: return value ^ 84;
                case 1:
                case 2:
                case 3:
                case 9: return rotL(value, 5);
                case 5: return value ^ 123;
                case 6: return addByte(value, 110);
                case 7: return addByte(value, 165);
                case 8: return rotL(value, 1);
            }
            break;
        case 3:
            switch (index % 10) {
                case 0:
                case 3:
                case 8: return rotL(value, 5);
                case 1:
                case 5: return rotL(value, 1);
                case 2: return addByte(value, 104);
                case 4: return addByte(value, 110);
                case 6: return addByte(value, 247);
                case 7: return rotL(value, 6);
                case 9: return value ^ 123;
            }
            break;
        case 4:
            switch (index % 10) {
                case 0:
                case 2: return value ^ 123;
                case 1:
                case 3:
                case 6: return rotL(value, 1);
                case 4:
                case 9: return rotL(value, 5);
                case 5:
                case 8: return value ^ 84;
                case 7: return addByte(value, 165);
            }
            break;
        case 5:
            switch (index % 10) {
                case 0:
                case 7: return value ^ 123;
                case 1:
                case 4: return addByte(value, 104);
                case 2:
                case 5:
                case 6:
                case 8: return rotL(value, 5);
                case 3: return addByte(value, 247);
                case 9: return rotL(value, 1);
            }
            break;
    }

    return value & 255;
}

function inverseTransformHashByte(value: number, index: number, round: number): number {
    switch (round) {
        case 1:
            switch (index % 10) {
                case 0: return subByte(value, 104);
                case 1:
                case 6: return value ^ 84;
                case 2:
                case 5: return rotR(value, 5);
                case 3: return subByte(value, 110);
                case 4: return rotR(value, 1);
                case 7: return subByte(value, 253);
                case 8: return rotR(value, 6);
                case 9: return value ^ 123;
            }
            break;
        case 2:
            switch (index % 10) {
                case 0:
                case 4: return value ^ 84;
                case 1:
                case 2:
                case 3:
                case 9: return rotR(value, 5);
                case 5: return value ^ 123;
                case 6: return subByte(value, 110);
                case 7: return subByte(value, 165);
                case 8: return rotR(value, 1);
            }
            break;
        case 3:
            switch (index % 10) {
                case 0:
                case 3:
                case 8: return rotR(value, 5);
                case 1:
                case 5: return rotR(value, 1);
                case 2: return subByte(value, 104);
                case 4: return subByte(value, 110);
                case 6: return subByte(value, 247);
                case 7: return rotR(value, 6);
                case 9: return value ^ 123;
            }
            break;
        case 4:
            switch (index % 10) {
                case 0:
                case 2: return value ^ 123;
                case 1:
                case 3:
                case 6: return rotR(value, 1);
                case 4:
                case 9: return rotR(value, 5);
                case 5:
                case 8: return value ^ 84;
                case 7: return subByte(value, 165);
            }
            break;
        case 5:
            switch (index % 10) {
                case 0:
                case 7: return value ^ 123;
                case 1:
                case 4: return subByte(value, 104);
                case 2:
                case 5:
                case 6:
                case 8: return rotR(value, 5);
                case 3: return subByte(value, 247);
                case 9: return rotR(value, 1);
            }
            break;
    }

    return value & 255;
}

function mutateHashBytes(data: number[], mutKey: number[], prefKey: number[], round: number): number[] {
    const output: number[] = [];

    for (let i = 0; i < data.length; i++) {
        if (i < prefKey.length) output.push(prefKey[i]!);
        const value = data[i]! ^ getMutKey(mutKey, i);
        output.push(transformHashByte(value, i, round));
    }

    return output;
}

function reverseMutateHashBytes(data: number[], mutKey: number[], prefKey: number[], round: number): number[] {
    const output: number[] = [];
    let dataIndex = 0;
    let outputIndex = 0;

    while (dataIndex < data.length) {
        if (outputIndex < prefKey.length) {
            if (data[dataIndex] !== prefKey[outputIndex]) throw new Error("Invalid encrypted payload prefix");
            dataIndex++;
        }

        if (dataIndex >= data.length) break;
        const value = inverseTransformHashByte(data[dataIndex]!, outputIndex, round);
        output.push((value ^ getMutKey(mutKey, outputIndex)) & 255);
        dataIndex++;
        outputIndex++;
    }

    return output;
}

function normalizeComixHashPath(path: string): string {
    return String(path || "")
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0]!
        .replace(/^\/api\/v1(?=\/|$)/, "");
}

function applyOldRound(data: number[], round: number, order: LegacyOrder): number[] {
    const offset = (round - 1) * 3;
    const mutKey = getOldKeyBytes(offset);
    const prefKey = getOldKeyBytes(offset + 1);
    const rc4Key = getOldKeyBytes(offset + 2);

    if (order === "legacy-mut-then-rc4") {
        return rc4(rc4Key, mutateHashBytes(data, mutKey, prefKey, round));
    }

    return mutateHashBytes(rc4(rc4Key, data), mutKey, prefKey, round);
}

function reverseOldRound(data: number[], round: number, order: LegacyOrder): number[] {
    const offset = (round - 1) * 3;
    const mutKey = getOldKeyBytes(offset);
    const prefKey = getOldKeyBytes(offset + 1);
    const rc4Key = getOldKeyBytes(offset + 2);

    if (order === "legacy-mut-then-rc4") {
        return reverseMutateHashBytes(rc4(rc4Key, data), mutKey, prefKey, round);
    }

    return rc4(rc4Key, reverseMutateHashBytes(data, mutKey, prefKey, round));
}

function oldGenerateComixHash(path: string, order: LegacyOrder): string {
    const normalizedPath = normalizeComixHashPath(path);
    const encoded = encodeURIComponent(normalizedPath).replace(/[!'()*]/g, char => {
        return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
    });
    let data: number[] = [];

    for (let i = 0; i < encoded.length; i++) data.push(encoded.charCodeAt(i) & 255);
    for (let round = 1; round <= 5; round++) data = applyOldRound(data, round, order);

    return b64UrlEncode(data);
}

function oldDecryptComixEnvelope(payload: any, order: LegacyOrder): any {
    if (!(payload && typeof payload === "object" && typeof payload.e === "string")) return payload;
    let data = b64Decode(payload.e);

    for (let round = 5; round >= 1; round--) data = reverseOldRound(data, round, order);

    const decoded = decodeURIComponent(bytesToString(data));
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" && parsed.status === "ok" ? parsed.result : parsed;
}

function signReport(runtime: RuntimeJson): { currentFail: number; oldUnexpectedPass: number } {
    let currentFail = 0;
    let oldUnexpectedPass = 0;
    const checks = runtime.signChecks ?? [];
    const orders: LegacyOrder[] = ["legacy-mut-then-rc4", "swapped-rc4-then-mut"];

    console.log(`bundle: ${runtime.bundleId ?? "unknown"}`);
    console.log("");
    console.log("sign candidates:");

    for (const check of checks) {
        const current = fastGenerateHash(check.signPath);
        const currentOk = current === check.liveToken;
        if (!currentOk) currentFail++;
        console.log(`  ${currentOk ? "PASS" : "FAIL"} current-fast ${check.signPath}`);
        if (!currentOk) {
            console.log(`    live: ${short(check.liveToken)}`);
            console.log(`    got : ${short(current)}`);
        }

        for (const order of orders) {
            const token = oldGenerateComixHash(check.signPath, order);
            const ok = token === check.liveToken;
            if (ok) oldUnexpectedPass++;
            console.log(`  ${ok ? "PASS" : "FAIL"} ${order} ${check.signPath}`);
            if (!ok) console.log(`    got : ${short(token)}`);
        }
    }

    return { currentFail, oldUnexpectedPass };
}

function decryptReport(fixtures: Fixture[]): { currentFail: number; oldUnexpectedPass: number } {
    let currentFail = 0;
    let oldUnexpectedPass = 0;
    const orders: LegacyOrder[] = ["legacy-mut-then-rc4", "swapped-rc4-then-mut"];

    console.log("");
    console.log("decrypt candidates:");

    for (const fixture of fixtures) {
        try {
            const current = fastDecryptComixPayload(fixture.path, fixture.encryptedPayload, fixture.headers ?? {});
            const ok = stable(current) === stable(fixture.decrypted);
            if (!ok) currentFail++;
            console.log(`  ${ok ? "PASS" : "FAIL"} current-fast ${fixture.path}`);
        } catch (e: any) {
            currentFail++;
            console.log(`  FAIL current-fast ${fixture.path}`);
            console.log(`    threw: ${e?.message ?? String(e)}`);
        }

        for (const order of orders) {
            try {
                const got = oldDecryptComixEnvelope(fixture.encryptedPayload, order);
                const ok = stable(got) === stable(fixture.decrypted);
                if (ok) oldUnexpectedPass++;
                console.log(`  ${ok ? "PASS" : "FAIL"} ${order} ${fixture.path}`);
            } catch (e: any) {
                console.log(`  FAIL ${order} ${fixture.path}`);
                console.log(`    threw: ${e?.message ?? String(e)}`);
            }
        }
    }

    return { currentFail, oldUnexpectedPass };
}

function main(): void {
    const runtime = loadJson<RuntimeJson>(RUNTIME_PATH);
    const fixtures = loadJson<Fixture[]>(FIXTURES_PATH);
    const sign = signReport(runtime);
    const decrypt = decryptReport(fixtures);
    const currentFail = sign.currentFail + decrypt.currentFail;
    const oldUnexpectedPass = sign.oldUnexpectedPass + decrypt.oldUnexpectedPass;

    console.log("");
    console.log(`summary: current-fast failures=${currentFail}, old-candidate unexpected passes=${oldUnexpectedPass}`);

    if (currentFail > 0 || oldUnexpectedPass > 0) {
        process.exit(1);
    }
}

main();
