export {};

/**
 * Verify whether the local ComixHash algorithm still produces tokens accepted by comix.to.
 *
 * Hits a few known v1 endpoints with our signed URL and reports the server's reply.
 * If we see {"status":"error","message":"Invalid token.","code":403}, the hash algo
 * (or one of its keys/rounds) has changed on comix.to's side.
 *
 * Run with:  npx tsx --env-file=.env experiment/ProbeHashValid.ts
 */

import { signUrl, generateHash } from "../src/ComixTo/ComixHash";

const API   = "https://comix.to/api/v1";
const CF    = process.env.CF_CLEARANCE ?? "";
const UA    = process.env.USER_AGENT ?? "Mozilla/5.0";
let SES     = process.env.SESSION ?? "";

function H(): Record<string, string> {
    const c: string[] = [];
    if (SES) c.push(`session=${SES}`);
    if (CF)  c.push(`cf_clearance=${CF}`);
    return {
        "Referer": "https://comix.to/",
        "User-Agent": UA,
        "Cookie": c.join("; "),
        "Accept": "application/json",
        "x-requested-with": "XMLHttpRequest",
    };
}

async function probe(label: string, url: string) {
    const signed = signUrl(url);
    const res = await fetch(signed, { method: "GET", headers: H() });
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "?";
    const cf = res.headers.get("cf-ray") ?? "?";
    let parsed: any = null; try { parsed = JSON.parse(text); } catch {}

    const verdict =
        res.status >= 200 && res.status < 300 && parsed?.status === "ok" ? "PASS"
        : parsed?.message === "Invalid token." ? "INVALID-TOKEN"
        : `OTHER (${res.status})`;

    console.log(`\n[${verdict}] ${label}`);
    console.log(`  url:      ${signed}`);
    console.log(`  http:     ${res.status} | ct=${ct} | cf-ray=${cf}`);
    console.log(`  body:     ${text.slice(0, 200).replace(/\s+/g, " ")}`);
}

async function acquireSession(): Promise<void> {
    if (SES) return;
    const res = await fetch(`${API}/user`, {
        method: "GET",
        headers: { "User-Agent": UA, "Cookie": CF ? `cf_clearance=${CF}` : "", "Accept": "application/json", "x-requested-with": "XMLHttpRequest", "Referer": "https://comix.to/" },
    });
    // @ts-ignore
    const sc: string[] = typeof (res.headers as any).getSetCookie === "function" ? (res.headers as any).getSetCookie() : [];
    for (const h of sc) { const m = h.match(/^session=([^;]+)/i); if (m) SES = m[1]!; }
}

(async () => {
    await acquireSession();
    console.log(`session=${SES ? "set" : "MISSING"}  cf_clearance=${CF ? "set" : "MISSING"}`);

    // Sanity 1: confirm our algorithm still reproduces the previously hardcoded value.
    const oldPath = "/manga/ll172/chapters";
    const oldKnown = "xQm9tJfLwGhz_0Eq8S_YAHYkwp-q1PLfm50W5QJnyd1NnNYpAjXjyCoAzoOL-EXkCToxWS0NeDGz_rNrbg";
    const oldLocal = generateHash(oldPath);
    console.log(`\nlocal-determinism check (${oldPath}):`);
    console.log(`  produced: ${oldLocal}`);
    console.log(`  expected: ${oldKnown}`);
    console.log(`  ${oldLocal === oldKnown ? "✅ algorithm still produces same output (deterministic)" : "❌ local algorithm changed!"}`);

    // Sanity 2: compare against a freshly captured browser token.
    const newPath = "/chapters/9000025";
    const newBrowser = "bemJ-0y5bduXT9upsFZyqV4s6RO7JKSqdGy_wtVw2MsEpRV3yl8xub6LeSndTeuS_h7dCQtn";
    const newLocal = generateHash(newPath);
    console.log(`\ndoes our algorithm match comix.to's CURRENT algo (${newPath}):`);
    console.log(`  ours:    ${newLocal}  (${newLocal.length} chars)`);
    console.log(`  browser: ${newBrowser}  (${newBrowser.length} chars)`);
    console.log(`  ${newLocal === newBrowser ? "✅ MATCH — algorithm still valid" : "❌ MISMATCH — comix.to changed their hash"}`);

    // Hit a variety of endpoints to see which (if any) still accept our token.
    await probe("A. /manga/ll172/chapters?page=1&limit=20",
        `${API}/manga/ll172/chapters?page=1&limit=20`);
    await probe("B. /manga/xlyyj/chapters?page=1&limit=100&order[number]=desc  (the failing URL from your log)",
        `${API}/manga/xlyyj/chapters?page=1&limit=100&order[number]=desc`);
    await probe("C. /manga?order[chapter_updated_at]=desc&limit=5  (search-style, was working in last session)",
        `${API}/manga?order[chapter_updated_at]=desc&limit=5`);
    await probe("D. /manga/top?type=trending&days=7&limit=5&content_rating=safe",
        `${API}/manga/top?type=trending&days=7&limit=5&content_rating=safe`);
    await probe("E. /chapters/9000025  (single chapter pages, also failing in your log)",
        `${API}/chapters/9000025`);
    await probe("F. /tags/search?type=genre&limit=5  (cheap GET, no auth)",
        `${API}/tags/search?type=genre&limit=5`);
    await probe("G. /user  (no token — should pass since /user is unsigned)",
        `${API}/user`);
})();
