/**
 * Tests comix.to API order parameters to verify they work and return distinct results.
 * Run with: node test-order-params.js
 *
 * Already-proven orders (used in homepage):
 *   chapter_updated_at, created_at, follows_total, relevance
 *
 * Testing (unknown):
 *   views_7d, views_30d, views_90d, views_total
 */

const https = require("https");

// ── ComixHash port ──────────────────────────────────────────────────────────

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64Decode(s) {
  const lookup = new Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
  const out = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break;
    const v = lookup[c] ?? -1;
    if (v === -1) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xFF); }
  }
  return out;
}

function b64UrlEncode(bytes) {
  let out = "", i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS[(n >> 18) & 63];
    out += B64_CHARS[(n >> 12) & 63];
    out += B64_CHARS[(n >> 6) & 63];
    out += B64_CHARS[n & 63];
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i] << 16;
    out += B64_CHARS[(n >> 18) & 63];
    out += B64_CHARS[(n >> 12) & 63];
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS[(n >> 18) & 63];
    out += B64_CHARS[(n >> 12) & 63];
    out += B64_CHARS[(n >> 6) & 63];
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

const KEYS = [
  "13YDu67uDgFczo3DnuTIURqas4lfMEPADY6Jaeqky+w=",
  "yEy7wBfBc+gsYPiQL/4Dfd0pIBZFzMwrtlRQGwMXy3Q=",
  "yrP+EVA1Dw==",
  "vZ23RT7pbSlxwiygkHd1dhToIku8SNHPC6V36L4cnwM=",
  "QX0sLahOByWLcWGnv6l98vQudWqdRI3DOXBdit9bxCE=",
  "WJwgqCmf",
  "BkWI8feqSlDZKMq6awfzWlUypl88nz65KVRmpH0RWIc=",
  "v7EIpiQQjd2BGuJzMbBA0qPWDSS+wTJRQ7uGzZ6rJKs=",
  "1SUReYlCRA==",
  "RougjiFHkSKs20DZ6BWXiWwQUGZXtseZIyQWKz5eG34=",
  "LL97cwoDoG5cw8QmhI+KSWzfW+8VehIh+inTxnVJ2ps=",
  "52iDqjzlqe8=",
  "U9LRYFL2zXU4TtALIYDj+lCATRk/EJtH7/y7qYYNlh8=",
  "e/GtffFDTvnw7LBRixAD+iGixjqTq9kIZ1m0Hj+s6fY=",
  "xb2XwHNB",
];

const getKeyBytes = (i) => { try { return b64Decode(KEYS[i]); } catch { return []; } };

function rc4(key, data) {
  if (key.length === 0) return [...data];
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i2 = 0, j2 = 0;
  return data.map(b => {
    i2 = (i2 + 1) % 256;
    j2 = (j2 + s[i2]) % 256;
    [s[i2], s[j2]] = [s[j2], s[i2]];
    return b ^ s[(s[i2] + s[j2]) % 256];
  });
}

const mutS = e => (e + 143) % 256;
const mutL = e => ((e >>> 1) | (e << 7)) & 255;
const mutC = e => (e + 115) % 256;
const mutM = e => (e ^ 177) & 255;
const mutF = e => (e - 188 + 256) % 256;
const mutG = e => ((e << 2) | (e >>> 6)) & 255;
const mutH = e => (e - 42 + 256) % 256;
const mutDollar = e => ((e << 4) | (e >>> 4)) & 255;
const mutB = e => (e - 12 + 256) % 256;
const mutUnderscore = e => (e - 20 + 256) % 256;
const mutY = e => ((e >>> 1) | (e << 7)) & 255;
const mutK = e => (e - 241 + 256) % 256;
const getMutKey = (mk, idx) => mk.length > 0 && (idx % 32) < mk.length ? mk[idx % 32] : 0;

function makeRound(rcKey, mutKeyIdx, prefKeyIdx, mutFn) {
  return (data) => {
    const enc = rc4(getKeyBytes(rcKey), data);
    const mutKey = getKeyBytes(mutKeyIdx);
    const prefKey = getKeyBytes(prefKeyIdx);
    const out = [];
    for (let i = 0; i < enc.length; i++) {
      if (i < prefKey.length && i < [7, 6, 7, 8, 6][Math.floor(rcKey / 3)]) out.push(prefKey[i]);
      let v = enc[i] ^ getMutKey(mutKey, i);
      v = mutFn(v, i);
      out.push(v & 255);
    }
    return out;
  };
}

