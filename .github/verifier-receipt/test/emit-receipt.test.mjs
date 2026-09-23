// What the emitter must refuse, and what it must not refuse.
//
// The positive control comes first and is the most important test here: a hardening that breaks it is worse
// than the defect it was meant to close, because a verifier that cannot say `success` about a genuine
// measurement stops being used. Everything after it removes exactly one fact from a world that held together,
// and asserts the refusal NAMES the field that went wrong - a refusal that does not say which fact failed is
// an outage, not a safeguard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as world from './world.mjs';

const refusedOn = (result, field) => {
  assert.equal(result.code, 3, `expected a refusal, got exit ${result.code}\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, new RegExp(`^REFUSING: ${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `, 'm'),
    `refusal did not name ${field}:\n${result.stderr}`);
};

test('provenance held: the trusted job\'s own capture for this run yields success for the named tests', () => {
  const built = world.build();
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.deepEqual(receipt.named_tests_summary,
    { named: 3, pass: 3, fail: 0, absent: 0, skipped: 0, todo: 0, suite_points: 0 });
  assert.equal(receipt.provenance.artifact.digest, built.archiveDigest);
  assert.equal(receipt.provenance.artifact.archive_sha256, built.archiveDigest);
  assert.equal(receipt.provenance.capture.sha256, built.meta.capture_sha256);
  assert.equal(receipt.provenance.measure_job.conclusion, 'success');
  assert.equal(receipt.provenance.runner.key, 'coordinator');
  assert.equal(receipt.provenance.runner.command, world.RUNNER_COMMAND);
  assert.equal(receipt.provenance.admissible_as_pin, true);
  assert.deepEqual(receipt.provenance.inadmissibility_reasons, []);
});

test('the receipt carries every field a third party needs to re-fetch and re-check it', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.run.id, world.RUN_ID);
  assert.equal(receipt.run.attempt, world.RUN_ATTEMPT);
  assert.equal(receipt.workflow.path, '.github/workflows/verifier-receipt.yml');
  assert.equal(receipt.workflow.trusted_source_sha, world.TRUSTED_SHA);
  assert.equal(receipt.candidate.sha, world.CANDIDATE_SHA);
  assert.equal(receipt.candidate.tree, world.CANDIDATE_TREE);
  assert.equal(receipt.provenance.artifact.name, 'measure-capture');
  assert.equal(receipt.provenance.artifact.id, world.ARTIFACT_ID);
  assert.equal(receipt.provenance.claim.path, world.CLAIM_PATH);
  assert.equal(receipt.provenance.claim.ref, world.CANDIDATE_SHA);
  assert.match(receipt.provenance.claim.sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.suite.exit, '0');
  assert.equal(receipt.suite.tests, 3);
  assert.equal(receipt.named_tests.length, 3);
  // The well-formedness check travels labelled as what it is, and never as evidence of genuineness.
  assert.equal(receipt.structure_check.kind, 'well-formedness');
  assert.match(receipt.structure_check.note, /does not say it is GENUINE/);
});

// ---- provenance refused, by name -------------------------------------------------------------------------

test('a capture offered under a different run id is refused, naming the run', () => {
  const built = world.build();
  refusedOn(world.emit(built, { RUN_ID: '34900000999' }), 'run.id');
});

test('a capture whose meta names another run is refused, naming the capture\'s run id', () => {
  const built = world.build({ meta: { run_id: '34900000002' } });
  refusedOn(world.emit(built), 'capture.run_id');
});

test('a capture taken on another attempt is refused, naming the attempt', () => {
  const built = world.build({ meta: { run_attempt: '2' } });
  refusedOn(world.emit(built), 'capture.run_attempt');
});

test('a capture of another candidate is refused, naming the candidate sha', () => {
  const built = world.build({ meta: { candidate_sha: '9'.repeat(40) } });
  refusedOn(world.emit(built), 'capture.candidate_sha');
});

test('a candidate whose tree is not the tree the API reports is refused, naming the tree', () => {
  const built = world.build();
  refusedOn(world.emit(built, { CANDIDATE_TREE: '1'.repeat(40) }), 'candidate.tree');
});

test('an artifact digest other than the one the measure job reported is refused, naming the digest', () => {
  const built = world.build({ artifact: { digest: `sha256:${'0'.repeat(64)}` } });
  refusedOn(world.emit(built), 'artifact.digest');
});

test('an archive that does not hash to the digest GitHub reports is refused, naming the digest', () => {
  const built = world.build();
  // The API still reports the real digest, but the bytes it serves are another artifact's.
  const other = world.build({ capture: world.tapFor(['a different run entirely']) });
  const routes = JSON.parse(fs.readFileSync(built.routesPath, 'utf8'));
  routes[`/repos/${world.REPO}/actions/artifacts/${world.ARTIFACT_ID}/zip`] = { binary_file: other.zipPath };
  fs.writeFileSync(built.routesPath, JSON.stringify(routes, null, 2));
  refusedOn(world.emit(built), 'artifact.digest');
});

test('an artifact belonging to another run is refused, naming the run it belongs to', () => {
  const built = world.build({ artifact: { workflow_run: { id: 34900000777 } } });
  refusedOn(world.emit(built), 'artifact.workflow_run.id');
});

test('a measure job that did not conclude success is refused, naming the conclusion', () => {
  refusedOn(world.emit(world.build({ job: { conclusion: 'failure' } })), 'measure_job.conclusion');
});

test('a measure job that is still running is refused, naming the status', () => {
  refusedOn(world.emit(world.build({ job: { status: 'in_progress', conclusion: null } })), 'measure_job.status');
});

test('a run with no job of the measure job\'s name is refused, naming the job', () => {
  refusedOn(world.emit(world.build({ job: { name: 'something-else' } })), 'measure_job.name');
});

test('a run of another workflow is refused, naming the workflow path', () => {
  refusedOn(world.emit(world.build({ run: { path: '.github/workflows/ci.yml' } })), 'workflow.path');
});

test('an artifact carrying anything but the two files the measure job writes is refused, naming its contents', () => {
  const built = world.build({ extraArtifactFiles: { 'candidate-supplied.tap': 'TAP version 13\n1..0\n' } });
  refusedOn(world.emit(built), 'artifact.contents');
});

test('a capture whose bytes are not the bytes the measure job digested is refused, naming the capture digest', () => {
  const built = world.build({ meta: { capture_sha256: '7'.repeat(64) } });
  refusedOn(world.emit(built), 'capture.sha256');
});

test('a capture produced by a runner command outside the protected enum is refused, naming the command', () => {
  const built = world.build({ meta: { runner_command: 'cat .github/fabricated.tap' } });
  refusedOn(world.emit(built), 'capture.runner_command');
});

test('a runner key that is not in the protected enum is refused, naming the key', () => {
  refusedOn(world.emit(world.build(), { RUNNER_KEY: 'whatever-the-candidate-likes' }), 'runner.key');
});

// ---- the candidate cannot supply the evidence, by any route ------------------------------------------------

test('a candidate-supplied TAP path is not evidence: the emitter reads only its own capture', () => {
  const built = world.build();
  const fabricated = path.join(built.root, 'candidate-choice.tap');
  fs.writeFileSync(fabricated, world.tapFor(['a test that never ran']));
  // Every path-shaped input the previous emitter accepted, offered at once.
  const result = world.emit(built, {
    TAP_PATH: fabricated,
    MANIFEST_PATH: path.join(built.root, 'candidate-choice.json'),
    SUITE_COMMAND: 'cat candidate-choice.tap',
  });
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  // The receipt describes the trusted capture, not the file that was offered.
  assert.equal(receipt.provenance.capture.sha256, built.meta.capture_sha256);
  assert.equal(receipt.named_tests_summary.named, 3);
  assert.ok(!receipt.named_tests.some(test => test.name === 'a test that never ran'));
});

test('the hand-written TAP that once produced success is refused on provenance, not on its plan', () => {
  // The fabrication is well formed: a header, a plan that matches, typed points, a reconciling summary, a
  // footer. Every structural rule passes. It fails because no measure job of this run produced it.
  const fabricated = world.tapFor(['a test that never ran']);
  const built = world.build({ capture: fabricated, meta: { run_id: '34899999999' } });
  const result = world.emit(built);
  refusedOn(result, 'capture.run_id');
  assert.doesNotMatch(result.stderr, /plan|reconcile|summary/i,
    `the refusal must name the provenance failure, not a malformed plan:\n${result.stderr}`);
});

test('a fabrication handed over as an artifact of another run is refused before any line of it is read', () => {
  const built = world.build({ capture: world.tapFor(['a test that never ran']), run: { id: 34900000123 } });
  refusedOn(world.emit(built), 'run.id');
});

// ---- the claim, and the authority --------------------------------------------------------------------------

test('a candidate that modifies the receipt authority is refused, naming the authority', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/contents/.github?ref=${world.CANDIDATE_SHA}`]: { json: [
      { name: 'coordinator', type: 'dir', sha: '6f'.repeat(20) },
      { name: 'verifier-receipt', type: 'dir', sha: '9999'.repeat(10) },
      { name: 'workflows', type: 'dir', sha: '5e'.repeat(20) }] },
  } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /\.github\/verifier-receipt/);
});

