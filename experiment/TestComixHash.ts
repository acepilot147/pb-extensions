/**
 * End-to-end test for the ComixHash token.
 *
 * Verifies:
 *   1. The known static case: generateHash("/manga/55kym/chapters", 0, 1) matches the
 *      captured token from a real browser session.
 *   2. The live API returns HTTP 200 when the generated token is attached.
 *
 * Run with:
 *   npx tsx --env-file=.env experiment/TestComixHash.ts
 */

// --- Inline ComixHash (no build step needed for experiments) ---

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
    try { const b = Buffer.from(KEYS[i], "base64"); return Array.from(b).map(x => x & 0xFF); }
    catch { return []; }
}
function rc4(key: number[], data: number[]): number[] {
    if (!key.length) return [...data];
    const s = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) % 256; [s[i], s[j]] = [s[j], s[i]]; }
    let i2 = 0, j2 = 0;
    const out = new Array(data.length);
    for (let k = 0; k < data.length; k++) {
        i2 = (i2 + 1) % 256; j2 = (j2 + s[i2]) % 256;
        [s[i2], s[j2]] = [s[j2], s[i2]];
        out[k] = data[k] ^ s[(s[i2] + s[j2]) % 256];
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
const getMutKey = (mk: number[], idx: number) => mk.length > 0 && (idx % 32) < mk.length ? mk[idx % 32] : 0;

function applyRound(
    data: number[], rc4KeyIdx: number, mutKeyIdx: number, prefKeyIdx: number,
    prefLimit: number,
    apply: (v: number, i: number) => number
): number[] {
    const enc = rc4(getKeyBytes(rc4KeyIdx), data);
    const mk = getKeyBytes(mutKeyIdx), pk = getKeyBytes(prefKeyIdx), out: number[] = [];
    for (let i = 0; i < enc.length; i++) {
        if (i < prefLimit && i < pk.length) out.push(pk[i]);
        out.push(apply(enc[i] ^ getMutKey(mk, i), i) & 255);
    }
    return out;
}

function round1(d: number[]) {
    return applyRound(d, 0, 1, 2, 7, (v, i) => {
        switch (i % 10) { case 0: case 9: return mutC(v); case 1: return mutB(v); case 2: return mutY(v); case 3: return mutDollar(v); case 4: case 6: return mutH(v); case 5: return mutS(v); case 7: return mutK(v); case 8: return mutL(v); } return v;
    });
}
function round2(d: number[]) {
    return applyRound(d, 3, 4, 5, 6, (v, i) => {
        switch (i % 10) { case 0: case 8: return mutC(v); case 1: return mutB(v); case 2: case 6: return mutDollar(v); case 3: return mutH(v); case 4: case 9: return mutS(v); case 5: return mutK(v); case 7: return mutUnderscore(v); } return v;
    });
}
function round3(d: number[]) {
    return applyRound(d, 6, 7, 8, 7, (v, i) => {
        switch (i % 10) { case 0: return mutC(v); case 1: return mutF(v); case 2: case 8: return mutS(v); case 3: return mutG(v); case 4: return mutY(v); case 5: return mutM(v); case 6: return mutDollar(v); case 7: return mutK(v); case 9: return mutB(v); } return v;
    });
}
function round4(d: number[]) {
    return applyRound(d, 9, 10, 11, 8, (v, i) => {
        switch (i % 10) { case 0: return mutB(v); case 1: case 9: return mutM(v); case 2: case 7: return mutL(v); case 3: case 5: return mutS(v); case 4: case 6: return mutUnderscore(v); case 8: return mutY(v); } return v;
    });
}
function round5(d: number[]) {
    return applyRound(d, 12, 13, 14, 6, (v, i) => {
        switch (i % 10) { case 0: return mutUnderscore(v); case 1: case 7: return mutS(v); case 2: return mutC(v); case 3: case 5: return mutM(v); case 4: return mutB(v); case 6: return mutF(v); case 8: return mutDollar(v); case 9: return mutG(v); } return v;
    });
}

function generateHash(path: string, bodySize: number, time: number): string {
    const encoded = encodeURIComponent(`${path}:${bodySize}:${time}`)
        .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    let data: number[] = [];
    for (let i = 0; i < encoded.length; i++) data.push(encoded.charCodeAt(i) & 0xFF);
    data = round1(data); data = round2(data); data = round3(data); data = round4(data); data = round5(data);
    return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Append time=1&_=<token> to an API URL. Path is everything after /api/v2. */
function signUrl(url: string): string {
    const path = url.replace("https://comix.to/api/v2", "").split("?")[0];
    const token = generateHash(path, 0, 1);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}time=1&_=${token}`;
}

// --- Test harness ---

const API_BASE = "https://comix.to/api/v2";
const HEADERS = {
    "Referer": "https://comix.to/",
    "User-Agent": process.env.USER_AGENT ?? "",
    "Cookie": `cf_clearance=${process.env.CF_CLEARANCE ?? ""}`,
    "Accept": "application/json",
};

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`  ✅ PASS: ${label}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
        failed++;
    }
}

