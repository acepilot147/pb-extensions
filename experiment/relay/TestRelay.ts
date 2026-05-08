export {};

/**
 * Smoke-test: ask the local relay to sign two paths, then send the signed
 * URLs to comix.to and confirm the API accepts them.
 *
 *   npx tsx --env-file=.env experiment/relay/TestRelay.ts
 *
 * Requires the relay running:
 *   npx tsx --env-file=.env experiment/relay/Server.ts
 */

const RELAY = process.env.RELAY_URL ?? "http://127.0.0.1:9091";

const PATHS = [
    "/chapters/9000025",
    "/manga/xlyyj/chapters?page=1&limit=100&order[number]=desc",
    "/manga?order[chapter_updated_at]=desc&limit=5",
    "/tags/search?type=genre&limit=5",
];

function H(): Record<string, string> {
    const c = [
        process.env.SESSION ? `session=${process.env.SESSION}` : "",
        process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : "",
    ].filter(Boolean).join("; ");
    return {
        "User-Agent": process.env.USER_AGENT ?? "Mozilla/5.0",
        "Cookie": c,
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://comix.to/",
    };
}

async function relaySign(path: string): Promise<string> {
    const res = await fetch(`${RELAY}/sign?path=${encodeURIComponent(path)}`);
    const body = await res.json() as any;
    if (!body.ok) throw new Error(`relay refused: ${body.error}`);
    return body.signedUrl;
}

(async () => {
    const health = await (await fetch(`${RELAY}/health`)).json() as any;
    console.log("relay health:", health);

    let ok = 0, fail = 0;
    for (const path of PATHS) {
        let signed: string;
        try { signed = await relaySign(path); }
        catch (e: any) { console.log(`\n❌ relay error for ${path}:`, e.message); fail++; continue; }

        const res = await fetch(signed, { headers: H() });
        const text = await res.text();
        let parsed: any = null; try { parsed = JSON.parse(text); } catch {}
        const verdict =
            res.status >= 200 && res.status < 300 && parsed?.status === "ok" ? "✅ OK"
            : parsed?.message === "Invalid token." ? "❌ Invalid token"
            : `⚠ status=${res.status}`;
        console.log(`\n${verdict}  ${path}`);
        console.log("  signed:", signed);
        console.log("  body  :", text.slice(0, 160).replace(/\s+/g, " "));
        if (verdict.startsWith("✅")) ok++; else fail++;
    }

    console.log(`\n========== summary: ${ok}/${PATHS.length} passed ==========`);
    process.exit(fail === 0 ? 0 : 1);
})();