// The hole this replaced: the check read `files[].filename` from a comparison GitHub caps at 300 entries and
// truncates, in ascending filename order, with nothing in the response saying so. 300 paths under `.github/a...`
// sort before `.github/verifier-receipt/`, so an authority edit fell off the end of the list and the candidate
// was approved as `touches_authority: false`. The identity check never reads that list, so the filler does not
// reach it.
test('a candidate hiding its authority edit behind a full 300-file comparison page is still refused', () => {
  const filler = Array.from({ length: 300 }, (unused, index) => ({
    filename: `.github/aaa/${String(index).padStart(4, '0')}.json`, status: 'added' }));
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/main...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead', ahead_by: 137,
      total_commits: 137, files: filler } },
    [`/repos/${world.REPO}/contents/.github?ref=${world.CANDIDATE_SHA}`]: { json: [
      { name: 'verifier-receipt', type: 'dir', sha: '9999'.repeat(10) },
      { name: 'workflows', type: 'dir', sha: '5e'.repeat(20) }] },
  } });
  refusedOn(world.emit(built), 'candidate.authority');
});

// A rename is reported under its NEW name, with the old path only in `previous_filename`. Moving the emitter to
// `.github/parked/` DELETES the authority, and the pattern-over-`filename` check called that untouched.
test('a candidate that renames the authority away is refused, naming the absent path', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/contents/.github?ref=${world.CANDIDATE_SHA}`]: { json: [
      { name: 'parked', type: 'dir', sha: '2b'.repeat(20) },
      { name: 'workflows', type: 'dir', sha: '5e'.repeat(20) }] },
  } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /absent at the candidate/);
});

test('a candidate that renames the workflow to another extension is refused', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/contents/.github/workflows?ref=${world.CANDIDATE_SHA}`]: { json: [
      { name: 'ci.yml', type: 'file', sha: '3c'.repeat(20) },
      { name: 'verifier-receipt.yaml', type: 'file', sha: world.AUTHORITY_WORKFLOW_SHA }] },
  } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /verifier-receipt\.yml is absent at the candidate/);
});

test('an authority listing the API will not serve is refused, not skipped', () => {
  const built = world.build({ dropRoutes: [`/repos/${world.REPO}/contents/.github?ref=${world.CANDIDATE_SHA}`] });
  refusedOn(world.emit(built), 'candidate.authority');
});

test('the receipt carries the object ids the authority decision was made from', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.candidate.touches_authority, false);
  assert.deepEqual(receipt.candidate.authority_identity.map(entry => entry.path),
    ['.github/workflows/verifier-receipt.yml', '.github/verifier-receipt']);
  for (const entry of receipt.candidate.authority_identity) {
    assert.equal(entry.protected_sha, entry.candidate_sha);
  }
});

test('a candidate carrying no claim is refused, naming the claim path', () => {
  const built = world.build({ dropRoutes: [`/repos/${world.REPO}/contents/${world.CLAIM_PATH}?ref=${world.CANDIDATE_SHA}`] });
  refusedOn(world.emit(built), 'claim.path');
});

test('a claim whose code revision the candidate is not a descendant of is refused, naming the revision', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/${world.CLAIM_HEAD}...${world.CANDIDATE_SHA}`]: { json: { status: 'diverged', files: [] } },
  } });
  refusedOn(world.emit(built), 'claim.code_revision.head');
});

test('a claim measured against a commit that changed code beyond the claim is refused, naming the revision', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/${world.CLAIM_HEAD}...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead',
      ahead_by: 1, total_commits: 1,
      files: [{ filename: world.CLAIM_PATH }, { filename: '.github/coordinator/push-broker.mjs' }] } },
  } });
  refusedOn(world.emit(built), 'claim.code_revision.head');
});

// ---- the widening is one commit wide, and the claim's own files wide ----------------------------------------

test('a claim whose code revision is 137 commits behind the measured commit is refused, naming the revision', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/${world.CLAIM_HEAD}...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead',
      ahead_by: 137, total_commits: 137, files: [{ filename: world.CLAIM_PATH }] } },
  } });
  const result = world.emit(built);
  refusedOn(result, 'claim.code_revision.head');
  assert.match(result.stderr, /137 commit\(s\)/);
});

test('a claim whose code revision is not a parent of the measured commit is refused, even one step ahead', () => {
  const built = world.build({ candidateParents: [{ sha: '3'.repeat(40) }] });
  const result = world.emit(built);
  refusedOn(result, 'claim.code_revision.head');
  assert.match(result.stderr, /nor one of its parents/);
});

// The hard bound: NO code path may change between the claim's code revision and the candidate, however much
// bookkeeping surrounds it. `.github/coordinator/service/receipts/` is tolerated as a bounded shape (plain
// `.json` directly in that one directory), so the filler below is genuinely tolerated here - and the code
// change is still named in the refusal, because tolerating the filler was never what admitted it.
test('a step that changes apps/, packages/ or tools/ is refused however much bookkeeping surrounds it', () => {
  for (const codePath of ['apps/gateway/src/index.ts', 'packages/contracts/src/authz.ts', 'tools/seed/run.mjs']) {
    const built = world.build({ routes: {
      [`/repos/${world.REPO}/compare/${world.CLAIM_HEAD}...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead',
        ahead_by: 1, total_commits: 1, files: [
          ...Array.from({ length: 5 }, (unused, index) => ({
            filename: `.github/coordinator/service/receipts/${String(index).padStart(4, '0')}.json` })),
          { filename: codePath, status: 'modified' },
        ] } },
    } });
    const result = world.emit(built);
    refusedOn(result, 'claim.code_revision.head');
    assert.match(result.stderr, new RegExp(codePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('a comparison at GitHub\'s 300-file cap is refused as truncated, not read as a boundary', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/${world.CLAIM_HEAD}...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead',
      ahead_by: 1, total_commits: 1,
      files: Array.from({ length: 300 }, (unused, index) => ({
        filename: `.github/coordinator/service/receipts/${String(index).padStart(4, '0')}.json` })) } },
  } });
  const result = world.emit(built);
  refusedOn(result, 'claim.code_revision.delta');
  assert.match(result.stderr, /truncated/);
});

test('a comparison that carries no file list is refused, not read as "nothing changed"', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/${world.CLAIM_HEAD}...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead',
      ahead_by: 1, total_commits: 1 } },
  } });
  refusedOn(world.emit(built), 'claim.code_revision.delta');
});

test('a step that renames code ONTO a bookkeeping path is refused, naming the path it came from', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/${world.CLAIM_HEAD}...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead',
      ahead_by: 1, total_commits: 1, files: [{ filename: world.CLAIM_PATH, status: 'renamed',
        previous_filename: 'apps/gateway/src/index.ts' }] } },
  } });
  const result = world.emit(built);
  refusedOn(result, 'claim.code_revision.head');
  assert.match(result.stderr, /apps\/gateway\/src\/index\.ts/);
});

