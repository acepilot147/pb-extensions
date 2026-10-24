// Pure-JS PNG / baseline-JPEG decoding to RGBA pixels, for the WAF captcha
// solver (WafSolver.ts). The source runs in JavaScriptCore with no DOM, so there
// is no <img>/<canvas> to read pixels from — and Paperback's PBCanvas can draw
// and re-encode but not hand back pixels. comix's captcha images are go-captcha
// output: PNG (rotate picture/piece, click strip) and baseline JPEG (click
// picture), as base64 data URLs.
//
// The JPEG path mirrors what a browser canvas shows (libjpeg-turbo): float IDCT,
// "fancy" (triangle-filter) chroma upsampling for 4:2:0 and 4:2:2, BT.601 YCbCr.

export interface Pixels {
    width: number;
    height: number;
    // RGBA, 4 bytes per pixel, row-major — same layout as canvas ImageData.data
    data: Uint8Array;
}

// JavaScriptCore-safe base64 decode (no atob / Buffer on device).
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;

export function base64ToBytes(s: string): Uint8Array {
    const out = new Uint8Array(Math.floor((s.length * 3) / 4));
    let n = 0, buf = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 61) break; // '='
        const v = c < 128 ? B64_LOOKUP[c]! : -1;
        if (v < 0) continue;
        buf = ((buf << 6) | v) & 0xffffff;
        bits += 6;
        if (bits >= 8) { bits -= 8; out[n++] = (buf >> bits) & 0xff; }
    }
    return out.subarray(0, n);
}

/** Decode a `data:image/...;base64,` URL (or bare base64) by sniffing the bytes. */
export function decodeDataUrl(src: string): Pixels {
    const comma = src.startsWith("data:") ? src.indexOf(",") : -1;
    const bytes = base64ToBytes(comma >= 0 ? src.slice(comma + 1) : src);
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return decodePng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJpeg(bytes);
    throw new Error("Could not decode the captcha image");
}

// ---------------------------------------------------------------------------
// Inflate (RFC 1951) over a zlib stream (RFC 1950)

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman { counts: Uint16Array; symbols: Uint16Array }

function huffman(lengths: ArrayLike<number>, n: number): Huffman {
    const counts = new Uint16Array(16), offsets = new Uint16Array(16), symbols = new Uint16Array(n);
    for (let i = 0; i < n; i++) counts[lengths[i]!]++;
    counts[0] = 0;
    for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1]! + counts[i - 1]!;
    for (let i = 0; i < n; i++) if (lengths[i]) symbols[offsets[lengths[i]!]!++] = i;
    return { counts, symbols };
}

function fixedTables(): [Huffman, Huffman] {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144); lengths.fill(9, 144, 256); lengths.fill(7, 256, 280); lengths.fill(8, 280, 288);
    return [huffman(lengths, 288), huffman(new Uint8Array(30).fill(5), 30)];
}
let FIXED: [Huffman, Huffman] | null = null;

