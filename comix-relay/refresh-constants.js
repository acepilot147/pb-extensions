"use strict";

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RELAY_ROOT = __dirname;
const REPO_ROOT = path.resolve(__dirname, "..");
const CONSTANTS_FILE = path.join(RELAY_ROOT, "comix-fast-constants.json");
const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_CLI = process.env.npm_execpath;
const HOMEPAGE = process.env.RELAY_PROBE_URL || "https://comix.to/title/xlyyj-eleceed";
const UA = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function run(label, command, args, cwd) {
  console.log("");
  console.log(`==> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function cookieHeader() {
  return [
    process.env.SESSION ? `session=${process.env.SESSION}` : "",
    process.env.CF_CLEARANCE ? `cf_clearance=${process.env.CF_CLEARANCE}` : ""
  ].filter(Boolean).join("; ");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": url.endsWith(".js") ? "application/javascript,*/*;q=0.9" : "text/html,*/*;q=0.9",
      "Cookie": cookieHeader(),
      "Referer": "https://comix.to/"
    }
  });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return await res.text();
}

function readCachedBundleId() {
  try {
    const cached = JSON.parse(fs.readFileSync(CONSTANTS_FILE, "utf8"));
    return typeof cached.bundleId === "string" ? cached.bundleId : "";
  } catch {
    return "";
  }
}

async function resolveLiveBundleId() {
  console.log("");
  console.log("==> check live Comix bundle cache");
  console.log(`[cache] fetching homepage ${HOMEPAGE}`);
  const html = await fetchText(HOMEPAGE);
  const mainM = html.match(/src="([^"]*main-[a-zA-Z0-9_-]+\.js)"/);
  if (!mainM) throw new Error("could not parse main bundle URL");

  const mainUrl = new URL(mainM[1], HOMEPAGE).href;
  console.log(`[cache] main ${mainUrl}`);
  const mainText = await fetchText(mainUrl);
  const secureM = mainText.match(/from\s*["']([^"']*secure-[a-zA-Z0-9_-]+\.js)["']/);
  if (!secureM) throw new Error("could not find secure bundle import");

  const secureUrl = new URL(secureM[1], mainUrl).href;
  console.log(`[cache] secure ${secureUrl}`);
  const secureText = await fetchText(secureUrl);
  return createHash("sha256").update(secureText).digest("hex").slice(0, 12);
}

async function main() {
  const force = process.argv.includes("--force") || process.env.COMIX_RELAY_FORCE_REFRESH === "1";
  if (!force) {
    const cachedBundleId = readCachedBundleId();
    const liveBundleId = await resolveLiveBundleId();
    console.log(`[cache] cached bundle ${cachedBundleId || "(none)"}`);
    console.log(`[cache] live bundle   ${liveBundleId}`);
    if (cachedBundleId && cachedBundleId === liveBundleId) {
      console.log("[cache] unchanged; skipping extraction/build");
      run("validate standalone relay JSON", NODE, ["server.js", "--check"], RELAY_ROOT);
      return;
    }
    console.log("[cache] changed or missing; refreshing constants");
  } else {
    console.log("[cache] force refresh requested");
  }

  if (NPM_CLI) {
    run("refresh Comix runtime from live site", NODE, [NPM_CLI, "run", "refresh:comix"], REPO_ROOT);
  } else {
    run("refresh Comix runtime from live site", NPM, ["run", "refresh:comix"], REPO_ROOT);
  }
  run("write relay constants JSON", NODE, ["update-constants.js"], RELAY_ROOT);
  run("validate standalone relay JSON", NODE, ["server.js", "--check"], RELAY_ROOT);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
