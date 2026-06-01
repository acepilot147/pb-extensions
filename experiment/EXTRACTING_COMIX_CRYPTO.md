# Extracting comix.to's sign / decrypt algorithms — methodology

A playbook for the recurring task: comix.to rotates `secure-*.js`, our embedded
copy (`src/ComixTo/ComixBundle.ts`) goes stale or the perf-killing live-VM path
needs replacing with a native port, and we have to recover the current signer +
response-decrypt so Paperback can do it natively.

Written after the 2026-05-30 extraction (bundle `e1619d65cd30`). Read this
**before** opening a probe script — the single biggest time-sink last time was
re-deriving an algorithm we already had documented.

---

## 0. The one rule that saves the most time

**Check what we already know before reverse-engineering anything.** In order:

1. Memory: [[comix-signing]] (`project_comix_signing.md`) — names the algorithm
   families, the per-round formula, what rotates, and the anti-tamper traps.
2. `experiment/legacy-static-port/` — `BuildComixFastDecrypt.ts` /
   `BuildComixFastSigner.ts` already implement *and auto-detect* both known
   families. `TestComixCryptoCandidates.ts` has the reference round logic.
3. This file's "Known algorithm families" section below.

The algorithm family has been **stable since 2026-05-22** (`sbox-cbc`). Across
many bundle rotations since, **only the constants change** (S-boxes, keys, IVs,
round count, and the obfuscated *names*). If the family hasn't changed you do
**not** reverse-engineer — you just re-capture constants (Section 3). Last time
the whole black-box reverse-engineering exercise (Section 4) re-derived
`sbox-cbc-inverse` byte-for-byte identical to `applySboxCbcInverseStage` that was
already sitting in `legacy-static-port/BuildComixFastDecrypt.ts`. Don't repeat
that.

Decision tree:

```
Stale bundle / need native port
        │
        ├─ Does decrypt still: atob(e) → length-preserving transform → TextDecoder → JSON ?
        │     (Section 2 boundary probe answers this in ~30 lines)
        │
        ├─ YES, looks like sbox-cbc  ──► Section 3: re-capture constants, done.
        │
        └─ NO (new shape: length grows, crypto.subtle called, multiple blocks,
                key from headers, etc.) ──► Section 4: deep RE, then update
                                            memory + this file with the new family.
```

---

## 1. Booting the bundle in Node (the test rig)

Everything below runs the embedded bundle as ground truth. Extract `cfg` and
`BUNDLE_CODE` from `src/ComixTo/ComixBundle.ts`, then eval under a sandbox.

Boot recipe that works (and the anti-tamper traps it satisfies):

```js
const src  = readFileSync("src/ComixTo/ComixBundle.ts","utf8");
const cfg  = src.match(/cfg:\s*"([^"]+)"/)[1];
const code = JSON.parse('"' + src.match(/BUNDLE_CODE\s*=\s*"([\s\S]*?)";\s*\n/)[1] + '"');

// Plain-object sandbox, prototype = real globalThis (built-ins resolve natively).
// This is the SAME trick ComixBundleRuntime.buildFastSandbox uses on-device.
const sb = buildBacking();                 // see any experiment/_probe*.cjs
Object.setPrototypeOf(sb, globalThis);
sb.globalThis = sb.window = sb.self = sb.global = sb;
const exp = new Function("__sb", `with(__sb){\n${code}\n}`)(sb);   // returns {a,i,n,o,r,s,t,...}

// Capture interceptors via a fake axios:
let reqI, resI;
exp.r({ interceptors:{ request:{use:h=>reqI=h}, response:{use:h=>resI=h} },
        defaults:{ headers:{common:{},get:{},post:{},put:{},delete:{},patch:{},head:{}},
                   transformRequest:[], transformResponse:[] },
        get(){},post(){},put(){},delete(){},patch(){},head(){} });
```

**Anti-tamper the sandbox MUST satisfy** (from [[comix-signing]]; skipping these
makes the bundle silently corrupt keys — you get wrong output, not an error):

- `document.querySelector` / `querySelectorAll` `.toString()` must return
  `"function querySelector() { [native code] }"` (the `ce()` native-code check).
- A `<meta name="cfg">` stub returning the real `cfg` from `getAttribute("content")`.
- `navigator.appCodeName === "Mozilla"` (used in VM key derivation).
- `atob`/`btoa`, `TextEncoder`/`TextDecoder`, timers, `localStorage` stubs.

If output is subtly wrong rather than throwing, suspect one of these.

---

## 2. The robust extraction primitive: intercept the JS built-in boundary