export function inflateZlib(input: Uint8Array): Uint8Array {
    let pos = 2, bitBuf = 0, bitCount = 0; // skip the 2-byte zlib header
    let out = new Uint8Array(Math.max(1024, input.length * 4)), outLen = 0;

    const ensure = (extra: number) => {
        if (outLen + extra <= out.length) return;
        let size = out.length * 2;
        while (size < outLen + extra) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(out.subarray(0, outLen));
        out = grown;
    };
    const bits = (n: number): number => {
        while (bitCount < n) {
            if (pos >= input.length) throw new Error("Truncated PNG data");
            bitBuf |= input[pos++]! << bitCount;
            bitCount += 8;
        }
        const v = bitBuf & ((1 << n) - 1);
        bitBuf >>>= n;
        bitCount -= n;
        return v;
    };
    const decode = (h: Huffman): number => {
        let code = 0, first = 0, index = 0;
        for (let len = 1; len < 16; len++) {
            code |= bits(1);
            const count = h.counts[len]!;
            if (code - first < count) return h.symbols[index + code - first]!;
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        throw new Error("Bad PNG data");
    };

    let last = 0;
    while (!last) {
        last = bits(1);
        const type = bits(2);
        if (type === 0) {
            bitBuf = 0; bitCount = 0;
            const len = input[pos]! | (input[pos + 1]! << 8);
            pos += 4;
            ensure(len);
            out.set(input.subarray(pos, pos + len), outLen);
            outLen += len; pos += len;
            continue;
        }
        let lit: Huffman, dist: Huffman;
        if (type === 1) {
            [lit, dist] = FIXED ?? (FIXED = fixedTables());
        } else if (type === 2) {
            const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
            const clLengths = new Uint8Array(19);
            for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]!] = bits(3);
            const cl = huffman(clLengths, 19);
            const lengths = new Uint8Array(hlit + hdist);
            for (let i = 0; i < hlit + hdist;) {
                const sym = decode(cl);
                if (sym < 16) { lengths[i++] = sym; continue; }
                let repeat = 0, value = 0;
                if (sym === 16) { value = lengths[i - 1]!; repeat = 3 + bits(2); }
                else if (sym === 17) repeat = 3 + bits(3);
                else repeat = 11 + bits(7);
                while (repeat--) lengths[i++] = value;
            }
            lit = huffman(lengths.subarray(0, hlit), hlit);
            dist = huffman(lengths.subarray(hlit), hdist);
        } else {
            throw new Error("Bad PNG data");
        }
        for (;;) {
            const sym = decode(lit);
            if (sym < 256) { ensure(1); out[outLen++] = sym; continue; }
            if (sym === 256) break;
            const l = LEN_BASE[sym - 257]! + bits(LEN_EXTRA[sym - 257]!);
            const ds = decode(dist);
            const d = DIST_BASE[ds]! + bits(DIST_EXTRA[ds]!);
            ensure(l);
            for (let i = 0; i < l; i++, outLen++) out[outLen] = out[outLen - d]!;
        }
    }
    return out.subarray(0, outLen);
}

// ---------------------------------------------------------------------------
// PNG (non-interlaced; any colour type, bit depths 1-16)

export function decodePng(bytes: Uint8Array): Pixels {
    const u32 = (p: number) => ((bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!) >>> 0;
    let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
    let palette: Uint8Array | null = null, transparency: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    let idatLength = 0;
    for (let p = 8; p + 8 <= bytes.length;) {
        const len = u32(p);
        const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
        const body = bytes.subarray(p + 8, p + 8 + len);
        if (type === "IHDR") {
            width = u32(p + 8); height = u32(p + 12);
            depth = body[8]!; colorType = body[9]!; interlace = body[12]!;
        } else if (type === "PLTE") palette = body;
        else if (type === "tRNS") transparency = body;
        else if (type === "IDAT") { idat.push(body); idatLength += len; }
        else if (type === "IEND") break;
        p += 12 + len;
    }
    if (!width || !height || interlace) throw new Error("Unsupported captcha image");

    const zlib = new Uint8Array(idatLength);
    let o = 0;
    for (const chunk of idat) { zlib.set(chunk, o); o += chunk.length; }
    const raw = inflateZlib(zlib);

    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
    if (!channels) throw new Error("Unsupported captcha image");
    const bpp = Math.max(1, (channels * depth) >> 3);
    const stride = Math.ceil((width * channels * depth) / 8);
    const lines = new Uint8Array(stride * height);
    for (let y = 0, src = 0; y < height; y++) {
        const filter = raw[src++]!;
        const row = y * stride, prev = row - stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? lines[row + x - bpp]! : 0;
            const b = y > 0 ? lines[prev + x]! : 0;
            const c = x >= bpp && y > 0 ? lines[prev + x - bpp]! : 0;
            let v = raw[src++]!;
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            lines[row + x] = v & 0xff;
        }
    }

    // Sample n of a row as an 8-bit value (16-bit keeps its high byte; low depths are scaled up)
    const sample = (row: number, n: number): number => {
        if (depth === 8) return lines[row + n]!;
        if (depth === 16) return lines[row + n * 2]!;
        const bit = n * depth, v = (lines[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
    };
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = y * stride;
        for (let x = 0; x < width; x++) {
            const d = (y * width + x) * 4;
            if (colorType === 3) {
                const i = sample(row, x);
                data[d] = palette?.[i * 3] ?? 0; data[d + 1] = palette?.[i * 3 + 1] ?? 0; data[d + 2] = palette?.[i * 3 + 2] ?? 0;
                data[d + 3] = transparency && i < transparency.length ? transparency[i]! : 255;
            } else if (colorType === 0 || colorType === 4) {
                const g = sample(row, x * channels);
                data[d] = data[d + 1] = data[d + 2] = g;
                data[d + 3] = colorType === 4 ? sample(row, x * 2 + 1) : 255;
            } else {
                data[d] = sample(row, x * channels); data[d + 1] = sample(row, x * channels + 1); data[d + 2] = sample(row, x * channels + 2);
                data[d + 3] = colorType === 6 ? sample(row, x * 4 + 3) : 255;
            }
        }
    }
    return { width, height, data };
}

// ---------------------------------------------------------------------------
// JPEG (baseline / extended sequential Huffman; 1 or 3 components)

const ZIGZAG = new Uint8Array([
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
    28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
    54, 47, 55, 62, 63,
]);

// IDCT basis: COS[x * 8 + u] = C(u)/2 * cos((2x + 1) u pi / 16)
const IDCT_COS = new Float64Array(64);
for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) IDCT_COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
}

