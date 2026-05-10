/**
 * Comix API signing and encrypted-response decoding.
 *
 * Refresh when comix.to rotates:
 *   1. npx tsx experiment/ExtractComixRuntime.ts
 *   2. npx tsx experiment/BuildComixFastSigner.ts
 *   3. npx tsx experiment/BuildComixFastDecrypt.ts
 *   4. npx tsx experiment/ValidateLocalComixRuntime.ts
 *   5. npm run bundle
 */

import { RequestManager, Response } from "@paperback/types";
import { fastDecryptComixPayload } from "./ComixFastDecrypt";
import { fastGenerateHash } from "./ComixFastSigner";
import { emit } from "./Telemetry";

/**
 * Generate the comix.to /api/v1 `_=` token for a path.
 *
 * @param rawPath API path; protocol+host, query string, and `/api/v1` prefix
 *                are stripped before signing.
 */
export function generateHash(rawPath: string): string {
    return fastGenerateHash(rawPath);
}

export async function decryptComixPayload(rawPath: string, payload: any, headers: Record<string, string> = {}): Promise<any> {
    return fastDecryptComixPayload(rawPath, payload, headers);
}

// Paths the live bundle actually signs. Anything outside this set must be sent
// unsigned because server-side endpoints reject unknown query params.
const SIGNED_PATTERNS: RegExp[] = [
    /^\/manga\/[^/]+\/chapters\b/,
    /^\/manga\/[^/]+\/chapter-indexes\b/,
    /^\/chapters\/[^/]+(?:\?|$)/,
];

/**
 * Append `_=<token>` to a comix.to /api/v1 URL only if the path is signed.
 */
export function signUrl(url: string): string {
    const path = url.replace("https://comix.to/api/v1", "").split("?")[0]!;
    if (!SIGNED_PATTERNS.some(re => re.test(path))) return url;
    const token = generateHash(path);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_=${token}`;
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
    const totalStart = Date.now();

    // apiPath keeps query string for decrypt key derivation; telPath strips it for readability
    const apiPath = fullUrl.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "");
    const telPath = apiPath.split("?")[0]!;
    const label = /^\/manga\/[^/]+\/chapters/.test(telPath) ? "chapters"
        : /^\/chapters\//.test(telPath) ? "chapter_images"
        : "signed_fetch";

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
    const status = response.status;
    const bytes = (response.data ?? "").length;

    // Emit before throwing so error statuses are recorded
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
        const decrypted = await decryptComixPayload(apiPath, json, headers) as T;
        const decryptMs = Date.now() - decryptStart;
        emit({ label, path: telPath, status, bytes, signMs, fetchMs, parseMs, decryptMs, totalMs: Date.now() - totalStart });
        return decrypted;
    }

    if (json.status !== "ok") {
        throw new Error(`Comix API ${json.status}: ${json.message ?? "no message"}`);
    }

    emit({ label, path: telPath, status, bytes, signMs, fetchMs, parseMs, decryptMs: 0, totalMs: Date.now() - totalStart });
    return json.result as T;
}
