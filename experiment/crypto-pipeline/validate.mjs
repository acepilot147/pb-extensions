// Step 3 — validate the EMITTED TS files against the live bundle.
//
// Transpiles src/ComixTo/ComixFastSigner.ts and ComixFastDecrypt.ts with the
// TypeScript compiler, imports the real artifacts, and checks them against the
// live bundle's signer + response interceptor across many samples. This tests
// the shipped files (catching generation bugs), not just the in-process logic.
//
//   node experiment/crypto-pipeline/validate.mjs

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  ROOT, bootBundle, liveSign, liveDecrypt,
  bytes, invert, encryptBytes, stableJson,
} from "./lib.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const CONSTANTS = resolve(ROOT, "experiment/crypto-pipeline/constants.json");

async function importTs(tsPath) {
  const source = readFileSync(tsPath, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "comix-fast-"));
  const out = join(dir, "mod.mjs");
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

const SIGN_PATHS = [
  "/manga/xlyyj/chapters",
  "/manga/k927/chapters",
  "/manga/xlyyj/chapter-indexes",
  "/chapters/9000025",
  "/chapters/1",
  "https://comix.to/api/v1/manga/abc-def/chapters",
];

// Real endpoint param shapes — the token now signs the canonicalized query too.
const SIGN_PARAM_CASES = [
  ["/manga/zgk6j", { includes: ["author", "artist"] }],
  ["/manga/zgk6j/chapters", { page: 1, limit: 100, "order[number]": "desc" }],
  ["/manga/top", { type: "trending", days: "30", limit: "15", content_rating: "erotica" }],
  ["/manga", { "order[relevance]": "desc", page: 1, limit: 20, keyword: "love", genres_in: ["1", "2"], genres_mode: "and" }],
  ["/manga", { keyword: "日本語 é & x=y", page: 3 }],
];

const PAYLOADS = [
  { status: "ok", result: { items: [{ id: "9000025", number: "1", title: "Chapter 1" }], meta: { lastPage: 3 } } },
  { status: "ok", result: { pages: ["https://x.store/si/abc/001.webp", "https://x.store/si/abc/002.webp"] } },
  { status: "ok", result: { unicode: "日本語テスト ñ é → ✓ 😀", nested: { a: [1, 2, 3], b: null, c: true } } },
  { status: "error", message: "not found" },
  { status: "ok", result: { items: Array.from({ length: 500 }, (_, i) => ({ id: i, t: "title " + i })) } },
];

