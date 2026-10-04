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
  assert.match(workflow, /group: staging-switch\n\s+cancel-in-progress: false/);
});
test('on-dev builds never write the main- or latest tags directly', () => {
  assert.match(workflow, /tags: \$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_PREFIX \}\}\/\$\{\{ env\.IMAGE_NAME \}\}:dev-\$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.doesNotMatch(workflow, /:main-|:latest/);
});
test('the switch runs only the smoke-tested digest', () => {
  const smoke = workflow.indexOf('image-smoke.sh'), run = workflow.indexOf('node deploy/coolify/staging-switch.mjs');
  assert.ok(smoke > 0 && run > smoke);
  assert.match(workflow, /DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}\n\s+REVISION: \$\{\{ steps\.target\.outputs\.sha \}\}/);
});
