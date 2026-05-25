export {};

/**
 * End-to-end validation of the embedded bundle by calling
 * ComixBundleRuntime.signPath / decryptPayload — the exact entry points the
 * extension uses at runtime. If this passes here, only Paperback-specific
 * runtime quirks would cause it to fail in the app.
 */

try {
    if (typeof (process as any).loadEnvFile === "function") {
        (process as any).loadEnvFile();
    }
} catch {}

import { signPath, decryptPayload, getBundleInfo } from "../src/ComixTo/ComixBundleRuntime";

function log(...a: any[]) { process.stdout.write("[validate] " + a.map(String).join(" ") + "\n"); }

const UA = process.env.USER_AGENT ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const COOKIE = [
    process.env.SESSION ? `session=${process.env.SESSION}` : "",
    process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
].filter(Boolean).join("; ");

async function main(): Promise<void> {
    process.on("uncaughtException", (e) => log("uncaughtException:", (e as any)?.message ?? e));

    const info = getBundleInfo();
    log("bundleId:", info.bundleId, "fetchedAt:", info.fetchedAt);
    log("secureUrl:", info.secureUrl);

    // Try each of the three signed path patterns
    const paths = ["/manga/xlyyj/chapters", "/chapters/9000025", "/manga/k927/chapters"];
    for (const p of paths) {
        const tok = signPath(p);
        log(`  sign ${p} -> ${tok || "(no token)"}`);
    }

    // Live fetch + decrypt cycle
    const token = signPath("/chapters/9000025");
    if (!token) throw new Error("signPath returned no token");
    const apiUrl = `https://comix.to/api/v1/chapters/9000025?_=${encodeURIComponent(token)}`;
    log("fetching", apiUrl);

    const apiRes = await fetch(apiUrl, {
        headers: {
            "User-Agent": UA,
            "Cookie": COOKIE,
            "Referer": "https://comix.to/",
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
        },
    });
    log("status:", apiRes.status);
    if (apiRes.status !== 200) {
        log("body:", (await apiRes.text()).slice(0, 200));
        throw new Error(`live API returned ${apiRes.status}`);
    }
    const respText = await apiRes.text();
    const respJson = JSON.parse(respText);
    log("response keys:", Object.keys(respJson).join(","));
    if (!("e" in respJson)) throw new Error("response was not encrypted — signing produced an invalid token");

    const headers: Record<string, string> = {};
    apiRes.headers.forEach((v, k) => { headers[k] = v; });
    const data = decryptPayload(respJson, headers);
    if (!data || typeof data !== "object") throw new Error("decryption returned non-object");
    log("decrypted top-level keys:", Object.keys(data).slice(0, 12).join(","));
    if (!("id" in data)) throw new Error("decryption produced unexpected shape");

    log("OK end-to-end (sandbox + with(__sb) path)");
    process.exit(0);
}

main().catch((e) => { log("FAILED:", e?.message ?? e); process.exit(1); });
