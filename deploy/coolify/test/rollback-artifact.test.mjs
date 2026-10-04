import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMAGE } from '../select-artifact.mjs';
const source = new URL('../rollback-artifact.mjs', import.meta.url);
const { discoverRollback, previous, readRunningArtifact, rollbackIO } = await import(process.env.ROLLBACK_MUTANT || source.href);
const revision = '50db30ee3c48b9fe4a056a253cd13992cfaba772';
const digest = 'sha256:b902332195eae3c01a3972684706a9beaebc1d1e226549c2ab8b5c8a0a9c8648';
const running = { image: IMAGE, revision, digest };
function fixture(tagged = true) {
  const calls = [];
  const registry = new Map([[`${IMAGE}@${digest}`, digest], [`${IMAGE}:latest`, `sha256:${'7'.repeat(64)}`],
    ...['76360f70', 'd3544962', 'aac05b10'].map((prefix) => [`${IMAGE}:main-${prefix}`, `sha256:${'7'.repeat(64)}`])]);
  if (tagged) registry.set(`${IMAGE}:main-${revision}`, digest);
  return { calls, io: {
    readRunning: async () => running,
    inspect: async (ref) => { calls.push(ref); return registry.get(ref) ?? null; },
    pull: async (pin) => calls.push(`pull ${pin}`), readRevision: async () => revision,
    health: async () => Response.json({ status: 'ok', component: 'gateway', revision }),
    smoke: async (pin) => calls.push(`smoke ${pin}`),
  } };
}
test('published running revision returns verified running digest despite different latest', async () => {
  const f = fixture();
  const result = await discoverRollback(f.io);
  assert.equal(result.digest, digest, 'ROLLBACK_NO_LATEST_SUBSTITUTION');
  assert.equal(result.outcome, 'ROLLBACK_READY', 'ROLLBACK_NO_LATEST_SUBSTITUTION');
  assert.ok(!f.calls.includes(`${IMAGE}:latest`), 'ROLLBACK_NO_LATEST_SUBSTITUTION');
  assert.ok(f.calls.includes(`smoke ${IMAGE}@${digest}`));
  assert.deepEqual(await previous(f.io), { ...running, pin: `${IMAGE}@${digest}` });
});
test('today running 50db30ee untagged returns explicit non-fatal remediation', async () => {
  const f = fixture(false), result = await discoverRollback(f.io);
  assert.equal(result.outcome, 'ROLLBACK_RUNNING_REVISION_UNTAGGED', 'ROLLBACK_UNTAGGED_TYPED');
  assert.equal(result.revision, revision); assert.equal(result.digest, digest);
  assert.match(result.remediation, /Publish immutable tag .*main-50db30ee.*or address ghcr.*@sha256:.*Never substitute latest/);
  assert.deepEqual(f.calls, [`${IMAGE}:main-${revision}`], 'ROLLBACK_NO_LATEST_SUBSTITUTION');
  await assert.rejects(previous(f.io), (error) => error.code === 'PRECONDITION_NOT_MET' && error.message.includes('ROLLBACK_RUNNING_REVISION_UNTAGGED'));
});
test('missing running evidence fails closed before registry access', async () => {
  const f = fixture(); f.io.readRunning = async () => ({ ...running, image: 'unverified' });
  await assert.rejects(discoverRollback(f.io), /ROLLBACK_RUNNING_ARTIFACT_REQUIRED/, 'ROLLBACK_RUNNING_ARTIFACT_REQUIRED');
  assert.equal(f.calls.length, 0, 'ROLLBACK_RUNNING_ARTIFACT_REQUIRED');
});
test('digest revision health smoke and running-state validation all fail closed', async () => {
  for (const patch of [
    { inspect: async () => `sha256:${'c'.repeat(64)}` },
    { inspect: async () => { throw Error('registry unavailable'); } },
    { readRevision: async () => 'a'.repeat(40) },
    { health: async () => Response.json({ status: 'ok', component: 'gateway', revision: 'a'.repeat(40) }) },
    { health: async () => Response.json({ status: 'bad', component: 'gateway', revision }) },
    { health: async () => Response.json({ status: 'ok', component: 'worker', revision }) },
    { health: async () => Response.json({ status: 'ok', component: 'gateway', revision }, { status: 503 }) },
    { smoke: async () => { throw Error('smoke failed'); } },
  ]) await assert.rejects(discoverRollback({ ...fixture().io, ...patch }));
  let reads = 0;
  await assert.rejects(discoverRollback({ ...fixture().io, readRunning: async () => ++reads === 1 ? running : { ...running, digest: 'changed' } }), /ROLLBACK_RUNNING_ARTIFACT_REQUIRED/);
});
test('host reader binds container image repository digest and embedded revision using only read commands', () => {
  const container = 'c'.repeat(64), imageId = `sha256:${'d'.repeat(64)}`, commands = [];
  const run = (command, args) => {
    commands.push([command, ...args]);
    if (args.includes('exec')) return `${revision}\n`;
    if (args.includes('image')) return JSON.stringify([{ Id: imageId, RepoDigests: [`${IMAGE}@${digest}`] }]);
    return JSON.stringify([{ Id: container, Image: imageId, State: { Running: true, Health: { Status: 'healthy' }, StartedAt: 'fixture' } }]);
  };
  assert.deepEqual(readRunningArtifact({ ROLLBACK_SSH_HOST: 'staging-alias', ROLLBACK_CONTAINER_ID: container }, run), running);
  assert.equal(commands.length, 4);
  assert.ok(commands.every((args) => args[0] === 'ssh' && !args.some((arg) => ['pull', 'run', 'create'].includes(arg))));
  assert.throws(() => readRunningArtifact({}, run), /ROLLBACK_RUNNING_ARTIFACT_REQUIRED/);
});
test('only explicit registry manifest absence is untagged; authentication and transport failures stop', () => {
  for (const stderr of ['unauthorized', 'timeout', 'not found']) {
    assert.throws(() => rollbackIO({}, () => { throw Object.assign(Error(), { stderr }); }).inspect('fixture'), /unreadable/);
  }
  assert.equal(rollbackIO({}, () => { throw Object.assign(Error(), { stderr: 'MANIFEST_UNKNOWN' }); }).inspect('fixture'), null);
});

