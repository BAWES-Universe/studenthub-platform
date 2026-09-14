import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { affectsRuntime } from '../runtime-change.mjs';
import { assertStagingTag, featureSmoke, restoreAutomatically } from '../automatic-staging.mjs';
import { IMAGE } from '../select-artifact.mjs';
import { DeploymentOutcome, triggerSelected } from '../trigger-selected.mjs';
const selected = { image: IMAGE, digest: `sha256:${'a'.repeat(64)}`, pin: `${IMAGE}@sha256:${'a'.repeat(64)}`, revision: 'b'.repeat(40) };
const previous = { ...selected, digest: `sha256:${'c'.repeat(64)}`, pin: `${IMAGE}@sha256:${'c'.repeat(64)}`, revision: 'd'.repeat(40) };
const app = { fqdn: 'https://staging.studenthub.co', build_pack: 'dockerimage', docker_registry_image_name: IMAGE, docker_registry_image_tag: 'latest', status: 'running:healthy' };
function fixture(failure) {
  const calls = [];
  let failed = false;
  const call = (name, value) => { calls.push(name); if (!failed && name === failure) { failed = true; throw new DeploymentOutcome('DEPLOYMENT_UNKNOWN', 'fixture'); } return value; };
  return { calls, io: {
    assertUnfrozen: () => call('gate'), preflight: () => call('preflight'), previous: () => call('previous', previous),
    freeze: () => call('freeze', 1), promote: (s) => call(s === selected ? 'promote' : 'rollback-promote'),
    assertDigest: (s) => call(s === selected ? 'digest' : 'rollback-digest'),
    trigger: (s) => call(s === selected ? 'trigger' : 'rollback-trigger', { outcome: 'DEPLOYMENT_SUCCEEDED' }),
    unfreeze: () => call('unfreeze'), notify: (_id, result) => call(`notify-${result.rollback}`),
  } };
}
test('automatic success durably freezes before promotion and verifies before clearing', async () => {
  const f = fixture(); assert.equal((await restoreAutomatically(selected, f.io)).outcome, 'DEPLOYMENT_SUCCEEDED');
  assert.deepEqual(f.calls, ['gate', 'preflight', 'previous', 'freeze', 'promote', 'digest', 'trigger', 'digest', 'unfreeze']);
});
for (const failure of ['gate', 'preflight', 'previous', 'freeze']) test(`automatic ${failure} gap cannot mutate registry or trigger`, async () => {
  const f = fixture(failure); await assert.rejects(restoreAutomatically(selected, f.io), { code: 'PRECONDITION_NOT_MET' });
  assert.ok(!f.calls.includes('promote')); assert.ok(!f.calls.includes('trigger'));
});
for (const failure of ['promote', 'digest', 'trigger', 'unfreeze']) test(`automatic ${failure} failure rolls back, verifies, notifies and retains freeze`, async () => {
  const f = fixture(failure); await assert.rejects(restoreAutomatically(selected, f.io));
  assert.deepEqual(f.calls.slice(-5), ['rollback-promote', 'rollback-digest', 'rollback-trigger', 'rollback-digest', 'notify-verified']);
  assert.equal(f.calls.at(-1), 'notify-verified');
});
test('automatic rollback failure is explicitly unverified and never clears freeze', async () => {
  const f = fixture('trigger'); f.io.promote = (s) => { if (s === previous) throw Error('fixture'); };
  await assert.rejects(restoreAutomatically(selected, f.io)); assert.equal(f.calls.at(-1), 'notify-unverified'); assert.ok(!f.calls.includes('unfreeze'));
});
test('automatic staging binding rejects production, source-build, foreign repository and unselected artifact', () => {
  assert.doesNotThrow(() => assertStagingTag(app, selected));
  for (const patch of [{ fqdn: 'https://studenthub.co' }, { build_pack: 'nixpacks' }, { docker_registry_image_name: 'foreign' }, { docker_registry_image_tag: 'other' }]) {
    assert.throws(() => assertStagingTag({ ...app, ...patch }, selected), { code: 'PRECONDITION_NOT_MET' });
  }
  assert.throws(() => assertStagingTag(app, { ...selected, pin: previous.pin }));
});
test('runtime scope excludes coordinator, documentation, tests and deployment automation itself', () => {
  for (const path of ['.github/coordinator/config.json', '.github/workflows/build.yml', 'README.md', 'docs/design.md', 'apps/gateway/test/health.test.ts', 'deploy/coolify/automatic-staging.mjs', 'deploy/coolify/runtime-change.mjs']) assert.equal(affectsRuntime(path), false, path);
  for (const path of ['Dockerfile', 'package-lock.json', 'apps/gateway/src/index.ts', 'packages/contracts/src/index.ts', 'deploy/coolify/gateway-entrypoint.sh']) assert.equal(affectsRuntime(path), true, path);
});
test('feature smoke checks UI, assets and unauthenticated profile without credentials', async () => {
  const paths = [];
  await featureSmoke(async (url, opts) => { paths.push(url); assert.equal(opts.headers.Authorization, undefined); return { status: url.endsWith('/profile') ? 401 : 200, text: async () => 'Continue with Universe @media' }; });
  assert.equal(paths.length, 3);
  await assert.rejects(featureSmoke(async () => ({ status: 500 })), { code: 'DEPLOYMENT_FAILED' });
});
test('automatic HTTP compatibility retains typed missing settings and exact running revision verification', async () => {
  const env = { COOLIFY_BASE: 'http://coolify.invalid', COOLIFY_TOKEN: 'fixture', COOLIFY_STUDENTHUB_GATEWAY_UUID: 'fixture' };
  let post = 0, features = 0;
  const request = async (url, opts) => {
    let value = app;
    if (opts.method === 'POST') { post++; value = { deployments: [{ deployment_uuid: 'fixture' }] }; }
    else if (url.pathname.includes('/deployments/')) value = { deployment_uuid: 'fixture', status: 'finished' };
    else if (url.pathname === '/health') { assert.equal(opts.headers.Authorization, undefined); value = { status: 'ok', component: 'gateway', revision: selected.revision }; }
    return { ok: true, json: async () => value };
  };
  const opts = { allowHttp: true, assertApplication: assertStagingTag, verifyFeatures: async () => { features++; } };
  assert.equal((await triggerSelected(selected, env, request, opts)).outcome, 'DEPLOYMENT_SUCCEEDED');
  assert.equal(post, 1); assert.equal(features, 1);
  await assert.rejects(triggerSelected(selected, { ...env, COOLIFY_BASE: '' }, request, opts), { code: 'PRECONDITION_NOT_MET' }); assert.equal(post, 1);
});
test('workflow never exposes latest before image smoke and serializes deploy through rollback', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/build.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /value=latest|workflow_dispatch:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /needs.runtime-scope.outputs.changed == 'true'/);
  assert.match(workflow, /needs: build-push/);
  assert.match(workflow, /image-smoke.sh.*DIGEST/);
  assert.match(workflow, /issues: write/);
});

