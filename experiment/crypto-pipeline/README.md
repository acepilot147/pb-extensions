# Comix crypto pipeline

Automated extraction of comix.to's request **signer** and response **decrypt**
into native, Paperback-safe TypeScript — the modern replacement for the old
`legacy-static-port/` (`BuildComixFastSigner.ts` / `BuildComixFastDecrypt.ts`).

It uses rotation-proof **outside-in observation** (`../EXTRACTING_COMIX_CRYPTO.md`):
boot the bundle (`experiment/ComixBundle.ts`), observe it at the JS built-in
boundary (`TextDecoder` for plaintext) and through a name-agnostic trace of the
arithmetic it executes, and never touch VM internals (opcode tables, register
names). That is why this keeps working across bundle rotations where the old
`__vmEnv`-array discovery kept breaking.

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

- `constants.json` — the extracted, self-verified constants: the signer's
  token prefix, MAC length and HMAC ipad/opad midstates, and the decrypt XOR
  table, plus `bundleId` and `verified` flags.
- `src/ComixTo/ComixFastDecrypt.ts` — `fastDecryptComixPayload(path, payload, headers)`.
- `src/ComixTo/ComixFastSigner.ts` — `fastGenerateHash(rawPath)`.

Both generated files are self-contained (no Node / DOM / crypto / `TextDecoder`
APIs — manual base64, UTF-8 and SHA-256), strict-mode clean, and embed the constants.

## Files

| file | role |
|------|------|
| `lib.mjs` | boot the bundle (anti-tamper-safe sandbox), boundary traces, op-trace instrumentation, reference ciphers |
| `extract.mjs` | recover constants from the live bundle, self-verify → `constants.json` |
| `generate.mjs` | emit the two native TS files from `constants.json` |
| `validate.mjs` | transpile the **emitted** files and check them vs the live signer + `resI` |
| `run.mjs` | orchestrate extract → generate → validate |

## The algorithm (current: bundle `88ef335b54f8`, 2026-10)

**Signer — `hmac-sha256-midstate`.**

```
token = "gfs." + base64url( HMAC-SHA256(key, path[?canonicalQuery])[0:12] )
```

- The message is the `/api/v1`-relative path, plus `?` + the canonical query
  when there are params (keys sorted, values raw, arrays as `k[0]=…&k[1]=…` —
  see `canonicalizeQuery`). A query string inside the URL itself is ignored by
  the bundle; the server canonicalizes whatever query arrives on the wire.
- The key never appears: the bundle hardcodes the SHA-256 **midstates** after
  the ipad and opad blocks (`istate` / `ostate`), which is all HMAC needs. Two
  compressions per token (inner over the message, outer over the inner digest).

**Decrypt — `xor-offset`, response header `x-enc: 2`.**

```
ct  = base64(e) = [h0, h1, body...]
off = ((h0 << 8) | h1) % 1024
pt[i] = body[i] ^ K[(off + i) % 1024]        → UTF-8 → JSON.parse → unwrap result
```

`K` is a fixed 1024-byte table. Constants are hardcoded in the bundle (not
derived from `cfg`) and rotate with `secure-*.js`. Previous families: see
`../EXTRACTING_COMIX_CRYPTO.md` §5.

## How extraction stays rotation-proof

- **Decrypt table** read straight off the live decrypt: an all-zero body under
  header `0,0` decrypts to `K` itself (captured at the `TextDecoder` boundary).
  The period is measured, and the XOR/offset model is checked on 200 random
  ciphertexts.
- **Signer midstates** read off the instrumented op trace
  (`bootBundle({ instrument: true })` rewrites every `^ & | << >> >>> + - * %`
  into a traced call; the anti-tamper does not notice). Each SHA-256
  compression ends with a feed-forward `state[i] + work[i]`; signing two
  same-length messages, the `state[i]` operand stays fixed while the sum
  changes — that isolates the 8 inner and 8 outer state words. Compressions
  are located by where the standard SHA-256 round constants `K[0]`/`K[63]` are
  used, never by VM names.
- **Self-verification** before writing: the native signer must reproduce live
  tokens for 150 random paths (1–3 SHA blocks, non-ASCII) plus a canonical
  query, and an encrypted round-trip must match the live `resI`.

If the family ever changes (decrypt stops being an XOR table behind a 2-byte
header, the signer stops doing exactly two SHA-256 compressions, the token
shape changes, etc.), extract throws rather than emit wrong constants — that
is the signal to characterize the new family per `../EXTRACTING_COMIX_CRYPTO.md`
§4 and extend `extract.mjs`.

## Wiring into the extension (done)

`ComixHash.ts` is the central crypto interface for `ComixTo.ts` and imports the
generated modules directly: `generateHash` → `fastGenerateHash`, and the `{e}`
decrypt in `fetchSigned` → `fastDecryptComixPayload`. The old live-VM path
(`ComixBundleRuntime`, `ComixBundle`, `ComixProbe`, `ComixPolyfills`) has been
removed — this is the fix for the 4.5 s/page decrypt cost, and the ~177 KB
obfuscated bundle no longer ships in `source.js`.

So a rotation only touches the two generated files; no extension wiring changes.
