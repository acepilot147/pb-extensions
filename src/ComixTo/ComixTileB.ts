// Comix.to tile-scramble Variant B (x-scramble-algo: 3) — reversed 2026-06.
//
// Page images for protected pages (pages.items[].s===1, ~every 4th page) are
// served as a 5x5 tile shuffle. The descramble permutation is a backward
// Fisher-Yates driven by a PRNG keyed by the uint32 x-scramble-seed:
//
//   eff = seed >>> 1                      // the scrambler ignores seed bit 0
//   a   = [0..24]
//   for C = 24 down to 1 (draw k = 24-C):
//     r_k = AFFINE_k(eff)                 // each draw is GF(2)-affine in eff
//     j   = r_k % (C + 1)
//     swap(a[C], a[j])
//   scramblePerm = a  (scrambled[i] = clean[a[i]])
//   descrambleLookup = inverse(a)         (clean[i] = scrambled[lookup[i]])
//
// Each draw r_k (k=0..23) is a GF(2)-affine function of the 31-bit eff:
//   r_k = BASE[k] XOR ( XOR over eff bits i set of COLS[k][i] )
// Reversed by querying the live bundle's descrambler (Qa) for chosen seeds and
// grid sizes, CRT-reconstructing each 32-bit draw across coprime tile counts,
// then solving the per-eff-bit GF(2) basis. Verified byte-exact against the
// live reader on 72 arbitrary seeds, 9 real chapters, and 2 DevTools-screenshot
// ground-truth pages.
//
// NOTE: this is the algo-3 scheme. The older algo-2 tile shuffle used a
// xorshift32 Fisher-Yates (see ComixDescramble.computeDescrambleLookup).

const PACKED =
  "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";

const TILES = 25;
const DRAWS = 24; // C = 24..1
const NBITS = 31; // eff = seed>>>1 is 31 bits

// JavaScriptCore-safe base64 decode (no atob / Buffer on device — mirrors
// ComixAlgo2 / ComixFastDecrypt). Runs at module load, so it must not throw.
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function unpackWords(s: string): Uint32Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lookup[B64_CHARS.charCodeAt(i)] = i;
  const bytes: number[] = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break; // '='
    const v = c < 128 ? lookup[c]! : -1;
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff); }
  }
  const out = new Uint32Array(bytes.length >> 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)) >>> 0;
  }
  return out;
}

// TABLE layout: BASE[24] then COLS[24*31] (COLS at index DRAWS + k*NBITS + i),
// little-endian uint32. Length 24 + 24*31 = 768.
const TABLE = unpackWords(PACKED);

// The k-th Fisher-Yates draw for effective seed `eff` (= seed >>> 1).
function draw(eff: number, k: number): number {
  let v = TABLE[k]!;
  const base = DRAWS + k * NBITS;
  for (let i = 0; i < NBITS; i++) {
    if ((eff >>> i) & 1) v ^= TABLE[base + i]!;
  }
  return v >>> 0;
}

// For each clean tile position, the scrambled tile index to copy from:
// clean[i] = scrambled[descrambleLookup[i]]. Only valid for the 5x5 grid.
export function computeDescrambleLookupB(seed: number): number[] {
  const eff = (seed >>> 1) >>> 0;
  const a = new Array<number>(TILES);
  for (let i = 0; i < TILES; i++) a[i] = i;
  for (let k = 0; k < DRAWS; k++) {
    const c = 24 - k;
    const j = draw(eff, k) % (c + 1);
    const t = a[c]!;
    a[c] = a[j]!;
    a[j] = t;
  }
  // a is the scramble permutation; descramble lookup is its inverse.
  const inv = new Array<number>(TILES);
  for (let i = 0; i < TILES; i++) inv[a[i]!] = i;
  return inv;
}