interface JpegHuffman { maxCode: Int32Array; valPtr: Int32Array; minCode: Int32Array; values: Uint8Array }

function jpegHuffman(counts: Uint8Array, values: Uint8Array): JpegHuffman {
    const maxCode = new Int32Array(18).fill(-1), valPtr = new Int32Array(17), minCode = new Int32Array(17);
    let code = 0, k = 0;
    for (let len = 1; len <= 16; len++) {
        valPtr[len] = k;
        minCode[len] = code;
        code += counts[len - 1]!;
        k += counts[len - 1]!;
        if (counts[len - 1]) maxCode[len] = code - 1;
        code <<= 1;
    }
    maxCode[17] = 0x7fffffff;
    return { maxCode, valPtr, minCode, values };
}

interface JpegComponent {
    id: number; h: number; v: number; tq: number;
    td: number; ta: number; pred: number;
    blocksPerLine: number; blocksPerColumn: number;
    width: number; height: number;
    plane: Uint8Array; // blocksPerLine*8 wide
}

export function decodeJpeg(bytes: Uint8Array): Pixels {
    const quant: Int32Array[] = [];
    const dcTables: JpegHuffman[] = [], acTables: JpegHuffman[] = [];
    let components: JpegComponent[] = [];
    let width = 0, height = 0, hMax = 1, vMax = 1, mcusPerLine = 0, mcusPerColumn = 0, restartInterval = 0;
    let adobe = -1;
    const u16 = (p: number) => (bytes[p]! << 8) | bytes[p + 1]!;

    let p = 2;
    while (p < bytes.length) {
        if (bytes[p] !== 0xff) { p++; continue; }
        const marker = bytes[p + 1]!;
        p += 2;
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { if (marker === 0xff) p--; continue; }
        if (marker === 0xd9) break;
        const len = u16(p), end = p + len;
        if (marker === 0xdb) {
            for (let q = p + 2; q < end;) {
                const precision = bytes[q]! >> 4, id = bytes[q]! & 15;
                const table = new Int32Array(64);
                q++;
                for (let i = 0; i < 64; i++) {
                    table[ZIGZAG[i]!] = precision ? u16(q) : bytes[q]!;
                    q += precision ? 2 : 1;
                }
                quant[id] = table;
            }
        } else if (marker === 0xc4) {
            for (let q = p + 2; q < end;) {
                const cls = bytes[q]! >> 4, id = bytes[q]! & 15;
                const counts = bytes.subarray(q + 1, q + 17);
                const total = counts.reduce((s, c) => s + c, 0);
                const table = jpegHuffman(counts, bytes.subarray(q + 17, q + 17 + total));
                (cls ? acTables : dcTables)[id] = table;
                q += 17 + total;
            }
        } else if (marker === 0xc0 || marker === 0xc1) {
            height = u16(p + 3); width = u16(p + 5);
            const n = bytes[p + 7]!;
            components = [];
            for (let i = 0; i < n; i++) {
                const q = p + 8 + i * 3;
                components.push({
                    id: bytes[q]!, h: bytes[q + 1]! >> 4, v: bytes[q + 1]! & 15, tq: bytes[q + 2]!,
                    td: 0, ta: 0, pred: 0, blocksPerLine: 0, blocksPerColumn: 0, width: 0, height: 0, plane: new Uint8Array(0),
                });
            }
            hMax = Math.max(...components.map((c) => c.h));
            vMax = Math.max(...components.map((c) => c.v));
            mcusPerLine = Math.ceil(width / (8 * hMax));
            mcusPerColumn = Math.ceil(height / (8 * vMax));
            for (const c of components) {
                c.width = Math.ceil((width * c.h) / hMax);
                c.height = Math.ceil((height * c.v) / vMax);
                c.blocksPerLine = mcusPerLine * c.h;
                c.blocksPerColumn = mcusPerColumn * c.v;
                c.plane = new Uint8Array(c.blocksPerLine * 8 * c.blocksPerColumn * 8);
            }
        } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            throw new Error("Unsupported captcha image (progressive JPEG)");
        } else if (marker === 0xdd) {
            restartInterval = u16(p + 2);
        } else if (marker === 0xee && String.fromCharCode(...bytes.subarray(p + 2, p + 7)) === "Adobe") {
            adobe = bytes[p + 13]!;
        } else if (marker === 0xda) {
            const n = bytes[p + 2]!;
            const scan: JpegComponent[] = [];
            for (let i = 0; i < n; i++) {
                const c = components.find((x) => x.id === bytes[p + 3 + i * 2])!;
                c.td = bytes[p + 4 + i * 2]! >> 4;
                c.ta = bytes[p + 4 + i * 2]! & 15;
                scan.push(c);
            }
            p = decodeScan(bytes, end, scan, quant, dcTables, acTables, mcusPerLine, mcusPerColumn, restartInterval);
            continue;
        }
        p = end;
    }
    if (!width || !components.length) throw new Error("Could not decode the captcha image");

    const data = new Uint8Array(width * height * 4);
    const planes = components.map((c) => upsample(c, width, height, hMax / c.h, vMax / c.v));
    const transform = components.length === 3 && adobe !== 0;
    for (let i = 0, d = 0; i < width * height; i++, d += 4) {
        if (components.length < 3) {
            data[d] = data[d + 1] = data[d + 2] = planes[0]![i]!;
        } else if (transform) {
            const Y = planes[0]![i]!, Cb = planes[1]![i]! - 128, Cr = planes[2]![i]! - 128;
            data[d] = clamp(Y + 1.402 * Cr);
            data[d + 1] = clamp(Y - 0.344136286 * Cb - 0.714136286 * Cr);
            data[d + 2] = clamp(Y + 1.772 * Cb);
        } else {
            data[d] = planes[0]![i]!; data[d + 1] = planes[1]![i]!; data[d + 2] = planes[2]![i]!;
        }
        data[d + 3] = 255;
    }
    return { width, height, data };
}

