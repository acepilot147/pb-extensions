/**
 * Comix API signing and encrypted-response decoding.
 *
 * Refresh when comix.to rotates:
 *   npm run refresh:comix
 */

import { RequestManager, Response, SourceStateManager } from "@paperback/types";
import { fastDecryptComixPayload } from "./ComixFastDecrypt";
import { fastGenerateHash } from "./ComixFastSigner";
import { fetchRemoteComixConstants, getAvailableRemoteComixConstants, RemoteConstants, remoteDecryptComixPayload, remoteGenerateHash, storeRemoteComixConstants } from "./ComixFastRemote";
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

function signUrlWithRemoteConstants(url: string, constants: RemoteConstants): string {
    const path = url.replace("https://comix.to/api/v1", "").split("?")[0]!;
    if (!SIGNED_PATTERNS.some(re => re.test(path))) return url;
    const token = remoteGenerateHash(path, constants);
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

async function signUrlRemote(
    requestManager: RequestManager,
    stateManager: SourceStateManager | undefined,
    url: string,
    force = false,
    telemetry?: { reason?: string; path?: string; attempt?: number; localStatus?: number; retryStatus?: number; detail?: string },
): Promise<{ signedUrl: string; constants: any }> {
    const path = url.replace("https://comix.to/api/v1", "").split("?")[0]!;
    if (!SIGNED_PATTERNS.some(re => re.test(path))) return { signedUrl: url, constants: null };
    const constants = await fetchRemoteComixConstants(requestManager, stateManager, force, {
        reason: telemetry?.reason,
        path: telemetry?.path ?? path,
        attempt: telemetry?.attempt,
        localStatus: telemetry?.localStatus,
        retryStatus: telemetry?.retryStatus,
        detail: telemetry?.detail,
    });
    return { signedUrl: signUrlWithRemoteConstants(url, constants), constants };
}


function checkSignedResponseError(response: Response, relayFallbackError?: string): void {
    const data = response.data ?? "";
    const preview = data.substring(0, 200).replace(/\s+/g, " ");
    const headers = response.headers ?? {};
    const ct = (headers["Content-Type"] ?? headers["content-type"] ?? "?") as string;
    const cfRay = (headers["Cf-Ray"] ?? headers["cf-ray"] ?? "?") as string;
    const reqUrl = (response as any).request?.url ?? "?";
    const relayCtx = relayFallbackError ? ` relay_fallback_failed="${relayFallbackError}"` : "";
    const ctx = `status=${response.status} ct=${ct} cf-ray=${cfRay} url=${reqUrl}${relayCtx} preview="${preview}"`;

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
    stateManager?: SourceStateManager,
): Promise<T> {
    const totalStart = Date.now();

    // apiPath keeps query string for decrypt key derivation; telPath strips it for readability
    const apiPath = fullUrl.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "");
    const telPath = apiPath.split("?")[0]!;
    const label = /^\/manga\/[^/]+\/chapters/.test(telPath) ? "chapters"
        : /^\/chapters\//.test(telPath) ? "chapter_images"
        : "signed_fetch";

    let usedRemoteConstants = false;
    let remoteFirst = false;
    let localStatus: number | undefined;
    let signStart = Date.now();
    const availableRemoteConstants = await getAvailableRemoteComixConstants(stateManager);
    let signedUrl: string;
    if (availableRemoteConstants) {
        signedUrl = signUrlWithRemoteConstants(fullUrl, availableRemoteConstants);
        usedRemoteConstants = signedUrl !== fullUrl;
        remoteFirst = usedRemoteConstants;
    } else {
        signedUrl = signUrl(fullUrl);
    }
    let signMs = Date.now() - signStart;
    let fetchStart = Date.now();
    let response = await requestSignedUrl(requestManager, signedUrl);
    let fetchMs = Date.now() - fetchStart;
    let status = response.status;
    let bytes = (response.data ?? "").length;
    if (!remoteFirst) localStatus = status;
    let relayFallbackError = "";

    if (status === 403 || status === 503) {
        try {
            if (remoteFirst) {
                signStart = Date.now();
                signedUrl = signUrl(fullUrl);
                signMs = Date.now() - signStart;
                usedRemoteConstants = false;
                fetchStart = Date.now();
                response = await requestSignedUrl(requestManager, signedUrl);
                fetchMs = Date.now() - fetchStart;
                status = response.status;
                bytes = (response.data ?? "").length;
                localStatus = status;
            } else {
                signStart = Date.now();
                const remote = await signUrlRemote(requestManager, stateManager, fullUrl, false, {
                    reason: `local-${status}`,
                    path: telPath,
                    attempt: 1,
                    localStatus,
                });
                signedUrl = remote.signedUrl;
                signMs = Date.now() - signStart;
                usedRemoteConstants = true;
                fetchStart = Date.now();
                response = await requestSignedUrl(requestManager, signedUrl);
                fetchMs = Date.now() - fetchStart;
                status = response.status;
                bytes = (response.data ?? "").length;
            }

            if (status === 403 || status === 503) {
                signStart = Date.now();
                const freshRemote = await signUrlRemote(requestManager, stateManager, fullUrl, true, {
                    reason: `retry-${status}`,
                    path: telPath,
                    attempt: 2,
                    localStatus,
                    retryStatus: status,
                    detail: remoteFirst ? "persisted remote and local constants failed; forced relay refresh" : "cached remote constants failed; forced relay refresh",
                });
                signedUrl = freshRemote.signedUrl;
                signMs = Date.now() - signStart;
                usedRemoteConstants = true;
                fetchStart = Date.now();
                response = await requestSignedUrl(requestManager, signedUrl);
                fetchMs = Date.now() - fetchStart;
                status = response.status;
                bytes = (response.data ?? "").length;
            }
        } catch (error) {
            relayFallbackError = String((error as Error)?.message ?? error).slice(0, 180);
            try {
                console.error(`[ComixTo] Relay fallback failed; continuing with local response: ${relayFallbackError}`);
            } catch {}
        }
    }

    // Emit before throwing so error statuses are recorded
    try {
        checkSignedResponseError(response, relayFallbackError);
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
        let decrypted: T;
        if (usedRemoteConstants) {
            const constants = await fetchRemoteComixConstants(requestManager, stateManager, false, {
                reason: "remote-decrypt",
                path: telPath,
                localStatus,
                retryStatus: status,
            });
            decrypted = remoteDecryptComixPayload(json, headers, constants) as T;
            await storeRemoteComixConstants(stateManager, constants);
        } else {
            decrypted = await decryptComixPayload(apiPath, json, headers) as T;
        }
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