// WHAT THE REPOSITORY ACTUALLY WRITES BESIDE A MANIFEST. Measured over every commit that ever touched
// claim-manifest.json: the manifest itself (11), `receipts/<name>.json` (4) and `suite-inventory.json` (2). An
// earlier version of this list refused the receipts file - the commonest of the three - while tolerating
// `.github/coordinator/service/verifier-receipts.json`, a name that has never existed in this repository. The
// tolerance is for the paths that are really written, and for no others.
const stepChanging = filenames => ({ routes: {
  [`/repos/${world.REPO}/compare/${world.CLAIM_HEAD}...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead',
    ahead_by: 1, total_commits: 1, files: filenames.map(filename => ({ filename, status: 'modified' })) } },
} });

test('the bookkeeping this repository really writes beside a manifest is tolerated', () => {
  const built = world.build(stepChanging([
    world.CLAIM_PATH,
    '.github/coordinator/service/receipts/verifier-r32.json',
    '.github/coordinator/service/receipts/b6-arming-robustness-and-manifest-guard.json',
    '.github/coordinator/service/suite-inventory.json',
  ]));
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.deepEqual(receipt.provenance.claim.delta_from_code_revision, [
    world.CLAIM_PATH,
    '.github/coordinator/service/receipts/verifier-r32.json',
    '.github/coordinator/service/receipts/b6-arming-robustness-and-manifest-guard.json',
    '.github/coordinator/service/suite-inventory.json',
  ]);
});

// The receipts directory is a bounded shape, not a prefix: one level deep, plain `.json` only. Anything else
// under it is code or a path traversal wearing a tolerated prefix.
test('the receipts directory is tolerated as a shape, not as a prefix', () => {
  for (const beyond of [
    '.github/coordinator/service/receipts/regenerate.mjs',
    '.github/coordinator/service/receipts/nested/run.json',
    '.github/coordinator/service/receipts/../../../../apps/gateway/src/index.ts',
    '.github/coordinator/service/receipts/.hidden.json',
    '.github/coordinator/service/receipts-sneaky.json',
    '.github/coordinator/service/receipts/',
  ]) {
    const result = world.emit(world.build(stepChanging([world.CLAIM_PATH, beyond])));
    refusedOn(result, 'claim.code_revision.head');
    assert.match(result.stderr, new RegExp(beyond.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `the refusal must name ${beyond}`);
  }
});

test('the name that has never existed in this repository is not tolerated', () => {
  const result = world.emit(world.build(stepChanging([
    world.CLAIM_PATH, '.github/coordinator/service/verifier-receipts.json'])));
  refusedOn(result, 'claim.code_revision.head');
  assert.match(result.stderr, /verifier-receipts\.json/);
});

// The tolerance widened; the bound did not. A rename out of a code path onto a NOW-tolerated bookkeeping path
// is still refused under the name it came from.
test('a rename of code onto the receipts directory is still refused, naming where it came from', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/${world.CLAIM_HEAD}...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead',
      ahead_by: 1, total_commits: 1, files: [
        { filename: '.github/coordinator/service/receipts/r33.json', status: 'renamed',
          previous_filename: 'packages/contracts/src/authz.ts' }] } },
  } });
  const result = world.emit(built);
  refusedOn(result, 'claim.code_revision.head');
  assert.match(result.stderr, /packages\/contracts\/src\/authz\.ts/);
});

test('the legitimate one-commit widening still succeeds, and the receipt records the step\'s files', () => {
  const built = world.build();
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.equal(receipt.provenance.claim.code_revision.head, world.CLAIM_HEAD);
  assert.deepEqual(receipt.provenance.claim.delta_from_code_revision, [world.CLAIM_PATH]);
});

test('a claim whose named tree is not that revision\'s tree is refused, naming the tree', () => {
  const built = world.build({ claim: { ...world.CLAIM, code_revision: { head: world.CLAIM_HEAD, tree: '2'.repeat(40) } } });
  refusedOn(world.emit(built), 'claim.code_revision.tree');
});

test('a claim committed at the revision it names needs no step, and still succeeds', () => {
  const built = world.build({
    claim: { ...world.CLAIM, code_revision: { head: world.CANDIDATE_SHA, tree: world.CANDIDATE_TREE } },
  });
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(world.receiptOf(built).provenance.claim.delta_from_code_revision, []);
});

// ---- the verdict is still about the named tests -------------------------------------------------------------

test('a named test that failed in the trusted capture makes the verdict failure', () => {
  const built = world.build({ capture: world.tapFor(world.NAMED_TESTS, { failing: [world.NAMED_TESTS[1]] }) });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.equal(receipt.named_tests_summary.fail, 1);
});

test('a named test absent from the trusted capture makes the verdict failure', () => {
  const built = world.build({ capture: world.tapFor(world.NAMED_TESTS.slice(0, 2)) });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.equal(receipt.named_tests_summary.absent, 1);
});

test('a claim that names no test cannot produce success', () => {
  const built = world.build({ claim: { ...world.CLAIM, entries: [] }, capture: world.tapFor(['anything at all']) });
  assert.equal(world.emit(built).code, 0);
  assert.equal(world.receiptOf(built).conclusion.verdict, 'failure');
});

// ---- defence in depth, labelled as such ----------------------------------------------------------------------

test('a truncated capture is still refused by the well-formedness check, naming the structure', () => {
  const full = world.tapFor(world.NAMED_TESTS);
  const built = world.build({ capture: full.slice(0, full.indexOf('1..3')) });
  refusedOn(world.emit(built), 'capture.structure');
});

test('two runs concatenated into one capture are refused by the well-formedness check', () => {
  const built = world.build({ capture: world.tapFor(world.NAMED_TESTS) + world.tapFor(world.NAMED_TESTS) });
  refusedOn(world.emit(built), 'capture.structure');
});

// ---- admissibility is separate from the verdict ---------------------------------------------------------------

test('a rehearsal run produces a receipt that says, by name, why it may not be pinned', () => {
  const built = world.build({ run: { event: 'pull_request', head_branch: 'verifier/bootstrap-receipt-producer' } });
  const result = world.emit(built, { TRUSTED_SOURCE_ORIGIN: 'pull-request-head' });
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.equal(receipt.provenance.admissible_as_pin, false);
  assert.equal(receipt.provenance.inadmissibility_reasons.length, 3);
  assert.match(receipt.provenance.inadmissibility_reasons.join(' | '), /pull_request/);
  assert.match(receipt.provenance.inadmissibility_reasons.join(' | '), /pull-request-head/);
});

test('an authority commit that main does not contain makes the receipt inadmissible', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/${world.TRUSTED_SHA}...main`]: { json: { status: 'diverged' } },
  } });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.provenance.admissible_as_pin, false);
  assert.match(receipt.provenance.inadmissibility_reasons.join(' | '), /is not contained in main/);
});

test('every identifying input is required: the emitter defaults nothing that names the evidence', () => {
  for (const name of ['REPO', 'RUN_ID', 'RUN_ATTEMPT', 'TRUSTED_SOURCE_SHA', 'TRUSTED_SOURCE_ORIGIN',
    'MEASURE_JOB_NAME', 'MEASURE_ARTIFACT_NAME', 'MEASURE_ARTIFACT_ID', 'MEASURE_ARTIFACT_DIGEST',
    'CANDIDATE_SHA', 'CANDIDATE_TREE', 'RUNNER_KEY', 'RUNNER_SPEC_PATH']) {
    refusedOn(world.emit(world.build(), { [name]: undefined }), `env.${name}`);
    // A workflow expression that resolves to nothing arrives as the empty string, which is the same failure.
    refusedOn(world.emit(world.build(), { [name]: '' }), `env.${name}`);
  }
});

// ---- a repeated point name is not a measurement of that name ------------------------------------------------

// The capture here is genuine: `node --test --test-reporter=tap` over a fixture that reports one name twice,
// failing first and passing second. Keying the observed status by name and overwriting it meant the later `ok`
// erased the earlier `not ok`, so a test the PROTECTED runner watched fail was carried into the receipt as
// `pass` - a failure the summary counts still showed, discarded from the verdict for that test.
test('a name the genuine capture reports as fail then pass is recorded fail, not pass', () => {
  const capture = world.genuineTap('duplicate-name.mjs');
  assert.match(capture, /^not ok 3 - a duplicated name$/m, 'the fixture must really fail first');
  assert.match(capture, /^ok 4 - a duplicated name$/m, 'the fixture must really pass second');
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-DUP', control: { test_names: ['a duplicated name'] }, killing_mutants: [] }],
  };
  const built = world.build({ capture, claim, meta: { suite_exit: '1' } });
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.deepEqual(receipt.named_tests.map(test => [test.name, test.status]), [['a duplicated name', 'fail']]);
  assert.equal(receipt.named_tests_summary.fail, 1);
  assert.equal(receipt.conclusion.verdict, 'failure');
  // The repeat itself is recorded, not just its worst outcome.
  assert.deepEqual(receipt.duplicate_points, [{ name: 'a duplicated name', points: 2,
    statuses: ['fail', 'pass'], collapsed_to: 'fail' }]);
  assert.match(receipt.conclusion.reasons.join(' | '), /reported 2 times, as fail and pass/);
  // And the suite counts the receipt carries still agree with the reporter's own.
  assert.equal(receipt.suite.not_ok, 1);
  assert.equal(receipt.suite.tests, 4);
});

