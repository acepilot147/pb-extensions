import { RequestManager, Response } from "@paperback/types";
import { signUrl } from "./ComixHash";

/**
 * Hardcoded relay URL — ships with each extension build, not user-configurable.
 *
 * Comix.to rotates the URL-signing algorithm on every deploy; the static
 * signer in ComixHash.ts can lag those rotations by hours to days. While the
 * static signer is current this can be left as the empty string and the
 * extension uses it directly. While it's broken (e.g. post-2026-05-09 VM
 * obfuscation + body-encryption rotation), point this at a deployed instance
 * of `experiment/relay/Server.ts`; the extension asks the relay to sign,
 * fetches Comix directly, then sends encrypted bodies through `/decrypt`.
 *
 * Operational deployment targets:
 *   - Local testing: `http://<lan-ip>:9091` (only works on the same Wi-Fi)
 *   - Production:    a Cloudflare Worker port of Server.ts, or any small VPS
 *
 * To disable the relay path entirely (after a fresh static signer ships),
 * set this to "" — fetchSigned() will fall back to the static path.
 */
export const RELAY_URL: string = "https://comix-relay.onrender.com";

const RELAY = RELAY_URL.trim().replace(/\/+$/, "");

/**
 * Fetch a signed comix.to v1 URL and return the parsed `result` payload.
 * Routes through RELAY when set; falls back to static signer otherwise.
 */
export async function fetchSigned<T>(
    requestManager: RequestManager,
    fullUrl: string,
): Promise<T> {
    if (RELAY) {
        const apiPath = fullUrl
            .replace(/^https?:\/\/[^/]+/, "")
            .replace(/^\/api\/v1/, "");

        const signRequest = App.createRequest({
            url: `${RELAY}/sign?path=${encodeURIComponent(apiPath)}`,
            method: "GET",
        });
        const signResponse = await requestManager.schedule(signRequest, 1);

        if (signResponse.status < 200 || signResponse.status >= 300) {
            const preview = (signResponse.data ?? "").slice(0, 200).replace(/\s+/g, " ");
            throw new Error(`Comix relay unreachable (HTTP ${signResponse.status} from ${RELAY}${preview ? `: ${preview}` : ""})`);
        }

        let signedWrapped: any;
        try { signedWrapped = JSON.parse(signResponse.data ?? "{}"); }
        catch { throw new Error(`Comix relay returned non-JSON: ${(signResponse.data ?? "").slice(0, 200)}`); }

        if (!signedWrapped.ok || typeof signedWrapped.signedUrl !== "string") {
            throw new Error(`Comix relay error: ${signedWrapped.error ?? "missing signedUrl"}`);
        }

        const apiRequest = App.createRequest({
            url: signedWrapped.signedUrl,
            method: "GET",
            headers: {
                "Accept": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://comix.to/",
            },
        });
        const apiResponse = await requestManager.schedule(apiRequest, 1);
        checkStaticResponseError(apiResponse);

        let apiJson: any;
        try { apiJson = JSON.parse(apiResponse.data ?? "{}"); }
        catch { throw new Error(`Comix API returned non-JSON: ${(apiResponse.data ?? "").slice(0, 200)}`); }

        if (!(apiJson && typeof apiJson === "object" && "e" in apiJson)) {
            if (apiJson.status !== "ok") {
                throw new Error(`Comix API ${apiJson.status}: ${apiJson.message ?? "no message"}`);
            }
            return apiJson.result as T;
        }

        const decryptRequest = App.createRequest({
            url: `${RELAY}/decrypt`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                path: apiPath,
                status: apiResponse.status,
                headers: apiResponse.headers ?? {},
                payload: apiJson,
            }),
        });
        const decryptResponse = await requestManager.schedule(decryptRequest, 1);

        if (decryptResponse.status < 200 || decryptResponse.status >= 300) {
            const preview = (decryptResponse.data ?? "").slice(0, 200).replace(/\s+/g, " ");
            throw new Error(`Comix relay decrypt failed (HTTP ${decryptResponse.status} from ${RELAY}${preview ? `: ${preview}` : ""})`);
        }

        let decryptedWrapped: any;
        try { decryptedWrapped = JSON.parse(decryptResponse.data ?? "{}"); }
        catch { throw new Error(`Comix relay decrypt returned non-JSON: ${(decryptResponse.data ?? "").slice(0, 200)}`); }

        if (!decryptedWrapped.ok) {
            throw new Error(`Comix relay decrypt error: ${decryptedWrapped.error ?? "unknown"}`);
        }
        return decryptedWrapped.data as T;
    }

    // --- static fallback ---------------------------------------------------
    const request = App.createRequest({ url: signUrl(fullUrl), method: "GET" });
    const response = await requestManager.schedule(request, 1);
    checkStaticResponseError(response);

    const json = JSON.parse(response.data ?? "{}");
    if (json.status !== "ok") {
        throw new Error(`Comix API ${json.status}: ${json.message ?? "no message"}`);
    }
    return json.result as T;
}

function checkStaticResponseError(response: Response): void {
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
