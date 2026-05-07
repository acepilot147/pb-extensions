/**
 * Generates the `_=` query-parameter token required by the comix.to /api/v1.
 *
 * The token is produced by URL-encoding the path, then running the result
 * through 5 rounds of RC4 + byte-mutation, and finally outputting base64url
 * (URL-safe alphabet, no padding).
 *
 * IMPORTANT – path convention:
 *   Pass the path **relative to /api/v1** (i.e. without the leading "/api/v1").
 *   Example: "/manga/ll172/chapters", NOT "/api/v1/manga/ll172/chapters".
 *   Verification: generateHash("/manga/ll172/chapters") must equal
 *   "xQm9tJfLwGhz_0Eq8S_YAHYkwp-q1PLfm50W5QJnyd1NnNYpAjXjyCoAzoOL-EXkCToxWS0NeDGz_rNrbg"
 */

// Pure-JS base64 helpers — no Buffer, no atob/btoa (neither exist in Paperback's JSC)
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64Decode(s: string): number[] {
    const lookup: number[] = new Array(128).fill(-1);
    for (let i = 0; i < 64; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
    const out: number[] = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 61 /* = */) break;        // padding
        const v = lookup[c] ?? -1;
        if (v === -1) continue;             // skip whitespace/newlines
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xFF); }
    }
    return out;
}

function b64UrlEncode(bytes: number[]): string {
    let out = "", i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64_CHARS[(n >> 18) & 63];
        out += B64_CHARS[(n >> 12) & 63];
        out += B64_CHARS[(n >> 6)  & 63];
        out += B64_CHARS[ n        & 63];
    }
    if (i + 1 === bytes.length) {
        const n = bytes[i] << 16;
        out += B64_CHARS[(n >> 18) & 63];
        out += B64_CHARS[(n >> 12) & 63];
    } else if (i + 2 === bytes.length) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += B64_CHARS[(n >> 18) & 63];
        out += B64_CHARS[(n >> 12) & 63];
        out += B64_CHARS[(n >> 6)  & 63];
    }
    // URL-safe: + → -, / → _,  no padding
    return out.replace(/\+/g, "-").replace(/\//g, "_");
}

// [RC4 key, mutKey, prefKey] × 5 rounds
const KEYS: string[] = [
    "13YDu67uDgFczo3DnuTIURqas4lfMEPADY6Jaeqky+w=", // 0  RC4 key  round 1
    "yEy7wBfBc+gsYPiQL/4Dfd0pIBZFzMwrtlRQGwMXy3Q=", // 1  mutKey   round 1
    "yrP+EVA1Dw==",                                   // 2  prefKey  round 1
    "vZ23RT7pbSlxwiygkHd1dhToIku8SNHPC6V36L4cnwM=",  // 3  RC4 key  round 2
    "QX0sLahOByWLcWGnv6l98vQudWqdRI3DOXBdit9bxCE=",  // 4  mutKey   round 2
    "WJwgqCmf",                                        // 5  prefKey  round 2
    "BkWI8feqSlDZKMq6awfzWlUypl88nz65KVRmpH0RWIc=",  // 6  RC4 key  round 3
    "v7EIpiQQjd2BGuJzMbBA0qPWDSS+wTJRQ7uGzZ6rJKs=",  // 7  mutKey   round 3
    "1SUReYlCRA==",                                    // 8  prefKey  round 3
    "RougjiFHkSKs20DZ6BWXiWwQUGZXtseZIyQWKz5eG34=",  // 9  RC4 key  round 4
    "LL97cwoDoG5cw8QmhI+KSWzfW+8VehIh+inTxnVJ2ps=",  // 10 mutKey   round 4
    "52iDqjzlqe8=",                                    // 11 prefKey  round 4
    "U9LRYFL2zXU4TtALIYDj+lCATRk/EJtH7/y7qYYNlh8=",  // 12 RC4 key  round 5
    "e/GtffFDTvnw7LBRixAD+iGixjqTq9kIZ1m0Hj+s6fY=",  // 13 mutKey   round 5
    "xb2XwHNB",                                        // 14 prefKey  round 5
];

function getKeyBytes(index: number): number[] {
    const b64 = KEYS[index];
    if (b64 === undefined) return [];
    try {
        return b64Decode(b64);
    } catch {
        return [];
    }
}

function rc4(key: number[], data: number[]): number[] {
    if (key.length === 0) return [...data];
    const s: number[] = new Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i] + key[i % key.length]) % 256;
        const tmp = s[i]; s[i] = s[j]; s[j] = tmp;
    }
    let i2 = 0, j2 = 0;
    const out: number[] = new Array(data.length);
    for (let k = 0; k < data.length; k++) {
        i2 = (i2 + 1) % 256;
        j2 = (j2 + s[i2]) % 256;
        const tmp = s[i2]; s[i2] = s[j2]; s[j2] = tmp;
        out[k] = data[k] ^ s[(s[i2] + s[j2]) % 256];
    }
    return out;
}

// Byte mutation functions — all inputs and outputs are 0–255
function mutS(e: number): number { return (e + 143) % 256; }
function mutL(e: number): number { return ((e >>> 1) | (e << 7)) & 255; }
function mutC(e: number): number { return (e + 115) % 256; }
function mutM(e: number): number { return (e ^ 177) & 255; }
function mutF(e: number): number { return (e - 188 + 256) % 256; }
function mutG(e: number): number { return ((e << 2) | (e >>> 6)) & 255; }
function mutH(e: number): number { return (e - 42 + 256) % 256; }
function mutDollar(e: number): number { return ((e << 4) | (e >>> 4)) & 255; }
function mutB(e: number): number { return (e - 12 + 256) % 256; }
function mutUnderscore(e: number): number { return (e - 20 + 256) % 256; }
function mutY(e: number): number { return ((e >>> 1) | (e << 7)) & 255; }
function mutK(e: number): number { return (e - 241 + 256) % 256; }