test('a name reported twice, both passing, is still pass - and the repeat is recorded', () => {
  const capture = [
    'TAP version 13',
    'ok 1 - a repeated name', '  ---', '  duration_ms: 1', "  type: 'test'", '  ...',
    'ok 2 - a repeated name', '  ---', '  duration_ms: 1', "  type: 'test'", '  ...',
    '1..2', '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
    '# duration_ms 3', '',
  ].join('\n');
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-REPEAT', control: { test_names: ['a repeated name'] }, killing_mutants: [] }],
  };
  const built = world.build({ capture, claim });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.equal(receipt.named_tests[0].points, 2);
  assert.deepEqual(receipt.duplicate_points, [{ name: 'a repeated name', points: 2, statuses: ['pass'],
    collapsed_to: 'pass' }]);
});

// ---- `ok` is not `pass`: a skipped test and an empty describe() are not measurements ----------------------

// The capture here is genuine: `node --test --test-reporter=tap` over a fixture that really skips one test,
// really marks one todo, and really declares one empty `describe()`. A review defeated the emitter with the
// first and the third of those - both put `ok` on the wire, and both were recorded `pass` for a term.
const SKIP_SUITE_CLAIM = {
  code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
  entries: [
    { id: 'TERM-SKIP', control: { test_names: ['the stale-head guard holds'] }, killing_mutants: [] },
    { id: 'TERM-SUITE', control: { test_names: [] },
      killing_mutants: [{ test_name: 'the mutant that removes the stale-head guard dies' }] },
    { id: 'TERM-TODO', control: { test_names: ['the broker retry budget is respected'] }, killing_mutants: [] },
    { id: 'TERM-REAL', control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] },
  ],
};

test('a test the runner reported `# SKIP` is not pass, and the marker is not part of its name', () => {
  const capture = world.genuineTap('skipped-and-suite.mjs');
  assert.match(capture, /^ok 1 - the stale-head guard holds # SKIP$/m, 'the fixture must really skip');
  assert.match(capture, /^ok 3 - the mutant that removes the stale-head guard dies$/m);
  assert.match(capture, /^# tests 3$/m, 'the runner must really report 3 tests for 4 points');
  const built = world.build({ capture, claim: SKIP_SUITE_CLAIM });
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  // The name is the test's own name - the directive was stripped, not captured into it - so the entry is
  // matched and recorded `skip`, rather than silently going `absent` under a name nothing reported.
  assert.deepEqual(receipt.named_tests.map(named => [named.name, named.status]), [
    ['the stale-head guard holds', 'skip'],
    ['the mutant that removes the stale-head guard dies', 'suite'],
    ['the broker retry budget is respected', 'todo'],
    ['the coordinator refuses a stale head', 'pass'],
  ]);
  assert.deepEqual(receipt.named_tests_summary,
    { named: 4, pass: 1, fail: 0, absent: 0, skipped: 1, todo: 1, suite_points: 1 });
  // Each of the three is a term this run establishes nothing about, and each is named as such.
  assert.deepEqual(receipt.terms.map(term => [term.id, term.establishes]),
    [['TERM-SKIP', false], ['TERM-SUITE', false], ['TERM-TODO', false], ['TERM-REAL', true]]);
  assert.deepEqual(receipt.terms_summary.without_evidence, ['TERM-SKIP', 'TERM-SUITE', 'TERM-TODO']);
  const reasons = receipt.conclusion.reasons.join(' | ');
  assert.match(reasons, /1 named test\(s\) were reported with a `# SKIP` directive.*the stale-head guard holds/);
  assert.match(reasons, /1 named test\(s\) were reported with a `# TODO` directive.*the broker retry budget is respected/);
  assert.match(reasons, /matched only by a `type: 'suite'` point.*the mutant that removes the stale-head guard dies/);
});

test('naming a skipped test verbatim WITH its `# SKIP` marker does not match it either', () => {
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-MARKER',
      control: { test_names: ['the stale-head guard holds # SKIP'] }, killing_mutants: [] }],
  };
  const built = world.build({ capture: world.genuineTap('skipped-and-suite.mjs'), claim });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.deepEqual(receipt.named_tests.map(named => named.status), ['absent']);
});

// A suite point and a test point can share a name - `describe('x')` beside `test('x')`. The collapse is
// pessimistic there as it is for two test points: the suite point is not evidence that the test ran.
test('a name reported by both a suite point and a passing test point collapses to the suite point', () => {
  const capture = [
    'TAP version 13',
    'ok 1 - a shared name', '  ---', '  duration_ms: 1', "  type: 'suite'", '  ...',
    'ok 2 - a shared name', '  ---', '  duration_ms: 1', "  type: 'test'", '  ...',
    '1..2', '# tests 1', '# suites 1', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
    '# duration_ms 3', '',
  ].join('\n');
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-SHARED', control: { test_names: ['a shared name'] }, killing_mutants: [] }],
  };
  const built = world.build({ capture, claim });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.deepEqual(receipt.named_tests.map(named => named.status), ['suite']);
  assert.deepEqual(receipt.duplicate_points, [{ name: 'a shared name', points: 2,
    statuses: ['suite', 'pass'], collapsed_to: 'suite' }]);
});

// A `#` a test author put in a NAME is escaped by the reporter as `\#`, so it is never read as a directive and
// the name still matches. Guards the directive rule against eating part of a real name.
test('a `#` inside a test name is not read as a directive', () => {
  const capture = [
    'TAP version 13',
    'ok 1 - a name with a \\# hash inside', '  ---', '  duration_ms: 1', "  type: 'test'", '  ...',
    '1..1', '# tests 1', '# suites 0', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
    '# duration_ms 3', '',
  ].join('\n');
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-HASH',
      control: { test_names: ['a name with a \\# hash inside'] }, killing_mutants: [] }],
  };
  const built = world.build({ capture, claim });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.deepEqual(receipt.named_tests.map(named => named.status), ['pass']);
});

// ---- every term is named, whether or not it names a test ------------------------------------------------------

// The claim-wide `named > 0` rule let a term that names no test ride to `success` on a sibling term's coverage,
// with no entry, no reason and no marker anywhere in the receipt.
test('terms that name no tests cannot ride to success on a sibling term\'s coverage', () => {
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [
      { id: 'TERM-covered', control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] },
      { id: 'TERM-empty-a', control: { test_names: [] }, killing_mutants: [] },
      { id: 'TERM-empty-b', control: {} },
      { id: 'TERM-no-control' },
    ],
  };
  const built = world.build({ claim, capture: world.tapFor(['the coordinator refuses a stale head']) });
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.notDeepEqual(receipt.conclusion.reasons, []);
  assert.match(receipt.conclusion.reasons.join(' | '),
    /3 term\(s\) name no tests, so this run establishes nothing about them: TERM-empty-a, TERM-empty-b, TERM-no-control/);
  // Every term the manifest lists appears, with what this run establishes about it.
  assert.deepEqual(receipt.terms.map(term => [term.id, term.named, term.establishes]), [
    ['TERM-covered', 1, true], ['TERM-empty-a', 0, false], ['TERM-empty-b', 0, false], ['TERM-no-control', 0, false]]);
  assert.deepEqual(receipt.terms_summary, { total: 4, establishing: 1, naming_no_tests: 3,
    without_evidence: ['TERM-empty-a', 'TERM-empty-b', 'TERM-no-control'] });
  // And the run still establishes what it did establish, term by term.
  assert.equal(receipt.named_tests_summary.pass, 1);
});

test('a term whose only named test failed is marked as establishing nothing, by name', () => {
  const built = world.build({ capture: world.tapFor(world.NAMED_TESTS, { failing: ['the push broker retries only reads'] }) });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.deepEqual(receipt.terms.map(term => [term.id, term.establishes]), [['TERM-1', true], ['TERM-2', false]]);
  assert.deepEqual(receipt.terms_summary.without_evidence, ['TERM-2']);
});

