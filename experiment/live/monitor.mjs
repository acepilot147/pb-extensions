// Watch comix's deploy / key-rotation cadence. Every `intervalMin` minutes:
//   1. GET the homepage → current build id. Build ids are base-36 unix seconds
//      of the build (e.g. tne3cx = 2026-10-24T02:10:09Z), and the signing keys
//      are compiled into apicore-*.js, so a new build means new keys.
//   2. One signed request with the keys in src/ComixTo/ComixFastSigner.ts →
//      200, or 403 key_retired once comix stops accepting them.
// Two light requests per sample (plain fetch; logs a Cloudflare challenge if one
// appears). Appends JSON lines to experiment/live/monitor.log.
//
//   node experiment/live/monitor.mjs [intervalMin=60] [hours=26]

import { appendFileSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const LOG = join(HERE, "monitor.log");
const [intervalMin = 60, hours = 26] = process.argv.slice(2).map(Number);
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const ts = createRequire(import.meta.url)("typescript");
const js = ts.transpileModule(readFileSync(join(ROOT, "src/ComixTo/ComixFastSigner.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const f = join(mkdtempSync(join(tmpdir(), "comix-mon-")), "s.mjs");
writeFileSync(f, js);
const { fastGenerateHash } = await import(pathToFileURL(f).href);

async function sample() {
  const at = new Date().toISOString();
  const row = { at };
  try {
    const r = await fetch("https://comix.to/", { headers: { "User-Agent": UA, Accept: "text/html" } });
    const t = await r.text();
    row.home = r.status;
    row.cf = /just a moment/i.test(t);
    row.build = t.match(/main-([a-z0-9]+)-/)?.[1] ?? null;
    if (row.build) row.builtAt = new Date(parseInt(row.build, 36) * 1000).toISOString();
  } catch (e) { row.homeError = String(e.message ?? e); }
  try {
    const u = "https://comix.to/api/v1/manga/z0l20";
    const tok = fastGenerateHash(u);
    const r = await fetch(`${u}?_=${tok}`, { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://comix.to/" } });
    const body = await r.text();
    row.key = tok.slice(0, tok.indexOf(".") + 1);
    row.keyStatus = r.status;
    row.keyCode = r.status === 200 ? "ok" : (body.match(/"code":"([^"]+)"|"error":"([^"]+)"/)?.slice(1).find(Boolean) ?? (/just a moment/i.test(body) ? "cf_challenge" : body.slice(0, 60)));
  } catch (e) { row.keyError = String(e.message ?? e); }
  appendFileSync(LOG, JSON.stringify(row) + "\n");
  console.log(`${at} build ${row.build ?? "?"} (built ${row.builtAt ?? "?"}) | key ${row.key ?? "?"} → ${row.keyStatus ?? "?"} ${row.keyCode ?? row.keyError ?? ""}${row.cf ? " | CF challenge" : ""}`);
}

const end = Date.now() + hours * 3600e3;
for (;;) {
  await sample();
  if (Date.now() + intervalMin * 60e3 > end) break;
  await new Promise((r) => setTimeout(r, intervalMin * 60e3));
}
console.log("monitor finished");
