/**
 * Console snippet for catching how comix.to's secure-*.js decrypts response
 * bodies. Paste into the dev-tools console on https://comix.to/ BEFORE
 * triggering a signed request (e.g. before opening a title page or hitting
 * "Read"). Then trigger one — for example, navigate to:
 *   https://comix.to/title/mr3m0-the-forgotten-field
 *
 * What gets logged:
 *   1. WebCrypto: every crypto.subtle.* call (encrypt / decrypt / importKey /
 *      digest / sign / verify / derive*).  If the bundle uses WebCrypto, you
 *      will see the algorithm name, key bytes, IV, ciphertext, and plaintext.
 *   2. CryptoJS: AES.decrypt / AES.encrypt if window.CryptoJS is exposed.
 *      Also lazy-detects in case the bundle attaches it after page load.
 *   3. fetch + XMLHttpRequest: the URL and full body of every /api/v1/*
 *      response — that's the encrypted {"e":"..."} blob.
 *   4. JSON.parse: catches the decrypted plaintext at the moment the bundle
 *      parses it back into a JS object — works even if the bundle rolled its
 *      own AES (no WebCrypto / CryptoJS calls to hook).
 *
 * After pasting, look in the console for "[crypto-trap]". If WebCrypto fires,
 * the importKey input is the AES key — copy its 32 bytes; the decrypt input
 * is { iv, ciphertext }; the result is the plaintext JSON. If only the
 * fetch + JSON.parse traps fire, the bundle is doing it in pure JS — at
 * least you'll have the (encrypted-in, plaintext-out) pair to start
 * differential analysis against the captured 10 long keys (atob harness
 * already showed the bundle uses them in reverse for response decoding).
 */
(() => {
    const TAG   = "%c[crypto-trap]";
    const STYLE = "color:#0bf;font-weight:bold";

    const asU8 = (x) => {
        if (x instanceof ArrayBuffer) return new Uint8Array(x);
        if (ArrayBuffer.isView(x))    return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
        return null;
    };
    const hexOf = (u, n = 32) => Array.from(u.slice(0, n)).map(b => b.toString(16).padStart(2, "0")).join("") + (u.length > n ? "…" : "");
    const b64Of = (u, n = 48) => { try { return btoa(String.fromCharCode(...u.slice(0, n))) + (u.length > n ? "…" : ""); } catch { return "<b64-err>"; } };
    const summary = (x) => {
        const u = asU8(x);
        if (u) return `<${u.length}B hex=${hexOf(u)} b64=${b64Of(u)}>`;
        return x;
    };

    // ---- 1. WebCrypto ----------------------------------------------------
    if (globalThis.crypto?.subtle) {
        for (const m of ["encrypt", "decrypt", "sign", "verify", "importKey", "exportKey", "deriveKey", "deriveBits", "digest", "wrapKey", "unwrapKey"]) {
            if (typeof crypto.subtle[m] !== "function") continue;
            const orig = crypto.subtle[m].bind(crypto.subtle);
            crypto.subtle[m] = (...args) => {
                console.log(TAG, STYLE, `subtle.${m}(`, ...args.map(summary), `)`);
                const p = orig(...args);
                if (p && typeof p.then === "function") {
                    return p.then(r => { console.log(TAG, STYLE, `subtle.${m} → result`, summary(r)); return r; })
                            .catch(e => { console.log(TAG, STYLE, `subtle.${m} → error`, e); throw e; });
                }
                return p;
            };
        }
        console.log(TAG, STYLE, "WebCrypto hooks installed");
    } else {
        console.log(TAG, STYLE, "no crypto.subtle on this page");
    }

    // ---- 2. CryptoJS (hook now if present, else poll briefly) -----------
    const hookCryptoJS = () => {
        const C = globalThis.CryptoJS;
        if (!C?.AES || C.AES.__trapped) return !!C?.AES;
        const oD = C.AES.decrypt, oE = C.AES.encrypt;
        C.AES.decrypt = function (...a) {
            console.log(TAG, STYLE, "CryptoJS.AES.decrypt args:", a);
            const r = oD.apply(this, a);
            try { console.log(TAG, STYLE, "  → utf8:", r.toString(C.enc.Utf8).slice(0, 300)); } catch {}
            try { console.log(TAG, STYLE, "  → hex :", r.toString(C.enc.Hex).slice(0, 96)); } catch {}
            return r;
        };
        C.AES.encrypt = function (...a) {
            console.log(TAG, STYLE, "CryptoJS.AES.encrypt args:", a);
            return oE.apply(this, a);
        };
        C.AES.__trapped = true;
        console.log(TAG, STYLE, "CryptoJS hooks installed");
        return true;
    };
    if (!hookCryptoJS()) {
        let tries = 0;
        const id = setInterval(() => { if (hookCryptoJS() || ++tries > 60) clearInterval(id); }, 500);
    }

    // ---- 3. fetch --------------------------------------------------------
    const _fetch = globalThis.fetch;
    if (_fetch) {
        globalThis.fetch = async (...args) => {
            const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
            const isApi = url.includes("/api/v1/");
            if (isApi) console.log(TAG, STYLE, "fetch →", url);
            const res = await _fetch(...args);
            if (isApi) {
                res.clone().text()
                    .then(t => console.log(TAG, STYLE, "fetch ← body:", t.length > 400 ? t.slice(0, 400) + "…" : t))
                    .catch(() => {});
            }
            return res;
        };
    }

    // ---- 4. XHR (axios uses this) ---------------------------------------
    const xo = XMLHttpRequest.prototype.open;
    const xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__trap_url = url;
        return xo.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const url = this.__trap_url ?? "";
        if (typeof url === "string" && url.includes("/api/v1/")) {
            console.log(TAG, STYLE, "xhr →", url);
            this.addEventListener("load", () => {
                const t = String(this.responseText ?? "");
                console.log(TAG, STYLE, "xhr ← body:", t.length > 400 ? t.slice(0, 400) + "…" : t);
            });
        }
        return xs.call(this, body);
    };

    // ---- 5. JSON.parse (catches plaintext after decrypt, even if pure JS)
    const _parse = JSON.parse;
    JSON.parse = function (s, ...rest) {
        if (typeof s === "string") {
            if (s.includes('"e":"')) {
                console.log(TAG, STYLE, "JSON.parse encrypted-in:", s.length, "bytes, head:", s.slice(0, 200));
            } else if (s.length > 200 && s[0] === "{") {
                console.log(TAG, STYLE, "JSON.parse plaintext-out (likely):", s.slice(0, 300));
            }
        }
        return _parse.call(this, s, ...rest);
    };

    console.log(TAG, STYLE, "all traps armed — trigger a signed request now (e.g. open a title page).");
})();
