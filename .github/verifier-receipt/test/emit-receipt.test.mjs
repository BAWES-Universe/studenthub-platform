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
import path from 'node:path';
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
  assert.deepEqual(receipt.named_tests_summary, { named: 3, pass: 3, fail: 0, absent: 0 });
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
    [`/repos/${world.REPO}/compare/main...${world.CANDIDATE_SHA}`]: { json: { status: 'diverged',
      files: [{ filename: '.github/verifier-receipt/emit-receipt.mjs' }] } },
  } });
  refusedOn(world.emit(built), 'candidate.authority');
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
      files: [{ filename: world.CLAIM_PATH }, { filename: '.github/coordinator/push-broker.mjs' }] } },
  } });
  refusedOn(world.emit(built), 'claim.code_revision.head');
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
    'CANDIDATE_SHA', 'RUNNER_KEY', 'RUNNER_SPEC_PATH']) {
    refusedOn(world.emit(world.build(), { [name]: undefined }), `env.${name}`);
    // A workflow expression that resolves to nothing arrives as the empty string, which is the same failure.
    refusedOn(world.emit(world.build(), { [name]: '' }), `env.${name}`);
  }
});
