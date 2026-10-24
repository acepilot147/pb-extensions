// Solves comix's own WAF captcha (the "Verify you're human" page at
// /@waf/challenge) inside the source, so a captcha_required 403 can be cleared
// and the request retried without the user opening the web view.
//
// Port of keiyoushi's Comix solver (a WebView script) to Paperback 0.8, which has
// no DOM: images are decoded by ImageDecode.ts instead of <img>/<canvas>, and
// requests go through the source's request manager (so the User-Agent matches —
// waf_pass is only accepted with the UA it was issued to).
//   Rotation search ported from https://github.com/nekomangaorg/Neko (ComixWafSolver)
//   Shapes: go-captcha's stock set (https://github.com/wenlng/go-captcha-assets,
//   Apache-2.0) as 60x60 bitmaps
//
// comix serves either its go-captcha challenge (rotate the piece, or click the
// strip's shapes in the picture), which this answers via /@waf/generate +
// /@waf/verify, or a Cloudflare Turnstile check, which only a real browser can
// pass — for that the user still has to use the cloud button (web view).

import { Request, RequestManager, Response } from "@paperback/types";
import { base64ToBytes, decodeDataUrl, Pixels } from "./ImageDecode";

const DOMAIN = "https://comix.to";

const SHAPES = [
    "AAAAAH4AAAAAAAAf8AAAAAAAA/+AAAAAAAB//AAAAAAAB//gAAAAAAB//gAAAA8AB//wAAAB+AD//wAAAD/gD//+AAAH/gD///wAAH/wD///8AAP/4D///+AAP/8H////AAP/+H////AAP/+H////AAP//H////AAf//n////AB///3///+AH///3///8AP///////wAf///////gA///////+AA///////4AA///////wAA////////wAf////////8f////////+P////////+H/////////A/////////AB////////AAAf//////AAA//////+AAB//////8AAH//////4AAP//////wAAf//////gAB//////+AAD//////8AAH//////8AAP//////8AAf//////8AAf///9//8AAf///9//8AA////87/8AAf///85/4AAf///48/4AAP///48fwAAD///48HAAAAA//4+AAAAAA//w+AAAAAAf/w+AAAAAAf/w+AAAAAAP/h+AAAAAAH/B+AAAAAAD8B4AAAAAAAADwAAAAAAAADAAAAAAAAACAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAH8AAAAAAAAP+AAAAAAAAf/AAAAAAAB//gAAAAAAH//4AAAAAf/////AAAB//////gAAB//////wAAD//////wAAD//////4AAD//////4AAD//////4AAD//////4AAH//////4AAH//////4AAH//////8AAP//////+AAf///////AB////////gD////////wH////////4H////////8P////////8P////////8P////////8P////////8H////////8D////////4D////////wB////////wB////////gA////////gA////////gA////////gA////////gA////////gB////////gB////////gB////////wB////////wB////////gB////////gA////////AAf//////+AAH//////8AAA//////AAAAP////8AAAAH////4AAAAD////4AAAAD////wAAAAB////wAAAAB////gAAAAA//f/gAAAAAf4D/AAAAAAHAAcAAAAAAAAAAAAAAAAAAAAAAA",
    "P+AAAAAAf8f+AAAAAAf+//AAAAAA////////////////////////////////////////////////////////////////AAAAAA///+AAAAAAf/P8AAAAAAP8H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4H4AAAAAAH4P8AAAAAAf+/+AAAAAA////AAAAAA////////////////////////////////////////////////////////////////AAAAAA//f+AAAAAA//P+AAAAAAf+",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//////8AAf//////+AAf///////AA////////AA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////gA////////AAf///////AAP//////+AAD//////4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAACAAAAAf/gB/+AAAB//4H//gAAH//+f//4AAP//////8AAf//////+AA////////AB////////gD////////wD////////wH////////4H////////4P////////8P////////8P////////8P////////8P////////8P////////8P////////8P////////8P////////8P////////8P////////8P////////8P////////8H////////4H////////4D////////wD////////wB////////gA////////AAf//////+AAP//////8AAH//////4AAD//////wAAB//////gAAA//////AAAAf////+AAAAP////8AAAAH////4AAAAD////wAAAAB////gAAAAA////AAAAAAf//+AAAAAAP//8AAAAAAH//4AAAAAAD//wAAAAAAB//gAAAAAAA//AAAAAAAAf+AAAAAAAAP8AAAAAAAAH4AAAAAAAADwAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAH4AAAAAAAAf+AAAAAAAA//AAAAAAAA//AAAAAAAB//gAAAAAAB//gAAAAAAB//gAAAAD/D//w/wAAH/n//5/4AAP//////8AAf//////+AAf//////+AAf/8//P/+AAf/8P+P/+AAf/8H4P/+AAf/4AAH/+AAf/4AAH/+AAf/4AAH/+AAP/wAAD/8AAH/gAAB/4AAH/AAAA/4AAP4AAAAH8AAfAAAAAA+AD/AAAAAA/wP/gAAAAB/8f/wAAAAB/+f/wAAAAD/+//4AAAAH////4AAAAH////4AAAAH////4AAAAH////4AAAAH////4AAAAH//f/wAAAAD/+f/gAAAAB/+P/gAAAAB/8D/AAAAAA/wAfAAAAAA+AAP4AAAAH8AAH/AAAA/4AAH/gAAB/4AAP/wAAD/8AAf/4AAH/+AAf/4AAH/+AAf/4AAH/+AAf/8H4P/+AAf/8f8P/+AAf/8//P/+AAf//////+AAf//////8AAP//////8AAH/n//5/4AAD/D//w/gAAAAB//gAAAAAAB//gAAAAAAB//gAAAAAAA//AAAAAAAA//AAAAAAAAP8AAAAAAAAH4AAAA",
    "AAAAAAAAAAAAAABgAAAAAAAAP8AAAAAAAAf+AAAAAAAA//AAAAAAAB//gAAAAAAB//gAAAAAAD//wAAAAAAD//wAAAAAAD//wAAAAAAH//4AAAAAAH//4AAAAAAH//4AAAAAAH//4AAAAAAH//4AAAAAAH//4AAAAAAH//4AAAAf8H//4P+AB//v/////gD////////wH////////4P////////8P////////8f////////+f////////+f////////+P////////8P////////8P////////8H////////4D////////wD////////wB////////gAf//////+AAP//////8AAD//////wAAAf////+AAAAH////4AAAAP////8AAAAf////+AAAAf////+AAAA//////AAAB//////gAAB//////gAAB//////gAAD//////wAAD//////wAAD//////wAAD//////wAAD//+f//wAAD//+f//wAAD//8P//wAAD//4H//wAAD//wD//wAAD//gB//wAAB//AA//gAAA/+AAf/AAAAf4AAH+AAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAPgAAAAD8AB/gAAAAH/gD/wAAAAH/wP/4AAAAP/8P/4AAAAP/+P/8AAAAf//H/8AAAAf//j/8AAAAf//j/8AAAA///x/+AAAA///x/+AAAA///5/+AAAAD//5/+AAAAAf/5/+AAAAAH/9/+AAAP/h/8/8OAA//4/8H8fgD//wH8A8fwH//gB4AYf8P//AAwAI/+f/+AAAAA////+AAAAB////8AAAAD////8AAAAD//f/8AAAAD/+f/8AAAAD/+P/gAAAAD/8P+AAAAAD/8H8OAAAAH/4DweAAAAH/wBh+AAAAH/gAD/AAAAP/AAH/gAAAf+AAH/gAAAf4AAP/wAAA/gAAf/wAAAAAAAf/wAAAAPAA//mAAP//AA//nAAf//AA//HgA///gA//P4D///gB//P8H///gB//P/H///gB/+P/H///gB/+P/j///gA/+P/x///gA/+P/wf//gA//P/4P//AAf/P/8D/8AAD+H/+AHAAAAAH//gAAAAAAH//wAAAAAAD//wAAAAAAB//wAAAAAAB//gAAAAAAA//AAAAAAAAf+AAAAAAAAP8AAAAAAAAH4AAAAAAAABgAAAA",
    "AAAA//AAAAAAAH//4AAAAAA////AAAAAD////wAAAAP////8AAAAf////+AAAB//////gAAD//////wAAH//////4AAP//////8AAf//////+AA////////AA///wD///AB//+AAf//gD//4AAH//wD//gAAB//wH//AAAA//4H/+AAAAf/4P/8AAAAP/8P/4AAAAH/8P/4AAAAH/8f/wAAAAD/+f/wAAAAD/+f/gAAAAB/+//gAAAAB////gAAAAB////AAAAAA////AAAAAA////AAAAAA////AAAAAA////AAAAAA////AAAAAA////AAAAAA////AAAAAA////gAAAAB////gAAAAB//f/gAAAAB/+f/wAAAAD/+f/wAAAAD/+P/4AAAAH/8P/4AAAAH/8P/8AAAAP/8H/+AAAAf/4H//AAAA//4D//gAAB//wD//4AAH//wB//+AAf//gA///wD///AA////////AAf//////+AAP//////8AAH//////4AAD//////wAAB//////gAAAf////+AAAAP////8AAAAD////wAAAAA////AAAAAAH//4AAAAAAA//AAAA",
    "AAAAAAAAAAAAAAAAAAAAAAwAAAAEAAAB+AAAB+AAAD/gAAH/AAAD/4DAf/AAAD/8Hg//AAAD/+Px//AAAD/8f4//AAAD/8f8//AAAD/4/8f/AAAB/5/+f+AAAB/x/+P+AAAB/x/+P+AAAB/j//H+AAAAAB//AAAAAAAA//AAAAAAP4P/HwAAAD/+H/P/AAAH//D+P/gAAP//h+P/wAAP//wOf/wAAP//gAf/wAAH//AA//gAAH/+AA//gAAD/+AB//AAAB/wAA/+AAAY/gAA/8IAA8eAAB/48AB+MOAB/h+AD/AeAB/D/AH/g/AAAH/gP/x/gAAP/wf/z/gf+P/4//j/j//H/4//j/z//H/8//n/z//n/8f/n/z//n/4P/n/x//j/wA/H/5//j8AAAH/4//gAAAAH/4f/gAAAAH/wP/gAAAAH/AD/gAAAAH8Hg/gAAAADgf4HAAAAAAB/+AAAAAAAD//AAAAAAAD//AAAAAAAB/+AAAAAAAB/+AAAAAAAA/8AAAAAAAA/8AAAAAAAAf4AAAAAAAAf4AAAAAAAAPwAAAAAAAAHgAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAH4AAAAAAAAf+AAAAAAAA//AAAAAAAA//AAAAAAAB//gAAAAAAB//gAAAAAAB//gAAAAB+D//w/gAAH/j//x/wAAP//////4AAP//////8AAf//////+AAf//////+AAf//////+AAf//////+AAf//////+AAf//////+AAf//wD//8AAP/+AAf/8AAH/8AAP/4AAH/4AAH/4AAH/wAAD/4AAf/gAAB/+AD//AAAA//wP//AAAA//8f//AAAA//+f/+AAAAf/+//+AAAAf////+AAAAf////+AAAAf////+AAAAf////+AAAAf////+AAAAf//f/+AAAAf/+f//AAAA//+P//AAAA//8D//AAAA//wAf/gAAB/+AAH/wAAD/4AAH/4AAH/4AAH/8AAP/4AAP/+AAf/8AAf//wD//+AAf//////+AAf//////+AAf//////+AAf//////+AAf//////+AAf//////+AAP//////8AAP//////8AAH/j//x/4AAB/B//wfgAAAAB//wAAAAAAB//gAAAAAAB//gAAAAAAA//gAAAAAAAf/AAAAAAAAP+AAAAAAAAH4AAAA",
    "AAB////gAAAAD////wAAAAH////4AAAAP////8AAAAf////+AAAA//////AAAB//////gAAD//////wAAH//////4AAP//////8AAf//////+AA////////AB////////gD////////wH////////4P////////8f////////+////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////f////////+P////////8H////////4D////////wB////////gA////////AAf//////+AAP//////8AAH//////4AAD//////wAAB//////gAAA//////AAAAf////+AAAAP////8AAAAH////4AAAAD////wAAAAB////gAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAD//4AAAAAAf//+AAAAAB////gAAAAD////4AAAAP////8AAAAf/////AAAA//////gAAB//////wAAD//////4AAH//////4AAP//////8AAP//////+AAf///////AA////////AA////////gB////////gB////////gB////////wD////////wD////////wD////////4D////////4H////////4H////////4H////////4H////////4H////////4H////////4H////////4H////////4D////////4D////////4D////////4D////////wB////////wB////////wB////////gA////////gA////////AAf///////AAf//////+AAP//////+AAH//////8AAH//////4AAD//////wAAB//////gAAA//////AAAAP////+AAAAH////8AAAAD////wAAAAA////AAAAAAH//8AAAAAAA//gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
];
const SHAPE_SIZE = 60;
const MASTER_PALETTE = ["#fde98e", "#60c1ff", "#fcb08e", "#fb88ff", "#b4fed4", "#cbfaa9", "#78d6f8"];
const THUMB_PALETTE = ["#1f55c4", "#780592", "#2f6b00", "#910000", "#864401", "#675901", "#016e5c"];
const GRID = 40;
const SIZES = Array.from({ length: 19 }, (_, i) => i + 18);
const ANGLES = Array.from({ length: 120 }, (_, i) => i * 3).filter((a) => (a >= 15 && a <= 75) || (a >= 285 && a <= 345));
const CONFIDENT_MARGIN = 2.2;
const CHALLENGES_PER_ROUND = 5;
const ROUNDS = 3;
const TURNSTILE_SCRIPT = "challenges.cloudflare.com/turnstile";