if (!process.env.ROLLBACK_MUTANT) {
  const mutations = [
    ['ROLLBACK_RUNNING_ARTIFACT_REQUIRED', 'missing running evidence', "running?.image !== IMAGE", 'false'],
    ['ROLLBACK_NO_LATEST_SUBSTITUTION', 'published running revision', 'const published = await io.inspect(`${IMAGE}:${tag}`);', 'await io.inspect(`${IMAGE}:latest`); const published = await io.inspect(`${IMAGE}:${tag}`);'],
    ['ROLLBACK_UNTAGGED_TYPED', 'today running', "outcome: 'ROLLBACK_RUNNING_REVISION_UNTAGGED'", "outcome: 'ROLLBACK_READY'"],
  ];
  // The mutant is written under TMPDIR, never beside the module it mutates. Sibling
  // test files run in parallel workers of the same `node --test` invocation and copy
  // deploy/coolify/ wholesale (env-manifest-mutations.test.mjs), and a transient file
  // that appears and vanishes inside a directory being copied fails that copy with
  // ENOENT. Relative specifiers are re-anchored on the real module's directory, so the
  // mutant still loads exactly the modules it would have loaded in place.
  const moduleDirectory = new URL('./', source).href;
  for (const [name, pattern, from, to] of mutations) test(`mutation killed by AssertionError ${name}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), `rollback-mutant-${name}-`));
    const path = pathToFileURL(join(directory, 'rollback-artifact.mjs'));
    const original = readFileSync(source, 'utf8'); assert.ok(original.includes(from));
    const mutant = original.replace(from, to).replaceAll("from './", `from '${moduleDirectory}`);
    assert.doesNotMatch(mutant, /from '\.\//, `${name}: the mutant must not keep a specifier relative to a directory it no longer lives in`);
    writeFileSync(path, mutant);
    try {
      const child = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, new URL(import.meta.url).pathname], { encoding: 'utf8', env: { PATH: process.env.PATH, ROLLBACK_MUTANT: path.href }, timeout: 10_000 });
      const output = child.stdout + child.stderr;
      assert.notEqual(child.status, 0, `${name}: mutant survived`);
      assert.match(output, /AssertionError/, output);
      assert.ok(output.includes(name), output);
      t.diagnostic(`AssertionError: ${name}`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
