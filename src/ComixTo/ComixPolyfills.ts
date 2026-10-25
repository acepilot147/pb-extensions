/** Browser API subset for apicore/axios in Paperback's bare JavaScriptCore.
 * No host globals are installed or required. Deliberate limits:
 * - TextDecoder is UTF-8 only; stream:true throws rather than corrupting chunks.
 * - URLs require HTTP(S):// and ASCII DNS or canonical dotted IPv4 hosts;
 *   no IDNA, IPv6, non-special schemes, or shorthand numeric hosts.
 *   href/pathname/search/hash and searchParams are mutable; authority is read-only.
 * - Blob is in-memory; stream() and non-transparent endings explicitly throw.
 * This is an apicore compatibility layer, not a complete Web IDL implementation.
 */

/** Convert a JS string to Unicode scalar values, replacing lone surrogates. */
function scalarString(value: unknown): string {
    return String(value).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,
        (part) => part.length === 2 ? part : "\uFFFD");
}

export class TextEncoderShim {
    get encoding(): string { return "utf-8"; }

    encode(input: string = ""): Uint8Array {
        const bytes: number[] = [];
        for (const char of scalarString(input)) {
            const cp = char.codePointAt(0)!;
            if (cp < 0x80) bytes.push(cp);
            else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
            else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
            else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        }
        return new Uint8Array(bytes);
    }

    encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
        let read = 0, written = 0;
        for (const char of String(input)) {
            const bytes = this.encode(char);
            if (written + bytes.length > destination.length) break;
            destination.set(bytes, written);
            written += bytes.length;
            read += char.length;
        }
        return { read, written };
    }
}

function byteView(input: ArrayBuffer | ArrayBufferView): Uint8Array {
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    throw new TypeError("Expected an ArrayBuffer or ArrayBufferView");
}

/** UTF-8 decoding follows the replacement boundaries of the Encoding Standard. */
export class TextDecoderShim {
    readonly encoding = "utf-8";
    readonly fatal: boolean;
    readonly ignoreBOM: boolean;

    constructor(label = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
        if (!["utf-8", "utf8", "unicode-1-1-utf-8"].includes(String(label).trim().toLowerCase())) {
            throw new RangeError("TextDecoderShim only supports UTF-8");
        }
        this.fatal = !!options.fatal;
        this.ignoreBOM = !!options.ignoreBOM;
    }

    decode(input?: ArrayBuffer | ArrayBufferView, options: { stream?: boolean } = {}): string {
        if (options.stream) throw new TypeError("TextDecoderShim does not support streaming");
        const bytes = input === undefined ? new Uint8Array(0) : byteView(input);
        let out = "", i = 0;
        const invalid = () => {
            if (this.fatal) throw new TypeError("Invalid UTF-8");
            return "\uFFFD";
        };
        while (i < bytes.length) {
            const first = bytes[i++]!;
            if (first < 0x80) { out += String.fromCharCode(first); continue; }
            let needed: number, cp: number;
            if (first >= 0xc2 && first <= 0xdf) { needed = 1; cp = first & 31; }
            else if (first >= 0xe0 && first <= 0xef) { needed = 2; cp = first & 15; }
            else if (first >= 0xf0 && first <= 0xf4) { needed = 3; cp = first & 7; }
            else { out += invalid(); continue; }
            let consumed = 0;
            while (consumed < needed && i < bytes.length) {
                const next = bytes[i]!;
                const low = consumed === 0 && first === 0xe0 ? 0xa0 : consumed === 0 && first === 0xf0 ? 0x90 : 0x80;
                const high = consumed === 0 && first === 0xed ? 0x9f : consumed === 0 && first === 0xf4 ? 0x8f : 0xbf;
                if (next < low || next > high) break;
                cp = (cp << 6) | (next & 63);
                consumed++; i++;
            }
            out += consumed === needed ? String.fromCodePoint(cp) : invalid();
        }
        return !this.ignoreBOM && out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
    }
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function formDecode(value: string): string {
    const input = scalarString(value).replace(/\+/g, " ");
    const bytes: number[] = [];
    for (let i = 0; i < input.length;) {
        if (input[i] === "%" && /^[\da-f]{2}$/i.test(input.slice(i + 1, i + 3))) {
            bytes.push(parseInt(input.slice(i + 1, i + 3), 16)); i += 3;
        } else {
            const char = String.fromCodePoint(input.codePointAt(i)!);
            for (const byte of new TextEncoderShim().encode(char)) bytes.push(byte);
            i += char.length;
        }
    }
    return new TextDecoderShim("utf-8", { ignoreBOM: true }).decode(new Uint8Array(bytes));
}

function formEncode(value: string): string {
    return encodeURIComponent(value).replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, "+");
}