type RGB = [number, number, number];
type Mask = Uint8Array;

const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const masterPalette = MASTER_PALETTE.map(rgb);
const thumbPalette = THUMB_PALETTE.map(rgb);

const dilate = (mask: Mask, w: number, h: number, r: number): Mask => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!mask[y * w + x]) continue;
            for (let dy = -r; dy <= r; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -r; dx <= r; dx++) {
                    const nx = x + dx;
                    if (nx >= 0 && nx < w) out[ny * w + nx] = 1;
                }
            }
        }
    }
    return out;
};

const invert = (mask: Mask): Mask => mask.map((v) => 1 - v);
const erode = (mask: Mask, w: number, h: number, r: number): Mask => invert(dilate(invert(mask), w, h, r));

const neighbours = (mask: Mask, w: number, h: number): Mask => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dy && !dx) continue;
                    const ny = y + dy, nx = x + dx;
                    if (ny >= 0 && ny < h && nx >= 0 && nx < w) n += mask[ny * w + nx]!;
                }
            }
            out[y * w + x] = n;
        }
    }
    return out;
};

// 4-connected components as lists of pixel indices
const components = (mask: Mask, w: number, h: number): number[][] => {
    const seen = new Uint8Array(w * h);
    const out: number[][] = [];
    for (let start = 0; start < w * h; start++) {
        if (!mask[start] || seen[start]) continue;
        const stack = [start];
        const pixels: number[] = [];
        seen[start] = 1;
        while (stack.length) {
            const p = stack.pop()!;
            pixels.push(p);
            const x = p % w, y = (p - x) / w;
            for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as [number, number][]) {
                if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                const q = ny * w + nx;
                if (mask[q] && !seen[q]) {
                    seen[q] = 1;
                    stack.push(q);
                }
            }
        }
        out.push(pixels);
    }
    return out;
};

