# Genuine Comix static fixtures

Captured **2026-10-25 04:35–04:37 UTC** from public HTTPS responses. These are unmodified response bodies, not generated stand-ins. The observed filename build ID is **`tnfy0u`**, not the baked `tnd60v` build. The static directory ID is a separate value: `35595e3de3c99889c1aa70`.

## Saved files and provenance

All paths below are relative to `experiment/live/assets/`.

| Role | File | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Homepage | `homepage.html` | 409947 | `5e9abbf0a27f2ce30b29da46c6c42405cc80677f45591fece4146b245b6d04a1` |
| Main | `main-tnfy0u-Ac5VIAhY.js` | 216980 | `70f9af1e277da4f8e3f6333ea544575f64930383af337ace1e096686ad0a4f46` |
| Apicore | `apicore-tnfy0u-DTgTZszb.js` | 168907 | `094ee5ffdd13c1bd6882b570871430075e65cfb27aa62b147871f8d369dbb157` |
| Imported helper | `tnfy0u-B1Ozv2t7.js` | 723 | `eb0e3e279a658dd97ad1b6295c3a9a01ed63b4f3115fa2f9c148f5833d6978a2` |

`assets/provenance.json` records exact source URLs, timestamps, HTTP status, content type, byte counts, SHA-256, graph evidence, and validation limits. Adjacent `*.headers.txt` files preserve response headers. `assets/` is already gitignored; no ignore rules were changed. This document remains outside the ignored directory.

## Exact source graph

1. Homepage: <https://comix.to/>
2. Main: <https://comix.to/assets/build/35595e3de3c99889c1aa70/dist/main-tnfy0u-Ac5VIAhY.js>
3. Apicore: <https://comix.to/assets/build/35595e3de3c99889c1aa70/dist/apicore-tnfy0u-DTgTZszb.js>
4. Helper: <https://comix.to/assets/build/35595e3de3c99889c1aa70/dist/tnfy0u-B1Ozv2t7.js>

Homepage entry, verbatim:

```html
<script type="module" src="/assets/build/35595e3de3c99889c1aa70/dist/main-tnfy0u-Ac5VIAhY.js" defer track>
```

Main imports apicore through a **static named import**, not a dynamic import:

```js
import{A as Yi,B as ji,H as He,I as yi,L as Ci,M as Oi,N as Ni,O as gk,P as Li,U as $e,V as Ee,W as c,_ as $l,c as En,d as on,f as mn,j as Si,k as Zi,l as Cn,o as Jn,p as _m,s as Gn,u as An,v as Rl,y as Ql,z as Fi}from"./apicore-tnfy0u-DTgTZszb.js";
```

Main also contains the bare filename `"apicore-tnfy0u-DTgTZszb.js"` in its `__vite__mapDeps` dependency table. This is the same asset, not a second module. Discovery that scans quoted filenames should resolve specifiers against the **main URL**, then deduplicate resolved URLs; searching only for `import(...)` will miss this graph.

Apicore has exactly one static import and no dynamic imports:

```js
import{n as WA,r as Wz,t as WO}from"./tnfy0u-B1Ozv2t7.js";
```

Resolve the helper specifier against the **apicore URL**. The helper has no imports and ends with:

```js
export{Ce as n,a as r,b as t};
```

This helper is required; apicore alone is not the complete input for `ComixApicore.ts`. Both apicore and helper have the minified `import{...}from"...";` / trailing `export{...};` forms used by the existing extractor's module transformer. The saved main has other imports, but those are not needed to supply the apicore-plus-helper fixture pair.

## Verified and deliberately not run

- All four saved source responses returned **HTTP 200**; all three JavaScript assets have `application/javascript` content type.
- TypeScript `createSourceFile(..., ScriptKind.JS)` parsed all three saved JavaScript files with **zero parse diagnostics**. This was static parsing only, not evaluation.
- Source URLs were discovered from the downloaded homepage and module text. SHA-256 values describe the saved raw response-body bytes.
- No saved apicore assets were present in the repository; the reviewed git history contained live acquisition scripts, not tracked apicore fixtures.
- No live API endpoint was requested. No browser, login, or challenge bypass was needed. An initial homepage transfer failed to save because the shell's temporary-path environment differed from the declared scratch path; the one successful retry is the homepage preserved here. Each JavaScript asset was fetched once.
- **Downloaded JavaScript was not executed on the host.** Neither the bare-VM extractor test nor the built-source runtime test was run during fixture recovery. Runtime extraction compatibility and the current key prefix are therefore **unverified**; do not assume the older `5qj.` prefix for this build.

For the existing test's positional inputs, the fixture pair is:

```text
experiment/live/assets/apicore-tnfy0u-DTgTZszb.js
experiment/live/assets/tnfy0u-B1Ozv2t7.js
```

Treat these as untrusted remote code. A Node `vm` context is not a security boundary; any subsequent evaluation needs an appropriate isolation policy and separate authorization from this acquisition-only task.
