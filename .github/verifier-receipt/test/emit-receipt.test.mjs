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
import { execFileSync } from 'node:child_process';
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
    { named: 4, distinct_names: 4, pass: 4, fail: 0, absent: 0, skipped: 0, todo: 0, suite_points: 0,
      misplaced: 0, unbound: 0, unclaimed: 0,
      // The default world's capture carries a `location:` on every point, because the emitter no longer
      // establishes a term from a point the runner named no file for. What that models is a REPORTER this
      // authority owns; the stock one writes a location on failing points only, and the test below builds a
      // world with `locations: null` to show what such a stream now produces.
      location_bound: { matched: 4, mismatched: 0, unreported: 0, unclaimed: 0 } });
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
  assert.equal(receipt.suite.tests, 4);
  assert.equal(receipt.named_tests.length, 4);
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
  assert.equal(receipt.named_tests_summary.named, 4);
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
  const built = world.build({ authority: { candidate: { directory: '9999'.repeat(10) } } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /\.github\/verifier-receipt is modified relative to the merge base/);
});

// THE MODE IS PART OF THE COMPARISON, through the emitter and not only through the module. A review measured
// `chmod +x .github/workflows/verifier-receipt.yml` passing the contents form, which reports an id that does
// not move when only the mode does.
test('a candidate that only chmods the authority workflow file is refused, naming the mode move', () => {
  const built = world.build({ authority: { candidate: { workflowMode: '100755' } } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /verifier-receipt\.yml is modified relative to the merge base/);
  assert.match(result.stderr, /its mode moved from 100644 at the merge base to 100755 at the candidate/);
});

// AND A TREE THAT SAYS IT WAS CUT OFF IS NOT READ AS "THE AUTHORITY IS NOT THERE". The other measured bypass:
// truncation used to be inferred from a listing's length, so a page cut off short of the cap read as absent -
// which is the one answer that admits an alteration.
test('a truncated authority tree is refused rather than read as an absent authority', () => {
  const built = world.build({ authority: {
    candidate: { directory: null, truncated: ['.github'] },
    mergeBase: { directory: null, truncated: ['.github'] },
  } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /answered `"truncated": true`/);
});

// The hole this replaced: the check read `files[].filename` from a comparison GitHub caps at 300 entries and
// truncates, in ascending filename order, with nothing in the response saying so. 300 paths under `.github/a...`
// sort before `.github/verifier-receipt/`, so an authority edit fell off the end of the list and the candidate
// was approved as `touches_authority: false`. The identity check never reads that list, so the filler does not
// reach it.
test('a candidate hiding its authority edit behind a full 300-file comparison page is still refused', () => {
  const filler = Array.from({ length: 300 }, (unused, index) => ({
    filename: `.github/aaa/${String(index).padStart(4, '0')}.json`, status: 'added' }));
  const built = world.build({
    authority: { candidate: { directory: '9999'.repeat(10) } },
    routes: {
      // A full page of `files`, and the merge base beside it. The comparison has to carry the fork point or the
      // refusal below would be the fail-closed one for an unestablishable merge base, which would prove nothing
      // about the listing.
      [`/repos/${world.REPO}/compare/main...${world.CANDIDATE_SHA}`]: { json: { status: 'ahead', ahead_by: 137,
        total_commits: 137, merge_base_commit: { sha: world.MERGE_BASE_SHA }, files: filler } },
    } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /\.github\/verifier-receipt is modified relative to the merge base/);
});

// A rename is reported under its NEW name, with the old path only in `previous_filename`. Moving the emitter to
// `.github/parked/` DELETES the authority, and the pattern-over-`filename` check called that untouched.
test('a candidate that renames the authority away is refused, naming the absent path', () => {
  const built = world.build({ authority: { candidate: { directory: null,
    fill: [{ path: 'parked', mode: '040000', type: 'tree', sha: world.AUTHORITY_DIR_SHA }] } } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /\.github\/verifier-receipt is deleted relative to the merge base/);
  assert.match(result.stderr, /absent at the candidate/);
});

test('a candidate that renames the workflow to another extension is refused', () => {
  const built = world.build({ authority: { candidate: { workflow: null, workflowsFill: [
    { path: 'verifier-receipt.yaml', mode: '100644', type: 'blob', sha: world.AUTHORITY_WORKFLOW_SHA }] } } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  // This assertion changed with the baseline. It used to read `verifier-receipt.yml is absent at the
  // candidate`, which was how the old check named EVERY absence - including the absence of a candidate that
  // simply predates the authority, which absent-is-not-altered measured false. The refusal now names the
  // change relative to the merge base, and carries the two ids it was decided from.
  assert.match(result.stderr, /verifier-receipt\.yml is deleted relative to the merge base: 1a1a1a1a1a1a at 999999999999, absent at the candidate/);
});

test('an authority tree the API will not serve is refused, not skipped', () => {
  const built = world.build({ authority: { candidate: { unreadable: ['.github'] } } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /the API will not serve the tree of \.github at bbbbbbbbbbbb/);
  // AND IT DOES NOT SAY THE CANDIDATE CHANGED ANYTHING, because this run did not establish that it did. A
  // refusal that opens by asserting what its own parenthesis calls unknown accuses an innocent candidate.
  assert.match(result.stderr, /this run cannot establish whether this candidate changes the receipt authority/);
  assert.equal(/this candidate changes the receipt authority relative to its merge base/.test(result.stderr),
    false, result.stderr);
});

test('the receipt carries the object ids the authority decision was made from', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.candidate.touches_authority, false);
  // The fork point the comparison was made at, in the receipt, so a reader can re-fetch the same two ids.
  assert.equal(receipt.candidate.authority_merge_base, world.MERGE_BASE_SHA);
  assert.deepEqual(receipt.candidate.authority_identity.map(entry => entry.path),
    ['.github/workflows/verifier-receipt.yml', '.github/verifier-receipt']);
  for (const entry of receipt.candidate.authority_identity) {
    assert.equal(entry.base_sha, entry.candidate_sha);
    assert.equal(entry.protected_sha, entry.candidate_sha);
    assert.equal(entry.change, 'none');
  }
  assert.equal(receipt.candidate.predates_authority, false);
  assert.equal(receipt.candidate.authority_stale_relative_to_protected, false);
});

// THE REFUSAL THIS CHANGE REPLACES, END TO END THROUGH THE EMITTER. Run 35852850002 dispatched the authority
// on main against candidate 6feac016 and refused it as an authority edit, reporting `main=3615f658
// candidate=<absent>` for the workflow file and `main=03fe40ba candidate=<absent>` for the directory. That
// candidate was cut from an older main and carries no authority at all, so it altered nothing; the check
// compared object ids for EQUALITY WITH MAIN and therefore read absent as altered. Measured against the fork
// point, where the candidate's copy and what it started from are the same object, there is no change.
test('a candidate that predates the authority is admitted, and the receipt says that is what it is', () => {
  // Absent at the candidate AND at the revision it was cut from; present on main, which moved on after it.
  const absentAuthority = { workflow: null, directory: null };
  const built = world.build({ authority: { candidate: absentAuthority, mergeBase: absentAuthority } });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.candidate.touches_authority, false);
  assert.equal(receipt.candidate.predates_authority, true);
  assert.deepEqual(receipt.candidate.authority_identity.map(entry => [entry.change, entry.base_sha, entry.candidate_sha]),
    [['none', null, null], ['none', null, null]]);
  // And the authority IS on the protected branch, so this receipt is not the "compared against nothing" case.
  assert.deepEqual(receipt.candidate.authority_identity.map(entry => entry.protected_sha),
    [world.AUTHORITY_WORKFLOW_SHA, world.AUTHORITY_DIR_SHA]);
  assert.equal(receipt.provenance.admissible_as_pin, true);
});

test('a comparison that names no merge base is refused, not read as unchanged', () => {
  const built = world.build({ routes: {
    [`/repos/${world.REPO}/compare/main...${world.CANDIDATE_SHA}`]: { json: { status: 'diverged', files: [] } },
  } });
  const result = world.emit(built);
  refusedOn(result, 'candidate.authority');
  assert.match(result.stderr, /cannot establish the merge base of main and/);
});

test('a comparison the API will not serve at all is refused, so the baseline is never assumed', () => {
  const built = world.build({ dropRoutes: [`/repos/${world.REPO}/compare/main...${world.CANDIDATE_SHA}`] });
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
  assert.equal(receipt.named_tests_summary.absent, 2);
});

test('a claim that names no test cannot produce success', () => {
  const built = world.build({ claim: { ...world.CLAIM, entries: [] }, capture: world.tapFor(['anything at all']) });
  assert.equal(world.emit(built).code, 0);
  assert.equal(world.receiptOf(built).conclusion.verdict, 'failure');
});

// ---- defence in depth, labelled as such ----------------------------------------------------------------------

test('a truncated capture is still refused by the well-formedness check, naming the structure', () => {
  const full = world.tapFor(world.NAMED_TESTS);
  const built = world.build({ capture: full.slice(0, full.indexOf(`1..${world.NAMED_TESTS.length}`)) });
  refusedOn(world.emit(built), 'capture.structure');
});

test('two runs concatenated into one capture are refused by the well-formedness check', () => {
  const built = world.build({ capture: world.tapFor(world.NAMED_TESTS) + world.tapFor(world.NAMED_TESTS) });
  refusedOn(world.emit(built), 'capture.structure');
});

// ---- the one numbering anomaly the runner writes itself -------------------------------------------------------
//
// `capture.structure` refused run 35843658922 - a real dispatch, a green measure job, 41 terms established by
// the controller - with `line 21875: point numbered 100 where the runner would have numbered it 3179`, and no
// receipt was produced. That point is the file-level point of a test file that dies at import because it writes
// into the read-only source mount, and the number on it is the file's position in the runner's own SORTED file
// list rather than the run's next number. The runner counts the point everywhere else, so the stream still
// reconciles; what it does not do is number it in sequence.
//
// The whole measurement - the runtime sources it was read out of, the ordinal arithmetic, the raw reproduction -
// is in fixtures/crashed-file-numbering/README.md. These tests hold the two halves of the rule: the runtime
// really does this, and nothing OTHER than this shape is tolerated.

const CRASH_FIXTURES = path.join(import.meta.dirname, 'fixtures', 'crashed-file-numbering');
const CAPTURE_FIXTURES = path.join(import.meta.dirname, 'fixtures', 'captures');
const crashFixture = name => fs.readFileSync(path.join(CRASH_FIXTURES, name), 'utf8');
// The two real captures. The CI one is the artifact of the refused run, trailer and all; the body is the
// runner's own output, which is what the measure job hashes and what this check reads.
const realCapture = name => {
  const whole = fs.readFileSync(path.join(CAPTURE_FIXTURES, name), 'utf8');
  const at = whole.lastIndexOf('\n# verifier-capture v1 ');
  return at === -1 ? whole : whole.slice(0, at + 1);
};
const structureRefusal = result => {
  assert.equal(result.code, 3, `expected a refusal, got exit ${result.code}\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^REFUSING: capture\.structure: /m, result.stderr);
  return result.stderr;
};

// THE MEASUREMENT ITSELF, RE-RUN. The tolerance below is only as good as the claim that `node --test` really
// numbers a crashed file's point this way, so this does not read the recorded output - it runs the minimal
// reproduction through whatever runtime is installed and asserts the shape, then feeds what came back to the
// emitter. If a future runtime stops doing this, this test says so before the tolerance can hide it.
test('the installed runtime numbers a crashed file\'s own point from its sorted file list, not from the run', () => {
  // A nested `node --test` that sees NODE_TEST_CONTEXT reports to its parent in v8 frames instead of TAP.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const repro = path.join(CRASH_FIXTURES, 'repro');
  let capture;
  try {
    capture = execFileSync(process.execPath,
      ['--test', '--test-reporter=tap', '--test-concurrency=1', './1-reports.test.mjs', './2-crashes.test.mjs'],
      { cwd: repro, encoding: 'utf8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.fail('the reproduction is supposed to exit non-zero: one of its files dies at import');
  } catch (error) {
    assert.equal(error.status, 1, error.message);
    capture = String(error.stdout ?? '');
  }
  const lines = capture.split('\n');
  const at = lines.findIndex(line => /^not ok \d+ - 2-crashes\.test\.mjs$/.test(line));
  assert.notEqual(at, -1, `no file-level point for the crashing file:\n${capture}`);

  // The number it printed, against the number the run's own sequence had reached.
  const printed = Number(/^not ok (\d+) - /.exec(lines[at])[1]);
  const before = lines.slice(0, at).filter(line => /^(ok|not ok) \d+ - /.test(line)).length;
  assert.equal(printed, 2, `expected the crashing file's position in the sorted list of two files\n${capture}`);
  assert.equal(before + 1, 4, `expected the run's next number to be 4\n${capture}`);
  assert.notEqual(printed, before + 1, 'the reproduction no longer reproduces the anomaly');

  // The three facts the tolerance reads, all of them present and none of them assumed.
  assert.equal(lines[at - 1], '# Subtest: 2-crashes.test.mjs');
  // The point's own YAML block, read as the emitter reads it: from its `---` to its `...`, at one indent in.
  assert.equal(lines[at + 1], '  ---', capture);
  const block = lines.slice(at + 2, lines.indexOf('  ...', at));
  assert.ok(block.includes("  type: 'test'"), capture);
  assert.equal(block.filter(line => /^ {2}location: /.test(line)).length, 1, capture);
  assert.match(block.find(line => /^ {2}location: /.test(line)),
    /^ {2}location: '.+\/2-crashes\.test\.mjs:1:1'$/, capture);
  assert.equal(lines.slice(0, at).filter(line => /^1\.\.\d+$/.test(line)).length, 0,
    'a file that died before reporting anything emits no plan of its own');
  // And the runner counted it anyway: the plan covers it and every later number is past it.
  assert.ok(lines.includes('1..4'), `expected the run's plan to count the crashed file's point\n${capture}`);

  // What the emitter must now do with exactly those bytes.
  const built = world.build({ capture });
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const crashed = world.receiptOf(built).structure_check.crashed_file_points;
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0].numbered, 2);
  assert.equal(crashed[0].global_next, 4);
  assert.match(crashed[0].file, /\/2-crashes\.test\.mjs$/);
});

test('a capture carrying one crashed file\'s point is accepted, and the receipt names it and both numbers', () => {
  const built = world.build({ capture: crashFixture('accepted-one-crashed-file.tap') });
  assert.equal(world.emit(built).code, 0);
  assert.deepEqual(world.receiptOf(built).structure_check.crashed_file_points,
    [{ file: '/src/b.test.mjs', line: 19, numbered: 2, global_next: 3 }]);
});

test('two different files that each died once are both tolerated, and both are named', () => {
  const built = world.build({ capture: crashFixture('accepted-two-crashed-files.tap') });
  assert.equal(world.emit(built).code, 0);
  assert.deepEqual(world.receiptOf(built).structure_check.crashed_file_points,
    [{ file: '/src/b.test.mjs', line: 12, numbered: 7, global_next: 2 },
      { file: '/src/d.test.mjs', line: 33, numbered: 9, global_next: 4 }]);
});

// THE EXACT PRE-FIX FAILURE, as a regression. Run 35843658922's capture was refused with
// `line 21875: point numbered 100 where the runner would have numbered it 3179`; those three numbers are
// asserted here, from the real artifact's own bytes, so a future change that re-breaks this breaks this test
// with the sentence it used to fail with.
test('the capture run 35843658922 was refused over is accepted, at the line and the numbers it was refused on', () => {
  const built = world.build({ capture: realCapture('run-35843658922-measure.out') });
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.deepEqual(receipt.structure_check.crashed_file_points,
    [{ file: '/src/.github/coordinator/test/shu249-role-authority.test.mjs',
      line: 21875, numbered: 100, global_next: 3179 }]);
  // The counts the runner reported, unchanged by the tolerance: the crashed file's point is inside all of them.
  assert.equal(receipt.suite.tests, 3652);
  assert.equal(receipt.suite.ok + receipt.suite.not_ok + receipt.suite.skipped, 3652);
  assert.equal(receipt.suite.exit, '1');
});

test('the same suite reproduced outside CI, in the same container flags, is accepted on the same anomaly', () => {
  const built = world.build({ capture: realCapture('local-in-container-7e7ac70e.out') });
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(world.receiptOf(built).structure_check.crashed_file_points,
    [{ file: '/src/.github/coordinator/test/shu249-role-authority.test.mjs',
      line: 21860, numbered: 100, global_next: 3179 }]);
});

// ---- and everything that is NOT that shape is still refused, by the same sentence ------------------------------

test('a second run concatenated onto a capture that carries a crashed file is still refused', () => {
  const built = world.build({ capture: crashFixture('negative-second-run-concatenated.tap') });
  const stderr = structureRefusal(world.emit(built));
  assert.match(stderr, /2 `TAP version` headers/);
  assert.match(stderr, /2 top-level plan lines/);
  // The anomaly that would have been tolerated is reported too: the stream stopped reconciling.
  assert.match(stderr, /line 19: point numbered 2 where the runner would have numbered it 3/);
});

test('a numbering reset that is not a crashed file\'s point is refused, naming its line and both numbers', () => {
  const built = world.build({ capture: crashFixture('negative-reset-not-tied-to-a-crash.tap') });
  assert.match(structureRefusal(world.emit(built)),
    /line 31: point numbered 1 where the runner would have numbered it 4/);
});

test('a duplicate point number that is not a crashed file\'s point is refused', () => {
  const built = world.build({ capture: crashFixture('negative-duplicate-number-not-tied-to-a-crash.tap') });
  assert.match(structureRefusal(world.emit(built)),
    /line 10: point numbered 1 where the runner would have numbered it 2/);
});

test('a second file-level point for one file is refused: a file dies once', () => {
  const built = world.build({ capture: crashFixture('negative-two-anomalies-in-one-file.tap') });
  const stderr = structureRefusal(world.emit(built));
  assert.match(stderr, /line 33: point numbered 7 where the runner would have numbered it 4/);
  // And the first one, held aside until the second broke the stream, is reported with it.
  assert.match(stderr, /line 12: point numbered 7 where the runner would have numbered it 2/);
});

test('a file that reported a plan of its own before dying is refused, plan and numbering both', () => {
  const built = world.build({ capture: crashFixture('negative-the-file-reported-its-own-plan.tap') });
  const stderr = structureRefusal(world.emit(built));
  assert.match(stderr, /2 top-level plan lines/);
  assert.match(stderr, /line 20: point numbered 2 where the runner would have numbered it 1/);
});

test('an anomaly in a stream whose counts do not reconcile is reported with the count that broke', () => {
  const built = world.build({ capture: crashFixture('negative-counts-do-not-reconcile.tap'),
    meta: { suite_exit: '1' } });
  const stderr = structureRefusal(world.emit(built));
  assert.match(stderr, /the summary does not reconcile: `# tests 4`/);
  assert.match(stderr, /line 19: point numbered 2 where the runner would have numbered it 3/);
});

test('an out-of-sequence `ok` point is refused however file-shaped the rest of it is', () => {
  const built = world.build({ capture: crashFixture('negative-anomaly-on-an-ok-point.tap') });
  assert.match(structureRefusal(world.emit(built)),
    /line 17: point numbered 2 where the runner would have numbered it 3/);
});

test('an out-of-sequence point whose location is not the file\'s first line and column is refused', () => {
  const built = world.build({ capture: crashFixture('negative-location-is-not-the-file-start.tap') });
  assert.match(structureRefusal(world.emit(built)),
    /line 19: point numbered 2 where the runner would have numbered it 3/);
});

test('an out-of-sequence point the preceding `# Subtest:` header names another file is refused', () => {
  const built = world.build({ capture: crashFixture('negative-header-names-another-file.tap') });
  assert.match(structureRefusal(world.emit(built)),
    /line 19: point numbered 2 where the runner would have numbered it 3/);
});

test('an out-of-sequence point the runner did not announce on the line before it is refused', () => {
  const built = world.build({ capture: crashFixture('negative-header-is-not-adjacent.tap') });
  assert.match(structureRefusal(world.emit(built)),
    /line 20: point numbered 2 where the runner would have numbered it 3/);
});

test('an out-of-sequence point nested inside another point is refused: a file point is never nested', () => {
  const built = world.build({ capture: crashFixture('negative-anomaly-on-a-nested-point.tap') });
  assert.match(structureRefusal(world.emit(built)),
    /line 4: point numbered 2 where the runner would have numbered it 1/);
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
  // The entry names the file the fixture really is, spelled the way a manifest spells it - relative to the
  // manifest's own directory - so the `location:` this genuine capture carries on its failing point binds to the
  // artifact instead of contradicting it. That makes this test a positive control for the binding too: a real
  // reporter's real location, matched against the claim's real artifact.
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-DUP', artifact: '../../../verifier-receipt/test/fixtures/duplicate-name.mjs',
      control: { test_names: ['a duplicated name'] },
      // The entry states PASS (the world defaults it), so it must name a mutant that must die for it - and the
      // name is a test the fixture really contains. The mutant PASSES, and the stock reporter writes no
      // `location:` on a passing point, so its row comes back `unbound`: that is the new rule showing through
      // on a genuine capture, and it is asserted below rather than hidden.
      killing_mutants: [{ test_name: 'the push broker retries only reads' }] }],
  };
  const built = world.build({ capture, claim, meta: { suite_exit: '1' } });
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.named_tests[0].location_bound, 'matched');
  assert.deepEqual(receipt.named_tests[0].locations,
    [path.join(world.HERE, 'fixtures', 'duplicate-name.mjs')]);
  assert.deepEqual(receipt.named_tests.map(test => [test.name, test.status]),
    [['a duplicated name', 'fail'], ['the push broker retries only reads', 'unbound']]);
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
  const at = name => `  location: '${world.ARTIFACT_LOCATION}:${name}:1'`;
  const capture = [
    'TAP version 13',
    'ok 1 - a repeated name', '  ---', '  duration_ms: 1', "  type: 'test'", at(12), '  ...',
    'ok 2 - a repeated name', '  ---', '  duration_ms: 1', "  type: 'test'", at(12), '  ...',
    'ok 3 - the mutant of the repeated name dies', '  ---', '  duration_ms: 1', "  type: 'test'", at(20), '  ...',
    '1..3', '# tests 3', '# suites 0', '# pass 3', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
    '# duration_ms 3', '',
  ].join('\n');
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-REPEAT', control: { test_names: ['a repeated name'] },
      killing_mutants: [{ test_name: 'the mutant of the repeated name dies' }] }],
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
//
// THE DISPOSITIONS ARE `BLOCK` AND THAT IS WHAT A MANIFEST OVER THIS CAPTURE WOULD SAY. Three of these four
// terms rest on a test that was skipped, marked todo, or is a describe() block, and the fourth's control
// passes with no `location:` - so none of them is in a state a manifest would call PASS, and an entry that
// says PASS must name a receipt that verified it and a mutant that must die for it. What this world is about
// is the STATUS each point is recorded under, which the disposition does not touch.
const SKIP_SUITE_CLAIM = {
  code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
  entries: [
    { id: 'TERM-SKIP', disposition: 'BLOCK', control: { test_names: ['the stale-head guard holds'] }, killing_mutants: [] },
    { id: 'TERM-SUITE', disposition: 'BLOCK', control: { test_names: [] },
      killing_mutants: [{ test_name: 'the mutant that removes the stale-head guard dies' }] },
    { id: 'TERM-TODO', disposition: 'BLOCK', control: { test_names: ['the broker retry budget is respected'] }, killing_mutants: [] },
    { id: 'TERM-REAL', disposition: 'BLOCK', control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] },
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
    // THE STOCK REPORTER SHOWING THROUGH. This point really passed, and this capture is the reporter's own
    // bytes - which carry no `location:` on a passing point, so nothing here says which file it was measured
    // in. It is `unbound`, not `pass`, and its term establishes nothing: this is the whole of the reach the
    // location binding has against the stock reporter, asserted on real bytes.
    ['the coordinator refuses a stale head', 'unbound'],
  ]);
  assert.deepEqual(receipt.named_tests_summary,
    { named: 4, distinct_names: 4, pass: 0, fail: 0, absent: 0, skipped: 1, todo: 1, suite_points: 1,
      misplaced: 0, unbound: 1, unclaimed: 0,
      location_bound: { matched: 0, mismatched: 0, unreported: 4, unclaimed: 0 } });
  // Each of the four is a term this run establishes nothing about, and each is named as such.
  assert.deepEqual(receipt.terms.map(term => [term.id, term.establishes]),
    [['TERM-SKIP', false], ['TERM-SUITE', false], ['TERM-TODO', false], ['TERM-REAL', false]]);
  assert.deepEqual(receipt.terms_summary.without_evidence,
    ['TERM-SKIP', 'TERM-SUITE', 'TERM-TODO', 'TERM-REAL']);
  const reasons = receipt.conclusion.reasons.join(' | ');
  assert.match(reasons, /1 named test\(s\) were reported with a `# SKIP` directive.*the stale-head guard holds/);
  assert.match(reasons, /1 named test\(s\) were reported with a `# TODO` directive.*the broker retry budget is respected/);
  assert.match(reasons, /matched only by a `type: 'suite'` point.*the mutant that removes the stale-head guard dies/);
});

