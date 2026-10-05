import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desired, isMissingTag, runConfirm, runDecide, runResolve, validDigest } from '../staging-ownership.mjs';

const S1 = '1'.repeat(40), S2 = '2'.repeat(40), M = 'a'.repeat(40);
const D1 = `sha256:${'d'.repeat(63)}1`, D2 = `sha256:${'d'.repeat(63)}2`, DM = `sha256:${'d'.repeat(63)}a`;
const T1 = '2026-10-04T10:00:00Z', T2 = '2026-10-04T11:00:00Z', T3 = '2026-10-04T12:00:00Z';

// A tiny model of GitHub and the registry: open PRs with the label (when each was labelled,
// whether it is a fork), branch heads, and which dev-<sha> images have been pushed.
function world(labels, heads = { main: M }, images = {}) {
  const state = { labels: structuredClone(labels), heads: { ...heads }, images: { ...images }, released: [] };
  return { state, api: {
    holders: () => Object.keys(state.labels).map(Number),
    holder: (number) => ({ number, labeledAt: state.labels[number].at, headRef: `branch-${number}`, crossRepository: !!state.labels[number].fork }),
    prHead: (pr) => state.heads[pr],
    branchHead: (branch) => state.heads[branch],
    release: ({ number, fork }) => { state.released.push({ number, fork }); delete state.labels[number]; },
    devDigest: (sha) => state.images[sha] ?? '',
  } };
}
const holds = (w) => Object.keys(w.state.labels).map(Number);

test('the same-repository PR labelled most recently owns staging and every other holder is released', () => {
  const w = world({ 208: { at: T1 }, 209: { at: T2 } });
  assert.deepEqual(runDecide(w.api), { mode: 'pr', pr: '209', branch: 'branch-209', release: [{ number: 208, fork: false }] });
  assert.deepEqual(holds(w), [209]);
  // Ties go to the higher PR number, so two decisions always agree.
  assert.equal(desired([{ number: 208, labeledAt: T2 }, { number: 209, labeledAt: T2 }]).pr, '209');
});
test('with no holder staging follows main', () => {
  assert.deepEqual(runDecide(world({}).api), { mode: 'free', pr: '', branch: 'main', release: [] });
});
test('the decision depends only on live state, so any surviving run restores it', () => {
  // GPT review 3, finding 1: A runs with an old view, B is labelled and its queued decision
  // is replaced by a manual run, a main push or C's push. Decide takes no event input at all,
  // so the survivor settles on B exactly as B's own decision would have.
  const w = world({ 208: { at: T1 }, 209: { at: T2 } });
  assert.equal(runDecide.length, 1);
  assert.equal(runDecide(w.api).pr, '209');
  assert.deepEqual(holds(w), [209]);
  assert.equal(runDecide(w.api).pr, '209');
});
test('a fork PR never owns staging and never displaces the same-repository holder', () => {
  // GPT review 3, finding 2: same-repo A at T1, fork F at T2.
  const w = world({ 208: { at: T1 }, 901: { at: T2, fork: true } });
  const want = runDecide(w.api);
  assert.equal(want.pr, '208');
  assert.deepEqual(w.state.released, [{ number: 901, fork: true }]);
  assert.deepEqual(holds(w), [208]);
  assert.equal(runDecide(world({ 901: { at: T2, fork: true } }).api).branch, 'main');
});
test('a stale run that survives the switch queue puts the newest wanted build on staging', () => {
  // GPT review 3, finding 3: S2's switch was queued, then the slower S1 build's switch replaced it.
  const w = world({ 208: { at: T1 } }, { main: M, 208: S2 }, { [S1]: D1, [S2]: D2 });
  assert.deepEqual(runResolve(w.api), { mode: 'pr', pr: '208', branch: 'branch-208', release: [], sha: S2, digest: D2 });
});
test('a run whose wanted commit has no image yet changes nothing; that commit\'s own run follows', () => {
  const w = world({ 208: { at: T1 } }, { main: M, 208: S2 }, { [S1]: D1 });
  assert.equal(runResolve(w.api).digest, '');
});
test('staging follows main when nobody holds the label', () => {
  assert.deepEqual(runResolve(world({}, { main: M }, { [M]: DM }).api), { mode: 'free', pr: '', branch: 'main', release: [], sha: M, digest: DM });
});
test('the switch is confirmed only while its commit is still the wanted one', () => {
  const w = world({ 208: { at: T1 } }, { main: M, 208: S2 });
  assert.equal(runConfirm(w.api, S2), true);
  w.state.heads[208] = S1; // a newer push
  assert.equal(runConfirm(w.api, S2), false);
  w.state.heads[208] = S2; w.state.labels[209] = { at: T3 }; w.state.heads[209] = S1; // another PR took the label
  assert.equal(runConfirm(w.api, S2), false);
  delete w.state.labels[208]; delete w.state.labels[209]; // label removed: main is wanted
  assert.equal(runConfirm(w.api, M), true);
});
test('resolve refuses an unreadable head instead of guessing', () => {
  assert.throws(() => runResolve(world({ 208: { at: T1 } }, { main: M }).api), /could not read the head/);
});