function getMutKey(mk: number[], idx: number): number {
    return mk.length > 0 && (idx % 32) < mk.length ? mk[idx % 32] : 0;
}

function round1(data: number[]): number[] {
    const enc = rc4(getKeyBytes(0), data);
    const mutKey = getKeyBytes(1);
    const prefKey = getKeyBytes(2);
    const out: number[] = [];
    for (let i = 0; i < enc.length; i++) {
        if (i < 7 && i < prefKey.length) out.push(prefKey[i]);
        let v = enc[i] ^ getMutKey(mutKey, i);
        switch (i % 10) {
            case 0: case 9: v = mutC(v); break;
            case 1: v = mutB(v); break;
            case 2: v = mutY(v); break;
            case 3: v = mutDollar(v); break;
            case 4: case 6: v = mutH(v); break;
            case 5: v = mutS(v); break;
            case 7: v = mutK(v); break;
            case 8: v = mutL(v); break;
        }
        out.push(v & 255);
    }
    return out;
}

function round2(data: number[]): number[] {
    const enc = rc4(getKeyBytes(3), data);
    const mutKey = getKeyBytes(4);
    const prefKey = getKeyBytes(5);
    const out: number[] = [];
    for (let i = 0; i < enc.length; i++) {
        if (i < 6 && i < prefKey.length) out.push(prefKey[i]);
        let v = enc[i] ^ getMutKey(mutKey, i);
        switch (i % 10) {
            case 0: case 8: v = mutC(v); break;
            case 1: v = mutB(v); break;
            case 2: case 6: v = mutDollar(v); break;
            case 3: v = mutH(v); break;
            case 4: case 9: v = mutS(v); break;
            case 5: v = mutK(v); break;
            case 7: v = mutUnderscore(v); break;
        }
        out.push(v & 255);
    }
    return out;
}

function round3(data: number[]): number[] {
    const enc = rc4(getKeyBytes(6), data);
    const mutKey = getKeyBytes(7);
    const prefKey = getKeyBytes(8);
    const out: number[] = [];
    for (let i = 0; i < enc.length; i++) {
        if (i < 7 && i < prefKey.length) out.push(prefKey[i]);
        let v = enc[i] ^ getMutKey(mutKey, i);
        switch (i % 10) {
            case 0: v = mutC(v); break;
            case 1: v = mutF(v); break;
            case 2: case 8: v = mutS(v); break;
            case 3: v = mutG(v); break;
            case 4: v = mutY(v); break;
            case 5: v = mutM(v); break;
            case 6: v = mutDollar(v); break;
            case 7: v = mutK(v); break;
            case 9: v = mutB(v); break;
        }
        out.push(v & 255);
    }
    return out;
}

function round4(data: number[]): number[] {
    const enc = rc4(getKeyBytes(9), data);
    const mutKey = getKeyBytes(10);
    const prefKey = getKeyBytes(11);
    const out: number[] = [];
    for (let i = 0; i < enc.length; i++) {
        if (i < 8 && i < prefKey.length) out.push(prefKey[i]);
        let v = enc[i] ^ getMutKey(mutKey, i);
        switch (i % 10) {
            case 0: v = mutB(v); break;
            case 1: case 9: v = mutM(v); break;
            case 2: case 7: v = mutL(v); break;
            case 3: case 5: v = mutS(v); break;
            case 4: case 6: v = mutUnderscore(v); break;
            case 8: v = mutY(v); break;
        }
        out.push(v & 255);
    }
    return out;
}

function round5(data: number[]): number[] {
    const enc = rc4(getKeyBytes(12), data);
    const mutKey = getKeyBytes(13);
    const prefKey = getKeyBytes(14);
    const out: number[] = [];
    for (let i = 0; i < enc.length; i++) {
        if (i < 6 && i < prefKey.length) out.push(prefKey[i]);
        let v = enc[i] ^ getMutKey(mutKey, i);
        switch (i % 10) {
            case 0: v = mutUnderscore(v); break;
            case 1: case 7: v = mutS(v); break;
            case 2: v = mutC(v); break;
            case 3: case 5: v = mutM(v); break;
            case 4: v = mutB(v); break;
            case 6: v = mutF(v); break;
            case 8: v = mutDollar(v); break;
            case 9: v = mutG(v); break;
        }
        out.push(v & 255);
    }
    return out;
}

/**
 * Generate the comix.to /api/v1 `_=` token.
 *
 * @param path API path **relative to `/api/v1`** — e.g. "/manga/ll172/chapters"
 */
export function generateHash(path: string): string {
    const encoded = encodeURIComponent(path)
        .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

    let data: number[] = [];
    for (let i = 0; i < encoded.length; i++) {
        data.push(encoded.charCodeAt(i) & 0xFF);
    }

    data = round1(data);
    data = round2(data);
    data = round3(data);
    data = round4(data);
    data = round5(data);

    return b64UrlEncode(data);
}

/**
 * Append `_=<token>` to a comix.to /api/v1 URL.
 * Strips the `https://comix.to/api/v1` prefix to derive the path passed to generateHash.
 */
export function signUrl(url: string): string {
    const path = url.replace("https://comix.to/api/v1", "").split("?")[0];
    const token = generateHash(path);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_=${token}`;
}