const bounds = (pixels: number[], w: number) => {
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, sumX = 0, sumY = 0;
    for (const p of pixels) {
        const x = p % w, y = (p - x) / w;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        sumX += x; sumY += y;
    }
    return { minX, maxX, minY, maxY, cx: sumX / pixels.length, cy: sumY / pixels.length };
};

// Area-normalised, centroid-centred GRID x GRID mask, sampled back from the source pixels
const normalise = (pixels: number[], w: number): Mask => {
    const b = bounds(pixels, w);
    const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
    const src = new Uint8Array(bw * bh);
    for (const p of pixels) {
        const x = p % w, y = (p - x) / w;
        src[(y - b.minY) * bw + (x - b.minX)] = 1;
    }
    const scale = Math.sqrt(pixels.length) / (GRID * 0.42);
    const out = new Uint8Array(GRID * GRID);
    for (let gy = 0; gy < GRID; gy++) {
        const sy = Math.floor((gy - GRID / 2 + 0.5) * scale + b.cy - b.minY + 0.5);
        if (sy < 0 || sy >= bh) continue;
        for (let gx = 0; gx < GRID; gx++) {
            const sx = Math.floor((gx - GRID / 2 + 0.5) * scale + b.cx - b.minX + 0.5);
            if (sx >= 0 && sx < bw) out[gy * GRID + gx] = src[sy * bw + sx]!;
        }
    }
    return out;
};

