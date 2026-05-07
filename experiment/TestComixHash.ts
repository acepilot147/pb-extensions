/**
 * Diagnostic test for comix.to API access after the site redesign.
 *
 * Goals:
 *   1. Static correctness — verify the known v2 token still generates correctly.
 *   2. API base probe — try both /api/v2 and /api/v1/ to find which (if either) is live.
 *   3. Path-signing convention — for v1, try signing with both "/manga/..." and "/api/v1/manga/..."
 *      prefixes to find what the hash expects.
 *   4. Raw diagnostics — print HTTP status, key response headers, and a body snippet so you can
 *      observe bot-detection patterns (Cloudflare JS challenge, 403, HTML pages, etc.).
 *
 * Run with:
 *   npx tsx --env-file=.env experiment/TestComixHash.ts
 */

// ---------------------------------------------------------------------------
// Inline ComixHash (Buffer-based, Node.js) — mirrors src/ComixTo/ComixHash.ts
// ---------------------------------------------------------------------------

const KEYS: string[] = [
    "13YDu67uDgFczo3DnuTIURqas4lfMEPADY6Jaeqky+w=",
    "yEy7wBfBc+gsYPiQL/4Dfd0pIBZFzMwrtlRQGwMXy3Q=",
    "yrP+EVA1Dw==",
    "vZ23RT7pbSlxwiygkHd1dhToIku8SNHPC6V36L4cnwM=",
    "QX0sLahOByWLcWGnv6l98vQudWqdRI3DOXBdit9bxCE=",
    "WJwgqCmf",
    "BkWI8feqSlDZKMq6awfzWlUypl88nz65KVRmpH0RWIc=",
    "v7EIpiQQjd2BGuJzMbBA0qPWDSS+wTJRQ7uGzZ6rJKs=",
    "1SUReYlCRA==",
    "RougjiFHkSKs20DZ6BWXiWwQUGZXtseZIyQWKz5eG34=",
    "LL97cwoDoG5cw8QmhI+KSWzfW+8VehIh+inTxnVJ2ps=",
    "52iDqjzlqe8=",
    "U9LRYFL2zXU4TtALIYDj+lCATRk/EJtH7/y7qYYNlh8=",
    "e/GtffFDTvnw7LBRixAD+iGixjqTq9kIZ1m0Hj+s6fY=",
    "xb2XwHNB",
];

function getKeyBytes(i: number): number[] {
    try { return Array.from(Buffer.from(KEYS[i]!, "base64")).map(x => x & 0xFF); }
    catch { return []; }
}
function rc4(key: number[], data: number[]): number[] {
    if (!key.length) return [...data];
    const s = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) { j = (j + s[i]! + key[i % key.length]!) % 256; [s[i], s[j]] = [s[j]!, s[i]!]; }
    let i2 = 0, j2 = 0;
    const out = new Array(data.length);
    for (let k = 0; k < data.length; k++) {
        i2 = (i2 + 1) % 256; j2 = (j2 + s[i2]!) % 256;
        [s[i2], s[j2]] = [s[j2]!, s[i2]!];
        out[k] = data[k]! ^ s[(s[i2]! + s[j2]!) % 256]!;
    }
    return out;
}
const mutS = (e: number) => (e + 143) % 256;
const mutL = (e: number) => ((e >>> 1) | (e << 7)) & 255;
const mutC = (e: number) => (e + 115) % 256;
const mutM = (e: number) => (e ^ 177) & 255;
const mutF = (e: number) => (e - 188 + 256) % 256;
const mutG = (e: number) => ((e << 2) | (e >>> 6)) & 255;
const mutH = (e: number) => (e - 42 + 256) % 256;
const mutDollar = (e: number) => ((e << 4) | (e >>> 4)) & 255;
const mutB = (e: number) => (e - 12 + 256) % 256;
const mutUnderscore = (e: number) => (e - 20 + 256) % 256;
const mutY = (e: number) => ((e >>> 1) | (e << 7)) & 255;
const mutK = (e: number) => (e - 241 + 256) % 256;
const getMutKey = (mk: number[], idx: number) => mk.length > 0 && (idx % 32) < mk.length ? mk[idx % 32]! : 0;

function applyRound(
    data: number[], rc4KeyIdx: number, mutKeyIdx: number, prefKeyIdx: number,
    prefLimit: number,
    apply: (v: number, i: number) => number
): number[] {
    const enc = rc4(getKeyBytes(rc4KeyIdx), data);
    const mk = getKeyBytes(mutKeyIdx), pk = getKeyBytes(prefKeyIdx), out: number[] = [];
    for (let i = 0; i < enc.length; i++) {
        if (i < prefLimit && i < pk.length) out.push(pk[i]!);
        out.push(apply(enc[i]! ^ getMutKey(mk, i), i) & 255);
    }
    return out;
}

