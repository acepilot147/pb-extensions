### Local Build and Deployment Guide

## Auto-key rotation verification

The working source can refresh Comix signing/decryption keys in-app and reuse
confirmed keys after restart. Run `npm run verify:keys` to type-check, test, build,
and exercise the built bundle offline with saved genuine assets. See
[behavior, trust boundary, and test instructions](experiment/live/AUTO_KEY_ROTATION.md).
This gate does not publish a release.


This guide outlines the steps to compile the TypeScript extension into standard JavaScript, fix the generated deep-links, and push the updates to the GitHub Pages environment. (For Windows and mostly as notes to self)

# 1. Compile the Source Code

Ensure you are checked out to your main working branch (e.g., 0.8) and your terminal is open to the pb-extensions root directory.

Run the following commands in the Windows Command Prompt (CMD) to set the repository path and build the bundle:
```
mkdir bundles\0.8
npm install
set GITHUB_REPOSITORY=acepilot147/pb-extensions/0.8
npm run bundle
```

Should see logs such as:
```
E:\GitHub\acepilot147-comix\pb-extensions>set GITHUB_REPOSITORY=acepilot147/pb-extensions    

E:\GitHub\acepilot147-comix\pb-extensions>npm run bundle      

> acepilot147-extensions@1.0.2 bundle
> paperback bundle --folder 0.8

[15:22:40:0884] Working directory: E:\GitHub\acepilot147-comix\pb-extensions
[15:22:40:0885] 
[15:22:40:0944] # Transpile and bundle time: 55ms
[15:22:40:0944] 
[15:22:40:0950] # Versioning File: 5ms
[15:22:40:0950]
[15:22:40:0951] - Generating the repository homepage
[15:22:40:0952] Using base URL deducted from GITHUB_REPOSITORY environment variable: https://acepilot147.github.io/pb-extensions/0.8
[15:22:41:0024] # Homepage Generation: 73ms
[15:22:41:0024] 
[15:22:41:0024] # Execution time: 138ms
```

# 2. Local Testing with Paperback v0.8

To test changes locally without deploying, use the dev server.

Start the server (add `-w` to auto-rebuild on file changes):
```
npm run serve -- -w
```

Find your Wi-Fi IP address:
```
ipconfig
```
Look for **Wireless LAN adapter Wi-Fi → IPv4 Address** (e.g. `192.168.0.215`). Ignore any `192.168.56.x` addresses — those are VirtualBox virtual adapters and are not reachable from your phone.

In Paperback v0.8, add a new repository using:
```
http://<your-wifi-ip>:8080
```

Your phone and PC must be on the same Wi-Fi network. HTTP only — HTTPS will not work for a local server.

# 3. Deploy to GitHub Pages

The compiled files must be moved to the gh-pages branch to go live.

Commit source code: Save your current work on your working branch.
```
git add .
git commit -m "Update extension source code"
```

Switch branches: Move to the deployment branch.
```
git checkout gh-pages
```

Transfer files: Copy all contents from your local output folder (bundles/ or dist/) and paste them directly into the 0.8 folder on the gh-pages branch, overwriting the old files.

```
git add 0.8/
git commit -m "Deploy updated extension bundle to 0.8"
git push origin gh-pages
```

# 4. Publishing a ComixTo Release

The full sequence for shipping a ComixTo update (key rotation, fix, or feature), in PowerShell from the repo root.

### 4a. Fix keys (only if comix rotated them)

Symptom: requests fail with 403 `key_retired`, or "API undefined: no message" (an endpoint just became encrypted). These scripts drive a real Chrome; keep runs rare, since comix's WAF captcha-walls IPs that send too much.
```
npm run comix:capture    # build id, key ID in the site's own tokens, WAF status
npm run comix:keys       # extract keys live + regenerate src/ComixTo/ComixFast*.ts
npm run comix:e2e        # verify the generated files against production
```
Usually no hand-written code changes are needed. If `comix:keys` throws, comix changed how the keys are stored. See `experiment/crypto-pipeline/README.md`. The older `crypto:pipeline` / `validate:comix` scripts don't work on apicore builds (2026-10-23 and later).

To watch how often comix rotates keys (writes `experiment/live/monitor.log`, which git ignores):
```
node experiment/live/monitor.mjs [intervalMin=60] [hours=26]
```

### 4b. Bump the version

Bump `version` in `ComixToInfo` in `src/ComixTo/ComixTo.ts`. Paperback only reads that string. `package.json`'s version is unrelated; leave it alone.

### 4c. Build

```
git checkout --no-guess 0.8 --
New-Item -ItemType Directory -Force bundles\0.8
npm install
$env:GITHUB_REPOSITORY = "acepilot147/pb-extensions/0.8"
npm run bundle
```
- The `--` is required. A plain `git checkout 0.8` fails ("could be both a local file and a tracking branch") because a `0.8/` folder also exists.
- The bundler won't create `bundles\0.8` itself and fails with `ENOENT … mkdir` if it's missing.
- To type-check, use `npm run typecheck`. TypeScript was updated to parse the installed Node declarations; errors must not be filtered out.

### 4d. Commit source

```
git add src/
git commit -m "vX.Y.Z: <what changed>"
git push origin 0.8
```

### 4e. Deploy to gh-pages

```
git checkout gh-pages
Copy-Item -Recurse -Force bundles\0.8\* 0.8\
git add 0.8/
git commit -m "vX.Y.Z: <what changed>"
git push origin gh-pages
git checkout --no-guess 0.8 --
```
- **Stage `0.8/` only.** gh-pages has no `.gitignore`, so `node_modules/`, `bundles/` and `package-lock.json` show up as untracked there. Never commit them.
- `index.html` may show as modified with no real diff (CRLF vs LF only). That's harmless.
- GitHub Pages takes about a minute to serve the new `0.8/versioning.json`. Then refresh the repo in Paperback and check that the new version appears.

# Troubleshooting

### Paperback can't reach local server (AsyncOperationTimedOutError)

If Paperback throws `AsyncOperationTimedOutError` when browsing the local repository and the app logs show:

```
_NSURLErrorNWPathKey=unsatisfied (Local network prohibited)
```

iOS is blocking Paperback from accessing the local network. This is an iOS 14+ privacy restriction — third-party apps must be explicitly granted permission to talk to local network addresses, even on the same Wi-Fi. Safari and the browser are exempt so the URL loads fine there but Paperback silently fails.

Fix: **iOS Settings → Privacy & Security → Local Network → Paperback → Enable**

This permission can be silently revoked by iOS updates or after reinstalling the app, so if local testing stops working for no obvious reason, check here first.