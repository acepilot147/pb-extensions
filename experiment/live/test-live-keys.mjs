// Offline E2E of the BUILT Paperback bundle and genuine saved apicore assets.
// No live requests. A fake server rejects the baked key, independently checks
// HMAC tokens, and encrypts every result using the extracted XOR table.
// node experiment/live/test-live-keys.mjs <source.js> <apicore.js> <chunk.js>
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { extractKeys } from './apicore-sandbox.mjs';
import { hmacMidstateSign, xorOffsetEncrypt } from '../crypto-pipeline/lib.mjs';
import { bareRealm, snapshot, assertUnchanged } from './runtime-test-utils.mjs';

const [sourcePath = 'bundles/0.8/ComixTo/source.js', apicorePath = 'experiment/live/assets/apicore-tnfy0u-DTgTZszb.js', chunkPath = 'experiment/live/assets/tnfy0u-B1Ozv2t7.js'] = process.argv.slice(2);
const sourceCode = readFileSync(sourcePath, 'utf8');
const apicoreSrc = readFileSync(apicorePath, 'utf8'), chunkSrc = readFileSync(chunkPath, 'utf8');
const keys = await extractKeys(apicoreSrc, chunkSrc);
assert.notEqual(keys.prefix, '5qj.', 'fixture must differ from baked keys to exercise rotation');
const manifestPath = join(dirname(apicorePath), 'provenance.json');
let pages;
if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    pages = {};
    for (const asset of manifest.assets) {
        const bytes = readFileSync(join(dirname(apicorePath), basename(asset.file)));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, 'fixture integrity: ' + asset.role);
        assert.equal(bytes.length, asset.bytes);
        pages[asset.source_url] = bytes.toString('utf8');
    }
    assert.ok(Object.values(pages).includes(apicoreSrc));
    assert.ok(Object.values(pages).includes(chunkSrc));
} else {
    const dist = 'https://comix.to/assets/build/offline/dist/';
    pages = {
        'https://comix.to/': `<script type="module" src="${dist}main-offline.js"></script>`,
        [dist + 'main-offline.js']: `import{a}from"./${basename(apicorePath)}";`,
        [dist + basename(apicorePath)]: apicoreSrc,
        [dist + basename(chunkPath)]: chunkSrc,
    };
}