test('two terms naming one test are two entries, each attributed to its own term', () => {
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [
      { id: 'TERM-A', control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] },
      { id: 'TERM-B', control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] },
    ],
  };
  const built = world.build({ claim, capture: world.tapFor(['the coordinator refuses a stale head']) });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.deepEqual(receipt.named_tests.map(test => test.term), ['TERM-A', 'TERM-B']);
  assert.deepEqual(receipt.terms.map(term => [term.id, term.named]), [['TERM-A', 1], ['TERM-B', 1]]);
  assert.equal(receipt.conclusion.verdict, 'success');
});

// ---- the candidate tree is required, like every other identity field ------------------------------------------

test('a capture that records no candidate tree is refused, naming the capture\'s tree', () => {
  const built = world.build({ meta: { candidate_tree: '' } });
  refusedOn(world.emit(built), 'capture.candidate_tree');
});

// ---- the workflow's own bounds, and its own gate, read out of the workflow file --------------------------------

// Everything above tests the emitter. The two things below test the WORKFLOW, because a receipt's authority
// rests on the job that measured and on the step that refuses - and neither of those is code the emitter's
// tests would otherwise touch.
const WORKFLOW_PATH = path.join(world.HERE, '..', '..', 'workflows', 'verifier-receipt.yml');
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8');

// `grep -n timeout .github/workflows/verifier-receipt.yml` once returned nothing. With no bound, a job that
// wedges - the measure job runs a candidate's suite, and a suite can hang - holds a hosted runner until
// GitHub cancels it at the 360-minute default: fail-closed, since `emit` needs `measure` and nothing is
// minted, but six hours spent on a cancellation that names nothing, on a workflow that triggers on every pull
// request touching this authority. This asserts the bound for EVERY job, so a job added later without one
// fails here rather than on a runner.
test('every job of this workflow bounds how long it may hold a runner', () => {
  const jobsBlock = WORKFLOW.slice(WORKFLOW.indexOf('\njobs:\n') + 1);
  const heads = [...jobsBlock.matchAll(/^ {2}([a-z][\w-]*):$/gm)];
  const jobs = heads.map((head, index) => ({
    name: head[1],
    body: jobsBlock.slice(head.index, heads[index + 1]?.index ?? jobsBlock.length),
  }));
  assert.deepEqual(jobs.map(job => job.name), ['trust', 'measure', 'emit'],
    'the jobs this workflow declares - if this changed, the bounds below were not re-read');
  for (const job of jobs) {
    const bound = /^ {4}timeout-minutes: (\d+)$/m.exec(job.body);
    assert.ok(bound, `job \`${job.name}\` declares no timeout-minutes, so it runs to GitHub's 360-minute default`);
    const minutes = Number(bound[1]);
    assert.ok(minutes > 0 && minutes < 360,
      `job \`${job.name}\` is bounded at ${minutes} minutes, which is not below GitHub's 360-minute default`);
  }
  // And the measure job's bound in particular is the one chosen against a measurement: the pinned `coordinator`
  // runner completes its 3667 tests in 289s (4m49s), so a bound near that would fail a green suite on a hosted
  // runner only slightly slower than the machine that was measured.
  const measure = jobs.find(job => job.name === 'measure');
  assert.ok(Number(/^ {4}timeout-minutes: (\d+)$/m.exec(measure.body)[1]) >= 10,
    'the measure job must leave real room above the 4m49s the pinned runner takes');
});

// THE GATE STEP, LIFTED OUT OF THE YAML AND RUN. The gate is the receipt's second reader: the emitter writes a
// verdict, and this step refuses to let `emit`'s attest step see an `admissible` output unless the receipt it
// reads says what it must. Until now nothing executed it - it was asserted to be right by reading it. Its body
// is extracted here verbatim, so a change to the step changes what these tests run.
const GATE_SOURCE = (() => {
  const step = WORKFLOW.indexOf('\n        id: gate\n');
  assert.ok(step > 0, 'the workflow no longer declares a step with `id: gate`');
  const opens = '\n          node -e "\n';
  const from = WORKFLOW.indexOf(opens, step);
  assert.ok(from > 0, 'the gate step no longer runs its body through `node -e`');
  const rest = WORKFLOW.slice(from + opens.length);
  const to = rest.indexOf('\n          "\n');
  assert.ok(to > 0, 'the gate step\'s `node -e` body is not closed where this test expects it');
  // The body is a double-quoted shell word, so the shell turns each `\`` back into a backtick before node sees
  // it. Nothing else in it is escaped - it carries no `$` and no backslash the shell would eat.
  const body = rest.slice(0, to);
  assert.ok(!body.includes('$('), 'the gate body gained a shell substitution this extraction does not model');
  return body.replace(/\\`/g, '`');
})();

// The gate is run where the emitter just wrote, because the step reads `receipt.json` from the job's workspace.
const runGate = built => {
  const outputFile = path.join(built.root, 'github-output');
  fs.writeFileSync(outputFile, '');
  const gate = world.runNode(['-e', GATE_SOURCE],
    { cwd: path.dirname(built.receiptPath), env: { GITHUB_OUTPUT: outputFile } });
  return { ...gate, output: fs.readFileSync(outputFile, 'utf8') };
};

test('the gate step, lifted from the workflow, passes a receipt this emitter really produced', () => {
  const built = world.build();
  const emitted = world.emit(built);
  assert.equal(emitted.code, 0, `${emitted.stdout}${emitted.stderr}`);
  const gate = runGate(built);
  assert.equal(gate.code, 0, `${gate.stdout}${gate.stderr}`);
  // The positive control of the gate: it writes the output the attest step's `if:` reads, and writes it false
  // or true from the receipt rather than from the fact that the gate passed.
  assert.equal(gate.output, 'admissible=true\n');
  assert.match(gate.stdout, /^verdict success named 3 pass 3 fail 0 absent 0$/m);
});

test('the gate step refuses a named test the runner only skipped, even when the verdict says success', () => {
  // Built from a receipt this emitter really produced over a genuine `# SKIP` capture, then forged in exactly
  // the two places the emitter would have refused it - the verdict and the summary - so that what reaches the
  // gate is a receipt whose every claim-level field says the run established its term, and whose per-test
  // record still says the runner never executed the test. That is the one path the verdict cannot catch, and
  // it is the whole reason the gate is a second reader rather than a restatement of the first.
  const built = world.build({
    capture: world.genuineTap('skipped-and-suite.mjs'),
    claim: {
      code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
      entries: [{ id: 'TERM-SKIP', control: { test_names: ['the stale-head guard holds'] }, killing_mutants: [] }],
    },
  });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 0, `${emitted.stdout}${emitted.stderr}`);
  const receipt = world.receiptOf(built);
  // What the emitter really wrote for a test the runner really skipped.
  assert.equal(receipt.named_tests[0].status, 'skip');
  assert.equal(receipt.conclusion.verdict, 'failure');
  // The forgery, and nothing else: every field the gate reads before the per-test rule now says success.
  receipt.conclusion.verdict = 'success';
  receipt.conclusion.reasons = [];
  receipt.named_tests_summary = { named: 1, pass: 1, fail: 0, absent: 0, skipped: 0, todo: 0, suite_points: 0 };
  receipt.terms = [{ id: 'TERM-SKIP', named: 1, pass: 1, fail: 0, absent: 0, skipped: 0, todo: 0,
    suite_points: 0, establishes: true }];
  receipt.terms_summary = { total: 1, establishing: 1, naming_no_tests: 0, without_evidence: [] };
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const gate = runGate(built);
  assert.equal(gate.code, 1, `${gate.stdout}${gate.stderr}`);
  // And it says which test and which status, rather than that something was wrong.
  assert.match(gate.stderr, /::error::these named tests were not measured as passing in this run: /);
  assert.match(gate.stderr, /the stale-head guard holds \[skip\]/);
  // Nothing is written on a refusal, so `if: steps.gate.outputs.admissible == \'true\'` cannot select the
  // attest step even if the step\'s own failure were somehow tolerated.
  assert.equal(gate.output, '');
});

// ---- the manifest's shape is refused, and coverage is keyed so that pooling cannot happen ---------------------

