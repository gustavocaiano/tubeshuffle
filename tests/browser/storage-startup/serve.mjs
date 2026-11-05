// Test server only: use a disposable/incognito browser profile, never the app origin.
// No production server, credentials, profile directory, database removal or migration.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from './bootstrap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const leaf = 'src/lib/storage/browser-db-target.ts';
const opener = 'src/lib/storage/browser-db.ts';
const entry = 'tests/browser/storage-startup/realm.ts';
const namespace = 'disposable-storage-target';
const source = await readFile(resolve(root, leaf), 'utf8');
// Deliberately strict: a changed production target requires reviewing this guard.
assert.match(source, /export const DB_NAME = "tubeshuffle_local";/);
assert.match(source, /export const DB_VERSION = 1;/);
const production = 'tubeshuffle_local';
const cases = ['guard', 'absent', 'preserved', 'legacy', 'read-failure', 'write-failure',
  'incompatible', 'stale', 'confirm', 'drain', 'export', 'history', 'history-abort'];
const targets = [...cases, 'tabs'];
const names = Object.fromEntries(targets.map(key => [key, `tubeshuffle-startup-test-${randomUUID()}`]));
assert.equal(new Set(Object.values(names)).size, targets.length);
const options = {
  absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
  platform: 'browser', format: 'iife', metafile: true, tsconfig: resolve(root, 'tsconfig.json'),
};
function code(bundle) { return bundle.outputFiles[0].text; }
function guardedCode(bundle) {
  return 'if (!window.__storageGuard) throw new Error("Fixture guard was not installed");\n' + code(bundle);
}
function assertRealCode(bundle) {
  for (const input of [opener, 'src/lib/storage/index.ts', 'src/lib/storage/browser-session.ts', 'src/lib/storage/storage-migrations.ts', 'src/lib/transfer/export.ts', 'src/stores/playlist-store.ts']) {
    assert.ok(bundle.metafile.inputs[input], `Real module absent: ${input}`);
  }
  assert.ok(Object.values(bundle.metafile.outputs).every(output => output.imports.length === 0));
}
// Build WITHOUT substitution, inspect it, and never serve/execute it.
const baseline = await build(options);
assertRealCode(baseline);
assert.ok(baseline.metafile.inputs[leaf]);
assert.ok(code(baseline).includes(`"${production}"`));
const bundles = new Map();
for (const key of targets) {
  let resolutions = 0, loads = 0;
  const plugin = {
    name: 'exact-test-leaf',
    setup(builder) {
      builder.onResolve({ filter: /browser-db-target/ }, async args => {
        assert.equal(args.path, './browser-db-target');
        assert.equal(await realpath(args.importer), await realpath(resolve(root, opener)));
        assert.equal(await realpath(resolve(args.resolveDir, `${args.path}.ts`)), await realpath(resolve(root, leaf)));
        resolutions++;
        return { path: 'target', namespace };
      });
      builder.onLoad({ filter: /^target$/, namespace }, () => {
        loads++;
        return { contents: `export const DB_NAME = ${JSON.stringify(names[key])}; export const DB_VERSION = 1;`, loader: 'js' };
      });
    },
  };
  const bundle = await build({ ...options, plugins: [plugin] });
  assertRealCode(bundle);
  assert.ok(resolutions > 0);
  assert.equal(loads, 1);
  assert.ok(bundle.metafile.inputs[`${namespace}:target`]);
  assert.ok(!bundle.metafile.inputs[leaf]);
  assert.ok(!code(bundle).includes(production));
  assert.ok(code(bundle).includes(names[key]));
  bundles.set(key, guardedCode(bundle));
}
const controller = await build({ ...options, entryPoints: ['tests/browser/storage-startup/scenarios.ts'] });
assert.ok(!Object.keys(controller.metafile.inputs).some(path => path.startsWith('src/')));
const run = randomUUID();
const prefix = `/${run}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const evidence = {
  productionBundleRetainsTarget: true, realModulesIncluded: true, virtualLeafOnly: true,
  productionTargetAbsentFromTestBundles: true, cases: cases.length,
  sourceHashes: Object.fromEntries(await Promise.all([leaf, opener, 'src/lib/storage/index.ts',
    'src/lib/storage/storage-migrations.ts', 'src/lib/storage/browser-session.ts', 'src/lib/storage/browser-provisioning.ts', 'src/stores/playlist-store.ts'].map(async path =>
    [path, hash(await readFile(resolve(root, path)))]))),
};
const csp = "default-src 'none'; script-src 'self'; frame-src 'self'; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
function html(scripts) {
  return '<!doctype html><meta charset="utf-8"><title>Disposable storage fixtures</title>' +
    scripts.map(path => `<script src="${prefix}/${path}"></script>`).join('');
}
const server = createServer((req, res) => {
  if (req.socket.remoteAddress !== '127.0.0.1' || req.method !== 'GET') { res.writeHead(403).end(); return; }
  const path = req.url?.slice(prefix.length);
  if (!req.url?.startsWith(`${prefix}/`)) { res.writeHead(404).end(); return; }
  let body, type = 'text/javascript';
  if (path === '/') { body = html(['boot.js', 'controller.js']); type = 'text/html'; }
  else if (path === '/boot.js') body = bootstrap(Object.values(names), { prefix, cases, evidence, root: true });
  else if (path === '/controller.js') body = guardedCode(controller);
  else {
    const match = /^\/realm\/([a-z-]+)\/(index.html|boot.js|bundle.js)$/.exec(path);
    if (match && bundles.has(match[1])) {
      const [, key, resource] = match;
      if (resource === 'index.html') { body = html([`realm/${key}/boot.js`, `realm/${key}/bundle.js`]); type = 'text/html'; }
      if (resource === 'boot.js') body = bootstrap([names[key]], { key, root: false });
      if (resource === 'bundle.js') body = bundles.get(key);
    }
  }
  if (body === undefined) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }).end(body);
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}${prefix}/`, ...evidence }));
// Browser lifetime belongs to the caller. Close ALL disposable tabs before stopping.
function stop() { server.closeAllConnections(); server.close(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);
setTimeout(stop, 15 * 60_000).unref();
