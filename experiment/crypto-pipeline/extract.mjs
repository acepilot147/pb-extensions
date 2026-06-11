// Step 1 — extract the sbox-cbc constants from the embedded bundle.
//
// Boots the bundle, drives the live signer + decrypt with controlled inputs,
// and reads the S-boxes / keys off the `atob` boundary and the per-round IVs off
// the decrypt output (captured at the TextDecoder boundary). Validates the
// recovered constants against the live bundle before writing constants.json.
//
//   node experiment/crypto-pipeline/extract.mjs

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOT, bootBundle, liveSign, liveDecrypt,
  bytes, invert, decRound, decryptBytes, encryptBytes, b64url, utf8Decode,
} from "./lib.mjs";

const OUT = resolve(ROOT, "experiment/crypto-pipeline/constants.json");
const PROBE_PATH = "/manga/xlyyj/chapters";

function classifyConstants(atobBufs) {
  // 256-byte results are S-boxes (permutations of 0..255); the shorter ones are
  // round keys. They arrive interleaved sbox,key,sbox,key,... in round order.
  const stages = [];
  let pendingSbox = null;
  for (const buf of atobBufs) {
    if (buf.length === 256) {
      pendingSbox = buf;
    } else if (pendingSbox && buf.length > 0 && buf.length <= 64) {
      stages.push({ sbox: new Uint8Array(pendingSbox), key: new Uint8Array(buf) });
      pendingSbox = null;
    }
  }
  return stages;
}

export function extract() {
  const { bundleId, cfg, reqI, resI, traces, resetTraces } = bootBundle();

  // --- decrypt trace: canonical stage order (round 1..N) ---
  // atob call #0 is the input ciphertext; the rest are sbox/key constants.
  // The probe must be longer than the round count: the IV solver pins iv_r via
  // plaintext position N-1-r, so it needs ctLen > N. 48 covers any realistic
  // round count (comix has used 3 and 5).
  const ctLen = 48;
  const ct = new Uint8Array(ctLen);
  for (let i = 0; i < ctLen; i++) ct[i] = (i * 37 + 11) & 0xff;
  const ctB64 = Buffer.from(ct).toString("base64");

  resetTraces();
  liveDecrypt(resI, ctB64);
  const decAtob = traces.atob.slice(1); // drop the input `e`
  const pt = traces.decoderInputs[traces.decoderInputs.length - 1];
  if (!pt) throw new Error("no TextDecoder output captured — decrypt path did not run");

  const rawStages = classifyConstants(decAtob);
  if (rawStages.length === 0) throw new Error("no (sbox,key) stages found on the atob boundary");
  const N = rawStages.length;
  if (N >= ctLen) throw new Error(`probe ciphertext (len ${ctLen}) too short for ${N} rounds — raise ctLen`);

  // Attach inverse S-boxes; verify each S-box is a true permutation.
  const stages = rawStages.map((s, i) => {
    const seen = new Set(s.sbox);
    if (seen.size !== 256) throw new Error(`stage ${i} S-box is not a permutation of 0..255`);
    return { sbox: s.sbox, invSbox: invert(s.sbox), key: s.key, iv: 0 };
  });

  // --- solve per-round IVs ---
  // CBC-decrypt chains on the round INPUT byte, so iv_r only affects final
  // plaintext positions 0..(N-r). Solve outward: iv_r is the unique IV
  // affecting pt[N-r] once iv_1..iv_{r-1} are known.
  for (let r = 0; r < N; r++) {
    const pos = N - 1 - r; // pt position uniquely pinned by iv at round r
    let solved = -1;
    for (let cand = 0; cand < 256; cand++) {
      stages[r].iv = cand;
      const out = decryptBytes(ct, stages);
      if (out[pos] === pt[pos]) { solved = cand; break; }
    }
    if (solved < 0) throw new Error(`could not solve IV for round ${r + 1}`);
    stages[r].iv = solved;
  }

  // Sanity: full decrypt of the probe ciphertext must reproduce the live plaintext bytes.
  const check = decryptBytes(ct, stages);
  for (let i = 0; i < ctLen; i++) {
    if (check[i] !== pt[i]) throw new Error(`decrypt mismatch at byte ${i} after IV solve`);
  }

  // --- validate signer: forward cipher must reproduce the live token ---
  const liveToken = liveSign(reqI, PROBE_PATH);
  const mine = b64url(encryptBytes(new Uint8Array(Buffer.from(PROBE_PATH, "utf8")), stages));
  const signerOk = mine === liveToken;
  if (!signerOk) {
    throw new Error(`signer reconstruction failed:\n  live: ${liveToken}\n  mine: ${mine}`);
  }

  // --- validate decrypt end-to-end via an encrypted round-trip through resI ---
  const sample = { status: "ok", result: { items: [{ id: "9000025", n: "1" }], unicode: "日本語 é → ✓" } };
  const e = Buffer.from(encryptBytes(new Uint8Array(Buffer.from(JSON.stringify(sample), "utf8")), stages)).toString("base64");
  const liveOut = liveDecrypt(resI, e);
  const mineOut = JSON.parse(utf8Decode(decryptBytes(bytes(e), stages)));
  const mineResult = mineOut?.status === "ok" && "result" in mineOut ? mineOut.result : mineOut;
  const decryptOk = JSON.stringify(liveOut) === JSON.stringify(mineResult);
  if (!decryptOk) throw new Error("decrypt reconstruction did not match live resI");

  const out = {
    bundleId,
    algorithm: "sbox-cbc",
    rounds: N,
    cfg,
    generatedAt: new Date().toISOString(),
    note: "Decrypt applies inverse stages in order 1..N; sign applies forward stages in order N..1. Same (sbox,key,iv) triples both directions.",
    stages: stages.map((s) => ({
      sboxB64: Buffer.from(s.sbox).toString("base64"),
      keyB64: Buffer.from(s.key).toString("base64"),
      iv: s.iv,
    })),
    verified: { signer: signerOk, decrypt: decryptOk },
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

function main() {
  const out = extract();
  console.log(`[extract] bundle ${out.bundleId} — ${out.algorithm}, ${out.rounds} rounds`);
  out.stages.forEach((s, i) => console.log(`  stage ${i + 1}: key ${bytes(s.keyB64).length}B, iv ${s.iv}`));
  console.log(`[extract] signer verified: ${out.verified.signer}, decrypt verified: ${out.verified.decrypt}`);
  console.log(`[extract] wrote ${OUT}`);
}

// Run if invoked directly (Windows-safe).
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
