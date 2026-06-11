// Shared helpers for the comix crypto pipeline.
//
// Everything keys off booting the embedded bundle (experiment/ComixBundle.ts)
// and observing it at the JS built-in boundary (atob / TextDecoder) — the
// rotation-proof technique from experiment/EXTRACTING_COMIX_CRYPTO.md. No VM
// internals are touched, so this survives name/structure rotation.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

export function bootBundle() {
  const { cfg, bundleId, code } = readBundle();
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
  return { cfg, bundleId, reqI, resI, traces, resetTraces };
}

// Drive the live signer: returns the `_` token the request interceptor injects.
export function liveSign(reqI, path) {
  const c = { url: path, method: "get", baseURL: "https://comix.to/api/v1", headers: {}, params: {} };
  const out = reqI(c) || c;
  return out?.params?._ ?? "";
}

// Drive the live decrypt: feed {e} with x-enc:1, return the response data.
export function liveDecrypt(resI, eB64) {
  const resp = {
    data: { e: eB64 }, status: 200, statusText: "OK",
    headers: { "x-enc": "1" },
    config: { url: "/x", method: "get", baseURL: "https://comix.to/api/v1" }, request: {},
  };
  const out = resI(resp) ?? resp;
  return out?.data ?? out;
}

// ---------------------------------------------------------------------------
// Cipher primitives (in-process, for extraction + validation)
// ---------------------------------------------------------------------------

export const bytes = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
export const invert = (box) => { const r = new Uint8Array(256); for (let i = 0; i < 256; i++) r[box[i]] = i; return r; };

// decrypt round: out[i] = invSbox[in[i]] ^ in[i-1] ^ key[i%len]   (in[-1] = iv)
export function decRound(inp, invSbox, key, iv) {
  const n = inp.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (invSbox[inp[i]] ^ (i === 0 ? iv : inp[i - 1]) ^ key[i % key.length]) & 0xff;
  return out;
}
// encrypt round: out[i] = sbox[ in[i] ^ out[i-1] ^ key[i%len] ]   (out[-1] = iv)
export function encRound(inp, sbox, key, iv) {
  const n = inp.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = sbox[(inp[i] ^ (i === 0 ? iv : out[i - 1]) ^ key[i % key.length]) & 0xff];
  return out;
}

// Full pipelines over canonical stages [{sbox,key,iv} in round order 1..N].
// Decrypt applies inverse stages 1..N; encrypt/sign applies forward stages N..1.
export function decryptBytes(ct, stages) {
  let d = ct;
  for (const s of stages) d = decRound(d, s.invSbox, s.key, s.iv);
  return d;
}
export function encryptBytes(pt, stages) {
  let d = pt;
  for (let r = stages.length - 1; r >= 0; r--) { const s = stages[r]; d = encRound(d, s.sbox, s.key, s.iv); }
  return d;
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