const REPLACE_QUERY = Symbol("replace URL query");

export class URLSearchParamsShim {
    private pairs: [string, string][] = [];

    constructor(init: unknown = "", private readonly changed?: () => void) {
        if (init == null) return;
        if (typeof init === "object" && Symbol.iterator in init) {
            for (const entry of init as Iterable<Iterable<unknown>>) {
                if (!entry || typeof entry !== "object" || !(Symbol.iterator in entry)) throw new TypeError("Expected query pairs");
                const pair = Array.from(entry);
                if (pair.length !== 2) throw new TypeError("Expected exactly two items in query pair");
                this.pairs.push([scalarString(pair[0]), scalarString(pair[1])]);
            }
        } else if (typeof init === "object") {
            for (const key of Object.keys(init)) this.pairs.push([scalarString(key), scalarString((init as Record<string, unknown>)[key])]);
        } else {
            for (const part of String(init).replace(/^\?/, "").split("&")) {
                if (!part) continue;
                const eq = part.indexOf("=");
                this.pairs.push([formDecode(eq < 0 ? part : part.slice(0, eq)), formDecode(eq < 0 ? "" : part.slice(eq + 1))]);
            }
        }
    }

    get [Symbol.toStringTag](): string { return "URLSearchParams"; }
    get size(): number { return this.pairs.length; }
    get(name: string): string | null { return this.pairs.find(([key]) => key === scalarString(name))?.[1] ?? null; }
    getAll(name: string): string[] { return this.pairs.filter(([key]) => key === scalarString(name)).map(([, value]) => value); }
    has(name: string, value?: string): boolean {
        const key = scalarString(name), val = value === undefined ? undefined : scalarString(value);
        return this.pairs.some(([k, v]) => k === key && (val === undefined || val === v));
    }
    append(name: string, value: string): void { this.pairs.push([scalarString(name), scalarString(value)]); this.changed?.(); }
    set(name: string, value: string): void {
        const key = scalarString(name), val = scalarString(value);
        const first = this.pairs.findIndex(([k]) => k === key);
        if (first < 0) this.pairs.push([key, val]);
        else {
            this.pairs[first]![1] = val;
            for (let i = this.pairs.length - 1; i > first; i--) if (this.pairs[i]![0] === key) this.pairs.splice(i, 1);
        }
        this.changed?.();
    }
    delete(name: string, value?: string): void {
        const key = scalarString(name), val = value === undefined ? undefined : scalarString(value);
        for (let i = this.pairs.length - 1; i >= 0; i--) {
            const pair = this.pairs[i]!;
            if (pair[0] === key && (val === undefined || pair[1] === val)) this.pairs.splice(i, 1);
        }
        this.changed?.();
    }
    sort(): void { this.pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); this.changed?.(); }
    [REPLACE_QUERY](query: string): void {
        this.pairs.length = 0;
        for (const pair of new URLSearchParamsShim("?" + query)) this.pairs.push(pair);
    }
    forEach(callback: (value: string, key: string, parent: URLSearchParamsShim) => void, thisArg?: unknown): void {
        for (const [key, value] of this) callback.call(thisArg, value, key, this);
    }
    *entries(): IterableIterator<[string, string]> { for (const [key, value] of this.pairs) yield [key, value]; }
    *keys(): IterableIterator<string> { for (const [key] of this) yield key; }
    *values(): IterableIterator<string> { for (const [, value] of this) yield value; }
    [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries(); }
    toString(): string { return this.pairs.map(([key, value]) => `${formEncode(key)}=${formEncode(value)}`).join("&"); }
}
interface URLParts {
    protocol: string; hostname: string; port: string; username: string; password: string;
    pathname: string; query: string | null; fragment: string | null;
}

function urlEncode(value: string, extra: string): string {
    let out = "";
    for (const char of scalarString(value)) {
        const cp = char.codePointAt(0)!;
        if (cp <= 0x20 || cp > 0x7e || extra.includes(char)) {
            for (const byte of new TextEncoderShim().encode(char)) out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
        } else out += char;
    }
    return out;
}

function normalizePath(path: string): string {
    const segments = path.split("/"), out: string[] = [];
    for (let i = 1; i < segments.length; i++) {
        const part = segments[i]!, dot = part.replace(/%2e/ig, ".");
        if (dot === "..") out.pop();
        else if (dot !== ".") out.push(part);
        if ((dot === "." || dot === "..") && i === segments.length - 1) out.push("");
    }
    return urlEncode("/" + out.join("/"), '"#<>?`{}');
}

