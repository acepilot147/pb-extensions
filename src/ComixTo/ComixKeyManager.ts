import { extractApicoreKeys, apicoreImport, ApicoreKeys } from "./ComixApicore";

export const COMIX_KEYS_CACHE = "comix_live_keys_v1";
const ORIGIN = "https://comix.to";

interface State {
    retrieve(key: string): Promise<unknown>;
    store(key: string, value: any): Promise<unknown>;
}
export interface KeyRecord {
    schema: 1;
    assetUrl: string;
    fetchedAt: number;
    keys: ApicoreKeys;
}

// Resolve only site-owned static JS; never fetch credentials, protocol-relative
// hosts, data URLs, or paths outside /assets/. No native URL API in Paperback.
function assetUrl(ref: string, base: string): string {
    if (/[\\\s?#%]/.test(ref) || ref.startsWith("//")) throw new Error("Comix key asset URL is not allowed");
    let path: string;
    if (/^https?:/i.test(ref)) {
        if (!ref.startsWith(ORIGIN + "/")) {
            const host = /^https?:\/\/(?:[^/]*@)?([^/]+)/i.exec(ref)?.[1] ?? "unknown";
            throw new Error(`Comix key asset origin is not allowed: ${host.slice(0, 128)}`);
        }
        path = ref.slice(ORIGIN.length);
    } else if (ref.startsWith("/")) path = ref;
    else path = base.slice(ORIGIN.length).replace(/[^/]*$/, "") + ref;
    const parts: string[] = [];
    for (const p of path.split("/")) {
        if (!p || p === ".") continue;
        if (p === "..") parts.pop();
        else parts.push(p);
    }
    path = "/" + parts.join("/");
    if (!/^\/assets\/[A-Za-z0-9_./-]+\.js$/.test(path)) throw new Error("Comix key asset path is not allowed");
    return ORIGIN + path;
}

export function validApicoreKeys(k: any): k is ApicoreKeys {
    const dense = (v: any, length: number, max: number) => {
        if (!Array.isArray(v) || v.length !== length) return false;
        for (let i = 0; i < length; i++) {
            if (!Object.prototype.hasOwnProperty.call(v, i) || !Number.isInteger(v[i]) || v[i] < 0 || v[i] > max) return false;
        }
        return true;
    };
    return !!k && typeof k.prefix === "string" && /^[A-Za-z0-9_-]{1,32}\.$/.test(k.prefix)
        && Number.isInteger(k.macBytes) && k.macBytes >= 1 && k.macBytes <= 32
        && dense(k.istate, 8, 0xffffffff) && dense(k.ostate, 8, 0xffffffff)
        && dense(k.table, 1024, 255);
}

function validRecord(r: any): r is KeyRecord {
    if (!r || r.schema !== 1 || !Number.isFinite(r.fetchedAt) || r.fetchedAt < 0 || !validApicoreKeys(r.keys) || typeof r.assetUrl !== "string") return false;
    try { return assetUrl(r.assetUrl, ORIGIN + "/") === r.assetUrl; } catch { return false; }
}

/** Numeric keys only are persisted. Downloaded JavaScript is never cached. */
export class ComixKeyManager {
    private active: KeyRecord | undefined;
    private loaded: Promise<void> | undefined;
    constructor(private state: State, private now: () => number = () => Date.now()) {}

    async current(): Promise<KeyRecord | undefined> {
        if (!this.loaded) this.loaded = (async () => {
            try {
                const raw = await this.state.retrieve(COMIX_KEYS_CACHE);
                const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                if (validRecord(parsed)) this.active = parsed;
            } catch { /* A broken/unavailable cache falls back to the baked keys. */ }
        })();
        await this.loaded;
        return this.active;
    }

    private flight: Promise<KeyRecord> | undefined;

    async discover(fetchText: (url: string) => Promise<string>): Promise<KeyRecord> {
        if (this.flight) return this.flight;
        this.flight = this.discoverOnce(async (url) => {
            const text = await fetchText(url);
            if (typeof text !== "string" || text.length > 3 * 1024 * 1024) throw new Error("Comix key asset is too large");
            return text;
        });
        try { return await this.flight; } finally { this.flight = undefined; }
    }

    private async discoverOnce(fetchText: (url: string) => Promise<string>): Promise<KeyRecord> {
        const html = await fetchText(ORIGIN + "/");
        const scripts = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
        let match: RegExpExecArray | null;
        const mains: string[] = [];
        let rejectedScript: unknown;
        while ((match = scripts.exec(html))) {
            if (!(/\btype\s*=\s*["']module["']/i.test(match[0]) || /(?:main|index)[.-]/.test(match[1]!))) continue;
            try {
                const url = assetUrl(match[1]!, ORIGIN + "/");
                if (!mains.includes(url)) mains.push(url);
            } catch (error) {
                // Ads/analytics may also be modules or named main.js. Ignore
                // their tags, never fetch/evaluate them or weaken asset checks.
                rejectedScript = error;
            }
        }
        if (!mains.length && rejectedScript) throw rejectedScript;
        if (!mains.length || mains.length > 4) throw new Error("Comix key discovery: expected a site module script");
        let apicore: string | undefined;
        for (const main of mains) {
            const text = await fetchText(main);
            const ref = /["']([^"'\s]*apicore-[A-Za-z0-9_-]+\.js)["']/.exec(text)?.[1];
            if (ref) { apicore = assetUrl(ref, main); break; }
        }
        if (!apicore) throw new Error("Comix key discovery: apicore module not found; update the extension");
        const source = await fetchText(apicore);
        const helper = apicoreImport(source);
        if (!helper) throw new Error("Comix key discovery: apicore helper import not found");
        const chunk = await fetchText(assetUrl(helper, apicore));
        const keys = await extractApicoreKeys(source, chunk);
        if (!validApicoreKeys(keys)) throw new Error("Comix key extraction returned invalid key material");
        return { schema: 1, assetUrl: apicore, fetchedAt: this.now(), keys };
    }

    // The caller must first obtain and decode a successful API response using
    // this candidate. A retired/invalid key must never replace the last good one.
    async activate(record: KeyRecord): Promise<void> {
        if (!validRecord(record)) throw new Error("Invalid Comix key cache record");
        await this.current();
        this.active = record;
        try { await this.state.store(COMIX_KEYS_CACHE, JSON.stringify(record)); }
        catch { /* Keep working in memory if the device's persistent store fails. */ }
    }
}
