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
  "https://comix.to/api/v1/manga/abc-def/chapters?page=2&limit=100",
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