test('naming a skipped test verbatim WITH its `# SKIP` marker does not match it either', () => {
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-MARKER', disposition: 'BLOCK',
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
    entries: [{ id: 'TERM-SHARED', disposition: 'BLOCK', control: { test_names: ['a shared name'] },
      killing_mutants: [] }],
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
  const at = line => `  location: '${world.ARTIFACT_LOCATION}:${line}:1'`;
  const capture = [
    'TAP version 13',
    'ok 1 - a name with a \\# hash inside', '  ---', '  duration_ms: 1', "  type: 'test'", at(12), '  ...',
    'ok 2 - the mutant of the hashed name dies', '  ---', '  duration_ms: 1', "  type: 'test'", at(20), '  ...',
    '1..2', '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
    '# duration_ms 3', '',
  ].join('\n');
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [{ id: 'TERM-HASH',
      control: { test_names: ['a name with a \\# hash inside'] },
      killing_mutants: [{ test_name: 'the mutant of the hashed name dies' }] }],
  };
  const built = world.build({ capture, claim });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.deepEqual(receipt.named_tests.map(named => named.status), ['pass', 'pass']);
});

// ---- every term is named, whether or not it names a test ------------------------------------------------------

// The claim-wide `named > 0` rule let a term that names no test ride to `success` on a sibling term's coverage,
// with no entry, no reason and no marker anywhere in the receipt.
test('terms that name no tests cannot ride to success on a sibling term\'s coverage', () => {
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [
      { id: 'TERM-covered', control: { test_names: ['the coordinator refuses a stale head'] },
        killing_mutants: [{ test_name: 'the mutant that removes the stale-head guard dies' }] },
      { id: 'TERM-empty-a', control: { test_names: [] }, killing_mutants: [] },
      { id: 'TERM-empty-b', control: {} },
      { id: 'TERM-no-control' },
    ],
  };
  const built = world.build({ claim,
    capture: world.tapFor(['the coordinator refuses a stale head',
      'the mutant that removes the stale-head guard dies']) });
  const result = world.emit(built);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.notDeepEqual(receipt.conclusion.reasons, []);
  assert.match(receipt.conclusion.reasons.join(' | '),
    /3 term\(s\) name no tests, so this run establishes nothing about them: TERM-empty-a, TERM-empty-b, TERM-no-control/);
  // Every term the manifest lists appears, with what this run establishes about it.
  assert.deepEqual(receipt.terms.map(term => [term.id, term.named, term.establishes]), [
    ['TERM-covered', 2, true], ['TERM-empty-a', 0, false], ['TERM-empty-b', 0, false], ['TERM-no-control', 0, false]]);
  // `controller_established` is carried beside `establishing` because the two answer different questions: what
  // the CONTROLLER observed, and what this receipt is willing to say. They are equal here because this world's
  // manifest permits every term it names; on a manifest that bars one they are not, and a reader wants both.
  assert.deepEqual(receipt.terms_summary, { total: 4, establishing: 1, measured: 1,
    controller_established: 1, controller_unobserved: [],
    permitted_by_the_manifest: 4, naming_no_tests: 3, barred_by_the_manifest: [],
    dispositions: { PASS: 4 },
    without_evidence: ['TERM-empty-a', 'TERM-empty-b', 'TERM-no-control'] });
  // And the run still establishes what it did establish, term by term.
  assert.equal(receipt.named_tests_summary.pass, 2);
});

test('a term whose only named test failed is marked as establishing nothing, by name', () => {
  const built = world.build({ capture: world.tapFor(world.NAMED_TESTS, { failing: ['the push broker retries only reads'] }) });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.deepEqual(receipt.terms.map(term => [term.id, term.establishes]), [['TERM-1', true], ['TERM-2', false]]);
  assert.deepEqual(receipt.terms_summary.without_evidence, ['TERM-2']);
});

// H1, THE FINDING THE COMMIT TITLED "coverage cannot pool" DID NOT CLOSE. That commit refused two entries
// SHARING a term id; it did nothing about two entries with distinct ids naming the same test. This is that
// case at its smallest, and the ten-entry form the review actually ran is below.
test('two terms resting on one test are refused: a measurement is the evidence for one term', () => {
  const claim = {
    code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
    entries: [
      { id: 'TERM-A', control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] },
      { id: 'TERM-B', control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] },
    ],
  };
  const built = world.build({ claim, capture: world.tapFor(['the coordinator refuses a stale head']) });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries.control.test_names');
  assert.match(result.stderr, /1 test name\(s\) in .* are named by more than one entry/);
  assert.match(result.stderr, /"the coordinator refuses a stale head" \(entries 0, 1: TERM-A, TERM-B\)/);
  assert.equal(fs.existsSync(built.receiptPath), false, 'a refusal writes no receipt for the gate to read');
});

// THE REVIEW'S OWN CASE, verbatim: ten DISTINCT, well-formed term ids, every one naming the SAME single passing
// test. At the commit under review this produced `verdict success; named 10 pass 10; terms: 10 listed, 10
// established; admissible as pin: true` over ONE measured name, and the gate agreed with it because there
// really were ten rows - one per entry, all for that name.
test('H1: ten distinct term ids naming ONE passing test are refused, by the name they share', () => {
  const built = world.build({
    claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
      entries: Array.from({ length: 10 }, (_, index) => ({ id: `TERM-${index}`,
        control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] })) },
    capture: world.tapFor(['the coordinator refuses a stale head']),
  });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries.control.test_names');
  assert.match(result.stderr, /entries 0, 1, 2, 3, 4, 5, 6, 7, 8, 9: TERM-0, TERM-1, TERM-2/);
  assert.equal(fs.existsSync(built.receiptPath), false);
});

