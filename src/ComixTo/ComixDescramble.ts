// Comix.to image byte-decryption.
//
// Newer uploads serve select page images byte-encrypted by the CDN. The response
// carries:
//   X-Enc-Seed: <uint32, decimal>   e.g. "1350642857"  (0 = image is clean)
//   X-Enc-Len:  <decimal>           e.g. "4096"         (bytes encrypted from start)
//
// Only the first `X-Enc-Len` bytes are transformed; the rest of the file is
// untouched. The transform is a simple XOR keystream from a 32-bit LCG keyed by
// the seed (output = the high byte of each LCG state):
//
//   x = seed >>> 0
//   for i in 0 .. min(len, length)-1:
//     x = (x * 1000005 + 0x499602D3) mod 2^32
//     data[i] ^= (x >>> 24) & 0xFF
//
// Because we only XOR bytes in place, the result is the original valid WebP — no
// canvas, no re-encode (so the platform's WebP processor decodes it normally).
//
// Reversed byte-exact from secure-*.js (bundle tg96hg, 2026-06): the page-cipher
// is VM bytecode whose per-byte keystream is this LCG. Verified against the live
// bundle across many seeds (4096 bytes each) and real chapter pages.

import { decryptComixImageAlgo2 } from "./ComixAlgo2";

const LCG_MUL = 1000005; // 0x000F4245
const LCG_INC = 0x499602d3;

export interface EncParams {
  seed: number;
  len: number;
  // Which keystream the CDN used. 1 (or absent header) = the LCG below; 2 = the
  // degree-32 GF(2) word-LFSR in ComixAlgo2.ts. comix mixes both across a chapter.
  algo: number;
}

// Pull the encryption params from a response's headers (case-insensitive).
// Returns null when the image is clean (no seed, or seed === 0) or the headers
// are malformed — in which case the response should be passed through untouched.
export function readEncHeaders(
  headers: Record<string, string | undefined> | undefined,
): EncParams | null {
  if (!headers) return null;
  let seedStr: string | undefined;
  let lenStr: string | undefined;
  let algoStr: string | undefined;
  for (const key of Object.keys(headers)) {
    const v = headers[key];
    if (typeof v !== "string") continue;
    const lk = key.toLowerCase();
    if (lk === "x-enc-seed") seedStr = v;
    else if (lk === "x-enc-len") lenStr = v;
    else if (lk === "x-enc-algo") algoStr = v;
  }
  if (!seedStr || !lenStr) return null;
  const seed = parseInt(seedStr, 10);
  const len = parseInt(lenStr, 10);
  if (!Number.isFinite(seed) || seed <= 0) return null; // 0/invalid → clean
  if (!Number.isFinite(len) || len <= 0) return null;
  const algo = algoStr ? parseInt(algoStr, 10) : 1; // absent header = original algo 1
  return { seed: seed >>> 0, len, algo: Number.isFinite(algo) ? algo : 1 };
}

// Decrypt the encrypted prefix in place, dispatching on the CDN's algorithm.
// Returns false when the algo is unknown (caller should pass the image through
// untouched rather than corrupt it).
export function decryptComixImageByParams(bytes: Uint8Array, params: EncParams): boolean {
  if (params.algo === 2) {
    decryptComixImageAlgo2(bytes, params.seed, params.len);
    return true;
  }
  if (params.algo === 1) {
    decryptComixImage(bytes, params.seed, params.len);
    return true;
  }
  return false; // unknown algo → don't touch the bytes
}

// XOR-decrypt the first `len` bytes of `bytes` in place using the seed's LCG
// keystream. Bytes beyond `len` are left unchanged.
export function decryptComixImage(bytes: Uint8Array, seed: number, len: number): void {
  let x = seed >>> 0;
  const n = Math.min(len, bytes.length);
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, LCG_MUL) + LCG_INC) >>> 0;
    bytes[i] = (bytes[i]! ^ ((x >>> 24) & 0xff)) & 0xff;
  }
}
