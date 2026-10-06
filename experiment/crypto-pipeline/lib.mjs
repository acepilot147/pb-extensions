// Shared helpers for the comix crypto pipeline.
//
// Everything keys off booting the embedded bundle (experiment/ComixBundle.ts)
// and observing it from outside: the JS built-in boundary (atob / TextDecoder)
// and, for the signer, the instrumented op trace (bootBundle({instrument:true})).
// No VM internals (opcode tables, register names) are touched, so this survives
// name/structure rotation — see experiment/EXTRACTING_COMIX_CRYPTO.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

export const ROOT = resolve(process.cwd());
export const BUNDLE_PATH = resolve(ROOT, "experiment/ComixBundle.ts");

// ---------------------------------------------------------------------------
// Bundle source
// ---------------------------------------------------------------------------

export function readBundle() {
  const src = readFileSync(BUNDLE_PATH, "utf8");
  const cfg = src.match(/cfg:\s*"([^"]+)"/)?.[1];
  const bundleId = src.match(/bundleId:\s*"([^"]+)"/)?.[1] ?? "unknown";
  const codeRaw = src.match(/BUNDLE_CODE\s*=\s*"([\s\S]*?)";\s*\n/)?.[1];
  if (!cfg || !codeRaw) throw new Error("Could not parse cfg / BUNDLE_CODE from ComixBundle.ts");
  const code = JSON.parse('"' + codeRaw + '"');
  return { cfg, bundleId, code };
}

// ---------------------------------------------------------------------------
// Sandbox + boot. Satisfies the anti-tamper traps (querySelector native-code
// string, <meta name=cfg>, navigator.appCodeName) or the bundle silently
// corrupts its keys.
// ---------------------------------------------------------------------------

function buildSandbox(cfg, traces) {
  const metaCfg = {
    get content() { return cfg; },
    getAttribute(n) { return n === "content" ? cfg : n === "name" ? "cfg" : null; },
    name: "cfg",
  };
  const querySelector = (s) => (typeof s === "string" && s.includes("cfg") ? metaCfg : null);
  const querySelectorAll = (s) => (typeof s === "string" && s.toLowerCase() === "meta" ? [metaCfg] : []);
  try {
    Object.defineProperty(querySelector, "toString", { value: () => "function querySelector() { [native code] }" });
    Object.defineProperty(querySelectorAll, "toString", { value: () => "function querySelectorAll() { [native code] }" });
  } catch {}

  const realAtob = (s) => Buffer.from(s, "base64").toString("binary");
  class TracingTextDecoder {
    constructor(...a) { this._d = new TextDecoder(...a); }
    decode(buf, opts) {
      if (buf) {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf);
        traces.decoderInputs.push(Buffer.from(u8));
      }
      return this._d.decode(buf, opts);
    }
  }

  const b = {
    document: {
      querySelector, querySelectorAll,
      getElementsByTagName: (t) => (t && t.toLowerCase() === "meta" ? [metaCfg] : []),
      createElement: () => ({ style: {} }),
      head: { appendChild() {}, removeChild() {} },
      body: { appendChild() {}, removeChild() {} },
      cookie: "", readyState: "complete", addEventListener() {}, removeEventListener() {},
    },
    location: { href: "https://comix.to/", origin: "https://comix.to", host: "comix.to", hostname: "comix.to", pathname: "/", protocol: "https:", search: "", hash: "" },
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", appCodeName: "Mozilla", appName: "Netscape", language: "en-US", languages: ["en-US", "en"], platform: "Win32", cookieEnabled: true },
    screen: { width: 1920, height: 1080 },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    atob: (s) => { const r = realAtob(s); traces.atob.push(Buffer.from(r, "binary")); return r; },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    TextEncoder, TextDecoder: TracingTextDecoder, URL, URLSearchParams, crypto: globalThis.crypto,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    queueMicrotask: (cb) => Promise.resolve().then(cb),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  Object.setPrototypeOf(b, globalThis);
  b.globalThis = b; b.window = b; b.self = b; b.global = b;
  return b;
}