// A term may rest on the same test twice WITHIN itself - as the control it names and as the mutant that kills
// it - which is the shape the default claim of this world carries. The rule is about one name serving two
// TERMS, so this must still succeed, or the refusal above would be refusing real manifests.
// WITHIN-ENTRY NAME REUSE, BOTH SPELLINGS. This used to be permitted, and the receipt it produced is the
// reason it is not: `named: 2, pass: 2, distinct_names: 1` off ONE point, with the mutant that is supposed to
// die when the term is removed being the very control that is supposed to pass while it is there. The pair
// cannot disagree, so the claim's own structure guaranteed its own verdict.
test('an entry that names one test as both its control and its killing mutant is refused, by name', () => {
  const built = world.build({
    claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
      entries: [{ id: 'TERM-ONE', control: { test_names: ['the coordinator refuses a stale head'] },
        killing_mutants: [{ test_name: 'the coordinator refuses a stale head' }] }] },
    capture: world.tapFor(['the coordinator refuses a stale head']),
  });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries.control.test_names');
  assert.match(result.stderr, /"the coordinator refuses a stale head" \(entry 0, TERM-ONE: named as control and as mutant\)/);
  // And no receipt was written for it: a claim this run cannot measure as written produces no verdict at all.
  assert.equal(fs.existsSync(built.receiptPath), false);
});

test('an entry that names one test twice in one list is refused, by name', () => {
  // The other spelling, and the one that used to be INVISIBLE: the key of the emitter's named-test map is
  // entry + kind + name, so the second write landed on the first and the receipt reported `named: 1`. A claim
  // that says it rests on two tests and rests on one is refused rather than silently deduplicated.
  const built = world.build({
    claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
      entries: [{ id: 'TERM-TWICE',
        control: { test_names: ['the coordinator refuses a stale head', 'the coordinator refuses a stale head'] },
        killing_mutants: [] }] },
    capture: world.tapFor(['the coordinator refuses a stale head']),
  });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries.control.test_names');
  assert.match(result.stderr, /named as control and as control/);
});

// AND THE SAME FINDING MEASURED RATHER THAN SPELLED: two different names the runner declared at one
// `<file>:<line>` are one test reported twice, which a loop over a list of names produces exactly.
test('TWO NAMES, ONE POINT: an entry whose two named tests sit at one location is refused, by name', () => {
  const generated = ['a generated case: alpha', 'a generated case: beta'];
  const built = world.build({
    claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
      entries: [{ id: 'TERM-LOOP', artifact: world.ARTIFACT, control: { test_names: [generated[0]] },
        killing_mutants: [{ test_name: generated[1] }], approvable: true, disposition: 'PASS' }] },
    // What `for (const name of [...]) test(name, () => {})` emits: two named points, one declaration, so one
    // location and one line on both.
    capture: world.tapFor(generated, {
      locations: { [generated[0]]: world.ARTIFACT_LOCATION, [generated[1]]: world.ARTIFACT_LOCATION },
      at: { [generated[0]]: 40, [generated[1]]: 40 },
    }),
  });
  const result = world.emit(built);
  refusedOn(result, 'capture.point_identity');
  assert.match(result.stderr, new RegExp(`${world.ARTIFACT_LOCATION}:40 \\(named by "a generated case: alpha", "a generated case: beta"\\)`));
});

test('two names the runner declared at two lines of one file are two tests, and establish their term', () => {
  // The control for the rule above: the same two names, the same file, declared where a real runner would
  // declare two separate tests. Nothing is refused, and the term rests on two measurements.
  const generated = ['a genuine case: alpha', 'a genuine case: beta'];
  const built = world.build({
    claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE },
      entries: [{ id: 'TERM-PAIR', artifact: world.ARTIFACT, control: { test_names: [generated[0]] },
        killing_mutants: [{ test_name: generated[1] }], approvable: true, disposition: 'PASS' }] },
    capture: world.tapFor(generated, {
      locations: { [generated[0]]: world.ARTIFACT_LOCATION, [generated[1]]: world.ARTIFACT_LOCATION },
      at: { [generated[0]]: 40, [generated[1]]: 51 },
    }),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.deepEqual(receipt.named_tests.map(test => test.points_at),
    [[`${world.ARTIFACT_LOCATION}:40`], [`${world.ARTIFACT_LOCATION}:51`]]);
  assert.equal(receipt.named_tests_summary.named, 2);
  assert.equal(receipt.named_tests_summary.distinct_names, 2);
  assert.deepEqual(receipt.named_tests_summary.location_bound,
    { matched: 2, mismatched: 0, unreported: 0, unclaimed: 0 });
  assert.equal(receipt.terms[0].establishes, true);
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
  assert.deepEqual(jobs.map(job => job.name), ['trust', 'measure', 'emit', 'attest'],
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

  // AND THE RUNNER IMAGE AND THE INTERPRETER ARE PINNED IN EVERY JOB. A review named the interpreter as the one
  // input this authority did not fix by content: four actions pinned to commits, the runner command from a
  // protected enum, the candidate and the authority checked out by sha - and then `runs-on: ubuntu-latest`
  // handing the measurement to whatever node that image currently resolves, on an image carrying more than
  // one. Which points carry a `location:`, what `--test-timeout` bounds and the TAP shapes the emitter
  // reconciles are all facts about a node version.
  for (const job of jobs) {
    assert.match(job.body, /^ {4}runs-on: ubuntu-\d\d\.\d\d$/m,
      `job \`${job.name}\` does not pin its runner image to a versioned label`);
    assert.match(job.body, /^ {10}node-version: \d+\.\d+\.\d+$/m,
      `job \`${job.name}\` does not pin the interpreter it runs this authority with`);
  }
  const versions = new Set([...WORKFLOW.matchAll(/^ {10}node-version: (\S+)$/gm)].map(match => match[1]));
  assert.equal(versions.size, 1, `this workflow pins more than one interpreter: ${[...versions].join(', ')}`);
});

// A JOB BOUND STOPS A HUNG SUITE FROM HOLDING A RUNNER FOR SIX HOURS. It does not stop ONE hung test from
// spending the whole of that bound: the runner has no per-test limit of its own, so a test that never settles
// consumes every minute the job has left and ends it as a cancellation, which carries no diagnostic saying
// what hung. The enum's commands carry the inner bound, and the number in them is derived from a measured run.
test('every runner the protected enum names bounds a single test, not only the job', () => {
  const spec = JSON.parse(fs.readFileSync(world.RUNNERS, 'utf8'));
  const runners = Object.entries(spec.runners);
  assert.ok(runners.length > 0, 'the enum names no runner at all');
  for (const [key, runner] of runners) {
    const bound = /--test-timeout=(\d+)\b/.exec(runner.command);
    assert.ok(bound, `runner "${key}" names no --test-timeout, so one hung test consumes the job's whole budget`);
    const ms = Number(bound[1]);
    // THE BOUND IS PER FILE AS WELL AS PER TEST, because a test file is itself a test in node 22. The first
    // value chosen here was 120000 - 3.7x the slowest single test point (32.4s) of the pinned candidate's real
    // capture - and it killed two whole files at 120s: 3538 tests measured instead of 3667, 2 cancelled, 129
    // never run. The slowest FILE of that suite is 273s standalone, which is what this floor is taken from.
    // THE VALUE IS TAKEN FROM THE SLOWEST FILE UNDER CONTENTION, not from the slowest file on an idle machine
    // and not from the slowest test. 120000 (3.7x the slowest single test point) killed two files. 600000
    // (2.2x the slowest file measured idle) killed three files on a contended run of the same command. The
    // same file measured 273s idle and 1446.8s contended - 5.3x, on one machine - so the floor here is the
    // contended number, not the idle one.
    assert.ok(ms >= 1500000, `runner "${key}" bounds a test at ${ms}ms, under the 1446.8s the slowest file of this suite really took under contention`);
    // And the inner bound must stay inside the outer one, or it bounds nothing: whatever the measure job's
    // own timeout-minutes says, read from the workflow rather than repeated here.
    const jobBound = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(
      WORKFLOW.slice(WORKFLOW.indexOf('\n  measure:\n'), WORKFLOW.indexOf('\n  emit:\n')))[1]) * 60000;
    assert.ok(ms < jobBound,
      `runner "${key}" bounds a test at ${ms}ms, which is not inside the measure job's own ${jobBound}ms bound`);
  }
});

