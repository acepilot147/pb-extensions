// Comix.to image byte-encryption — algo 2 (responses carrying "X-Enc-Algo: 2").
//
// Like algo 1 ([[ComixDescramble.decryptComixImage]]) this is a pure, data-independent
// XOR keystream over the first X-Enc-Len bytes, keyed only by the uint32 X-Enc-Seed.
// But the keystream generator is different: reversed byte-exact from the live bundle
// (secure-5328a883bf2f, 2026-06-13) it is GF(2)-linear in the 32 seed bits — a
// degree-32 word LFSR over little-endian uint32 words:
//
//   word[n>=32] = XOR over j in TAPS of word[n-32+j]            (TAPS bitmask = 0x3ec241)
//   word[n<32]  = INIT[n] XOR ( XOR over set seed bits i of BASIS[i][n] )
//   keystream   = words little-endian; XOR onto the image bytes in place.
//
// INIT (32 words) and BASIS (32 seed-bits x 32 words) are universal constants of the
// cipher (KS(0) and KS(2^i)^KS(0)); they only change if comix changes algo-2 itself.
// Re-derive with experiment/_scratch (oracle -> GF(2)-linearity -> Berlekamp-Massey).
// Verified byte-exact vs the live bundle on 17 seeds (captured + random incl. 0/1/0xffffffff).

const TAPS = 0x3ec241;

// 32 INIT words followed by 32*32 BASIS words (BASIS[i*32 + n]), little-endian uint32.
const PACKED = "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";

function unpack(): Uint32Array {
  const bin = typeof atob === "function" ? atob(PACKED) : Buffer.from(PACKED, "base64").toString("binary");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
  const out = new Uint32Array(bytes.length >> 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)) >>> 0;
  }
  return out;
}

const TABLE = unpack();           // length 1056
const INIT = TABLE.subarray(0, 32);
// BASIS[i][n] = TABLE[32 + i*32 + n]

// Produce the first `len` keystream bytes for `seed`.
export function algo2Keystream(seed: number, len: number): Uint8Array {
  const nwords = (len + 3) >> 2;
  const w = new Uint32Array(Math.max(nwords, 32));
  for (let n = 0; n < 32; n++) {
    let x = INIT[n]!;
    let s = seed >>> 0;
    let i = 0;
    while (s) { if (s & 1) x ^= TABLE[32 + i * 32 + n]!; s >>>= 1; i++; }
    w[n] = x >>> 0;
  }
  for (let n = 32; n < nwords; n++) {
    let x = 0;
    for (let j = 0; j < 32; j++) if ((TAPS >>> j) & 1) x ^= w[n - 32 + j]!;
    w[n] = x >>> 0;
  }
  const out = new Uint8Array(len);
  for (let n = 0; n < nwords; n++) {
    const v = w[n]!;
    const o = n * 4;
    if (o < len) out[o] = v & 0xff;
    if (o + 1 < len) out[o + 1] = (v >>> 8) & 0xff;
    if (o + 2 < len) out[o + 2] = (v >>> 16) & 0xff;
    if (o + 3 < len) out[o + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

// XOR-decrypt the first `len` bytes of `bytes` in place with the algo-2 keystream.
export function decryptComixImageAlgo2(bytes: Uint8Array, seed: number, len: number): void {
  const n = Math.min(len, bytes.length);
  const ks = algo2Keystream(seed, n);
  for (let i = 0; i < n; i++) bytes[i] = (bytes[i]! ^ ks[i]!) & 0xff;
}