function round1(data) {
  const enc = rc4(getKeyBytes(0), data);
  const mutKey = getKeyBytes(1), prefKey = getKeyBytes(2), out = [];
  for (let i = 0; i < enc.length; i++) {
    if (i < 7 && i < prefKey.length) out.push(prefKey[i]);
    let v = enc[i] ^ getMutKey(mutKey, i);
    switch (i % 10) {
      case 0: case 9: v = mutC(v); break; case 1: v = mutB(v); break;
      case 2: v = mutY(v); break; case 3: v = mutDollar(v); break;
      case 4: case 6: v = mutH(v); break; case 5: v = mutS(v); break;
      case 7: v = mutK(v); break; case 8: v = mutL(v); break;
    }
    out.push(v & 255);
  }
  return out;
}

function round2(data) {
  const enc = rc4(getKeyBytes(3), data);
  const mutKey = getKeyBytes(4), prefKey = getKeyBytes(5), out = [];
  for (let i = 0; i < enc.length; i++) {
    if (i < 6 && i < prefKey.length) out.push(prefKey[i]);
    let v = enc[i] ^ getMutKey(mutKey, i);
    switch (i % 10) {
      case 0: case 8: v = mutC(v); break; case 1: v = mutB(v); break;
      case 2: case 6: v = mutDollar(v); break; case 3: v = mutH(v); break;
      case 4: case 9: v = mutS(v); break; case 5: v = mutK(v); break;
      case 7: v = mutUnderscore(v); break;
    }
    out.push(v & 255);
  }
  return out;
}

function round3(data) {
  const enc = rc4(getKeyBytes(6), data);
  const mutKey = getKeyBytes(7), prefKey = getKeyBytes(8), out = [];
  for (let i = 0; i < enc.length; i++) {
    if (i < 7 && i < prefKey.length) out.push(prefKey[i]);
    let v = enc[i] ^ getMutKey(mutKey, i);
    switch (i % 10) {
      case 0: v = mutC(v); break; case 1: v = mutF(v); break;
      case 2: case 8: v = mutS(v); break; case 3: v = mutG(v); break;
      case 4: v = mutY(v); break; case 5: v = mutM(v); break;
      case 6: v = mutDollar(v); break; case 7: v = mutK(v); break;
      case 9: v = mutB(v); break;
    }
    out.push(v & 255);
  }
  return out;
}

function round4(data) {
  const enc = rc4(getKeyBytes(9), data);
  const mutKey = getKeyBytes(10), prefKey = getKeyBytes(11), out = [];
  for (let i = 0; i < enc.length; i++) {
    if (i < 8 && i < prefKey.length) out.push(prefKey[i]);
    let v = enc[i] ^ getMutKey(mutKey, i);
    switch (i % 10) {
      case 0: v = mutB(v); break; case 1: case 9: v = mutM(v); break;
      case 2: case 7: v = mutL(v); break; case 3: case 5: v = mutS(v); break;
      case 4: case 6: v = mutUnderscore(v); break; case 8: v = mutY(v); break;
    }
    out.push(v & 255);
  }
  return out;
}

function round5(data) {
  const enc = rc4(getKeyBytes(12), data);
  const mutKey = getKeyBytes(13), prefKey = getKeyBytes(14), out = [];
  for (let i = 0; i < enc.length; i++) {
    if (i < 6 && i < prefKey.length) out.push(prefKey[i]);
    let v = enc[i] ^ getMutKey(mutKey, i);
    switch (i % 10) {
      case 0: v = mutUnderscore(v); break; case 1: case 7: v = mutS(v); break;
      case 2: v = mutC(v); break; case 3: case 5: v = mutM(v); break;
      case 4: v = mutB(v); break; case 6: v = mutF(v); break;
      case 8: v = mutDollar(v); break; case 9: v = mutG(v); break;
    }
    out.push(v & 255);
  }
  return out;
}

