export {};

/**
 * One-command Comix runtime refresh.
 *
 * Run:
 *   node -r ts-node/register/transpile-only experiment/RefreshComixRuntime.ts
 */

import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const NODE = process.execPath;
const NPM_CLI = process.env.npm_execpath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const SAFE_DIR = "E:/GitHub/acepilot147-comix/pb-extensions";

function run(label: string, command: string, args: string[]): void {
    console.log("");
    console.log(`==> ${label}`);
    const result = spawnSync(command, args, {
        cwd: ROOT,
        stdio: "inherit",
        shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
    }
}

function runTs(label: string, script: string): void {
    run(label, NODE, ["-r", "ts-node/register/transpile-only", script]);
}

function runNpm(label: string, args: string[]): void {
    if (NPM_CLI) {
        run(label, NODE, [NPM_CLI, ...args]);
        return;
    }
    run(label, NPM, args);
}

function main(): void {
    runTs("extract live runtime and fixtures", "experiment/ExtractComixRuntime.ts");
    runTs("build and self-validate fast signer", "experiment/BuildComixFastSigner.ts");
    runTs("build and self-validate fast decrypt", "experiment/BuildComixFastDecrypt.ts");
    runTs("validate local Comix runtime", "experiment/ValidateLocalComixRuntime.ts");
}

main();