test('the command line reconciles through gh and docker and writes its outputs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls'), out = join(dir, 'out');
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${log}"
case "$1 $2" in
  "pr list") printf '208\\n209\\n' ;;
  "pr view") case "$*" in
    *headRefOid*) echo ${S2} ;;
    "pr view 208"*) echo '{"headRefName":"a","isCrossRepository":false}' ;;
    *) echo '{"headRefName":"b","isCrossRepository":false}' ;;
  esac ;;
  "api --paginate") case "$*" in *issues/208*) echo ${T1} ;; *) echo ${T2} ;; esac ;;
esac
`);
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\necho "docker $*" >> "${log}"\ncase "$*" in *dev-${S2}*) echo '{"digest":"${D2}"}' ;; *) exit 1 ;; esac\n`);
  for (const f of ['gh', 'docker']) chmodSync(join(dir, f), 0o755);
  const run = (args, extra = {}) => {
    writeFileSync(out, '');
    try { execFileSync('node', ['deploy/coolify/staging-ownership.mjs', ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_OUTPUT: out, ...extra } }); return 0; }
    catch (error) { return error.status; }
  };
  writeFileSync(log, '');
  assert.equal(run(['decide']), 0);
  assert.equal(readFileSync(out, 'utf8'), 'branch=b\npr=209\nmode=pr\n');
  assert.match(readFileSync(log, 'utf8'), /gh pr edit 208 --repo o\/r --remove-label on-dev/);
  assert.equal(run(['resolve']), 0);
  assert.equal(readFileSync(out, 'utf8'), `sha=${S2}\ndigest=${D2}\npr=209\n`);
  assert.equal(run(['confirm'], { SHA: S2 }), 0);
  assert.equal(readFileSync(out, 'utf8'), 'current=true\n');
  assert.equal(run(['confirm'], { SHA: S1 }), 0);
  assert.equal(readFileSync(out, 'utf8'), 'current=false\n');
  assert.equal(run(['nonsense']), 1);
});

test('only a registry answer that the tag is missing counts as "not built yet"', () => {
  const ref = `ghcr.io/bawes-universe/studenthub-gateway:dev-${S1}`;
  assert.equal(isMissingTag(`ERROR: ${ref}: not found\n`, ref), true); // real buildx output for a missing tag
  assert.equal(isMissingTag('MANIFEST_UNKNOWN: manifest unknown', ref), true);
  for (const stderr of ['ERROR: failed to authorize: failed to fetch anonymous token: 403 Forbidden', 'unauthorized: authentication required',
    'dial tcp: i/o timeout', `ERROR: ${ref}-other: not found`, '']) assert.equal(isMissingTag(stderr, ref), false, stderr);
  assert.equal(validDigest(D1), D1);
  for (const bad of [undefined, '', 'sha256:short', `sha512:${'a'.repeat(64)}`]) assert.throws(() => validDigest(bad), /invalid digest/);
});

test('a registry failure fails the switch job instead of passing as "no image yet"', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\ncase "$1 $2" in\n  "pr list") echo 208 ;;\n  "pr view") case "$*" in *headRefOid*) echo ${S2} ;; *) echo '{"headRefName":"a","isCrossRepository":false}' ;; esac ;;\n  "api --paginate") echo ${T1} ;;\nesac\n`);
  const resolve = (docker) => {
    writeFileSync(join(dir, 'docker'), `#!/bin/sh\n${docker}\n`);
    for (const f of ['gh', 'docker']) chmodSync(join(dir, f), 0o755);
    writeFileSync(join(dir, 'out'), '');
    let code = 0;
    try { execFileSync('node', ['deploy/coolify/staging-ownership.mjs', 'resolve'], { stdio: 'pipe', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_OUTPUT: join(dir, 'out') } }); }
    catch (error) { code = error.status; }
    return { code, out: readFileSync(join(dir, 'out'), 'utf8') };
  };
  assert.deepEqual(resolve(`echo "ERROR: ghcr.io/bawes-universe/studenthub-gateway:dev-${S2}: not found" >&2; exit 1`), { code: 0, out: `sha=${S2}\ndigest=\npr=208\n` });
  assert.deepEqual(resolve(`echo '{"digest":"${D2}"}'`), { code: 0, out: `sha=${S2}\ndigest=${D2}\npr=208\n` });
  for (const failure of ['echo "unauthorized: authentication required" >&2; exit 1', 'echo "dial tcp: i/o timeout" >&2; exit 1', "echo 'not json'", `echo '{"digest":"sha256:short"}'`]) {
    assert.deepEqual(resolve(failure), { code: 1, out: '' }, failure);
  }
});
