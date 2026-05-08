export {};

/**
 * Replay the browser-captured tokens from our session to confirm whether
 * the new algorithm is "just rotated keys" or has a session/time component.
 *
 * Tests:
 *   1. Browser token for /chapters/9000025 — does our session accept it?
 *   2. Browser token for /manga/xlyyj/chapters — does our session accept it?
 *   3. Tokens swapped between paths — is the data portion path-validated?
 *
 * Run with:  npx tsx --env-file=.env experiment/ProbeReplay.ts
 */

const API = "https://comix.to/api/v1";
const CF  = process.env.CF_CLEARANCE ?? "";
const UA  = process.env.USER_AGENT ?? "Mozilla/5.0";
const SES = process.env.SESSION ?? "";

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

async function hit(label: string, url: string) {
    const res = await fetch(url, { method: "GET", headers: H() });
    const text = await res.text();
    const ok = res.status >= 200 && res.status < 300;
    console.log(`\n${ok ? "✅" : "❌"} ${label}`);
    console.log(`   url:    ${url}`);
    console.log(`   http:   ${res.status}`);
    console.log(`   body:   ${text.slice(0, 180).replace(/\s+/g, " ")}`);
}

(async () => {
    console.log(`my session=${SES.slice(0, 20)}...  cf_clearance=${CF ? "set" : "MISSING"}`);

    // Tokens captured from user's browser
    const T_CHAP_PAGE = "bemJ-0y5bduXT9upsFZyqV4s6RO7JKSqdGy_wtVw2MsEpRV3yl8xub6LeSndTeuS_h7dCQtn";          // /chapters/9000025
    const T_CHAP_LIST = "bemJ-0y5bduXT9upsFZyqV4s6RO7JKSqdGy_wtVw2MsErBWwyqsxWwbL-D5aByKWW7zNf6Acnja4S5sV"; // /manga/xlyyj/chapters

    // 1. Replay browser's exact tokens with the matching paths
    await hit("1. Browser token replayed: /chapters/9000025",
        `${API}/chapters/9000025?_=${T_CHAP_PAGE}`);

    await hit("2. Browser token replayed: /manga/xlyyj/chapters",
        `${API}/manga/xlyyj/chapters?page=1&limit=20&order[number]=desc&_=${T_CHAP_LIST}`);

    // 2. Swap tokens — does the data portion encode the path?
    await hit("3. SWAPPED token: send chap-list token for chap-page path",
        `${API}/chapters/9000025?_=${T_CHAP_LIST}`);

    await hit("4. SWAPPED token: send chap-page token for chap-list path",
        `${API}/manga/xlyyj/chapters?page=1&limit=20&order[number]=desc&_=${T_CHAP_PAGE}`);

    // 3. Truncated token (only the constant 33-byte prefix portion)
    const PREFIX_ONLY = "bemJ-0y5bduXT9upsFZyqV4s6RO7JKSqdGy_wtVw2MsE";
    await hit("5. Token = constant prefix only (no path-derived data)",
        `${API}/chapters/9000025?_=${PREFIX_ONLY}`);

    // 4. Different chapter id — does old token work for a different ID?
    await hit("6. Browser token for 9000025 sent to /chapters/9000024",
        `${API}/chapters/9000024?_=${T_CHAP_PAGE}`);
})();
