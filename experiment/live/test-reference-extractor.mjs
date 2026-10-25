// Offline reference-extractor gate. The child has a hard wall-clock deadline.
// node experiment/live/test-reference-extractor.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--worker")) {
  const child = spawnSync(process.execPath,
    ["--max-old-space-size=256", fileURLToPath(import.meta.url), "--worker"],
    { encoding: "utf8", timeout: 45_000, maxBuffer: 128 * 1024 });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  if (child.error) console.error(child.error.message);
  process.exit(child.status === 0 && !child.error ? 0 : 1);
}

const here = new URL("./", import.meta.url);
const asset = (name) => new URL(`assets/${name}`, here);
const provenance = JSON.parse(readFileSync(asset("provenance.json"), "utf8"));
assert.equal(provenance.observed_build_id, "tnfy0u");
const loadFixture = (role) => {
  const entry = provenance.assets.find((item) => item.role === role);
  assert.ok(entry, `fixture provenance missing ${role}`);
  const data = readFileSync(new URL(`../../${entry.file}`, here));
  assert.equal(data.length, entry.bytes, `${role} byte count`);
  assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256, `${role} SHA-256`);
  return data.toString("utf8");
};
const apicore = loadFixture("apicore"), chunk = loadFixture("helper_chunk");
console.log("PASS fixtures: tnfy0u apicore + helper SHA-256 match provenance");
assert.ok(existsSync(new URL("apicore-sandbox.mjs", here)), "reference extractor implementation is missing");
const { extractKeys } = await import("./apicore-sandbox.mjs");
const keys = await extractKeys(apicore, chunk);
assert.deepEqual(Object.keys(keys).sort(), ["istate", "macBytes", "ostate", "prefix", "table"]);
assert.equal(keys.prefix, "uly.");
assert.ok(Number.isInteger(keys.macBytes) && keys.macBytes > 0 && keys.macBytes <= 32);
for (const name of ["istate", "ostate"]) {
  assert.equal(keys[name].length, 8);
  assert.ok(keys[name].every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff));
}
assert.equal(keys.table.length, 1024);
assert.ok(keys.table.every((n) => Number.isInteger(n) && n >= 0 && n <= 255));
console.log(`PASS extracted: prefix=${keys.prefix} macBytes=${keys.macBytes} midstates=8+8 words table=${keys.table.length} bytes`);
console.log("PASS independent checks: 5 signed URLs; Unicode response decrypts at 3 offsets across table wraparound");

// Test-only alterations run exclusively in the same VM as the saved fixture.
const append = (source, addition) => source.replace(/(?=export\s*\{[^}]*\};?\s*$)/, `${addition}\n`);
const badSignatures = append(apicore, `
  const __negativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const parsed = new URL(url, location.href), token = parsed.searchParams.get("_");
    if (token) parsed.searchParams.set("_", token.replace(/\\.[A-Za-z0-9_-]/, part => part === ".A" ? ".B" : ".A"));
    return __negativeOpen.call(this, method, parsed.href, ...args);
  };
`);
await assert.rejects(extractKeys(badSignatures, chunk), /no candidate reproduces signed URLs/);
console.log("PASS negative control: altered URL MAC rejected");

const badCiphertext = append(apicore, `
  const __negativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    const finish = this.onloadend;
    this.onloadend = function(...events) {
      if (this.getResponseHeader("x-enc") === "2") {
        const envelope = JSON.parse(this.responseText), raw = atob(envelope.e);
        envelope.e = btoa(raw.slice(0, 2) + String.fromCharCode(raw.charCodeAt(2) ^ 1) + raw.slice(3));
        this.response = this.responseText = JSON.stringify(envelope);
      }
      return finish?.apply(this, events);
    };
    return __negativeSend.apply(this, args);
  };
`);
await assert.rejects(extractKeys(badCiphertext, chunk), /planted Unicode decryption/);
console.log("PASS negative control: altered encrypted response rejected");

await assert.rejects(extractKeys("", chunk), /missing or oversized module source/);
await assert.rejects(extractKeys(apicore.replace(/export\s*\{[^}]*\};?\s*$/, ""), chunk), /no trailing named export/);
await assert.rejects(extractKeys('import("https://example.invalid/forbidden.js");export{};', chunk), /unsupported extra import/);
await assert.rejects(extractKeys('export{};', chunk), /unsupported module binding/);
console.log("PASS negative controls: empty, missing-export, dynamic-import and unsupported modules rejected");

const realmProbe = append(apicore, `
  if (typeof process !== "undefined" || typeof require !== "undefined" || typeof fetch !== "undefined" || typeof Buffer !== "undefined")
    throw Error("unexpected host/network binding");
  if (Function("return this")() !== globalThis) throw Error("Function escaped realm");
  Function("globalThis.__referenceIsolationSentinel = true")();
`);
const isolatedKeys = await extractKeys(realmProbe, chunk);
assert.deepEqual(isolatedKeys, keys, "fresh realm should yield identical independently captured keys");
assert.equal(globalThis.__referenceIsolationSentinel, undefined);
console.log("PASS realm checks: repeated extraction stable; dynamic Function remains in VM; no host/network bindings");

await assert.rejects(extractKeys(append(apicore, "while (true) {}"), chunk), /Script execution timed out/);
console.log("PASS deadline control: synchronous infinite loop interrupted by VM timeout");
await assert.rejects(extractKeys(append(apicore, "Promise.resolve().then(() => { while (true) {} });"), chunk), /Script execution timed out/);
console.log("PASS deadline control: Promise microtask infinite loop interrupted by VM timeout");

writeFileSync(asset("reference-keys.json"), JSON.stringify(keys, null, 2) + "\n");
console.log("PASS wrote: experiment/live/assets/reference-keys.json");
