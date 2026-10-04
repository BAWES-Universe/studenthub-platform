import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, guard, runDecide, runGuard } from '../staging-ownership.mjs';

const S1 = '1'.repeat(40), S2 = '2'.repeat(40);
// A tiny model of GitHub: open PRs carrying the label (with when each was labelled), and branch heads.
function world(labels, heads = {}) {
  const state = { labels: { ...labels }, heads, released: [] };
  return { state, api: {
    holders: () => Object.keys(state.labels).map(Number),
    holder: (number) => ({ number, labeledAt: state.labels[number], headRef: `branch-${number}`, crossRepository: number >= 900 }),
    prHead: (pr) => state.heads[pr],
    branchHead: (branch) => state.heads[branch],
    release: (other) => { state.released.push(other); delete state.labels[other]; },
  } };
}
const T1 = '2026-10-04T10:00:00Z', T2 = '2026-10-04T11:00:00Z', T3 = '2026-10-04T12:00:00Z';
const pr = { EVENT: 'pull_request' };

test('the most recently labelled PR owns staging and every other holder is released', () => {
  const w = world({ 208: T1, 209: T2 });
  assert.deepEqual(runDecide(pr, w.api), { branch: 'branch-209', pr: '209', mode: 'pr', remove: [208], owner: 209, reason: '#209 holds on-dev' });
  assert.deepEqual(w.state.labels, { 209: T2 });
});
test('a late event for a PR that lost the label changes nothing about who owns staging', () => {
  const w = world({ 209: T2 });
  assert.equal(runDecide(pr, w.api).pr, '209');
  assert.deepEqual(w.state.released, []);
});
test('whichever decisions GitHub drops, the newest one restores the intended state', () => {
  // A runs with a stale view [A]; B is labelled (its decision may be dropped); then a push to
  // A, another label on C, or B's own event arrives last. Each survivor converges on the newest label.
  for (const last of ['A-push', 'B-label', 'C-label']) {
    const w = world({ 208: T1, 209: T2 });
    if (last === 'C-label') w.state.labels[210] = T3;
    const result = runDecide(pr, w.api);
    const expected = last === 'C-label' ? 210 : 209;
    assert.equal(result.pr, String(expected), last);
    assert.deepEqual(Object.keys(w.state.labels).map(Number), [expected], last);
    assert.doesNotThrow(() => guard({ mode: 'pr', pr: result.pr, holders: w.api.holders(), head: S1, sha: S1 }), last);
  }
});
test('two PRs labelled together end with exactly one holder whichever decision runs first', () => {
  const w = world({ 208: T2, 209: T2 });
  const first = runDecide(pr, w.api), second = runDecide(pr, w.api);
  assert.equal(first.pr, '209'); assert.equal(second.pr, '209');
  assert.deepEqual(w.state.labels, { 209: T2 });
});
test('with no holder staging returns to main', () => {
  assert.deepEqual(runDecide(pr, world({}).api).branch, 'main');
  assert.equal(decide({ name: 'pull_request' }, []).mode, 'free');
});
test('a fork PR that holds the label is never built, but still releases older holders', () => {
  const w = world({ 208: T1, 901: T2 });
  const result = runDecide(pr, w.api);
  assert.equal(result.branch, ''); assert.deepEqual(w.state.released, [208]);
});
test('a manual run never takes staging from a labelled PR', () => {
  assert.equal(decide({ name: 'workflow_dispatch', inputBranch: 'x' }, [{ number: 208, labeledAt: T1 }]).branch, '');
  assert.deepEqual(decide({ name: 'workflow_dispatch', inputBranch: 'x' }, []).mode, 'manual');
});

test('the switch guard requires the run to be the only holder', () => {
  assert.doesNotThrow(() => guard({ mode: 'pr', pr: '208', holders: [208], head: S1, sha: S1 }));
  for (const holders of [[], [209], [208, 209], [209, 208]]) {
    assert.throws(() => guard({ mode: 'pr', pr: '208', holders, head: S1, sha: S1 }), { code: 'PRECONDITION_NOT_MET' });
  }
  assert.doesNotThrow(() => guard({ mode: 'free', holders: [], head: S1, sha: S1 }));
  assert.throws(() => guard({ mode: 'free', holders: [208], head: S1, sha: S1 }), { code: 'PRECONDITION_NOT_MET' });
  assert.throws(() => guard({ mode: 'manual', holders: [208], head: S1, sha: S1 }), { code: 'PRECONDITION_NOT_MET' });
  assert.throws(() => guard({ mode: '', holders: [], head: S1, sha: S1 }), { code: 'PRECONDITION_NOT_MET' });
});
test('an older build finishing after a newer one never replaces it', () => {
  // R1 built S1; a push started R2 for S2, which switched first. R1 then reaches the guard.
  const w = world({ 208: T1 }, { 208: S2 });
  assert.doesNotThrow(() => runGuard({ MODE: 'pr', PR: '208', SHA: S2 }, w.api));
  assert.throws(() => runGuard({ MODE: 'pr', PR: '208', SHA: S1 }, w.api), { code: 'PRECONDITION_NOT_MET' });
  const main = world({}, { main: S2 });
  assert.throws(() => runGuard({ MODE: 'free', BRANCH: 'main', SHA: S1 }, main.api), { code: 'PRECONDITION_NOT_MET' });
  assert.throws(() => runGuard({ MODE: 'manual', BRANCH: '../pulls', SHA: S2 }, main.api), { code: 'PRECONDITION_NOT_MET' });
});

test('the command line reads live holders through gh and exits nonzero without releasing anyone on a stale event', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "pr list") echo 209 ;;\n  "pr view") case "$*" in *headRefOid*) echo ${S1} ;; *) echo '{"headRefName":"b","isCrossRepository":false}' ;; esac ;;\n  "api --paginate") echo ${T2} ;;\nesac\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  const run = (args, extra) => {
    try { return { code: 0, out: execFileSync('node', ['deploy/coolify/staging-ownership.mjs', ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_OUTPUT: join(dir, 'out'), ...extra } }) }; }
    catch (error) { return { code: error.status, out: `${error.stdout}${error.stderr}` }; }
  };
  writeFileSync(log, '');
  assert.equal(run(['decide'], { EVENT: 'pull_request' }).code, 0);
  assert.match(readFileSync(join(dir, 'out'), 'utf8'), /^branch=b\npr=209\nmode=pr\n$/);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /edit|comment/);
  const stale = run(['guard'], { MODE: 'pr', PR: '208', SHA: S1 });
  assert.equal(stale.code, 1); assert.match(stale.out, /expected only #208/);
  assert.equal(run(['guard'], { MODE: 'pr', PR: '209', SHA: S1 }).code, 0);
  assert.equal(run(['guard'], { MODE: 'pr', PR: '209', SHA: S2 }).code, 1);
});
