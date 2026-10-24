// End-to-end check of the generated crypto against production: sign each
// endpoint shape the extension uses with src/ComixTo/ComixFastSigner.ts, fetch
// it through a real Chrome, decrypt with ComixFastDecrypt.ts. Keep runs rare —
// comix's WAF captcha-walls IPs that send too much (see the WAF note in
// crypto-pipeline/README.md).
//
//   node experiment/live/e2e.mjs [titleSlug] [chapterId]

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, sleep } from "./cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(import.meta.url)("typescript");
async function importTs(rel) {
  const js = ts.transpileModule(readFileSync(join(ROOT, rel), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  const f = join(mkdtempSync(join(tmpdir(), "comix-e2e-")), "m.mjs");
  writeFileSync(f, js);
  return import(pathToFileURL(f).href);
}
const { fastGenerateHash } = await importTs("src/ComixTo/ComixFastSigner.ts");
const { fastDecryptComixPayload } = await importTs("src/ComixTo/ComixFastDecrypt.ts");

const A = "https://comix.to/api/v1";
const slug = process.argv[2] ?? "3rdr3";
const signed = (p) => /^\/manga(?:\/|$)/.test(p) || /^\/chapters\/[^/]+/.test(p);
const signUrl = (url) => {
  const path = url.replace(A, "").split("?")[0];
  return signed(path) ? url + (url.includes("?") ? "&" : "?") + "_=" + fastGenerateHash(url) : url;
};
const kw = (s) => encodeURIComponent(s).replace(/%20/g, "+");

const b = await launch();
let ok = 0, total = 0;
try {
  await b.goto("https://comix.to/");
  const summarize = (res) => Array.isArray(res) ? `array[${res.length}]`
    : res?.items ? `items[${res.items.length}]` : res?.pages ? `pages[${res.pages.items.length}]`
    : res?.title ? `title="${res.title}"` : JSON.stringify(res).slice(0, 80);
  const check = async (u) => {
    total++;
    const r = await b.fetchText(signUrl(u), { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" });
    let s;
    try {
      const j = JSON.parse(r.text);
      const res = "e" in j ? fastDecryptComixPayload(u, j, r.headers) : (j.status === "ok" ? j.result : j);
      s = summarize(res);
      if (r.status === 200) ok++;
      await sleep(500); // stay well under comix's rate limits
      return res;
    } catch (e) {
      s = `DECODE ERROR ${e.message} body=${r.text.slice(0, 90)}`;
    } finally {
      console.log(String(r.status).padEnd(4), `x-enc=${r.headers["x-enc"] ?? "-"}`.padEnd(9), u.replace(A, "").slice(0, 70).padEnd(72), s);
    }
  };
  await check(`${A}/manga/${slug}?includes[]=author&includes[]=artist`);
  const list = await check(`${A}/manga/${slug}/chapters?page=1&limit=100&order[number]=desc`);
  const chapterId = process.argv[3] ?? list?.items?.[0]?.id;
  if (chapterId) await check(`${A}/chapters/${chapterId}`);
  await check(`${A}/manga/top?type=trending&days=30&limit=15&content_rating=erotica`);
  await check(`${A}/manga?order[chapter_updated_at]=desc&limit=15&includes[]=author`);
  await check(`${A}/manga?order[relevance]=desc&page=1&limit=20&keyword=${kw("solo leveling")}`);
  await check(`${A}/manga?order[relevance]=desc&page=1&limit=20&genres_in[]=1&genres_in[]=2&genres_mode=and`);
  await check(`${A}/tags/search?type=genre&limit=50`);
} finally {
  b.close();
}
console.log(`\n${ok}/${total} OK`);
process.exit(ok === total ? 0 : 1);
