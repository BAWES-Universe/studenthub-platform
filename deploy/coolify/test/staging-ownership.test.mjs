import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, guard, runDecide, runGuard } from '../staging-ownership.mjs';

const S1 = '1'.repeat(40), S2 = '2'.repeat(40);
const labeled = (pr) => ({ name: 'pull_request', action: 'labeled', label: 'on-dev', pr, headRef: `branch-${pr}` });

// A tiny model of GitHub: which open PRs carry the label, and each branch head.
function world(holders, heads = {}) {
  const state = { holders: [...holders], heads, released: [] };
  return { state, api: {
    holders: () => [...state.holders],
    prHead: (pr) => state.heads[pr],
    branchHead: (branch) => state.heads[branch],
    release: (other) => { state.released.push(other); state.holders = state.holders.filter((n) => n !== other); },
  } };
}
const env = (event) => ({ EVENT: event.name, ACTION: event.action, EVENT_LABEL: event.label, PR: String(event.pr ?? ''), HEAD_REF: event.headRef, HAD_LABEL: String(!!event.hadLabel), INPUT_BRANCH: event.inputBranch });

test('taking the label releases every other holder', () => {
  const w = world([208, 209]);
  assert.deepEqual(runDecide(env(labeled(209)), w.api), { branch: 'branch-209', pr: '209', mode: 'pr', remove: [208], reason: '#209 took on-dev' });
  assert.deepEqual(w.state.holders, [209]);
});
test('a late labeled event for a PR that lost the label changes nothing', () => {
  // A was labelled, then B took over; A's delayed event arrives last.
  const w = world([209]);
  assert.equal(runDecide(env(labeled(208)), w.api).branch, '');
  assert.deepEqual(w.state.released, []);
  assert.deepEqual(w.state.holders, [209]);
});
test('two PRs labelled together end with exactly one holder whichever decision runs first', () => {
  for (const [first, second] of [[208, 209], [209, 208]]) {
    const w = world([208, 209]);
    const a = runDecide(env(labeled(first)), w.api), b = runDecide(env(labeled(second)), w.api);
    assert.equal(a.mode, 'pr'); assert.equal(b.branch, '');
    assert.deepEqual(w.state.holders, [first]);
  }
});
test('pushes follow only the holder, and the label leaving frees staging only when nobody holds it', () => {
  assert.equal(decide({ action: 'synchronize', pr: 208, headRef: 'b' }, [208]).mode, 'pr');
  assert.equal(decide({ action: 'synchronize', pr: 208, headRef: 'b' }, [209]).branch, '');
  assert.equal(decide({ action: 'unlabeled', label: 'on-dev', pr: 208 }, []).mode, 'free');
  assert.equal(decide({ action: 'unlabeled', label: 'on-dev', pr: 208 }, [209]).branch, '');
  assert.equal(decide({ action: 'closed', hadLabel: true, pr: 208 }, []).branch, 'main');
  assert.equal(decide({ action: 'closed', hadLabel: false, pr: 208 }, []).branch, '');
  assert.equal(decide({ action: 'unlabeled', label: 'other', pr: 208 }, []).branch, '');
});
test('a manual run never takes staging from a labelled PR', () => {
  assert.equal(decide({ name: 'workflow_dispatch', inputBranch: 'x' }, [208]).branch, '');
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
  const w = world([208], { 208: S2 });
  assert.doesNotThrow(() => runGuard({ MODE: 'pr', PR: '208', SHA: S2 }, w.api));
  assert.throws(() => runGuard({ MODE: 'pr', PR: '208', SHA: S1 }, w.api), { code: 'PRECONDITION_NOT_MET' });
  const main = world([], { main: S2 });
  assert.throws(() => runGuard({ MODE: 'free', BRANCH: 'main', SHA: S1 }, main.api), { code: 'PRECONDITION_NOT_MET' });
  assert.throws(() => runGuard({ MODE: 'manual', BRANCH: '../pulls', SHA: S2 }, main.api), { code: 'PRECONDITION_NOT_MET' });
});

test('the command line reads live holders through gh and exits nonzero without releasing anyone on a stale event', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1 $2" in\n  "pr list") echo 209 ;;\n  "pr view") echo ${S1} ;;\nesac\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  const run = (args, extra) => {
    try { return { code: 0, out: execFileSync('node', ['deploy/coolify/staging-ownership.mjs', ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_OUTPUT: join(dir, 'out'), ...extra } }) }; }
    catch (error) { return { code: error.status, out: `${error.stdout}${error.stderr}` }; }
  };
  writeFileSync(log, '');
  assert.equal(run(['decide'], env(labeled(208))).code, 0);
  assert.match(readFileSync(join(dir, 'out'), 'utf8'), /^branch=\npr=\nmode=\n$/);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /edit|comment/);
  const stale = run(['guard'], { MODE: 'pr', PR: '208', SHA: S1 });
  assert.equal(stale.code, 1); assert.match(stale.out, /expected only #208/);
  assert.equal(run(['guard'], { MODE: 'pr', PR: '209', SHA: S1 }).code, 0);
  assert.equal(run(['guard'], { MODE: 'pr', PR: '209', SHA: S2 }).code, 1);
});
