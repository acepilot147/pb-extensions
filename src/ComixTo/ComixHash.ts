/**
 * Generates the `_=` query-parameter token required by comix.to /api/v1 for
 * the small set of "signed" endpoints (chapter list, chapter-indexes, single
 * chapter). All other endpoints are unsigned.
 *
 * --- How this file got here -----------------------------------------------
 *
 * Previously comix.to served a 5-round RC4 + mutation algorithm in plain JS.
 * In Apr-May 2026 they rotated keys, slightly restructured the round shape
 * (mut+prefix+xor first, then RC4, vs the old combined per-round form), and
 * tightened the signed-paths set to three patterns. They also briefly served
 * a 351 KB VM-obfuscated build; the live "dev" build that's been
 * stable since is plain JS again (~28 KB).
 *
 * To recover the new keys we ran the live `secure-*.js` headlessly in Node
 * (`experiment/relay/Server.ts`). One catch: the bundle has an anti-tamper
 * check `ce()` that requires `document.querySelector.toString()` to match a
 * native-function regex; if it fails, every mut-key-loading function silently
 * corrupts its bytes and produces a useless token. Defeated by overriding
 * `querySelector.toString` to return `"function querySelector() { [native code] }"`.
 * With that, the relay produced byte-exact browser tokens, which let us read
 * out the 15 base64 constants below from the bundle source.
 *
 * Cross-checked against the Tachiyomi
 * Kotlin port — independent reverse-engineering arrived at the identical
 * 15 keys, identical round structure (mut → rc4 per round), and identical
 * mutation case tables. As solid as this kind of thing gets.
 *
 * --- Refresh procedure when comix.to rotates ------------------------------
 *
 *   1. `npx tsx --env-file=.env experiment/relay/Server.ts`  (relay scrapes
 *      the live homepage, fetches the live secure-*.js, imports it under
 *      a DOM stub, exposes /sign).
 *   2. Pretty-print the captured bundle (path printed in relay logs).
 *   3. Find `Si = { ..., I: ki[2], ... }` then `ki[2]` — its 10-stage chain
 *      gives you the 5 mut-rounds + 5 RC4 keys in order.
 *   4. Update KEYS[] below (5 RC4 / 5 mutKey / 5 prefKey).
 *   5. `npx tsx --env-file=.env experiment/ValidateComixHash.ts` — must pass
 *      both static fixtures and live cross-check vs the relay.
 *
 * TODO: when comix.to next rotates and breaks production tokens, plumb a
 *   relay fallback into `signUrl`: detect Invalid-token 403 once at runtime,
 *   then route subsequent signing through a deployed relay (`/sign?path=...`)
 *   until the next extension update lands. See TODO.md.
 */

