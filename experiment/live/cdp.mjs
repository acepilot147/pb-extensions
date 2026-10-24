// Minimal Chrome DevTools Protocol driver for talking to comix.to from a real
// browser. comix.to serves Cloudflare challenges to Node fetch / curl / headless
// Chrome, but a *headed* Chrome passes in ~1 s, so everything live goes through it.
//
//   const b = await launch();          // opens a visible Chrome window
//   await b.goto("https://comix.to/");
//   const text = await b.fetchText(url); // fetch() inside the page (carries its cookies)
//   b.close();

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, profileDir = join(tmpdir(), "comix-live-chrome") } = {}) {
  mkdirSync(profileDir, { recursive: true });
  const { existsSync } = await import("node:fs");
  const chrome = CHROME_PATHS.find((p) => existsSync(p));
  if (!chrome) throw new Error("Chrome not found — set CHROME_PATH");
  const proc = spawn(chrome, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1100,900", "about:blank",
  ], { stdio: "ignore" });

  let page;
  for (let i = 0; i < 75 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch { /* starting */ }
    if (!page) await sleep(200);
  }
  if (!page) { proc.kill(); throw new Error("Chrome DevTools endpoint did not come up"); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map(), handlers = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else handlers.forEach((h) => h(m));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result?.result?.value;
  };
  await send("Page.enable");

  // Navigate and wait until the Cloudflare interstitial ("Just a moment…") is gone.
  const goto = async (url, settleMs = 3000) => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const title = await evaluate("document.title").catch(() => "");
      if (title && !/just a moment/i.test(title)) break;
    }
    await sleep(settleMs);
  };

  // fetch() from inside the page; returns { status, headers, text }.
  const fetchText = async (url, headers = {}) => JSON.parse(await evaluate(
    `fetch(${JSON.stringify(url)}, { headers: ${JSON.stringify(headers)} })
       .then(async r => JSON.stringify({ status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() }))`,
  ));

  return {
    send, evaluate, goto, fetchText,
    on: (h) => handlers.push(h),
    close: () => { try { ws.close(); } catch { /* closed */ } proc.kill(); },
  };
}