async function fetchSigned(label: string, url: string): Promise<any | null> {
    const signed = signUrl(url);
    console.log(`\n=========================================`);
    console.log(`${label}`);
    console.log(`URL: ${signed}`);
    const res = await fetch(signed, { method: "GET", headers: HEADERS });
    if (res.status === 403 || res.status === 503) {
        console.error(`  ❌ Cloudflare blocked (${res.status}) — CF_CLEARANCE may have expired`);
        failed++;
        return null;
    }
    assert(`HTTP 200`, res.status === 200, `got ${res.status}`);
    if (!res.ok) return null;
    const json = await res.json() as any;
    assert(`status=200 in JSON body`, json?.status === 200, `got ${json?.status}`);
    return json;
}

(async () => {
    console.log("=== ComixHash End-to-End Test ===\n");

    // 1. Static correctness — known-good token from a captured browser session
    console.log("=========================================");
    console.log("Unit test: static hash correctness");
    const KNOWN_TOKEN = "xQm9tJfLwGhz_0Eq8S_YAHYkwp-q1PLfm50W5QJnyd1NnNYpAjXjyCoAzoOLru8aI60xWS0NeDGz_rNrbqBjLLP1H9qi";
    const computed = generateHash("/manga/55kym/chapters", 0, 1);
    assert(`generateHash("/manga/55kym/chapters", 0, 1) matches known token`, computed === KNOWN_TOKEN, `\n    got:      ${computed}\n    expected: ${KNOWN_TOKEN}`);

    // 2. Live requests — one per major endpoint type
    const mangaData = await fetchSigned(
        "Chapters list (the endpoint the token was captured from)",
        `${API_BASE}/manga/55kym/chapters?limit=20&page=1&order[number]=desc`
    );
    if (mangaData?.result?.items) {
        assert(`result.items is an array`, Array.isArray(mangaData.result.items));
    }

    const homeData = await fetchSigned(
        "Home — trending",
        `${API_BASE}/top?type=trending&days=30&limit=5`
    );
    if (homeData?.result?.items) {
        assert(`result.items is an array`, Array.isArray(homeData.result.items));
    }

    const latestData = await fetchSigned(
        "Home — latest updates",
        `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=5`
    );
    if (latestData?.result?.items?.length) {
        const firstManga = latestData.result.items[0];
        const mangaId = firstManga.hash_id;
        console.log(`  ℹ  Using manga "${firstManga.title}" (${mangaId}) for downstream tests`);

        const detailData = await fetchSigned(
            `Manga details (${mangaId})`,
            `${API_BASE}/manga/${mangaId}?includes[]=author&includes[]=artist`
        );
        if (detailData?.result) {
            assert(`result.title present`, typeof detailData.result.title === "string");
        }

        const chapData = await fetchSigned(
            `Chapter list (${mangaId})`,
            `${API_BASE}/manga/${mangaId}/chapters?page=1&limit=5&order[number]=desc`
        );
        if (chapData?.result?.items?.length) {
            const chapterId = chapData.result.items[0].hash_id;
            if (chapterId) {
                const pagesData = await fetchSigned(
                    `Chapter pages (${chapterId})`,
                    `${API_BASE}/chapters/${chapterId}`
                );
                if (pagesData?.result) {
                    assert(`result.images present`, Array.isArray(pagesData.result.images));
                }
            }
        }
    }

    console.log(`\n=========================================`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
