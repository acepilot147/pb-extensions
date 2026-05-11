# Comix Fast Constants Relay

Small Render-compatible Node service that returns the generated Comix fast runtime constants as JSON.

At runtime it reads only `comix-fast-constants.json` in this folder. That keeps
the Render service independent from the rest of the repo.

Endpoints:

- `GET /health`
- `GET /comix-fast-constants.json`
- `GET /api/comix-fast-constants`
- `GET /api/refresh`

By default, constants requests also run the bundle cache check first:

```text
fetch live homepage/main/secure
hash secure.js
compare with cached bundleId
skip analysis if unchanged
refresh constants if changed
serve comix-fast-constants.json
```

If one request is already checking/analyzing a bundle, later requests are queued
onto the same in-flight analysis and do not start another extraction. Render logs
include `bundle analysis started`, `bundle analysis already running; request
queued`, and `bundle analysis finished`.

Set `COMIX_RELAY_AUTO_REFRESH=0` to make constants endpoints serve only the
cached JSON. You can still trigger a check manually:

```text
GET /api/refresh
GET /api/refresh?force=1
GET /api/comix-fast-constants?force=1
```

The constants response includes:

- `bundleId`
- `schemaVersion: 2`
- `encoding: "compact-b64-ops"`
- `period: 160`
- signer `pipelineOrder`, `roundSteps`, `rc4Keys`, compact `insertStages`
- decrypt `pipelineOrder`, `roundSteps`, `rc4Keys`, compact `mutationStages`

Stage payloads use base64 byte blobs:

- signer insert stage: `{ prefix, prefixBytesB64, opsB64 }`
- decrypt mutation stage: `{ prefix, opsB64 }`

Each `opsB64` decodes to `period * 3` bytes: `[op, key, extra]` per residue.

Run locally:

```sh
cd comix-relay
npm run check
npm start
```

To fully refresh from the live Comix site and update this relay JSON:

```sh
cd comix-relay
npm run refresh
```

That command first checks the live Comix bundle id against the cached
`comix-fast-constants.json`. If the bundle id is unchanged, it skips the
expensive extraction/build and only validates the cached JSON.

If the bundle changed or the JSON is missing, it runs the repo's normal Comix
refresh pipeline:

1. `experiment/ExtractComixRuntime.ts`
2. `experiment/BuildComixFastSigner.ts`
3. `experiment/BuildComixFastDecrypt.ts`
4. `experiment/ValidateLocalComixRuntime.ts`
5. `comix-relay/update-constants.js`
6. `comix-relay/server.js --check`

To force regeneration even when the cached bundle id matches:

```sh
cd comix-relay
npm run refresh:force
```

If you already ran `npm run refresh:comix` from the repo root and only need to
re-export the relay JSON, run:

```sh
cd comix-relay
npm run update
```

`npm run update` packages and compacts the generated
`../src/ComixTo/ComixFastSigner.ts` and
`../src/ComixTo/ComixFastDecrypt.ts` into the self-contained
`comix-fast-constants.json`.

Render uses `PORT` automatically.
