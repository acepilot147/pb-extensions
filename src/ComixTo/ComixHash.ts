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
 * To recover the current signer/decrypt path we run the live `secure-*.js`
 * headlessly in Node (`experiment/ExtractComixRuntime.ts`). One catch: the bundle has an anti-tamper
 * check `ce()` that requires `document.querySelector.toString()` to match a
 * native-function regex; if it fails, every mut-key-loading function silently
 * corrupts its bytes and produces a useless token. Defeated by overriding
 * `querySelector.toString` to return `"function querySelector() { [native code] }"`.
 * With that, the extractor produced byte-exact browser tokens and encrypted
 * response fixtures.
 *
 * Cross-checked against the Tachiyomi
 * Kotlin port — independent reverse-engineering arrived at the identical
 * 15 keys, identical round structure (mut → rc4 per round), and identical
 * mutation case tables. As solid as this kind of thing gets.
 *
 * --- Refresh procedure when comix.to rotates ------------------------------
 *
 *   1. `npx tsx experiment/ExtractComixRuntime.ts`
 *   2. `npx tsx experiment/BuildComixLiveRuntime.ts`
 *   3. `npx tsx experiment/ValidateLocalComixRuntime.ts`
 *   4. `npm run bundle`
 */

// Pure-JS base64 helpers — neither Buffer, atob, nor btoa exist in Paperback's JSC.
import { RequestManager, Response } from "@paperback/types";
import { liveDecryptComixPayload, liveGenerateHash, liveGetRuntimeTiming } from "./ComixLiveRuntime";
import { fastDecryptComixPayload } from "./ComixFastDecrypt";

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
    return liveGenerateHash(rawPath);
}

export async function decryptComixPayload(rawPath: string, payload: any, headers: Record<string, string> = {}): Promise<any> {
    try {
        return fastDecryptComixPayload(rawPath, payload, headers);
    } catch {
        return await liveDecryptComixPayload(rawPath, payload, headers);
    }
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

const TIMING_LOG_URL = "http://192.168.0.215:9090/log";
let timingSeq = 0;
let runtimeTimingLogged = false;
let timingRequestManager: RequestManager | null = null;

function apiPathFromUrl(fullUrl: string): string {
    return fullUrl
        .replace(/^https?:\/\/[^/]+/, "")
        .replace(/^\/api\/v1/, "");
}

function headerValue(headers: Record<string, any>, name: string): string {
    return String(headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? "");
}

function getTimingRequestManager(): RequestManager {
    if (timingRequestManager === null) {
        timingRequestManager = App.createRequestManager({
            requestsPerSecond: 20,
            requestTimeout: 3000,
        });
    }
    return timingRequestManager;
}

function timingLog(message: string): void {
    if (!TIMING_LOG_URL) return;
    try {
        const request = App.createRequest({
            url: TIMING_LOG_URL,
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            data: message,
        });
        void getTimingRequestManager().schedule(request, 1).catch(() => {});
    } catch {
        // Timing must never break source behavior.
    }
}

function logRuntimeTimingOnce(): void {
    if (runtimeTimingLogged) return;
    runtimeTimingLogged = true;
    const timing = liveGetRuntimeTiming();
    timingLog(
        `[runtime:init] browserStub=${timing.browserStubMs}ms secureEval=${timing.secureEvalMs}ms restoreTimers=${timing.restoreTimersMs}ms total=${timing.totalInitMs}ms installer=${timing.installerMs ?? "pending"}ms`,
    );
}

function checkSignedResponseError(response: Response): void {
    const data = response.data ?? "";
    const preview = data.substring(0, 200).replace(/\s+/g, " ");
    const headers = response.headers ?? {};
    const ct = (headers["Content-Type"] ?? headers["content-type"] ?? "?") as string;
    const cfRay = (headers["Cf-Ray"] ?? headers["cf-ray"] ?? "?") as string;
    const reqUrl = (response as any).request?.url ?? "?";
    const ctx = `status=${response.status} ct=${ct} cf-ray=${cfRay} url=${reqUrl} preview="${preview}"`;

    if (response.status === 403 || response.status === 503) {
        throw new Error(`Cloudflare Bypass Required [${ctx}]`);
    }
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: Unexpected response from server [${ctx}]`);
    }
    if (data.trimStart().startsWith("<")) {
        throw new Error(`Cloudflare Bypass Required [${ctx}]`);
    }
}

export async function fetchSigned<T>(
    requestManager: RequestManager,
    fullUrl: string,
): Promise<T> {
    const id = ++timingSeq;
    logRuntimeTimingOnce();

    const totalStart = Date.now();
    const apiPath = apiPathFromUrl(fullUrl);

    const signStart = Date.now();
    const signedUrl = signUrl(fullUrl);
    const signMs = Date.now() - signStart;

    const request = App.createRequest({
        url: signedUrl,
        method: "GET",
        headers: {
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://comix.to/",
        },
    });

    const fetchStart = Date.now();
    const response = await requestManager.schedule(request, 1);
    const fetchMs = Date.now() - fetchStart;

    checkSignedResponseError(response);

    const parseStart = Date.now();
    const json = JSON.parse(response.data ?? "{}");
    const parseMs = Date.now() - parseStart;

    const headers = response.headers ?? {};
    const xEnc = headerValue(headers, "x-enc") || "0";
    const bytes = (response.data ?? "").length;

    if (json && typeof json === "object" && "e" in json) {
        const decryptStart = Date.now();
        const decrypted = await decryptComixPayload(apiPath, json, headers) as T;
        const decryptMs = Date.now() - decryptStart;
        const runtime = liveGetRuntimeTiming();
        timingLog(
            `[fetch:${id}] path=${apiPath} status=${response.status} bytes=${bytes} xEnc=${xEnc} sign=${signMs}ms fetch=${fetchMs}ms parse=${parseMs}ms decrypt=${decryptMs}ms total=${Date.now() - totalStart}ms installer=${runtime.installerMs ?? "pending"}ms`,
        );
        return decrypted;
    }

    if (json.status !== "ok") {
        throw new Error(`Comix API ${json.status}: ${json.message ?? "no message"}`);
    }

    timingLog(
        `[fetch:${id}] path=${apiPath} status=${response.status} bytes=${bytes} xEnc=${xEnc} sign=${signMs}ms fetch=${fetchMs}ms parse=${parseMs}ms decrypt=0ms total=${Date.now() - totalStart}ms`,
    );
    return json.result as T;
}
