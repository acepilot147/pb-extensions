// Unit tests of discovery/cache policy. Extraction is stubbed at the module
// boundary here; the real extractor and built bundle have separate E2E gates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = new URL('../../src/ComixTo/ComixKeyManager.ts', import.meta.url);
const keys = () => ({ prefix: 'new.', macBytes: 12, istate: Array(8).fill(1), ostate: Array(8).fill(2), table: Array.from({ length: 1024 }, (_, i) => i % 256) });
const root = 'https://comix.to/assets/build/test/dist/';
function setup({ stored, extraction = keys, storeError = false } = {}) {
    let value = stored, extracts = 0, reads = 0, writes = 0, now = 100000;
    const realm = vm.createContext({});
    assert.ok(existsSync(source), 'ComixKeyManager implementation must exist');
    const code = ts.transpileModule(readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    vm.runInContext(`(function(exports, require){${code}\n})`, realm)(exports, (name) => {
        assert.equal(name, './ComixApicore');
        return {
            apicoreImport: s => /from"([^"]+)"/.exec(s)?.[1] ?? null,
            extractApicoreKeys: async () => { extracts++; return extraction(); },
        };
    });
    const state = { retrieve: async () => { reads++; return value; }, store: async (_, v) => { writes++; if (storeError) throw Error('disk full'); value = v; } };
    const manager = new exports.ComixKeyManager(state, () => now);
    const urls = [];
    const pages = {
        'https://comix.to/': `<script type="module" src="${root}main-xyz.js"></script>`,
        [`${root}main-xyz.js`]: 'import {a} from "./apicore-test-xyz.js";',
        [`${root}apicore-test-xyz.js`]: 'import{a}from"./helpers-xyz.js";export{a};',
        [`${root}helpers-xyz.js`]: 'const a=1;export{a};',
    };
    const fetch = async url => { urls.push(url); assert.ok(url in pages, `unexpected URL ${url}`); return pages[url]; };
    return { manager, state, fetch, pages, urls, exports, counts: () => ({ extracts, reads, writes }), stored: () => value };
}

test('discover, validate, activate atomically, then reuse persisted keys after restart', async () => {
    const x = setup();
    assert.equal(await x.manager.current(), undefined);
    const candidate = await x.manager.discover(x.fetch);
    assert.equal(candidate.keys.prefix, 'new.');
    assert.equal(await x.manager.current(), undefined, 'unconfirmed candidate must not replace active keys');
    assert.equal(x.counts().writes, 0);
    await x.manager.activate(candidate);
    assert.equal((await x.manager.current()).keys.prefix, 'new.');
    assert.equal(x.counts().writes, 1);
    assert.equal(x.urls.length, 4);
    const restart = setup({ stored: x.stored() });
    assert.equal((await restart.manager.current()).keys.prefix, 'new.');
    assert.deepEqual(restart.urls, []);
    assert.equal(restart.counts().extracts, 0);
});

test('concurrent refreshes share one discovery and later requests can refresh immediately', async () => {
    const x = setup();
    const [a, b] = await Promise.all([x.manager.discover(x.fetch), x.manager.discover(x.fetch)]);
    assert.equal(a, b);
    assert.equal(x.urls.length, 4);
    const next = await x.manager.discover(x.fetch);
    assert.equal(next.fetchedAt, a.fetchedAt, 'no clock advance or cooldown required');
    assert.equal(x.urls.length, 8);
});

test('failed discovery can recover immediately once an oversized asset is repaired', async () => {
    const x = setup();
    x.pages[`${root}main-xyz.js`] = 'x'.repeat(3 * 1024 * 1024 + 1);
    await assert.rejects(x.manager.discover(x.fetch), /too large/);
    x.pages[`${root}main-xyz.js`] = 'import {a} from "./apicore-test-xyz.js";';
    assert.equal((await x.manager.discover(x.fetch)).keys.prefix, 'new.');
    assert.equal(x.counts().writes, 0);
});

for (const stored of ['{broken', JSON.stringify({ schema: 99 }), JSON.stringify({ schema: 1, assetUrl: root + 'apicore-test-xyz.js', fetchedAt: 1, keys: { ...keys(), table: [999] } })]) {
    test('ignores malformed/incompatible cache without network: ' + stored.slice(0, 35), async () => {
        const x = setup({ stored });
        assert.equal(await x.manager.current(), undefined);
        assert.deepEqual(x.urls, []);
    });
}

for (const url of ['https://evil.invalid/main-x.js', '//evil.invalid/main-x.js', '/@waf/main-x.js', '/assets/%2e%2e/main-x.js']) {
    test('rejects untrusted discovery asset ' + url, async () => {
        const x = setup();
        x.pages['https://comix.to/'] = `<script type="module" src="${url}"></script>`;
        await assert.rejects(x.manager.discover(x.fetch), /not allowed/);
        assert.deepEqual(x.urls, ['https://comix.to/']);
        assert.equal(x.counts().extracts, 0);
    });
}

test('ignores unrelated external module tags before or after the real main', async () => {
    for (const first of [true, false]) {
        const x = setup();
        const real = x.pages['https://comix.to/'];
        const external = '<script type="module" src="https://cdn.example.invalid/main-analytics.js"></script>';
        x.pages['https://comix.to/'] = first ? external + real : real + external;
        const record = await x.manager.discover(x.fetch);
        assert.equal(record.keys.prefix, 'new.');
        assert.deepEqual(x.urls, ['https://comix.to/', `${root}main-xyz.js`, `${root}apicore-test-xyz.js`, `${root}helpers-xyz.js`]);
    }
});

for (const kind of ['main', 'helper']) test(`rejects off-origin ${kind} dependencies and identifies the rejected host`, async () => {
    const x = setup();
    if (kind === 'main') x.pages[`${root}main-xyz.js`] = 'import{a}from"https://cdn.example.invalid/assets/apicore-test-x.js";';
    else x.pages[`${root}apicore-test-xyz.js`] = 'import{a}from"https://cdn.example.invalid/assets/helper-x.js";export{a};';
    await assert.rejects(x.manager.discover(x.fetch), /origin is not allowed.*cdn\.example\.invalid/);
    assert.ok(x.urls.every(u => u.startsWith('https://comix.to/')));
});

test('failed extraction leaves the good persisted record untouched', async () => {
    const initial = setup();
    await initial.manager.activate(await initial.manager.discover(initial.fetch));
    const x = setup({ stored: initial.stored(), extraction: () => { throw Error('token mismatch'); } });
    const before = await x.manager.current();
    await assert.rejects(x.manager.discover(x.fetch), /token mismatch/);
    assert.equal(await x.manager.current(), before);
    assert.equal(x.stored(), initial.stored());
    assert.equal(x.counts().writes, 0);
});

test('object-valued caches with sparse arrays fall back instead of breaking signing', async () => {
    for (const field of ['istate','ostate','table']) {
        const k = keys(); k[field] = Array(field === 'table' ? 1024 : 8);
        const x = setup({ stored: { schema: 1, assetUrl: root + 'apicore-test-xyz.js', fetchedAt: 1, keys: k } });
        assert.equal(await x.manager.current(), undefined);
    }
});

test('persistent storage failure does not discard confirmed in-memory keys', async () => {
    const x = setup({ storeError: true });
    await x.manager.activate(await x.manager.discover(x.fetch));
    assert.equal((await x.manager.current()).keys.prefix, 'new.');
});