// D1/D2. `termReport` was one row per manifest ENTRY, but each row's coverage was `perTest.filter(t => t.term
// === term.id)`. Entries that shared an id - or that both omitted one, collapsing to `null` - pooled their
// tests, so an entry naming no test inherited a sibling's coverage and reported `named: 1, pass: 1,
// establishes: true`. The workflow's gate step could not catch it: its check is `!(term.named > 0)`, and the
// pooled row reports `named: 1`, so the second reader re-read the field the first one had inflated. The
// manifest comes from the CANDIDATE and nothing validated its shape, so the candidate controlled this.
//
// Two changes close it, and each is tested on its own below, because either alone leaves a path open:
// the shape REFUSAL, and the per-entry KEYING.

const claimWith = entries => ({ code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE }, entries });
const ONE_REAL_TEST = 'the coordinator refuses a stale head';
const namesTest = id => ({ id, control: { test_names: [ONE_REAL_TEST] }, killing_mutants: [] });
const namesNothing = id => ({ id, control: { test_names: [] }, killing_mutants: [] });

test('D2: two entries with no id at all are refused, naming the entries that carry none', () => {
  const built = world.build({
    claim: claimWith([{ control: { test_names: [ONE_REAL_TEST] }, killing_mutants: [] },
      { control: { test_names: [] }, killing_mutants: [] }]),
    capture: world.tapFor([ONE_REAL_TEST]),
  });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries.id');
  assert.match(result.stderr, /2 entry\/entries of .* carry no term id/);
  assert.match(result.stderr, /entry 0 \(absent\), 1 \(absent\)/);
  // A refusal is a refusal: no receipt is written at all, so there is nothing for the gate to read.
  assert.equal(fs.existsSync(built.receiptPath), false);
});

test('D1b: ten entries sharing one term id are refused, naming the id and every entry that claims it', () => {
  const built = world.build({
    claim: claimWith([namesTest('TERM-X'), ...Array.from({ length: 9 }, () => namesNothing('TERM-X'))]),
    capture: world.tapFor([ONE_REAL_TEST]),
  });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries.id');
  assert.match(result.stderr, /1 term id\(s\) in .* are claimed by more than one entry/);
  assert.match(result.stderr, /TERM-X \(entries 0, 1, 2, 3, 4, 5, 6, 7, 8, 9\)/);
  assert.equal(fs.existsSync(built.receiptPath), false);
});

test('D1: two entries sharing one term id are refused before any coverage is computed', () => {
  const built = world.build({
    claim: claimWith([namesTest('TERM-X'), namesNothing('TERM-X')]),
    capture: world.tapFor([ONE_REAL_TEST]),
  });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries.id');
  assert.match(result.stderr, /TERM-X \(entries 0, 1\)/);
  // The refusal happens before the capture is read as coverage, so nothing about the run is reported under a
  // claim the emitter could not read term by term.
  assert.equal(result.stdout, '');
});

test('an id that is blank, or not a string, names no term and is refused like an absent one', () => {
  for (const [id, shown] of [['', '""'], ['   ', '"   "'], [null, 'null'], [17, '17'], [['TERM-X'], '["TERM-X"]']]) {
    const built = world.build({
      claim: claimWith([namesTest('TERM-OK'), { id, control: { test_names: [] }, killing_mutants: [] }]),
      capture: world.tapFor([ONE_REAL_TEST]),
    });
    const result = world.emit(built);
    refusedOn(result, 'claim.entries.id');
    assert.match(result.stderr, new RegExp(`entry 1 \\(${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`),
      `id ${JSON.stringify(id)} was not named in the refusal:\n${result.stderr}`);
  }
});

test('an entry that is not an object at all is refused, naming what it is', () => {
  const built = world.build({
    claim: claimWith([namesTest('TERM-OK'), 'TERM-X', null, ['TERM-Y']]),
    capture: world.tapFor([ONE_REAL_TEST]),
  });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries');
  assert.match(result.stderr, /3 entry\/entries of .* are not objects/);
  assert.match(result.stderr, /entry 1 \(string\), 2 \(null\), 3 \(a list\)/);
});

test('an `entries` that is not a list is refused, not read as one term or as none', () => {
  const built = world.build({
    claim: claimWith({ 'TERM-X': { control: { test_names: [ONE_REAL_TEST] } } }),
    capture: world.tapFor([ONE_REAL_TEST]),
  });
  refusedOn(world.emit(built), 'claim.entries');
});

// An ABSENT `entries` is not a shape refusal. It is a claim that lists no terms, which the verdict already
// records as establishing nothing - and that distinction is deliberate, so this pins it.
test('a claim with no `entries` at all is a verdict of failure, not a refusal', () => {
  const built = world.build({
    claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE } },
    capture: world.tapFor([ONE_REAL_TEST]),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.match(receipt.conclusion.reasons.join(' | '), /the claim lists no terms, so this run establishes nothing/);
});