const clamp = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

function decodeScan(
    bytes: Uint8Array, start: number, scan: JpegComponent[], quant: Int32Array[],
    dcTables: JpegHuffman[], acTables: JpegHuffman[],
    mcusPerLine: number, mcusPerColumn: number, restartInterval: number,
): number {
    let p = start, bitBuf = 0, bitCount = 0;
    const bit = (): number => {
        if (bitCount === 0) {
            let b = bytes[p++] ?? 0;
            if (b === 0xff) {
                const next = bytes[p];
                if (next === 0) p++;
                else if (next !== undefined && next >= 0xd0 && next <= 0xd7) { b = 0; p--; } // ran into a restart marker: pad
            }
            bitBuf = b;
            bitCount = 8;
        }
        bitCount--;
        return (bitBuf >> bitCount) & 1;
    };
    const receive = (n: number): number => {
        let v = 0;
        for (let i = 0; i < n; i++) v = (v << 1) | bit();
        return v;
    };
    const extend = (v: number, n: number) => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
    const decode = (h: JpegHuffman): number => {
        let code = bit(), len = 1;
        while (code > h.maxCode[len]!) {
            code = (code << 1) | bit();
            if (++len > 16) throw new Error("Bad JPEG data");
        }
        return h.values[h.valPtr[len]! + code - h.minCode[len]!]!;
    };

    const coeffs = new Int32Array(64), block = new Float64Array(64), tmp = new Float64Array(64);
    const decodeBlock = (c: JpegComponent, row: number, col: number) => {
        coeffs.fill(0);
        const t = decode(dcTables[c.td]!);
        c.pred += extend(receive(t), t);
        coeffs[0] = c.pred;
        for (let k = 1; k < 64;) {
            const rs = decode(acTables[c.ta]!);
            const r = rs >> 4, s = rs & 15;
            if (s === 0) {
                if (r < 15) break;
                k += 16;
                continue;
            }
            k += r;
            if (k > 63) break;
            coeffs[ZIGZAG[k]!] = extend(receive(s), s);
            k++;
        }
        const q = quant[c.tq]!;
        for (let i = 0; i < 64; i++) block[i] = coeffs[i]! * q[i]!;
        // separable 2D IDCT: rows then columns
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                let s = 0;
                for (let u = 0; u < 8; u++) s += IDCT_COS[x * 8 + u]! * block[y * 8 + u]!;
                tmp[y * 8 + x] = s;
            }
        }
        const stride = c.blocksPerLine * 8;
        for (let x = 0; x < 8; x++) {
            for (let y = 0; y < 8; y++) {
                let s = 0;
                for (let v = 0; v < 8; v++) s += IDCT_COS[y * 8 + v]! * tmp[v * 8 + x]!;
                c.plane[(row * 8 + y) * stride + col * 8 + x] = clamp(s + 128);
            }
        }
    };

    const total = scan.length === 1
        ? Math.ceil(scan[0]!.width / 8) * Math.ceil(scan[0]!.height / 8)
        : mcusPerLine * mcusPerColumn;
    for (const c of scan) c.pred = 0;
    for (let m = 0; m < total; m++) {
        if (restartInterval && m > 0 && m % restartInterval === 0) {
            // byte-align and skip the RSTn marker
            bitCount = 0;
            while (p < bytes.length && !(bytes[p] === 0xff && bytes[p + 1]! >= 0xd0 && bytes[p + 1]! <= 0xd7)) p++;
            p += 2;
            for (const c of scan) c.pred = 0;
        }
        if (scan.length === 1) {
            const c = scan[0]!, perLine = Math.ceil(c.width / 8);
            decodeBlock(c, Math.floor(m / perLine), m % perLine);
        } else {
            const mcuRow = Math.floor(m / mcusPerLine), mcuCol = m % mcusPerLine;
            for (const c of scan) {
                for (let v = 0; v < c.v; v++) {
                    for (let h = 0; h < c.h; h++) decodeBlock(c, mcuRow * c.v + v, mcuCol * c.h + h);
                }
            }
        }
    }
    // resume marker parsing at the next 0xFF that isn't stuffing or a restart
    while (p < bytes.length && !(bytes[p] === 0xff && bytes[p + 1] !== 0 && !(bytes[p + 1]! >= 0xd0 && bytes[p + 1]! <= 0xd7))) p++;
    return p;
}

