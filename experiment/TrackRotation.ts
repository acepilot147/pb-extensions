export {};

/**
 * Standalone rotation tracker. Polls comix.to every ~30 min and records to
 * experiment/rotation-history.csv. After 24-48h of data we should be able to
 * tell whether key rotation is human-driven (irregular, business hours) or
 * automated (regular cadence).
 *
 * What we record per poll:
 *   ts            — ISO timestamp
 *   mainUrl       — current main-*.js URL
 *   secureUrl     — current secure-*.js URL  (this is what changes on rotation)
 *   bundleSha     — sha256(secureBundleContent), 12-char prefix
 *   cfgSha        — sha256(cfg meta blob), 12-char prefix (cfg has been stable; we track to confirm)
 *   bundleBytes   — size of secure-*.js
 *   bundleChanged — "yes" if bundleSha differs from previous row, blank otherwise
 *
 * Run:
 *   npx tsx --env-file=.env experiment/TrackRotation.ts
 *
 * Tail the CSV:
 *   tail -f experiment/rotation-history.csv
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const CSV_PATH   = resolve(__dirname, "rotation-history.csv");

const PROBE_URL  = process.env.RELAY_PROBE_URL ?? "https://comix.to/title/xlyyj-eleceed";
const POLL_MS    = Number(process.env.TRACK_POLL_MS ?? 30 * 60 * 1000);  // 30 min
const UA         = process.env.USER_AGENT ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const COOKIE = [
    process.env.SESSION ? `session=${process.env.SESSION}` : "",
    process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
].filter(Boolean).join("; ");

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept": url.endsWith(".js") ? "application/javascript,*/*;q=0.9" : "text/html,*/*;q=0.9",
            "Cookie": COOKIE,
            "Referer": "https://comix.to/",
        },
    });
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    return await res.text();
}

function sha12(s: string): string {
    return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function ensureHeader(): void {
    if (existsSync(CSV_PATH) && statSync(CSV_PATH).size > 0) return;
    appendFileSync(CSV_PATH, "ts,mainUrl,secureUrl,bundleSha,cfgSha,bundleBytes,bundleChanged\n");
}

function lastBundleSha(): string {
    if (!existsSync(CSV_PATH)) return "";
    const lines = readFileSync(CSV_PATH, "utf8").trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 1; i--) {
        const cols = lines[i]!.split(",");
        if (cols[3] && cols[3] !== "ERROR") return cols[3]!;
    }
    return "";
}

async function poll(): Promise<void> {
    const ts = new Date().toISOString();
    try {
        const html = await fetchText(PROBE_URL);
        const cfgM  = html.match(/<meta\s+name="cfg"\s+content="([^"]+)"/);
        const mainM = html.match(/src="([^"]*main-[a-zA-Z0-9_-]+\.js)"/);
        if (!cfgM || !mainM) throw new Error("could not parse cfg/main from homepage");

        const cfg = cfgM[1]!;
        const mainUrl = mainM[1]!;
        const mainText = await fetchText(mainUrl);
        const secM = mainText.match(/from\s*["']([^"']*secure-[a-zA-Z0-9_-]+\.js)["']/);
        if (!secM) throw new Error("could not find secure-*.js import in main bundle");
        const secureUrl = new URL(secM[1]!, mainUrl).href;

        const secureText = await fetchText(secureUrl);
        const bundleSha = sha12(secureText);
        const cfgSha    = sha12(cfg);
        const prev = lastBundleSha();
        const changed = prev && prev !== bundleSha ? "yes" : "";

        const line = `${ts},${mainUrl},${secureUrl},${bundleSha},${cfgSha},${secureText.length},${changed}\n`;
        appendFileSync(CSV_PATH, line);
        const tag = changed === "yes" ? "🔄 ROTATED" : "==";
        console.log(`[${ts}] ${tag} bundleSha=${bundleSha} cfgSha=${cfgSha} bytes=${secureText.length} url=${secureUrl}`);
    } catch (e: any) {
        const msg = (e?.message ?? String(e)).replace(/[,\n]/g, " ");
        appendFileSync(CSV_PATH, `${ts},,,ERROR,,,"${msg}"\n`);
        console.log(`[${ts}] ERROR ${msg}`);
    }
}

(async () => {
    ensureHeader();
    console.log(`[track] writing to ${CSV_PATH} every ${(POLL_MS/60000).toFixed(0)} min`);
    await poll();
    setInterval(poll, POLL_MS);
})();
