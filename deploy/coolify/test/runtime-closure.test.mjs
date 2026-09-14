import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runtimeClosure, stage } from '../stage-workspaces.mjs';
import { reconcileWorkspaceLinks } from '../prune-workspace-links.mjs';
import { assertImageContent } from '../assert-image-content.mjs';

function fixture(t) {
  // Inside this clone so mutation modules resolve the build-only TS parser.
  const root = mkdtempSync(resolve('.runtime-closure-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value)); };
  const packages = {};
  for (const [name, path, dependencies] of [
    ['gateway', 'apps/gateway', { '@test/a': '*' }], ['a', 'packages/a', { '@test/b': '*' }],
    ['b', 'packages/b', {}], ['unused', 'packages/unused', {}],
  ]) {
    packages[`node_modules/@test/${name}`] = { link: true, resolved: path };
    put(`${path}/package.json`, { name: `@test/${name}`, main: './dist/index.js', dependencies });
    put(`${path}/dist/index.js`, 'export const value = 1;');
  }
  put('apps/gateway/dist/index.js', "import '@test/a';");
  put('packages/a/dist/index.js', "export * from '@test/b';");
  put('package-lock.json', { packages });
  return { root, put };
}
const names = result => result.packages.map(pkg => pkg.name);
const compute = (fn, root) => names(fn(root, ['apps/gateway/dist/index.js']));
const baseline = ['@test/a', '@test/b', '@test/gateway'];

export function dependencyAssertions(fn, { root, put }) {
  assert.deepEqual(compute(fn, root), baseline, 'CLOSURE_TRANSITIVE: include reachable dependencies and exclude unrelated packages');
  put('packages/b/package.json', { name: '@test/b', main: './dist/index.js', dependencies: { '@test/unused': '*' } });
  put('packages/b/dist/index.js', "import('@test/unused');");
  assert.ok(compute(fn, root).includes('@test/unused'), 'CLOSURE_ADD_RUNTIME: newly referenced transitive dependency enters');
  put('packages/b/package.json', { name: '@test/b', main: './dist/index.js', dependencies: {} });
  put('packages/b/dist/index.js', 'export const value = 1;');
  assert.deepEqual(compute(fn, root), baseline, 'CLOSURE_REMOVE_RUNTIME: removed transitive dependency leaves');
  put('packages/a/package.json', { name: '@test/a', main: './dist/index.js', devDependencies: { '@test/b': '*' } });
  assert.deepEqual(compute(fn, root), baseline, 'CLOSURE_IMPORTED_DEV: imported code remains needed regardless of dependency classification');
  put('packages/a/dist/index.js', 'export const value = 1;');
  assert.deepEqual(compute(fn, root), ['@test/a', '@test/gateway'], 'CLOSURE_DEV_ONLY: unimported devDependency is excluded');
}
test('runtime closure follows transitive dependencies and add/remove/devDependency mutations', t => dependencyAssertions(runtimeClosure, fixture(t)));
test('runtime closure follows emitted relative imports and worker URLs without unrelated output', t => {
  const { root, put } = fixture(t);
  put('apps/gateway/dist/index.js', "import '../../../packages/unused/dist/index.js'; new URL('./worker.js', import.meta.url);");
  put('apps/gateway/dist/worker.js', "export * from '../../../packages/b/dist/index.js';");
  put('dist/unrelated/index.js', 'throw new Error("must not ship");');
  const result = runtimeClosure(root, ['apps/gateway/dist/index.js']);
  assert.ok(names(result).includes('@test/unused'), 'CLOSURE_RELATIVE: relative import grants runtime membership');
  assert.ok(result.code.includes('apps/gateway/dist/worker.js'), 'CLOSURE_WORKER: worker URL is traversed');
  assert.ok(!result.code.includes('dist/unrelated/index.js'), 'CLOSURE_UNUSED_OUTPUT: unrelated compiled output is excluded');
});
test('runtime closure fails closed on nonliteral dynamic imports', t => {
  const { root, put } = fixture(t);
  put('apps/gateway/dist/index.js', 'import(process.env.MODULE);');
  assert.throws(() => runtimeClosure(root, ['apps/gateway/dist/index.js']), /nonliteral runtime import/);
});

for (const [name, from, to, assertion] of [
  ['ignore added runtime dependency', 'else packageEntry(value, mode);', "else if (value !== '@test/unused') packageEntry(value, mode);", 'CLOSURE_ADD_RUNTIME'],
  ['retain removed runtime dependency', 'const packages = new Set(),', 'const packages = new Set(),', 'CLOSURE_REMOVE_RUNTIME'],
  ['follow devDependencies', 'packages.add(name);', "packages.add(name); for (const dependency of Object.keys(workspaces.get(name).manifest.devDependencies ?? {})) { include(dependency); pending.push(workspaces.get(dependency).path + '/dist/index.js'); }", 'CLOSURE_DEV_ONLY'],
]) test(`runtime closure mutation killed: ${name}`, async t => {
  const data = fixture(t);
  let source = readFileSync(new URL('../stage-workspaces.mjs', import.meta.url), 'utf8');
  if (name === 'retain removed runtime dependency') {
    source = source.replace('export function runtimeClosure', 'const retained = new Set();\nexport function runtimeClosure').replace('const packages = new Set(),', 'const packages = new Set(retained),').replace('return { packages:', 'for (const name of packages) retained.add(name);\n  return { packages:');
    // Cache only the optional leaf, so baseline packages still traverse normally.
    source = source.replace('new Set(retained)', "new Set([...retained].filter(name => name === '@test/unused'))");
  } else { assert.ok(source.includes(from)); source = source.replace(from, to); }
  data.put('mutant.mjs', source);
  const mutant = await import(pathToFileURL(resolve(data.root, 'mutant.mjs')));
  assert.throws(() => dependencyAssertions(mutant.runtimeClosure, data), error => {
    assert.equal(error.name, 'AssertionError');
    assert.ok(error.message.includes(assertion), error.message);
    console.log(`KILLED ${name}: AssertionError [${assertion}]`);
    return true;
  });
});

function stagedFixture(t) {
  const data = fixture(t);
  data.put('dist/apps/gateway/src/index.js', "import '@test/a';");
  data.put('packages/db/dist/migrate.js', 'export const migrate = true;');
  data.put('packages/db/migrations/001.sql', 'SELECT 1;');
  for (const file of ['packages/a/src/secret.ts', 'packages/a/test/a.test.js', 'packages/a/dist/index.js.map', 'packages/a/dist/index.d.ts', 'packages/a/.env', 'packages/a/docs/readme.md', 'dist/apps/worker/src/index.js']) data.put(file, 'excluded');
  data.put('node_modules/external/index.js', 'module.exports = {};');
  data.put('node_modules/external/index.d.ts', 'excluded');
  data.put('node_modules/external/index.js.map', 'excluded');
  data.put('node_modules/external/test/test.js', 'excluded');
  const destination = resolve(data.root, 'staged');
  const closure = stage(data.root, destination);
  reconcileWorkspaceLinks(destination, closure);
  return { ...data, destination, closure };
}
test('staging bounds manifests emitted JavaScript and SQL migrations and excludes source tests credentials and unused output', t => {
  const { root, destination } = stagedFixture(t);
  const inventory = assertImageContent(destination);
  assert.equal(inventory.typescript + inventory.maps + inventory.tests, 0, 'STAGE_CLASSES: prohibited classes are absent');
  assert.equal(existsSync(resolve(root, 'node_modules/external/index.d.ts')), false, 'STAGE_EXTERNAL: third-party declarations removed');
  assert.equal(existsSync(resolve(destination, 'packages/a/.env')), false, 'STAGE_CREDENTIALS: credentials never staged');
  assert.equal(existsSync(resolve(destination, 'dist/apps/worker/src/index.js')), false, 'STAGE_UNUSED: worker not shipped');
});
for (const [name, file, expected] of [
  ['TypeScript source', 'node_modules/external/leak.ts', 'IMAGE_CONTENT_CLASSES'],
  ['source map', 'node_modules/external/leak.js.map', 'IMAGE_CONTENT_CLASSES'],
  ['test file', 'node_modules/external/leak.test.js', 'IMAGE_CONTENT_CLASSES'],
  ['source tree', 'packages/a/src/leak.js', 'IMAGE_CONTENT_BOUNDED'],
  ['unrelated workspace', 'packages/unused/package.json', 'IMAGE_CONTENT_BOUNDED'],
]) test(`image content mutation killed: ${name}`, t => {
  const { destination, put, root } = stagedFixture(t);
  put(`staged/${file}`, '{}');
  assert.throws(() => assertImageContent(destination), error => {
    assert.equal(error.name, 'AssertionError');
    assert.ok(error.message.includes(expected), error.message);
    console.log(`KILLED ${name}: AssertionError [${expected}]`);
    return true;
  });
});
test('image content mutation killed: missing closure manifest', t => {
  const { destination } = stagedFixture(t);
  rmSync(resolve(destination, 'packages/a/package.json'));
  assert.throws(() => assertImageContent(destination), error => {
    assert.equal(error.name, 'AssertionError');
    assert.ok(error.message.includes('IMAGE_CONTENT_COMPLETE'), error.message);
    console.log('KILLED missing closure package: AssertionError [IMAGE_CONTENT_COMPLETE]');
    return true;
  });
});

test('image content mutation killed: dangling workspace link', t => {
  const { destination } = stagedFixture(t);
  rmSync(resolve(destination, 'packages/a'), { recursive: true });
  assert.throws(() => assertImageContent(destination), error => {
    assert.equal(error.name, 'AssertionError');
    assert.ok(error.message.includes('IMAGE_CONTENT_CLASSES'), error.message);
    console.log('KILLED dangling workspace link: AssertionError [IMAGE_CONTENT_CLASSES]');
    return true;
  });
});
test('image smoke keeps the HTTP 200 gate and then asserts image contents in the same container', () => {
  const script = readFileSync(new URL('../image-smoke.sh', import.meta.url), 'utf8');
  assert.ok(script.includes('if [[ "$code" == 200 ]]'), 'IMAGE_GATE_HEALTH: exactly HTTP 200 required');
  assert.ok(script.includes('docker exec "$container" node deploy/coolify/assert-image-content.mjs'), 'IMAGE_GATE_CONTENT: inspect the running image');
  assert.ok(script.indexOf('if [[ "$code" == 200 ]]') < script.indexOf('node deploy/coolify/assert-image-content.mjs'), 'IMAGE_GATE_ORDER: content cannot bypass health');
});

test('unused emitted module cannot grant workspace runtime authority', t => {
  const { root, put } = fixture(t);
  put('packages/a/dist/maintenance.js', "import '../../unused/dist/index.js';");
  const result = runtimeClosure(root, ['apps/gateway/dist/index.js']);
  assert.deepEqual(names(result), baseline, 'CLOSURE_UNUSED_MODULE: unreferenced built module confers no authority');
  assert.ok(!result.code.includes('packages/a/dist/maintenance.js'), 'CLOSURE_UNUSED_MODULE: unreferenced built module is not staged');
});

function equalityAssertions(root, destination, entries) {
  const reachable = names(runtimeClosure(root, entries));
  const staged = JSON.parse(readFileSync(resolve(destination, 'runtime-closure.json'))).packages.map(pkg => pkg.name);
  assert.deepEqual(staged, reachable, 'CLOSURE_DECLARED_BUT_UNIMPORTED: staged set must equal actual reachable set in both directions');
  assertImageContent(destination);
}

test('declared but unimported workspace is neither staged nor linked', t => {
  const data = stagedFixture(t);
  data.put('apps/gateway/package.json', { name: '@test/gateway', dependencies: { '@test/a': '*', '@test/unused': '*' } });
  const closure = stage(data.root, data.destination);
  reconcileWorkspaceLinks(data.destination, closure);
  equalityAssertions(data.root, data.destination);
  assert.equal(existsSync(resolve(data.destination, 'packages/unused')), false);
  assert.equal(existsSync(resolve(data.destination, 'node_modules/@test/unused')), false);
});

test('closure mutation killed: stage declared but unimported workspace', t => {
  const data = stagedFixture(t);
  data.put('apps/gateway/package.json', { name: '@test/gateway', dependencies: { '@test/a': '*', '@test/unused': '*' } });
  const manifest = JSON.parse(readFileSync(resolve(data.destination, 'runtime-closure.json')));
  manifest.packages.push({ name: '@test/unused', path: 'packages/unused' });
  manifest.packages.sort((a, b) => a.name.localeCompare(b.name));
  data.put('staged/runtime-closure.json', manifest);
  data.put('staged/packages/unused/package.json', { name: '@test/unused' });
  reconcileWorkspaceLinks(data.destination, manifest);
  for (const check of [() => equalityAssertions(data.root, data.destination), () => assertImageContent(data.destination)]) {
    assert.throws(check, error => {
      assert.equal(error.name, 'AssertionError');
      assert.match(error.message, /CLOSURE_DECLARED_BUT_UNIMPORTED/);
      console.log(`KILLED declared but unimported: AssertionError: ${error.message}`);
      return true;
    });
  }
});

for (const [name, mutation, assertion] of [
  ['staged but unlinked', data => rmSync(resolve(data.destination, 'node_modules/@test/a')), 'CLOSURE_STAGED_NOT_LINKED'],
  ['reachable but not staged', data => {
    rmSync(resolve(data.destination, 'node_modules/@test/a'));
    rmSync(resolve(data.destination, 'packages/a/package.json'));
  }, 'CLOSURE_REACHABLE_NOT_STAGED'],
  ['linked but not referenced', data => {
    symlinkSync(resolve(data.destination, 'packages/a'), resolve(data.destination, 'node_modules/@test/unused'));
  }, 'CLOSURE_LINKED_NOT_REFERENCED'],
]) test(`closure mutation killed: ${name}`, t => {
  const data = stagedFixture(t);
  mutation(data);
  assert.throws(() => assertImageContent(data.destination), error => {
    assert.equal(error.name, 'AssertionError');
    assert.ok(error.message.includes(assertion), error.message);
    console.log(`KILLED ${name}: AssertionError: ${error.message}`);
    return true;
  });
});

test('workspace links are recreated after pruning using manifest scope', t => {
  const data = stagedFixture(t);
  const closure = { workspaces: [{ name: '@bawes/actor-assertion', path: 'packages/actor-assertion' }], packages: [{ name: '@bawes/actor-assertion', path: 'packages/actor-assertion' }] };
  data.put('staged/packages/actor-assertion/package.json', { name: '@bawes/actor-assertion' });
  reconcileWorkspaceLinks(data.destination, closure);
  assert.ok(existsSync(resolve(data.destination, 'node_modules/@bawes/actor-assertion/package.json')));
  reconcileWorkspaceLinks(data.destination, { ...closure, packages: [] });
  assert.equal(existsSync(resolve(data.destination, 'node_modules/@bawes/actor-assertion')), false);
});

test('workspace imports select only the requested export and runtime condition', t => {
  const { root, put } = fixture(t);
  put('apps/gateway/dist/index.js', "import '@test/a/feature'; require('@test/a');");
  put('packages/a/package.json', { name: '@test/a', exports: { '.': { import: './dist/unused.js', require: './dist/required.cjs' }, './feature': { types: './dist/feature.d.ts', node: './dist/feature.js' }, './maintenance': './dist/unused.js' } });
  put('packages/a/dist/feature.js', "export * from '@test/b';");
  put('packages/a/dist/required.cjs', 'module.exports = {};');
  put('packages/a/dist/unused.js', "import '@test/unused';");
  const result = runtimeClosure(root, ['apps/gateway/dist/index.js']);
  assert.deepEqual(names(result), baseline, 'CLOSURE_SELECTED_EXPORT: unrelated exports confer no membership');
  assert.ok(result.code.includes('packages/a/dist/required.cjs'));
  assert.ok(!result.code.includes('packages/a/dist/index.js'));
  assert.ok(!result.code.includes('packages/a/dist/unused.js'));
});

test('closure algorithm mutation killed: follow declared but unimported dependencies', async t => {
  const data = stagedFixture(t);
  data.put('apps/gateway/package.json', { name: '@test/gateway', dependencies: { '@test/a': '*', '@test/unused': '*' } });
  const source = readFileSync(new URL('../stage-workspaces.mjs', import.meta.url), 'utf8');
  const from = 'packages.add(name);';
  assert.ok(source.includes(from));
  data.put('mutant.mjs', source.replace(from, `${from}\n    for (const dependency of Object.keys(workspaces.get(name).manifest.dependencies ?? {})) packageEntry(dependency, 'import');`));
  const mutant = await import(pathToFileURL(resolve(data.root, 'mutant.mjs')));
  const closure = mutant.stage(data.root, data.destination);
  reconcileWorkspaceLinks(data.destination, closure);
  assert.ok(existsSync(resolve(data.destination, 'packages/unused/package.json')));
  assert.throws(() => equalityAssertions(data.root, data.destination), error => {
    assert.equal(error.name, 'AssertionError');
    assert.match(error.message, /CLOSURE_DECLARED_BUT_UNIMPORTED/);
    console.log(`KILLED dependency-driven algorithm: AssertionError: ${error.message}`);
    return true;
  });
});
