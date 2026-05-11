"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(process.env.COMIX_SOURCE_ROOT || path.join(__dirname, ".."));
const SIGNER_FILE = path.join(REPO_ROOT, "src", "ComixTo", "ComixFastSigner.ts");
const DECRYPT_FILE = path.join(REPO_ROOT, "src", "ComixTo", "ComixFastDecrypt.ts");
const OUT_FILE = path.join(__dirname, "comix-fast-constants.json");
const PERIOD = 160;

const OP_XOR = 0;
const OP_ADD_XOR = 1;
const OP_ROTL1_XOR = 2;
const OP_ROTR1_XOR = 3;
const OP_ROTL2_XOR = 4;
const OP_ROTR2_XOR = 5;
const OP_NIBSWAP_XOR = 6;
const OP_ROTL3_XOR = 7;
const OP_ROTR3_XOR = 8;
const OP_XOR_ADD = 9;
const OP_XOR_ROTL1 = 10;
const OP_XOR_ROTR1 = 11;
const OP_XOR_ROTL2 = 12;
const OP_XOR_ROTR2 = 13;
const OP_XOR_NIBSWAP = 14;
const OP_XOR_ROTL3 = 15;
const OP_XOR_ROTR3 = 16;

const rotL1 = (n) => ((n << 1) | (n >>> 7)) & 0xff;
const rotR1 = (n) => ((n >>> 1) | (n << 7)) & 0xff;
const rotL2 = (n) => ((n << 2) | (n >>> 6)) & 0xff;
const rotR2 = (n) => ((n >>> 2) | (n << 6)) & 0xff;
const rotL3 = (n) => ((n << 3) | (n >>> 5)) & 0xff;
const rotR3 = (n) => ((n >>> 3) | (n << 5)) & 0xff;
const nibSwap = (n) => ((n << 4) | (n >>> 4)) & 0xff;

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function getHeaderValue(source, label) {
  const match = source.match(new RegExp(`${label}:\\s*([^\\r\\n*]+)`));
  if (!match) throw new Error(`Could not find generated header value: ${label}`);
  return match[1].trim();
}

function extractArrayLiteral(source, constName) {
  const constIndex = source.indexOf(`const ${constName}`);
  if (constIndex < 0) throw new Error(`Could not find const ${constName}`);

  const equalsIndex = source.indexOf("=", constIndex);
  if (equalsIndex < 0) throw new Error(`Could not find assignment for ${constName}`);

  const start = source.indexOf("[", equalsIndex);
  if (start < 0) throw new Error(`Could not find array literal for ${constName}`);

  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  throw new Error(`Unterminated array literal for ${constName}`);
}

function parseGeneratedArray(source, constName) {
  const literal = extractArrayLiteral(source, constName);
  return Function(`"use strict"; return (${literal});`)();
}

