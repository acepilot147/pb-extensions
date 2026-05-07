export {};

/**
 * Probe the new comix.to /api/v1 surface.
 *
 * Focuses on three open questions left after TestComixHash.ts:
 *   1. Does removing "time=1" from the URL (keeping it in the hash) fix the 403?
 *   2. What endpoint replaced /top for trending/popular?
 *   3. What are the exact camelCase field names in v1 responses?
 *      (manga list, manga detail, chapter list, chapter pages, terms/genres)
 *
 * Run with:
 *   npx tsx --env-file=.env experiment/ProbeV1API.ts
 */

// ---------------------------------------------------------------------------
// ComixHash inline (unchanged from TestComixHash — algorithm still correct)
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

function applyRound(data: number[], rc4KeyIdx: number, mutKeyIdx: number, prefKeyIdx: number, prefLimit: number, apply: (v: number, i: number) => number): number[] {
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
    return hashEncoded(encoded);
}

/** Hash a pre-encoded string directly (no `:bodySize:time` formatting). */
function hashEncoded(encoded: string): string {
    let data: number[] = [];
    for (let i = 0; i < encoded.length; i++) data.push(encoded.charCodeAt(i) & 0xFF);
    data = round1(data); data = round2(data); data = round3(data); data = round4(data); data = round5(data);
    return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Sign for v1: strip /api/v1 prefix, hash encodeURIComponent(path) — NO :bodySize:time suffix */
function signV1(url: string): string {
    const path = url.replace("https://comix.to/api/v1", "").split("?")[0];
    const token = hashEncoded(encodeURIComponent(path));
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_=${token}`;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

const CF_CLEARANCE = process.env.CF_CLEARANCE ?? "";
const USER_AGENT   = process.env.USER_AGENT ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// Populated at runtime via /api/v1/user — expires every 2 hours.
let sessionCookie = process.env.SESSION ?? "";

function buildCookie(): string {
    const parts: string[] = [];
    if (sessionCookie) parts.push(`session=${sessionCookie}`);
    if (CF_CLEARANCE)  parts.push(`cf_clearance=${CF_CLEARANCE}`);
    return parts.join("; ");
}

function baseHeaders(): Record<string, string> {
    return {
        "Referer": "https://comix.to/",
        "User-Agent": USER_AGENT,
        "Cookie": buildCookie(),
        "Accept": "application/json",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-requested-with": "XMLHttpRequest",
    };
}

async function get(url: string): Promise<{ status: number; body: string; ct: string }> {
    try {
        const res = await fetch(url, { method: "GET", headers: baseHeaders() });
        const body = await res.text();
        return { status: res.status, body, ct: res.headers.get("content-type") ?? "" };
    } catch (e: any) {
        return { status: 0, body: String(e?.message ?? e), ct: "" };
    }
}

/**
 * Hit /api/v1/user — the first call the site makes on load.
 * The server issues a fresh session cookie (2h expiry) in the Set-Cookie response header.
 * Falls back to SESSION env var if the request fails or returns no cookie.
 */
async function acquireSession(): Promise<void> {
    if (sessionCookie) {
        console.log(`  ✅ Using SESSION from .env: ${sessionCookie.slice(0, 20)}...`);
        return;
    }
    console.log("  SESSION not in .env — calling /api/v1/user to obtain fresh session cookie...");
    try {
        const res = await fetch("https://comix.to/api/v1/user", {
            method: "GET",
            headers: {
                "User-Agent": USER_AGENT,
                "Cookie": CF_CLEARANCE ? `cf_clearance=${CF_CLEARANCE}` : "",
                "Accept": "application/json",
                "x-requested-with": "XMLHttpRequest",
                "Referer": "https://comix.to/",
            },
        });

        const setCookies: string[] = [];
        // @ts-ignore — getSetCookie() is Node 18.14+
        if (typeof (res.headers as any).getSetCookie === "function") {
            setCookies.push(...(res.headers as any).getSetCookie());
        } else {
            res.headers.forEach((v, k) => { if (k.toLowerCase() === "set-cookie") setCookies.push(v); });
        }

        console.log(`  /api/v1/user → HTTP ${res.status}, Set-Cookie headers: ${setCookies.length}`);
        for (const h of setCookies) {
            console.log(`    → ${h}`);
            const m = h.match(/^session=([^;]+)/i);
            if (m) {
                sessionCookie = m[1]!;
                console.log(`  ✅ Fresh session captured: ${sessionCookie.slice(0, 20)}...`);
            }
        }

        if (!sessionCookie) {
            console.log("  ⚠  No session in Set-Cookie — falling back to SESSION env var");
        }
    } catch (e: any) {
        console.log(`  💥 /api/v1/user request failed: ${e?.message ?? e}`);
        console.log("  ⚠  Falling back to SESSION env var");
    }
}

function tryJson(body: string): any {
    try { return JSON.parse(body); } catch { return null; }
}

function pretty(obj: any, indent = 2): string {
    return JSON.stringify(obj, null, indent);
}

/** Print the top-level keys and the keys of the first item in result.items */
function dumpSchema(label: string, json: any) {
    console.log(`\n  📋 Schema dump — ${label}`);
    if (!json) { console.log("     (null response)"); return; }
    console.log(`     Top-level keys: ${Object.keys(json).join(", ")}`);
    if (json.status !== undefined) console.log(`     status value: ${JSON.stringify(json.status)}`);
    if (json.result) {
        console.log(`     result keys: ${Object.keys(json.result).join(", ")}`);
        const items = json.result?.items ?? (Array.isArray(json.result) ? json.result : null);
        if (items?.length) {
            console.log(`     items[0] keys: ${Object.keys(items[0]).join(", ")}`);
            console.log(`     items[0] sample:\n${pretty(items[0]).split("\n").map(l => "       " + l).join("\n")}`);
        } else if (json.result && typeof json.result === "object" && !Array.isArray(json.result)) {
            // Single object result (manga detail, chapter pages, etc.)
            const topKeys = Object.keys(json.result);
            console.log(`     result (single object) keys: ${topKeys.join(", ")}`);
            // Print a subset to avoid flooding the terminal
            const preview: any = {};
            for (const k of topKeys.slice(0, 12)) preview[k] = json.result[k];
            console.log(`     result preview:\n${pretty(preview).split("\n").map(l => "       " + l).join("\n")}`);
        }
    }
}

const API = "https://comix.to/api/v1";
const TEST_SLUG = "ll172"; // stable test manga

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
    console.log("=== ProbeV1API — comix.to /api/v1 field & endpoint survey ===");
    console.log(`Timestamp: ${new Date().toISOString()}\n`);

    // -------------------------------------------------------------------------
    // 0. Session cookie acquisition
    // -------------------------------------------------------------------------
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("0. Session cookie acquisition");
    await acquireSession();
    console.log(`   sessionCookie: ${sessionCookie ? sessionCookie.slice(0, 20) + "..." : "NOT SET ⚠"}`);
    console.log(`   CF_CLEARANCE:  ${CF_CLEARANCE ? CF_CLEARANCE.slice(0, 20) + "..." : "NOT SET ⚠"}`);

    // -------------------------------------------------------------------------
    // 1. KEY FIX: v1 chapters with just _=token (no time=1 in URL)
    // -------------------------------------------------------------------------
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("1. Chapters — hash path hypothesis check + live fetch");

    const BROWSER_HASH    = "xQm9tJfLwGhz_0Eq8S_YAHYkwp-q1PLfm50W5QJnyd1NnNYpAjXjyCoAzoOL-EXkCToxWS0NeDGz_rNrbg";
    const fullPath        = `/manga/${TEST_SLUG}/chapters`;

    const hashFullWithSuffix = generateHash(fullPath, 0, 1);                 // path:0:1 (v2 style)
    const hashStripped       = generateHash(`/${TEST_SLUG}/chapters`, 0, 1); // /ll172/chapters:0:1
    const hashJustPath       = hashEncoded(encodeURIComponent(fullPath));    // hypothesis: just the encoded path
    const hashJustPathRaw    = hashEncoded(fullPath);                         // hypothesis: path, not encoded

    console.log(`   Browser hash:                          ${BROWSER_HASH}`);
    console.log(`   hash(/manga/ll172/chapters:0:1):       ${hashFullWithSuffix}  ${hashFullWithSuffix === BROWSER_HASH ? "✅" : "❌"}`);
    console.log(`   hash(/ll172/chapters:0:1):             ${hashStripped}  ${hashStripped === BROWSER_HASH ? "✅" : "❌"}`);
    console.log(`   hash(encodeURIComponent(/manga/...)):  ${hashJustPath}  ${hashJustPath === BROWSER_HASH ? "✅" : "❌"}`);
    console.log(`   hash(/manga/ll172/chapters raw):       ${hashJustPathRaw}  ${hashJustPathRaw === BROWSER_HASH ? "✅" : "❌"}`);

    // Build URL using whichever variant matched
    let winningToken: string | null = null;
    if (hashJustPath === BROWSER_HASH)         winningToken = hashJustPath;
    else if (hashJustPathRaw === BROWSER_HASH) winningToken = hashJustPathRaw;
    else if (hashStripped === BROWSER_HASH)    winningToken = hashStripped;
    else if (hashFullWithSuffix === BROWSER_HASH) winningToken = hashFullWithSuffix;

    const tokenForFetch = winningToken ?? hashFullWithSuffix;
    console.log(`\n   → Using token: ${winningToken ? "MATCHED variant" : "fallback (full path:0:1)"}`);
    const chapUrl = `${API}/manga/${TEST_SLUG}/chapters?page=1&limit=20&order[number]=desc&_=${tokenForFetch}`;
    console.log(`   URL: ${chapUrl}`);
    const chapRes = await get(chapUrl);
    const chapJson = tryJson(chapRes.body);
    const chapOk = chapRes.status === 200 && chapJson?.status === "ok";
    console.log(`   HTTP ${chapRes.status}  JSON status: ${chapJson?.status ?? "(none)"}  ${chapOk ? "✅ WORKING" : "❌ STILL FAILING"}`);
    if (chapOk) dumpSchema("Chapter list item", chapJson);
    else console.log(`   Body: ${chapRes.body.slice(0, 300)}`);

    // -------------------------------------------------------------------------
    // 2. Manga list (open endpoint — no token needed, but we still sign it)
    // -------------------------------------------------------------------------
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("2. Manga list fields (camelCase audit)");

    const listUrl = signV1(`${API}/manga?limit=3&order[chapter_updated_at]=desc`);
    const listRes = await get(listUrl);
    const listJson = tryJson(listRes.body);
    console.log(`   HTTP ${listRes.status}  JSON status: ${listJson?.status ?? "(none)"}`);
    dumpSchema("Manga list", listJson);

    // -------------------------------------------------------------------------
    // 3. Manga detail — compare signed vs unsigned to see if signing is required
    // -------------------------------------------------------------------------
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("3. Manga detail fields — signed vs unsigned comparison");

    const detailRaw    = `${API}/manga/${TEST_SLUG}?includes[]=author&includes[]=artist`;
    const detailSigned = signV1(detailRaw);

    console.log("\n   --- 3a. UNSIGNED (no _=<token>) ---");
    console.log(`   URL: ${detailRaw}`);
    const detailUnsignedRes  = await get(detailRaw);
    const detailUnsignedJson = tryJson(detailUnsignedRes.body);
    const unsignedOk = detailUnsignedRes.status === 200 && detailUnsignedJson?.status === "ok";
    console.log(`   HTTP ${detailUnsignedRes.status}  JSON status: ${detailUnsignedJson?.status ?? "(none)"}  ${unsignedOk ? "✅" : "❌"}`);
    if (!unsignedOk) console.log(`   Body: ${detailUnsignedRes.body.slice(0, 300)}`);

    console.log("\n   --- 3b. SIGNED (_=<token> appended) ---");
    console.log(`   URL: ${detailSigned}`);
    const detailSignedRes  = await get(detailSigned);
    const detailSignedJson = tryJson(detailSignedRes.body);
    const signedOk = detailSignedRes.status === 200 && detailSignedJson?.status === "ok";
    console.log(`   HTTP ${detailSignedRes.status}  JSON status: ${detailSignedJson?.status ?? "(none)"}  ${signedOk ? "✅" : "❌"}`);
    if (!signedOk) console.log(`   Body: ${detailSignedRes.body.slice(0, 300)}`);

    console.log("\n   --- 3c. Verdict ---");
    if (unsignedOk && signedOk)        console.log("   ✅ Both work — signing is NOT required for manga detail.");
    else if (!unsignedOk && signedOk)  console.log("   🔒 Only signed works — signing IS required for manga detail.");
    else if (unsignedOk && !signedOk)  console.log("   ⚠  Unsigned works but signed fails — signV1 may be malformed for this route.");
    else                                console.log("   ❌ Both failed — likely a session/CF_CLEARANCE issue, not signing.");

    // Use whichever succeeded for the schema dump and downstream tag inspection
    const detailJson = signedOk ? detailSignedJson : detailUnsignedJson;
    dumpSchema("Manga detail", detailJson);

    // Dump shape of embedded tag arrays so we know the field name (name vs label)
    if (detailJson?.status === "ok") {
        const r = detailJson.result;
        for (const arrName of ["genres", "tags", "demographics", "formats", "authors", "artists"]) {
            const arr = r?.[arrName];
            if (Array.isArray(arr) && arr.length) {
                console.log(`   ${arrName}[0]: ${pretty(arr[0])}`);
            } else {
                console.log(`   ${arrName}: ${arr === undefined ? "(missing)" : "(empty)"}`);
            }
        }
    }

    // -------------------------------------------------------------------------
    // 4. Chapter pages (need a valid chapter hid — grab one from the list)
    // -------------------------------------------------------------------------
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("4. Chapter pages fields");

    let chapterHid: string | null = null;
    if (chapOk && chapJson?.result?.items?.length) {
        const first = chapJson.result.items[0];
        // Might be first.hid, first.id, first.hash_id, first.chapter_id — print all to find it
        console.log(`   First chapter item keys: ${Object.keys(first).join(", ")}`);
        console.log(`   First chapter item: ${pretty(first)}`);
        chapterHid = first.hid ?? first.hash_id ?? String(first.id ?? first.chapter_id ?? "");
    } else if (chapJson?.result?.items?.length) {
        const first = chapJson.result.items[0];
        console.log(`   First chapter item keys: ${Object.keys(first).join(", ")}`);
        chapterHid = first.hid ?? first.hash_id ?? String(first.id ?? "");
    }

    if (chapterHid) {
        console.log(`   Using chapter hid: ${chapterHid}`);
        const pagesUrl = signV1(`${API}/chapters/${chapterHid}`);
        const r = await get(pagesUrl);
        const j = tryJson(r.body);
        console.log(`   URL: ${pagesUrl}`);
        console.log(`   HTTP ${r.status}  JSON status: ${j?.status ?? "(none)"}`);
        if (j?.status === "ok") {
            console.log(`   result top-level keys: ${j.result ? Object.keys(j.result).join(", ") : "(no result)"}`);
            console.log(`   Full result:\n${pretty(j.result).split("\n").slice(0, 60).map(l => "     " + l).join("\n")}`);
        } else {
            console.log(`   Body: ${r.body.slice(0, 400)}`);
        }
    } else {
        console.log("   Skipped — could not determine chapter hid from step 1");
    }

    // -------------------------------------------------------------------------
    // 5. Terms / genres replacement candidates
    // -------------------------------------------------------------------------
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("5. Tag/genre list endpoint candidates");

    const termCandidates = [
        `${API}/tags/search?type=genre&limit=50`,
        `${API}/tags/search?type=theme&limit=50`,
        `${API}/tags/search?type=tag&limit=50`,
        `${API}/tags/search?type=format&limit=50`,
        `${API}/tags/search?type=demographic&limit=50`,
    ];
    for (const url of termCandidates) {
        const signed = signV1(url);
        const r = await get(signed);
        const j = tryJson(r.body);
        const itemCount = Array.isArray(j?.result?.items) ? j.result.items.length
                          : Array.isArray(j?.result) ? j.result.length
                          : Array.isArray(j?.result?.genres) ? j.result.genres.length
                          : -1;
        const ok = r.status === 200 && j?.status === "ok" && itemCount > 0;
        const icon = ok ? "✅" : (r.status === 200 ? "⚠️ " : "❌");
        console.log(`   ${icon}  HTTP ${r.status}  items=${itemCount >= 0 ? itemCount : "N/A"}  — ${url.replace(API, "")}`);
        if (ok) {
            console.log(`        result keys: ${j.result ? Object.keys(j.result).join(", ") : "(none)"}`);
            const firstItem = j.result?.items?.[0] ?? (Array.isArray(j.result) ? j.result[0] : null);
            if (firstItem) console.log(`        first item: ${pretty(firstItem)}`);
        } else if (r.status === 200) {
            console.log(`        body: ${r.body.slice(0, 200)}`);
        }
    }

    // -------------------------------------------------------------------------
    // 6. Trending endpoint candidates — find what replaced /top
    // -------------------------------------------------------------------------
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("6. Trending endpoint replacement candidates");

    const candidates = [
        { label: "/top (old, expect 404)",          url: `${API}/top?type=trending&days=30&limit=5` },
        { label: "/trending",                        url: `${API}/trending?limit=5` },
        { label: "/popular",                         url: `${API}/popular?limit=5` },
        { label: "/manga/trending",                  url: `${API}/manga/trending?limit=5` },
        { label: "/manga?order[views_30d]=desc",     url: `${API}/manga?order[views_30d]=desc&limit=5` },
        { label: "/manga?order[views_7d]=desc",      url: `${API}/manga?order[views_7d]=desc&limit=5` },
        { label: "/manga?order[follows_total]=desc", url: `${API}/manga?order[follows_total]=desc&limit=5` },
        { label: "/manga?order[rated_avg]=desc",     url: `${API}/manga?order[rated_avg]=desc&limit=5` },
        { label: "/manga?type=trending",             url: `${API}/manga?type=trending&limit=5` },
    ];

    for (const c of candidates) {
        const signed = signV1(c.url);
        const r = await get(signed);
        const j = tryJson(r.body);
        const hasItems = Array.isArray(j?.result?.items) && j.result.items.length > 0;
        const icon = r.status === 200 && j?.status === "ok" && hasItems ? "✅" :
                     r.status === 200 ? "⚠️ " : "❌";
        console.log(`   ${icon}  HTTP ${r.status}  items=${hasItems ? j.result.items.length : "N/A"}  — ${c.label}`);
        if (r.status !== 200 && r.status !== 404) console.log(`        body: ${r.body.slice(0, 100)}`);
    }

    // -------------------------------------------------------------------------
    // 7. Search keyword — try multiple endpoints/params, print actual results
    // -------------------------------------------------------------------------
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("7. Search results — endpoint & param comparison");

    const searchTerm = "Infinite mage";
    const searchCandidates = [
        { label: "limit=10 (probe-style)",         url: `${API}/manga?order[relevance]=desc&page=1&limit=10&keyword=${encodeURIComponent(searchTerm)}&genres_mode=and` },
        { label: "limit=20 (Paperback-style)",     url: `${API}/manga?order[relevance]=desc&page=1&limit=20&keyword=${encodeURIComponent(searchTerm)}&genres_mode=and` },
        { label: "limit=20 + _cb (full Paperback)", url: `${API}/manga?order[relevance]=desc&page=1&limit=20&keyword=${encodeURIComponent(searchTerm)}&genres_mode=and&_cb=${Date.now()}` },
        { label: "limit=20 + brackets URL-encoded", url: `${API}/manga?order%5Brelevance%5D=desc&page=1&limit=20&keyword=${encodeURIComponent(searchTerm)}&genres_mode=and` },
    ];

    for (const c of searchCandidates) {
        const signed = signV1(c.url);
        const r = await get(signed);
        const j = tryJson(r.body);
        const items: any[] = Array.isArray(j?.result?.items) ? j.result.items
                            : Array.isArray(j?.result) ? j.result
                            : [];
        const ok = r.status === 200 && j?.status === "ok";
        const icon = ok && items.length > 0 ? "✅" : ok ? "⚠️ " : "❌";
        console.log(`\n   ${icon}  HTTP ${r.status}  items=${items.length}  — ${c.label}`);
        if (!ok && r.status !== 404) console.log(`      body: ${r.body.slice(0, 150)}`);
        if (ok && items.length > 0) {
            for (let i = 0; i < Math.min(items.length, 5); i++) {
                const it = items[i];
                console.log(`      ${i + 1}. ${it.title ?? "(no title)"}  [hid=${it.hid ?? "?"}, type=${it.type ?? "?"}]`);
            }
        }
    }

    // Mimic Paperback's request: NO cookies at all
    console.log(`\n   --- Mimicking Paperback (no Cookie header at all) ---`);
    const naked = signV1(`${API}/manga?order[relevance]=desc&page=1&limit=20&keyword=${encodeURIComponent(searchTerm)}&genres_mode=and`);
    const nakedRes = await fetch(naked, {
        method: "GET",
        headers: {
            "Referer": "https://comix.to/",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    });
    const nakedBody = await nakedRes.text();
    const nakedJson = tryJson(nakedBody);
    console.log(`   HTTP ${nakedRes.status}  status=${nakedJson?.status}`);
    if (nakedJson?.status === "ok" && Array.isArray(nakedJson.result?.items)) {
        for (let i = 0; i < Math.min(5, nakedJson.result.items.length); i++) {
            const it = nakedJson.result.items[i];
            console.log(`      ${i + 1}. ${it.title}  [hid=${it.hid}]`);
        }
    } else {
        console.log(`      body: ${nakedBody.slice(0, 300)}`);
    }

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("Summary of key findings");
    console.log("  • Chapters fix (no time=1):   " + (chapOk ? "✅ confirmed working" : "❌ still broken — re-check CF_CLEARANCE"));
    console.log("  • API base:                    https://comix.to/api/v1");
    console.log("  • signUrl change:              strip /api/v1, append _=<token> only (no time=1)");
    console.log("  • JSON .status field:          string 'ok'/'error' (not number 200)");
    console.log("  • Field casing:                camelCase (hid, latestChapter, isNsfw, etc.)");
    console.log("═══════════════════════════════════════════════════════════════\n");
})();
