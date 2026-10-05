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
const jobs = Object.fromEntries(workflow.split(/\n(?=  [a-z-]+:\n)/).slice(1).map((text) => [text.match(/^  ([a-z-]+):/)[1], text]));
const step = (job, name) => jobs[job].slice(jobs[job].indexOf(`- name: ${name}`)).split(/\n      - /)[0];

test('on-dev workflow ignores pull requests from forks and serializes switches', () => {
  assert.match(jobs.decide, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(jobs.switch, /group: staging-switch\n\s+cancel-in-progress: false/);
});
test('on-dev builds never write the main- or latest tags directly', () => {
  assert.match(jobs.build, /tags: \$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_PREFIX \}\}\/\$\{\{ env\.IMAGE_NAME \}\}:dev-\$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.doesNotMatch(workflow, /:main-|:latest/);
});
test('the switch promotes only an image that main\'s smoke test passed in the same job, and only if still wanted', () => {
  const order = ['Work out what staging should run now', 'Smoke-test the wanted image', 'Check it is still wanted', 'Switch staging and verify'].map((n) => jobs.switch.indexOf(`- name: ${n}`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), String(order));
  assert.match(step('switch', 'Smoke-test the wanted image'), /if: steps\.want\.outputs\.digest != ''[\s\S]*DIGEST: \$\{\{ steps\.want\.outputs\.digest \}\}[\s\S]*image-smoke\.sh/);
  assert.match(step('switch', 'Check it is still wanted'), /SHA: \$\{\{ steps\.want\.outputs\.sha \}\}\n\s+run: node deploy\/coolify\/staging-ownership\.mjs confirm/);
  const run = step('switch', 'Switch staging and verify');
  assert.match(run, /if: steps\.confirm\.outputs\.current == 'true'/);
  assert.match(run, /DIGEST: \$\{\{ steps\.want\.outputs\.digest \}\}\n\s+REVISION: \$\{\{ steps\.want\.outputs\.sha \}\}/);
  // A failed smoke test fails its step, so the steps after it (confirm, switch) never run.
  assert.doesNotMatch(step('switch', 'Smoke-test the wanted image'), /continue-on-error/);
});
test('the branch smoke script runs only after the registry write token is gone', () => {
  const logout = jobs.build.indexOf('docker logout ghcr.io'), smoke = jobs.build.indexOf('image-smoke.sh');
  assert.ok(jobs.build.indexOf('uses: docker/build-push-action') < logout && logout < smoke);
  assert.match(step('build', 'Pull the pushed digest and log out of the registry'), /docker pull "\$\{REGISTRY\}\/\$\{IMAGE_PREFIX\}\/\$\{IMAGE_NAME\}@\$\{DIGEST\}"\n\s+docker logout ghcr\.io\n\s+rm -f "\$\{HOME\}\/\.docker\/config\.json"/);
  assert.equal(jobs.build.match(/image-smoke\.sh/g).length, 1);
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
  assert.match(jobs.decide, /if \[ ! -f deploy\/coolify\/staging-ownership\.mjs \]; then[\s\S]*?printf 'branch=\\npr=\\n'[\s\S]*?exit 0\n\s+fi/);
});
test('only on-dev events start a run, and no step reads the event\'s PR, branch or label', () => {
  assert.match(jobs.decide, /github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'push' \|\|/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(jobs.decide, /github\.event\.label\.name == 'on-dev' \|\|\n\s+\(\(github\.event\.action == 'synchronize' \|\| github\.event\.action == 'closed'\) &&\n\s+contains\(github\.event\.pull_request\.labels\.\*\.name, 'on-dev'\)\)/);
  for (const name of ['decide', 'build', 'switch']) assert.doesNotMatch(jobs[name].replace(/^[\s\S]*?\n    steps:/, ''), /github\.event\./, name);
  assert.doesNotMatch(workflow, /inputs\./);
});
test('a switch reconciles even when its own build failed or was superseded', () => {
  assert.match(jobs.switch, /if: always\(\) && needs\.decide\.result == 'success' && needs\.decide\.outputs\.branch != ''/);
  assert.doesNotMatch(jobs.switch, /needs\.build\.outputs/);
});
test('the on-dev switch is the only job anywhere that can move staging', () => {
  const build = readFileSync(new URL('../../../.github/workflows/build.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(build, /COOLIFY_TOKEN|staging-switch|automatic-staging/);
  assert.equal(workflow.match(/secrets\.COOLIFY_TOKEN/g).length, 1);
  assert.match(step('switch', 'Switch staging and verify'), /COOLIFY_TOKEN/);
});
