// One offline release gate; each subprocess has a hard deadline, including
// synchronous downloaded-JS evaluation. No package installation or network.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const [apicore = 'experiment/live/assets/apicore-tnfy0u-DTgTZszb.js', helper = 'experiment/live/assets/tnfy0u-B1Ozv2t7.js'] = process.argv.slice(2);
for (const file of [apicore, helper]) {
    if (!existsSync(resolve(root, file))) throw Error(`Missing real fixture ${file}; see experiment/live/fixture-README.md. This gate never downloads assets or silently skips E2E.`);
}
function run(args) {
    console.log('\n> node ' + args.join(' '));
    const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, GITHUB_REPOSITORY: 'acepilot147/pb-extensions/0.8' }, stdio: 'inherit', timeout: 120000 });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
run([require.resolve('typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json']);
run(['--test', 'experiment/live/test-polyfills.mjs', 'experiment/live/test-crypto-keys.mjs', 'experiment/live/test-key-manager.mjs', 'experiment/live/test-key-retry.mjs', 'experiment/live/test-apicore-guards.mjs']);
run(['experiment/live/test-apicore-jsc.mjs', apicore, helper]);
mkdirSync(resolve(root, 'bundles/0.8'), { recursive: true });
run([require.resolve('@paperback/toolchain/bin/run'), 'bundle', '--folder', '0.8']);
run(['experiment/live/test-live-keys.mjs', 'bundles/0.8/ComixTo/source.js', apicore, helper]);
console.log(`\nVERIFIED: ${statSync(resolve(root, 'bundles/0.8/ComixTo/source.js')).size} byte bundle; no deployment performed.`);
