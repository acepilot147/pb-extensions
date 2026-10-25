# In-app Comix key rotation

## Runtime behavior

All API consumers (home/search/details, chapter lists/pages, settings/tag loads)
use the same queued `fetchSigned` path. A request snapshots its keys and keeps
signing, fetching, retrying, and decoding inside that queue item.

- Start with validated `comix_live_keys_v1` state, otherwise the baked keys.
- A structured HTTP 403 `key_retired`, or failure to decode the supported
  encrypted envelope, triggers discovery: homepage → main module → apicore →
  its helper chunk. Generic HTTP errors, WAF/captcha challenges, decoded API
  errors, and unsupported cipher versions do not trigger key discovery.
- Extraction must reproduce four of apicore's own request tokens, including
  nested parameters, array parameters and Unicode. Its client must also decrypt
  a planted Unicode payload encrypted with the candidate table.
- Retry the API request once with the candidate. Only a successful decoded
  response activates/persists it. Failed extraction/retries leave the previous
  record intact. In-memory keys survive a persistent-store write failure.
- A queue prevents concurrent homepage calls from racing key changes. Discovery
  is also single-flight, with no time-based cooldown: the next request may refresh
  immediately after success or failure. Each request still retries its API call
  only once; repeated failing requests can therefore repeat the asset downloads.
- A restart reads the numeric key cache; it does not refetch assets unless an API
  response signals stale keys. There is deliberately no periodic TTL refresh.

Discovery accepts only HTTPS `comix.to/assets/…/*.js` URLs. It rejects external
origins, encoded/traversal-to-non-asset paths, query/fragment references, oversized
bodies, and unexpected module layouts. Unrelated external module/main script
tags on the homepage are skipped; apicore/helper dependencies still must pass
strict origin checks. Rejected dependency errors identify the hostname, not
credentials or URL query values. Downloaded JavaScript is not persisted.
The on-device state contains the key prefix, two SHA-256 midstates, XOR table,
schema version, source asset URL, and extraction timestamp.

## Trust boundary and limits

**The apicore environment is compatibility emulation, not a security sandbox.**
`new Function` executes the site's JavaScript inside Paperback's realm. Fake
browser globals/XHR avoid ordinary browser/network dependencies but cannot stop
hostile code reaching shared constructors or the native App API, changing
built-ins, or looping synchronously. HTTPS origin restrictions do not protect
against a compromised site. The installed Paperback Request/Response API exposes neither
a redirect policy nor a distinct final-response URL, so the initial-origin checks
do not prove the origin of a transparently redirected response. Only use this
design when the site and its delivery chain are trusted as an
executable dependency. A hostile-code threat model requires an interpreter or an
isolated runtime, not more JavaScript wrappers.

The offline runner uses subprocess deadlines and checks built-in identities,
prototypes and property descriptors. These checks verify observed fixture
behavior; they are not in-app isolation guarantees. A bare Node VM approximates
missing Paperback APIs, but does not replace testing on an actual iOS device.

Supported crypto families are HMAC-SHA256-midstate signing and `x-enc: 2`
XOR-offset encryption. New algorithms/module structures still require an
extension update. Polyfills deliberately reject unsupported browser features
rather than silently fabricating values.

## Verification

Install dependencies once, then run this entirely offline gate:

```sh
npm run verify:keys
```

It type-checks, runs unit/compatibility tests, extracts keys from genuine saved
assets in a bare VM, builds `bundles/0.8/ComixTo/source.js`, then runs that exact
bundle against a fake server. Every subprocess has a deadline. Missing fixtures
are errors, not silently skipped tests. See [fixture-README.md](fixture-README.md)
for asset provenance; saved third-party assets are gitignored.

Alternate fixtures:

```sh
npm run verify:keys -- path/to/apicore-build-hash.js path/to/helper.js
```

The fake server uses the independent Node reference extractor and pipeline crypto,
not the bundle's signer/decryptor, to check tokens and encrypt results. It exercises
public source methods for details, chapters, pages, search, home, and tags;
rotation, retry/decryption, corrupted cache, fresh-VM restart without refetching,
WAF/generic errors, unsupported cipher, failed retries, and preservation of built-ins.
No live API requests occur. Existing telemetry calls are intercepted locally.

Individual commands:

```sh
npm run typecheck
npm run test:keys
npm run test:keys:e2e
node experiment/live/test-apicore-jsc.mjs path/to/apicore.js path/to/helper.js expectedPrefix.
```

`npm test` remains the existing Paperback toolchain command. `comix:e2e` is the
older LIVE-site probe, not this offline gate. No release version bump, commit,
push, or copy to the published `0.8/` directory is performed by verification.
