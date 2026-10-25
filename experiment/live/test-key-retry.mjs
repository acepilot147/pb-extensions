// Policy/integration tests; crypto and extraction are boundary stubs here.
// Real cryptography and real downloaded assets are exercised by test-live-keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const root = 'https://comix.to/assets/build/test/dist/';
const rotated = { prefix: 'new.', macBytes: 12, istate: Array(8).fill(1), ostate: Array(8).fill(2), table: Array(1024).fill(3) };
function setup({ state = new Map(), mode = 'rotate' } = {}) {
    const calls = [], modules = {}, telemetry = [];
    let active = 'new.';
    const App = { createSourceStateManager: () => ({ retrieve: async k => state.get(k), store: async (k,v) => state.set(k,v) }), createRequest: r => r };
    const realm = vm.createContext({ App });
    const pages = {
        'https://comix.to/': `<script type="module" src="${root}main-xyz.js"></script>`,
        [`${root}main-xyz.js`]: 'import {a} from "./apicore-test-xyz.js";',
        [`${root}apicore-test-xyz.js`]: 'import{a}from"./helpers-xyz.js";export{a};',
        [`${root}helpers-xyz.js`]: 'const a=1;export{a};',
    };
    const manager = { schedule: async request => {
        const url = request.url;
        calls.push(url);
        if (url in pages) return { status: 200, data: pages[url], headers: {}, request };
        assert.ok(url.startsWith('https://comix.to/api/v1/'));
        const token = new URL(url).searchParams.get('_');
        const error = (code, status=403) => ({ status, data: JSON.stringify({ code }), headers: {}, request });
        if (mode === 'waf') return { status: 403, data: '{"error":"captcha_required"}', headers: {}, request };
        if (mode === 'other403') return error('forbidden');
        if (mode === 'serverError') return error('unavailable', 500);
        if (mode === 'alwaysRetired' || (mode !== 'decrypt' && !token?.startsWith(active))) return error('key_retired');
        return { status: 200, data: JSON.stringify({ e: mode === 'malformedEnvelope' ? 5 : 'encrypted' }), headers: { 'X-Enc': mode === 'unsupported' ? '99' : '2' }, request };
    }, cookieStore: { getAllCookies: () => [] } };
    const overrides = {
        '@paperback/types': { Source: class {}, ContentRating: {}, BadgeColor: {}, SourceIntents: {} },
        './Parser': { Parser: class {} }, './Settings': {}, './Common': { DOMAIN: 'https://comix.to', API_BASE: 'https://comix.to/api/v1' },
        './ComixDescramble': {}, './ComixTileB': {}, './DebugLog': { DEBUG: false },
        './ComixFastSigner': { fastGenerateHash: (_, keys) => (keys?.prefix ?? 'old.') + 'signature' },
        './ComixFastDecrypt': { fastDecryptComixPayload: (_, payload, headers, table) => {
            if (headers['X-Enc'] !== '2') throw Error('unsupported cipher');
            if (table?.[0] !== 3) throw Error('invalid ciphertext');
            return mode === 'apiError' ? { status: 'error', message: 'API rejected request' } : { recovered: true };
        } },
        './Telemetry': { emit: event => telemetry.push(event) },
        './WafSolver': { solveWafCaptcha: async () => { throw Error('unexpected WAF solver'); } },
        './ComixApicore': { apicoreImport: s => /from"([^"]+)"/.exec(s)?.[1], extractApicoreKeys: async () => rotated },
    };
    function load(name) {
        if (name in overrides) return overrides[name];
        if (name in modules) return modules[name];
        const src = readFileSync(new URL(`../../src/ComixTo/${name.replace('./','')}.ts`, import.meta.url), 'utf8');
        const code = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
        const exports = modules[name] = {};
        vm.runInContext(`(function(exports,require){${code}\n})`, realm)(exports, load);
        return exports;
    }
    return { hash: load('./ComixHash'), sourceClass: load('./ComixTo').ComixTo, manager, calls, state, telemetry, setMode: value => { mode = value; } };
}

test('key_retired rotates once, re-signs queued requests, decrypts and persists', async () => {
    const x = setup();
    const urls = ['/manga/one', '/chapters/2', '/manga?keyword=caf%C3%A9&genres_in[]=1&genres_in[]=2'].map(p => 'https://comix.to/api/v1' + p);
    const values = await Promise.all(urls.map(url => x.hash.fetchSigned(x.manager, url)));
    assert.equal(JSON.stringify(values), JSON.stringify(Array(3).fill({ recovered: true })));
    assert.equal(x.calls.filter(u => u === 'https://comix.to/').length, 1);
    const api = x.calls.filter(u => u.includes('/api/v1/'));
    assert.equal(api.length, 4);
    assert.match(api[0], /_=old\./);
    assert.ok(api.slice(1).every(u => /_=new\./.test(u)));
    assert.equal(x.state.size, 1);
    const restart = setup({ state: x.state });
    await restart.hash.fetchSigned(restart.manager, urls[0]);
    assert.equal(restart.calls.length, 1, 'restart must not fetch homepage or JS');
    assert.match(restart.calls[0], /_=new\./);
});

