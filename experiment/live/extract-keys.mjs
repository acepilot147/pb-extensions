// Extract comix's signing + decryption keys from the LIVE site in a real Chrome,
// and self-verify them against the site's own traffic. Writes
// experiment/crypto-pipeline/constants.json (same schema generate.mjs reads) and
// experiment/live/samples.json (the captured traffic, for validate-live.mjs).
//
// Since build tnd60v (2026-10-23) the keys no longer live in secure-*.js: an
// `apicore-*.js` module assembles one Uint8Array at runtime from XOR-masked
// string pieces — [inner HMAC midstate 32 B][outer midstate 32 B][XOR table 1024 B]
// — and signs/decrypts with plain JS (SHA-256 via `Ij`, token via `Uj`, decrypt
// via `Vj`). The algorithms are the v3 families (see crypto-pipeline/README.md);
// only the storage changed. Rather than chase the obfuscation, we:
//   1. inject (before any site script) a hook that remembers every Uint8Array
//      the page creates with a length of 1–8 KB;
//   2. load a chapter page, recording the site's signed API URLs and encrypted
//      response bodies;
//   3. offline, accept the candidate buffer whose [0:32]/[32:64] midstates
//      reproduce the site's own tokens and whose table decrypts its responses.
// Nothing comix-specific is assumed beyond the families, and every constant is
// verified against what production actually did.
//
//   node experiment/live/extract-keys.mjs

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";
import { sha256From, xorOffsetDecrypt, stableJson } from "../crypto-pipeline/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const CONSTANTS = join(ROOT, "experiment/crypto-pipeline/constants.json");
const SAMPLES = join(HERE, "samples.json");
const STD_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// ---------------------------------------------------------------- capture ---
const HOOK = `(() => {
  const Native = Uint8Array, seen = [];
  Object.defineProperty(window, "__comixBufs", { value: seen, enumerable: false });
  const P = new Proxy(Native, {
    construct(t, args, nt) {
      const r = Reflect.construct(t, args, nt);
      try { if (r.length >= 1024 && r.length <= 8192 && seen.length < 400) seen.push(r); } catch (e) {}
      return r;
    },
  });
  Object.defineProperty(window, "Uint8Array", { value: P, writable: true, configurable: true });
})();`;

async function capture(titleUrl) {
  const b = await launch();
  const reqs = new Map();
  b.on((m) => {
    const p = m.params ?? {};
    if (m.method === "Network.requestWillBeSent" && p.request.url.includes("/api/v1/")) reqs.set(p.requestId, { url: p.request.url });
    if (m.method === "Network.responseReceived" && reqs.has(p.requestId)) Object.assign(reqs.get(p.requestId), { status: p.response.status, headers: p.response.headers });
  });
  try {
    await b.send("Network.enable");
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
    await b.goto("https://comix.to/");
    const links = async () => JSON.parse(await b.evaluate('JSON.stringify([...new Set([...document.querySelectorAll("a[href]")].map(a => a.href))])'));
    const title = titleUrl ?? (await links()).find((h) => /\/title\/[^/]+$/.test(h));
    if (!title) throw new Error(`no title link (landed on ${await b.evaluate("location.href")} — WAF?)`);
    await b.goto(title);
    const chapter = (await links()).find((h) => h.startsWith(title + "/"));
    if (chapter) await b.goto(chapter, 6000);
    await sleep(1500);

    const buffers = JSON.parse(await b.evaluate(
      "JSON.stringify((window.__comixBufs || []).map(u => Array.from(u)))"));
    const traffic = [];
    for (const [id, r] of reqs) {
      if (r.status !== 200) continue;
      let body = "";
      try { body = (await b.send("Network.getResponseBody", { requestId: id })).result?.body ?? ""; } catch { /* evicted */ }
      traffic.push({ url: r.url, xEnc: r.headers?.["x-enc"] ?? null, body });
    }
    return { at: new Date().toISOString(), title, chapter: chapter ?? null, buffers, traffic };
  } finally {
    b.close();
  }
}

// ----------------------------------------------------------------- verify ---
const words = (buf, off) => Array.from({ length: 8 }, (_, i) => ((buf[off + 4 * i] << 24) | (buf[off + 4 * i + 1] << 16) | (buf[off + 4 * i + 2] << 8) | buf[off + 4 * i + 3]) >>> 0);

// The signed message: /api/v1-relative path + "?" + canonical query (same rules
// as canonicalizeQuery in the generated signer), with the `_` token removed.
function signedMessage(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/api\/v1/, "");
  const groups = {}, counts = {};
  for (const [k, v] of u.searchParams) {
    if (k === "_") continue;
    let base, rendered;
    if (k.endsWith("[]")) { base = k.slice(0, -2); const i = counts[base] ?? 0; counts[base] = i + 1; rendered = `${base}[${i}]=${v}`; }
    else { base = k.includes("[") ? k.slice(0, k.indexOf("[")) : k; rendered = `${k}=${v}`; }
    (groups[base] ??= []).push(rendered);
  }
  const q = Object.keys(groups).sort().map((g) => groups[g].join("&")).join("&");
  return q ? `${path}?${q}` : path;
}

