// Offline, independent Node reference for saved apicore modules.
// This VM is a COMPATIBILITY HARNESS, NOT a hostile-code security sandbox.
// Native WHATWG objects cross the realm boundary; only use reviewed fixtures.
// Downloaded source and every callback execute inside vm.runInContext with a
// timeout. No host eval/Function, production TS/crypto, real XHR, or live fetch.
// Run test-reference-extractor.mjs for a memory/wall-clock-capped subprocess.
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import vm from "node:vm";
import { hmacMidstateSign, xorOffsetEncrypt } from "../crypto-pipeline/lib.mjs";

const LIMITS = Object.freeze({ source: 2_000_000, scriptMs: 1500, totalMs: 15_000, functions: 160 });

// This intentionally supports only the saved bundles' named-import/export
// form, not arbitrary ESM. All transformed source still executes in the VM.
function moduleBody(source, allowImport) {
  if (typeof source !== "string" || !source.length || source.length > LIMITS.source) {
    throw new Error("reference: missing or oversized module source");
  }
  const ending = /export\s*\{([^}]*)\};?\s*$/.exec(source);
  if (!ending) throw new Error("reference: no trailing named export");
  const binding = /^([$A-Z_a-z][$\w]*)(?:\s+as\s+([$A-Z_a-z][$\w]*))?$/;
  function bindings(text, imports) {
    return text.split(",").map((part) => {
      const m = binding.exec(part.trim());
      if (!m) throw new Error("reference: unsupported module binding");
      return imports ? `${JSON.stringify(m[1])}:${m[2] ?? m[1]}` : `${JSON.stringify(m[2] ?? m[1])}:${m[1]}`;
    }).join(",");
  }
  let imports = 0;
  let body = source.slice(0, ending.index).replace(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?/g, (_, names, specifier) => {
    if (!allowImport || ++imports > 1 || !/^\.\/[\w.-]+\.js$/.test(specifier)) {
      throw new Error("reference: unexpected module import");
    }
    return `const {${bindings(names, true)}} = __referenceChunk;`;
  });
  if (/\bimport\s*[({*"']|\bimport\.meta|\bexport\s/.test(body)) {
    throw new Error("reference: unsupported extra import/export");
  }
  body += `\n;return {${bindings(ending[1], false)}};`;
  return `(function(){"use strict";\n${body}\n})()`;
}

// Everything in this scaffold belongs to the VM realm, including Promise,
// Function, instrumentation, XHR events, and invoked API functions.
const SCAFFOLD = `(() => {
  const noop = () => {};
  const candidates = [], tables = [], requests = [];
  const NativeProxy = Proxy, NativeU8 = Uint8Array;
  Uint8Array = new NativeProxy(NativeU8, {
    construct(target, args, newTarget) {
      const result = Reflect.construct(target, args, newTarget);
      if (result.length >= 1024 && result.length <= 8192) {
        if (candidates.length >= 400) throw Error("reference: buffer observation limit");
        candidates.push(result);
      }
      return result;
    }
  });
  Proxy = new NativeProxy(NativeProxy, {
    construct(target, args, newTarget) {
      const object = args[0];
      if (object && typeof object === "object" && Object.keys(object).some(k => typeof object[k] === "function")) {
        if (tables.length >= 64) throw Error("reference: API table limit");
        tables.push(object);
      }
      return Reflect.construct(target, args, newTarget);
    }
  });
  const element = () => ({ style: {}, setAttribute: noop, appendChild: noop,
    removeChild: noop, addEventListener: noop, removeEventListener: noop, remove: noop, contentWindow: null });
  const storage = () => {
    const map = new Map();
    return { getItem: k => map.get(String(k)) ?? null, setItem: (k,v) => map.set(String(k),String(v)),
      removeItem: k => map.delete(String(k)), clear: () => map.clear(), key: i => [...map.keys()][i] ?? null,
      get length() { return map.size; } };
  };
  Object.assign(globalThis, {
    document: { cookie: "", readyState: "complete", visibilityState: "visible", hidden: false, referrer: "", title: "Comix",
      body: element(), head: element(), documentElement: element(), createElement: element,
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [],
      addEventListener: noop, removeEventListener: noop },
    navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      language: "en-US", languages: ["en-US"], cookieEnabled: true, webdriver: false, product: "Gecko", platform: "iPhone", onLine: true },
    location: { href: "https://comix.to/", origin: "https://comix.to", protocol: "https:", host: "comix.to", hostname: "comix.to",
      port: "", pathname: "/", search: "", hash: "", reload: noop, assign: noop, replace: noop },
    history: { pushState: noop, replaceState: noop, back: noop }, screen: { width: 390, height: 844 },
    localStorage: storage(), sessionStorage: storage(),
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    queueMicrotask: f => Promise.resolve().then(f),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true, postMessage: noop, reportError: noop
  });
  window = self = globalThis;
  let answer = { status: 200, headers: { "content-type": "application/json" }, body: '{"status":"ok","result":{}}' };
  let issued = 0;
  class XHR {
    readyState = 0; status = 0; statusText = ""; responseText = ""; response = ""; responseURL = "";
    onloadend = null; onerror = null; onabort = null; ontimeout = null; onreadystatechange = null; onload = null;
    upload = { addEventListener: noop };
    headers = {}; method = "GET"; url = "";
    open(method, url) { this.method = String(method).toUpperCase(); this.url = String(url); this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return Object.entries(this.headers).map(([k,v]) => k + ": " + v).join("\\r\\n"); }
    getResponseHeader(name) { return this.headers[String(name).toLowerCase()] ?? null; }
    addEventListener(type, fn) { this["on" + type] = fn; }
    removeEventListener() {}
    abort() {}
    send() {
      Promise.resolve().then(() => {
        if (++issued > 512) throw Error("reference: fake request limit");
        const url = new URL(this.url, "https://comix.to/").href;
        requests.push({ url, method: this.method });
        this.headers = {};
        for (const [k,v] of Object.entries(answer.headers)) this.headers[k.toLowerCase()] = v;
        this.status = answer.status; this.statusText = "OK";
        this.responseText = this.response = answer.body; this.responseURL = url; this.readyState = 4;
        this.onreadystatechange?.(); this.onload?.(); this.onloadend?.();
      });
    }
  }
  XMLHttpRequest = XHR;
  let functions = [], state = null;
  __referenceHarness = {
    collect() {
      functions = [...new Set(tables.flatMap(t => Object.values(t).filter(f => typeof f === "function")))];
      return functions.length;
    },
    invoke(index, args) {
      requests.length = 0;
      const current = state = { done: false, value: null, error: null };
      Promise.resolve().then(() => functions[index](...args)).then(
        value => { current.done = true; current.value = value ?? null; },
        error => { current.done = true; current.error = String(error?.message ?? error); }
      );
    },
    report() { return JSON.stringify({ ...state, requests }); },
    buffers() { return JSON.stringify(candidates.filter(b => b.length >= 1088).map(b => Array.from(b))); },
    answer(value) { answer = value; }
  };
})()`;

function boot(apicoreSource, chunkSource) {
  // Transform/validate both modules before running either one.
  const chunkCode = moduleBody(chunkSource, false), apicoreCode = moduleBody(apicoreSource, true);
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Blob,
    crypto: { getRandomValues: (array) => webcrypto.getRandomValues(array) },
  }, { name: "offline-apicore-reference", microtaskMode: "afterEvaluate", codeGeneration: { strings: true, wasm: false } });
  const deadline = Date.now() + LIMITS.totalMs;
  function run(code, filename = "reference-harness.js") {
    if (Date.now() >= deadline) throw new Error("reference: extraction deadline exceeded");
    return new vm.Script(code, { filename }).runInContext(context, { timeout: Math.min(LIMITS.scriptMs, Math.max(1, deadline - Date.now())) });
  }
  run(SCAFFOLD);
  run(`globalThis.__referenceChunk = ${chunkCode}`, "saved-helper.js");
  run(apicoreCode, "saved-apicore.js");
  const count = run("__referenceHarness.collect()");
  if (!count || count > LIMITS.functions) throw new Error(`reference: invalid API function count ${count}`);
  return {
    count,
    invoke(index, args) {
      // Never invoke a realm function on the host: this also covers Promise jobs.
      run(`__referenceHarness.invoke(${index}, ${JSON.stringify(args)})`);
      let result = JSON.parse(run("__referenceHarness.report()"));
      for (let i = 0; !result.done && i < 8; i++) {
        run("void 0");
        result = JSON.parse(run("__referenceHarness.report()"));
      }
      return result;
    },
    buffers: () => JSON.parse(run("__referenceHarness.buffers()")),
    answer: (value) => run(`__referenceHarness.answer(${JSON.stringify(value)})`),
  };
}

