/**
 * Simulate the Paperback fallback path for a Comix signed-request 403:
 *
 *   local signed request fails -> fetch Render constants -> sign with remote constants
 *   -> retry Comix API -> decrypt encrypted envelope if present.
 *
 * Run:
 *   node -r ts-node/register/transpile-only experiment/SimulateComixRelay403Recovery.ts
 *
 * Options:
 *   --path "/chapters/9000025"
 *   --relay "https://comix-fast-constants-relay.onrender.com/api/comix-fast-constants"
 *   --real-403   first call Comix with a deliberately bad token to prove the failure path
 */

import { remoteDecryptComixPayload, remoteGenerateHash } from "../src/ComixTo/ComixFastRemote";

const DOMAIN = "https://comix.to";
const API_BASE = `${DOMAIN}/api/v1`;
const DEFAULT_RELAY = "https://comix-fast-constants-relay.onrender.com/api/comix-fast-constants";
const DEFAULT_PATH = "/chapters/9000025";
const UA = process.env.USER_AGENT ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface RemoteConstants {
    schemaVersion: number;
    encoding: string;
    period: number;
    bundleId: string;
    signer: {
        pipelineOrder: string;
        rc4Keys: string[];
        insertStages: Array<{ prefix: number; prefixBytesB64: string; opsB64: string }>;
    };
    decrypt: {
        pipelineOrder: string;
        rc4Keys: string[];
        mutationStages: Array<{ prefix: number; opsB64: string }>;
    };
}

function argValue(name: string, fallback: string): string {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function hasFlag(name: string): boolean {
    return process.argv.includes(name);
}

function cookieHeader(): string {
    return [
        process.env.SESSION ? `session=${process.env.SESSION}` : "",
        process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
    ].filter(Boolean).join("; ");
}

function appendToken(apiPath: string, token: string): string {
    const sep = apiPath.includes("?") ? "&" : "?";
    return `${API_BASE}${apiPath}${sep}_=${encodeURIComponent(token)}`;
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
}

async function fetchJsonText(url: string): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    const res = await fetch(url, {
        method: "GET",
        headers: {
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": `${DOMAIN}/`,
            "User-Agent": UA,
            "Cookie": cookieHeader(),
        },
    });
    return {
        status: res.status,
        headers: responseHeadersToRecord(res.headers),
        text: await res.text(),
    };
}

function validateConstants(constants: RemoteConstants): void {
    if (constants.schemaVersion !== 2) throw new Error(`Unexpected constants schema: ${constants.schemaVersion}`);
    if (constants.encoding !== "compact-b64-ops") throw new Error(`Unexpected constants encoding: ${constants.encoding}`);
    if (constants.period !== 160) throw new Error(`Unexpected constants period: ${constants.period}`);
    if (constants.signer.rc4Keys.length !== constants.signer.insertStages.length) throw new Error("Signer key/stage count mismatch");
    if (constants.decrypt.rc4Keys.length !== constants.decrypt.mutationStages.length) throw new Error("Decrypt key/stage count mismatch");
}

async function fetchRemoteConstants(relayUrl: string): Promise<RemoteConstants> {
    const url = `${relayUrl}${relayUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
    const res = await fetch(url, {
        headers: {
            "Accept": "application/json",
            "User-Agent": UA,
        },
    });
    if (!res.ok) throw new Error(`Relay constants HTTP ${res.status}`);
    const constants = await res.json() as RemoteConstants;
    validateConstants(constants);
    return constants;
}

function summarizePayload(value: any): string {
    if (Array.isArray(value)) return `array length=${value.length}`;
    if (value && typeof value === "object") return `object keys=${Object.keys(value).slice(0, 12).join(",")}`;
    return `${typeof value}: ${String(value).slice(0, 120)}`;
}

async function main(): Promise<void> {
    const apiPath = argValue("--path", DEFAULT_PATH);
    const relayUrl = argValue("--relay", DEFAULT_RELAY);
    const doReal403 = hasFlag("--real-403");

    console.log(`[simulate] API path: ${apiPath}`);
    console.log(`[simulate] relay:    ${relayUrl}`);

    if (doReal403) {
        const badUrl = appendToken(apiPath, "bad-token");
        const bad = await fetchJsonText(badUrl);
        console.log(`[simulate] deliberately bad signed request -> HTTP ${bad.status}`);
    } else {
        console.log("[simulate] pretending local signed request returned HTTP 403");
    }

    console.log("[simulate] fetching remote constants");
    const constants = await fetchRemoteConstants(relayUrl);
    console.log(`[simulate] constants bundle=${constants.bundleId} signer=${constants.signer.pipelineOrder} decrypt=${constants.decrypt.pipelineOrder}`);

    const token = remoteGenerateHash(apiPath, constants as any);
    console.log(`[simulate] remote token=${token.slice(0, 32)}... length=${token.length}`);

    const signedUrl = appendToken(apiPath, token);
    console.log("[simulate] retrying Comix API with remote token");
    const response = await fetchJsonText(signedUrl);
    console.log(`[simulate] retry status=${response.status} bytes=${response.text.length}`);
    if (response.status < 200 || response.status >= 300) {
        console.log(response.text.slice(0, 500));
        throw new Error(`Remote-token retry failed with HTTP ${response.status}`);
    }

    const payload = JSON.parse(response.text || "{}");
    if (payload && typeof payload === "object" && "e" in payload) {
        console.log("[simulate] encrypted envelope detected; decrypting with remote constants");
        const decrypted = remoteDecryptComixPayload(payload, response.headers, constants as any);
        console.log(`[simulate] decrypted ${summarizePayload(decrypted)}`);
        return;
    }

    console.log(`[simulate] plain payload ${summarizePayload(payload?.result ?? payload)}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
