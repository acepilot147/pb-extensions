/**
 * Comix API signing and encrypted-response decoding — the central interface for
 * ComixTo. Signing and decryption are delegated to the native, generated modules
 * (ComixFastSigner / ComixFastDecrypt); the live-VM bundle is no longer used.
 *
 * Regenerate those modules when comix.to rotates secure-*.js:
 *   npm run crypto:pipeline        (offline, from the embedded bundle)
 *   npm run crypto:pipeline -- --refresh   (fetch live secure.js first;
 *     requires CF_CLEARANCE / SESSION / USER_AGENT — see
 *     experiment/crypto-pipeline/README.md)
 */

import { RequestManager, Response } from "@paperback/types";
import { fastGenerateHash } from "./ComixFastSigner";
import { fastDecryptComixPayload } from "./ComixFastDecrypt";
import { emit } from "./Telemetry";

// Paths the live bundle's request interceptor signs — verified by probing the
// booted bundle (experiment/crypto-pipeline). As of bundle 6ffb/625d… (2026-06)
// comix widened token enforcement to EVERY /manga endpoint (details, browse
// lists, /top, /{slug}/chapters, /{slug}/chapter-indexes) plus individual
// /chapters/{id}. Unsigned /manga* now returns 403 "Missing token.". Only
// /tags/search (and non-/manga, non-/chapters paths) stay unsigned — the bundle
// does not sign those. Patterns are segment-exact (so /mangas is NOT matched),
// and tokens are pathname-only (the query string is not part of the signature).
const SIGNED_PATTERNS: RegExp[] = [
    /^\/manga(?:\/|$)/,
    /^\/chapters\/[^/]+/,
];

function isSignedPath(path: string): boolean {
    return SIGNED_PATTERNS.some(re => re.test(path));
}

/**
 * Generate the comix.to /api/v1 `_=` token for a request. Since bundle 625d…
 * the signature covers the path AND its query params; `fastGenerateHash`
 * canonicalizes the query internally, so pass the full URL (or path+query).
 */
export function generateHash(rawPath: string): string {
    return fastGenerateHash(rawPath);
}

/**
 * Append `_=<token>` to a comix.to /api/v1 URL when the path is on the
 * signed list. Pass-through for everything else. The token signs the path +
 * canonicalized query (handled in fastGenerateHash); the wire URL is unchanged
 * because the server re-canonicalizes whatever we send.
 */
export function signUrl(url: string): string {
    const path = url.replace("https://comix.to/api/v1", "").split("?")[0]!;
    if (!isSignedPath(path)) return url;
    const token = generateHash(url);
    if (!token) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_=${token}`;
}

async function requestSignedUrl(requestManager: RequestManager, url: string): Promise<Response> {
    return requestManager.schedule(App.createRequest({
        url,
        method: "GET",
        headers: {
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://comix.to/",
        },
    }), 1);
}

function checkSignedResponseError(response: Response): void {
    const data = response.data ?? "";
    const preview = data.substring(0, 200).replace(/\s+/g, " ");
    const headers = response.headers ?? {};
    const ct = (headers["Content-Type"] ?? headers["content-type"] ?? "?") as string;
    const cfRay = (headers["Cf-Ray"] ?? headers["cf-ray"] ?? "?") as string;
    const reqUrl = (response as any).request?.url ?? "?";
    const ctx = `status=${response.status} ct=${ct} cf-ray=${cfRay} url=${reqUrl} preview="${preview}"`;

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: Unexpected response from server [${ctx}]`);
    }
    if (data.trimStart().startsWith("<")) {
        throw new Error(`Cloudflare challenge page returned [${ctx}]`);
    }
}

export async function fetchSigned<T>(
    requestManager: RequestManager,
    fullUrl: string,
): Promise<T> {
    const totalStart = Date.now();

    const apiPath = fullUrl.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "");
    const telPath = apiPath.split("?")[0]!;
    const label = /^\/manga\/[^/]+\/chapters/.test(telPath) ? "chapters"
        : /^\/chapters\//.test(telPath) ? "chapter_images"
        : "signed_fetch";

    const signStart = Date.now();
    const signedUrl = signUrl(fullUrl);
    const signMs = Date.now() - signStart;

    const fetchStart = Date.now();
    const response = await requestSignedUrl(requestManager, signedUrl);
    const fetchMs = Date.now() - fetchStart;
    const status = response.status;
    const bytes = (response.data ?? "").length;

    try {
        checkSignedResponseError(response);
    } catch (err) {
        emit({ label, path: telPath, status, bytes, signMs, fetchMs, parseMs: 0, decryptMs: 0, totalMs: Date.now() - totalStart });
        throw err;
    }

    const parseStart = Date.now();
    const json = JSON.parse(response.data ?? "{}");
    const parseMs = Date.now() - parseStart;
    const headers = response.headers ?? {};

    if (json && typeof json === "object" && "e" in json) {
        const decryptStart = Date.now();
        const decrypted = fastDecryptComixPayload(apiPath, json, headers) as any;
        const decryptMs = Date.now() - decryptStart;
        emit({ label, path: telPath, status, bytes, signMs, fetchMs, parseMs, decryptMs, totalMs: Date.now() - totalStart });
        // The interceptor unwraps `{ status: "ok", result: ... }` for us and
        // returns `result` directly; some payloads may not be wrapped.
        return (decrypted && typeof decrypted === "object" && "result" in decrypted && decrypted.status === "ok"
            ? decrypted.result
            : decrypted) as T;
    }

    if (json.status !== "ok") {
        throw new Error(`Comix API ${json.status}: ${json.message ?? "no message"}`);
    }
    emit({ label, path: telPath, status, bytes, signMs, fetchMs, parseMs, decryptMs: 0, totalMs: Date.now() - totalStart });
    return json.result as T;
}
