"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const CONSTANTS_FILE = path.join(__dirname, "comix-fast-constants.json");
const REFRESH_SCRIPT = path.join(__dirname, "refresh-constants.js");
const PERIOD = 160;
const AUTO_REFRESH = process.env.COMIX_RELAY_AUTO_REFRESH !== "0";

let analysisPromise = null;
let analysisRunId = 0;
let queuedAnalysisWaiters = 0;

function log(message, data) {
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

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

function runRefreshScript(force) {
  return new Promise((resolve, reject) => {
    const args = [REFRESH_SCRIPT];
    if (force) args.push("--force");

    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    child.stdout.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) log("analysis stdout", { line });
      }
    });
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) log("analysis stderr", { line });
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`refresh-constants.js exited with ${code}`));
    });
  });
}

async function ensureFreshConstants(force = false) {
  if (analysisPromise) {
    queuedAnalysisWaiters += 1;
    log("bundle analysis already running; request queued", { waiters: queuedAnalysisWaiters });
    try {
      await analysisPromise;
    } finally {
      queuedAnalysisWaiters -= 1;
    }
    return;
  }

  const runId = ++analysisRunId;
  analysisPromise = (async () => {
    const before = fs.existsSync(CONSTANTS_FILE) ? fs.statSync(CONSTANTS_FILE).mtimeMs : 0;
    log("bundle analysis started", { runId, force });
    await runRefreshScript(force);
    const afterPayload = buildPayload();
    const after = fs.existsSync(CONSTANTS_FILE) ? fs.statSync(CONSTANTS_FILE).mtimeMs : 0;
    log("bundle analysis finished", {
      runId,
      bundleId: afterPayload.bundleId,
      changed: after !== before,
      queuedWaiters: queuedAnalysisWaiters
    });
  })();

  try {
    await analysisPromise;
  } finally {
    analysisPromise = null;
  }
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

async function constantsResponse(res, options = {}) {
  if (AUTO_REFRESH || options.force) {
    await ensureFreshConstants(!!options.force);
  }

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

async function requestHandler(req, res) {
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
        autoRefresh: AUTO_REFRESH,
        analyzing: !!analysisPromise,
        queuedAnalysisWaiters,
        endpoints: ["/comix-fast-constants.json", "/api/comix-fast-constants"]
      });
      return;
    }

    if (url.pathname === "/comix-fast-constants.json" || url.pathname === "/api/comix-fast-constants") {
      await constantsResponse(res, { force: url.searchParams.get("force") === "1" });
      return;
    }

    if (url.pathname === "/api/refresh" || url.pathname === "/refresh") {
      await ensureFreshConstants(url.searchParams.get("force") === "1");
      const payload = buildPayload();
      jsonResponse(res, 200, {
        ok: true,
        bundleId: payload.bundleId,
        schemaVersion: payload.schemaVersion,
        encoding: payload.encoding
      });
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
    log("comix fast constants relay listening", { port: PORT, autoRefresh: AUTO_REFRESH });
  });
}
