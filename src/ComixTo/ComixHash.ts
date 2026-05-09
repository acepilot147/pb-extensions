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
    timingLog("[runtime:init] signer=fast decrypt=fast");
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
        timingLog(
            `[fetch:${id}] path=${apiPath} status=${response.status} bytes=${bytes} xEnc=${xEnc} sign=${signMs}ms fetch=${fetchMs}ms parse=${parseMs}ms decrypt=${decryptMs}ms total=${Date.now() - totalStart}ms`,
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