// Canonicalize the actual captured URL with native WHATWG parsing. No
// generated/production signer or URL/text/base64 shim participates here.
function signedMessage(url) {
  const parsed = new URL(url);
  const groups = new Map(), counts = new Map();
  for (const [name, value] of parsed.searchParams) {
    if (name === "_") continue;
    const base = name.includes("[") ? name.slice(0, name.indexOf("[")) : name;
    let key = name;
    if (name.endsWith("[]")) {
      const index = counts.get(base) ?? 0;
      counts.set(base, index + 1);
      key = `${base}[${index}]`;
    }
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(`${key}=${value}`);
  }
  const query = [...groups.keys()].sort().flatMap(key => groups.get(key)).join("&");
  const path = parsed.pathname.replace(/^\/api\/v1(?=\/|$)/, "");
  return query ? `${path}?${query}` : path;
}

/** Return keys only after independent signing and Unicode decryption gates. */
export async function extractKeys(apicoreSrc, chunkSrc) {
  const realm = boot(apicoreSrc, chunkSrc);
  const probe = "/manga/__reference_probe__";
  let client = -1;
  for (let index = 0; index < realm.count; index++) {
    const result = realm.invoke(index, [probe]);
    if (result.requests.some(({ method, url }) => method === "GET" &&
      new URL(url).pathname === `/api/v1${probe}` && new URL(url).searchParams.has("_"))) {
      client = index;
      break;
    }
  }
  if (client < 0) throw new Error("reference: no signing client found");
  const probes = [
    ["/manga/abc12"],
    ["/manga/abc12/chapters", { params: { page: 1, limit: 20, order: { number: "desc" } } }],
    ["/chapters/12345678"],
    ["/manga", { params: { keyword: "café 東京 🚀 + & =", genres_ex: [8, 9], page: 2 } }],
    ["/manga", { params: { z: "last", a: "a b", nested: { child: "✓" } } }],
  ];
  const signed = probes.map(args => {
    const result = realm.invoke(client, args);
    if (!result.done || result.error || result.requests.length !== 1 || result.requests[0].method !== "GET") {
      throw new Error(`reference: signing probe failed (${result.error ?? "no single completed GET"})`);
    }
    const url = result.requests[0].url;
    return { message: signedMessage(url), token: new URL(url).searchParams.get("_") };
  });
  const shape = /^([A-Za-z0-9_-]+\.)([A-Za-z0-9_-]+)$/.exec(signed[0].token ?? "");
  if (!shape) throw new Error("reference: unexpected signing token shape");
  const prefix = shape[1], macBytes = Buffer.from(shape[2], "base64url").length;
  if (macBytes < 1 || macBytes > 32 || Buffer.from(shape[2], "base64url").toString("base64url") !== shape[2]) {
    throw new Error("reference: invalid token MAC encoding");
  }
  let keys;
  const candidates = realm.buffers();
  for (const candidate of candidates) {
    const buffer = Buffer.from(candidate);
    const words = off => Array.from({ length: 8 }, (_, i) => buffer.readUInt32BE(off + 4 * i));
    const trial = { prefix, macBytes, istate: words(0), ostate: words(32), table: [...buffer.subarray(64, 1088)] };
    if (signed.every(({ message, token }) => hmacMidstateSign(message, trial) === token)) {
      keys = trial;
      break;
    }
  }
  if (!keys) throw new Error(`reference: no candidate reproduces signed URLs (${candidates.length} candidates)`);
  const planted = { status: "ok", result: {
    probe: randomBytes(16).toString("hex"), text: "héllo ✓ 東京 🚀 e\u0301\u0000",
    // Longer than the complete XOR table: prove wraparound, not just a prefix.
    padding: "café 🌍 ".repeat(160),
  } };
  for (const header of [[0, 0], [3, 255], [255, 254]]) {
    const encrypted = xorOffsetEncrypt(Buffer.from(JSON.stringify(planted), "utf8"), keys.table, header);
    realm.answer({ status: 200, headers: { "content-type": "application/json", "x-enc": "2" },
      body: JSON.stringify({ e: Buffer.from(encrypted).toString("base64") }) });
    const result = realm.invoke(client, ["/manga/abc12"]);
    const got = result.value?.data ?? result.value;
    if (!result.done || result.error) throw new Error(`reference: planted Unicode decryption failed (${result.error ?? "pending"})`);
    assert.deepEqual(got?.result ?? got, planted.result, "reference: planted Unicode decryption mismatch");
  }
  return keys;
}
