/**
 * Comix API signing and encrypted-response decoding — the central interface for
 * ComixTo. Signing and decryption are delegated to the native, generated modules
 * (ComixFastSigner / ComixFastDecrypt); the live-VM bundle is no longer used.
 *
 * Regenerate those modules when comix.to rotates secure-*.js:
 *   npm run crypto:pipeline        (offline, from the embedded bundle)
 *   npm run crypto:pipeline -- --refresh   (fetch live secure.js first;
 *     requires CF_CLEARANCE / SESSION / USER_AGENT — see
 *     experiment/crypto-pipeline/README.md)
 */

import { Cookie, Request, RequestManager, Response } from "@paperback/types";
import { fastGenerateHash } from "./ComixFastSigner";
import { fastDecryptComixPayload } from "./ComixFastDecrypt";
import { emit } from "./Telemetry";
import { solveWafCaptcha } from "./WafSolver";

// Paths the live bundle's request interceptor signs — verified by probing the
// booted bundle (experiment/crypto-pipeline). As of bundle 6ffb/625d… (2026-06)
// comix widened token enforcement to EVERY /manga endpoint (details, browse
// lists, /top, /{slug}/chapters, /{slug}/chapter-indexes) plus individual
// /chapters/{id}. Unsigned /manga* now returns 403 "Missing token.". Only
// /tags/search (and non-/manga, non-/chapters paths) stay unsigned — the bundle
// does not sign those. Patterns are segment-exact (so /mangas is NOT matched),
// and tokens are pathname-only (the query string is not part of the signature).
const SIGNED_PATTERNS: RegExp[] = [
    /^\/manga(?:\/|$)/,
    /^\/chapters\/[^/]+/,
];

function isSignedPath(path: string): boolean {
    return SIGNED_PATTERNS.some(re => re.test(path));
}

/**
 * Generate the comix.to /api/v1 `_=` token for a request. Since bundle 625d…
 * the signature covers the path AND its query params; `fastGenerateHash`
 * canonicalizes the query internally, so pass the full URL (or path+query).
 */
export function generateHash(rawPath: string): string {
    return fastGenerateHash(rawPath);
}

/**
 * Append `_=<token>` to a comix.to /api/v1 URL when the path is on the
 * signed list. Pass-through for everything else. The token signs the path +
 * canonicalized query (handled in fastGenerateHash); the wire URL is unchanged
 * because the server re-canonicalizes whatever we send.
 */
