import { RequestManager, SourceStateManager } from "@paperback/types";
import { emitRelay } from "./Telemetry";

const REMOTE_CONSTANTS_URL = "https://comix-fast-constants-relay.onrender.com/api/comix-fast-constants";
const REMOTE_CONSTANTS_STATE_KEY = "comix.remoteConstants.v2";
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PERIOD = 160;

type PipelineOrder = "rc4-then-insert" | "insert-then-rc4" | "mutation-then-rc4" | "rc4-then-mutation";

interface InsertStage {
    prefix: number;
    prefixBytesB64: string;
    opsB64: string;
}

interface MutationStage {
    prefix: number;
    opsB64: string;
}

interface RemoteConstants {
    schemaVersion: number;
    encoding: string;
    period: number;
    bundleId: string;
    signer: {
        pipelineOrder: PipelineOrder;
        rc4Keys: string[];
        insertStages: InsertStage[];
    };
    decrypt: {
        pipelineOrder: PipelineOrder;
        rc4Keys: string[];
        mutationStages: MutationStage[];
    };
}

interface RelayTelemetryContext {
    reason?: string;
    path?: string;
    method?: string;
    attempt?: number;
    localStatus?: number;
    retryStatus?: number;
    detail?: string;
}

let cachedConstants: RemoteConstants | null = null;

function b64Decode(s: string): number[] {
    const lookup: number[] = new Array(128).fill(-1);
    for (let i = 0; i < 64; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
    const normalized = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
    const out: number[] = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < normalized.length; i++) {
        const c = normalized.charCodeAt(i);
        if (c === 61) break;
        const v = lookup[c] ?? -1;
        if (v < 0) continue;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 0xff);
        }
    }
    return out;
}

function b64UrlEncode(bytes: number[]): string {
    let out = "", i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
        out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
    }
    if (i + 1 === bytes.length) {
        const n = bytes[i]! << 16;
        out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63];
    } else if (i + 2 === bytes.length) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
        out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63];
    }
    return out.replace(/\+/g, "-").replace(/\//g, "_");
}

function bytesFromString(s: string): number[] {
    const out: number[] = new Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

function bytesToBinaryString(bytes: number[]): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 8192) {
        out += String.fromCharCode(...bytes.slice(i, i + 8192));
    }
    return out;
}

function rc4(key: number[], data: number[]): number[] {
    const s: number[] = new Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i]! + key[i % key.length]!) & 255;
        const t = s[i]!; s[i] = s[j]!; s[j] = t;
    }
    const out: number[] = new Array(data.length);
    let i = 0; j = 0;
    for (let n = 0; n < data.length; n++) {
        i = (i + 1) & 255;
        j = (j + s[i]!) & 255;
        const t = s[i]!; s[i] = s[j]!; s[j] = t;
        out[n] = data[n]! ^ s[(s[i]! + s[j]!) & 255]!;
    }
    return out;
}

function rotL1(n: number): number { return ((n << 1) | (n >>> 7)) & 0xff; }
function rotR1(n: number): number { return ((n >>> 1) | (n << 7)) & 0xff; }
function rotL2(n: number): number { return ((n << 2) | (n >>> 6)) & 0xff; }
function rotR2(n: number): number { return ((n >>> 2) | (n << 6)) & 0xff; }
function rotL3(n: number): number { return ((n << 3) | (n >>> 5)) & 0xff; }
function rotR3(n: number): number { return ((n >>> 3) | (n << 5)) & 0xff; }
function nibSwap(n: number): number { return ((n << 4) | (n >>> 4)) & 0xff; }

function transformSignerByte(b: number, op: number, key: number, extra: number): number {
    const n = b ^ key;
    switch (op) {
        case 0: return n;
        case 1: return (n + extra) & 0xff;
        case 2: return rotL1(n);
        case 3: return rotR1(n);
        case 4: return rotL2(n);
        case 5: return rotR2(n);
        case 6: return nibSwap(n);
        case 7: return rotL3(n);
        case 8: return rotR3(n);
        default: return n;
    }
}

function transformDecryptByte(b: number, op: number, key: number, extra: number): number {
    switch (op) {
        case 0: return b ^ key;
        case 1: return ((b + extra) & 0xff) ^ key;
        case 2: return rotL1(b) ^ key;
        case 3: return rotR1(b) ^ key;
        case 4: return rotL2(b) ^ key;
        case 5: return rotR2(b) ^ key;
        case 6: return nibSwap(b) ^ key;
        case 7: return rotL3(b) ^ key;
        case 8: return rotR3(b) ^ key;
        case 9: return ((b ^ key) + extra) & 0xff;
        case 10: return rotL1(b ^ key);
        case 11: return rotR1(b ^ key);
        case 12: return rotL2(b ^ key);
        case 13: return rotR2(b ^ key);
        case 14: return nibSwap(b ^ key);
        case 15: return rotL3(b ^ key);
        case 16: return rotR3(b ^ key);
        default: return b ^ key;
    }
}