// Component plane -> full-resolution plane. 2x horizontal/vertical use
// libjpeg's triangle filter ("fancy upsampling"); anything else is replicated.
function upsample(c: JpegComponent, width: number, height: number, sx: number, sy: number): Uint8Array {
    const stride = c.blocksPerLine * 8, out = new Uint8Array(width * height);
    const at = (x: number, y: number) => c.plane[Math.min(y, c.height - 1) * stride + Math.min(Math.max(x, 0), c.width - 1)]!;
    for (let y = 0; y < height; y++) {
        const r = Math.floor(y / sy);
        const far = sy === 2 ? Math.min(Math.max(y & 1 ? r + 1 : r - 1, 0), c.height - 1) : r;
        for (let x = 0; x < width; x++) {
            const col = Math.floor(x / sx);
            let v: number;
            if (sx === 2 && sy === 2) {
                const sum = (cc: number) => 3 * at(cc, r) + at(cc, far);
                const here = sum(col);
                if (x & 1) v = col === c.width - 1 ? (here * 4 + 7) >> 4 : (here * 3 + sum(col + 1) + 7) >> 4;
                else v = col === 0 ? (here * 4 + 8) >> 4 : (here * 3 + sum(col - 1) + 8) >> 4;
            } else if (sx === 2 && sy === 1) {
                const here = at(col, r);
                if (x & 1) v = col === c.width - 1 ? here : (3 * here + at(col + 1, r) + 2) >> 2;
                else v = col === 0 ? here : (3 * here + at(col - 1, r) + 1) >> 2;
            } else {
                v = at(col, r);
            }
            out[y * width + x] = v;
        }
    }
    return out;
}