// Pure-JS base64 helpers — neither Buffer, atob, nor btoa exist in Paperback's JSC.
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64Decode(s: string): number[] {
    const lookup: number[] = new Array(128).fill(-1);
    for (let i = 0; i < 64; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
    const out: number[] = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 61 /* = */) break;
        const v = lookup[c] ?? -1;
        if (v === -1) continue;
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
    return out.replace(/\+/g, "-").replace(/\//g, "_");
}

// [RC4 key, mutKey, prefKey] × 5 rounds — extracted from the live secure-*.js
// bundle. To refresh after a key rotation: see the Refresh procedure above.
const KEYS: string[] = [
    "JxTcdyiA5GZxnbrmthXBQfU2IMTKcY1+3nNhbq98Sgo=", // 0  RC4 key  round 1
    "3PordjODbhqla382Cxapmo/1JiABJQcjiJj1+48gTJ4=", // 1  mutKey   round 1
    "OaKvnI5ARA==",                                  // 2  prefKey  round 1
    "MHNBHYWA7lvy867fXgvGcJwWDk79KqUJUVFsh3RwnnI=", // 3  RC4 key  round 2
    "8i0Cru/VJBSVB2Y1GcMDVpzx2WepOcfnWdd81yxICl4=", // 4  mutKey   round 2
    "Fyskubz8VvA=",                                  // 5  prefKey  round 2
    "B46L1x+UeWP+19cRpQ+OZvdLAK9EHID8g3mSgn57tew=", // 6  RC4 key  round 3
    "DTSTmUt6LpDUw9r1lSQqyb3YlFTzruT8tk8wUGkwehQ=", // 7  mutKey   round 3
    "vY/meeI=",                                      // 8  prefKey  round 3
    "7xWfIF5THL5LAnRgAARg+4mjWHPU9n3PQwvzbaMNi+Q=", // 9  RC4 key  round 4
    "bewtiTuV+HJk56xxkf2iCljLgruCpBmN9BgE8i6gc9M=", // 10 mutKey   round 4
    "/Xcb2zAu8AU=",                                  // 11 prefKey  round 4
    "WgeCQ3T8R51uTwVSiVa7Zy0dN6JOg6Z5JleMS+HV8Aw=", // 12 RC4 key  round 5
    "yXayUVFrrcW56jQCEfZzuCidjpnWKjTDUNT7XeX9i7k=", // 13 mutKey   round 5
    "tSLco2w=",                                      // 14 prefKey  round 5
];

function getKeyBytes(index: number): number[] {
    const b64 = KEYS[index];
    if (b64 === undefined) return [];
    try { return b64Decode(b64); }
    catch { return []; }
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

// Byte mutation primitives — all input/output ∈ [0,255]. Only the rotations
// used by the current 5 rounds are kept; the bundle also defines rotR1/rotL2
// but they don't appear in the round tables.
const rotL1   = (e: number) => 0xff & ((e << 1) | (e >>> 7));   // bundle: v, Q
const rotR2   = (e: number) => 0xff & ((e >>> 2) | (e << 6));   // bundle: ee
const nibSwap = (e: number) => 0xff & ((e << 4) | (e >>> 4));   // bundle: h, L, $, Y

function getMutKey(mk: number[], idx: number): number {
    return mk.length > 0 && (idx % 32) < mk.length ? mk[idx % 32] : 0;
}

// Apply per-byte: optionally splice prefKey, then xor mutKey, then mutate.
// `round` selects the per-byte mutation table (1..5).
function mutate(data: number[], mutKey: number[], prefKey: number[], prefLimit: number, round: number): number[] {
    const out: number[] = [];
    for (let o = 0; o < data.length; o++) {
        if (o < prefLimit && o < prefKey.length) out.push(prefKey[o]);
        let n = data[o] ^ getMutKey(mutKey, o);
        switch (round) {
            case 1:
                switch (o % 10) {
                    case 0: n = rotL1(n); break;
                    case 1: n = 37 ^ n; break;
                    case 2: n = 81 ^ n; break;
                    case 3: n = 147 ^ n; break;
                    case 4: n = rotR2(n); break;
                    case 5: case 8: n = nibSwap(n); break;
                    case 6: n = 218 ^ n; break;
                    case 7: n = (n + 159) % 256; break;
                    case 9: n = 180 ^ n; break;
                }
                break;
            case 2:
                switch (o % 10) {
                    case 0: case 9: n = 180 ^ n; break;
                    case 1: n = rotL1(n); break;
                    case 2: n = 147 ^ n; break;
                    case 3: n = rotL1(n); break;
                    case 4: n = rotR2(n); break;
                    case 5: n = nibSwap(n); break;
                    case 6: case 8: n = (n + 159) % 256; break;
                    case 7: n = (n + 34) % 256; break;
                }
                break;
            case 3:
                switch (o % 10) {
                    case 0: n = 81 ^ n; break;
                    case 1: n = nibSwap(n); break;
                    case 2: case 9: n = nibSwap(n); break;
                    case 3: n = 37 ^ n; break;
                    case 4: n = (n + 159) % 256; break;
                    case 5: n = rotL1(n); break;
                    case 6: n = 180 ^ n; break;
                    case 7: n = (n + 34) % 256; break;
                    case 8: n = rotR2(n); break;
                }
                break;
            case 4:
                switch (o % 10) {
                    case 0: case 7: n = 218 ^ n; break;
                    case 1: case 4: n = rotL1(n); break;
                    case 2: n = rotL1(n); break;
                    case 3: n = (n + 159) % 256; break;
                    case 5: case 8: n = 180 ^ n; break;
                    case 6: n = 147 ^ n; break;
                    case 9: n = 37 ^ n; break;
                }
                break;
            case 5:
                switch (o % 10) {
                    case 0: n = nibSwap(n); break;
                    case 1: case 3: n = 147 ^ n; break;
                    case 2: n = (n + 34) % 256; break;
                    case 4: case 9: n = 218 ^ n; break;
                    case 5: case 7: n = rotL1(n); break;
                    case 6: n = 180 ^ n; break;
                    case 8: n = rotR2(n); break;
                }
                break;
        }
        out.push(n & 0xff);
    }
    return out;
}

// Each round: mutate first, then RC4. Note this is the reverse of the
// pre-2026 algorithm, which did RC4 first and combined the mutation with the
// prefix-splicing in one pass.
function round1(d: number[]): number[] { return rc4(getKeyBytes(0),  mutate(d, getKeyBytes(1),  getKeyBytes(2),  7, 1)); }
function round2(d: number[]): number[] { return rc4(getKeyBytes(3),  mutate(d, getKeyBytes(4),  getKeyBytes(5),  8, 2)); }
function round3(d: number[]): number[] { return rc4(getKeyBytes(6),  mutate(d, getKeyBytes(7),  getKeyBytes(8),  5, 3)); }
function round4(d: number[]): number[] { return rc4(getKeyBytes(9),  mutate(d, getKeyBytes(10), getKeyBytes(11), 8, 4)); }
function round5(d: number[]): number[] { return rc4(getKeyBytes(12), mutate(d, getKeyBytes(13), getKeyBytes(14), 5, 5)); }

/**
 * Generate the comix.to /api/v1 `_=` token for a path.
 *
 * @param rawPath API path; protocol+host, query string, and `/api/v1` prefix
 *                are all stripped before signing (matches the bundle's own
 *                preprocessing in `Pi(url)`).
 */
export function generateHash(rawPath: string): string {
    const path = rawPath
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0]!
        .replace(/^\/api\/v1/, "");

    const encoded = encodeURIComponent(path);
    let bytes: number[] = new Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i) & 0xFF;

    bytes = round1(bytes);
    bytes = round2(bytes);
    bytes = round3(bytes);
    bytes = round4(bytes);
    bytes = round5(bytes);

    return b64UrlEncode(bytes);
}

// Paths the live bundle actually signs (zi[] in the bundle source). Anything
// outside this set must be sent unsigned — server-side these endpoints reject
// unknown query params.
const SIGNED_PATTERNS: RegExp[] = [
    /^\/manga\/[^/]+\/chapters\b/,
    /^\/manga\/[^/]+\/chapter-indexes\b/,
    /^\/chapters\/[^/]+(?:\?|$)/,
];

/**
 * Append `_=<token>` to a comix.to /api/v1 URL — only if the path is one
 * the site actually signs. Other URLs are returned unchanged.
 */
export function signUrl(url: string): string {
    const path = url.replace("https://comix.to/api/v1", "").split("?")[0]!;
    if (!SIGNED_PATTERNS.some(re => re.test(path))) return url;
    const token = generateHash(path);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_=${token}`;
}
