# Local Comix Runtime Port

This is the handoff workflow for turning the live Comix.to runtime into Paperback-safe static code.

## Goal

Port the live signer and encrypted API response decryptor into local TypeScript so Paperback can fetch Comix directly without the Render relay.

Target API:

```ts
export function generateHash(rawPath: string): string
export function signUrl(url: string): string
export function decryptComixPayload(path: string, payload: any): any
```

`decryptComixPayload()` should accept the encrypted API object from Comix, usually shaped like:

```json
{ "e": "..." }
```

and return the decrypted result object matching the fixture's `decrypted` value.

## Generate Extraction Package

Run:

```bash
npx tsx experiment/ExtractComixRuntime.ts
```

Output folder:

```text
experiment/extracted/comix-runtime-latest/
```

Useful files:

- `report.md`: summary and live signer check
- `runtime.json`: machine-readable live signer tokens and metadata
- `secure.js`: full live secure bundle
- `signer-function.js`: behavior-detected signer wrapper
- `response-interceptor.js`: behavior-detected decrypt interceptor wrapper
- `source-references.json`: VM ids and helper identifiers used by extracted wrappers
- `source-neighborhoods.txt`: nearby minified source around those identifiers
- `fixtures.json`: encrypted payloads and expected decrypted outputs

## LLM Prompt

Paste this prompt into the LLM:

```text
I need to port Comix.to's live signer and response decryptor into Paperback-safe TypeScript.

Constraints:
- Target file: src/ComixTo/ComixHash.ts, or a new src/ComixTo/ComixCrypto.ts re-exported from ComixHash.ts.
- Must run in Paperback JavaScriptCore.
- No Node APIs: no Buffer, fs, crypto, process, dynamic import, eval, workers, or DOM.
- Use plain TypeScript/JavaScript only.
- Existing ComixHash.ts has base64 helpers, RC4, old mutation logic, generateHash(), and signUrl().
- Preserve generateHash(rawPath: string): string and signUrl(url: string): string.
- Add export function decryptComixPayload(path: string, payload: any): any.

Use these extracted files:
1. experiment/extracted/comix-runtime-latest/report.md
2. experiment/extracted/comix-runtime-latest/runtime.json
3. src/ComixTo/ComixHash.ts
4. experiment/extracted/comix-runtime-latest/source-references.json
5. experiment/extracted/comix-runtime-latest/signer-function.js
6. experiment/extracted/comix-runtime-latest/response-interceptor.js
7. experiment/extracted/comix-runtime-latest/source-neighborhoods.txt
8. experiment/extracted/comix-runtime-latest/fixtures.json

Goals:
- Update the static signer so generateHash(path) matches runtime.json signChecks liveToken values.
- Implement local decrypt so decryptComixPayload(path, encryptedPayload) matches fixtures.json decrypted values.
- Do not call the relay.
- Keep the result self-contained and readable.
- Return a patch only.

If source-neighborhoods.txt is insufficient, tell me the exact identifier/function names you need from secure.js.
```

Paste files in the order listed. Start with the small files. Only paste sections of `secure.js` if the LLM asks for exact identifiers.

## Validation

After applying the LLM patch:

```bash
npx tsx experiment/ValidateLocalComixRuntime.ts
npm run bundle
```

Expected successful validator result:

```text
summary: signer N pass / 0 fail, decrypt N pass / 0 fail
```

If decrypt has not been implemented yet, the validator will print:

```text
Missing local decrypt export
```

If the signer is still stale, it will print each mismatching live token from `runtime.json`.

## Optional Strict Signer Check

To make extraction fail when the checked-in static signer is stale:

```bash
npx tsx experiment/ExtractComixRuntime.ts --strict-sign
```

Use this later for automation, not for manual extraction while actively porting.

## Updating Paperback Flow

Once validation passes, update `src/ComixTo/RelayClient.ts` so the relay path is no longer the default.

Desired flow:

1. Use `signUrl(fullUrl)`.
2. Fetch Comix directly.
3. Parse JSON.
4. If JSON has `{ e: ... }`, call `decryptComixPayload(apiPath, json)`.
5. Return the decrypted result.
6. Keep relay fallback only for emergency rotations.

Then run:

```bash
npm run bundle
```

and copy the generated bundle into the tracked `0.8/ComixTo/source.js` if the bundler only updates `bundles/0.8/ComixTo/source.js`.