function parseURL(input: string, base?: string): URLParts {
    const parent = base === undefined ? undefined : parseURL(base);
    let text = scalarString(input).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\r\n]/g, "");
    // For special HTTP URLs, backslashes in the authority/path are slashes.
    text = text.replace(/^[^?#]*/, (path) => path.replace(/\\/g, "/"));
    let fragment: string | null = null, query: string | null = null;
    const hash = text.indexOf("#");
    if (hash >= 0) { fragment = urlEncode(text.slice(hash + 1), '"<>`'); text = text.slice(0, hash); }
    const question = text.indexOf("?");
    if (question >= 0) { query = urlEncode(text.slice(question + 1), '"#<>\''); text = text.slice(0, question); }
    const scheme = /^([a-z][a-z\d+.-]*:)/i.exec(text);
    let protocol = scheme ? scheme[1]!.toLowerCase() : parent?.protocol;
    if (!protocol || !/^https?:$/.test(protocol)) throw new TypeError("URLShim supports only absolute HTTP(S) URLs or a valid HTTP(S) base");
    if (scheme) text = text.slice(scheme[0].length);
    if (!text.startsWith("//")) {
        if (scheme || !parent) throw new TypeError("Invalid HTTP(S) URL");
        return { ...parent, pathname: text ? normalizePath(text.startsWith("/") ? text : parent.pathname.slice(0, parent.pathname.lastIndexOf("/") + 1) + text) : parent.pathname,
            query: query === null && !text ? parent.query : query, fragment };
    }
    const authorityEnd = text.indexOf("/", 2);
    let authority = authorityEnd < 0 ? text.slice(2) : text.slice(2, authorityEnd);
    const pathname = normalizePath(authorityEnd < 0 ? "/" : text.slice(authorityEnd));
    let username = "", password = "";
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
        const auth = authority.slice(0, at), colon = auth.indexOf(":");
        const extra = '"#<>?`{}/:;=@[\\]^|';
        username = urlEncode(colon < 0 ? auth : auth.slice(0, colon), extra);
        password = colon < 0 ? "" : urlEncode(auth.slice(colon + 1), extra);
        authority = authority.slice(at + 1);
    }
    if (/[^\x00-\x7f]/.test(authority)) throw new TypeError("URLShim requires an ASCII hostname (no IDNA conversion)");
    const host = /^([a-z\d._-]+)(?::(\d*))?$/i.exec(authority);
    if (!host) throw new TypeError("Invalid or unsupported HTTP(S) hostname");
    const hostname = host[1]!.toLowerCase();
    const labels = hostname.replace(/\.$/, "").split(".");
    if (/^(?:\d+|0x[\da-f]*)$/i.test(labels[labels.length - 1]!)) {
        if (labels.length !== 4 || labels.some((part) => !/^(?:0|[1-9]\d*)$/.test(part) || Number(part) > 255) || hostname.endsWith(".")) {
            throw new TypeError("URLShim requires canonical dotted-decimal IPv4");
        }
    }
    let port = host[2] ? String(Number(host[2])) : "";
    if (Number(port) > 65535) throw new TypeError("Invalid URL port");
    if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) port = "";
    return { protocol, hostname, port, username, password, pathname, query, fragment };
}

/** HTTP(S), ASCII DNS/canonical IPv4 hosts; not a full WHATWG URL implementation. */
export class URLShim {
    private parts: URLParts;
    readonly searchParams: URLSearchParamsShim;

