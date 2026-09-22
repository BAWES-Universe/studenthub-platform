// Emit the canonical receipt for one measurement. Runs in the emit job, on the measurer checked out from the
// dispatching ref (protected main), with NO candidate code checked out: the candidate reaches this process only
// as data - the dispatch input, the TAP the runner captured, and the manifest the candidate committed.
//
// Fails closed. Anything it cannot establish about a named test is `absent`, and absent is not passing. A claim
// that names no tests establishes nothing, so it cannot produce a passing receipt: a review defeated the earlier
// version with a manifest of `entries: []` and a crashing suite, because `[].every(...)` is `true`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const fail = message => {
  console.error(`REFUSING: ${message}`);
  process.exit(3);
};

const candidateSha = env.CANDIDATE_SHA ?? fail('no CANDIDATE_SHA: the measured commit must be supplied');
if (!/^[0-9a-f]{40}$/.test(candidateSha)) fail(`CANDIDATE_SHA is not a full commit sha: ${candidateSha}`);
const candidateTree = env.CANDIDATE_TREE ?? fail('no CANDIDATE_TREE');
const tapPath = env.TAP_PATH ?? fail('no TAP_PATH');
const manifestPath = env.MANIFEST_PATH ?? fail('no MANIFEST_PATH');
const outPath = env.OUT_PATH ?? path.join(process.cwd(), 'receipt.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.code_revision?.head !== candidateSha) {
  fail(`the claim names ${String(manifest.code_revision?.head).slice(0, 12)} as its code revision, but this run `
    + `was asked to measure ${candidateSha.slice(0, 12)}`);
}
if (manifest.code_revision?.tree !== candidateTree) {
  fail('the claim\'s code revision tree is not the tree that was checked out');
}

// What the claim says must exist. A control is a test the claim names; a mutant is a test that must die when its
// term is removed. Both are read from the candidate's manifest - as data, never as code.
const named = new Map();
for (const entry of manifest.entries ?? []) {
  for (const test of entry.control?.test_names ?? []) {
    named.set(test, { term: entry.id, kind: 'control', name: test });
  }
  for (const mutant of entry.killing_mutants ?? []) {
    if (mutant.test_name) named.set(mutant.test_name, { term: entry.id, kind: 'mutant', name: mutant.test_name });
  }
}

// The TAP the runner captured. Its own summary lines are authoritative for what the suite did: a run whose
// counts do not add up, or which reported no tests at all, is not a measurement of anything.
const tap = fs.readFileSync(tapPath, 'utf8');
const counts = { tests: 0, ok: 0, not_ok: 0, skipped: 0, todo: 0 };
const observed = new Map();
let tapLooksReal = false;
for (const line of tap.split('\n')) {
  const summary = /^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$/.exec(line.trim());
  if (summary) {
    tapLooksReal = true;
    if (summary[1] === 'tests') counts.tests = Number(summary[2]);
    if (summary[1] === 'pass') counts.ok = Number(summary[2]);
    if (summary[1] === 'fail') counts.not_ok = Number(summary[2]);
    if (summary[1] === 'skipped') counts.skipped = Number(summary[2]);
    if (summary[1] === 'todo') counts.todo = Number(summary[2]);
    continue;
  }
  const point = /^(ok|not ok) \d+ - (.*?)\s*$/.exec(line.trim());
  if (point) {
    tapLooksReal = true;
    observed.set(point[2], point[1] === 'ok' ? 'pass' : 'fail');
  }
}
if (!tapLooksReal) fail('the captured output is not TAP: no test points and no summary lines');

const perTest = [...named.values()].map(test => ({ ...test, status: observed.get(test.name) ?? 'absent' }));
const summary = {
  named: perTest.length,
  pass: perTest.filter(test => test.status === 'pass').length,
  fail: perTest.filter(test => test.status === 'fail').length,
  absent: perTest.filter(test => test.status === 'absent').length,
};

// Success means: the claim names tests, every one of them was observed, and every one passed. The suite's own
// exit code and counts travel with the receipt so an unrelated failure is visible rather than smoothed over.
const suiteExit = env.MEASURED_SUITE_EXIT ?? 'unknown';
const established = summary.named > 0 && summary.fail === 0 && summary.absent === 0;
const reasons = [];
if (summary.named === 0) reasons.push('the claim names no tests, so this run establishes nothing about any term');
if (summary.fail > 0) reasons.push(`${summary.fail} named test(s) failed in the measured run`);
if (summary.absent > 0) reasons.push(`${summary.absent} named test(s) did not appear in the measured run`);

const receipt = {
  schema: 1,
  repository: env.GITHUB_REPOSITORY ?? null,
  workflow: {
    path: '.github/workflows/verifier-receipt.yml',
    ref: env.GITHUB_WORKFLOW_REF ?? null,
    head_sha: env.GITHUB_SHA ?? null,
    workflow_ref: env.GITHUB_WORKFLOW_REF ?? null,
    event: env.GITHUB_EVENT_NAME ?? null,
  },
  run: { id: env.GITHUB_RUN_ID ?? null, attempt: env.GITHUB_RUN_ATTEMPT ?? null },
  candidate: { sha: candidateSha, tree: candidateTree },
  manifest: { sha256: null, code_revision: { head: manifest.code_revision?.head ?? null, tree: manifest.code_revision?.tree ?? null } },
  suite: { tests: counts.tests, ok: counts.ok, not_ok: counts.not_ok, skipped: counts.skipped, todo: counts.todo, exit: String(suiteExit) },
  named_tests: perTest,
  named_tests_summary: summary,
  conclusion: {
    verdict: established ? 'success' : 'failure',
    scope: 'the named tests of the claim this measured',
    reasons,
  },
};
receipt.manifest.sha256 = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`receipt for ${candidateSha.slice(0, 12)} tree ${candidateTree.slice(0, 8)}: verdict `
  + `${receipt.conclusion.verdict}; named ${summary.named} pass ${summary.pass} fail ${summary.fail} `
  + `absent ${summary.absent}; suite exit ${suiteExit}, tests ${counts.tests}`);
process.exit(0);