function encodedIndexForOutput(outputIndex: number, prefixLimit: number): number {
    return outputIndex < prefixLimit ? outputIndex * 2 + 1 : outputIndex + prefixLimit;
}

function applyInsertStage(data: number[], stage: InsertStage): number[] {
    const prefixBytes = b64Decode(stage.prefixBytesB64);
    const ops = b64Decode(stage.opsB64);
    const out: number[] = new Array(data.length + stage.prefix);
    for (let i = 0; i < data.length; i++) {
        if (i < stage.prefix) out[i * 2] = prefixBytes[i]!;
        const opIndex = (i % PERIOD) * 3;
        out[i < stage.prefix ? i * 2 + 1 : i + stage.prefix] = transformSignerByte(
            data[i]! & 0xff,
            ops[opIndex]!,
            ops[opIndex + 1]!,
            ops[opIndex + 2]!,
        );
    }
    return out;
}

function applyMutationStage(data: number[], stage: MutationStage): number[] {
    const ops = b64Decode(stage.opsB64);
    const outLen = data.length - stage.prefix;
    if (outLen < 0) throw new Error("Comix encrypted payload is too short");
    const out: number[] = new Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const opIndex = (i % PERIOD) * 3;
        const encoded = data[encodedIndexForOutput(i, stage.prefix)]! & 0xff;
        out[i] = transformDecryptByte(encoded, ops[opIndex]!, ops[opIndex + 1]!, ops[opIndex + 2]!);
    }
    return out;
}

function normalizeSignPath(rawPath: string): string {
    return rawPath
        .replace(/^https?:\/\/[^/]+/, "")
        .replace(/^\/api\/v1/, "")
        .split("?")[0]!;
}

function validateConstants(constants: RemoteConstants): void {
    if (constants.schemaVersion !== 2 || constants.encoding !== "compact-b64-ops" || constants.period !== PERIOD) {
        throw new Error("Unsupported Comix remote constants schema");
    }
    if (constants.signer.rc4Keys.length !== constants.signer.insertStages.length) {
        throw new Error("Comix remote signer constants mismatch");
    }
    if (constants.decrypt.rc4Keys.length !== constants.decrypt.mutationStages.length) {
        throw new Error("Comix remote decrypt constants mismatch");
    }
}

function emitRemoteConstantsTelemetry(
    constants: RemoteConstants | null,
    source: string,
    force: boolean,
    ctx: RelayTelemetryContext | undefined,
    values: { relayStatus?: number; relayOk: boolean; relayError?: string; relayMs: number; totalMs: number; bytes: number },
): void {
    emitRelay({
        reason: ctx?.reason ?? "constants-fetch",
        path: ctx?.path ?? "",
        method: ctx?.method ?? "GET",
        attempt: ctx?.attempt ?? 1,
        localStatus: ctx?.localStatus,
        retryStatus: ctx?.retryStatus,
        relayStatus: values.relayStatus,
        relayOk: values.relayOk,
        relayError: values.relayError,
        bundleId: constants?.bundleId,
        constantsSchema: constants?.schemaVersion,
        signerOrder: constants?.signer.pipelineOrder,
        signerRounds: constants?.signer.rc4Keys.length,
        decryptOrder: constants?.decrypt.pipelineOrder,
        decryptRounds: constants?.decrypt.rc4Keys.length,
        constantsSource: source,
        cacheHit: source === "memory" || source === "state",
        forceRefresh: force,
        relayMs: values.relayMs,
        totalMs: values.totalMs,
        bytes: values.bytes,
        detail: ctx?.detail,
    });
}

async function loadStoredConstants(stateManager?: SourceStateManager): Promise<RemoteConstants | null> {
    if (!stateManager) return null;
    try {
        const raw = await stateManager.retrieve(REMOTE_CONSTANTS_STATE_KEY) as string | null;
        if (!raw) return null;
        const constants = JSON.parse(raw) as RemoteConstants;
        validateConstants(constants);
        return constants;
    } catch {
        await stateManager.store(REMOTE_CONSTANTS_STATE_KEY, null);
        return null;
    }
}