    constructor(input: string | URLShim, base?: string | URLShim) {
        this.parts = parseURL(String(input), base === undefined ? undefined : String(base));
        this.searchParams = new URLSearchParamsShim("?" + (this.parts.query ?? ""), () => {
            this.parts.query = this.searchParams.toString() || null;
        });
    }
    get protocol(): string { return this.parts.protocol; }
    get hostname(): string { return this.parts.hostname; }
    get port(): string { return this.parts.port; }
    get username(): string { return this.parts.username; }
    get password(): string { return this.parts.password; }
    get host(): string { return this.hostname + (this.port ? ":" + this.port : ""); }
    get origin(): string { return this.protocol + "//" + this.host; }
    get pathname(): string { return this.parts.pathname; }
    set pathname(value: string) {
        const path = scalarString(value).replace(/[\t\r\n]/g, "").replace(/\\/g, "/");
        this.parts.pathname = normalizePath(path.startsWith("/") ? path : "/" + path);
    }
    get search(): string { return this.parts.query ? "?" + this.parts.query : ""; }
    set search(value: string) {
        const text = scalarString(value).replace(/[\t\r\n]/g, "");
        this.parts.query = text === "" ? null : urlEncode(text.replace(/^\?/, ""), '"#<>\'');
        this.searchParams[REPLACE_QUERY](this.parts.query ?? "");
    }
    get hash(): string { return this.parts.fragment ? "#" + this.parts.fragment : ""; }
    set hash(value: string) {
        const text = scalarString(value).replace(/[\t\r\n]/g, "");
        this.parts.fragment = text === "" ? null : urlEncode(text.replace(/^#/, ""), '"<>`');
    }
    get href(): string {
        const auth = this.username || this.password ? this.username + (this.password ? ":" + this.password : "") + "@" : "";
        return this.protocol + "//" + auth + this.host + this.pathname + (this.parts.query === null ? "" : "?" + this.parts.query) + (this.parts.fragment === null ? "" : "#" + this.parts.fragment);
    }
    set href(value: string) {
        this.parts = parseURL(String(value));
        this.searchParams[REPLACE_QUERY](this.parts.query ?? "");
    }
    toString(): string { return this.href; }
    toJSON(): string { return this.href; }
}

function blobType(value: unknown): string {
    const type = String(value);
    return /[^\x20-\x7e]/.test(type) ? "" : type.toLowerCase();
}

/** In-memory Blob with real, copied bytes. No ReadableStream dependency. */
export class BlobShim {
    private readonly data: Uint8Array;
    readonly type: string;

    constructor(parts: Iterable<unknown> = [], options: { type?: string; endings?: string } = {}) {
        if (options.endings !== undefined && options.endings !== "transparent") throw new TypeError("BlobShim supports only transparent endings");
        if (!parts || typeof parts !== "object" || !(Symbol.iterator in parts)) throw new TypeError("Blob parts must be a sequence");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (const part of parts) {
            const bytes = part instanceof BlobShim ? part.data :
                part instanceof ArrayBuffer || ArrayBuffer.isView(part) ? byteView(part) : new TextEncoderShim().encode(String(part));
            chunks.push(bytes.slice()); size += bytes.length;
        }
        this.data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { this.data.set(chunk, offset); offset += chunk.length; }
        this.type = blobType(options.type === undefined ? "" : options.type);
    }
    get size(): number { return this.data.length; }
    get [Symbol.toStringTag](): string { return "Blob"; }
    async arrayBuffer(): Promise<ArrayBuffer> { return this.data.slice().buffer; }
    async text(): Promise<string> { return new TextDecoderShim().decode(this.data); }
    slice(start = 0, end = this.size, contentType = ""): BlobShim {
        const offset = (n: number) => {
            n = Number(n);
            n = Number.isFinite(n) ? Math.trunc(n) : 0;
            return n < 0 ? Math.max(this.size + n, 0) : Math.min(n, this.size);
        };
        const from = offset(start), to = Math.max(from, offset(end));
        return new BlobShim([this.data.subarray(from, to)], { type: contentType });
    }
    stream(): never { throw new TypeError("BlobShim does not support streams"); }
}

function invalidCharacter(): never {
    // DOMException is also absent in Paperback; preserve its browser error name.
    const error = new Error("Invalid character in base64 input");
    error.name = "InvalidCharacterError";
    throw error;
}

export function btoaShim(input: string): string {
    if (!arguments.length) throw new TypeError("btoa requires an argument");
    const s = String(input);
    let out = "";
    for (let i = 0; i < s.length; i += 3) {
        const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
        if (a > 255 || b > 255 || c > 255) invalidCharacter();
        const n = (a << 16) | ((b || 0) << 8) | (c || 0);
        out += BASE64[(n >>> 18) & 63]! + BASE64[(n >>> 12) & 63]!;
        out += i + 1 < s.length ? BASE64[(n >>> 6) & 63]! : "=";
        out += i + 2 < s.length ? BASE64[n & 63]! : "=";
    }
    return out;
}

export function atobShim(input: string): string {
    if (!arguments.length) throw new TypeError("atob requires an argument");
    let s = String(input).replace(/[\t\n\f\r ]/g, "");
    if (s.length % 4 === 0) s = s.replace(/==?$/, "");
    if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) invalidCharacter();
    let out = "", bits = 0, value = 0;
    for (const char of s) {
        value = (value << 6) | BASE64.indexOf(char);
        bits += 6;
        if (bits >= 8) { bits -= 8; out += String.fromCharCode((value >>> bits) & 255); }
    }
    return out;
}