function signedMessage(url) {
    const u = new URL(url), groups = Object.create(null), counts = Object.create(null);
    for (const [key, value] of u.searchParams) {
        if (key === '_') continue;
        let base, rendered;
        if (key.endsWith('[]')) { base = key.slice(0, -2); const i = counts[base] ?? 0; counts[base] = i + 1; rendered = `${base}[${i}]=${value}`; }
        else { base = key.split('[')[0]; rendered = `${key}=${value}`; }
        (groups[base] ??= []).push(rendered);
    }
    const q = Object.keys(groups).sort().map(k => groups[k].join('&')).join('&');
    return u.pathname.replace(/^\/api\/v1/, '') + (q ? '?' + q : '');
}
const title = 'héllo ✓ café 中文 😀';
function resultFor(path) {
    if (/\/manga\/[^/]+\/chapters$/.test(path)) return { items: [{ id: 12345, number: 1, name: title, createdAtFormatted: '1 day ago' }], meta: { lastPage: 1 } };
    if (/\/chapters\/[^/]+$/.test(path)) return { pages: { baseUrl: 'https://images.invalid/', items: [{ url: 'one.webp' }, { url: 'two.webp' }] } };
    if (path === '/api/v1/tags/search') return [{ id: 1, label: title }];
    const manga = { hid: 'fixture', title, contentRating: 'safe', status: 'ongoing', synopsis: title };
    if (path === '/api/v1/manga/top') return [manga];
    if (path === '/api/v1/manga') return { items: [manga], meta: { lastPage: 1 } };
    return manga;
}
function boot({ state = new Map(), mode = 'normal' } = {}) {
    if (mode === 'waf') state.set('waf_auto_solve', false); // Test key policy, not captcha solving.
    const log = [], telemetry = [];
    let accepted = 0, rejected = 0;
    const server = request => {
        const u = new URL(request.url);
        log.push(request.url);
        const response = (status, data, headers = {}) => ({ status, data, headers, request });
        if (request.url in pages) return response(200, (mode === 'extraScripts' && request.url === 'https://comix.to/' ? '<script type="module" src="https://analytics.invalid/main-analytics.js"></script>' : '') + pages[request.url], { 'content-type': request.url.endsWith('.js') ? 'application/javascript' : 'text/html' });
        assert.equal(u.origin, 'https://comix.to', 'unexpected outbound origin');
        assert.ok(u.pathname.startsWith('/api/v1/'), 'unexpected request path');
        if (mode === 'waf') return response(403, '{"error":"captcha_required"}');
        if (mode === 'forbidden') return response(403, '{"code":"forbidden"}');
        const signed = /^\/api\/v1\/manga(?:\/|$)/.test(u.pathname) || /^\/api\/v1\/chapters\//.test(u.pathname);
        const expected = hmacMidstateSign(signedMessage(request.url), keys);
        const token = u.searchParams.get('_');
        if (signed) {
            assert.equal(u.searchParams.getAll('_').length, 1, 'exactly one wire token');
            if (token?.startsWith(keys.prefix)) assert.equal(token, expected, 'signature must match independent reference');
            if (mode === 'retired' || (mode !== 'staleTable' && token !== expected)) { rejected++; return response(403, '{"code":"key_retired"}'); }
        } else assert.equal(token, null, 'unsigned endpoints must remain unsigned');
        accepted++;
        const plain = Buffer.from(JSON.stringify({ status: 'ok', result: resultFor(u.pathname) }), 'utf8');
        const cipher = xorOffsetEncrypt(plain, keys.table, [3, 250]); // crosses the table boundary
        return response(200, JSON.stringify({ e: mode === 'corrupt' ? 'not-valid-ciphertext' : Buffer.from(cipher).toString('base64') }), { 'X-Enc': mode === 'unsupported' ? '99' : '2' });
    };
    const App = {
        createSourceStateManager: () => ({ retrieve: async key => state.get(key), store: async (key, value) => { state.set(key, value); } }),
        createRequestManager: options => ({
            getDefaultUserAgent: async () => 'Offline Paperback fixture',
            cookieStore: { getAllCookies: () => [] },
            schedule: async request => {
                if (request.url === 'https://telemetry.comix-ext.workers.dev/log') { telemetry.push(request); return { status: 204, data: '', headers: {}, request }; }
                if (options.interceptor?.interceptRequest) request = await options.interceptor.interceptRequest(request);
                const response = server(request);
                return options.interceptor?.interceptResponse ? options.interceptor.interceptResponse(response) : response;
            },
        }),
    };
    for (const factory of ['createRequest','createChapter','createChapterDetails','createSourceManga','createMangaInfo','createPartialSourceManga','createPagedResults','createHomeSection','createTag','createTagSection','createDUISection','createDUINavigationButton','createDUIForm','createDUISwitch','createDUIBinding','createDUISelect','createDUIInputField','createDUIButton','createDUILabel']) App[factory] = value => value;
    const realm = bareRealm({ App });
    vm.runInContext(sourceCode, realm, { filename: sourcePath, timeout: 15000 });
    const extension = new realm.Sources.ComixTo();
    const before = snapshot(realm);
    return { extension, state, log, telemetry, realm, setMode: value => { mode = value; }, checkIntegrity: () => assertUnchanged(before, snapshot(realm)), counts: () => ({ accepted, rejected }) };
}
const cases = [];
async function check(name, fn) { await fn(); cases.push(name); console.log('PASS ' + name); }
let confirmed;
await check('built source rotates baked key, validates tokens, decrypts Unicode and persists keys', async () => {
    const x = boot();
    const details = await x.extension.getMangaDetails('fixture');
    assert.equal(details.mangaInfo.titles[0], title);
    const [chapters, chapter, search] = await Promise.all([
        x.extension.getChapters('fixture'),
        x.extension.getChapterDetails('fixture', '12345'),
        x.extension.getSearchResults({ title: 'café 中文', includedTags: [{ id: 'genre-1' }, { id: 'genre-2' }] }),
    ]);
    assert.equal(chapters[0].name, title);
    assert.equal(JSON.stringify(chapter.pages), JSON.stringify(['https://images.invalid/one.webp', 'https://images.invalid/two.webp']));
    assert.equal(search.results[0].title, title);
    const sections = [];
    await x.extension.getHomePageSections(section => sections.push(section));
    assert.equal(sections.length, 5);
    assert.ok(sections.every(s => s.items[0].title === title));
    const tags = await x.extension.getSearchTags();
    assert.ok(tags.some(s => s.tags.some(t => t.label === title)));
    assert.equal(x.log.filter(u => u === 'https://comix.to/').length, 1);
    assert.equal(x.log.filter(u => !u.includes('/api/v1/')).length, 4);
    assert.equal(x.counts().rejected, 1);
    const cache = JSON.parse(x.state.get('comix_live_keys_v1'));
    assert.equal(cache.keys.prefix, keys.prefix);
    assert.deepEqual(cache.keys.table, keys.table);
    assert.deepEqual(cache.keys.istate, keys.istate);
    assert.deepEqual(cache.keys.ostate, keys.ostate);
    confirmed = new Map(x.state);
    x.checkIntegrity();
});
await check('tag-filter settings decrypt API results rather than caching empty lists', async () => {
    const state = new Map(confirmed); state.delete('tag_cache_v1');
    const x = boot({ state });
    const rows = await (await x.extension.getSourceMenu()).rows();
    await rows.find(r => r.id === 'tag_filter_settings').form.sections();
    const cache = JSON.parse(state.get('tag_cache_v1'));
    assert.equal(cache.genre[0]?.label, title);
    assert.equal(x.log.filter(u => !u.includes('/api/v1/')).length, 0);
});
await check('unrelated external module scripts never block or leave the allowed discovery chain', async () => {
    const x = boot({ mode: 'extraScripts' });
    assert.equal((await x.extension.getMangaDetails('fixture')).mangaInfo.titles[0], title);
    assert.equal(x.log.filter(u => !u.includes('/api/v1/')).length, 4);
    assert.ok(x.log.every(u => u.startsWith('https://comix.to/')));
    x.checkIntegrity();
});
await check('fresh VM restart reuses persisted keys with zero asset fetches', async () => {
    const x = boot({ state: new Map(confirmed) });
    assert.equal((await x.extension.getMangaDetails('fixture')).mangaInfo.titles[0], title);
    assert.equal(x.log.length, 1);
    assert.equal(x.counts().rejected, 0);
    x.checkIntegrity();
});
await check('decrypt-table rotation refreshes once even when server accepts the signing key', async () => {
    const x = boot({ mode: 'staleTable' });
    assert.equal((await x.extension.getChapterDetails('fixture', '12345')).pages.length, 2);
    assert.equal(x.log.filter(u => u.includes('/api/v1/')).length, 2);
    assert.equal(x.log.filter(u => !u.includes('/api/v1/')).length, 4);
    x.checkIntegrity();
});
await check('corrupted persistent cache safely falls back and recovers', async () => {
    const x = boot({ state: new Map([['comix_live_keys_v1', '{broken']]) });
    assert.equal((await x.extension.getMangaDetails('fixture')).mangaInfo.titles[0], title);
    assert.equal(x.counts().rejected, 1);
});
for (const mode of ['waf','forbidden','unsupported']) await check(`${mode} does not fetch keys or replace confirmed cache`, async () => {
    const state = new Map(confirmed), before = state.get('comix_live_keys_v1');
    const x = boot({ state, mode });
    await assert.rejects(x.extension.getMangaDetails('fixture'));
    assert.equal(x.log.length, 1);
    assert.equal(state.get('comix_live_keys_v1'), before);
});
for (const mode of ['retired','corrupt']) await check(`${mode} response is retried only once and never cached`, async () => {
    const x = boot({ mode });
    await assert.rejects(x.extension.getMangaDetails('fixture'));
    assert.equal(x.log.filter(u => u.includes('/api/v1/')).length, 2);
    assert.equal(x.log.filter(u => !u.includes('/api/v1/')).length, 4);
    assert.equal(x.state.has('comix_live_keys_v1'), false);
    await assert.rejects(x.extension.getMangaDetails('fixture'));
    assert.equal(x.log.filter(u => u.includes('/api/v1/')).length, 4);
    assert.equal(x.log.filter(u => !u.includes('/api/v1/')).length, 8);
    assert.equal(x.state.has('comix_live_keys_v1'), false);
    x.setMode('normal');
    assert.equal((await x.extension.getMangaDetails('fixture')).mangaInfo.titles[0], title);
    assert.equal(x.log.filter(u => !u.includes('/api/v1/')).length, 12);
});
console.log(`\n${cases.length}/${cases.length} offline built-bundle scenarios passed; key=${keys.prefix}; bytes=${Buffer.byteLength(sourceCode)}; live requests=0`);