export function signUrl(url: string): string {
    const path = url.replace("https://comix.to/api/v1", "").split("?")[0]!;
    if (!isSignedPath(path)) return url;
    const token = generateHash(url);
    if (!token) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_=${token}`;
}

// comix blocks clients that hit its API too hard: since 2026-10 its own WAF
// answers every request with 403 {"error":"captcha_required"} and redirects the
// site to a "Verify you're human" check at /@waf/challenge (Mihon throttles to
// 2 req/s for the same reason). Paperback 0.8 has no timers, so requests can't
// be spaced in time; instead every comix.to API call goes through this
// single-flight queue — one request in flight at a time, which at typical
// latency (~250–400 ms) keeps it around 2–4 req/s instead of bursts of 10–20.
// Images are on other hosts and don't go through here.
let comixQueue: Promise<unknown> = Promise.resolve();

function enqueueComix<T>(task: () => Promise<T>): Promise<T> {
    const run = comixQueue.then(task);
    comixQueue = run.catch(() => undefined);
    return run;
}

// Settings > Network > "Auto-solve security check". ComixTo registers the getter
// so this module needn't import Settings (which imports this one).
let wafAutoSolveEnabled: () => Promise<boolean> = async () => false;
export function setWafAutoSolve(isEnabled: () => Promise<boolean>): void {
    wafAutoSolveEnabled = isEnabled;
}

// Last solver outcome, for error messages and the settings status row. After a
// failure (e.g. comix is showing Turnstile, which only the web view can pass)
// auto-solve stands down for a minute instead of re-trying on every request.
const SOLVE_RETRY_MS = 60 * 1000;
let lastWafSolve: { at: number; ok: boolean; message: string } | null = null;

export function wafSolveStatus(): string {
    if (!lastWafSolve) return "Not needed yet";
    const mins = Math.round((Date.now() - lastWafSolve.at) / 60000);
    const when = mins < 1 ? "just now" : `${mins} min ago`;
    return lastWafSolve.ok ? `Solved ${when}` : `Failed ${when}: ${lastWafSolve.message}`;
}

function isSecurityCheck(response: Response): boolean {
    const data = response.data ?? "";
    return response.status === 403 && (data.includes("captcha_required") || data.includes("/@waf/challenge"));
}

function challengePathOf(response: Response): string | undefined {
    try {
        const path = JSON.parse(response.data ?? "{}")?.challenge;
        return typeof path === "string" ? path : undefined;
    } catch {
        return undefined;
    }
}

async function solveWaf(requestManager: RequestManager, challengePath?: string): Promise<void> {
    try {
        await solveWafCaptcha(requestManager, challengePath);
        lastWafSolve = { at: Date.now(), ok: true, message: "" };
    } catch (error: any) {
        lastWafSolve = { at: Date.now(), ok: false, message: error?.message ?? String(error) };
        throw error;
    }
}

export function scheduleComix(requestManager: RequestManager, request: Request): Promise<Response> {
    return enqueueComix(async () => {
        const response = await requestManager.schedule(request, 1);
        if (!isSecurityCheck(response) || !(await wafAutoSolveEnabled())) return response;
        if (lastWafSolve && !lastWafSolve.ok && Date.now() - lastWafSolve.at < SOLVE_RETRY_MS) return response;
        try {
            await solveWaf(requestManager, challengePathOf(response));
        } catch {
            return response; // throwIfSecurityCheck reports why
        }
        return requestManager.schedule(request, 1);
    });
}

/** Settings button: solve the security check now, queued behind any in-flight comix call. */
export function solveSecurityCheckNow(requestManager: RequestManager): Promise<void> {
    return enqueueComix(() => solveWaf(requestManager));
}

// Passing the check (POST /@waf/verify) sets an HttpOnly `waf_pass` cookie that
// clears the wall for ~5 minutes, and only for the User-Agent it was issued to.
// Its value starts with its own unix expiry ("1791779685.<sig>").
function wafPassExpiry(cookie: Cookie): number | null {
    const fromValue = /^(\d{10})\./.exec(cookie.value);
    if (fromValue) return Number(fromValue[1]) * 1000;
    const expires = cookie.expires ? new Date(cookie.expires).getTime() : NaN;
    return isNaN(expires) ? null : expires;
}

// Turn the WAF's captcha wall into an actionable error instead of a bare 403,
// saying what state the user's waf_pass is in (from Paperback's cookie store).
export function throwIfSecurityCheck(response: Response, requestManager?: RequestManager): void {
    if (!isSecurityCheck(response)) return;

    const solve ="tap the cloud / globe button and complete the \"Verify you're human\" check it opens (or open any title in the web view), then retry";
    let detail: string;
    let cookies: Cookie[] | null = null;
    try { cookies = requestManager?.cookieStore?.getAllCookies() ?? null; } catch { cookies = null; }
    const pass = cookies?.find((c) => c.name === "waf_pass" && c.domain.replace(/^\./, "").endsWith("comix.to"));
    if (!cookies) {
        detail = `Please ${solve} within 5 minutes.`;
    } else if (!pass) {
        detail = `No security pass (waf_pass) found. Please ${solve}. If you just did, Paperback may not be sharing the web view's cookies with this source.`;
    } else {
        const expiry = wafPassExpiry(pass);
        const now = Date.now();
        if (expiry !== null && expiry <= now) {
            const mins = Math.max(1, Math.round((now - expiry) / 60000));
            detail = `Your security pass expired ${mins} min ago (passes last about 5 minutes). Please ${solve}.`;
        } else {
            const left = expiry !== null ? ` (valid ~${Math.max(0, Math.round((expiry - now) / 1000))}s more)` : "";
            detail = `A security pass was found${left} but comix rejected it. Passes only work with the User-Agent they were issued to: if you changed Settings > Custom User-Agent after passing the check, or the web view uses a different User-Agent, ${solve}.`;
        }
    }
    const autoSolve = lastWafSolve && !lastWafSolve.ok && Date.now() - lastWafSolve.at < SOLVE_RETRY_MS
        ? ` Auto-solve failed: ${lastWafSolve.message}.`
        : "";
    const ua = (response as any).request?.headers?.["User-Agent"] as string | undefined;
    throw new Error(`Comix security check required: comix.to is asking to verify you're human.${autoSolve} ${detail}${ua ? ` [UA: ${ua}]` : ""}`);
}

