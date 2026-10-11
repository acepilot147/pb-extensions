// Step 1 — extract the signer + decrypt constants from the embedded bundle.
//
// Families (bundle 88ef335b54f8, 2026-10 — see README "The algorithm"):
//   decrypt  "xor-offset"           x-enc 2: 2-byte header picks an offset into a
//                                   fixed XOR table K; pt[i] = body[i] ^ K[(off+i) % |K|]
//   signer   "hmac-sha256-midstate" token = prefix + b64url(HMAC-SHA256(key, msg)[0:n]);
//                                   the key exists only as its ipad/opad midstates
//
// Decrypt: K is read straight off the live decrypt — an all-zero body under
// header 0,0 decrypts to K itself (captured at the TextDecoder boundary).
// Signer: the midstates are read off the instrumented op trace. Each SHA-256
// compression ends with a feed-forward `state[i] + work[i]`; across two
// messages `state[i]` stays fixed while the sum changes, which isolates the
// 8 state words of the inner (ipad) and outer (opad) compressions.
// Both are self-verified against the live bundle before constants.json is written.
//
//   node experiment/crypto-pipeline/extract.mjs

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ROOT, bootBundle, liveSign, liveSignParams, liveDecrypt,
  xorOffsetEncrypt, hmacMidstateSign, SHA256_K0, SHA256_K63, stableJson,
} from "./lib.mjs";

const OUT = resolve(ROOT, "experiment/crypto-pipeline/constants.json");

// Two same-length single-block messages, so the VM takes identical code paths
// and the feed-forward adds line up one-to-one between the two traces.
const TRACE_PATHS = ["/manga/aaaa1", "/manga/bbbb2"];

const u32 = (v) => v >>> 0;
const isWord = (v) => Number.isInteger(v) && Math.abs(v) < 2 ** 33 && Math.abs(v) > 0xffff;

// Read the XOR table through a JSON-digit oracle. Since bundle 7f5eff7ebada
// (2026-10-10) the bundle decodes UTF-8 and parses JSON inside the VM — no
// TextDecoder or JSON.parse — so raw plaintext is no longer observable. What is:
// resI returns a number for a one-byte plaintext that is a JSON digit, and the
// untouched {e} envelope otherwise. The 2-byte header puts any table index j at
// plaintext position 0, so for each j: try body bytes c until one decodes to a
// digit d → K[j] = c ^ ("0" + d). (~25 tries per index, ~0.4 ms each.)
function extractDecryptTable(resI) {
  const digitAt = (H) => {
    for (let c = 0; c < 256; c++) {
      let v;
      try { v = liveDecrypt(resI, Buffer.from([H >> 8, H & 0xff, c]).toString("base64")); } catch { continue; }
      if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 9) return c ^ (0x30 + v);
    }
    throw new Error(`no one-byte ciphertext decrypts to a digit at header ${H} — family changed (not a header-offset XOR table)`);
  };

  // Period: the smallest P with K at header H equal to K at header H+P for a
  // run of H (one byte matching by chance is 1/256, so require 8 in a row).
  const head = Array.from({ length: 8 }, (_, h) => digitAt(h));
  let period = 0;
  for (const P of [256, 512, 1024, 2048, 4096, 8192, 16384, 32768]) {
    if (head.every((k, h) => digitAt(P + h) === k)) { period = P; break; }
  }
  if (!period) throw new Error("header offset has no power-of-two period ≤ 32768 — family changed");

  const K = new Uint8Array(period);
  for (let j = 0; j < period; j++) K[j] = j < head.length ? head[j] : digitAt(j);

  // Verify end-to-end through resI: real JSON envelopes (unicode, large, error
  // bodies) under random headers, including offsets that wrap the table.
  const samples = [
    { status: "ok", result: { items: [{ id: 9000025, n: "1" }], unicode: "日本語 é → ✓ 😀", digits: "0123456789", n: [8, 88, 8.5] } },
    { status: "ok", result: { items: Array.from({ length: 300 }, (_, i) => ({ id: i, t: "title " + i })) } },
    { status: "error", message: "not found" },
  ];
  for (let t = 0; t < 30; t++) {
    const sample = samples[t % samples.length];
    const header = [Math.random() * 256 | 0, Math.random() * 256 | 0];
    const e = Buffer.from(xorOffsetEncrypt(new Uint8Array(Buffer.from(JSON.stringify(sample), "utf8")), K, header)).toString("base64");
    const live = liveDecrypt(resI, e);
    const expected = sample.status === "ok" ? sample.result : sample;
    if (stableJson(live) !== stableJson(expected)) throw new Error(`decrypt round-trip through live resI did not match (header ${header})`);
  }
  return K;
}

// Feed-forward adds of the last compression ending before `endIdx`: the adds
// after its final K63 use, in trace order, as [a, b, result] uint32 triples.
function feedForwardAdds(log) {
  const k0 = [], k63 = [];
  log.forEach(([, a, b], i) => {
    if (u32(a) === SHA256_K0 || u32(b) === SHA256_K0) k0.push(i);
    if (u32(a) === SHA256_K63 || u32(b) === SHA256_K63) k63.push(i);
  });
  // Cluster K0 uses into compressions (each compression touches K0 a few times in a row).
  const starts = k0.filter((i, j) => j === 0 || i - k0[j - 1] > 1000);
  if (starts.length !== 2) throw new Error(`expected 2 SHA-256 compressions per signature, saw ${starts.length} — family changed`);
  const windows = starts.map((s, c) => {
    const end = c + 1 < starts.length ? starts[c + 1] : log.length;
    const lastK63 = k63.filter((i) => i > s && i < end).pop();
    if (lastK63 === undefined) throw new Error(`compression ${c} never used K63`);
    const adds = [];
    for (let i = lastK63; i < Math.min(end, lastK63 + 20000); i++) {
      const [op, a, b, r] = log[i];
      if (op === "+" && isWord(a) && isWord(b)) adds.push([u32(a), u32(b), u32(r)]);
    }
    return adds;
  });
  return windows;
}

