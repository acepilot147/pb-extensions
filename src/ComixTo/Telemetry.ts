import { RequestManager } from "@paperback/types";

// Set to your telemetry collector URL. Empty string disables telemetry.
export const TELEMETRY_URL = "https://telemetry.comix-ext.workers.dev/log";
// Must match the SECRET environment variable set in the Cloudflare Worker.
const TELEMETRY_KEY = "comix-telemetry-key-Y29taXh0ZWxlbWV0cnljb2RlMTQ3";

export interface TelemetryEvent {
    seq: number;
    ts: number;
    label: string;
    path: string;
    status: number;
    bytes: number;
    signMs: number;
    fetchMs: number;
    parseMs: number;
    decryptMs: number;
    totalMs: number;
}

export interface RelayTelemetryEvent {
    seq: number;
    ts: number;
    reason: string;
    path: string;
    method: string;
    attempt: number;
    localStatus?: number;
    retryStatus?: number;
    relayStatus?: number;
    relayOk: boolean;
    relayError?: string;
    bundleId?: string;
    constantsSchema?: number;
    signerOrder?: string;
    signerRounds?: number;
    decryptOrder?: string;
    decryptRounds?: number;
    constantsSource?: string;
    cacheHit: boolean;
    forceRefresh: boolean;
    relayMs: number;
    totalMs: number;
    bytes: number;
    detail?: string;
}

let _rm: RequestManager | null = null;
let _seq = 0;
let _relaySeq = 0;

function getRM(): RequestManager {
    if (!_rm) {
        _rm = App.createRequestManager({ requestsPerSecond: 20, requestTimeout: 3000 });
    }
    return _rm;
}

// FNV-1a 32-bit — one-way hash so no manga/chapter IDs leave the device in plaintext
function hashPath(path: string): string {
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) {
        h ^= path.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

export function emit(event: Omit<TelemetryEvent, "seq" | "ts">): void {
    if (!TELEMETRY_URL) return;
    try {
        const full: TelemetryEvent = { seq: ++_seq, ts: Date.now(), ...event, path: hashPath(event.path) };
        const req = App.createRequest({
            url: TELEMETRY_URL,
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Tel-Key": TELEMETRY_KEY },
            data: JSON.stringify(full),
        });
        void getRM().schedule(req, 1).catch(() => {});
    } catch {}
}

export function emitRelay(event: Omit<RelayTelemetryEvent, "seq" | "ts">): void {
    if (!TELEMETRY_URL) return;
    try {
        const full: RelayTelemetryEvent = { seq: ++_relaySeq, ts: Date.now(), ...event, path: hashPath(event.path) };
        const req = App.createRequest({
            url: TELEMETRY_URL.replace(/\/log$/, "/relay-log"),
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Tel-Key": TELEMETRY_KEY },
            data: JSON.stringify(full),
        });
        void getRM().schedule(req, 1).catch(() => {});
    } catch {}
}