function assertOrder(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} pipeline order ${JSON.stringify(value)} is not supported`);
  }
}

function statIso(file) {
  return fs.statSync(file).mtime.toISOString();
}

function bytesB64(values) {
  return Buffer.from(values.map((v) => v & 0xff)).toString("base64");
}

function decodeB64(value) {
  return Array.from(Buffer.from(String(value || ""), "base64"));
}

function matches(map, fn) {
  for (let b = 0; b < 256; b += 1) {
    if ((fn(b) & 0xff) !== map[b]) return false;
  }
  return true;
}

function inferDecryptOp(map) {
  const xorKey = map[0] & 0xff;
  if (matches(map, (b) => b ^ xorKey)) return [OP_XOR, xorKey, 0];

  for (let add = 0; add < 256; add += 1) {
    const key = (map[0] ^ add) & 0xff;
    if (matches(map, (b) => (((b + add) & 0xff) ^ key))) return [OP_ADD_XOR, key, add];
  }

  for (let add = 0; add < 256; add += 1) {
    const key = (map[0] - add) & 0xff;
    if (matches(map, (b) => (((b ^ key) + add) & 0xff))) return [OP_XOR_ADD, key, add];
  }

  const rotCandidates = [
    [OP_ROTL1_XOR, rotL1],
    [OP_ROTR1_XOR, rotR1],
    [OP_ROTL2_XOR, rotL2],
    [OP_ROTR2_XOR, rotR2],
    [OP_NIBSWAP_XOR, nibSwap],
    [OP_ROTL3_XOR, rotL3],
    [OP_ROTR3_XOR, rotR3],
  ];
  for (const [op, transform] of rotCandidates) {
    const key = transform(0) ^ map[0];
    if (matches(map, (b) => transform(b) ^ key)) return [op, key, 0];
  }

  const xorThenRotCandidates = [
    [OP_XOR_ROTL1, rotL1, rotR1],
    [OP_XOR_ROTR1, rotR1, rotL1],
    [OP_XOR_ROTL2, rotL2, rotR2],
    [OP_XOR_ROTR2, rotR2, rotL2],
    [OP_XOR_NIBSWAP, nibSwap, nibSwap],
    [OP_XOR_ROTL3, rotL3, rotR3],
    [OP_XOR_ROTR3, rotR3, rotL3],
  ];
  for (const [op, transform, inverse] of xorThenRotCandidates) {
    const key = inverse(map[0] & 0xff);
    if (matches(map, (b) => transform(b ^ key))) return [op, key, 0];
  }

  throw new Error(`Could not infer decrypt op from table row: ${map.slice(0, 16).join(",")}`);
}

function compactInsertStage(stage) {
  return {
    prefix: stage.prefix,
    prefixBytesB64: bytesB64(stage.prefixBytes),
    opsB64: bytesB64(stage.ops)
  };
}

function compactMutationStage(stage) {
  const table = decodeB64(stage.table);
  if (table.length !== PERIOD * 256) {
    throw new Error(`Unexpected decrypt mutation table length: ${table.length}`);
  }

  const ops = [];
  for (let residue = 0; residue < PERIOD; residue += 1) {
    const start = residue * 256;
    ops.push(...inferDecryptOp(table.slice(start, start + 256)));
  }

  return {
    prefix: stage.prefix,
    opsB64: bytesB64(ops)
  };
}

function validateCompactPayload(payload) {
  if (payload.signer.rc4Keys.length !== payload.signer.insertStages.length) {
    throw new Error("Signer key/stage count mismatch");
  }
  if (payload.decrypt.rc4Keys.length !== payload.decrypt.mutationStages.length) {
    throw new Error("Decrypt key/stage count mismatch");
  }
  for (const stage of payload.signer.insertStages) {
    if (decodeB64(stage.prefixBytesB64).length !== stage.prefix) {
      throw new Error("Signer prefix byte count mismatch");
    }
    if (decodeB64(stage.opsB64).length !== PERIOD * 3) {
      throw new Error("Signer ops length mismatch");
    }
  }
  for (const stage of payload.decrypt.mutationStages) {
    if (decodeB64(stage.opsB64).length !== PERIOD * 3) {
      throw new Error("Decrypt ops length mismatch");
    }
  }
}

function buildPayload() {
  const signerSource = readText(SIGNER_FILE);
  const decryptSource = readText(DECRYPT_FILE);

  const signerBundleId = getHeaderValue(signerSource, "Bundle ID");
  const decryptBundleId = getHeaderValue(decryptSource, "Bundle ID");
  if (signerBundleId !== decryptBundleId) {
    throw new Error(`Signer/decrypt bundle mismatch: ${signerBundleId} != ${decryptBundleId}`);
  }

  const signerOrder = getHeaderValue(signerSource, "Pipeline order");
  const decryptOrder = getHeaderValue(decryptSource, "Pipeline order");
  assertOrder(signerOrder, ["rc4-then-insert", "insert-then-rc4"], "signer");
  assertOrder(decryptOrder, ["mutation-then-rc4", "rc4-then-mutation"], "decrypt");

  const signerInsertStages = parseGeneratedArray(signerSource, "INSERT_STAGES").map(compactInsertStage);
  const decryptMutationStages = parseGeneratedArray(decryptSource, "MUTATION_STAGES").map(compactMutationStage);

  const payload = {
    schemaVersion: 2,
    kind: "comix-fast-runtime-constants",
    encoding: "compact-b64-ops",
    period: PERIOD,
    bundleId: signerBundleId,
    generatedAt: new Date().toISOString(),
    sourceModifiedAt: {
      signer: statIso(SIGNER_FILE),
      decrypt: statIso(DECRYPT_FILE)
    },
    signer: {
      pipelineOrder: signerOrder,
      roundSteps: signerOrder.split("-then-"),
      rc4Keys: parseGeneratedArray(signerSource, "RC4_KEYS"),
      insertStages: signerInsertStages
    },
    decrypt: {
      pipelineOrder: decryptOrder,
      roundSteps: decryptOrder.split("-then-"),
      rc4Keys: parseGeneratedArray(decryptSource, "RC4_KEYS"),
      mutationStages: decryptMutationStages
    }
  };

  validateCompactPayload(payload);

  return payload;
}

const payload = buildPayload();
const previousSize = fs.existsSync(OUT_FILE) ? fs.statSync(OUT_FILE).size : 0;
fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload)}\n`);
const outputSize = fs.statSync(OUT_FILE).size;
console.log(JSON.stringify({
  ok: true,
  output: OUT_FILE,
  schemaVersion: payload.schemaVersion,
  encoding: payload.encoding,
  previousBytes: previousSize,
  outputBytes: outputSize,
  bundleId: payload.bundleId,
  signerOrder: payload.signer.pipelineOrder,
  signerRounds: payload.signer.rc4Keys.length,
  decryptOrder: payload.decrypt.pipelineOrder,
  decryptRounds: payload.decrypt.rc4Keys.length
}, null, 2));
