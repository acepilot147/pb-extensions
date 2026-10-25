// Shared test-only bare-runtime loader/integrity assertions. Node vm emulates
// missing browser APIs; it is NOT a security boundary for hostile JavaScript.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

export function bareRealm(globals = {}) {
    const realm = vm.createContext(globals);
    assert.equal(vm.runInContext(`['URL','URLSearchParams','TextEncoder','TextDecoder','atob','btoa','Blob','Buffer','setTimeout','setInterval','process','require','fetch'].filter(n => typeof globalThis[n] !== 'undefined').length`, realm), 0);
    return realm;
}
export function loadTs(realm, name, cache = new Map()) {
    if (cache.has(name)) return cache.get(name);
    assert.match(name, /^Comix[A-Za-z]+$/);
    const src = readFileSync(new URL(`../../src/ComixTo/${name}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = vm.runInContext('({ exports: {} })', realm);
    cache.set(name, module.exports);
    vm.runInContext(`(function(exports,require,module){${code}\n})`, realm, { filename: name + '.ts' })(module.exports, r => loadTs(realm, r.replace('./', ''), cache), module);
    return module.exports;
}
export function snapshot(realm) {
    const targets = vm.runInContext(`(() => {
        const out = [globalThis];
        for (const n of ['Object','Array','Function','String','Number','Boolean','Promise','JSON','Math','Reflect','Symbol','Uint8Array','Uint32Array','ArrayBuffer','DataView','RegExp','Date','Map','Set','Proxy','Error','TypeError']) {
            const v = globalThis[n]; out.push(v); if (v.prototype) out.push(v.prototype);
        }
        out.push(Object.getPrototypeOf(Uint8Array), Object.getPrototypeOf(Uint8Array.prototype));
        return out;
    })()`, realm);
    // Host intrinsics inspect descriptors without invoking test-realm getters.
    return Array.from(targets, target => ({ target, proto: Object.getPrototypeOf(target), descriptors: Object.getOwnPropertyDescriptors(target) }));
}
export function assertUnchanged(before, after) {
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
        const a = before[i], b = after[i];
        assert.equal(b.target, a.target, `built-in target ${i} replaced`);
        assert.equal(b.proto, a.proto, `built-in prototype ${i} changed`);
        assert.deepEqual(Reflect.ownKeys(b.descriptors), Reflect.ownKeys(a.descriptors), `built-in keys ${i} changed`);
        for (const key of Reflect.ownKeys(a.descriptors)) {
            const da = a.descriptors[key], db = b.descriptors[key];
            for (const field of ['value','get','set','writable','enumerable','configurable']) {
                assert.ok(Object.is(da[field], db[field]), `built-in ${i}.${String(key)} descriptor ${field} changed`);
            }
        }
    }
}
