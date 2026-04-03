// Tests scope= variants on the manga endpoint to find what powers the "new" tab
// visible on comix.to under Latest Updates.
// Run with: npx tsx --env-file=.env experiment/TestNewEndpoint.ts

const DOMAIN = "https://comix.to";
const API_BASE = "https://comix.to/api/v2";

const HEADERS = {
  "Referer": `${DOMAIN}/`,
  "User-Agent": process.env.USER_AGENT ?? "",
  "Cookie": `cf_clearance=${process.env.CF_CLEARANCE ?? ""}`,
  "Accept": "application/json",
};

async function fetch_endpoint(label: string, url: string) {
  console.log(`\n=========================================`);
  console.log(`${label}`);
  console.log(`URL: ${url}`);

  const response = await fetch(url, { method: "GET", headers: HEADERS });

  if (response.status === 403 || response.status === 503) {
    console.error(`❌ Cloudflare blocked (${response.status}) — CF_CLEARANCE may have expired`);
    return null;
  }
  if (!response.ok) {
    console.error(`❌ HTTP ${response.status} ${response.statusText}`);
    return null;
  }

  const json = await response.json() as any;
  console.log(`✅ HTTP ${response.status}`);
  return json;
}

function fmt_date(unix_s: number): string {
  return new Date(unix_s * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function print_items(items: any[], col1: string, col2: string, key1: string, key2: string) {
  console.log(`\n${"Title".padEnd(38)} | ${col1.padEnd(24)} | ${col2}`);
  console.log(`${"-".repeat(38)}-|-${"-".repeat(24)}-|-${"-".repeat(24)}`);
  for (const m of items) {
    const title = m.title.padEnd(38).slice(0, 38);
    console.log(`${title} | ${fmt_date(m[key1]).padEnd(24)} | ${fmt_date(m[key2])}`);
  }
}

(async () => {
  const endpoints = [
    { label: "scope=hot   (current 'Latest Updates')", url: `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=8&scope=hot` },
    { label: "scope=new",                               url: `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=8&scope=new` },
    { label: "scope=latest",                            url: `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=8&scope=latest` },
    { label: "no scope    (baseline)",                  url: `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=8` },
    { label: "order[created_at]=desc (no scope)",       url: `${API_BASE}/manga?order[created_at]=desc&limit=8` },
    { label: "scope=max   (invalid — sanity check)",    url: `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=8&scope=max` },
  ];

  const results: Record<string, any[]> = {};

  for (const ep of endpoints) {
    const data = await fetch_endpoint(ep.label, ep.url);
    if (data?.result?.items) {
      results[ep.label] = data.result.items;
      print_items(data.result.items, "chapter_updated_at", "created_at", "chapter_updated_at", "created_at");
    }
  }

  // --- OVERLAP MATRIX ---
  const labels = Object.keys(results);
  if (labels.length > 1) {
    console.log(`\n=========================================`);
    console.log("Overlap vs scope=hot:");
    const hotIds = new Set(results[labels[0]]?.map((m: any) => m.hash_id) ?? []);
    for (const label of labels.slice(1)) {
      const ids = results[label].map((m: any) => m.hash_id);
      const overlap = ids.filter((id: string) => hotIds.has(id)).length;
      console.log(`  ${label.padEnd(40)} — ${overlap}/${ids.length} titles in common`);
    }
  }
})();