**This is the key improvement over the old approach.** The old extractor
(`BuildComixFastDecrypt.captureSboxCbcDecryptRounds`) reached *inside* the VM —
it read `fn.__vmEnv`, found the locals array by structure, and intercepted env
slots. That works but is brittle: it broke on rotation (env-array property
rename, role-letter rotation `Ai.I`→`yi.J`→`wi.J`, container rename) and the v1
fallback then probed random VM functions with junk and crashed the bundle. That
fragility is *why the project abandoned the native port and ate the 4.5s/page
live-VM cost.*

The cipher, however, can only talk to the outside world through **JS built-ins**:
`atob` (base64-decode input + constants), `TextDecoder.decode` (final bytes →
string), and on the encrypt side `TextEncoder`/`btoa`. Those names never rotate.
Wrap them and you observe the algorithm without touching the VM at all:

```js
// In buildBacking():
atob: s => { const r = bufAtob(s); ATOB_CALLS.push(Buffer.from(r,"binary")); return r; },
class TracingTextDecoder { decode(buf,o){ DEC_INPUTS.push(Buffer.from(buf)); return real.decode(buf,o); } }
```

What each interception gives you:

| Built-in            | What it reveals                                                            |
|---------------------|----------------------------------------------------------------------------|
| `atob` results      | call[0] = the ciphertext bytes; the **256-byte** results are S-boxes (each a permutation of 0..255), the short ones are round keys, in pipeline order |
| `TextDecoder.decode` input | the **clean plaintext bytes** before UTF-8 mangling — feed garbage ciphertext and you still get exact decrypted bytes (no `0xFFFD` replacement noise) |
| `TextEncoder`/`btoa`| the encrypt path, if you need it for fixtures                              |

> Pitfall that cost time last round: reading the decrypt output as a latin1
> string shows scattered `0xfd` bytes. Those are UTF-8 **replacement chars**
> (U+FFFD) from `TextDecoder` choking on garbage input — not cipher output.
> Intercept `TextDecoder.decode` to get the real pre-decode bytes.

This boundary probe alone answers "is it still sbox-cbc?": if `atob` yields three
256-byte permutations + three short keys and the transform is length-preserving,
it is. Capture them and skip to Section 3.

---

## 3. Re-capturing constants for a known family (the common case)

For `sbox-cbc` you need, per round: the forward S-box, the key, and the IV.
S-boxes + keys fall out of the `atob` trace (Section 2). The **IV is solvable
from a single (input,output) byte sample** — no search over the array needed:

```
decrypt round:  out[i] = invS[in[i]] ^ in[i-1] ^ key[i % keylen]   (in[-1] = IV)
                ⇒  IV = invS[in[0]] ^ key[0] ^ out[0]
```

Grab one round's `(sampleIn, sampleOut)` and solve directly (this is exactly what
`buildSboxCbcInverseStages` does). If you only have the end-to-end decrypt (not
per-round samples), brute-force the 3 IVs against one captured plaintext — a
256³ loop with early-out on positions 0–2 runs in well under a second.

Then **dump constants as base64** and drop them into a native port. Reference
implementation produced last time:
`experiment/comix-decrypt-reference.mjs` (standalone, dependency-free, self-test
passes) and the spec in `experiment/comix-decrypt-algorithm.md`.

The signer is the same cipher run **forward** (CBC-encrypt direction); the same
S-box/key/IV set serves both. `Ai.T(path)` signs, `Ai.I(blob)` decrypts, and
`Ai.I(Ai.T(path)) === path` (role letters + container name rotate — never
hardcode them; identify by round-trip behavior).

---

## 4. Deep reverse-engineering (only when the family genuinely changed)

This is the from-scratch path used 2026-05-30. Use it to *characterize a new
family*, then write it up so future runs skip back to Section 3.