let shapeBitsCache: Mask[] | null = null;
const shapeBits = (): Mask[] => shapeBitsCache ?? (shapeBitsCache = SHAPES.map((encoded) => {
    const bytes = base64ToBytes(encoded);
    const bits = new Uint8Array(SHAPE_SIZE * SHAPE_SIZE);
    for (let i = 0; i < bits.length; i++) bits[i] = (bytes[i >> 3]! >> (7 - (i & 7))) & 1;
    return bits;
}));

// Shape scaled to (size+10)^2 like go-captcha draws it, by averaging 4x4 samples per pixel
const resized = new Map<string, { side: number; mask: Mask; area: number }>();
const resize = (shape: number, size: number) => {
    const key = `${shape}/${size}`;
    if (!resized.has(key)) {
        const s = size + 10, f = SHAPE_SIZE / s, bits = shapeBits()[shape]!;
        const out = new Uint8Array(s * s);
        let area = 0;
        for (let y = 0; y < s; y++) {
            for (let x = 0; x < s; x++) {
                let sum = 0;
                for (let i = 0; i < 4; i++) {
                    for (let j = 0; j < 4; j++) {
                        sum += bits[Math.floor((y + (i + 0.5) / 4) * f) * SHAPE_SIZE + Math.floor((x + (j + 0.5) / 4) * f)]!;
                    }
                }
                if (sum > 8) { out[y * s + x] = 1; area++; }
            }
        }
        resized.set(key, { side: s, mask: out, area });
    }
    return resized.get(key)!;
};

