import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bareRealm, loadTs } from './runtime-test-utils.mjs';

const api = () => loadTs(bareRealm(), 'ComixApicore');
test('rejects unsupported module formats instead of executing extra imports', () => {
    const { moduleBody } = api();
    assert.throws(() => moduleBody('export default 1'), /no trailing export/);
    assert.throws(() => moduleBody('import x from "./other.js";export{x};'), /unexpected extra imports/);
    assert.throws(() => moduleBody('import("https://other.invalid/a.js");const x=1;export{x};'), /unexpected extra imports/);
});
test('helper chunk sees the same fake global as apicore', async () => {
    await assert.rejects(api().extractApicoreKeys('import{n}from"./helper.js";if(n!==globalThis)throw Error("helper escaped fake global");const x=1;export{x};', 'const n=globalThis;export{n};'), /no signing client found/);
});
test('a non-settling API cannot hang extraction forever', { timeout: 2000 }, async () => {
    await assert.rejects(api().extractApicoreKeys('new Proxy({get:()=>new Promise(()=>{})},{});const x=1;export{x};', 'const n=1;export{n};'), /no signing client found/);
});

test('both modules shadow direct access to the Paperback App global', async () => {
    const realm = bareRealm({ App: { sentinel: true } });
    const { extractApicoreKeys } = loadTs(realm, 'ComixApicore');
    const guard = 'if(typeof App!=="undefined")throw Error("real App exposed");const n=1;export{n};';
    await assert.rejects(extractApicoreKeys(guard, 'const n=1;export{n};'), /no signing client found/);
    await assert.rejects(extractApicoreKeys('const n=1;export{n};', guard), /no signing client found/);
});

test('observed buffers, API tables and probe attempts have resource caps', async () => {
    for (const source of [
        'for(let i=0;i<257;i++)new Uint8Array(1088);',
        'for(let i=0;i<129;i++)new Proxy({get:()=>1},{});',
        'const t={};for(let i=0;i<257;i++)t[i]=()=>1;new Proxy(t,{});',
    ]) await assert.rejects(api().extractApicoreKeys(source+'const n=1;export{n};', 'const n=1;export{n};'), /resource limit/);
});