async function requestSignedUrl(requestManager: RequestManager, url: string): Promise<Response> {
    return scheduleComix(requestManager, App.createRequest({
        url,
        method: "GET",
        headers: {
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://comix.to/",
        },
    }));
}

function checkSignedResponseError(response: Response, requestManager: RequestManager): void {
    throwIfSecurityCheck(response, requestManager);
    const data = response.data ?? "";
    const preview = data.substring(0, 200).replace(/\s+/g, " ");
    const headers = response.headers ?? {};
    const ct = (headers["Content-Type"] ?? headers["content-type"] ?? "?") as string;
    const cfRay = (headers["Cf-Ray"] ?? headers["cf-ray"] ?? "?") as string;
    const reqUrl = (response as any).request?.url ?? "?";
    const ctx = `status=${response.status} ct=${ct} cf-ray=${cfRay} url=${reqUrl} preview="${preview}"`;

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: Unexpected response from server [${ctx}]`);
    }
    if (data.trimStart().startsWith("<")) {
        throw new Error(`Cloudflare challenge page returned [${ctx}]`);
    }
}

/**
 * Decode a comix /api/v1 response body into its `result`.
 *
 * comix enables `x-enc` encryption per-endpoint rather than site-wide, so an
 * endpoint that returns plaintext `{status,result}` today can start returning
 * `{e}` at any time (as /manga/{slug} did in 2026-08 — it surfaced as
 * "API undefined: no message" because `{e}` has no `status`). Every endpoint
 * therefore goes through here, which handles both shapes.
 *
 * `timing`, if supplied, receives the parse/decrypt split for telemetry.
 */
export function decodeComixResponse<T>(
    apiPath: string,
    response: Response,
    timing?: { parseMs: number; decryptMs: number },
): T {
    const parseStart = Date.now();
    const json = JSON.parse(response.data ?? "{}");
    if (timing) timing.parseMs = Date.now() - parseStart;

    if (json && typeof json === "object" && "e" in json) {
        const decryptStart = Date.now();
        const decrypted = fastDecryptComixPayload(apiPath, json, response.headers ?? {}) as any;
        if (timing) timing.decryptMs = Date.now() - decryptStart;
        // The interceptor unwraps `{ status: "ok", result: ... }` for us and
        // returns `result` directly; some payloads may not be wrapped.
        return (decrypted && typeof decrypted === "object" && "result" in decrypted && decrypted.status === "ok"
            ? decrypted.result
            : decrypted) as T;
    }

    if (json.status !== "ok") {
        throw new Error(`Comix API ${json.status}: ${json.message ?? "no message"}`);
    }
    return json.result as T;
}

export async function fetchSigned<T>(
    requestManager: RequestManager,
    fullUrl: string,
): Promise<T> {
    const totalStart = Date.now();

    const apiPath = fullUrl.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "");
    const telPath = apiPath.split("?")[0]!;
    const label = /^\/manga\/[^/]+\/chapters/.test(telPath) ? "chapters"
        : /^\/chapters\//.test(telPath) ? "chapter_images"
        : "signed_fetch";

    const signStart = Date.now();
    const signedUrl = signUrl(fullUrl);
    const signMs = Date.now() - signStart;

    const fetchStart = Date.now();
    const response = await requestSignedUrl(requestManager, signedUrl);
    const fetchMs = Date.now() - fetchStart;
    const status = response.status;
    const bytes = (response.data ?? "").length;

    try {
        checkSignedResponseError(response, requestManager);
    } catch (err) {
        emit({ label, path: telPath, status, bytes, signMs, fetchMs, parseMs: 0, decryptMs: 0, totalMs: Date.now() - totalStart });
        throw err;
    }

    const timing = { parseMs: 0, decryptMs: 0 };
    const result = decodeComixResponse<T>(apiPath, response, timing);
    emit({ label, path: telPath, status, bytes, signMs, fetchMs, parseMs: timing.parseMs, decryptMs: timing.decryptMs, totalMs: Date.now() - totalStart });
    return result;
}
