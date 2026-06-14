// Comix.to tile-scramble Variant B (x-scramble-algo: 3) — reversed 2026-06.
//
// Page images for protected pages (pages.items[].s===1, ~every 4th page) are
// served as a 5x5 tile shuffle. The descramble permutation is a backward
// Fisher-Yates driven by a plain xorshift32 (13/17/5) PRNG, seeded with the
// uint32 x-scramble-seed forced odd (state = seed | 1):
//
//   state = (seed | 1) >>> 0            // bit 0 forced set (so seed & seed^1 collide)
//   a     = [0..24]
//   for i = 24 down to 1:
//     state ^= state << 13; state >>>= 0
//     state ^= state >>> 17
//     state ^= state << 5;  state >>>= 0
//     j = state % (i + 1); swap(a[i], a[j])
//   scramblePerm = a  (scrambled[i] = clean[a[i]])
//   descrambleLookup = inverse(a)       (clean[i] = scrambled[lookup[i]])
//
// This is structurally the legacy algo-2 shuffle (ComixDescramble.computeDescramble-
// Lookup, xorshift with state = seed) except the seed is forced odd. We originally
// reversed this via a live-app oracle + CRT and shipped it as a 3 KB GF(2)-affine
// lookup table; that table was just the linearized form of this same xorshift
// (xorshift is GF(2)-linear and `seed|1` is affine in the seed — hence the
// "eff = seed >>> 1" we observed). The closed form below is byte-identical to the
// table on 5000+ random seeds plus every ground-truth seed, so the table is gone.
// Cross-checked against the Keiyoushi comix extension's `buildOrder`.
//
// NOTE: this is the algo-3 scheme. The older algo-2 tile shuffle used a
// xorshift32 Fisher-Yates with state = seed (see ComixDescramble.computeDescrambleLookup).

const TILES = 25; // 5x5

// For each clean tile position, the scrambled tile index to copy from:
// clean[i] = scrambled[descrambleLookup[i]]. Only valid for the 5x5 grid.
export function computeDescrambleLookupB(seed: number): number[] {
  const a = new Array<number>(TILES);
  for (let i = 0; i < TILES; i++) a[i] = i;
  let s = (seed | 1) >>> 0;
  for (let i = TILES - 1; i > 0; i--) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    const j = (s >>> 0) % (i + 1);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  // a is the scramble permutation; descramble lookup is its inverse.
  const inv = new Array<number>(TILES);
  for (let i = 0; i < TILES; i++) inv[a[i]!] = i;
  return inv;
}