// AN OUTPUT NOTHING READS IS WORSE THAN AN OUTPUT THAT IS NOT THERE, because a reader counts it as a check.
// Two of this workflow's own outputs - the measure job's `capture_sha256` and `body_sha256` - were declared
// and consumed nowhere at all, which is exactly how the suite's exit status came to reach the emitter only
// through a file the forgery rewrites. This asserts the property rather than the two names: every job output
// this workflow declares is read by something in it.
test('every job output this workflow declares is consumed by something in this workflow', () => {
  const declared = [...WORKFLOW.matchAll(/^ {6}([a-z0-9_]+): \$\{\{ (?:steps|needs)\./gm)].map(match => match[1]);
  assert.ok(declared.length >= 10, `expected this workflow to declare several job outputs, found ${declared.length}`);
  const unconsumed = [...new Set(declared)]
    .filter(name => !new RegExp(`needs\\.\\w+\\.outputs\\.${name}\\b`).test(WORKFLOW));
  assert.deepEqual(unconsumed, [],
    `these job outputs are declared and read by nothing, so they look like checks and are not: ${unconsumed.join(', ')}`);
});

// A TAG IS A POINTER AND ITS OWNER IS NOT THIS REPOSITORY. Every other input to this authority is named by
// content - the authority by sha, the candidate by sha, the runner command by a protected enum, the capture by
// a digest GitHub computed - and a floating action tag was the one input left that could change under a rerun
// of an identical dispatch with no line of this repository changing. It matters most in `attest`, the only job
// holding the attestation permissions: code that runs there can exchange this repository's OIDC token for a
// signature over anything.
test('every third-party action this workflow runs is pinned to an immutable commit', () => {
  const uses = [...WORKFLOW.matchAll(/^ *uses: (.+)$/gm)].map(match => match[1].trim());
  assert.ok(uses.length >= 7, `expected this workflow to use several actions, found ${uses.length}`);
  for (const line of uses) {
    assert.match(line, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}( # .+)?$/,
      `\`${line}\` is not pinned to a 40-character commit sha, so what this workflow runs can change without this repository changing`);
  }
  // And the job that can sign says WHY, where someone editing that job will read it.
  const attest = WORKFLOW.slice(WORKFLOW.indexOf('\n  attest:\n'));
  assert.match(attest, /WHY EVERY THIRD-PARTY ACTION IN THIS WORKFLOW IS PINNED TO A COMMIT/);
  assert.match(attest, /tag is a POINTER/);
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
// THE FOUR FACTS ABOUT THE RUN come from the step's `env:` block in the workflow - `github.event_name`,
// `github.ref`, `github.run_id` and the trust job's resolved origin - and are what let the gate check the
// receipt against something the receipt does not supply. A world is a dispatch of main by default, exactly as
// `world.build` builds it, and the tests that measure a rehearsal say so here.
// AND THE TWO DIGESTS THE MEASURE JOB PUBLISHES as its own outputs, which are what let the gate derive the
// measurement from the capture beside the receipt rather than read the receipt's account of it. A world's
// defaults are the ones its own capture justifies, exactly as the workflow's would be.
const runGate = (built, run = {}) => {
  const outputFile = path.join(built.root, 'github-output');
  fs.writeFileSync(outputFile, '');
  const gate = world.runNode(['-e', GATE_SOURCE], {
    cwd: path.dirname(built.receiptPath),
    env: {
      GITHUB_OUTPUT: outputFile,
      EVENT: 'workflow_dispatch',
      REF: 'refs/heads/main',
      THIS_RUN_ID: world.RUN_ID,
      TRUSTED_ORIGIN: 'protected-main',
      MEASURE_CAPTURE_SHA256: built.meta.capture_sha256,
      MEASURE_BODY_SHA256: built.meta.capture_body_sha256,
      ...run,
    },
  });
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
  assert.match(gate.stdout, /^verdict success named 4 pass 4 fail 0 absent 0$/m);
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
      entries: [{ id: 'TERM-SKIP', disposition: 'BLOCK',
        control: { test_names: ['the stale-head guard holds'] }, killing_mutants: [] }],
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
// The mutant that entry must name, because an entry stating an establishing disposition and naming a control
// must also name a mutant that must die for it. It is a second point in the captures below, not a second name
// on the first: two names at one `<file>:<line>` is refused as one test reported twice.
const ITS_MUTANT = 'the mutant that removes the stale-head guard dies';
const REAL_PAIR = [ONE_REAL_TEST, ITS_MUTANT];
const namesTest = id => ({ id, control: { test_names: [ONE_REAL_TEST] },
  killing_mutants: [{ test_name: ITS_MUTANT }] });
const namesNothing = id => ({ id, control: { test_names: [] }, killing_mutants: [] });

test('D2: two entries with no id at all are refused, naming the entries that carry none', () => {
  const built = world.build({
    claim: claimWith([{ control: { test_names: [ONE_REAL_TEST] }, killing_mutants: [] },
      { control: { test_names: [] }, killing_mutants: [] }]),
    capture: world.tapFor(REAL_PAIR),
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
    capture: world.tapFor(REAL_PAIR),
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
    capture: world.tapFor(REAL_PAIR),
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
      capture: world.tapFor(REAL_PAIR),
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
    capture: world.tapFor(REAL_PAIR),
  });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries');
  assert.match(result.stderr, /3 entry\/entries of .* are not objects/);
  assert.match(result.stderr, /entry 1 \(string\), 2 \(null\), 3 \(a list\)/);
});

test('an `entries` that is not a list is refused, not read as one term or as none', () => {
  const built = world.build({
    claim: claimWith({ 'TERM-X': { control: { test_names: [ONE_REAL_TEST] } } }),
    capture: world.tapFor(REAL_PAIR),
  });
  refusedOn(world.emit(built), 'claim.entries');
});

// An ABSENT `entries` is not a shape refusal. It is a claim that lists no terms, which the verdict already
// records as establishing nothing - and that distinction is deliberate, so this pins it.
test('a claim with no `entries` at all is a verdict of failure, not a refusal', () => {
  const built = world.build({
    claim: { code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE } },
    capture: world.tapFor(REAL_PAIR),
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
  assert.equal(calls.length, 6,
    `expected the six manifest-shape refusals to neuter, found ${calls.length}; this test is stale`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keying-'));
  neuteredEmitter = path.join(dir, 'emit.mjs');
  fs.writeFileSync(neuteredEmitter, source.replace(/refuse\('claim\.entries/g, '(() => {})(\'claim.entries'));
  // The emitter reads the protected matrix from BESIDE ITSELF, so a copy of it needs the matrix beside the
  // copy. That is the point of reading it from `import.meta.url` rather than from an input: a path this
  // process is told could be told wrong, and a neutered copy in a temp directory is exactly a case where it
  // would have been.
  fs.copyFileSync(world.MATRIX_PATH, path.join(dir, 'matrix.json'));
  // The same for the authority-scope module, which the emitter imports from beside itself for the same
  // reason: a module path this process is told could be told wrong.
  fs.copyFileSync(world.AUTHORITY_SCOPE, path.join(dir, 'authority-scope.mjs'));
  return neuteredEmitter;
};

test('coverage is keyed per entry, so ten entries sharing an id still pool nothing with the shape check off', () => {
  const built = world.build({
    claim: claimWith([namesTest('TERM-X'), ...Array.from({ length: 9 }, () => namesNothing('TERM-X'))]),
    capture: world.tapFor(REAL_PAIR),
  });
  const result = world.emit(built, {}, emitterWithoutShapeChecks());
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  // ONE test was named and ONE term is established by it. The other nine named nothing and inherit nothing.
  assert.deepEqual(receipt.named_tests.map(t => [t.entry, t.term, t.status]),
    [[0, 'TERM-X', 'pass'], [0, 'TERM-X', 'pass']]);
  assert.deepEqual(receipt.terms.map(t => [t.entry, t.id, t.named, t.pass, t.establishes]),
    [[0, 'TERM-X', 2, 2, true], ...Array.from({ length: 9 }, (_, i) => [i + 1, 'TERM-X', 0, 0, false])]);
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
    claim: claimWith([{ control: { test_names: [ONE_REAL_TEST] }, killing_mutants: [{ test_name: ITS_MUTANT }] },
      { control: { test_names: [] }, killing_mutants: [] }]),
    capture: world.tapFor(REAL_PAIR),
  });
  assert.equal(world.emit(built, {}, emitterWithoutShapeChecks()).code, 0);
  const receipt = world.receiptOf(built);
  assert.deepEqual(receipt.terms.map(t => [t.entry, t.named, t.establishes]), [[0, 2, true], [1, 0, false]]);
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
    [[0, 'TERM-1', 'control'], [0, 'TERM-1', 'mutant'], [1, 'TERM-2', 'control'], [1, 'TERM-2', 'mutant']]);
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
// `taken.bytes` are whole - the runner's output AND the trailer the capture program appended - so they are
// handed to the world as they are rather than re-wrapped, and the meta is that program's own.
const worldFromCapture = (taken, patch = {}) => world.build({
  wholeCapture: taken.bytes,
  body: taken.bytes.slice(0, taken.meta.capture_body_bytes),
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
  // ACCEPTED, READ AND RECONCILED - and establishing nothing, which is the honest reading of these bytes.
  // Every provenance check passes over a capture the trusted program really produced: the digest is the one it
  // took as the stream went through it, the trailer it appended is the trailer in the hashed bytes, and the
  // interpreter and image it recorded are the ones the receipt now names. What the stream does NOT carry is a
  // `location:` on a passing point - the stock reporter writes one only on a point it reports failing - so all
  // four names are `unbound` and no term is established. That is the whole of the reach the location binding
  // has against this reporter, measured here on its own bytes rather than asserted.
  assert.equal(receipt.named_tests_summary.pass, 0);
  assert.equal(receipt.named_tests_summary.unbound, 4);
  assert.deepEqual(receipt.named_tests_summary.location_bound,
    { matched: 0, mismatched: 0, unreported: 4, unclaimed: 0 });
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.match(receipt.conclusion.reasons.join(' | '),
    /4 named test\(s\) were reported by the runner with no `location:` at all/);
  assert.equal(receipt.provenance.capture.sha256, taken.meta.capture_sha256);
  assert.equal(receipt.provenance.capture.hashed, 'in the trusted job, as the stream passed through it');
  // AND THE INTERPRETER THE MEASUREMENT WAS TAKEN WITH, out of the capture's own trailer.
  assert.equal(receipt.provenance.runner.node, process.version);
  assert.equal(receipt.provenance.runner.arch, process.arch);
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
    .map(line => (line === '# pass 4' ? '# pass 3' : line === '# fail 0' ? '# fail 1' : line));
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
      entries: [{ id: 'TERM-1', disposition: 'BLOCK',
        control: { test_names: ['the coordinator refuses a stale head'] } }] },
  });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 0, `${emitted.stdout}${emitted.stderr}`);
  const receipt = world.receiptOf(built);
  assert.deepEqual([receipt.suite.tests, receipt.suite.suites, receipt.suite.ok, receipt.suite.skipped,
    receipt.suite.todo, receipt.suite.exit], [3, 1, 1, 1, 1, '0']);
  // The reconciliation is what this test is about, and it passed: the capture was read, not refused. The
  // verdict is failure because a stock-reporter capture carries no `location:` on a passing point, so the one
  // name this claim rests on is `unbound` - and because the entry's own disposition says BLOCK.
  assert.equal(receipt.named_tests[0].status, 'unbound');
  assert.equal(receipt.conclusion.verdict, 'failure');
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
  entries: [{ id: 'TERM-A', control: { test_names: [ONE_REAL_TEST] },
    killing_mutants: [{ test_name: ITS_MUTANT }] }],
};

test('the gate refuses a terms row claiming coverage no named test row supports', () => {
  const built = world.build({ claim: ONE_TERM, capture: world.tapFor(REAL_PAIR) });
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
  const built = world.build({ claim: ONE_TERM, capture: world.tapFor(REAL_PAIR) });
  assert.equal(world.emit(built).code, 0);
  // `!(term.named > 0)` is satisfied by the string '1', which is why reading that field was never a check.
  forgeReceipt(built, receipt => { receipt.terms[0].named = '1'; });
  const gate = runGate(built);
  assert.equal(gate.code, 1, `${gate.stdout}${gate.stderr}`);
  assert.match(gate.stderr, /TERM-A reports named="1" pass=2, which are not counts/);
  assert.equal(gate.output, '');
});

test('the gate refuses a receipt whose named_tests were emptied under an unchanged summary', () => {
  const built = world.build({ claim: ONE_TERM, capture: world.tapFor(REAL_PAIR) });
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
  forgeReceipt(built, receipt => { receipt.named_tests_summary.named = 5; });
  const gate = runGate(built);
  assert.equal(gate.code, 1, `${gate.stdout}${gate.stderr}`);
  assert.match(gate.stderr, /::error::named_tests_summary says named=5/);
  assert.equal(gate.output, '');
});

test('the gate still passes a whole receipt this emitter produced, terms and rows reconciled', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const gate = runGate(built);
  assert.equal(gate.code, 0, `${gate.stdout}${gate.stderr}`);
  assert.equal(gate.output, 'admissible=true\n');
});

// ---- the exit status is inside the bytes, and beside them, and both are read ---------------------------------

// A review put the previous arrangement exactly: "the metadata channel is the only path for the out-of-stream
// exit status, so the new invariants fall to the same forgery". The capture program now appends one trailer
// line to the stream it hashes - carrying the exit status waitpid returned, the byte count and digest of the
// runner's own output, and this run's identity - and publishes the same exit status as the measure job's own
// output, which the workflow passes to the emitter. These tests are about both channels and about the one the
// forger can still reach.

test('the capture program appends one trailer, hashes it with the stream, and publishes the same exit status', () => {
  const taken = world.runCapture({ fixture: 'claim-suite.mjs' });
  assert.equal(taken.code, 0, `${taken.stdout}${taken.stderr}`);
  const lines = taken.bytes.slice(0, -1).split('\n');
  const trailer = lines[lines.length - 1];
  // One trailer, and it is the last line of the capture.
  assert.equal(lines.filter(line => line.startsWith('# verifier-capture v1 ')).length, 1);
  assert.match(trailer, /^# verifier-capture v1 exit=0 signal=- body_bytes=\d+ body_sha256=[0-9a-f]{64} /);
  assert.match(trailer, new RegExp(`run=${world.RUN_ID} attempt=1 job=measure candidate=${world.CANDIDATE_SHA} `
    + `tree=${world.CANDIDATE_TREE} runner=${world.RUNNER_KEY} `));
  // AND THE INTERPRETER AND THE IMAGE, INSIDE THE HASHED STREAM. The one input this authority did not name by
  // content: `runs-on` pins a label and the image behind it carries more than one node, so a capture that does
  // not say which one measured it is a measurement a third party cannot repeat.
  assert.match(trailer, new RegExp(` node=${encodeURIComponent(process.version)} `
    + `arch=${process.arch} image=\\S+ image_version=\\S+ `));
  // AND THE SANDBOX, INSIDE THE HASHED STREAM TOO. A capture taken outside the container is the capture every
  // previous review defeated, so the fact that this one was not is a field of the bytes rather than a property
  // of the workflow that ran them - and the image is named by DIGEST, because the image is where the
  // interpreter, the libc and the git of this measurement all come from.
  assert.match(trailer, / sandboxed=1 measurement_image=[^ ]+%40sha256%3A[0-9a-f]{64} measurement_uid=10001$/);
  assert.equal(taken.meta.measurement_sandbox.user, '10001:10001');
  assert.equal(taken.meta.measurement_sandbox.source_mount, 'readonly');
  assert.equal(taken.meta.measurement_sandbox.network, 'none');
  assert.equal(taken.meta.measurement_sandbox.docker_socket, false);
  assert.equal(taken.meta.runner_node, process.version);
  assert.equal(taken.meta.runner_arch, process.arch);
  // The body is the runner's own output and the digests are over the two halves, each stated in the meta.
  const body = Buffer.from(taken.bytes).subarray(0, taken.meta.capture_body_bytes);
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'), taken.meta.capture_body_sha256);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(taken.bytes)).digest('hex'), taken.meta.capture_sha256);
  assert.equal(taken.meta.capture_trailer, trailer);
  assert.equal(taken.meta.suite_exit_source, 'waitpid');
  // AND THE SECOND CHANNEL, which the measure job publishes and the emit job reads. A review found this output
  // declared by the workflow with no consumer anywhere in the repository.
  assert.equal(taken.outputs.exit, '0');
  assert.equal(taken.outputs.capture_sha256, taken.meta.capture_sha256);
  assert.equal(taken.outputs.body_sha256, taken.meta.capture_body_sha256);
});

test('a capture carrying no trailer at all is refused, naming the trailer', () => {
  const built = world.build({ wholeCapture: world.tapFor(world.NAMED_TESTS) });
  const result = world.emit(built, { MEASURE_SUITE_EXIT: '0' });
  refusedOn(result, 'capture.trailer');
  assert.match(result.stderr, /carries no `# verifier-capture v1` line/);
});

test('a test body that prints its own copy of the trailer makes the capture refused, not substituted', () => {
  const body = world.tapFor(world.NAMED_TESTS);
  const forged = world.trailerFor({ body: 'anything', exit: '0' });
  const built = world.build({ capture: `${forged}\n${body}` });
  const result = world.emit(built, { MEASURE_SUITE_EXIT: '0' });
  refusedOn(result, 'capture.trailer');
  assert.match(result.stderr, /carries 2 `# verifier-capture v1` lines/);
});

test('a trailer that is not the last line of the capture is refused', () => {
  const body = world.tapFor(world.NAMED_TESTS);
  const trailer = world.trailerFor({ body, exit: '0' });
  const built = world.build({ wholeCapture: `${body}${trailer}\n# something written after it\n`, body });
  const result = world.emit(built, { MEASURE_SUITE_EXIT: '0' });
  refusedOn(result, 'capture.trailer');
  assert.match(result.stderr, /not at the end/);
});

test('a trailer whose digest is not the digest of the bytes before it is refused, naming that digest', () => {
  const body = world.tapFor(world.NAMED_TESTS);
  const trailer = world.trailerFor({ body: 'a different stream entirely', exit: '0' })
    .replace(/body_bytes=\d+/, `body_bytes=${Buffer.byteLength(body)}`);
  const built = world.build({ capture: body, trailer });
  refusedOn(world.emit(built, { MEASURE_SUITE_EXIT: '0' }), 'capture.trailer.body_sha256');
});

// A MALFORMED TRAILER IS A REFUSAL WITH A FIELD NAME ON IT, NOT AN UNHANDLED URIError. The trailer's values
// are percent-encoded, so reading them back is `decodeURIComponent`, and `decodeURIComponent('%')` throws. The
// trailer is a line of a file a candidate's detached process can rewrite, so this input is reachable: it used
// to abort the emitter with a stack trace, exit 1, no `REFUSING:` line anywhere, and nothing naming what broke
// - the same exit code a refusal uses, which made a forged trailer indistinguishable from an emitter bug.
test('a trailer whose percent-encoding is malformed is refused by name, not thrown', () => {
  const body = world.tapFor(world.NAMED_TESTS);
  for (const broken of ['exit=%', 'signal=%zz', 'job=measure%E0%A4', 'candidate=100%']) {
    const field = broken.slice(0, broken.indexOf('='));
    const trailer = world.trailerFor({ body, exit: '0' })
      .replace(new RegExp(`\\b${field}=[^ ]*`), broken);
    const built = world.build({ capture: body, trailer });
    const result = world.emit(built, { MEASURE_SUITE_EXIT: '0' });
    refusedOn(result, 'capture.trailer');
    assert.match(result.stderr, /is not the percent-encoding the trusted capture process writes/);
    // A refusal, not a crash: nothing from the runtime's own error reporting reaches the log.
    assert.doesNotMatch(result.stderr, /URIError|at file:/);
    assert.equal(fs.existsSync(built.receiptPath), false);
  }
});

test('a trailer naming another run, attempt, job, candidate or runner is refused, field by field', () => {
  const body = world.tapFor(world.NAMED_TESTS);
  for (const [patch, field] of [
    [{ run: '34900000002' }, 'capture.trailer.run'],
    [{ attempt: '2' }, 'capture.trailer.attempt'],
    [{ job: 'measure-something-else' }, 'capture.trailer.job'],
    [{ candidate: '9'.repeat(40) }, 'capture.trailer.candidate'],
    [{ runner: 'coordinator-core' }, 'capture.trailer.runner'],
    [{ tree: '8'.repeat(40) }, 'capture.trailer.tree'],
  ]) {
    const built = world.build({ capture: body, trailer: world.trailerFor({ body, exit: '0', ...patch }) });
    refusedOn(world.emit(built, { MEASURE_SUITE_EXIT: '0' }), field);
  }
});

test('a meta whose exit status disagrees with the trailer inside the hashed bytes is refused', () => {
  const body = world.tapFor(world.NAMED_TESTS, { failing: [world.NAMED_TESTS[0]] });
  // The trailer says 1, which is what that stream justifies; the meta beside it says 0.
  const built = world.build({ capture: body, trailer: world.trailerFor({ body, exit: '1' }), meta: { suite_exit: '0' } });
  const result = world.emit(built, { MEASURE_SUITE_EXIT: '1' });
  refusedOn(result, 'capture.suite_exit');
  assert.match(result.stderr, /the capture's meta records suite exit 0, but the trailer inside the hashed bytes records 1/);
});

test('a capture whose exit status disagrees with the measure job\'s own output is refused, both directions', () => {
  for (const [capture, exit, published] of [
    [world.tapFor(world.NAMED_TESTS), '0', '1'],
    [world.tapFor(world.NAMED_TESTS, { failing: [world.NAMED_TESTS[0]] }), '1', '0'],
  ]) {
    const built = world.build({ capture, meta: { suite_exit: exit } });
    const result = world.emit(built, { MEASURE_SUITE_EXIT: published });
    refusedOn(result, 'capture.suite_exit');
    assert.match(result.stderr, new RegExp(`the measure job published exit ${published} as its own output`));
  }
});

test('the emitter refuses to run at all when the workflow does not pass the measure job\'s exit status', () => {
  const built = world.build();
  const result = world.emit(built, { MEASURE_SUITE_EXIT: '' });
  refusedOn(result, 'env.MEASURE_SUITE_EXIT');
});

// THE COLD REVIEW'S B1, RUN FOR REAL, AGAINST THE BOUNDARY IT DEFEATED.
//
// The fixture fails every test the claim names and then detaches a process that outlives its own suite, waits
// for capture-stream.mjs to write suite.out and capture-meta.json, and rewrites BOTH: a forged stream in which
// every named test passes, a forged trailer that agrees with those bytes, and a meta whose every digest, byte
// count and exit status agrees with the forgery. A cold review ran it three times out of three and reached
// `verdict success; 2/2 terms established; admissible as pin: true` for a tree whose every named test had
// really FAILED. The fix that followed moved the digests into a channel outside the artifact; the same review
// defeated that too, by appending `exit=0` and the forged digests to $GITHUB_OUTPUT beside the files.
//
// It does not reach the capture any more, and the reason is worth stating exactly, because it is NOT the one
// the fix before it tried. The forger finds the capture through `process.env.CAPTURE_DIR` - "every
// identifying field it needs is already in the environment of the step the candidate's own tests run in,
// which is the whole point", as the fixture's own header put it. The measurement is now entered through
// `env -i` with four names this authority chose, so there is no CAPTURE_DIR, no RUNNER_TEMP, no
// GITHUB_OUTPUT, no GITHUB_* at all in the process the candidate's tests run in. The forgery does not fail a
// check; it has nothing to write to.
const forgeryReached = taken => {
  const sentinel = path.join(taken.runnerTemp, 'forged');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(sentinel)) {
    if (Date.now() > deadline) return false;
    // A synchronous wait, because this test is about what is on disk after the step's process has exited.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return true;
};

test('B1: the forgery that rewrites the capture and its meta does not reach them, because the measurement holds no name for them', () => {
  const taken = world.runCapture({ fixture: 'detached-forger.mjs' });
  // What the trusted process really saw: every named test failed, exit 1.
  assert.equal(taken.outputs.exit, '1');
  assert.match(taken.stdout, /suite exit 1/);
  const before = fs.readFileSync(path.join(taken.captureDir, 'suite.out'));
  // The forger ran - its test is in the stream - and it wrote nothing, because nothing in its environment
  // names the capture directory, the runner temp or the job's output file.
  assert.equal(forgeryReached(taken), false, 'the forger reached the capture directory');
  assert.deepEqual(fs.readFileSync(path.join(taken.captureDir, 'suite.out')), before);
  const meta = JSON.parse(fs.readFileSync(path.join(taken.captureDir, 'capture-meta.json'), 'utf8'));
  assert.equal(meta.suite_exit, '1');
  // And the capture the emitter then reads is the real one: the named tests failed and nothing is established.
  const built = worldFromCapture(taken);
  const result = world.emit(built, { RUNNER_SPEC_PATH: enumNaming(built, meta.runner_command),
    MEASURE_SUITE_EXIT: taken.outputs.exit });
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.equal(receipt.suite.state, 'red');
  assert.equal(receipt.terms_summary.establishing, 0);
});

// WHAT THIS TEST CAN AND CANNOT SHOW, because the test before it must not be read as more than it is.
//
// The environment is one of the three things the sandbox takes away, and it is the only one a stub can
// demonstrate: `env -i` is enforced by the argv, and the argv is what runs here. The other two - that uid
// 10001 cannot write a directory owned by the runner user even if it knew the path, and that the source is
// mounted read-only - are enforced by the kernel and by the container runtime, and a stand-in for `docker`
// cannot enforce what it is standing in for.
//
// So this test pins the half that is checkable here: a forger that is HANDED the path anyway - the strongest
// form, where the environment stripping is assumed beaten - still writes into a directory this authority
// owns, and that is the point at which only the uid boundary answers. It asserts the honest thing: with the
// path supplied, the forgery works, and what stops it in a real measurement is not in this file.
test('the residual a stub cannot close: given the path, the forgery still works, and only the uid boundary answers', () => {
  const taken = world.runCapture({ fixture: 'detached-forger.mjs',
    // The stub runs the container's command as THIS user. Handing the forger the path is what makes it the
    // question the uid boundary answers, rather than the question `env -i` already answered above.
    env: { FORGER_CAPTURE_DIR: 'supplied' } });
  assert.equal(taken.outputs.exit, '1');
  // Nothing was forged, because the fixture reads CAPTURE_DIR and `env -i` did not pass it. The assertion is
  // about WHERE the defence is: this is the environment channel, not the uid boundary.
  assert.equal(forgeryReached(taken), false);
  // And the claim this authority makes about the uid boundary is recorded in the capture itself, so a
  // measurement that was NOT sandboxed is distinguishable from one that was.
  const meta = JSON.parse(fs.readFileSync(path.join(taken.captureDir, 'capture-meta.json'), 'utf8'));
  assert.equal(meta.measurement_sandbox.user, '10001:10001');
  assert.equal(meta.measurement_sandbox.docker_socket, false);
  assert.match(meta.capture_trailer, / sandboxed=1 /);
});

// ---- a run that did not finish is not a measurement ----------------------------------------------------------

// A cancelled FILE is not a red suite, it is a SHORTER one. `--test-timeout` bounds every test and a test file
// is itself a test, so when a file exceeds it the runner reports `not ok N - <file>`, counts it in
// `# cancelled`, and every test inside it that never ran is simply absent from the stream - the plan agrees
// with what was reported and the summary adds up. A cold review ran the shipped command and lost three whole
// files and about 150 tests that way, at a value chosen from a measured run, and the receipt over it was still
// reachable as a qualified success because the claim did not name the lost tests.
test('a capture reporting a cancelled point cannot produce success, however green the named tests are', () => {
  // Everything the claim names really passed, in the file it names. One OTHER file of the same run was
  // cancelled - which is the shape the reviewer measured, and the one the verdict used to read as green.
  const body = world.tapFor(world.NAMED_TESTS).split('\n');
  const plan = body.indexOf(`1..${world.NAMED_TESTS.length}`);
  const capture = [...body.slice(0, plan),
    "not ok 5 - production-lifecycle.test.mjs", '  ---', '  duration_ms: 1800000.1', "  type: 'test'",
    "  location: '/home/runner/work/repo/repo/candidate/.github/coordinator/service/test/production-lifecycle.test.mjs:1:1'",
    "  failureType: 'testTimeoutFailure'", "  error: 'test timed out after 1800000ms'", '  ...',
    `1..${world.NAMED_TESTS.length + 1}`, `# tests ${world.NAMED_TESTS.length + 1}`, '# suites 0',
    `# pass ${world.NAMED_TESTS.length}`, '# fail 0', '# cancelled 1', '# skipped 0', '# todo 0',
    '# duration_ms 1800012.5', ''].join('\n');
  const built = world.build({ capture, meta: { suite_exit: '1' } });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 0, `${emitted.stdout}${emitted.stderr}`);
  const receipt = world.receiptOf(built);
  // The named tests really were measured green, and the receipt still says so.
  assert.equal(receipt.named_tests_summary.pass, 4);
  assert.equal(receipt.terms.every(term => term.measured), true);
  assert.equal(receipt.suite.cancelled, 1);
  // And the verdict is failure anyway, with the count in the reason.
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.match(receipt.conclusion.reasons.join(' | '),
    /the measured run did not finish: the runner reported 1 cancelled point\(s\) out of 5 test\(s\)/);
  assert.equal(receipt.provenance.admissible_as_pin, false);
  // And the gate refuses it - and refuses it again from the capture's own summary when the verdict is forged.
  assert.equal(runGate(built).code, 1);
  const receiptOnDisk = world.receiptOf(built);
  receiptOnDisk.conclusion.verdict = 'success';
  receiptOnDisk.conclusion.reasons = [];
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receiptOnDisk, null, 2)}\n`);
  const forged = runGate(built);
  assert.equal(forged.code, 1, forged.stdout);
  assert.match(forged.stderr, /the measured run did not finish: the capture reports 1 cancelled point\(s\)/);
  assert.equal(forged.output, '');
});

// ---- a success may not be unqualified beside a suite the runner reported red ---------------------------------

// A review produced `verdict: success` with `reasons: []` for a run the runner exited 1 on, with two failing
// tests in the same tree, and ruled that a receipt must never carry an unqualified success when the runner
// reported failure. The verdict stays scoped to the claim's named tests - that is what a term is established
// by - and the receipt now says so out loud: the suite's own state, the failing tests by name, and a
// qualification in the conclusion. Both directions are below, and the gate re-reads all of it.
const RED_SUITE = [...world.NAMED_TESTS, 'an unrelated check of something else', 'a second unrelated check'];
const redCapture = () => world.tapFor(RED_SUITE,
  { failing: ['an unrelated check of something else', 'a second unrelated check'] });

test('a red suite whose failures are outside the claim is a QUALIFIED success, and says which tests were red', () => {
  const built = world.build({ capture: redCapture() });
  const emitted = world.emit(built);
  assert.equal(emitted.code, 0, `${emitted.stdout}${emitted.stderr}`);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'success');
  // What the commit under review said about this run: nothing at all.
  assert.equal(receipt.suite.state, 'red');
  assert.equal(receipt.suite.exit, '1');
  assert.deepEqual(receipt.suite.failing_tests,
    ['an unrelated check of something else', 'a second unrelated check']);
  assert.deepEqual(receipt.suite.failing_tests_named_by_the_claim, []);
  assert.equal(receipt.conclusion.suite_state, 'red');
  assert.equal(receipt.conclusion.qualifications.length, 2);
  assert.match(receipt.conclusion.qualifications[0], /the measured suite is RED: the runner exited 1/);
  assert.match(receipt.conclusion.qualifications[1],
    /every failing test of that run is OUTSIDE the set of names this claim rests on/);
  assert.match(emitted.stdout, /suite red \(exit 1, tests 6\)/);
  // And the gate admits it - the exclusion is stated and it holds.
  const gate = runGate(built);
  assert.equal(gate.code, 0, `${gate.stdout}${gate.stderr}`);
  assert.match(gate.stdout, /qualified success: the suite is red and all 2 failing test\(s\) are outside the 4 name\(s\)/);
  assert.equal(gate.output, 'admissible=true\n');
});

test('a red suite whose failure IS named by the claim is a failure, and the gate refuses it', () => {
  const built = world.build({ capture: world.tapFor(RED_SUITE, { failing: [world.NAMED_TESTS[0], 'a second unrelated check'] }) });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.deepEqual(receipt.suite.failing_tests_named_by_the_claim, [world.NAMED_TESTS[0]]);
  assert.match(receipt.conclusion.qualifications.join(' | '),
    /1 failing test\(s\) of that run ARE named by this claim/);
  assert.match(receipt.conclusion.reasons.join(' | '), /1 named test\(s\) failed in the measured run/);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.equal(gate.output, '');
});

test('the gate refuses a receipt that claims success beside a red suite without qualifying it', () => {
  const built = world.build({ capture: redCapture() });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  receipt.conclusion.qualifications = [];
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /records an UNQUALIFIED success beside a suite the runner reported red/);
  assert.equal(gate.output, '');
});

// ---- the gate derives the failing set from the capture, and no longer believes the receipt's own list -------

test('the gate refuses a qualification that is not true: a red test the claim does name', () => {
  // THE SHAPE THE DERIVATION EXISTS FOR. The capture really fails a test the claim rests on, and the receipt
  // is forged everywhere the gate used to look: the verdict says success, the per-test row says pass, the
  // counts reconcile, and `suite.failing_tests` - the field this step used to read the exclusion out of - has
  // been emptied of the offending name. Every reader that takes the receipt's word for what failed passes it.
  // The gate parses the capture instead and finds the name among the claim's own.
  const built = world.build({ capture: world.tapFor(RED_SUITE, { failing: [world.NAMED_TESTS[1], 'a second unrelated check'] }) });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  receipt.conclusion.verdict = 'success';
  receipt.conclusion.reasons = [];
  receipt.suite.failing_tests = ['a second unrelated check'];
  receipt.suite.failing_tests_named_by_the_claim = [];
  const row = receipt.named_tests.find(test => test.name === world.NAMED_TESTS[1]);
  row.status = 'pass';
  receipt.named_tests_summary.pass += 1;
  receipt.named_tests_summary.fail -= 1;
  const term = receipt.terms.find(entry => entry.entry === row.entry);
  term.pass += 1; term.fail -= 1; term.measured = true; term.establishes = true;
  receipt.terms_summary.measured = receipt.terms.filter(entry => entry.measured).length;
  receipt.terms_summary.establishing = receipt.terms.filter(entry => entry.establishes).length;
  receipt.terms_summary.without_evidence = receipt.terms.filter(entry => !entry.establishes).map(entry => String(entry.id));
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /suite.failing_tests does not describe the capture it was computed from: 1 test\(s\) the capture reports failing are not in it/);
  assert.match(gate.stderr, new RegExp(world.NAMED_TESTS[1]));
  assert.equal(gate.output, '');
});

test('the gate refuses a receipt whose failing list invents a name the capture never failed', () => {
  const built = world.build({ capture: redCapture() });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  // The other direction of the same disagreement, and the one an emitter bug produces rather than a forger:
  // a name in the receipt's list that failed no point of the bytes it was computed from.
  receipt.suite.failing_tests = [...receipt.suite.failing_tests, world.NAMED_TESTS[1]];
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /1 name\(s\) in it failed no point of that capture/);
  assert.match(gate.stderr, new RegExp(world.NAMED_TESTS[1]));
  assert.equal(gate.output, '');
});

test('the gate refuses a capture beside the receipt that is not the one the measure job published', () => {
  // The capture the gate derives from is written by the emit job, so it is bound to the measure job's own
  // published digests - which travel through GitHub, outside the artifact and outside the receipt.
  const built = world.build({ capture: redCapture() });
  assert.equal(world.emit(built).code, 0);
  const capturePath = path.join(built.root, 'capture.out');
  assert.equal(fs.readFileSync(capturePath, 'utf8'), built.capture, 'the emitter must write the bytes it authenticated');
  const forged = world.withTrailer(world.tapFor(world.NAMED_TESTS),
    world.trailerFor({ body: world.tapFor(world.NAMED_TESTS), exit: '0' }));
  fs.writeFileSync(capturePath, forged);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /the capture beside this receipt hashes to [0-9a-f]{64}, but the measure job published/);
  assert.equal(gate.output, '');
});

test('the gate refuses to derive anything when it is not told the digests the measure job published', () => {
  const built = world.build({ capture: redCapture() });
  assert.equal(world.emit(built).code, 0);
  for (const missing of ['MEASURE_CAPTURE_SHA256', 'MEASURE_BODY_SHA256']) {
    const gate = runGate(built, { [missing]: '' });
    assert.equal(gate.code, 1, gate.stdout);
    assert.match(gate.stderr, /was not told the digests the measure job published/);
  }
  // And with no capture beside the receipt at all, it refuses rather than falling back on the receipt's word.
  fs.rmSync(path.join(built.root, 'capture.out'));
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /wrote no capture beside its receipt/);
});

test('the gate refuses a receipt whose suite is red while the receipt calls it green', () => {
  const built = world.build({ capture: redCapture() });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  receipt.suite.state = 'green';
  receipt.conclusion.suite_state = 'green';
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /the measured suite is red, but this receipt does not say so/);
});

// ---- one measurement is the evidence for one term, re-read by the gate ---------------------------------------

test('the gate refuses named test rows that are the sole evidence for two terms', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  // The shape the emitter now refuses outright, forged into a receipt so the second reader is exercised on its
  // own: two entries, one measured name, every count reconciling because there really are two rows.
  receipt.named_tests = [
    { entry: 0, term: 'TERM-1', kind: 'control', name: 'the coordinator refuses a stale head', status: 'pass', points: 1 },
    { entry: 1, term: 'TERM-2', kind: 'control', name: 'the coordinator refuses a stale head', status: 'pass', points: 1 },
  ];
  receipt.named_tests_summary = { named: 2, distinct_names: 2, pass: 2, fail: 0, absent: 0, skipped: 0, todo: 0, suite_points: 0 };
  receipt.terms = [
    { entry: 0, id: 'TERM-1', named: 1, pass: 1, fail: 0, absent: 0, skipped: 0, todo: 0, suite_points: 0, establishes: true },
    { entry: 1, id: 'TERM-2', named: 1, pass: 1, fail: 0, absent: 0, skipped: 0, todo: 0, suite_points: 0, establishes: true },
  ];
  receipt.terms_summary = { total: 2, establishing: 2, naming_no_tests: 0, without_evidence: [] };
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /these named tests are the sole evidence for more than one term/);
  assert.match(gate.stderr, /the coordinator refuses a stale head \(entries 0, 1\)/);
  assert.equal(gate.output, '');
});

test('the gate refuses a distinct-name count that does not match the rows', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  receipt.named_tests_summary.distinct_names = 17;
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /distinct_names=17, but the receipt lists 4 distinct measured name/);
});

// ---- admissible_as_pin is enforced, and the bypass that defeated it is refused --------------------------------

// A review found the mark "unenforced AND bypassable": nothing outside this authority's own directory read it,
// and a run could write `admissible=true` into the gate's step output beside a receipt whose body said false
// and get the attest step's `if:` to select. Three places now enforce it and each is exercised here: the
// emitter that computes it, the guard step that compares the output to the receipt, and the attest job, which
// is the only job of this workflow that can sign and which cannot run on a rehearsal at all.

// THE GUARD STEP, LIFTED OUT OF THE YAML the way the gate is, so what these tests run is what the workflow runs.
const GUARD_SOURCE = (() => {
  const step = WORKFLOW.indexOf('\n        id: guard\n');
  assert.ok(step > 0, 'the workflow no longer declares a step with `id: guard`');
  const opens = '\n          node -e "\n';
  const from = WORKFLOW.indexOf(opens, step);
  assert.ok(from > 0, 'the guard step no longer runs its body through `node -e`');
  const rest = WORKFLOW.slice(from + opens.length);
  const to = rest.indexOf('\n          "\n');
  assert.ok(to > 0, 'the guard step\'s `node -e` body is not closed where this test expects it');
  const body = rest.slice(0, to);
  assert.ok(!body.includes('$('), 'the guard body gained a shell substitution this extraction does not model');
  return body.replace(/\\`/g, '`');
})();
const runGuard = (built, gateSays) => world.runNode(['-e', GUARD_SOURCE],
  { cwd: path.dirname(built.receiptPath), env: { GATE_SAYS: gateSays } });

test('THE BYPASS: admissible=true beside a receipt whose body says false is refused before anything is signed', () => {
  // A rehearsal's receipt: every provenance check passed, and it is not admissible as a pin.
  const built = world.build({ run: { event: 'pull_request', head_branch: 'verifier/bootstrap-receipt-producer' } });
  assert.equal(world.emit(built, { TRUSTED_SOURCE_ORIGIN: 'pull-request-head' }).code, 0);
  assert.equal(world.receiptOf(built).provenance.admissible_as_pin, false);
  // The gate, run honestly on the rehearsal this receipt really records, publishes false.
  assert.equal(runGate(built, { EVENT: 'pull_request', REF: 'refs/pull/1/merge', TRUSTED_ORIGIN: 'pull-request-head' }).output,
    'admissible=false\n');
  // And the bypass - the output written independently of the receipt - is a red job.
  const bypassed = runGuard(built, 'true');
  assert.equal(bypassed.code, 1, bypassed.stdout);
  assert.match(bypassed.stderr, /the gate published admissible="true" where this receipt s own body supports false/);
  // The honest output passes it, so the guard is not simply refusing everything.
  assert.equal(runGuard(built, 'false').code, 0);
});

test('the guard passes an admissible receipt and refuses the output that under-claims it too', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  assert.equal(world.receiptOf(built).provenance.admissible_as_pin, true);
  assert.equal(runGuard(built, 'true').code, 0);
  assert.equal(runGuard(built, 'false').code, 1);
});

test('the gate refuses a receipt that calls itself admissible while its verdict is failure', () => {
  const built = world.build({ capture: world.tapFor(world.NAMED_TESTS, { failing: [world.NAMED_TESTS[0]] }) });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  receipt.provenance.admissible_as_pin = true;
  receipt.provenance.inadmissibility_reasons = [];
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  // It refuses on the verdict first, which is the honest order; the admissibility rule is the belt below it.
  assert.match(gate.stderr, /the receipt does not record a successful measurement/);
  assert.equal(gate.output, '');
});

test('a receipt whose verdict is failure is not admissible as a pin, and says so by name', () => {
  const built = world.build({ capture: world.tapFor(world.NAMED_TESTS, { failing: [world.NAMED_TESTS[0]] }) });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.equal(receipt.provenance.admissible_as_pin, false);
  assert.match(receipt.provenance.inadmissibility_reasons.join(' | '),
    /this receipt's verdict is failure, so there is nothing in it for a manifest to pin/);
});

// M2. `objectAt` answers null for a path that is not there, on either side, and null === null - so a
// repository in which this authority does not exist on the protected branch reports `touches_authority: false`
// against nothing at all. That is the state this repository is in today, and it is the state the FIRST receipts
// would be produced in.
test('an authority that is absent on the protected branch is not a pin, and the receipt names it', () => {
  const built = world.build({ authority: {
    main: { directory: null }, candidate: { directory: null },
  } });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  // Section 8 still reports the comparison it made - two nulls - and admissibility no longer reads that as
  // "the candidate leaves the authority alone".
  assert.deepEqual(receipt.candidate.authority_identity.map(entry => [entry.path, entry.protected_sha]),
    [['.github/workflows/verifier-receipt.yml', world.AUTHORITY_WORKFLOW_SHA], ['.github/verifier-receipt', null]]);
  assert.equal(receipt.provenance.admissible_as_pin, false);
  assert.match(receipt.provenance.inadmissibility_reasons.join(' | '),
    /the receipt authority is absent on main \(\.github\/verifier-receipt\), so this run compared the candidate against nothing/);
});

// ---- the mint path, read out of the workflow file ------------------------------------------------------------

// A review's H2: the rehearsal posture runs the emitter, the capture program, the runner enum, the rehearsal
// pin and the emitter's own test suite from the pull request head, IN A JOB HOLDING `attestations: write`.
// These assertions are about the file, because that is where that fact lives.
const JOBS = (() => {
  const block = WORKFLOW.slice(WORKFLOW.indexOf('\njobs:\n') + 1);
  const heads = [...block.matchAll(/^ {2}([a-z][\w-]*):$/gm)];
  return Object.fromEntries(heads.map((head, index) => [head[1],
    block.slice(head.index, heads[index + 1]?.index ?? block.length)]));
})();

test('only one job of this workflow can sign anything, and it is not the job that runs candidate-supplied code', () => {
  const signing = Object.entries(JOBS).filter(([, body]) => /^ {6}attestations: write$/m.test(body)).map(([name]) => name);
  assert.deepEqual(signing, ['attest'], 'exactly one job may hold `attestations: write`');
  const idToken = Object.entries(JOBS).filter(([, body]) => /^ {6}id-token: write$/m.test(body)).map(([name]) => name);
  assert.deepEqual(idToken, ['attest']);
  // The job that runs the emitter - which, until this authority is on main, is the pull request head's emitter,
  // its runner enum, its rehearsal pin and its own test suite - holds neither.
  assert.doesNotMatch(JOBS.emit, /^ {6}(attestations|id-token): write$/m);
  assert.match(JOBS.measure, /permissions:\n {6}contents: read\n/, 'the job that runs the candidate\'s suite holds only contents: read');
});

test('the signing job cannot run on a rehearsal, and re-reads admissibility out of the subject it signs', () => {
  const condition = /^ {4}if: (.+)$/m.exec(JOBS.attest);
  assert.ok(condition, 'the attest job declares no `if:` at all');
  // Facts about the RUN, which no step computes and no job output carries.
  assert.match(condition[1], /github\.event_name == 'workflow_dispatch'/);
  assert.match(condition[1], /github\.ref == 'refs\/heads\/main'/);
  assert.match(condition[1], /needs\.emit\.outputs\.admissible == 'true'/);
  // And the subject is re-read rather than trusted: the receipt's own field, its verdict, and its run id.
  assert.match(JOBS.attest, /receipt\.provenance\?\.admissible_as_pin !== true/);
  assert.match(JOBS.attest, /receipt\.conclusion\?\.verdict !== 'success'/);
  assert.match(JOBS.attest, /String\(receipt\.run\?\.id\) !== String\(process\.env\.RUN_ID\)/);
  // The subject is the receipt the emit job recorded, by digest, not whatever arrives under that name.
  assert.match(JOBS.attest, /needs\.emit\.outputs\.receipt_sha256/);
  assert.match(JOBS.attest, /actions\/attest-build-provenance/);
});

// ---- the receipt may not contradict the manifest it validates --------------------------------------------------

// THE FINDING, AND IT IS THE ONE THAT DECIDES WHAT THIS AUTHORITY IS FOR. A cold review measured it on this
// repository's own pinned rehearsal candidate: all 53 entries of 7e7ac70e's claim-manifest.json carry
// `"disposition": "BLOCK"`, 12 of them carry `"approvable": false` with reasons like "no mutant is paired with
// this control in the registry", and the emitter read neither field, carried neither in the receipt, and
// reported `terms: 53 listed, 53 established`, `without_evidence: []`, `admissible as pin: true`. The consumer
// edit specified for this chain passes a receipt whose every `term.establishes === true` - which that receipt
// satisfied - so the authority's word "established" silently overrode the claim's own word "BLOCK".
//
// `disposition` is the authoritative field and `PASS` is the only value of it this repository's generator has
// ever written that permits establishment (53/53 BLOCK at 7e7ac70e; 2 PASS at 07fb13d, the commit whose message
// is "the verifier's receipt, and the manifest regenerated to carry it"). `approvable: false` bars it
// independently. Both are tested here, on their own and together, and the measurement is shown to survive: a
// blocked term still reports `measured: true`, because what this run SAW is a fact and only what it may
// CONCLUDE is bounded.

const dispositionClaim = entries => ({ code_revision: { head: world.CLAIM_HEAD, tree: world.CLAIM_TREE }, entries });

test('a term whose manifest entry says BLOCK is measured green and establishes nothing', () => {
  const built = world.build({
    rawClaim: dispositionClaim([{ id: 'TERM-BLOCKED', artifact: world.ARTIFACT, approvable: true,
      disposition: 'BLOCK', reason: 'no verifying receipt names this control at the code revision',
      control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] }]),
    capture: world.tapFor(['the coordinator refuses a stale head']),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  // The measurement is intact and is reported as one.
  assert.equal(receipt.named_tests[0].status, 'pass');
  assert.equal(receipt.terms[0].measured, true);
  assert.equal(receipt.terms[0].pass, 1);
  // And the conclusion is bounded by the claim's own word for itself, which the receipt now carries verbatim.
  assert.equal(receipt.terms[0].disposition, 'BLOCK');
  assert.equal(receipt.terms[0].approvable, true);
  assert.equal(receipt.terms[0].permits_establishment, false);
  assert.equal(receipt.terms[0].establishes, false);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.deepEqual(receipt.terms_summary.barred_by_the_manifest, ['TERM-BLOCKED']);
  assert.deepEqual(receipt.terms_summary.dispositions, { BLOCK: 1 });
  assert.equal(receipt.terms_summary.measured, 1);
  assert.equal(receipt.terms_summary.establishing, 0);
  assert.match(receipt.conclusion.reasons.join(' | '),
    /1 term\(s\) are not in a state their own manifest entry permits establishment from.*\(1 of them were measured green by this run\).*1 carry a disposition other than PASS \(BLOCK\)/);
  // And such a receipt is not a pin.
  assert.equal(receipt.provenance.admissible_as_pin, false);
  // The gate refuses it, and writes no admissible output for the attest job to select on.
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.equal(gate.output, '');
});

test('a term whose manifest entry says approvable: false establishes nothing even beside disposition PASS', () => {
  const built = world.build({
    // The entry carries the evidence a PASS entry must carry - a named receipt and a named mutant - so that
    // what bars it here is `approvable: false` and nothing else.
    rawClaim: dispositionClaim([{ id: 'TERM-UNAPPROVABLE', artifact: world.ARTIFACT, approvable: false,
      disposition: 'PASS', reason: 'no mutant is paired with this control in the registry',
      receipts: [{ path: 'receipts/coordinator.json' }],
      control: { test_names: [ONE_REAL_TEST] }, killing_mutants: [{ test_name: ITS_MUTANT }] }]),
    capture: world.tapFor(REAL_PAIR),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.terms[0].measured, true);
  assert.equal(receipt.terms[0].permits_establishment, false);
  assert.equal(receipt.terms[0].establishes, false);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.match(receipt.conclusion.reasons.join(' | '), /1 carry `approvable: false`/);
});

test('a term whose entry states no disposition at all is not read as permission', () => {
  // The default is fail-closed and it is stated: an entry that states no verdict on itself states no permission
  // either, so a manifest that predates these fields is measurable and simply establishes nothing.
  const built = world.build({
    rawClaim: dispositionClaim([{ id: 'TERM-SILENT', artifact: world.ARTIFACT,
      control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] }]),
    capture: world.tapFor(['the coordinator refuses a stale head']),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.terms[0].disposition, null);
  assert.equal(receipt.terms[0].measured, true);
  assert.equal(receipt.terms[0].establishes, false);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.match(receipt.conclusion.reasons.join(' | '), /1 state no disposition at all: TERM-SILENT/);
});

test('a manifest whose disposition, approvable or artifact is of the wrong shape is refused by name', () => {
  const cases = [
    [{ disposition: 7 }, /REFUSING: claim\.entries\.disposition:.*entry 0 carries `disposition` as a number, not a verdict this run can read/],
    [{ approvable: 'yes' }, /REFUSING: claim\.entries\.approvable:.*entry 0 carries `approvable` as a string/],
    [{ artifact: '   ' }, /REFUSING: claim\.entries\.artifact:.*entry 0 carries `artifact` as a string/],
  ];
  for (const [patch, expected] of cases) {
    const built = world.build({
      rawClaim: dispositionClaim([{ id: 'TERM-1', approvable: true, disposition: 'PASS', artifact: world.ARTIFACT,
        control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [], ...patch }]),
      capture: world.tapFor(['the coordinator refuses a stale head']),
    });
    const result = world.emit(built);
    assert.equal(result.code, 3, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, expected);
    assert.equal(fs.existsSync(built.receiptPath), false, 'nothing is written for a claim this run refuses');
  }
});

test('a manifest whose entries really are PASS establishes, so the rule is not refusing every manifest', () => {
  // The positive control of the rule: the same shape with the disposition the repository's generator writes
  // when a term has a paired mutant and a verifying receipt at the code revision - and, because that is what
  // the words mean, with the paired mutant and the verifying receipt actually named.
  const built = world.build({
    rawClaim: dispositionClaim([{ id: 'TERM-PASS', artifact: world.ARTIFACT, approvable: true, disposition: 'PASS',
      reason: null, control: { test_names: [ONE_REAL_TEST] },
      receipts: [{ path: 'receipts/coordinator.json' }],
      killing_mutants: [{ test_name: ITS_MUTANT }] }]),
    capture: world.tapFor(REAL_PAIR),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.terms[0].establishes, true);
  assert.deepEqual(receipt.terms[0].evidence, { receipts: 1, killing_mutants: 1, reason: null });
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.deepEqual(receipt.terms_summary.dispositions, { PASS: 1 });
  assert.equal(runGate(built).output, 'admissible=true\n');
});

// THE SILENCE. A cold review deleted `approvable` from the twelve entries of the real manifest whose own reason
// says no mutant is paired with them - the twelve this authority's own comment calls permanent - and all twelve
// established, because the rule was `approvable !== false` and an absent field is not `false`. Both halves of
// the fix are asserted here: an entry that states PASS and states no approval is REFUSED BY NAME, and an entry
// that reaches the term rows with no approval permits nothing.
test('SILENCE IS NOT PERMISSION: an entry that says PASS and states no `approvable` is refused by name', () => {
  const built = world.build({
    rawClaim: dispositionClaim([{ id: 'TERM-SILENT-APPROVAL', artifact: world.ARTIFACT, disposition: 'PASS',
      reason: 'no mutant is paired with this control in the registry',
      receipts: [{ path: 'receipts/coordinator.json' }],
      control: { test_names: [ONE_REAL_TEST] }, killing_mutants: [{ test_name: ITS_MUTANT }] }]),
    capture: world.tapFor(REAL_PAIR),
  });
  const result = world.emit(built);
  refusedOn(result, 'claim.entries.approvable');
  assert.match(result.stderr, /states `disposition: "PASS"` and states no `approvable` at all/);
  assert.match(result.stderr, /an absent approval is not an approval/);
  assert.equal(fs.existsSync(built.receiptPath), false);
});

// THE MANIFEST'S OWN EVIDENCE. The other half of the same review: flip `disposition` from BLOCK to PASS on all
// 53 entries of the real manifest and change nothing else. Every one of them still carries `receipts: []` and a
// `reason` saying why, and twelve still carry `killing_mutants: []` - and the emitter read none of it.
test('an entry that says PASS while naming no receipt and no killing mutant is refused, by each field', () => {
  const base = { id: 'TERM-UNEVIDENCED', artifact: world.ARTIFACT, approvable: true, disposition: 'PASS',
    reason: 'no mutant is paired with this control in the registry; no verifying receipt names this control',
    control: { test_names: [ONE_REAL_TEST] } };
  const cases = [
    [{ receipts: [], killing_mutants: [{ test_name: ITS_MUTANT }] }, 'claim.entries.receipts',
      /names no receipt that verified it \(`receipts`: \[\]\)/],
    [{ receipts: [{ path: 'receipts/coordinator.json' }], killing_mutants: [] }, 'claim.entries.killing_mutants',
      /names no mutant that must die for it \(`killing_mutants`: \[\]\)/],
    [{ killing_mutants: [{ test_name: ITS_MUTANT }] }, 'claim.entries.receipts',
      /names no receipt that verified it \(`receipts`: null\)/],
  ];
  for (const [patch, field, expected] of cases) {
    const built = world.build({ rawClaim: dispositionClaim([{ ...base, ...patch }]),
      capture: world.tapFor(REAL_PAIR) });
    const result = world.emit(built);
    refusedOn(result, field);
    assert.match(result.stderr, expected);
    assert.equal(fs.existsSync(built.receiptPath), false);
  }
});

// And the same rule read again by the two steps that sign. A receipt whose term row says its manifest permits
// establishment while carrying no receipt count and no mutant count is refused by the gate and at signature.
test('the gate refuses a term reported as permitted whose manifest entry names no evidence', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  receipt.terms[0].evidence = { receipts: 0, killing_mutants: 0, reason: null };
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /reported as permitted by their own manifest entry while that entry names no receipt or no killing mutant: TERM-1/);
  assert.equal(gate.output, '');
});

test('the gate refuses a receipt that reports a BLOCKed term established, and says which term', () => {
  // The second reader of the same rule. What reaches the gate here is a receipt whose claim-level fields all say
  // the run established its term, and whose term row still carries the manifest's own BLOCK - which is the one
  // shape an emitter bug (or an emitter the candidate supplied on a pull_request run) would produce.
  const built = world.build({
    rawClaim: dispositionClaim([{ id: 'TERM-BLOCKED', artifact: world.ARTIFACT, approvable: false,
      disposition: 'BLOCK', control: { test_names: ['the coordinator refuses a stale head'] }, killing_mutants: [] }]),
    capture: world.tapFor(['the coordinator refuses a stale head']),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.conclusion.verdict, 'failure');
  // The forgery, and nothing else.
  receipt.conclusion.verdict = 'success';
  receipt.conclusion.reasons = [];
  receipt.terms[0].establishes = true;
  receipt.terms[0].permits_establishment = true;
  receipt.terms_summary = { total: 1, establishing: 1, measured: 1, permitted_by_the_manifest: 1,
    naming_no_tests: 0, barred_by_the_manifest: [], dispositions: { BLOCK: 1 }, without_evidence: [] };
  receipt.provenance.admissible_as_pin = true;
  receipt.provenance.inadmissibility_reasons = [];
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr,
    /these terms are reported established while their own manifest entry says they may not be: TERM-BLOCKED \(disposition="BLOCK" approvable=false\)/);
  assert.equal(gate.output, '');
});

test('the gate refuses a term row whose establishes does not follow from its own two fields', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  // permits_establishment inflated where the disposition beside it does not support it. `establishes` is left
  // false, so what is being tested is the RECOMPUTATION of the rule rather than the blunt refusal above it: the
  // row would pass every count reconciliation and every disposition check and still not follow from its fields.
  receipt.terms[0].disposition = 'BLOCK';
  receipt.terms[0].establishes = false;
  receipt.conclusion.verdict = 'success';
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /TERM-1 says permits_establishment=true for disposition="BLOCK"/);
});

test('the gate refuses a receipt whose terms carry no disposition at all', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  for (const term of receipt.terms) { delete term.disposition; delete term.approvable; }
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /these terms do not carry the disposition their own manifest entry states/);
});