// THE SECOND CHANGE, TESTED ON ITS OWN. The refusal above is what a real candidate meets, so a test that only
// exercises it proves nothing about the keying underneath - the two would be indistinguishable. This runs a
// copy of the emitter with the manifest-shape refusals neutered, and feeds it the D1b manifest: ten
// entries sharing TERM-X, one of which names a test. If coverage were still looked up by term id, all ten rows
// would report `named: 1, pass: 1, establishes: true` and the verdict would be success. Keyed by entry index,
// the nine that name nothing report exactly that.
let neuteredEmitter = null;
const emitterWithoutShapeChecks = () => {
  if (neuteredEmitter) return neuteredEmitter;
  const source = fs.readFileSync(world.EMITTER, 'utf8');
  const calls = source.match(/refuse\('claim\.entries/g) ?? [];
  // An exact count, deliberately: a shape refusal added or removed later must be looked at here rather than
  // silently left un-neutered, which would let this test pass on the refusal it was written to do without.
  assert.equal(calls.length, 4,
    `expected the four manifest-shape refusals to neuter, found ${calls.length}; this test is stale`);
  neuteredEmitter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keying-')), 'emit.mjs');
  fs.writeFileSync(neuteredEmitter, source.replace(/refuse\('claim\.entries/g, '(() => {})(\'claim.entries'));
  return neuteredEmitter;
};

test('coverage is keyed per entry, so ten entries sharing an id still pool nothing with the shape check off', () => {
  const built = world.build({
    claim: claimWith([namesTest('TERM-X'), ...Array.from({ length: 9 }, () => namesNothing('TERM-X'))]),
    capture: world.tapFor([ONE_REAL_TEST]),
  });
  const result = world.emit(built, {}, emitterWithoutShapeChecks());
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  // ONE test was named and ONE term is established by it. The other nine named nothing and inherit nothing.
  assert.deepEqual(receipt.named_tests.map(t => [t.entry, t.term, t.status]), [[0, 'TERM-X', 'pass']]);
  assert.deepEqual(receipt.terms.map(t => [t.entry, t.id, t.named, t.pass, t.establishes]),
    [[0, 'TERM-X', 1, 1, true], ...Array.from({ length: 9 }, (_, i) => [i + 1, 'TERM-X', 0, 0, false])]);
  assert.equal(receipt.terms_summary.total, 10);
  assert.equal(receipt.terms_summary.establishing, 1);
  assert.equal(receipt.terms_summary.naming_no_tests, 9);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.match(receipt.conclusion.reasons.join(' | '), /9 term\(s\) name no tests/);
  // And the gate, reading that receipt, refuses it and writes no `admissible` output for the attest step.
  // It refuses on the verdict, which is the first of its checks to fire; its own per-term rule is the second
  // reader, and the point of the keying is that the first reader is no longer handing it an inflated field.
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /the receipt does not record a successful measurement/);
  assert.match(gate.stdout, /"naming_no_tests":9/);
  assert.equal(gate.output, '');
});

test('the same for two entries with no id at all: null is not a bucket two terms can share', () => {
  const built = world.build({
    claim: claimWith([{ control: { test_names: [ONE_REAL_TEST] }, killing_mutants: [] },
      { control: { test_names: [] }, killing_mutants: [] }]),
    capture: world.tapFor([ONE_REAL_TEST]),
  });
  assert.equal(world.emit(built, {}, emitterWithoutShapeChecks()).code, 0);
  const receipt = world.receiptOf(built);
  assert.deepEqual(receipt.terms.map(t => [t.entry, t.named, t.establishes]), [[0, 1, true], [1, 0, false]]);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.equal(runGate(built).code, 1);
});

// The entry index is in the receipt, on both sides, so a reader can check the attribution rather than trust it.
test('a well-formed manifest carries its entry index into every term row and every named test', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.deepEqual(receipt.terms.map(term => [term.entry, term.id]), [[0, 'TERM-1'], [1, 'TERM-2']]);
  assert.deepEqual(receipt.named_tests.map(test => [test.entry, test.term, test.kind]),
    [[0, 'TERM-1', 'control'], [0, 'TERM-1', 'mutant'], [1, 'TERM-2', 'control']]);
  assert.equal(receipt.conclusion.verdict, 'success');
});

// ---- the capture is hashed as it passes through, and a capture that contradicts itself is refused -------------

// A review defeated the whole provenance chain here. The measure job used to redirect the runner's output into
// $RUNNER_TEMP/capture/suite.out and hash that file in the NEXT step, so the candidate's own test bodies - which
// run inside the capture step, as the same user, with RUNNER_TEMP in their environment - could stage a forged TAP
// stream and rename(2) it over the capture. The trusted step then hashed the forgery, and twenty-seven
// provenance checks all passed: every one of them authenticates WHICH JOB uploaded the artifact, and none
// authenticated WHO WROTE THE BYTES INSIDE IT.
//
// The attack is kept as a fixture (fixtures/rewriting-suite.mjs) and run for real against the capture program,
// because the only honest way to show a defence holds is to point the defeat at it.
test('the capture program hashes the stream as it passes through, so the rename that replaced the capture cannot', () => {
  const taken = world.runCapture({ fixture: 'rewriting-suite.mjs' });
  assert.equal(taken.code, 0, `${taken.stdout}${taken.stderr}`);
  assert.deepEqual(taken.entries, ['capture-meta.json', 'suite.out']);
  // The forged stream is nowhere in the capture: the capture did not exist as a file while the suite ran, so
  // there was nothing to rename over, and the attempt itself is recorded as the failing test point it is.
  assert.doesNotMatch(taken.bytes, /^ok 3 - the push broker retries only reads$/m);
  assert.match(taken.bytes, /^not ok 2 - the coordinator refuses a stale head$/m);
  assert.match(taken.bytes, /ENOENT/, 'the rewriting test failed to reach the capture, and said so in the stream');
  assert.match(taken.bytes, /^# fail 3$/m);
  // The digest in the meta is the streaming one, and the bytes on disk still hash to it.
  assert.equal(taken.meta.capture_hash_source, 'stream');
  assert.equal(taken.meta.capture_sha256,
    crypto.createHash('sha256').update(taken.bytes).digest('hex'));
  assert.equal(taken.meta.capture_bytes, Buffer.byteLength(taken.bytes));
  // And the exit status comes from waitpid in the trusted process, not from a $GITHUB_OUTPUT line the measured
  // code can append to - the adjacent finding of the same review.
  assert.equal(taken.meta.suite_exit, '1');
});

test('a capture directory the measured code created first is refused, not written into', () => {
  const taken = world.runCapture({ fixture: 'claim-suite.mjs', preCreateDir: true });
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, /REFUSING: capture\.directory: .* already exists before the runner has been invoked/);
  // Fail closed: no meta is written, so the artifact cannot hold the two files the emitter demands.
  assert.equal(taken.meta, null);
});

test('the capture program refuses rather than defaulting anything that identifies the measurement', () => {
  for (const missing of ['CAPTURE_DIR', 'CANDIDATE_DIR', 'RUNNER_COMMAND', 'RUNNER_KEY', 'CANDIDATE_SHA',
    'CANDIDATE_TREE', 'TRUSTED_SOURCE_SHA', 'JOB_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    const taken = world.runCapture({ fixture: 'claim-suite.mjs', env: { [missing]: '' } });
    assert.equal(taken.code, 1, `${missing} was defaulted`);
    assert.match(taken.stderr, new RegExp(`REFUSING: env\\.${missing}:`));
  }
});

// The capture this authority really produces, fed to the emitter as the artifact's contents - so the two halves
// of the chain are tested joined, not each against a fixture of the other.
const worldFromCapture = (taken, patch = {}) => world.build({
  capture: taken.bytes,
  meta: { ...taken.meta, ...(patch.meta ?? {}) },
  ...patch,
});
// The emitter checks the meta's runner command against the PROTECTED ENUM, so a world whose capture was taken
// over a fixture suite needs an enum that names that fixture - the check stays live, over an enum this test owns
// rather than over a command the world asserts twice.
const enumNaming = (built, command) => {
  const spec = path.join(built.root, 'runners.json');
  fs.writeFileSync(spec, `${JSON.stringify({ runners: { coordinator: { command } } }, null, 2)}\n`);
  return spec;
};

test('a capture the trusted program really took is what the emitter accepts', () => {
  const taken = world.runCapture({ fixture: 'claim-suite.mjs' });
  assert.equal(taken.code, 0, `${taken.stdout}${taken.stderr}`);
  const built = worldFromCapture(taken);
  const emitted = world.emit(built, { RUNNER_SPEC_PATH: enumNaming(built, taken.meta.runner_command) });
  assert.equal(emitted.code, 0, `${emitted.stdout}${emitted.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.equal(receipt.named_tests_summary.pass, 3);
  assert.equal(receipt.provenance.capture.sha256, taken.meta.capture_sha256);
  assert.equal(receipt.provenance.capture.hashed, 'in the trusted job, as the stream passed through it');
});

test('a capture replaced after the trusted process hashed it is refused, naming the capture digest', () => {
  const taken = world.runCapture({ fixture: 'claim-suite.mjs' });
  // The residual the streaming hash leaves: a detached process that outlives the suite could still overwrite the
  // file. It no longer overwrites the digest, because that was taken as the bytes passed through - so the
  // substitution is refused on `capture.sha256` instead of being hashed as if it were the measurement.
  const built = world.build({ capture: world.tapFor(world.NAMED_TESTS), meta: taken.meta });
  const emitted = world.emit(built, { RUNNER_SPEC_PATH: enumNaming(built, taken.meta.runner_command) });
  assert.equal(emitted.code, 3);
  assert.match(emitted.stderr, /REFUSING: capture\.sha256:/);
});

test('a capture whose meta does not say its digest came from the stream is refused, naming the hash source', () => {
  for (const source of [undefined, 'file', 'read-back-after-the-run']) {
    const built = world.build({ meta: { capture_hash_source: source } });
    const emitted = world.emit(built);
    assert.equal(emitted.code, 3);
    assert.match(emitted.stderr, /REFUSING: capture\.hash_source:/);
  }
});

test('a capture whose recorded byte count is not the artifact bytes is refused, naming the count', () => {
  const built = world.build({ meta: { capture_bytes: 17 } });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 3);
  assert.match(emitted.stderr, /REFUSING: capture\.bytes: the capture records 17 bytes/);
});

// THE SELF-CONTRADICTORY CAPTURE. The review's probe: a stream reporting `# tests 3 / # pass 3 / # fail 0`
// beside the exit code 1 the trusted job recorded - the residue of a forgery that could replace the stream but
// not the exit status - accepted as verdict success, admissible, attested.
test('a capture reporting no failure beside a non-zero suite exit is refused, naming the exit', () => {
  const built = world.build({ meta: { suite_exit: '1' } });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 3);
  assert.match(emitted.stderr, /REFUSING: capture\.suite_exit: the capture contradicts itself/);
  assert.match(emitted.stderr, /recorded suite exit 1/);
  assert.equal(fs.existsSync(built.receiptPath), false, 'a refusal writes no receipt for the gate to read');
});

test('a capture reporting a failure beside a suite exit of 0 is refused, naming the exit', () => {
  const built = world.build({
    capture: world.tapFor(world.NAMED_TESTS, { failing: [world.NAMED_TESTS[0]] }),
    meta: { suite_exit: '0' },
  });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 3);
  assert.match(emitted.stderr, /REFUSING: capture\.suite_exit: the capture contradicts itself/);
  assert.match(emitted.stderr, /recorded suite exit 0/);
});

test('a summary whose per-status counts do not match the points it enumerated is refused, status by status', () => {
  // Three ok test points, a summary that adds up and a plan that matches - but the summary attributes one of
  // them to `# fail`. Everything the well-formedness check reconciled before this agrees; the point statuses do
  // not, and the names are what a term is established by.
  const lines = world.tapFor(world.NAMED_TESTS).split('\n')
    .map(line => (line === '# pass 3' ? '# pass 2' : line === '# fail 0' ? '# fail 1' : line));
  const built = world.build({ capture: lines.join('\n'), meta: { suite_exit: '1' } });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 3);
  assert.match(emitted.stderr, /REFUSING: capture\.summary\.pass: the capture contradicts itself/);
});

test('the genuine capture of a skipped test, a todo and an empty describe reconciles status by status', () => {
  // The guard on the four new per-status checks: a REAL reporter's output, where `# pass` excludes a directive
  // and a suite point, `# skipped` and `# todo` hold the directives, and `# suites` holds the describe. If the
  // checks were stricter than the reporter, this would refuse a genuine measurement.
  const built = world.build({
    capture: world.genuineTap('skipped-and-suite.mjs'),
    claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
      entries: [{ id: 'TERM-1', control: { test_names: ['the coordinator refuses a stale head'] } }] },
  });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 0, `${emitted.stdout}${emitted.stderr}`);
  const receipt = world.receiptOf(built);
  assert.deepEqual([receipt.suite.tests, receipt.suite.suites, receipt.suite.ok, receipt.suite.skipped,
    receipt.suite.todo, receipt.suite.exit], [3, 1, 1, 1, 1, '0']);
  assert.equal(receipt.conclusion.verdict, 'success');
});

// ---- a container of the wrong type is a named refusal, not an unhandled TypeError ----------------------------

// A review supplied `control.test_names` as a string and `killing_mutants` as a string, and got
// `.map is not a function` and `.filter is not a function` - fail-closed in effect, but in the log
// indistinguishable from a broken workflow, so a malformed candidate manifest read as an infrastructure fault
// rather than as a refused claim. The file claims every refusal names the field that did not match.
test('a control.test_names that is not a list is refused, naming the container', () => {
  const built = world.build({ claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-A', control: { test_names: 'the coordinator refuses a stale head' } }] } });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 3, emitted.stderr);
  assert.match(emitted.stderr, /REFUSING: claim\.entries\.control\.test_names:/);
  assert.match(emitted.stderr, /entry 0 carries `control\.test_names` as a string, not a list of test names/);
});

test('a killing_mutants that is not a list, and an element of one that names no test, are refused by name', () => {
  const claim = entry => ({ code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE }, entries: [entry] });
  const string = world.build({ claim: claim({ id: 'TERM-A', killing_mutants: 'x' }) });
  assert.match(world.emit(string).stderr, /REFUSING: claim\.entries\.killing_mutants: .*`killing_mutants` as a string/);
  const nulls = world.build({ claim: claim({ id: 'TERM-A', killing_mutants: [null] }) });
  assert.match(world.emit(nulls).stderr, /REFUSING: claim\.entries\.killing_mutants: .*element 0 \(literal `null`\)/);
  const strings = world.build({ claim: claim({ id: 'TERM-A', killing_mutants: ['a name, not a mutant'] }) });
  assert.match(world.emit(strings).stderr, /REFUSING: claim\.entries\.killing_mutants: .*element 0 \(a string\)/);
  const control = world.build({ claim: claim({ id: 'TERM-A', control: 'a name, not an object' }) });
  assert.match(world.emit(control).stderr, /REFUSING: claim\.entries\.control: .*`control` as a string, not an object/);
});

test('an entry that names neither a control nor a mutant is still a term establishing nothing, not a refusal', () => {
  // The line between the refusal above and the verdict: an ABSENT container is a term this run establishes
  // nothing about, which the verdict already records by name. Only a PRESENT container of the wrong type is
  // refused, so this distinction cannot be collapsed later by accident.
  const built = world.build({ claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-A' }] } });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 0, emitted.stderr);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.match(receipt.conclusion.reasons.join(' '), /1 term\(s\) name no tests/);
});

test('a claim body that is not an object at all is refused, naming what it is', () => {
  const route = `/repos/${world.REPO}/contents/${world.CLAIM_PATH}?ref=${world.CANDIDATE_SHA}`;
  for (const [body, what] of [['null\n', 'literal `null`'], ['[]\n', 'a list'], ['"x"\n', 'a string'], ['7\n', 'a number']]) {
    const built = world.build({ routes: { [route]: { json: { sha: 'f'.repeat(40),
      content: Buffer.from(body).toString('base64') } } } });
    const emitted = world.emit(built);
    assert.equal(emitted.code, 3, emitted.stderr);
    assert.match(emitted.stderr, new RegExp(`REFUSING: claim\\.json: .* is ${what.replace(/[`[\]]/g, m => `\\${m}`)}, not an object`));
  }
});

// ---- the gate reconciles the terms against the rows they claim to count --------------------------------------

// The one line the review found missing, and the reason the rest of the gate was a re-read rather than a second
// reading: terms[].named was never reconciled against named_tests, so a receipt whose term claimed coverage that
// no per-test row supported passed with admissible=true. None of these is reachable by a candidate; all three
// are reachable by an emitter bug, which is what a second reader is for.
const forgeReceipt = (built, edit) => {
  const receipt = world.receiptOf(built);
  edit(receipt);
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
};
const ONE_TERM = {
  code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
  entries: [{ id: 'TERM-A', control: { test_names: ['the coordinator refuses a stale head'] } }],
};

test('the gate refuses a terms row claiming coverage no named test row supports', () => {
  const built = world.build({ claim: ONE_TERM, capture: world.tapFor(['the coordinator refuses a stale head']) });
  assert.equal(world.emit(built).code, 0);
  forgeReceipt(built, receipt => {
    receipt.terms.push({ entry: 1, id: 'TERM-B', named: 1, pass: 1, fail: 0, absent: 0, skipped: 0, todo: 0,
      suite_points: 0, establishes: true });
    receipt.terms_summary.total = 2;
    receipt.terms_summary.establishing = 2;
  });
  const gate = runGate(built);
  assert.equal(gate.code, 1, `${gate.stdout}${gate.stderr}`);
  assert.match(gate.stderr, /::error::these terms claim coverage that no named test row of this receipt supports/);
  assert.match(gate.stderr, /TERM-B \(entry 1\) claims named=1 pass=1, but named_tests holds 0 test\(s\)/);
  assert.equal(gate.output, '');
});

test('the gate refuses a terms row whose counts are not counts', () => {
  const built = world.build({ claim: ONE_TERM, capture: world.tapFor(['the coordinator refuses a stale head']) });
  assert.equal(world.emit(built).code, 0);
  // `!(term.named > 0)` is satisfied by the string '1', which is why reading that field was never a check.
  forgeReceipt(built, receipt => { receipt.terms[0].named = '1'; });
  const gate = runGate(built);
  assert.equal(gate.code, 1, `${gate.stdout}${gate.stderr}`);
  assert.match(gate.stderr, /TERM-A reports named="1" pass=1, which are not counts/);
  assert.equal(gate.output, '');
});

test('the gate refuses a receipt whose named_tests were emptied under an unchanged summary', () => {
  const built = world.build({ claim: ONE_TERM, capture: world.tapFor(['the coordinator refuses a stale head']) });
  assert.equal(world.emit(built).code, 0);
  forgeReceipt(built, receipt => { receipt.named_tests = []; });
  const gate = runGate(built);
  assert.equal(gate.code, 1, `${gate.stdout}${gate.stderr}`);
  assert.match(gate.stderr, /::error::these terms claim coverage that no named test row of this receipt supports/);
  assert.equal(gate.output, '');
});

test('the gate refuses a named test row attributed to no term at all', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  forgeReceipt(built, receipt => { receipt.named_tests[0].entry = 7; });
  const gate = runGate(built);
  assert.equal(gate.code, 1, `${gate.stdout}${gate.stderr}`);
  assert.equal(gate.output, '');
});

test('the gate refuses a summary that disagrees with the rows the receipt lists', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  forgeReceipt(built, receipt => { receipt.named_tests_summary.named = 4; });
  const gate = runGate(built);
  assert.equal(gate.code, 1, `${gate.stdout}${gate.stderr}`);
  assert.match(gate.stderr, /::error::named_tests_summary says named=4/);
  assert.equal(gate.output, '');
});

test('the gate still passes a whole receipt this emitter produced, terms and rows reconciled', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const gate = runGate(built);
  assert.equal(gate.code, 0, `${gate.stdout}${gate.stderr}`);
  assert.equal(gate.output, 'admissible=true\n');
});
