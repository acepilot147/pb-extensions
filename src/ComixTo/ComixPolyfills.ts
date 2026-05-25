/**
 * Polyfills for browser/JS built-ins that Paperback's JavaScriptCore
 * environment does not expose. The Comix bundle aliases these and falls
 * over with "undefined is not a constructor" if they aren't present.
 *
 * Verified missing in Paperback (via ComixProbe):
 *   TextEncoder, TextDecoder, atob, btoa, Blob, URL, URLSearchParams,
 *   fetch, Headers, setTimeout family, queueMicrotask, document, window,
 *   navigator, location, localStorage, crypto, DOMException,
 *   AbortController.
 *
 * Only the ones the bundle actually constructs or calls during signing /
 * decryption are implemented for real; the others get permissive stubs so
 * the bundle's anti-tamper / refresh code paths don't crash.
 */

/** Minimal UTF-8 TextEncoder. */
export class TextEncoderShim {
    get encoding(): string { return "utf-8"; }

    encode(input?: string): Uint8Array {
        const str = input == null ? "" : String(input);
        // Allocate worst-case (4 bytes/char) then trim.
        const out = new Uint8Array(str.length * 4);
        let pos = 0;
        for (let i = 0; i < str.length; i++) {
            let cp = str.charCodeAt(i);
            if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
                const low = str.charCodeAt(i + 1);
                if (low >= 0xdc00 && low <= 0xdfff) {
                    cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                    i++;
                }
            }
            if (cp < 0x80) {
                out[pos++] = cp;
            } else if (cp < 0x800) {
                out[pos++] = 0xc0 | (cp >> 6);
                out[pos++] = 0x80 | (cp & 0x3f);
            } else if (cp < 0x10000) {
                out[pos++] = 0xe0 | (cp >> 12);
                out[pos++] = 0x80 | ((cp >> 6) & 0x3f);
                out[pos++] = 0x80 | (cp & 0x3f);
            } else {
                out[pos++] = 0xf0 | (cp >> 18);
                out[pos++] = 0x80 | ((cp >> 12) & 0x3f);
                out[pos++] = 0x80 | ((cp >> 6) & 0x3f);
                out[pos++] = 0x80 | (cp & 0x3f);
            }
        }
        return out.slice(0, pos);
    }

    encodeInto(input: string, dest: Uint8Array): { read: number; written: number } {
        const enc = this.encode(input);
        const written = Math.min(enc.length, dest.length);
        for (let i = 0; i < written; i++) dest[i] = enc[i]!;
        return { read: input.length, written };
    }
}

/** Minimal UTF-8 TextDecoder. Only handles utf-8; throws on stream:true. */
export class TextDecoderShim {
    encoding: string;
    fatal: boolean;
    ignoreBOM: boolean;

    constructor(encoding: string = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
        const enc = (encoding || "utf-8").toLowerCase();
        if (enc !== "utf-8" && enc !== "utf8" && enc !== "unicode-1-1-utf-8") {
            // The bundle only ever asks for utf-8; surface anything else loudly.
            throw new RangeError(`TextDecoderShim: only utf-8 is supported (got ${encoding})`);
        }
        this.encoding = "utf-8";
        this.fatal = !!options.fatal;
        this.ignoreBOM = !!options.ignoreBOM;
    }

    decode(input?: ArrayBuffer | ArrayBufferView | null): string {
        if (input == null) return "";
        let bytes: Uint8Array;
        if (input instanceof Uint8Array) bytes = input;
        else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
        else if ((input as any).buffer instanceof ArrayBuffer) {
            const view = input as ArrayBufferView;
            bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        } else {
            bytes = new Uint8Array(input as any);
        }
        let i = 0;
        if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
            i = 3;
        }
        let out = "";
        while (i < bytes.length) {
            const b0 = bytes[i++]!;
            if (b0 < 0x80) {
                out += String.fromCharCode(b0);
            } else if (b0 < 0xc0) {
                if (this.fatal) throw new TypeError("invalid utf-8 continuation byte");
                out += "�";
            } else if (b0 < 0xe0) {
                const b1 = bytes[i++] ?? 0;
                out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
            } else if (b0 < 0xf0) {
                const b1 = bytes[i++] ?? 0;
                const b2 = bytes[i++] ?? 0;
                out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
            } else {
                const b1 = bytes[i++] ?? 0;
                const b2 = bytes[i++] ?? 0;
                const b3 = bytes[i++] ?? 0;
                let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
                cp -= 0x10000;
                out += String.fromCharCode(0xd800 + (cp >> 10));
                out += String.fromCharCode(0xdc00 + (cp & 0x3ff));
            }
        }
        return out;
    }
}

/** Inert Blob stub — enough for `new Blob([...])` and `.size`/`.type`. */
export class BlobShim {
    size: number;
    type: string;
    private _parts: any[];

    constructor(parts: any[] = [], options: { type?: string } = {}) {
        this._parts = parts;
        this.type = options.type ?? "";
        let total = 0;
        for (const p of parts) {
            if (typeof p === "string") total += p.length;
            else if (p && typeof p.byteLength === "number") total += p.byteLength;
            else if (p && typeof p.size === "number") total += p.size;
        }
        this.size = total;
    }

    slice(): BlobShim { return new BlobShim(this._parts, { type: this.type }); }
    async arrayBuffer(): Promise<ArrayBuffer> { return new ArrayBuffer(this.size); }
    async text(): Promise<string> { return this._parts.filter(p => typeof p === "string").join(""); }
    stream(): unknown { return null; }
}