const macBytesOf = (msg, istate, ostate) =>
  sha256From(ostate, 64, sha256From(istate, 64, new Uint8Array(Buffer.from(msg, "utf8"))));

// 6-bit groups of the first `n` chars of a base64 encoding of `bytes`.
function sextets(bytes, n) {
  const out = [];
  for (let i = 0; out.length < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push((v >> 18) & 63, (v >> 12) & 63, (v >> 6) & 63, v & 63);
  }
  return out.slice(0, n);
}

function solve(cap) {
  const signed = cap.traffic
    .map((t) => ({ ...t, token: new URL(t.url).searchParams.get("_") }))
    .filter((t) => t.token && t.token.includes("."));
  if (signed.length < 2) throw new Error(`only ${signed.length} signed requests captured — cannot verify`);
  const prefix = signed[0].token.slice(0, signed[0].token.indexOf(".") + 1);
  const tokenLen = signed[0].token.length - prefix.length;

  for (const buf of cap.buffers) {
    if (buf.length < 64 + 1024) continue;
    const istate = words(buf, 0), ostate = words(buf, 32);
    // Signer: derive the alphabet from the first token, then require every token to match.
    const alphabet = new Array(64).fill(null);
    let ok = true;
    for (const t of signed) {
      const sx = sextets(macBytesOf(signedMessage(t.url), istate, ostate), tokenLen);
      const chars = t.token.slice(prefix.length);
      for (let i = 0; i < tokenLen && ok; i++) {
        if (alphabet[sx[i]] === null) alphabet[sx[i]] = chars[i];
        else if (alphabet[sx[i]] !== chars[i]) ok = false;
      }
      if (!ok) break;
    }
    if (!ok) continue;
    // Decrypt: every captured {e} must decode to valid JSON.
    const K = Uint8Array.from(buf.slice(64, 64 + 1024));
    const enc = cap.traffic.filter((t) => t.body.startsWith('{"e":'));
    let decOk = 0;
    for (const t of enc) {
      const pt = xorOffsetDecrypt(new Uint8Array(Buffer.from(JSON.parse(t.body).e, "base64")), K);
      try { JSON.parse(Buffer.from(pt).toString("utf8")); decOk++; } catch { /* wrong table */ }
    }
    if (enc.length && decOk !== enc.length) continue;

    const known = alphabet.filter((c) => c !== null).length;
    const standard = alphabet.every((c, i) => c === null || c === STD_B64[i]);
    if (!standard) throw new Error(`token alphabet is not base64url (${known}/64 chars seen) — extend the generator for a custom alphabet`);
    return { prefix, macBytes: Math.floor(tokenLen * 6 / 8), istate, ostate, K, signedChecked: signed.length, decryptChecked: enc.length };
  }
  throw new Error(`no captured buffer (${cap.buffers.length} candidates) reproduces the site's tokens — storage or family changed`);
}

// ------------------------------------------------------------------- main ---
const cap = await capture(process.argv[2]);
writeFileSync(SAMPLES, JSON.stringify({ at: cap.at, title: cap.title, chapter: cap.chapter, traffic: cap.traffic }, null, 1));
const r = solve(cap);
const prev = existsSync(CONSTANTS) ? JSON.parse(readFileSync(CONSTANTS, "utf8")) : {};
const capInfo = existsSync(join(HERE, "capture.json")) ? JSON.parse(readFileSync(join(HERE, "capture.json"), "utf8")) : {};
const out = {
  bundleId: capInfo.build ?? prev.bundleId ?? "live",
  cfg: prev.cfg ?? null,
  generatedAt: new Date().toISOString(),
  source: "experiment/live/extract-keys.mjs (live site, self-verified against its own traffic)",
  signer: {
    algorithm: "hmac-sha256-midstate",
    note: "token = prefix + b64url(HMAC-SHA256(key, path[?canonicalQuery])[0:macBytes]); istate/ostate = SHA-256 state after the ipad/opad block",
    prefix: r.prefix, macBytes: r.macBytes,
    istate: r.istate.map((w) => "0x" + w.toString(16).padStart(8, "0")),
    ostate: r.ostate.map((w) => "0x" + w.toString(16).padStart(8, "0")),
  },
  decrypt: {
    algorithm: "xor-offset", xEnc: "2",
    note: "ct = [h0,h1,body]; off = ((h0<<8)|h1) % K.length; pt[i] = body[i] ^ K[(off+i) % K.length]",
    keyB64: Buffer.from(r.K).toString("base64"),
  },
  verified: { signer: true, decrypt: true, signedRequests: r.signedChecked, encryptedResponses: r.decryptChecked },
};
writeFileSync(CONSTANTS, JSON.stringify(out, null, 2) + "\n");
console.log(`[extract-keys] key ${r.prefix} — verified against ${r.signedChecked} site tokens and ${r.decryptChecked} encrypted responses`);
console.log(`[extract-keys] wrote ${CONSTANTS}`);