function extractSignerStates(bootInst) {
  const { reqI, traceOps } = bootInst;
  liveSign(reqI, "/manga/warmup"); // first call lazily decodes VM bytecode; keep it out of the traces
  const traceA = feedForwardAdds(traceOps(() => liveSign(reqI, TRACE_PATHS[0])));
  const traceB = feedForwardAdds(traceOps(() => liveSign(reqI, TRACE_PATHS[1])));
  // A state word is an addend in BOTH traces whose sums differ (the other addend
  // is message-dependent). VM bookkeeping adds produce identical sums in both;
  // data values never recur across the two messages. Matched by value, not by
  // position — the VM may run a few extra adds for one message (bundle
  // 7f5eff7ebada did), which broke index pairing.
  return [0, 1].map((c) => {
    const sums = (adds) => {
      const m = new Map();
      for (const [a, b, r] of adds) for (const v of [a, b]) { if (!m.has(v)) m.set(v, new Set()); m.get(v).add(r); }
      return m;
    };
    const A = traceA[c], sumsA = sums(A), sumsB = sums(traceB[c]);
    const state = [];
    for (const [a, b] of A) {
      for (const v of [a, b]) {
        if (v === SHA256_K63 || state.includes(v) || !sumsB.has(v)) continue;
        const rb = sumsB.get(v);
        if ([...sumsA.get(v)].every((r) => !rb.has(r))) state.push(v);
      }
      if (state.length === 8) break;
    }
    if (state.length !== 8) throw new Error(`compression ${c}: recovered ${state.length}/8 state words`);
    return state;
  });
}

export function extract() {
  const { bundleId, cfg, reqI, resI } = bootBundle();

  // --- decrypt (x-enc 2) ---
  const K = extractDecryptTable(resI);

  // --- signer ---
  const probe = liveSign(reqI, "/manga/xlyyj");
  const dot = probe.lastIndexOf(".");
  const prefix = probe.slice(0, dot + 1);
  const macBytes = Buffer.from(probe.slice(dot + 1).replace(/-/g, "+").replace(/_/g, "/"), "base64").length;
  if (!probe || macBytes < 8) throw new Error(`unexpected token shape "${probe}" — family changed`);

  const [istate, ostate] = extractSignerStates(bootBundle({ instrument: true }));
  const sign = { prefix, macBytes, istate, ostate };

  // Verify: paths (1–3 SHA blocks, non-ASCII) and param objects vs the live signer.
  const rnd = (n) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz0123456789-_.~é漫"[Math.random() * 43 | 0]).join("");
  const msgs = ["/manga/xlyyj", "/chapters/9000025"];
  for (let i = 0; i < 150; i++) msgs.push((i % 2 ? "/manga/" : "/chapters/") + rnd(1 + Math.random() * 150 | 0));
  for (const m of msgs) {
    const live = liveSign(reqI, m), mine = hmacMidstateSign(m, sign);
    if (live !== mine) throw new Error(`signer mismatch for ${m}:\n  live: ${live}\n  mine: ${mine}`);
  }
  const liveP = liveSignParams(reqI, "/manga/abc/chapters", { page: 1, limit: 100, "order[number]": "desc" });
  if (liveP !== hmacMidstateSign("/manga/abc/chapters?limit=100&order[number]=desc&page=1", sign)) {
    throw new Error("signer mismatch on canonical query — the bundle's param serialization changed");
  }

  const out = {
    bundleId,
    cfg,
    generatedAt: new Date().toISOString(),
    signer: {
      algorithm: "hmac-sha256-midstate",
      note: "token = prefix + b64url(HMAC-SHA256(key, path[?canonicalQuery])[0:macBytes]); istate/ostate = SHA-256 state after the ipad/opad block",
      prefix, macBytes,
      istate: istate.map((w) => "0x" + w.toString(16).padStart(8, "0")),
      ostate: ostate.map((w) => "0x" + w.toString(16).padStart(8, "0")),
    },
    decrypt: {
      algorithm: "xor-offset",
      xEnc: "2",
      note: "ct = [h0,h1,body]; off = ((h0<<8)|h1) % K.length; pt[i] = body[i] ^ K[(off+i) % K.length]",
      keyB64: Buffer.from(K).toString("base64"),
    },
    verified: { signer: true, decrypt: true },
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  return out;
}

function main() {
  const out = extract();
  console.log(`[extract] bundle ${out.bundleId}`);
  console.log(`  signer : ${out.signer.algorithm}, prefix "${out.signer.prefix}", ${out.signer.macBytes}-byte MAC`);
  console.log(`  decrypt: ${out.decrypt.algorithm} (x-enc ${out.decrypt.xEnc}), ${Buffer.from(out.decrypt.keyB64, "base64").length}-byte table`);
  console.log(`[extract] wrote ${OUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