/** Bare-bones URL parser that supports what the bundle reads (.href, .host, .hostname, .pathname, .protocol, .origin, .search). */
export class URLShim {
    href: string;
    protocol: string;
    host: string;
    hostname: string;
    pathname: string;
    search: string;
    origin: string;
    hash: string;
    port: string;

    constructor(url: string, base?: string) {
        const resolved = resolveUrl(String(url), base ? String(base) : undefined);
        this.href = resolved.href;
        this.protocol = resolved.protocol;
        this.host = resolved.host;
        this.hostname = resolved.hostname;
        this.port = resolved.port;
        this.pathname = resolved.pathname;
        this.search = resolved.search;
        this.hash = resolved.hash;
        this.origin = resolved.protocol && resolved.host ? `${resolved.protocol}//${resolved.host}` : "null";
    }

    toString(): string { return this.href; }
}

function resolveUrl(url: string, base?: string): { href: string; protocol: string; host: string; hostname: string; port: string; pathname: string; search: string; hash: string } {
    // Try absolute first.
    let m = /^([a-zA-Z][a-zA-Z0-9+\-.]*:)\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
    if (!m && base) {
        // Resolve against base. We only support the simple cases the bundle hits.
        const bm = /^([a-zA-Z][a-zA-Z0-9+\-.]*:)\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(base);
        if (!bm) throw new TypeError(`URLShim: invalid base ${base}`);
        const proto = bm[1]!, host = bm[2]!, basePath = bm[3] || "/";
        let full: string;
        if (url.startsWith("//")) full = `${proto}${url}`;
        else if (url.startsWith("/")) full = `${proto}//${host}${url}`;
        else if (url.startsWith("?") || url.startsWith("#")) full = `${proto}//${host}${basePath}${url}`;
        else {
            const baseDir = basePath.replace(/[^\/]*$/, "");
            full = `${proto}//${host}${baseDir}${url}`;
        }
        m = /^([a-zA-Z][a-zA-Z0-9+\-.]*:)\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(full);
    }
    if (!m) throw new TypeError(`URLShim: invalid URL ${url}`);
    const protocol = m[1]!;
    const host = m[2]!;
    const pathname = m[3] || "/";
    const search = m[4] || "";
    const hash = m[5] || "";
    const portMatch = /:(\d+)$/.exec(host);
    const hostname = portMatch ? host.slice(0, -portMatch[0].length) : host;
    const port = portMatch ? portMatch[1]! : "";
    return {
        href: `${protocol}//${host}${pathname}${search}${hash}`,
        protocol, host, hostname, port, pathname, search, hash,
    };
}

/** URLSearchParams stub — bundle rarely uses, but cheap insurance. */
export class URLSearchParamsShim {
    private _params: Array<[string, string]> = [];

    constructor(init?: string | Record<string, string>) {
        if (typeof init === "string") {
            const s = init.startsWith("?") ? init.slice(1) : init;
            if (s) {
                for (const kv of s.split("&")) {
                    const eq = kv.indexOf("=");
                    if (eq < 0) this._params.push([decodeURIComponent(kv), ""]);
                    else this._params.push([decodeURIComponent(kv.slice(0, eq)), decodeURIComponent(kv.slice(eq + 1))]);
                }
            }
        } else if (init && typeof init === "object") {
            for (const [k, v] of Object.entries(init)) this._params.push([k, String(v)]);
        }
    }

    get(name: string): string | null {
        for (const [k, v] of this._params) if (k === name) return v;
        return null;
    }
    has(name: string): boolean { return this._params.some(([k]) => k === name); }
    set(name: string, value: string): void {
        let found = false;
        this._params = this._params.filter(([k]) => {
            if (k === name) { if (!found) { found = true; return true; } return false; }
            return true;
        });
        if (found) {
            for (const p of this._params) if (p[0] === name) p[1] = String(value);
        } else {
            this._params.push([name, String(value)]);
        }
    }
    append(name: string, value: string): void { this._params.push([name, String(value)]); }
    delete(name: string): void { this._params = this._params.filter(([k]) => k !== name); }
    toString(): string {
        return this._params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    }
}

/** Minimal `crypto.getRandomValues` using Math.random. NOT cryptographic. */
export const cryptoShim = {
    getRandomValues(buf: any): any {
        if (!buf || typeof buf.length !== "number") return buf;
        for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 256) | 0;
        return buf;
    },
    randomUUID(): string {
        const hex = (n: number) => ((Math.random() * (1 << n)) | 0).toString(16).padStart(Math.ceil(n / 4), "0");
        return `${hex(32)}-${hex(16)}-4${hex(12)}-${(8 + ((Math.random() * 4) | 0)).toString(16)}${hex(12)}-${hex(32)}${hex(16)}`;
    },
};

/** Safe atob fallback (matches the one in ComixBundleRuntime). */
export function atobShim(s: string): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lookup = new Array(128).fill(-1);
    for (let i = 0; i < 64; i++) lookup[chars.charCodeAt(i)] = i;
    let out = "";
    let buf = 0;
    let bits = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 61) break;
        const v = lookup[c] ?? -1;
        if (v < 0) continue;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 0xff); }
    }
    return out;
}

export function btoaShim(s: string): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    let i = 0;
    while (i < s.length) {
        const a = s.charCodeAt(i++) & 0xff;
        const b = i < s.length ? s.charCodeAt(i++) & 0xff : -1;
        const c = i < s.length ? s.charCodeAt(i++) & 0xff : -1;
        const n = (a << 16) | (Math.max(0, b) << 8) | Math.max(0, c);
        out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + (b < 0 ? "=" : chars[(n >> 6) & 63]) + (c < 0 ? "=" : chars[n & 63]);
    }
    return out;
}