const templates = new Map<string, Mask[]>();
const template = (shape: number, size: number, thumb: boolean): Mask[] => {
    const key = `${shape}/${size}/${thumb}`;
    if (!templates.has(key)) {
        const { side, mask } = resize(shape, size);
        const pad = 3, out = side + 2 * pad + Math.ceil(side * 0.5);
        const c = (side - 1) / 2, oc = (out - 1) / 2;
        const rotations = ANGLES.map((angle) => {
            const rad = (angle * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
            let rotated = new Uint8Array(out * out);
            for (let y = 0; y < out; y++) {
                for (let x = 0; x < out; x++) {
                    const dx = x - oc, dy = y - oc;
                    const sx = Math.round(cos * dx - sin * dy + c), sy = Math.round(sin * dx + cos * dy + c);
                    if (sx >= 0 && sx < side && sy >= 0 && sy < side) rotated[y * out + x] = mask[sy * side + sx]!;
                }
            }
            if (thumb) rotated = thumbClean(rotated, out, out);
            const pixels: number[] = [];
            rotated.forEach((v, i) => { if (v) pixels.push(i); });
            return normalise(pixels, out);
        });
        templates.set(key, rotations);
    }
    return templates.get(key)!;
};

// Strip shapes: bridge the noise lines drawn across them, then drop line/mark pixels
const thumbClean = (mask: Mask, w: number, h: number): Mask => {
    const closed = erode(dilate(mask, w, h, 1), w, h, 1).map((v, i) => v | mask[i]!);
    const n = neighbours(closed, w, h);
    return closed.map((v, i) => (v && n[i]! >= 4 ? 1 : 0));
};

interface Blob { area: number; mask: Mask }

const scores = (blob: Blob, thumb: boolean): number[] => SHAPES.map((_, shape) => {
    const size = SIZES.reduce((a, b) => (Math.abs(resize(shape, b).area - blob.area) < Math.abs(resize(shape, a).area - blob.area) ? b : a));
    let best = 0;
    for (const t of template(shape, size, thumb)) {
        let inter = 0, union = 0;
        for (let i = 0; i < t.length; i++) {
            inter += t[i]! & blob.mask[i]!;
            union += t[i]! | blob.mask[i]!;
        }
        best = Math.max(best, inter / union);
    }
    return best;
});

const nearestColour = (data: Uint8Array, palette: RGB[]) => {
    const n = data.length / 4;
    const nearest = new Uint8Array(n), distance = new Float32Array(n);
    for (let p = 0; p < n; p++) {
        let best = 0, bestD = Infinity;
        for (let k = 0; k < palette.length; k++) {
            const dr = data[p * 4]! - palette[k]![0], dg = data[p * 4 + 1]! - palette[k]![1], db = data[p * 4 + 2]! - palette[k]![2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bestD) { bestD = d; best = k; }
        }
        nearest[p] = best;
        distance[p] = Math.sqrt(bestD);
    }
    return { nearest, distance };
};

// Picture shapes: flat palette-coloured blobs of shape size with a dark shadow beside them
const masterBlobs = ({ width: w, height: h, data }: Pixels): (Blob & { x: number; y: number })[] => {
    const { nearest, distance } = nearestColour(data, masterPalette);
    const dark = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) dark[p] = data[p * 4]! + data[p * 4 + 1]! + data[p * 4 + 2]! < 150 ? 1 : 0;
    const blobs: (Blob & { x: number; y: number })[] = [];
    const tooBig = (pixels: number[]) => {
        const b = bounds(pixels, w);
        return pixels.length > 1400 || b.maxY - b.minY >= 60 || b.maxX - b.minX >= 60;
    };
    // Petals of one shape don't touch: join pieces within `group` px, splitting too-big groups finer
    const pieces = (pixels: number[], group: number, found: number[][]): number[][] => {
        const sub = new Uint8Array(w * h);
        for (const p of pixels) sub[p] = 1;
        for (const joined of components(group ? dilate(sub, w, h, group) : sub, w, h)) {
            const own = joined.filter((p) => sub[p]);
            if (!own.length) continue;
            if (group && tooBig(own)) pieces(own, group - 1, found);
            else found.push(own);
        }
        return found;
    };
    for (let k = 0; k < masterPalette.length; k++) {
        const pixels: number[] = [];
        for (let p = 0; p < w * h; p++) if (nearest[p] === k && distance[p]! < 40) pixels.push(p);
        for (const blob of pieces(pixels, 2, [])) {
            const b = bounds(blob, w);
            const bh = b.maxY - b.minY + 1, bw = b.maxX - b.minX + 1;
            if (blob.length < 120 || blob.length > 1400 || bh < 14 || bh > 60 || bw < 14 || bw > 60) continue;
            const own = new Uint8Array(w * h);
            for (const p of blob) own[p] = 1;
            const ring = dilate(own, w, h, 2);
            let shadow = 0;
            for (let p = 0; p < w * h; p++) if (ring[p] && !own[p] && dark[p]) shadow++;
            const meanDistance = blob.reduce((s, p) => s + distance[p]!, 0) / blob.length;
            if (shadow < 3 || meanDistance > 20) continue;
            blobs.push({ x: Math.round(b.cx), y: Math.round(b.cy), area: blob.length, mask: normalise(blob, w) });
        }
    }
    return blobs;
};