test('runtime fingerprint ignores unrelated workspace source but detects the actual deployed closure', async (t) => {
  const { runtimeFingerprint } = await import('../runtime-fingerprint.mjs');
  const { runtimeClosure } = await import('../stage-workspaces.mjs');
  const { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const root = process.cwd(), closure = runtimeClosure(root);
  const dir = mkdtempSync(join(tmpdir(), 'restore-fingerprint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = [...closure.code, ...closure.workspaces.map(({ path }) => `${path}/package.json`), 'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
    ...['gateway-entrypoint.sh', 'preflight.mjs', 'assert-image-content.mjs', 'stage-workspaces.mjs', 'prune-workspace-links.mjs'].map((file) => `deploy/coolify/${file}`),
    ...readdirSync('packages/db/migrations').map((file) => `packages/db/migrations/${file}`)];
  for (const file of files) { mkdirSync(dirname(join(dir, file)), { recursive: true }); cpSync(join(root, file), join(dir, file)); }
  const before = runtimeFingerprint(dir);
  assert.equal(before, runtimeFingerprint(root));
  mkdirSync(join(dir, 'apps/worker/src'), { recursive: true });
  writeFileSync(join(dir, 'apps/worker/src/unrelated.ts'), 'export const unrelated = true;');
  writeFileSync(join(dir, 'README.md'), 'docs-only');
  assert.equal(runtimeFingerprint(dir), before);
  const deployed = join(dir, closure.code[0]);
  writeFileSync(deployed, readFileSync(deployed, 'utf8') + '\n// runtime change\n');
  assert.notEqual(runtimeFingerprint(dir), before);
});
