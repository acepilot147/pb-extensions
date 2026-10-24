// Download one or more comix.to assets through a real Chrome into experiment/live/assets/.
//   node experiment/live/fetch-asset.mjs <url>...
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";
const dir = join(dirname(fileURLToPath(import.meta.url)), "assets");
mkdirSync(dir, { recursive: true });
const b = await launch();
try {
  await b.goto("https://comix.to/", 1500);
  for (const u of process.argv.slice(2)) {
    const r = await b.fetchText(u);
    const f = join(dir, u.split("/").pop().split("?")[0]);
    writeFileSync(f, r.text);
    console.log(r.status, r.text.length, f);
  }
} finally { b.close(); }
