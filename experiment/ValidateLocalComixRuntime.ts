export {};

/**
 * Validate the local Paperback-safe Comix runtime against extractor fixtures.
 *
 * Expected local export after porting:
 *
 *   export function decryptComixPayload(path: string, payload: any, headers?: Record<string, string>): any
 *
 * Run:
 *   npx tsx experiment/ValidateLocalComixRuntime.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ComixHash from "../src/ComixTo/ComixHash";

interface RuntimeJson {
    staticSignerOk?: boolean;
    signChecks?: Array<{
        path: string;
        signPath: string;
        staticMatchesLive: boolean;
        staticToken: string;
        liveToken: string;
    }>;
}

interface Fixture {
    path: string;
    headers?: Record<string, string>;
    encryptedPayload: any;
    decrypted: any;
    decryptError?: string;
}

const RUNTIME_PATH = resolve(process.cwd(), "experiment", "extracted", "comix-runtime-latest", "runtime.json");
const FIXTURES_PATH = resolve(process.cwd(), "experiment", "extracted", "comix-runtime-latest", "fixtures.json");

function stable(value: any): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function preview(value: any, max = 800): string {
    const text = JSON.stringify(value, null, 2);
    return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function loadJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

function findDecryptExport(): ((path: string, payload: any, headers?: Record<string, string>) => any) | null {
    const mod = ComixHash as any;
    const candidates = [
        "decryptComixPayload",
        "decryptPayload",
        "decryptApiPayload",
        "decryptComixResponse",
        "localDecryptComixPayload",
    ];
    for (const name of candidates) {
        if (typeof mod[name] === "function") {
            return (path: string, payload: any, headers?: Record<string, string>) => {
                const fn = mod[name];
                return fn(path, payload, headers);
            };
        }
    }
    return null;
}

function validateSigner(runtime: RuntimeJson): { pass: number; fail: number } {
    let pass = 0;
    let fail = 0;
    console.log("signer:");
    for (const check of runtime.signChecks ?? []) {
        const got = ComixHash.generateHash(check.signPath);
        const ok = got === check.liveToken;
        console.log(`  ${ok ? "PASS" : "FAIL"} ${check.signPath}`);
        if (!ok) {
            console.log(`    expected live: ${check.liveToken}`);
            console.log(`    got local    : ${got}`);
        }
        ok ? pass++ : fail++;
    }
    return { pass, fail };
}

async function validateDecrypt(fixtures: Fixture[], decrypt: (path: string, payload: any, headers?: Record<string, string>) => any): Promise<{ pass: number; fail: number }> {
    let pass = 0;
    let fail = 0;
    console.log("\ndecrypt:");
    for (const fixture of fixtures) {
        let got: any;
        try {
            got = await decrypt(fixture.path, fixture.encryptedPayload, fixture.headers ?? {});
        } catch (e: any) {
            console.log(`  FAIL ${fixture.path}`);
            console.log(`    threw: ${e?.message ?? String(e)}`);
            fail++;
            continue;
        }

        const ok = stable(got) === stable(fixture.decrypted);
        console.log(`  ${ok ? "PASS" : "FAIL"} ${fixture.path}`);
        if (!ok) {
            console.log("    expected:");
            console.log(preview(fixture.decrypted));
            console.log("    got:");
            console.log(preview(got));
        }
        ok ? pass++ : fail++;
    }
    return { pass, fail };
}

async function main(): Promise<void> {
    const runtime = loadJson<RuntimeJson>(RUNTIME_PATH);
    const fixtures = loadJson<Fixture[]>(FIXTURES_PATH);

    const sign = validateSigner(runtime);
    const decryptExport = findDecryptExport();
    if (!decryptExport) {
        console.log("");
        console.log("decrypt: SKIP");
        console.log("  Missing local decrypt export. Add this to src/ComixTo/ComixHash.ts or re-export it from there:");
        console.log("  export function decryptComixPayload(path: string, payload: any, headers?: Record<string, string>): any");
        console.log("");
        console.log(`summary: signer ${sign.pass} pass / ${sign.fail} fail, decrypt skipped`);
        process.exit(sign.fail === 0 ? 2 : 1);
    }

    const dec = await validateDecrypt(fixtures, decryptExport);
    console.log("");
    console.log(`summary: signer ${sign.pass} pass / ${sign.fail} fail, decrypt ${dec.pass} pass / ${dec.fail} fail`);
    process.exit(sign.fail === 0 && dec.fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
