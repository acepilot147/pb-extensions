export {};

/**
 * Validate the ported ComixHash against (a) tokens captured from the
 * live browser bundle and (b) the relay (which still runs the live bundle
 * itself). Both are ground truth.
 *
 *   npx tsx --env-file=.env experiment/ValidateComixHash.ts
 *
 * Requires the relay running for the live cross-check:
 *   npx tsx --env-file=.env experiment/relay/Server.ts
 */

import { generateHash, signUrl } from "../src/ComixTo/ComixHash";

const KNOWN: Array<{ path: string; token: string; via: string }> = [
    {
        path: "/chapters/9000025",
        token: "bemJ-0y5bduXT9upsFZyqV4s6RO7JKSqdGy_wtVw2MsEpRV3yl8xub6LeSndTeuS_h7dCQtn",
        via: "browser capture",
    },
    {
        path: "/manga/xlyyj/chapters",
        token: "bemJ-0y5bduXT9upsFZyqV4s6RO7JKSqdGy_wtVw2MsErBWwyqsxWwbL-D5aByKWW7zNf6Acnja4S5sV",
        via: "browser capture",
    },
];

let pass = 0, fail = 0;
for (const { path, token, via } of KNOWN) {
    const ours = generateHash(path);
    const ok = ours === token;
    console.log(`${ok ? "✅" : "❌"} ${path}    (${via})`);
    if (!ok) {
        console.log(`   expected: ${token}`);
        console.log(`   got     : ${ours}`);
        const n = Math.min(token.length, ours.length);
        let firstDiff = -1;
        for (let i = 0; i < n; i++) if (token[i] !== ours[i]) { firstDiff = i; break; }
        if (firstDiff === -1 && token.length !== ours.length) firstDiff = n;
        console.log(`   first diff at index ${firstDiff} (matched prefix ${firstDiff} bytes)`);
    }
    ok ? pass++ : fail++;
}

const RELAY = process.env.RELAY_URL ?? "http://127.0.0.1:9091";
const LIVE_PATHS = [
    "/chapters/9000025",
    "/manga/xlyyj/chapters",
    "/chapters/8999999",
    "/manga/ll172/chapters",
    "/manga/8wgym/chapter-indexes",
];

(async () => {
    let liveOk = 0, liveFail = 0;
    try {
        const probe = await fetch(`${RELAY}/health`);
        if (!probe.ok) throw new Error(`/health → ${probe.status}`);
        console.log(`\nlive cross-check via relay ${RELAY}`);
        for (const path of LIVE_PATHS) {
            const ours = generateHash(path);
            const res = await fetch(`${RELAY}/sign?path=${encodeURIComponent(path)}`);
            const body = await res.json() as any;
            if (!body.ok) { console.log(`  ⚠ relay error for ${path}: ${body.error}`); liveFail++; continue; }
            const m = body.signedUrl.match(/[?&]_=([^&]+)/);
            const theirs = m ? decodeURIComponent(m[1]) : "(none)";
            const ok = ours === theirs;
            console.log(`${ok ? "✅" : "❌"} ${path}`);
            if (!ok) {
                console.log(`   ours  : ${ours}`);
                console.log(`   relay : ${theirs}`);
            }
            ok ? liveOk++ : liveFail++;
        }
    } catch (e: any) {
        console.log(`\n⚠ relay unreachable (${RELAY}): ${e?.message ?? e}`);
        console.log(`   start it with: npx tsx --env-file=.env experiment/relay/Server.ts`);
    }

    console.log(`\nstatic fixtures: ${pass} pass / ${fail} fail`);
    console.log(`live relay     : ${liveOk} pass / ${liveFail} fail`);

    console.log(`\nsignUrl scope:`);
    for (const u of [
        "https://comix.to/api/v1/manga?order[chapter_updated_at]=desc&limit=5",
        "https://comix.to/api/v1/tags/search?type=genre&limit=5",
        "https://comix.to/api/v1/manga/xlyyj?includes[]=author",
        "https://comix.to/api/v1/manga/xlyyj/chapters?page=1",
        "https://comix.to/api/v1/chapters/9000025",
    ]) {
        const signed = signUrl(u);
        const has = /[?&]_=/.test(signed);
        console.log(`  ${has ? "🔒" : "  "} ${u}  ->  ${has ? "signed" : "unsigned"}`);
    }

    process.exit(fail === 0 && liveFail === 0 ? 0 : 1);
})();
