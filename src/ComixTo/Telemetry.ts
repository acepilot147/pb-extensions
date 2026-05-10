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

let _rm: RequestManager | null = null;
let _seq = 0;

function getRM(): RequestManager {
    if (!_rm) {
        _rm = App.createRequestManager({ requestsPerSecond: 20, requestTimeout: 3000 });
    }
    return _rm;
}

export function emit(event: Omit<TelemetryEvent, "seq" | "ts">): void {
    if (!TELEMETRY_URL) return;
    try {
        const full: TelemetryEvent = { seq: ++_seq, ts: Date.now(), ...event };
        const req = App.createRequest({
            url: TELEMETRY_URL,
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Tel-Key": TELEMETRY_KEY },
            data: JSON.stringify(full),
        });
        void getRM().schedule(req, 1).catch(() => {});
    } catch {}
}