// Rewrite every numeric binary operator (^ & | << >> >>> + - * %) in the bundle
// into a call to globalThis.__T(op, a, b). The VM's opcode handlers are plain JS
// operators, so this exposes the arithmetic the bytecode performs — which is
// how the HMAC-SHA256 signer's midstates are read off (see extract.mjs). The
// anti-tamper does not notice: the instrumented bundle signs identically.
function instrumentCode(code) {
  const ts = createRequire(import.meta.url)("typescript");
  const K = ts.SyntaxKind;
  const OPS = {
    [K.CaretToken]: "^", [K.AmpersandToken]: "&", [K.BarToken]: "|",
    [K.LessThanLessThanToken]: "<<", [K.GreaterThanGreaterThanToken]: ">>", [K.GreaterThanGreaterThanGreaterThanToken]: ">>>",
    [K.PlusToken]: "+", [K.MinusToken]: "-", [K.AsteriskToken]: "*", [K.PercentToken]: "%",
  };
  const sf = ts.createSourceFile("b.js", `(function(){${code}\n})`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const f = ts.factory;
  const tr = (ctx) => {
    const visit = (node) => {
      node = ts.visitEachChild(node, visit, ctx);
      const op = ts.isBinaryExpression(node) && OPS[node.operatorToken.kind];
      return op ? f.createCallExpression(f.createIdentifier("__T"), undefined, [f.createStringLiteral(op), node.left, node.right]) : node;
    };
    return (n) => ts.visitNode(n, visit);
  };
  const printed = ts.createPrinter().printFile(ts.transform(sf, [tr]).transformed[0]).trim();
  return printed.replace(/^\(function \(\) \{/, "").replace(/\}\);?$/, "");
}

const OP_IMPL = {
  "^": (a, b) => a ^ b, "&": (a, b) => a & b, "|": (a, b) => a | b,
  "<<": (a, b) => a << b, ">>": (a, b) => a >> b, ">>>": (a, b) => a >>> b,
  "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "%": (a, b) => a % b,
};

// `instrument: true` boots the op-traced bundle and returns `traceOps(fn)`,
// which runs fn() and returns every numeric [op, a, b, result] it executed.
export function bootBundle({ instrument = false } = {}) {
  const { cfg, bundleId, code: rawCode } = readBundle();
  const code = instrument ? instrumentCode(rawCode) : rawCode;
  let opLog = null;
  if (instrument) {
    globalThis.__T = (op, a, b) => {
      const r = OP_IMPL[op](a, b);
      if (opLog && typeof a === "number" && typeof b === "number") opLog[opLog.length] = [op, a, b, r];
      return r;
    };
  }
  const traces = { atob: [], decoderInputs: [] };
  const sb = buildSandbox(cfg, traces);
  const exp = new Function("__sb", `with(__sb){\n${code}\n}`)(sb);
  if (!exp || typeof exp !== "object") throw new Error("bundle did not return an exports object");

  // The axios installer export rotates its name (was `r`, now `i`, …). Find it
  // by behaviour, not name: it is the export that, given an axios-like instance,
  // registers BOTH a request and a response interceptor. (Never key off the
  // export name — it reshuffles every bundle rotation.)
  const makeAxios = () => {
    let reqI = null, resI = null;
    const ax = {
      interceptors: { request: { use: (h) => (reqI = h) }, response: { use: (h) => (resI = h) } },
      defaults: { headers: { common: {}, get: {}, post: {}, put: {}, delete: {}, patch: {}, head: {} }, transformRequest: [], transformResponse: [] },
      get() {}, post() {}, put() {}, delete() {}, patch() {}, head() {},
    };
    return { ax, getReqI: () => reqI, getResI: () => resI };
  };

  let reqI = null, resI = null, installer = null;
  const swallow = () => {}; // a non-installer export (e.g. the image fetcher) may float a rejecting fetch
  process.on("unhandledRejection", swallow);
  try {
    for (const k of Object.keys(exp)) {
      if (typeof exp[k] !== "function") continue;
      const probe = makeAxios();
      try {
        const ret = exp[k](probe.ax);
        if (ret && typeof ret.then === "function") ret.then(swallow, swallow);
      } catch { continue; }
      if (probe.getReqI() && probe.getResI()) { installer = k; reqI = probe.getReqI(); resI = probe.getResI(); break; }
    }
  } finally {
    process.removeListener("unhandledRejection", swallow);
  }
  if (!installer) throw new Error("could not locate axios installer export (none registered request+response interceptors)");

  const resetTraces = () => { traces.atob.length = 0; traces.decoderInputs.length = 0; };
  const traceOps = (fn) => {
    if (!instrument) throw new Error("traceOps requires bootBundle({ instrument: true })");
    opLog = [];
    try { fn(); return opLog; } finally { opLog = null; }
  };
  return { cfg, bundleId, reqI, resI, traces, resetTraces, traceOps };
}

// Drive the live signer: returns the `_` token the request interceptor injects.
// A query string in `path` is ignored by the bundle — pass params via liveSignParams.
export function liveSign(reqI, path) {
  return liveSignParams(reqI, path, {});
}

// Drive the live signer with an axios params object (what the site does). The
// bundle signs path + "?" + its canonical serialization of params.
export function liveSignParams(reqI, path, params) {
  const c = { url: path, method: "get", baseURL: "https://comix.to/api/v1", headers: {}, params: JSON.parse(JSON.stringify(params)) };
  const out = reqI(c) || c;
  return out?.params?._ ?? "";
}

// Drive the live decrypt: feed {e} with the given x-enc, return the response data.
export function liveDecrypt(resI, eB64, xenc = "2") {
  const resp = {
    data: { e: eB64 }, status: 200, statusText: "OK",
    headers: { "x-enc": xenc },
    config: { url: "/x", method: "get", baseURL: "https://comix.to/api/v1" }, request: {},
  };
  const out = resI(resp) ?? resp;
  return out?.data ?? out;
}

// ---------------------------------------------------------------------------
// Reference implementations of the current families (in-process, for
// extraction + validation). See README "The algorithm".
// ---------------------------------------------------------------------------

export const bytes = (b64) => new Uint8Array(Buffer.from(b64, "base64"));

// xor-offset decrypt (x-enc 2): ct = [h0, h1, body...];
//   off = ((h0 << 8) | h1) % K.length;  pt[i] = body[i] ^ K[(off + i) % K.length]
export function xorOffsetDecrypt(ct, K) {
  const off = ((ct[0] << 8) | ct[1]) % K.length;
  const out = new Uint8Array(Math.max(0, ct.length - 2));
  for (let i = 0; i < out.length; i++) out[i] = ct[i + 2] ^ K[(off + i) % K.length];
  return out;
}
export function xorOffsetEncrypt(pt, K, header = [0, 0]) {
  const ct = new Uint8Array(pt.length + 2);
  ct[0] = header[0]; ct[1] = header[1];
  const off = ((header[0] << 8) | header[1]) % K.length;
  for (let i = 0; i < pt.length; i++) ct[i + 2] = pt[i] ^ K[(off + i) % K.length];
  return ct;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
export const SHA256_K0 = SHA256_K[0];
export const SHA256_K63 = SHA256_K[63];

// SHA-256 resumed from a midstate after `prefixLen` already-absorbed bytes
// (an HMAC ipad/opad block is 64 bytes).
export function sha256From(state, prefixLen, msg) {
  const h = state.map((x) => x | 0);
  const padLen = (msg.length + 9 + 63) & ~63;
  const buf = new Uint8Array(padLen);
  buf.set(msg); buf[msg.length] = 0x80;
  const bits = (prefixLen + msg.length) * 8;
  for (let i = 0; i < 4; i++) buf[padLen - 1 - i] = (bits >>> (8 * i)) & 0xff;
  const w = new Int32Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (buf[off + 4 * i] << 24) | (buf[off + 4 * i + 1] << 16) | (buf[off + 4 * i + 2] << 8) | buf[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = w[i - 16] + ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) + w[i - 7] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
      const t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    for (let i = 0; i < 8; i++) h[i] |= 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[4 * i] = h[i] >>> 24; out[4 * i + 1] = (h[i] >>> 16) & 255; out[4 * i + 2] = (h[i] >>> 8) & 255; out[4 * i + 3] = h[i] & 255; }
  return out;
}

// HMAC-SHA256 from precomputed ipad/opad midstates, truncated and prefixed:
//   prefix + b64url(HMAC(key, msg)[0:macBytes])
export function hmacMidstateSign(msg, { istate, ostate, prefix, macBytes }) {
  const inner = sha256From(istate, 64, utf8Encode(msg));
  const outer = sha256From(ostate, 64, inner);
  return prefix + b64url(outer.subarray(0, macBytes));
}

// base64url, no padding (matches the bundle's token encoding).
export const b64url = (u8) => Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function utf8Encode(str) { return new Uint8Array(Buffer.from(str, "utf8")); }
export function utf8Decode(u8) { return Buffer.from(u8).toString("utf8"); }

export function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
}
