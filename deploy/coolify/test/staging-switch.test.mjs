import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selection, switchStaging } from '../staging-switch.mjs';
import { IMAGE } from '../select-artifact.mjs';
import { DeploymentOutcome } from '../trigger-selected.mjs';

const revision = 'b'.repeat(40), digest = `sha256:${'a'.repeat(64)}`;
const selected = selection(revision, digest);
function fixture(failure) {
  const calls = [];
  const call = (name, value) => { calls.push(name); if (name === failure) throw new DeploymentOutcome('DEPLOYMENT_UNKNOWN', 'fixture'); return value; };
  return { calls, io: {
    preflight: () => call('preflight'), promote: () => call('promote'), assertDigest: () => call('digest'),
    trigger: () => call('trigger', { outcome: 'DEPLOYMENT_SUCCEEDED' }),
  } };
}

test('selection pins the gateway image by digest and exact revision', () => {
  assert.deepEqual(selected, { revision, image: IMAGE, digest, pin: `${IMAGE}@${digest}` });
  for (const [r, d] of [['b'.repeat(39), digest], [revision.toUpperCase(), digest], [revision, 'sha256:short'], [revision, undefined]]) {
    assert.throws(() => selection(r, d), { code: 'PRECONDITION_NOT_MET' });
  }
});
test('switch checks the staging app before moving latest, then verifies the deployed digest', async () => {
  const f = fixture();
  assert.deepEqual(await switchStaging(selected, f.io), { outcome: 'DEPLOYMENT_SUCCEEDED', revision, digest });
  assert.deepEqual(f.calls, ['preflight', 'promote', 'digest', 'trigger', 'digest']);
});
test('a staging target that cannot be verified never moves latest or triggers', async () => {
  const f = fixture('preflight');
  await assert.rejects(switchStaging(selected, f.io));
  assert.deepEqual(f.calls, ['preflight']);
});
for (const failure of ['promote', 'digest', 'trigger']) test(`a ${failure} failure is reported, never success`, async () => {
  const f = fixture(failure);
  await assert.rejects(switchStaging(selected, f.io), DeploymentOutcome);
});

const workflow = readFileSync(new URL('../../../.github/workflows/staging-on-dev.yml', import.meta.url), 'utf8');
test('on-dev workflow ignores pull requests from forks and serializes switches', () => {
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(jobs.switch, /group: staging-switch\n\s+cancel-in-progress: false/);
});
test('on-dev builds never write the main- or latest tags directly', () => {
  assert.match(workflow, /tags: \$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_PREFIX \}\}\/\$\{\{ env\.IMAGE_NAME \}\}:dev-\$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.doesNotMatch(workflow, /:main-|:latest/);
});
const jobs = Object.fromEntries(workflow.split(/\n(?=  [a-z-]+:\n)/).slice(1).map((text) => [text.match(/^  ([a-z-]+):/)[1], text]));
test('the switch runs only the smoke-tested digest', () => {
  assert.match(jobs.build, /image-smoke\.sh/);
  assert.match(jobs.switch, /needs: \[decide, build\]/);
  assert.match(jobs.switch, /DIGEST: \$\{\{ needs\.build\.outputs\.digest \}\}\n\s+REVISION: \$\{\{ needs\.build\.outputs\.sha \}\}/);
  assert.match(jobs.switch, /id: switch\n\s+if: needs\.build\.result == 'success'/);
});
test('branch code never runs with the Coolify secrets', () => {
  for (const [name, text] of Object.entries(jobs)) if (name !== 'switch') assert.doesNotMatch(text, /COOLIFY_/, name);
  assert.equal(jobs.switch.match(/ref: /g).length, 1);
  assert.match(jobs.switch, /ref: \$\{\{ env\.DEFAULT_BRANCH \}\}/);
  assert.match(workflow, /DEFAULT_BRANCH: main\n/);
});
test('label decisions are serialized and ownership code comes from main', () => {
  assert.match(jobs.decide, /concurrency:\n\s+group: staging-label\n\s+cancel-in-progress: false/);
  for (const name of ['decide', 'switch']) assert.match(jobs[name], /ref: \$\{\{ env\.DEFAULT_BRANCH \}\}/, name);
  assert.match(jobs.decide, /\n\s+node deploy\/coolify\/staging-ownership\.mjs decide\n/);
  // Before main carries the scripts, the bootstrap path selects nothing rather than failing every PR.
  assert.match(jobs.decide, /if \[ ! -f deploy\/coolify\/staging-ownership\.mjs \]; then[\s\S]*?printf 'branch=\\npr=\\nmode=\\n'[\s\S]*?exit 0\n\s+fi/);
  assert.match(jobs.switch, /SHA: \$\{\{ needs\.build\.outputs\.sha \}\}\n\s+run: node deploy\/coolify\/staging-ownership\.mjs guard/);
});
test('staging ownership is rechecked right before the switch', () => {
  const check = jobs.switch.indexOf("Check staging is still this run's to change"), run = jobs.switch.indexOf('node deploy/coolify/staging-switch.mjs');
  assert.ok(check > 0 && run > check);
  assert.equal(jobs.switch.slice(check, run).match(/- name:/g).length, 1);
});
test('the main deploy shares the staging queue with the on-dev switch', () => {
  const build = readFileSync(new URL('../../../.github/workflows/build.yml', import.meta.url), 'utf8');
  assert.match(build, /\n  deploy:\n[\s\S]*?concurrency:\n\s+group: staging-switch\n\s+cancel-in-progress: false\n[\s\S]*?\n    steps:/);
});