function round1(d: number[]) { return applyRound(d, 0, 1, 2, 7, (v, i) => { switch (i % 10) { case 0: case 9: return mutC(v); case 1: return mutB(v); case 2: return mutY(v); case 3: return mutDollar(v); case 4: case 6: return mutH(v); case 5: return mutS(v); case 7: return mutK(v); case 8: return mutL(v); } return v; }); }
function round2(d: number[]) { return applyRound(d, 3, 4, 5, 6, (v, i) => { switch (i % 10) { case 0: case 8: return mutC(v); case 1: return mutB(v); case 2: case 6: return mutDollar(v); case 3: return mutH(v); case 4: case 9: return mutS(v); case 5: return mutK(v); case 7: return mutUnderscore(v); } return v; }); }
function round3(d: number[]) { return applyRound(d, 6, 7, 8, 7, (v, i) => { switch (i % 10) { case 0: return mutC(v); case 1: return mutF(v); case 2: case 8: return mutS(v); case 3: return mutG(v); case 4: return mutY(v); case 5: return mutM(v); case 6: return mutDollar(v); case 7: return mutK(v); case 9: return mutB(v); } return v; }); }
function round4(d: number[]) { return applyRound(d, 9, 10, 11, 8, (v, i) => { switch (i % 10) { case 0: return mutB(v); case 1: case 9: return mutM(v); case 2: case 7: return mutL(v); case 3: case 5: return mutS(v); case 4: case 6: return mutUnderscore(v); case 8: return mutY(v); } return v; }); }
function round5(d: number[]) { return applyRound(d, 12, 13, 14, 6, (v, i) => { switch (i % 10) { case 0: return mutUnderscore(v); case 1: case 7: return mutS(v); case 2: return mutC(v); case 3: case 5: return mutM(v); case 4: return mutB(v); case 6: return mutF(v); case 8: return mutDollar(v); case 9: return mutG(v); } return v; }); }