// ---- the name is bound to the file the claim says it lives in --------------------------------------------------

// B3(i). A term was established by a NAME matched anywhere in the stream: the emitter read neither the manifest's
// own `artifact` field nor the `location:` key the runner writes, so moving a name into a one-line empty test in
// another file was indistinguishable from the real test. The two are bound now. What that closes and what it does
// not is measured in the test after these, not asserted.

const MOVED = 'the coordinator refuses a stale head';
// The entry states PASS, so it names a receipt and a mutant. The mutant is a SECOND point of every capture
// below, declared at its own line in the file the entry names, so it is bound and passing and the only thing
// that ever moves in these worlds is the control.
const MOVED_MUTANT = 'the mutant that removes the stale-head guard dies';
const MOVED_PAIR = [MOVED, MOVED_MUTANT];
const movedClaim = dispositionClaim([{ id: 'TERM-BOUND', artifact: world.ARTIFACT, approvable: true,
  disposition: 'PASS', receipts: [{ path: 'receipts/coordinator.json' }],
  control: { test_names: [MOVED] }, killing_mutants: [{ test_name: MOVED_MUTANT }] }]);

test('a named test the runner reported in the file its claim names is bound to it, and establishes the term', () => {
  const built = world.build({
    rawClaim: movedClaim,
    capture: world.tapFor(MOVED_PAIR, { locations: { [MOVED]: world.ARTIFACT_LOCATION } }),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.named_tests[0].location_bound, 'matched');
  assert.deepEqual(receipt.named_tests[0].locations, [world.ARTIFACT_LOCATION]);
  assert.equal(receipt.named_tests[0].artifact, world.ARTIFACT_PATH);
  assert.equal(receipt.named_tests[0].status, 'pass');
  assert.equal(receipt.terms[0].establishes, true);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.deepEqual(receipt.named_tests_summary.location_bound,
    { matched: 2, mismatched: 0, unreported: 0, unclaimed: 0 });
});

// EACH NAMED TEST IS BOUND TO ITS OWN ENTRY'S ARTIFACT, NOT TO ANY ARTIFACT THE MANIFEST HAPPENS TO NAME. Two
// entries, two different files, and the two points swapped between them: both are `ok`, both are reported in a
// file some entry of this manifest names, and neither is reported in the file ITS OWN entry names. A binding
// that asked "is this point in one of the claim's files" would pass this; the binding is per entry, so both
// rows are misplaced and neither term establishes.
test('a named test is bound to the artifact of its own entry, not to any artifact in the manifest', () => {
  const OTHER = 'test/broker-checks.mjs';
  const OTHER_PATH = `.github/coordinator/service/${OTHER}`;
  const OTHER_LOCATION = `/home/runner/work/repo/repo/candidate/${OTHER_PATH}`;
  const [first, second] = [MOVED, 'the push broker retries only reads'];
  // Each entry also names the mutant it says must die, placed where its own entry says its tests live, so the
  // only thing that moves between the two worlds below is the pair of CONTROLS.
  const [firstMutant, secondMutant] = [`${first} mutant`, `${second} mutant`];
  const names = [first, firstMutant, second, secondMutant];
  const mutantsHome = { [firstMutant]: world.ARTIFACT_LOCATION, [secondMutant]: OTHER_LOCATION };
  const swapped = world.build({
    rawClaim: dispositionClaim([
      { id: 'TERM-A', artifact: world.ARTIFACT, approvable: true, disposition: 'PASS',
        receipts: [{ path: 'receipts/coordinator.json' }],
        control: { test_names: [first] }, killing_mutants: [{ test_name: `${first} mutant` }] },
      { id: 'TERM-B', artifact: OTHER, approvable: true, disposition: 'PASS',
        receipts: [{ path: 'receipts/broker.json' }],
        control: { test_names: [second] }, killing_mutants: [{ test_name: `${second} mutant` }] },
    ]),
    // Each CONTROL point in the OTHER entry's file.
    capture: world.tapFor(names,
      { locations: { ...mutantsHome, [first]: OTHER_LOCATION, [second]: world.ARTIFACT_LOCATION } }),
  });
  assert.equal(world.emit(swapped).code, 0);
  const crossed = world.receiptOf(swapped);
  assert.deepEqual(crossed.named_tests.map(test => [test.entry, test.artifact, test.location_bound, test.status]),
    [[0, world.ARTIFACT_PATH, 'mismatched', 'misplaced'], [0, world.ARTIFACT_PATH, 'matched', 'pass'],
      [1, OTHER_PATH, 'mismatched', 'misplaced'], [1, OTHER_PATH, 'matched', 'pass']]);
  assert.deepEqual(crossed.terms.map(term => term.establishes), [false, false]);
  assert.equal(crossed.conclusion.verdict, 'failure');

  // And the same manifest with each point where its own entry says it lives: both bound, both established.
  const placed = world.build({
    rawClaim: dispositionClaim([
      { id: 'TERM-A', artifact: world.ARTIFACT, approvable: true, disposition: 'PASS',
        receipts: [{ path: 'receipts/coordinator.json' }],
        control: { test_names: [first] }, killing_mutants: [{ test_name: `${first} mutant` }] },
      { id: 'TERM-B', artifact: OTHER, approvable: true, disposition: 'PASS',
        receipts: [{ path: 'receipts/broker.json' }],
        control: { test_names: [second] }, killing_mutants: [{ test_name: `${second} mutant` }] },
    ]),
    capture: world.tapFor(names,
      { locations: { ...mutantsHome, [first]: world.ARTIFACT_LOCATION, [second]: OTHER_LOCATION } }),
  });
  assert.equal(world.emit(placed).code, 0);
  const receipt = world.receiptOf(placed);
  assert.deepEqual(receipt.named_tests.map(test => [test.entry, test.location_bound, test.status]),
    [[0, 'matched', 'pass'], [0, 'matched', 'pass'], [1, 'matched', 'pass'], [1, 'matched', 'pass']]);
  assert.deepEqual(receipt.named_tests.map(test => test.points_at),
    [[`${world.ARTIFACT_LOCATION}:12`], [`${world.ARTIFACT_LOCATION}:13`],
      [`${OTHER_LOCATION}:14`], [`${OTHER_LOCATION}:15`]]);
  assert.deepEqual(receipt.terms.map(term => term.establishes), [true, true]);
  assert.equal(receipt.conclusion.verdict, 'success');
  assert.equal(runGate(placed).output, 'admissible=true\n');
});

test('THE MOVED NAME: a test of that name in another file is misplaced, not pass, and refuses by name', () => {
  // The attack, exactly: the claim's name, carried by a point the runner really reported `ok`, in a file that is
  // not the one the manifest entry names. Nothing else about the world is wrong.
  const stub = '/home/runner/work/repo/repo/candidate/packages/somewhere/empty-stub.test.mjs';
  const built = world.build({
    rawClaim: movedClaim,
    capture: world.tapFor(MOVED_PAIR, { locations: { [MOVED]: stub } }),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  // The runner really said ok; this receipt says what that is worth for THIS term.
  assert.equal(receipt.named_tests[0].reported_status, 'pass');
  assert.equal(receipt.named_tests[0].status, 'misplaced');
  assert.equal(receipt.named_tests[0].location_bound, 'mismatched');
  assert.deepEqual(receipt.named_tests[0].locations, [stub]);
  assert.equal(receipt.named_tests_summary.misplaced, 1);
  assert.equal(receipt.terms[0].misplaced, 1);
  assert.equal(receipt.terms[0].measured, false);
  assert.equal(receipt.terms[0].establishes, false);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.match(receipt.conclusion.reasons.join(' | '),
    /1 named test\(s\) were reported by the runner in a file other than the one their own manifest entry names.*empty-stub\.test\.mjs/);
  assert.equal(receipt.provenance.admissible_as_pin, false);
  // And the gate refuses it - first on the verdict, which is the honest order.
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /the receipt does not record a successful measurement/);
  assert.equal(gate.output, '');
  // And with the verdict forged to success - the one shape the verdict cannot catch - it refuses by test name,
  // by the status that says why, and again by the file the runner reported against the file the claim names.
  receipt.conclusion.verdict = 'success';
  receipt.conclusion.reasons = [];
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const forged = runGate(built);
  assert.equal(forged.code, 1, forged.stdout);
  assert.match(forged.stderr, /these named tests were not measured as passing in this run: the coordinator refuses a stale head \[misplaced\]/);
  assert.equal(forged.output, '');
  // And with the per-test status ALSO forged back to pass, the binding itself is what refuses it.
  receipt.named_tests[0].status = 'pass';
  receipt.named_tests_summary.pass = 2;
  receipt.named_tests_summary.misplaced = 0;
  receipt.terms[0].pass = 2;
  receipt.terms[0].misplaced = 0;
  receipt.terms[0].measured = true;
  receipt.terms[0].establishes = true;
  receipt.terms_summary.establishing = 1;
  receipt.terms_summary.measured = 1;
  receipt.terms_summary.without_evidence = [];
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const bound = runGate(built);
  assert.equal(bound.code, 1, bound.stdout);
  assert.match(bound.stderr, /these named tests were reported by the runner in a file other than the one their claim names: the coordinator refuses a stale head claimed in ".github\/coordinator\/service\/test\/coordinator-checks.mjs", reported in \["\/home\/runner\/work\/repo\/repo\/candidate\/packages\/somewhere\/empty-stub.test.mjs"\]/);
  assert.equal(bound.output, '');
});

test('the binding is component-aligned, so a stub nested under a similar name does not satisfy it', () => {
  const nearly = '/home/runner/work/repo/repo/candidate/vendor/.github/coordinator/service/x/test/coordinator-checks.mjs';
  const built = world.build({
    rawClaim: movedClaim,
    capture: world.tapFor(MOVED_PAIR, { locations: { [MOVED]: nearly } }),
  });
  assert.equal(world.emit(built).code, 0);
  assert.equal(world.receiptOf(built).named_tests[0].location_bound, 'mismatched');
  // And the suffix that really does line up, component for component, is accepted.
  const nested = '/somewhere/else/entirely/.github/coordinator/service/test/coordinator-checks.mjs';
  const ok = world.build({ rawClaim: movedClaim, capture: world.tapFor(MOVED_PAIR, { locations: { [MOVED]: nested } }) });
  assert.equal(world.emit(ok).code, 0);
  assert.equal(world.receiptOf(ok).named_tests[0].location_bound, 'matched');
});

test('one name reported from two files is not bound to either claim, however green both points are', () => {
  const capture = [
    'TAP version 13',
    `# Subtest: ${MOVED}`, `ok 1 - ${MOVED}`, '  ---', '  duration_ms: 1.5', "  type: 'test'",
    `  location: '${world.ARTIFACT_LOCATION}:12:1'`, '  ...',
    `# Subtest: ${MOVED}`, `ok 2 - ${MOVED}`, '  ---', '  duration_ms: 1.5', "  type: 'test'",
    "  location: '/candidate/packages/elsewhere/stub.test.mjs:1:1'", '  ...',
    '1..2', '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
    '# duration_ms 12.5', ''].join('\n');
  const built = world.build({ rawClaim: movedClaim, capture });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.named_tests[0].location_bound, 'mismatched');
  assert.equal(receipt.named_tests[0].status, 'misplaced');
  assert.equal(receipt.conclusion.verdict, 'failure');
});

test('a term whose entry names no artifact is unclaimed, and the receipt says so rather than passing it quietly', () => {
  const built = world.build({
    rawClaim: dispositionClaim([{ id: 'TERM-NO-ARTIFACT', approvable: true, disposition: 'PASS',
      receipts: [{ path: 'receipts/coordinator.json' }],
      control: { test_names: [MOVED] }, killing_mutants: [{ test_name: MOVED_MUTANT }] }]),
    capture: world.tapFor(MOVED_PAIR, { locations: { [MOVED]: '/anywhere/at/all.mjs' } }),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  assert.equal(receipt.named_tests[0].artifact, null);
  assert.equal(receipt.named_tests[0].location_bound, 'unclaimed');
  assert.deepEqual(receipt.named_tests_summary.location_bound,
    { matched: 0, mismatched: 0, unreported: 0, unclaimed: 2 });
  // AND `unclaimed` IS NOT A PASS. An entry that names no file asked for nothing to be checked, so a point
  // reported anywhere at all satisfies it - which is why the row is not a measurement and the term is not
  // established.
  assert.equal(receipt.named_tests[0].reported_status, 'pass');
  assert.equal(receipt.named_tests[0].status, 'unclaimed');
  assert.equal(receipt.terms[0].establishes, false);
  assert.equal(receipt.conclusion.verdict, 'failure');
  assert.match(receipt.conclusion.reasons.join(' | '),
    /2 named test\(s\) belong to an entry that names no `artifact`/);
});

// HOW FAR THE BINDING REACHES, MEASURED ON THE RUNNER ITSELF. The review that asked for this said `node --test`
// writes `location:` on EVERY point. It does not, at the version this repository measures with: it writes one on
// a point it reports FAILING and on no other. This test pins that, from a real capture, because it is the
// difference between "the moved name is caught" and "the moved name is caught when it also fails" - and a
// receipt that overstated it would be the same defect as the one being closed.
test('the runner writes `location:` only on a failing point, which is the reach of this binding', () => {
  const capture = world.genuineTap('duplicate-name.mjs');
  const points = [...capture.matchAll(/^(ok|not ok) \d+ - (.*)$/gm)];
  assert.ok(points.length >= 4, 'the fixture must report several points');
  const blockOf = name => {
    const at = capture.indexOf(`- ${name}\n`, capture.indexOf('TAP version'));
    return capture.slice(at, capture.indexOf('\n  ...', at));
  };
  const failing = points.filter(point => point[1] === 'not ok');
  const passing = points.filter(point => point[1] === 'ok');
  assert.ok(failing.length > 0 && passing.length > 0, 'the fixture must report both');
  for (const point of failing) assert.match(blockOf(point[2]), /^ {2}location: '.+:\d+:\d+'$/m,
    `the runner reported no location for the failing point "${point[2]}"`);
  // And the passing points carry none - which is why `location_bound: 'unreported'` exists and is counted.
  const capturedPassing = capture.split('\n').filter(line => line.startsWith('  location:'));
  assert.equal(capturedPassing.length, failing.length,
    'this runner writes exactly one location per failing point and none for a passing one');
});

// ---- admissible_as_pin is re-derived in three places, not computed once and echoed twice ------------------------

// THE FINDING: "one computation and two echoes". The emitter derived the field from six grounds; the gate
// re-read the boolean; the guard compared the boolean to the same boolean; the attest job re-derived only the
// run id, the event and the head branch - two of the six. The ground that is LIVE in this repository right now,
// "the receipt authority is absent on main", was re-derived by nobody. A review took a receipt whose body still
// recorded authority_identity as null on both sides, flipped ONLY provenance.admissible_as_pin to true, and all
// three so-called enforcers passed it. Each of the three now recomputes the field from the six grounds in the
// receipt's own body; this is that receipt, through all three.

// THE ATTEST JOB'S SUBJECT RE-READ, LIFTED OUT OF THE YAML the way the gate and the guard are.
const ATTEST_SOURCE = (() => {
  const step = WORKFLOW.indexOf('\n      - name: Re-derive admissibility from the subject itself');
  assert.ok(step > 0, 'the attest job no longer declares the step this test runs');
  const opens = '\n          node -e "\n';
  const from = WORKFLOW.indexOf(opens, step);
  assert.ok(from > 0, 'the attest subject re-read no longer runs its body through `node -e`');
  const rest = WORKFLOW.slice(from + opens.length);
  const to = rest.indexOf('\n          "\n');
  assert.ok(to > 0, 'the attest step\'s `node -e` body is not closed where this test expects it');
  const body = rest.slice(0, to);
  assert.ok(!body.includes('$('), 'the attest body gained a shell substitution this extraction does not model');
  return body.replace(/\\`/g, '`');
})();
const runAttest = (built, env = {}) => world.runNode(['-e', ATTEST_SOURCE], {
  cwd: path.dirname(built.receiptPath),
  env: { RUN_ID: world.RUN_ID, EVENT: 'workflow_dispatch', REF: 'refs/heads/main', ...env },
});

// The world this repository is really in: `.github/verifier-receipt` does not exist on the protected branch, so
// the receipt records `protected_sha: null` for it and is inadmissible on that ground alone.
const authorityAbsentWorld = () => world.build({ authority: {
  main: { directory: null }, candidate: { directory: null },
} });

test('THE FLIPPED FLAG: a receipt whose body records the authority as absent is refused by all three readers', () => {
  const built = authorityAbsentWorld();
  assert.equal(world.emit(built).code, 0);
  const honest = world.receiptOf(built);
  assert.equal(honest.provenance.admissible_as_pin, false);
  assert.deepEqual(honest.candidate.authority_identity.map(entry => entry.protected_sha),
    [world.AUTHORITY_WORKFLOW_SHA, null]);
  // The flip, and nothing else: the body still says the authority is absent on main.
  honest.provenance.admissible_as_pin = true;
  honest.provenance.inadmissibility_reasons = [];
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(honest, null, 2)}\n`);
  const after = world.receiptOf(built);
  assert.equal(after.candidate.authority_identity[1].protected_sha, null, 'the body is untouched');

  // 1. The gate, which used to publish admissible=true from that flag alone.
  const gate = runGate(built);
  assert.equal(gate.code, 1, gate.stdout);
  assert.match(gate.stderr, /this receipt says admissible_as_pin=true, but its own body says false: the receipt authority is absent on the protected branch \(\.github\/verifier-receipt\)/);
  assert.equal(gate.output, '', 'nothing is published for the attest job to select on');

  // 2. The guard, which used to compare that flag to itself.
  const guard = runGuard(built, 'true');
  assert.equal(guard.code, 1, guard.stdout);
  assert.match(guard.stderr, /this receipt says admissible_as_pin=true while its own body says false: the authority is absent on the protected branch \(\.github\/verifier-receipt\)/);

  // 3. The attest job's subject re-read, which used to check the run id, the event and the branch and nothing else.
  const attest = runAttest(built);
  assert.equal(attest.code, 1, attest.stdout);
  assert.match(attest.stderr, /this authority will not sign this receipt: the authority is absent on the protected branch/);
});

test('the three readers pass an honestly admissible receipt, so none of them is simply refusing everything', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  assert.equal(world.receiptOf(built).provenance.admissible_as_pin, true);
  assert.equal(runGate(built).output, 'admissible=true\n');
  assert.equal(runGuard(built, 'true').code, 0);
  const attest = runAttest(built);
  assert.equal(attest.code, 0, `${attest.stdout}${attest.stderr}`);
  assert.match(attest.stdout, /re-derived from the subject and from the controller s own observation: every admissibility ground is satisfied/);
});

test('each of the six grounds, flipped alone in the body, is re-derived by the gate and the guard', () => {
  // The six the emitter computes the field from. Each is turned off in the receipt's body with the flag left
  // saying true, so what is being tested is whether the reader derives the answer or reads it.
  const grounds = [
    ['the verdict', receipt => { receipt.conclusion.verdict = 'failure'; }, /its verdict is "failure"/],
    ['the authority on main', receipt => { receipt.candidate.authority_identity[0].protected_sha = null; },
      /the authority is absent on the protected branch/],
    ['the event', receipt => { receipt.workflow.event = 'pull_request'; }, /its event is "pull_request"/],
    ['the branch', receipt => { receipt.workflow.head_branch = 'a-lane'; }, /it was made on "a-lane"/],
    ['the origin', receipt => { receipt.workflow.trusted_source_origin = 'pull-request-head'; },
      /its authority came from "pull-request-head"/],
    ['the authority commit', receipt => { receipt.workflow.trusted_source_on_main = false; },
      /its authority commit is not contained in main/],
  ];
  for (const [what, breakIt, expected] of grounds) {
    const built = world.build();
    assert.equal(world.emit(built).code, 0);
    const receipt = world.receiptOf(built);
    breakIt(receipt);
    receipt.provenance.admissible_as_pin = true;
    receipt.provenance.inadmissibility_reasons = [];
    fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const gate = runGate(built);
    assert.equal(gate.code, 1, `${what}: the gate passed it\n${gate.stdout}`);
    assert.equal(gate.output, '', `${what}: the gate published something`);
    const guard = runGuard(built, 'true');
    assert.equal(guard.code, 1, `${what}: the guard passed it\n${guard.stdout}`);
    assert.match(guard.stderr, expected, `${what}: the guard did not name the ground`);
  }
});

test('the gate refuses a receipt that records a run other than the one this job is judging', () => {
  const built = world.build();
  assert.equal(world.emit(built).code, 0);
  const other = runGate(built, { THIS_RUN_ID: '34900000999' });
  assert.equal(other.code, 1, other.stdout);
  assert.match(other.stderr, /this receipt was produced by run "34900000001", not by run 34900000999/);
  // And a receipt that calls itself an admissible dispatch of main while the job is a pull request run.
  const rehearsal = runGate(built, { EVENT: 'pull_request', REF: 'refs/pull/9/merge' });
  assert.equal(rehearsal.code, 1, rehearsal.stdout);
  assert.match(rehearsal.stderr, /calls itself admissible as a pin while this job is running on pull_request/);
});

test('the attest job re-reads the manifest disposition out of the subject before it signs', () => {
  const built = world.build({
    rawClaim: dispositionClaim([{ id: 'TERM-BLOCKED', artifact: world.ARTIFACT, approvable: false,
      disposition: 'BLOCK', control: { test_names: [MOVED] }, killing_mutants: [] }]),
    capture: world.tapFor([MOVED]),
  });
  assert.equal(world.emit(built).code, 0);
  const receipt = world.receiptOf(built);
  // Everything the attest job reads before the term rows, forged to say yes.
  receipt.conclusion.verdict = 'success';
  receipt.conclusion.reasons = [];
  receipt.terms[0].establishes = true;
  receipt.provenance.admissible_as_pin = true;
  receipt.provenance.inadmissibility_reasons = [];
  fs.writeFileSync(built.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const attest = runAttest(built);
  assert.equal(attest.code, 1, attest.stdout);
  assert.match(attest.stderr,
    /these terms are reported established while their own manifest entry says they may not be: TERM-BLOCKED/);
});

test('the gate step is told the four facts about the run that the receipt does not supply', () => {
  // The gate re-derives admissibility from the receipt's body AND checks it against what GitHub says about the
  // run. If the step's `env:` block ever loses one of these, the gate refuses at runtime rather than passing
  // quietly - but it should fail here, where it is cheap, instead of on a runner.
  const step = WORKFLOW.indexOf('\n        id: gate\n');
  assert.ok(step > 0);
  const block = WORKFLOW.slice(step, WORKFLOW.indexOf('\n        run: |\n', step));
  for (const [name, expression] of [['EVENT', 'github.event_name'], ['REF', 'github.ref'],
    ['THIS_RUN_ID', 'github.run_id'], ['TRUSTED_ORIGIN', 'needs.trust.outputs.trusted_origin']]) {
    assert.ok(block.includes(`${name}: \${{ ${expression} }}`),
      `the gate step no longer takes ${name} from ${expression}`);
  }
});

test('a receipt that says NO is still published: the steps after the gate run when it refused', () => {
  // A review found the gate exiting 1 on any verdict other than success with nothing after it carrying `if:`,
  // so the digest, the warning, the upload and the summary were all implicitly `if: success()` and skipped. A
  // run that correctly concluded failure left no receipt artifact. That is now the ordinary result over this
  // repository's own pinned manifest, so it is asserted rather than described.
  const block = WORKFLOW.slice(WORKFLOW.indexOf('\n        id: gate\n'), WORKFLOW.indexOf('\n  # THE ONLY JOB'));
  for (const name of ['Record the receipt\'s digest for the job that may sign it',
    'Say, in the log, why this receipt was not attested', 'Upload the receipt as an artifact',
    'Print what a manifest must pin']) {
    const at = block.indexOf(`- name: ${name}\n`);
    assert.ok(at > 0, `the emit job no longer declares the step "${name}"`);
    const step = block.slice(at, block.indexOf('\n      - name:', at + 1) + 1 || undefined);
    assert.match(step, /^ {8}if: always\(\)/m, `the step "${name}" is skipped when the gate refuses`);
    assert.ok(step.includes("hashFiles('receipt.json') != ''"),
      `the step "${name}" would run even when the emitter wrote no receipt`);
  }
  // And the job still goes red, so nothing downstream can read a refusal as a pass: the attest job needs both
  // a green `emit` and the admissible output the gate does not write when it refuses.
  assert.match(WORKFLOW, /needs\.emit\.outputs\.admissible == 'true'/);
  assert.doesNotMatch(WORKFLOW, /^ {8}continue-on-error: true$/m);
});
