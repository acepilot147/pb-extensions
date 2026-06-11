# Comix crypto pipeline

Automated extraction of comix.to's request **signer** and response **decrypt**
into native, Paperback-safe TypeScript — the modern replacement for the old
`legacy-static-port/` (`BuildComixFastSigner.ts` / `BuildComixFastDecrypt.ts`).

It uses the rotation-proof **boundary-interception** technique
(`../EXTRACTING_COMIX_CRYPTO.md`): boot the bundle (`experiment/ComixBundle.ts`),
observe it only at the JS built-in boundary (`atob` for constants, `TextDecoder`
for plaintext), and never touch VM internals. That is why this keeps working
across bundle rotations where the old `__vmEnv`-array discovery kept breaking.

The extension itself no longer ships the bundle or runs it — `ComixHash.ts`
imports the generated `ComixFastSigner` / `ComixFastDecrypt` directly. The bundle
lives at `experiment/ComixBundle.ts` purely as the source-of-truth this pipeline
extracts from (it is outside `src/`, so it is never compiled or shipped).

## Run

```bash
node experiment/crypto-pipeline/run.mjs            # uses experiment/ComixBundle.ts
node experiment/crypto-pipeline/run.mjs --refresh  # fetch live secure.js first
# or: npm run crypto:pipeline
```

`--refresh` runs `experiment/RefreshComixBundle.ts` first (needs
`CF_CLEARANCE` / `SESSION` / `USER_AGENT` env). Without it, the pipeline works
fully offline against the checked-in `experiment/ComixBundle.ts`.

## When comix.to rotates secure.js (the regeneration workflow)

Two artifacts, two steps. `experiment/ComixBundle.ts` (the captured bundle) and
`src/ComixTo/ComixFast{Signer,Decrypt}.ts` (the shipped native crypto) are
separate, so a rotation means: refresh the bundle, then regenerate from it.

```bash
# 1. refresh the captured bundle from live comix.to
npm run refresh:comix          # writes experiment/ComixBundle.ts
                               # (needs CF_CLEARANCE / SESSION / USER_AGENT env)

# 2. regenerate + validate the native crypto from that bundle
npm run crypto:pipeline        # rewrites src/ComixTo/ComixFast{Signer,Decrypt}.ts

# 3. rebuild the extension bundle, then commit / deploy as usual
npm run bundle
```

Or collapse 1+2 into one command:

```bash
npm run crypto:pipeline -- --refresh    # refresh, then extract → generate → validate
```

You never hand-edit any of these files. `refresh:comix` regenerates
`experiment/ComixBundle.ts`; `crypto:pipeline` regenerates the shipped crypto
from it and fails loudly (rather than emitting wrong constants) if the algorithm
family changed. If you only have a new `secure.js` and no working env creds for
`refresh:comix`, drop it into `experiment/ComixBundle.ts` (same
`BUNDLE_INFO` / `BUNDLE_CODE` shape) and run step 2 offline.

Each step is also runnable on its own:

```bash
node experiment/crypto-pipeline/extract.mjs    # -> constants.json
node experiment/crypto-pipeline/generate.mjs   # -> src/ComixTo/ComixFast{Decrypt,Signer}.ts
node experiment/crypto-pipeline/validate.mjs   # transpile + check vs live bundle  (= npm run validate:comix)
```

## What it produces

- `constants.json` — the extracted, self-verified `sbox-cbc` constants
  (per-round S-box, key, IV) in canonical decrypt order, plus `bundleId` and
  `verified` flags.
- `src/ComixTo/ComixFastDecrypt.ts` — `fastDecryptComixPayload(path, payload, headers)`.
- `src/ComixTo/ComixFastSigner.ts` — `fastGenerateHash(rawPath)`.

Both generated files are self-contained (no Node / DOM / crypto / `TextDecoder`
APIs — manual base64 + UTF-8), strict-mode clean, and embed the constants.

## Files

| file | role |
|------|------|
| `lib.mjs` | boot the bundle (anti-tamper-safe sandbox), boundary traces, cipher primitives |
| `extract.mjs` | recover constants from the live bundle, solve IVs, self-verify → `constants.json` |
| `generate.mjs` | emit the two native TS files from `constants.json` |
| `validate.mjs` | transpile the **emitted** files and check them vs the live signer + `resI` |
| `run.mjs` | orchestrate extract → generate → validate |

## The algorithm (current: `sbox-cbc`, 3 rounds)

Same `(sbox, key, iv)` triple per round serves both directions.

```
decrypt round:  out[i] = invSbox[in[i]] ^ in[i-1] ^ key[i % len]   (in[-1] = iv)   stages 1..N
sign round:     out[i] = sbox[ in[i] ^ out[i-1] ^ key[i % len] ]   (out[-1] = iv)  stages N..1
```

- Decrypt: `base64(e)` → inverse rounds 1..N → UTF-8 → `JSON.parse` → unwrap `result`.
- Sign: raw path bytes → forward rounds N..1 → base64url (no padding).
- Constants are hardcoded in the bundle (NOT derived from `cfg`); they rotate
  with `secure-*.js`.

## How extraction stays rotation-proof

- **Constants** read off `atob`: 256-byte result = S-box (a permutation), the
  short ones = keys, captured in round order. Never by name.
- **IVs** solved from one live (ciphertext → plaintext) pair: because CBC-decrypt
  chains on the input byte, `iv_r` only affects plaintext positions `0..N-r`, so
  they solve outward in `N×256` tries (`iv_r` is pinned by `pt[N-r]`).
- **Self-verification** before writing: the forward cipher must reproduce the
  live signing token, and an encrypted round-trip must match the live `resI`.

If the family ever changes (decrypt stops being length-preserving, `atob` no
longer yields 256-byte permutations, `crypto.subtle` gets called, etc.), extract
will throw rather than emit wrong constants — that is the signal to characterize
the new family per `../EXTRACTING_COMIX_CRYPTO.md` §4 and extend `extract.mjs`.

## Wiring into the extension (done)

`ComixHash.ts` is the central crypto interface for `ComixTo.ts` and imports the
generated modules directly: `generateHash` → `fastGenerateHash`, and the `{e}`
decrypt in `fetchSigned` → `fastDecryptComixPayload`. The old live-VM path
(`ComixBundleRuntime`, `ComixBundle`, `ComixProbe`, `ComixPolyfills`) has been
removed — this is the fix for the 4.5 s/page decrypt cost, and the ~177 KB
obfuscated bundle no longer ships in `source.js`.

So a rotation only touches the two generated files; no extension wiring changes.