function generateHash(path: string, bodySize: number, time: number): string {
    const encoded = encodeURIComponent(`${path}:${bodySize}:${time}`)
        .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    let data: number[] = [];
    for (let i = 0; i < encoded.length; i++) data.push(encoded.charCodeAt(i) & 0xFF);
    data = round1(data); data = round2(data); data = round3(data); data = round4(data); data = round5(data);
    return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ---------------------------------------------------------------------------
// Signing helpers for each base/convention combination
// ---------------------------------------------------------------------------

/**
 * Sign for v2 convention: path stripped of /api/v2 prefix.
 * Produces: ?time=1&_=<token>
 */
function signV2(url: string, apiBase: string): string {
    const path = url.replace(apiBase, "").split("?")[0];
    const token = generateHash(path, 0, 1);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}time=1&_=${token}`;
}

/**
 * Sign for v1 convention A: path stripped of domain only ("/api/v1/...").
 * In case the hash now includes the /api/v1 prefix.
 */
function signV1WithPrefix(url: string): string {
    const path = url.replace("https://comix.to", "").split("?")[0];
    const token = generateHash(path, 0, 1);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}time=1&_=${token}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const HEADERS = {
    "Referer": "https://comix.to/",
    "User-Agent": process.env.USER_AGENT ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Cookie": `cf_clearance=${process.env.CF_CLEARANCE ?? ""}`,
    "Accept": "application/json, text/html, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
};

interface ProbeResult {
    label: string;
    url: string;
    status: number;
    contentType: string;
    cfRay: string;
    bodySnippet: string;
    isJson: boolean;
    jsonStatus?: number;
    blocked: boolean;
    error?: string;
}

async function probe(label: string, rawUrl: string): Promise<ProbeResult> {
    const result: ProbeResult = {
        label,
        url: rawUrl,
        status: 0,
        contentType: "",
        cfRay: "",
        bodySnippet: "",
        isJson: false,
        blocked: false,
    };

    try {
        const res = await fetch(rawUrl, {
            method: "GET",
            headers: HEADERS,
            // @ts-ignore — Node 18+ fetch supports redirect
            redirect: "follow",
        });

        result.status = res.status;
        result.contentType = res.headers.get("content-type") ?? "";
        result.cfRay = res.headers.get("cf-ray") ?? "";

        const raw = await res.text();
        result.bodySnippet = raw.slice(0, 400).replace(/\s+/g, " ").trim();

        result.blocked = res.status === 403 || res.status === 503 ||
            raw.toLowerCase().includes("just a moment") ||
            raw.toLowerCase().includes("enable javascript") ||
            raw.toLowerCase().includes("cloudflare") && res.status !== 200;

        const lct = result.contentType.toLowerCase();
        if (lct.includes("application/json") || (lct.includes("text") && raw.trimStart().startsWith("{"))) {
            try {
                const parsed = JSON.parse(raw) as any;
                result.isJson = true;
                result.jsonStatus = parsed?.status;
            } catch { /* not valid JSON */ }
        }
    } catch (err: any) {
        result.error = String(err?.message ?? err);
        result.blocked = true;
    }

    return result;
}

function printProbe(r: ProbeResult) {
    const icon = r.blocked ? "🚫" : r.status === 200 ? "✅" : r.status === 0 ? "💥" : "⚠️";
    console.log(`\n  ${icon}  ${r.label}`);
    console.log(`     URL:          ${r.url}`);
    console.log(`     Status:       ${r.status}`);
    console.log(`     Content-Type: ${r.contentType || "(none)"}`);
    if (r.cfRay) console.log(`     CF-Ray:       ${r.cfRay}`);
    if (r.isJson) console.log(`     JSON status:  ${r.jsonStatus ?? "(no .status field)"}`);
    if (r.error) console.log(`     Error:        ${r.error}`);
    console.log(`     Body snippet: ${r.bodySnippet || "(empty)"}`);
    if (r.blocked) console.log(`     ⚠  Bot-detection or block detected`);
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const API_V2 = "https://comix.to/api/v2";
const API_V1 = "https://comix.to/api/v1";

// A stable manga slug used for path-specific tests
const TEST_SLUG = "55kym";

const KNOWN_V2_TOKEN = "xQm9tJfLwGhz_0Eq8S_YAHYkwp-q1PLfm50W5QJnyd1NnNYpAjXjyCoAzoOLru8aI60xWS0NeDGz_rNrbqBjLLP1H9qi";

(async () => {
    console.log("=== ComixTo API Diagnostic — v1 vs v2 probe ===");
    console.log(`Timestamp: ${new Date().toISOString()}\n`);

    // -----------------------------------------------------------------------
    // 1. Static hash correctness (unchanged algorithm check)
    // -----------------------------------------------------------------------
    console.log("─────────────────────────────────────────────────────────");
    console.log("1. Static hash correctness (v2 known-good token)");
    const computed = generateHash("/manga/55kym/chapters", 0, 1);
    const hashMatch = computed === KNOWN_V2_TOKEN;
    console.log(`   Expected: ${KNOWN_V2_TOKEN}`);
    console.log(`   Got:      ${computed}`);
    console.log(`   Match:    ${hashMatch ? "✅ YES — algorithm unchanged" : "❌ NO — algorithm or keys may have changed"}`);

    // Show what v1-path convention hashes would look like (useful for comparison)
    const hashV1WithPrefix = generateHash("/api/v1/manga/55kym/chapters", 0, 1);
    console.log(`\n   Hash with /api/v1 prefix in path: ${hashV1WithPrefix}`);
    console.log(`   (This is what we'd need if v1 uses full-path signing)`);

    // -----------------------------------------------------------------------
    // 2. Baseline — no token, just check if the site is up
    // -----------------------------------------------------------------------
    console.log("\n─────────────────────────────────────────────────────────");
    console.log("2. Baseline reachability (no token)");

    const results: ProbeResult[] = [];

    results.push(await probe(
        "GET /api/v2/manga (no token)",
        `${API_V2}/manga?limit=5`
    ));
    results.push(await probe(
        "GET /api/v1/manga (no token)",
        `${API_V1}/manga?limit=5`
    ));
    results.push(await probe(
        "GET /api/v1 chapters (no token)",
        `${API_V1}/manga/${TEST_SLUG}/chapters?limit=5&page=1&order[number]=desc`
    ));
    results.push(await probe(
        "GET /api/v1 trending (no token)",
        `${API_V1}/top?type=trending&days=30&limit=5`
    ));

    results.forEach(printProbe);

    // -----------------------------------------------------------------------
    // 3. v2 base — signed with current (v2) path convention
    // -----------------------------------------------------------------------
    console.log("\n─────────────────────────────────────────────────────────");
    console.log("3. API v2 base — signed (current path convention, strip /api/v2)");

    const v2MangaUrl = `${API_V2}/manga/${TEST_SLUG}/chapters?limit=5&page=1&order[number]=desc`;
    results.push(await probe(
        "v2 chapters — v2-path signed",
        signV2(v2MangaUrl, API_V2)
    ));

    const v2TopUrl = `${API_V2}/top?type=trending&days=30&limit=5`;
    results.push(await probe(
        "v2 trending — v2-path signed",
        signV2(v2TopUrl, API_V2)
    ));

    results.slice(-2).forEach(printProbe);

    // -----------------------------------------------------------------------
    // 4. v1 base — signed with v2 path convention (strip /api/v1)
    // -----------------------------------------------------------------------
    console.log("\n─────────────────────────────────────────────────────────");
    console.log("4. API v1 base — signed with v2 path convention (strip /api/v1)");

    const v1MangaUrl = `${API_V1}/manga/${TEST_SLUG}/chapters?limit=5&page=1&order[number]=desc`;
    results.push(await probe(
        "v1 chapters — v2-path signed (strip /api/v1)",
        signV2(v1MangaUrl, API_V1)
    ));

    const v1TopUrl = `${API_V1}/top?type=trending&days=30&limit=5`;
    results.push(await probe(
        "v1 trending — v2-path signed (strip /api/v1)",
        signV2(v1TopUrl, API_V1)
    ));

    results.slice(-2).forEach(printProbe);

    // -----------------------------------------------------------------------
    // 5. v1 base — signed with full /api/v1/... path (alternative convention)
    // -----------------------------------------------------------------------
    console.log("\n─────────────────────────────────────────────────────────");
    console.log("5. API v1 base — signed with full /api/v1/... path (alternative convention)");

    results.push(await probe(
        "v1 chapters — full-path signed (/api/v1/manga/...)",
        signV1WithPrefix(`${API_V1}/manga/${TEST_SLUG}/chapters?limit=5&page=1&order[number]=desc`)
    ));

    results.push(await probe(
        "v1 trending — full-path signed (/api/v1/top)",
        signV1WithPrefix(`${API_V1}/top?type=trending&days=30&limit=5`)
    ));

    results.slice(-2).forEach(printProbe);

    // -----------------------------------------------------------------------
    // 6. Summary table
    // -----------------------------------------------------------------------
    console.log("\n─────────────────────────────────────────────────────────");
    console.log("Summary");
    console.log("─────────────────────────────────────────────────────────");

    const working = results.filter(r => !r.blocked && r.status === 200 && r.isJson && r.jsonStatus === 200);
    const partial = results.filter(r => !r.blocked && r.status === 200 && !working.includes(r));
    const blocked = results.filter(r => r.blocked || r.status === 403 || r.status === 503);

    console.log(`\n✅ Working (HTTP 200 + JSON status 200):`);
    if (working.length === 0) console.log("   (none)");
    working.forEach(r => console.log(`   • ${r.label}`));

    console.log(`\n⚠️  Partial (HTTP 200 but unexpected JSON):`);
    if (partial.length === 0) console.log("   (none)");
    partial.forEach(r => console.log(`   • ${r.label}  [jsonStatus=${r.jsonStatus ?? "N/A"}, isJson=${r.isJson}]`));

    console.log(`\n🚫 Blocked / errored:`);
    if (blocked.length === 0) console.log("   (none)");
    blocked.forEach(r => console.log(`   • ${r.label}  [HTTP ${r.status}]`));

    // Recommendation
    console.log("\n─────────────────────────────────────────────────────────");
    console.log("Recommendation");
    if (working.some(r => r.label.startsWith("v2"))) {
        console.log("→ API v2 is still live and working. No base change needed.");
        if (!hashMatch) console.log("→ Hash mismatch detected — keys or algorithm may have rotated.");
    } else if (working.some(r => r.label.includes("v2-path signed") && r.label.startsWith("v1"))) {
        console.log("→ API moved to v1 but still uses the v2 PATH signing convention.");
        console.log("→ Update API_BASE to /api/v1 and keep signUrl path-stripping as-is.");
    } else if (working.some(r => r.label.includes("full-path signed") && r.label.startsWith("v1"))) {
        console.log("→ API moved to v1 and now uses full /api/v1/... path for signing.");
        console.log("→ Update API_BASE to /api/v1 AND update signUrl to strip only the domain.");
    } else {
        console.log("→ No combination returned a clean JSON 200. Possible causes:");
        console.log("   • CF_CLEARANCE cookie is expired or missing — get a fresh one from the browser.");
        console.log("   • Comix.to is down, changed domain, or added JS-challenge bot detection.");
        console.log("   • Hash keys have been rotated — check browser devtools Network tab for the _ param.");
        console.log(`   • USER_AGENT env var not set (current: ${process.env.USER_AGENT ? "SET" : "NOT SET"})`);
        console.log(`   • CF_CLEARANCE env var not set (current: ${process.env.CF_CLEARANCE ? "SET" : "NOT SET"})`);
    }
    console.log("─────────────────────────────────────────────────────────\n");
})();
