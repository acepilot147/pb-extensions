// Open a manga + one of its chapters in a real Chrome and report what the site
// is doing: build id, secure-*.js URL, the key ID in the site's own tokens, and
// whether comix's WAF is challenging. Writes capture.json next to this file
// (refresh-bundle.mjs reads it).
//
//   node experiment/live/capture.mjs [titleUrl]

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const b = await launch();
const responses = [];
b.on((m) => {
  if (m.method === "Network.responseReceived") responses.push({ status: m.params.response.status, type: m.params.type, url: m.params.response.url });
});
await b.send("Network.enable");

try {
  await b.goto("https://comix.to/");
  const links = async () => JSON.parse(await b.evaluate('JSON.stringify([...new Set([...document.querySelectorAll("a[href]")].map(a => a.href))])'));
  const title = process.argv[2] ?? (await links()).find((h) => /\/title\/[^/]+$/.test(h));
  if (!title) throw new Error(`no title link on the homepage (landed on ${await b.evaluate("location.href")})`);
  await b.goto(title);
  const chapter = (await links()).find((h) => h.startsWith(title + "/"));
  if (chapter) await b.goto(chapter, 6000);

  const html = await b.evaluate("document.documentElement.outerHTML");
  const cfg = html.match(/<meta\s+name="cfg"\s+content="([^"]+)"/)?.[1] ?? null;
  const secureUrl = responses.map((r) => r.url).find((u) => /\/build\/.*\/secure-[\w-]+\.js$/.test(u)) ?? null;
  const mainUrl = responses.map((r) => r.url).find((u) => /\/build\/.*\/main-[\w-]+\.js$/.test(u)) ?? null;
  const api = responses.filter((r) => r.url.includes("/api/v1/"));
  const tokens = api.map((r) => new URL(r.url).searchParams.get("_")).filter(Boolean);
  const keyIds = [...new Set(tokens.map((t) => t.split(".")[0]))];
  const waf = responses.some((r) => r.url.includes("/@waf/challenge")) || /security check/i.test(await b.evaluate("document.title"));

  const out = {
    at: new Date().toISOString(), title, chapter: chapter ?? null, landedOn: await b.evaluate("location.href"),
    build: secureUrl?.match(/secure-([a-z0-9]+)-/)?.[1] ?? null, secureUrl, mainUrl, cfg, keyIds, waf,
    api: api.map((r) => ({ status: r.status, url: r.url })),
  };
  writeFileSync(join(HERE, "capture.json"), JSON.stringify(out, null, 2));
  console.log(`build ${out.build} | key ${keyIds.join(",") || "?"} | WAF ${waf ? "CHALLENGING" : "clear"} | landed ${out.landedOn}`);
  for (const r of api) console.log(`  ${r.status} ${r.url.replace("https://comix.to", "")}`);
  console.log(`  secure: ${secureUrl}`);
} finally {
  b.close();
}