test('homepage/search/details timed fetch uses the same rotation path', async () => {
    const x = setup();
    const result = await x.sourceClass.prototype.fetchTimed.call({ requestManager: x.manager, checkResponseError: () => {} }, 'search', 'https://comix.to/api/v1/manga?keyword=test');
    assert.equal(result.recovered, true);
    assert.equal(x.state.size, 1);
    assert.equal(x.telemetry.at(-1).label, 'search');
});

test('supported encrypted response with a stale table refreshes once and decrypts the retry', async () => {
    const x = setup({ mode: 'decrypt' });
    assert.equal((await x.hash.fetchSigned(x.manager, 'https://comix.to/api/v1/manga/one')).recovered, true);
    assert.equal(x.calls.filter(u => u.includes('/api/v1/')).length, 2);
    assert.equal(x.calls.filter(u => u === 'https://comix.to/').length, 1);
    assert.equal(x.state.size, 1);
});

for (const mode of ['waf', 'other403', 'serverError']) test(`${mode} does not trigger key discovery`, async () => {
    const x = setup({ mode });
    await assert.rejects(x.hash.fetchSigned(x.manager, 'https://comix.to/api/v1/manga/one'));
    assert.equal(x.calls.length, 1);
    assert.equal(x.state.size, 0);
});

test('an unsuccessful key retry is bounded and never persists the candidate', async () => {
    const x = setup({ mode: 'alwaysRetired' });
    await assert.rejects(x.hash.fetchSigned(x.manager, 'https://comix.to/api/v1/manga/one'), /HTTP 403/);
    assert.equal(x.calls.filter(u => u.includes('/api/v1/')).length, 2);
    assert.equal(x.state.size, 0);
    await assert.rejects(x.hash.fetchSigned(x.manager, 'https://comix.to/api/v1/manga/one'), /HTTP 403/);
    assert.equal(x.calls.filter(u => u === 'https://comix.to/').length, 2);
    assert.equal(x.calls.filter(u => u.includes('/api/v1/')).length, 4);
    assert.equal(x.state.size, 0);
    x.setMode('rotate');
    assert.equal((await x.hash.fetchSigned(x.manager, 'https://comix.to/api/v1/manga/one')).recovered, true);
    assert.equal(x.calls.filter(u => u === 'https://comix.to/').length, 3);
});

test('re-signing replaces every old token without changing other query values', () => {
    const x = setup();
    const url = 'https://comix.to/api/v1/manga?keyword=caf%C3%A9&_=stale&genres_in[]=1&%5F=other';
    const signed = x.hash.signUrl(url, rotated);
    assert.deepEqual(new URL(signed).searchParams.getAll('_'), ['new.signature']);
    assert.match(signed, /keyword=caf%C3%A9/);
    assert.match(signed, /genres_in\[\]=1/);
    assert.equal(x.hash.signUrl('https://comix.to/api/v1/tags/search?type=genre'), 'https://comix.to/api/v1/tags/search?type=genre');
});

test('nonstring encrypted envelopes never confirm a candidate', async () => {
    const x = setup({ mode: 'malformedEnvelope' });
    await assert.rejects(x.hash.fetchSigned(x.manager, 'https://comix.to/api/v1/manga/one'), /encrypted envelope/);
    assert.equal(x.state.size, 0);
});

test('decrypted API errors are not treated as successful key confirmation', async () => {
    const x = setup({ mode: 'apiError' });
    await assert.rejects(x.hash.fetchSigned(x.manager, 'https://comix.to/api/v1/manga/one'), /Comix API error: API rejected request/);
    assert.equal(x.state.size, 0);
    const initial = setup();
    await initial.hash.fetchSigned(initial.manager, 'https://comix.to/api/v1/manga/one');
    const confirmed = setup({ mode: 'apiError', state: initial.state });
    await assert.rejects(confirmed.hash.fetchSigned(confirmed.manager, 'https://comix.to/api/v1/manga/one'), /Comix API error/);
    assert.equal(confirmed.calls.length, 1, 'a decoded API error is not a stale-key signal');
});
