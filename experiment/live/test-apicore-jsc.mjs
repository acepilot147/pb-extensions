// Run src/ComixTo/ComixApicore.ts in a bare vm realm — no URL, TextEncoder,
// atob, Buffer, timers (roughly Paperback's JavaScriptCore) — against saved
// apicore builds, and check that booting apicore leaves the realm's built-ins alone.
//
//   node experiment/live/test-apicore-jsc.mjs <apicore.js> <chunk.js> [expectPrefix]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import { snapshot as takeSnapshot, assertUnchanged } from "./runtime-test-utils.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ts = createRequire(join(ROOT, "package.json"))("typescript");
const [apicorePath, chunkPath, expectPrefix] = process.argv.slice(2);

const realm = vm.createContext({});
const missing = vm.runInContext("['URL','TextEncoder','TextDecoder','atob','btoa','Buffer','setTimeout','process','require','fetch'].filter(n => typeof globalThis[n] !== 'undefined')", realm);
if (missing.length) throw new Error("realm unexpectedly has: " + missing);

const cache = {};
const load = (name) => {
    if (cache[name]) return cache[name].exports;
    const src = readFileSync(join(ROOT, "src/ComixTo", name + ".ts"), "utf8");
    const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = (cache[name] = { exports: {} });
    vm.runInContext(`(function(exports, require, module){${js}\n})`, realm)(module.exports, (r) => load(r.replace("./", "")), module);
    return module.exports;
};

const snapshot = () => takeSnapshot(realm);

const { extractApicoreKeys } = load("ComixApicore");
const before = snapshot();
const t0 = Date.now();
const k = await extractApicoreKeys(readFileSync(apicorePath, "utf8"), readFileSync(chunkPath, "utf8"));
const ms = Date.now() - t0;
const after = snapshot();
console.log(`key ${k.prefix} macBytes=${k.macBytes} istate[0]=0x${k.istate[0].toString(16)} table=${k.table.length}B  ${ms}ms`);
assertUnchanged(before, after);
console.log("built-in identities, prototypes and descriptors untouched");
const negative = vm.createContext({});
const baseline = takeSnapshot(negative);
vm.runInContext("Object.keys = () => []", negative);
assert.throws(() => assertUnchanged(baseline, takeSnapshot(negative)), /descriptor value changed/);
console.log("integrity negative control: PASS");
if (expectPrefix && k.prefix !== expectPrefix) { console.log(`expected ${expectPrefix}`); process.exit(1); }
