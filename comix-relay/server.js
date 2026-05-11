"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const CONSTANTS_FILE = path.join(__dirname, "comix-fast-constants.json");
const PERIOD = 160;

function assertOrder(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} pipeline order ${JSON.stringify(value)} is not supported`);
  }
}

function decodeB64(value) {
  return Buffer.from(String(value || ""), "base64");
}

function buildPayload() {
  const payload = JSON.parse(fs.readFileSync(CONSTANTS_FILE, "utf8"));

  if (payload.schemaVersion !== 2) throw new Error("Unsupported constants schema version");
  if (payload.kind !== "comix-fast-runtime-constants") throw new Error("Unexpected constants kind");
  if (payload.encoding !== "compact-b64-ops") throw new Error("Unexpected constants encoding");
  if (payload.period !== PERIOD) throw new Error("Unexpected constants period");
  assertOrder(payload.signer?.pipelineOrder, ["rc4-then-insert", "insert-then-rc4"], "signer");
  assertOrder(payload.decrypt?.pipelineOrder, ["mutation-then-rc4", "rc4-then-mutation"], "decrypt");
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

  return { ...payload, servedAt: new Date().toISOString() };
}

function jsonResponse(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...extraHeaders
  });
  res.end(text);
}

function constantsResponse(res) {
  const payload = buildPayload();
  const text = JSON.stringify(payload);
  const etag = `"${crypto.createHash("sha256").update(text).digest("base64url")}"`;

  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "etag": etag
  });
  res.end(text);
}

function requestHandler(req, res) {
  try {
    if (!req.url || req.method !== "GET") {
      jsonResponse(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/healthz") {
      jsonResponse(res, 200, {
        ok: true,
        service: "comix-fast-constants-relay",
        endpoints: ["/comix-fast-constants.json", "/api/comix-fast-constants"]
      });
      return;
    }

    if (url.pathname === "/comix-fast-constants.json" || url.pathname === "/api/comix-fast-constants") {
      constantsResponse(res);
      return;
    }

    jsonResponse(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    jsonResponse(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
}

if (process.argv.includes("--check")) {
  const payload = buildPayload();
  console.log(JSON.stringify({
    ok: true,
    bundleId: payload.bundleId,
    schemaVersion: payload.schemaVersion,
    encoding: payload.encoding,
    signerOrder: payload.signer.pipelineOrder,
    signerRounds: payload.signer.rc4Keys.length,
    decryptOrder: payload.decrypt.pipelineOrder,
    decryptRounds: payload.decrypt.rc4Keys.length
  }, null, 2));
} else {
  http.createServer(requestHandler).listen(PORT, () => {
    console.log(`comix fast constants relay listening on :${PORT}`);
  });
}