// Strip shapes, left to right: the largest single-colour blobs once the noise is cleaned off
const thumbBlobs = ({ width: w, height: h, data }: Pixels, count: number): Blob[] => {
    const { nearest, distance } = nearestColour(data, thumbPalette);
    const found: number[][] = [];
    for (let k = 0; k < thumbPalette.length; k++) {
        const mask = new Uint8Array(w * h);
        for (let p = 0; p < w * h; p++) mask[p] = data[p * 4 + 3]! > 128 && distance[p]! < 60 && nearest[p] === k ? 1 : 0;
        found.push(...components(thumbClean(mask, w, h), w, h));
    }
    found.sort((a, b) => b.length - a.length);
    return found.slice(0, count)
        .sort((a, b) => bounds(a, w).cx - bounds(b, w).cx)
        .map((pixels) => {
            const own = new Uint8Array(w * h);
            for (const p of pixels) own[p] = 1;
            const opened = dilate(erode(own, w, h, 1), w, h, 1);
            const kept = pixels.filter((p) => opened[p]);
            const shape = kept.length >= 0.6 * pixels.length ? kept : pixels;
            return { area: shape.length, mask: normalise(shape, w) };
        });
};

const softmax = (values: number[]): number[] => {
    const max = Math.max(...values);
    const e = values.map((v) => Math.exp((v - max) / 0.01));
    const sum = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / sum);
};