export async function storeRemoteComixConstants(stateManager: SourceStateManager | undefined, constants: RemoteConstants): Promise<void> {
    if (!stateManager) return;
    validateConstants(constants);
    await stateManager.store(REMOTE_CONSTANTS_STATE_KEY, JSON.stringify(constants));
}

export async function fetchRemoteComixConstants(
    requestManager: RequestManager,
    stateManager?: SourceStateManager,
    force = false,
    telemetry?: RelayTelemetryContext,
): Promise<RemoteConstants> {
    const totalStart = Date.now();

    if (cachedConstants && !force) {
        emitRemoteConstantsTelemetry(cachedConstants, "memory", force, telemetry, {
            relayOk: true,
            relayMs: 0,
            totalMs: Date.now() - totalStart,
            bytes: 0,
        });
        return cachedConstants;
    }

    if (!force) {
        const stored = await loadStoredConstants(stateManager);
        if (stored) {
            cachedConstants = stored;
            emitRemoteConstantsTelemetry(stored, "state", force, telemetry, {
                relayOk: true,
                relayMs: 0,
                totalMs: Date.now() - totalStart,
                bytes: 0,
            });
            return stored;
        }
    }

    let responseStatus = 0;
    let responseBytes = 0;
    const relayStart = Date.now();
    try {
        const response = await requestManager.schedule(App.createRequest({
            url: `${REMOTE_CONSTANTS_URL}?t=${Date.now()}`,
            method: "GET",
            headers: { "Accept": "application/json" },
        }), 1);
        const relayMs = Date.now() - relayStart;
        responseStatus = response.status;
        responseBytes = (response.data ?? "").length;
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Comix remote constants HTTP ${response.status}`);
        }
        const constants = JSON.parse(response.data ?? "{}") as RemoteConstants;
        validateConstants(constants);
        cachedConstants = constants;
        await storeRemoteComixConstants(stateManager, constants);
        emitRemoteConstantsTelemetry(constants, force ? "force-relay" : "relay", force, telemetry, {
            relayStatus: response.status,
            relayOk: true,
            relayMs,
            totalMs: Date.now() - totalStart,
            bytes: responseBytes,
        });
        return constants;
    } catch (error) {
        try {
            console.error(`[ComixTo] Relay constants fetch failed: ${String((error as Error)?.message ?? error)}`);
        } catch {}
        emitRemoteConstantsTelemetry(null, force ? "force-relay" : "relay", force, telemetry, {
            relayStatus: responseStatus || undefined,
            relayOk: false,
            relayError: String((error as Error)?.message ?? error).slice(0, 160),
            relayMs: Date.now() - relayStart,
            totalMs: Date.now() - totalStart,
            bytes: responseBytes,
        });
        throw error;
    }
}

export function remoteGenerateHash(rawPath: string, constants: RemoteConstants): string {
    const path = normalizeSignPath(rawPath);
    let data = bytesFromString(encodeURIComponent(path));
    for (let i = 0; i < constants.signer.rc4Keys.length; i++) {
        if (constants.signer.pipelineOrder === "rc4-then-insert") {
            data = rc4(b64Decode(constants.signer.rc4Keys[i]!), data);
            data = applyInsertStage(data, constants.signer.insertStages[i]!);
        } else {
            data = applyInsertStage(data, constants.signer.insertStages[i]!);
            data = rc4(b64Decode(constants.signer.rc4Keys[i]!), data);
        }
    }
    return b64UrlEncode(data);
}

export function remoteDecryptComixPayload(payload: any, headers: Record<string, string>, constants: RemoteConstants): any {
    if (!(payload && typeof payload === "object" && "e" in payload)) return payload;
    const normalizedHeaders: Record<string, string> = {};
    for (const key of Object.keys(headers ?? {})) normalizedHeaders[key.toLowerCase()] = String(headers[key]);
    if (normalizedHeaders["x-enc"] && normalizedHeaders["x-enc"] !== "1") return payload;

    let data = b64Decode(String(payload.e ?? ""));
    for (let i = 0; i < constants.decrypt.rc4Keys.length; i++) {
        if (constants.decrypt.pipelineOrder === "mutation-then-rc4") {
            data = applyMutationStage(data, constants.decrypt.mutationStages[i]!);
            data = rc4(b64Decode(constants.decrypt.rc4Keys[i]!), data);
        } else {
            data = rc4(b64Decode(constants.decrypt.rc4Keys[i]!), data);
            data = applyMutationStage(data, constants.decrypt.mutationStages[i]!);
        }
    }

    const parsed = JSON.parse(decodeURIComponent(bytesToBinaryString(data)));
    return parsed && typeof parsed === "object" && parsed.status === "ok" ? parsed.result : parsed;
}
