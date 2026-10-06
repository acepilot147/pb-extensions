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
  xorOffsetDecrypt, xorOffsetEncrypt, hmacMidstateSign, SHA256_K0, SHA256_K63, stableJson,
} from "./lib.mjs";

const OUT = resolve(ROOT, "experiment/crypto-pipeline/constants.json");

// Two same-length single-block messages, so the VM takes identical code paths
// and the feed-forward adds line up one-to-one between the two traces.
const TRACE_PATHS = ["/manga/aaaa1", "/manga/bbbb2"];

const u32 = (v) => v >>> 0;
const isWord = (v) => Number.isInteger(v) && Math.abs(v) < 2 ** 33 && Math.abs(v) > 0xffff;

function extractDecryptTable(resI, traces, resetTraces) {
  const decryptRaw = (ct) => {
    resetTraces();
    try { liveDecrypt(resI, Buffer.from(ct).toString("base64")); } catch { /* non-JSON plaintext: fine, we read the TextDecoder input */ }
    const pt = traces.decoderInputs[traces.decoderInputs.length - 1];
    if (!pt) throw new Error("no TextDecoder output captured — x-enc 2 decrypt path did not run");
    return new Uint8Array(pt);
  };

  // Keystream under header 0,0, long enough to see the period twice.
  const N = 8192;
  const ks = decryptRaw(new Uint8Array(N + 2));
  if (ks.length !== N) throw new Error(`decrypt is not length-preserving after a 2-byte header (got ${ks.length} for ${N}) — family changed`);
  let period = 0;
  for (let p = 1; p <= N / 2 && !period; p++) {
    let ok = true;
    for (let i = 0; i + p < N; i++) if (ks[i] !== ks[i + p]) { ok = false; break; }
    if (ok) period = p;
  }
  if (!period) throw new Error("keystream has no period ≤ 4096 — family changed (not a fixed XOR table)");
  const K = ks.subarray(0, period);

  // Verify the model (XOR, header-selected offset) on random ciphertexts.
  for (let t = 0; t < 200; t++) {
    const n = 2 + Math.floor(Math.random() * 3000);
    const ct = new Uint8Array(n);
    for (let i = 0; i < n; i++) ct[i] = Math.random() * 256 | 0;
    const live = decryptRaw(ct), mine = xorOffsetDecrypt(ct, K);
    if (Buffer.compare(Buffer.from(live), Buffer.from(mine)) !== 0) {
      throw new Error(`xor-offset model mismatch (header ${ct[0]},${ct[1]}, len ${n}) — family changed`);
    }
  }

  // End-to-end through resI: real JSON envelope, unwrapped result.
  const sample = { status: "ok", result: { items: [{ id: 9000025, n: "1" }], unicode: "日本語 é → ✓ 😀" } };
  const e = Buffer.from(xorOffsetEncrypt(new Uint8Array(Buffer.from(JSON.stringify(sample), "utf8")), K, [0x12, 0x34])).toString("base64");
  const live = liveDecrypt(resI, e);
  if (stableJson(live) !== stableJson(sample.result)) throw new Error("decrypt round-trip through live resI did not match");
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
  const kset = new Set([SHA256_K63]);
  return [0, 1].map((c) => {
    const A = traceA[c], B = traceB[c], state = [];
    for (let i = 0; i < Math.min(A.length, B.length) && state.length < 8; i++) {
      const [a1, b1, r1] = A[i], [a2, b2, r2] = B[i];
      if (r1 === r2 || kset.has(a1) || kset.has(b1)) continue; // same result: VM bookkeeping, not data
      if (a1 === a2) state.push(a1);
      else if (b1 === b2) state.push(b1);
    }
    if (state.length !== 8) throw new Error(`compression ${c}: recovered ${state.length}/8 state words`);
    return state;
  });
}

export function extract() {
  const { bundleId, cfg, reqI, resI, traces, resetTraces } = bootBundle();

  // --- decrypt (x-enc 2) ---
  const K = extractDecryptTable(resI, traces, resetTraces);

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