export interface Challenge {
    captcha_id: string;
    image_base64: string;
    thumb_base64: string;
    thumb_size?: number;
    count?: number;
}

export interface Plan {
    margin: number;
    answer?: { angle: number } | { dots: string };
}

// Rotate captcha: clockwise angle that lines the piece up with the picture's centre
export const planRotate = (challenge: Challenge): Plan => {
    const reference = decodeDataUrl(challenge.image_base64), piece = decodeDataUrl(challenge.thumb_base64);
    const size = piece.width, offset = Math.floor((reference.width - size) / 2);
    const rotated = piece.data;
    const gray = (data: Uint8Array, i: number) => (data[i * 4]! + data[i * 4 + 1]! + data[i * 4 + 2]!) / 3;
    const center = (size - 1) / 2, scale = size / 128;
    let bestAngle = 0, bestScore = Infinity;
    for (let degrees = 0; degrees < 360; degrees++) {
        const rad = (degrees * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        let sum = 0, valid = 0;
        for (let i = 0; i < 128 * 128; i++) {
            const gx = (i % 128) * scale, gy = Math.floor(i / 128) * scale;
            const vx = gx - center, vy = gy - center;
            const x = center + vx * cos + vy * sin, y = center - vx * sin + vy * cos;
            if (x < 0 || x >= size || y < 0 || y >= size) continue;
            const index = Math.floor(y) * size + Math.floor(x);
            if (rotated[index * 4 + 3]! <= 128) continue;
            const diff = gray(reference.data, (offset + Math.floor(gy)) * reference.width + offset + Math.floor(gx)) - gray(rotated, index);
            sum += diff * diff;
            valid++;
        }
        if (valid >= 100 && sum / valid < bestScore) {
            bestScore = sum / valid;
            bestAngle = degrees;
        }
    }
    return { margin: Infinity, answer: { angle: bestAngle } };
};

// Click captcha: picture blob for each strip shape, and how far the best pairing beats the runner-up
export const planClick = (challenge: Challenge): Plan => {
    const count = challenge.count ?? 0;
    const masters = masterBlobs(decodeDataUrl(challenge.image_base64));
    const thumbs = thumbBlobs(decodeDataUrl(challenge.thumb_base64), count);
    if (thumbs.length < count || masters.length < thumbs.length) return { margin: -Infinity };
    const mp = masters.map((m) => softmax(scores(m, false)));
    const tp = thumbs.map((t) => softmax(scores(t, true)));
    const similarity = tp.map((t) => mp.map((m) => Math.log(t.reduce((s, v, i) => s + v * m[i]!, 0) + 1e-12)));
    let best: { total: number; picks?: number[] } = { total: -Infinity }, second = -Infinity;
    const search = (i: number, used: number, total: number, picks: number[]) => {
        if (i === thumbs.length) {
            if (total > best.total) { second = best.total; best = { total, picks: [...picks] }; } else if (total > second) second = total;
            return;
        }
        for (let j = 0; j < masters.length; j++) {
            if (used & (1 << j)) continue;
            picks.push(j);
            search(i + 1, used | (1 << j), total + similarity[i]![j]!, picks);
            picks.pop();
        }
    };
    search(0, 0, 0, []);
    return {
        margin: (best.total - second) / thumbs.length,
        answer: { dots: best.picks!.flatMap((j) => [masters[j]!.x, masters[j]!.y]).join(",") },
    };
};

// ---------------------------------------------------------------------------
// Talking to the WAF

export class WafSolveError extends Error {}

const json = (response: Response): any => {
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP error ${response.status}`);
    return JSON.parse(response.data ?? "null");
};

const get = (requestManager: RequestManager, path: string, headers: Record<string, string> = {}): Promise<Response> =>
    requestManager.schedule(App.createRequest({ url: `${DOMAIN}${path}`, method: "GET", headers }), 1);

// Up to CHALLENGES_PER_ROUND challenges; answers the first confident one, else the most confident
const round = async (requestManager: RequestManager): Promise<boolean> => {
    let best: (Plan & { challenge: Challenge }) | null = null;
    for (let i = 0; i < CHALLENGES_PER_ROUND; i++) {
        const challenge = json(await get(requestManager, "/@waf/generate", { Accept: "application/json" })) as Challenge;
        if (!challenge?.image_base64 || !challenge.thumb_base64) throw new WafSolveError("The site changed its captcha");
        let plan: (c: Challenge) => Plan;
        if ((challenge.count ?? 0) > 0) plan = planClick;
        else if ((challenge.thumb_size ?? 0) > 0) plan = planRotate;
        else throw new WafSolveError("The site changed its captcha");
        const attempt = { challenge, ...plan(challenge) };
        if (!best || attempt.margin > best.margin) best = attempt;
        if (best.margin >= CONFIDENT_MARGIN) break;
    }
    if (!best?.answer) return false;
    const request: Request = App.createRequest({
        url: `${DOMAIN}/@waf/verify`,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        data: JSON.stringify({ captcha_id: best.challenge.captcha_id, ...best.answer }),
    });
    const response = await requestManager.schedule(request, 1);
    const ok = json(response)?.success === true;
    if (ok) storeWafPass(requestManager, response);
    return ok;
};

// Paperback may or may not persist Set-Cookie from source requests; make sure the
// fresh waf_pass ends up in the source's cookie store either way.
function storeWafPass(requestManager: RequestManager, response: Response): void {
    try {
        const headers = response.headers ?? {};
        const raw = Object.keys(headers)
            .filter((k) => k.toLowerCase() === "set-cookie")
            .map((k) => String(headers[k]))
            .join(", ");
        const match = /(?:^|[,;\s])waf_pass=([^;,\s]+)/.exec(raw);
        if (!match) return;
        const value = match[1]!;
        const fromValue = /^(\d{10})\./.exec(value);
        const store = requestManager.cookieStore;
        if (!store) return;
        for (const c of store.getAllCookies()) {
            if (c.name === "waf_pass" && c.domain.replace(/^\./, "").endsWith("comix.to") && c.value !== value) store.removeCookie(c);
        }
        if (store.getAllCookies().some((c) => c.name === "waf_pass" && c.value === value)) return;
        store.addCookie(App.createCookie({
            name: "waf_pass",
            value,
            domain: "comix.to",
            path: "/",
            expires: fromValue ? new Date(Number(fromValue[1]) * 1000) : new Date(Date.now() + 5 * 60 * 1000),
        }));
    } catch {
        // best effort — the native layer may have stored it already
    }
}

/**
 * Pass comix's security check from inside the source. Resolves when a fresh
 * waf_pass has been issued; throws a WafSolveError with a user-facing reason
 * otherwise. Must not be called through scheduleComix (it's used from within it).
 */
export async function solveWafCaptcha(requestManager: RequestManager, challengePath = "/@waf/challenge"): Promise<void> {
    try {
        const page = await get(requestManager, challengePath.startsWith("/") ? challengePath : "/@waf/challenge");
        if (page.status >= 400 && page.status !== 403) throw new Error(`HTTP error ${page.status}`);
        if ((page.data ?? "").includes(TURNSTILE_SCRIPT)) {
            throw new WafSolveError("comix is showing a Cloudflare Turnstile check, which can't be solved automatically. Tap the cloud / globe button to pass it in the web view");
        }
        for (let i = 0; i < ROUNDS; i++) {
            if (await round(requestManager)) return;
        }
        throw new WafSolveError("Couldn't solve the site's captcha. Tap the cloud / globe button to solve it in the web view");
    } catch (error: any) {
        if (error instanceof WafSolveError) throw error;
        throw new WafSolveError(`Couldn't solve the site's captcha (${error?.message ?? String(error)}). Tap the cloud / globe button to solve it in the web view`);
    }
}
