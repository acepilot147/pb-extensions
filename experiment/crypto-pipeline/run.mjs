// Orchestrator — extract → generate → validate, in one shot.
//
//   node experiment/crypto-pipeline/run.mjs            # use the embedded bundle
//   node experiment/crypto-pipeline/run.mjs --refresh  # refresh secure.js first
//
// --refresh fetches the live comix.to secure-*.js and regenerates
// experiment/ComixBundle.ts before extracting (needs CF_CLEARANCE / SESSION /
// USER_AGENT env, same as npm run refresh:comix).

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT } from "./lib.mjs";
import { extract } from "./extract.mjs";
import { generate } from "./generate.mjs";
import { validate } from "./validate.mjs";

async function run({ refresh }) {
  if (refresh) {
    console.log("== refresh secure.js ==");
    const r = spawnSync("node", ["-r", "ts-node/register/transpile-only", resolve(ROOT, "experiment/RefreshComixBundle.ts")], { stdio: "inherit", cwd: ROOT });
    if (r.status !== 0) throw new Error("refresh failed — check CF_CLEARANCE / SESSION / USER_AGENT");
  }

  console.log("== extract ==");
  const c = extract();
  console.log(`   bundle ${c.bundleId} — ${c.algorithm}, ${c.rounds} rounds; signer=${c.verified.signer} decrypt=${c.verified.decrypt}`);

  console.log("== generate ==");
  const g = generate();
  console.log(`   wrote ${g.decryptPath}`);
  console.log(`   wrote ${g.signerPath}`);

  console.log("== validate ==");
  const v = await validate();
  if (!v.ok) throw new Error(`validation failed (signer ${v.signFail} fail, decrypt ${v.decFail} fail)`);
  console.log(`\nDONE — signer ${v.signPass} pass, decrypt ${v.decPass} pass. Native files match the live bundle.`);
  return v;
}

run({ refresh: process.argv.includes("--refresh") })
  .then((v) => process.exit(v.ok ? 0 : 1))
  .catch((e) => { console.error(`\nFAILED: ${e?.message ?? e}`); process.exit(1); });