1. **Confirm the I/O shape.** Length-preserving (stream/substitution/CBC) vs
   length-growing (block padding, or per-byte prefix-insert like the old v1).
   Is `crypto.subtle` ever called? (Wrap it.) Is there a `WebAssembly.instantiate`?
   (Wrap it — last bundle shipped a tiny `buildOrder(seed,n)` WASM that's just a
   Numerical-Recipes LCG Fisher-Yates, used for *image* descramble, not API
   decrypt — see `ComixDescramble.ts`. Don't confuse the two.)

2. **Feed controlled bytes through the cipher core**, not base64 chars. To inject
   raw byte array `B`, pass `btoa(B)` as the ciphertext so the internal
   `atob` yields exactly `B`. Read clean output via the `TextDecoder` intercept.

3. **Locality / avalanche analysis** → round count. Flip one ciphertext byte,
   see which plaintext positions move:
   ```
   flip ct[p] → pt[p..p+3] changed   ⇒  4-byte forward window
   ```
   A window of `R+1` is the signature of **R chained rounds** (each CBC round
   spreads influence by one byte). The 2026-05-30 bundle showed a 4-byte window =
   3 rounds, matching the 3 (S-box,key) pairs from the `atob` trace.

4. **Recover the round formula by IV-independent brute force.** With CBC-decrypt
   chaining (`prev = input[i-1]`), the per-round IV only affects `pt[0..R-1]`.
   So **score candidate formulas on positions ≥ R** and the IV drops out. Search
   the small space: box ∈ {S, invS}, ops ∈ {XOR, ADD, SUB} for `op(op(box[in], prev), key)`
   and its variants, for each round, in forward and reverse pipeline order.
   The winner last time: `invS[in[i]] ^ in[i-1] ^ key[i%len]`, all 3 rounds, forward order.
   Then solve IVs (Section 3) to fix positions 0–2.

5. **Gold-standard verification.** Build the matching **encrypt** (invert each
   round; CBC-encrypt feeds back `out[i-1]`; apply rounds in reverse order),
   fabricate a realistic JSON payload, encrypt it to a synthetic `{e}`, and run
   it through the **actual bundle `resI`** vs your native port. Match on: unicode,
   error bodies (`status:"error"`), large lists (500+ items), and the
   `{status:"ok",result}` → `result` unwrap. 200 random-length raw-byte trials +
   these payloads = confidence it's byte-exact, not just close.

---

## 5. Known algorithm families (keep this current)

**v1 — insert+RC4 (sign) / mutation+RC4 (decrypt).** ≤ bundle `e0f2a868a520`
(2026-05-21). 5 rounds, each = a byte-mutation stage (rotate/add/xor by index%10)
+ RC4, with a per-round prefix-insert so tokens *grow* (77+ chars). Token in
`?_=` in the URL. Reference: `legacy-static-port/TestComixCryptoCandidates.ts`.

**v2 — sbox-cbc (sign) / sbox-cbc-inverse (decrypt).** From bundle
`3a0786b685ca` (2026-05-22) through at least `e1619d65cd30` (2026-05-30).
Length-preserving. Was 5 rounds, **now 3**. Per round:
```
sign/encrypt : out[i] = sbox[ in[i] ^ key[i%len] ^ prev ];  prev = out[i]   (in[-1]=IV)
decrypt      : out[i] = invSbox[ in[i] ] ^ key[i%len] ^ prev; prev = in[i]  (in[-1]=IV)
```
Constants are **hardcoded in the bundle, NOT derived from `cfg`** (cfg is only
read by the anti-tamper / signing-context path; same key material under a faked
cfg — verified). Token moved to `params._` on the axios config. Whole payload =
`atob(e)` → 3 inverse rounds → `TextDecoder` → `JSON.parse` → unwrap `result`.

Trigger condition (response interceptor): `headers["x-enc"]==="1"` &&
`typeof data === "object"` && `typeof data.e === "string"`.

---

## 6. Checklist / gotchas

- [ ] Memory + `legacy-static-port/` checked before any RE.
- [ ] Sandbox passes anti-tamper (querySelector native-code string, cfg meta,
      `navigator.appCodeName`) — else you get wrong bytes, not errors.
- [ ] Constants identified by **structure/behavior**, never by rotating names:
      256-byte atob = S-box; round-trip `f(g(x))===x` = sign/decrypt pair;
      first own Array property = VM env locals.
- [ ] Read decrypt output via `TextDecoder`-intercept, not as a latin1 string
      (avoid the `0xFFFD`/`0xfd` red herring).
- [ ] Verify by re-encrypting and round-tripping through the live bundle `resI`,
      across unicode / error / large-list payloads — not just one happy path.
- [ ] If the family changed: update [[comix-signing]] and Section 5 here, and add
      a `tryBuildXxx` detector so the pipeline auto-detects it next time.
- [ ] Image tile-descramble (`X-Scramble-Seed`/`-Grid`, LCG Fisher-Yates) is a
      **separate** system from API decrypt — see `src/ComixTo/ComixDescramble.ts`.
      Don't conflate the WASM `buildOrder` with the cipher.

## 7. Why prefer the boundary probe over de-VM'ing (the historical lesson)

The de-VM extractor (`legacy-static-port/`) is more *automated* (it emits a full
`ComixFastDecrypt.ts`) but couples to VM internals that rotate every build; when
discovery broke it crashed and the project fell back to running the whole
obfuscated bundle live — which is the source of the 4.5s/page freeze
([[project-chapter-update-perf]]). The boundary-interception method here couples
only to `atob`/`TextDecoder`, which can't rotate, so it keeps working across
bundles and yields constants you can paste into a fast native port. Ideal
end state: a refresh script that boots the bundle, captures constants via the
boundary probe, solves IVs, and regenerates a native decrypt module — getting the
automation of the old pipeline with the durability of the new technique.