export async function validate() {
  const c = JSON.parse(readFileSync(CONSTANTS, "utf8"));
  const stages = c.stages.map((s) => {
    const sbox = bytes(s.sboxB64);
    return { sbox, invSbox: invert(sbox), key: bytes(s.keyB64), iv: s.iv };
  });

  const { reqI, resI } = bootBundle();
  const { fastGenerateHash } = await importTs(resolve(ROOT, "src/ComixTo/ComixFastSigner.ts"));
  const { fastDecryptComixPayload } = await importTs(resolve(ROOT, "src/ComixTo/ComixFastDecrypt.ts"));

  let signPass = 0, signFail = 0;
  for (const p of SIGN_PATHS) {
    const live = liveSign(reqI, p.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "").split("?")[0]);
    const mine = fastGenerateHash(p);
    if (live && live === mine) signPass++;
    else { signFail++; console.log(`  SIGN FAIL ${p}\n    live: ${live}\n    fast: ${mine}`); }
  }

  // Query-param signing: since bundle 625d… the token covers the canonicalized
  // query, not just the path. Drive the live interceptor with real param objects
  // and confirm fastGenerateHash reproduces the token — so a future change to the
  // bundle's param serializer is caught HERE instead of silently shipping 403s.
  const liveSignParams = (path, params) => {
    const c = { url: path, method: "get", baseURL: "https://comix.to/api/v1", headers: {}, params: JSON.parse(JSON.stringify(params)) };
    return (reqI(c) || c)?.params?._ ?? "";
  };
  const buildWire = (obj) => Object.entries(obj).map(([k, v]) =>
    Array.isArray(v) ? v.map((e) => `${k}[]=${encodeURIComponent(e)}`).join("&")
      : (v && typeof v === "object") ? Object.entries(v).map(([sk, sv]) => `${k}[${sk}]=${encodeURIComponent(sv)}`).join("&")
        : `${k}=${encodeURIComponent(v)}`
  ).filter(Boolean).join("&");

  for (const [path, params] of SIGN_PARAM_CASES) {
    const live = liveSignParams(path, params);
    const mine = fastGenerateHash(`${path}?${buildWire(params)}`);
    if (live && live === mine) signPass++;
    else { signFail++; console.log(`  SIGN(params) FAIL ${path} ${JSON.stringify(params)}\n    live: ${live}\n    fast: ${mine}`); }
  }

  // Fuzz the canonicalization against the live bundle.
  {
    const KEYS = ["page", "limit", "type", "days", "keyword", "order", "includes", "genres_in", "genres_ex", "types", "statuses", "aZ", "_k"];
    const VALS = ["desc", "author", "1", "love", "a b", "a&b=c", "x/y?z#w", "100%", "日本é", "a+b", ""];
    const SUB = ["number", "relevance", "created_at"];
    const rnd = (a) => a[Math.floor(Math.random() * a.length)];
    let fp = 0, ff = 0;
    for (let i = 0; i < 500; i++) {
      const o = {};
      const n = 1 + Math.floor(Math.random() * 5);
      for (let j = 0; j < n; j++) {
        const k = rnd(KEYS), r = Math.random();
        if (r < 0.2) o[k] = { [rnd(SUB)]: rnd(VALS) };
        else if (r < 0.45) o[k] = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => rnd(VALS));
        else o[k] = rnd(VALS);
      }
      const live = liveSignParams("/manga", o);
      if (!live) continue;
      const mine = fastGenerateHash(`/manga?${buildWire(o)}`);
      if (live === mine) fp++;
      else { ff++; if (ff <= 3) console.log(`  FUZZ FAIL ${JSON.stringify(o)}\n    wire ${buildWire(o)}\n    live ${live}\n    fast ${mine}`); }
    }
    if (ff === 0) signPass++; else signFail++;
    console.log(`  [param-fuzz] ${fp} pass / ${ff} fail`);
  }

  let decPass = 0, decFail = 0;
  for (const payload of PAYLOADS) {
    // Encrypt with the validated in-process forward cipher to fabricate `e`.
    const e = Buffer.from(encryptBytes(new Uint8Array(Buffer.from(JSON.stringify(payload), "utf8")), stages)).toString("base64");
    const live = liveDecrypt(resI, e);
    const mine = fastDecryptComixPayload("/x", { e }, { "x-enc": "1" });
    const expected = payload.status === "ok" ? payload.result : payload;
    // Three-way: live bundle, fast file, and the original all agree.
    if (stableJson(live) === stableJson(mine) && stableJson(mine) === stableJson(expected)) decPass++;
    else { decFail++; console.log(`  DECRYPT FAIL ${payload.status}\n    live: ${stableJson(live).slice(0, 80)}\n    fast: ${stableJson(mine).slice(0, 80)}`); }
  }

  // Pass-through cases for the decrypt file.
  const ptThrough = fastDecryptComixPayload("/x", { status: "ok", result: 1 }, {});
  if (stableJson(ptThrough) !== stableJson({ status: "ok", result: 1 })) { decFail++; console.log("  DECRYPT FAIL passthrough(no e)"); } else decPass++;

  console.log(`[validate] signer ${signPass} pass / ${signFail} fail, decrypt ${decPass} pass / ${decFail} fail`);
  const ok = signFail === 0 && decFail === 0;
  return { ok, signPass, signFail, decPass, decFail };
}

function main() {
  validate().then((r) => process.exit(r.ok ? 0 : 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