function generateHash(path, bodySize, time) {
  const baseString = `${path}:${bodySize}:${time}`;
  const encoded = encodeURIComponent(baseString)
    .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  let data = [];
  for (let i = 0; i < encoded.length; i++) data.push(encoded.charCodeAt(i) & 0xFF);
  data = round1(data);
  data = round2(data);
  data = round3(data);
  data = round4(data);
  data = round5(data);
  return b64UrlEncode(data);
}

function signUrl(url) {
  const path = url.replace("https://comix.to/api/v2", "").split("?")[0];
  const token = generateHash(path, 0, 1);
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}time=1&_=${token}`;
}

// ── HTTP fetch helper ────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const signed = signUrl(url);
    https.get(signed, {
      headers: {
        "Referer": "https://comix.to/",
        "User-Agent": "Mozilla/5.0 (compatible; ComixTo-test/1.0)",
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${data.slice(0, 100)}`)); }
      });
    }).on("error", reject);
  });
}

// ── Test runner ──────────────────────────────────────────────────────────────

const API_BASE = "https://comix.to/api/v2";

const ORDER_PARAMS = [
  // Already proven (from homepage code) — included for comparison baseline
  { key: "relevance",        desc: "Best Match (proven - used in search)" },
  { key: "chapter_updated_at", desc: "Updated Date (proven - used in homepage)" },
  { key: "created_at",       desc: "Created Date (proven - used in homepage)" },
  { key: "follows_total",    desc: "Most Follows (proven - used in homepage)" },
  // Unknown - needs testing
  { key: "views_7d",         desc: "Most Views 7d  [TESTING]" },
  { key: "views_30d",        desc: "Most Views 1mo [TESTING]" },
  { key: "views_90d",        desc: "Most Views 3mo [TESTING]" },
  { key: "views_total",      desc: "Total Views    [TESTING]" },
];

async function testOrderParam({ key, desc }) {
  const url = `${API_BASE}/manga?order[${key}]=desc&page=1&limit=5`;
  try {
    const json = await fetchJson(url);
    if (json.status !== 200) {
      console.log(`  FAIL  (API status ${json.status}: ${json.message ?? "no message"})`);
      return { key, ok: false };
    }
    const items = json.result?.items ?? [];
    if (items.length === 0) {
      console.log(`  WARN  (0 results returned)`);
      return { key, ok: false };
    }
    const titles = items.slice(0, 3).map((m, i) => `    ${i + 1}. ${m.title}`).join("\n");
    console.log(`  OK    (${items.length} results)\n${titles}`);
    return { key, ok: true, firstId: items[0]?.manga_id };
  } catch (err) {
    console.log(`  ERROR ${err.message}`);
    return { key, ok: false };
  }
}

async function main() {
  // Verify signing works first
  console.log("=== Verifying signing (known test vector) ===");
  const expected = "xQm9tJfLwGhz_0Eq8S_YAHYkwp-q1PLfm50W5QJnyd1NnNYpAjXjyCoAzoOLru8aI60xWS0NeDGz_rNrbqBjLLP1H9qi";
  const got = generateHash("/manga/55kym/chapters", 0, 1);
  if (got === expected) {
    console.log("  Signing OK\n");
  } else {
    console.log(`  Signing MISMATCH\n  Expected: ${expected}\n  Got:      ${got}\n`);
    process.exit(1);
  }

  console.log("=== Testing order parameters ===\n");
  const results = [];
  for (const param of ORDER_PARAMS) {
    process.stdout.write(`[${param.key}] ${param.desc}\n`);
    const r = await testOrderParam(param);
    results.push(r);
    await new Promise(r => setTimeout(r, 300)); // be polite to the API
  }

  console.log("\n=== Summary ===");
  const proven = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  console.log(`  Working: ${proven.map(r => r.key).join(", ") || "none"}`);
  if (failed.length) console.log(`  Failed:  ${failed.map(r => r.key).join(", ")}`);

  // Check if all views_* params produce distinct top results
  const viewsResults = results.filter(r => r.key.startsWith("views_") && r.ok);
  if (viewsResults.length > 1) {
    const ids = viewsResults.map(r => r.firstId);
    const allDistinct = new Set(ids).size === ids.length;
    console.log(`\n  views_* top results ${allDistinct ? "ARE distinct ✓" : "are NOT distinct — may be ignored by API"}`);
  }
}

main().catch(console.error);
