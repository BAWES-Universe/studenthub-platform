// Tests for the fetch tool, because it is the piece that turns a pin into evidence and it had none.
//
// `gh` is stubbed through PATH, so the checks run without network and without a token: each case supplies the
// API's answers in a fixture file and asserts what the tool does with them. The refusals are the point - a tool
// that accepted a run it was not asked to measure, an artifact GitHub never digested, or a receipt with no
// attestation would let a fabricated pin through.
//
// TWO KINDS OF RECEIPT APPEAR BELOW, and which is which is never left to be inferred:
//
//   * `SYNTHETIC_GREEN` is written here. It is the smallest receipt that stands for an admissible one, and it
//     is what the acceptance case and every "one field wrong" case are built from. Nothing it says happened.
//   * `fixtures/receipt-35869844952/receipt.trimmed.json` is a REAL receipt, produced by a real dispatch of
//     the authority on refs/heads/main for candidate 6feac016, three unread keys removed and no value edited.
//     Its digest is pinned here so that editing it to make a test pass fails the suite instead. It is a
//     FAILURE receipt, so the consumer must refuse to pin it - see that directory's README.md.
//
// AND THE MUTANTS GO BOTH WAYS, because admissibility is now RE-DERIVED here with the authority's own
// predicate rather than read off `provenance.admissible_as_pin`:
//
//   * the real receipt with ONLY that flag flipped to true is refused, and the refusal names the grounds its
//     own body says no on - the forgery that walked past three readers which each compared a computed
//     boolean with itself;
//   * a body every ground of which is satisfied, with the flag saying false or absent, is refused too, as the
//     disagreement it is: a flag that understates is reported, not resolved in the pin's favour;
//   * the predicate module itself is checked by git blob id against refs/heads/main, and a mismatch is
//     refused naming both ids - on a pull_request event the checked-out code is the candidate's, so a
//     consumer that trusted its own copy of the rule would let a candidate supply the rule that judges it.
//
// The suite reaches for no network and no git history: it runs under actions/checkout at fetch-depth 1. The
// blob ids it expects are computed from this repository's own files rather than pinned as constants, so the
// rule and its permission list can be edited without a stale expectation silently passing here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const TOOL = path.join(import.meta.dirname, '..', 'fetch-receipt.mjs');
const STUB = path.join(import.meta.dirname, 'gh-stub.cjs');
const REPO = 'owner/name';
const WORKFLOW = '.github/workflows/verifier-receipt.yml';
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
// `GITHUB_WORKFLOW_REF` as the authority records it in workflow.ref and workflow.workflow_ref.
const WORKFLOW_REF = `${REPO}/${WORKFLOW}@refs/heads/main`;

// SYNTHETIC. Not a receipt any run produced: the smallest body carrying every field the consumer reads, in
// the state an admissible receipt would carry it. EVERY GROUND of `.github/verifier-receipt/admissibility.mjs`
// is satisfied here, because the consumer now re-derives that rule rather than reading the flag: a green
// suite with no failing, cancelled, skipped or `todo` point, every named test passing, the authority present
// on the protected branch, and a dispatch of main whose authority files came from protected main.
const SYNTHETIC_GREEN = {
  schema: 2,
  repository: REPO,
  workflow: { path: WORKFLOW, ref: WORKFLOW_REF, workflow_ref: WORKFLOW_REF, head_sha: HEAD,
    head_branch: 'main', event: 'workflow_dispatch', trusted_source_sha: HEAD,
    trusted_source_origin: 'protected-main', trusted_source_on_main: true },
  run: { id: '4242', attempt: '1' },
  candidate: { sha: HEAD, tree: TREE, authority_identity: [
    { path: WORKFLOW, protected_sha: 'e'.repeat(40), change: 'none' },
    { path: '.github/verifier-receipt', protected_sha: 'f'.repeat(40), change: 'none' },
  ] },
  provenance: { admissible_as_pin: true, inadmissibility_reasons: [] },
  manifest: { sha256: 'c'.repeat(64), code_revision: { head: HEAD, tree: TREE } },
  suite: { tests: 10, ok: 10, not_ok: 0, cancelled: 0, skipped: 0, todo: 0, exit: '0', state: 'green',
    failing_tests: [] },
  named_tests: [{ term: 'a/term', kind: 'control', name: 'a control', status: 'pass' }],
  named_tests_summary: { named: 1, pass: 1 },
  conclusion: { verdict: 'success', scope: 'named tests', suite_state: 'green' },
};
const receipt = SYNTHETIC_GREEN;

const RUN = { path: WORKFLOW, event: 'workflow_dispatch', head_branch: 'main', status: 'completed',
  conclusion: 'success', id: 4242, head_sha: HEAD, run_attempt: 1 };
const ARTIFACT = { id: 77, name: 'verifier-receipt', expired: false,
  digest: `sha256:${'d'.repeat(64)}`, workflow_run: { head_sha: HEAD } };

// THE PROTECTED BRANCH'S ANSWER FOR THE RULE ITSELF. The consumer hashes the predicate module it loaded the
// way git hashes a blob and asks the API what blob `refs/heads/main` holds for that path; these are the
// answers a healthy world gives, computed from the very files this repository holds so that an edit to the
// rule changes them here too rather than leaving a stale constant behind.
const gitBlobId = bytes => crypto.createHash('sha1')
  .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes])).digest('hex');
const RULE_FILES = {
  '.github/verifier-receipt/admissibility.mjs': path.join(import.meta.dirname, '..', 'admissibility.mjs'),
  '.github/verifier-receipt/tolerated-skips.json': path.join(import.meta.dirname, '..', 'tolerated-skips.json'),
};
const blobOf = repoPath => gitBlobId(fs.readFileSync(RULE_FILES[repoPath]));
const contentsAnswer = repoPath => ({ type: 'file', path: repoPath, sha: blobOf(repoPath) });

// Prepare a directory holding the stub, its answers and optionally a real zip of the receipt. `zip` is either
// an object, which is serialised, or a string, which is written as the receipt's bytes unchanged.
const stage = ({ run = RUN, artifacts = { artifacts: [ARTIFACT] }, zip = null, attestations = [],
  runId = '4242', repo = REPO, contents = {} } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  const answers = {
    [`/repos/${repo}/actions/runs/${runId}`]: run,
    [`/repos/${repo}/actions/runs/${runId}/artifacts`]: artifacts,
  };
  for (const repoPath of Object.keys(RULE_FILES)) {
    answers[`/repos/${repo}/contents/${repoPath}?ref=refs/heads/main`] =
      repoPath in contents ? contents[repoPath] : contentsAnswer(repoPath);
  }
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
  fs.writeFileSync(path.join(dir, 'attestations.json'), JSON.stringify({ attestations }));
  fs.copyFileSync(STUB, path.join(dir, 'gh.cjs'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec node "${path.join(dir, 'gh.cjs')}" "$@"\n`);
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  if (zip) {
    const receiptPath = path.join(dir, 'receipt.json');
    fs.writeFileSync(receiptPath, typeof zip === 'string' ? zip : JSON.stringify(zip));
    execFileSync('python3', ['-c', [
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1], "w") as archive:',
      '    archive.write(sys.argv[2], "receipt.json")',
    ].join('\n'), path.join(dir, 'zip.bin'), receiptPath]);
  }
  return dir;
};

const runTool = (dir, { runId = '4242', repo = REPO } = {}) => {
  try {
    return { code: 0, stdout: execFileSync('node', [TOOL, '--run', runId, '--repo', repo],
      { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }), stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '' };
  }
};

// A staged healthy world with one field of the RECEIPT replaced, which is what every identity case needs.
const withReceipt = body => runTool(stage({ zip: body, attestations: [envelope()] }));
const withWorkflow = fields =>
  withReceipt({ ...receipt, workflow: { ...receipt.workflow, ...fields } });

test('the fetch tool refuses a run that is not a dispatch of the receipt workflow on main', () => {
  for (const [field, value, expectation] of [
    ['path', '.github/workflows/ci.yml', /not \.github\/workflows\/verifier-receipt\.yml/],
    ['event', 'push', /not a dispatch/],
    ['head_branch', 'some-branch', /dispatched on some-branch, not main/],
    ['conclusion', 'failure', /concluded failure/],
    ['status', 'in_progress', /is in_progress/],
  ]) {
    const result = runTool(stage({ run: { ...RUN, [field]: value } }));
    assert.notEqual(result.code, 0, `${field}=${value} must be refused`);
    assert.match(result.stderr, expectation, `${field}=${value} gave: ${result.stderr}`);
  }
});

test('the fetch tool refuses an artifact it cannot tie to a digest, and a receipt with no attestation', () => {
  const noDigest = runTool(stage({ artifacts: { artifacts: [{ ...ARTIFACT, digest: undefined }] } }));
  assert.match(noDigest.stderr, /carries no digest/);

  const absent = runTool(stage({ artifacts: { artifacts: [] } }));
  assert.match(absent.stderr, /holds no artifact named verifier-receipt/);

  // A healthy run, a digested artifact, a real zip - and no attestation recorded against the receipt's digest.
  // Nothing then ties those bytes to a workflow run, so the tool must refuse rather than emit a pin.
  const unAttested = runTool(stage({ zip: receipt }));
  assert.match(unAttested.stderr, /no attestation is recorded/);
});

test('the fetch tool refuses a receipt that does not belong to the run it was fetched from', () => {
  const wrongRun = runTool(stage({ zip: { ...receipt, run: { id: '9999' } }, attestations: [envelope()] }));
  assert.match(wrongRun.stderr, /the receipt names run 9999/);

  // The receipt says the authority ran at a commit GitHub does not report for this run. The measured
  // candidate is an input and may differ from it; the commit the authority ran at may not.
  const wrongCommit = withWorkflow({ head_sha: '0'.repeat(40) });
  assert.match(wrongCommit.stderr, /says the authority ran at 0{40}, but GitHub reports run 4242 ran a{40}/);

  // A candidate that differs from the dispatching commit is the NORMAL case for a dispatch and is accepted.
  const otherCandidate = withReceipt({ ...receipt,
    candidate: { ...receipt.candidate, sha: '1'.repeat(40), tree: TREE } });
  assert.equal(otherCandidate.code, 0, `expected success, got: ${otherCandidate.stderr}`);
});

test('the fetch tool reads the receipt schema it actually reads the fields of', () => {
  for (const [schema, expectation] of [
    [1, /is schema 1, and this tool reads schema 2 only/],
    [3, /is schema 3, and this tool reads schema 2 only/],
    ['2', /is schema "2", and this tool reads schema 2 only/],
    [undefined, /is schema null, and this tool reads schema 2 only/],
  ]) {
    const body = { ...receipt, schema };
    if (schema === undefined) delete body.schema;
    const result = withReceipt(body);
    assert.notEqual(result.code, 0, `schema ${schema} must be refused`);
    assert.match(result.stderr, expectation, `schema ${schema} gave: ${result.stderr}`);
  }
});

// ITEM 1. The tool used to build the ref it checked out of the run's own branch, so the check compared a
// derived value with a value derived the same way and could not disagree. These cases are the ones that
// value made unreachable: the RUN is a healthy dispatch on main throughout, and only the RECEIPT is wrong.
test('the fetch tool reads the identity out of the receipt, and refuses a receipt that names another ref', () => {
  const onAnotherRef = `${REPO}/${WORKFLOW}@refs/heads/topic`;
  for (const [what, fields, expectation] of [
    ['a workflow path that is not the authority\'s', { path: '.github/workflows/ci.yml' },
      /names workflow "\.github\/workflows\/ci\.yml", not \.github\/workflows\/verifier-receipt\.yml/],
    ['no workflow path at all', { path: undefined }, /names workflow null, not/],
    ['a ref that is not the protected branch', { ref: onAnotherRef, workflow_ref: onAnotherRef },
      /workflow\.ref names ref "refs\/heads\/topic", not refs\/heads\/main/],
    ['a workflow_ref that is not the protected branch', { workflow_ref: onAnotherRef },
      /workflow\.workflow_ref names ref "refs\/heads\/topic", not refs\/heads\/main/],
    ['a tag rather than a branch', { ref: `${REPO}/${WORKFLOW}@refs/tags/v1`, workflow_ref: `${REPO}/${WORKFLOW}@refs/tags/v1` },
      /workflow\.ref names ref "refs\/tags\/v1", not refs\/heads\/main/],
    ['no ref at all', { ref: undefined }, /carries no readable workflow\.ref \(null\)/],
    ['no workflow_ref at all', { workflow_ref: undefined }, /carries no readable workflow\.workflow_ref \(null\)/],
    ['a bare ref with nothing to place it', { ref: 'refs/heads/main' },
      /carries no readable workflow\.ref \("refs\/heads\/main"\)/],
    ['a ref in another repository', { ref: `other/name/${WORKFLOW}@refs/heads/main`,
      workflow_ref: `other/name/${WORKFLOW}@refs/heads/main` },
      /workflow\.ref names "other\/name\/\.github\/workflows\/verifier-receipt\.yml", not owner\/name\//],
    ['no head_sha at all', { head_sha: undefined }, /carries no workflow\.head_sha \(null\)/],
    ['a head_sha that is not a commit', { head_sha: 'main' }, /carries no workflow\.head_sha \("main"\)/],
  ]) {
    const result = withWorkflow(fields);
    assert.notEqual(result.code, 0, `${what} must be refused`);
    assert.match(result.stderr, expectation, `${what} gave: ${result.stderr}`);
  }

  // The repository the receipt names is its own field too, not one taken from --repo.
  const elsewhere = withReceipt({ ...receipt, repository: 'other/name' });
  assert.match(elsewhere.stderr, /names repository "other\/name", not owner\/name/);
  const noRepository = withReceipt({ ...receipt, repository: undefined });
  assert.match(noRepository.stderr, /names repository null, not owner\/name/);
});

// ITEM 2. ADMISSIBILITY IS RE-DERIVED WITH THE AUTHORITY'S OWN PREDICATE, NOT READ OFF THE FLAG. The flag is
// still required to say true - a receipt is not pinned over its own objection - but it decides nothing: the
// tool applies `.github/verifier-receipt/admissibility.mjs` to the body and refuses any disagreement, in
// EITHER direction. A flag that over-claims is the forgery a review used; a flag that under-claims is a
// receipt contradicting itself, and this tool reports that rather than resolving it in the pin's favour.
test('the fetch tool refuses a receipt that does not say a manifest may pin it', () => {
  const provenance = fields => withReceipt({ ...receipt, provenance: { ...receipt.provenance, ...fields } });

  // MUTANT B, in its smallest form: every ground satisfied, the flag saying false.
  const absent = withReceipt({ ...receipt, provenance: { inadmissibility_reasons: [] } });
  assert.notEqual(absent.code, 0, 'an absent admissible_as_pin must be refused');
  assert.match(absent.stderr, /records provenance\.admissible_as_pin=null while every ground of `?\.github\/verifier-receipt\/admissibility\.mjs`? is satisfied by its own body/);

  const noProvenance = withReceipt({ ...receipt, provenance: undefined });
  assert.match(noProvenance.stderr, /records provenance\.admissible_as_pin=null while every ground/);

  const silentlyFalse = provenance({ admissible_as_pin: false, inadmissibility_reasons: [] });
  assert.notEqual(silentlyFalse.code, 0, 'false with no reasons must be refused');
  assert.match(silentlyFalse.stderr, /records provenance\.admissible_as_pin=false while every ground/);
  assert.match(silentlyFalse.stderr, /refuses a disagreement between a receipt and itself/);

  // A body whose grounds really do fail: the derived reasons are what the refusal quotes, and the receipt's
  // own recorded words are quoted beside them.
  const failed = withReceipt({ ...receipt, conclusion: { verdict: 'failure', suite_state: 'green' },
    provenance: { admissible_as_pin: false,
      inadmissibility_reasons: ['this receipt\'s verdict is failure, so there is nothing in it for a manifest to pin'] } });
  assert.match(failed.stderr, /may not be pinned, on 1 ground\(s\) re-derived from its own body: "this receipt's verdict is failure/);
  assert.match(failed.stderr, /it records: "this receipt's verdict is failure/);

  // A receipt cannot both permit a pin and record why it may not be pinned.
  const contradictory = provenance({ admissible_as_pin: true, inadmissibility_reasons: ['its verdict is failure'] });
  assert.match(contradictory.stderr,
    /admissible_as_pin=true while recording 1 reason\(s\) why it may not be pinned: "its verdict is failure"/);

  const noReasonList = provenance({ admissible_as_pin: true, inadmissibility_reasons: undefined });
  assert.match(noReasonList.stderr, /carries no provenance\.inadmissibility_reasons list/);

  // "true" is not true, and neither is 1: the field is read, not coerced.
  for (const value of ['true', 1]) {
    const coerced = provenance({ admissible_as_pin: value });
    assert.notEqual(coerced.code, 0, `admissible_as_pin=${JSON.stringify(value)} must be refused`);
    assert.match(coerced.stderr, /admissible_as_pin=/, `gave: ${coerced.stderr}`);
  }
});

// MUTANT B, ONE GROUND AT A TIME. Each case below turns a single ground off in the BODY, leaves the flag
// saying true, and requires the refusal to name that ground - which is only possible if the tool derived the
// answer rather than read it.
test('MUTANT: the flag says true while one ground of the body says no, and the refusal names the ground', () => {
  const cases = [
    ['the verdict', body => { body.conclusion = { ...body.conclusion, verdict: 'failure' }; },
      /this receipt's verdict is failure, so there is nothing in it for a manifest to pin/],
    ['a red suite', body => {
      body.suite = { ...body.suite, state: 'red', not_ok: 2, ok: 8, exit: '1',
        failing_tests: ['an unrelated check', 'another'] };
      body.conclusion = { ...body.conclusion, suite_state: 'red' };
    }, /the measured suite reports 2 failing test\(s\) out of 10/],
    ['an unauthorized skip', body => {
      body.suite = { ...body.suite, skipped: 1, ok: 9, skipped_tests: ['a check that needs a daemon'] };
    }, /1 skipped test\(s\) are not in the authorized list[^"]*"a check that needs a daemon"/],
    // MUTANT C: the flipped-boolean case the authority's own comment records as having defeated the producer.
    ['the authority absent from main', body => {
      body.candidate = { ...body.candidate,
        authority_identity: [{ path: '.github/verifier-receipt', protected_sha: null, change: 'none' }] };
    }, /the receipt authority is absent on main \(\.github\/verifier-receipt\)/],
    ['the event', body => { body.workflow = { ...body.workflow, event: 'pull_request' }; },
      /this run's event is pull_request; only a workflow_dispatch of/],
    ['the origin of the authority files', body => {
      body.workflow = { ...body.workflow, trusted_source_origin: 'pull-request-head' };
    }, /the authority files came from pull-request-head, not from protected main/],
    ['the authority commit', body => { body.workflow = { ...body.workflow, trusted_source_on_main: false }; },
      /the authority commit a{12} is not contained in main/],
  ];
  for (const [what, breakIt, expected] of cases) {
    const body = JSON.parse(JSON.stringify(receipt));
    breakIt(body);
    body.provenance = { admissible_as_pin: true, inadmissibility_reasons: [] };
    const result = withReceipt(body);
    assert.notEqual(result.code, 0, `${what} must be refused`);
    assert.match(result.stderr, /says provenance\.admissible_as_pin=true, but its own body says otherwise/,
      `${what} gave: ${result.stderr}`);
    assert.match(result.stderr, expected, `${what} gave: ${result.stderr}`);
    assert.equal(result.stdout, '', `${what} emitted a pin`);
  }
});

// THE RULE THAT JUDGES A RECEIPT MAY NOT BE A RULE THE JUDGED PARTY SUPPLIED. On a pull_request event the
// workflow definition and the checked-out code are the candidate's, so a consumer that trusted its own copy
// of the predicate would let a candidate write the rule that judges it. The tool hashes the module it loaded
// the way git hashes a blob and compares that with the blob refs/heads/main holds for the same path.
test('the fetch tool refuses when the predicate it loaded is not the blob main holds', () => {
  const real = blobOf('.github/verifier-receipt/admissibility.mjs');
  const other = 'd'.repeat(40);
  const mismatched = runTool(stage({ zip: receipt, attestations: [envelope()],
    contents: { '.github/verifier-receipt/admissibility.mjs':
      { type: 'file', path: '.github/verifier-receipt/admissibility.mjs', sha: other } } }));
  assert.notEqual(mismatched.code, 0, 'a module that is not main\'s must be refused');
  // BOTH ids are named: the one this process loaded, and the one the protected branch holds.
  assert.ok(mismatched.stderr.includes(real) && mismatched.stderr.includes(other),
    `the refusal must name both blob ids, gave: ${mismatched.stderr}`);
  assert.match(mismatched.stderr, /the rule that judges a receipt may not be a rule the judged party supplied/);
  assert.equal(mismatched.stdout, '', 'a refused module emits no pin');

  // The permission list is checked the same way, for the same reason: a candidate that could rewrite it
  // would be authorising its own skips.
  const skips = runTool(stage({ zip: receipt, attestations: [envelope()],
    contents: { '.github/verifier-receipt/tolerated-skips.json':
      { type: 'file', path: '.github/verifier-receipt/tolerated-skips.json', sha: other } } }));
  assert.match(skips.stderr, /tolerated-skips\.json this tool loaded is blob [0-9a-f]{40}, but refs\/heads\/main holds blob d{40}/);

  // An answer that is not a file blob, and an API that will not answer at all, are refusals rather than
  // assumptions: neither establishes that the rule this tool loaded is the protected one.
  const notAFile = runTool(stage({ zip: receipt, attestations: [envelope()],
    contents: { '.github/verifier-receipt/admissibility.mjs': { type: 'dir', sha: null } } }));
  assert.match(notAFile.stderr, /reports no file blob for \.github\/verifier-receipt\/admissibility\.mjs/);

  const unanswered = runTool(stage({ zip: receipt, attestations: [envelope()],
    contents: { '.github/verifier-receipt/admissibility.mjs': undefined } }));
  assert.match(unanswered.stderr,
    /refs\/heads\/main could not be asked what blob it holds for \.github\/verifier-receipt\/admissibility\.mjs/);
});

test('the fetch tool emits a pin when the run, the receipt and the attestation agree', () => {
  const dir = stage({ zip: receipt, attestations: [envelope()] });
  const result = runTool(dir);
  assert.equal(result.code, 0, `expected success, got: ${result.stderr}`);
  const pin = JSON.parse(result.stdout);
  assert.equal(pin.run_id, '4242');
  assert.equal(pin.workflow_path, WORKFLOW);
  // Read out of the receipt, which is why the cases above can refuse it.
  assert.equal(pin.workflow_ref, 'refs/heads/main');
  assert.equal(pin.workflow_head_sha, HEAD);
  assert.equal(pin.attestation_workflow_ref, 'refs/heads/main');
  assert.equal(pin.artifact_name, 'verifier-receipt');
  assert.equal(pin.artifact_digest, `sha256:${'d'.repeat(64)}`);
  // The receipt digest is computed from the bytes inside the artifact, never taken from the candidate.
  const expected = crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  assert.equal(pin.receipt_digest, `sha256:${expected}`);
  assert.equal(pin.attestation_digest, pin.receipt_digest);
  // The pin states the basis it was admitted on rather than leaving a reader to take it on trust: the rule
  // that admitted it, by the blob id checked against refs/heads/main, and the derivation it came back with.
  assert.equal(pin.admissibility.module, '.github/verifier-receipt/admissibility.mjs');
  assert.equal(pin.admissibility.module_blob, blobOf('.github/verifier-receipt/admissibility.mjs'));
  assert.equal(pin.admissibility.tolerated_skips_blob,
    blobOf('.github/verifier-receipt/tolerated-skips.json'));
  assert.equal(pin.admissibility.protected_ref, 'refs/heads/main');
  assert.deepEqual(pin.admissibility.derived_reasons, []);
  assert.equal(pin.receipt.schema, 2);
  assert.equal(pin.receipt.admissible_as_pin, true);
  assert.equal(pin.receipt.conclusion.verdict, 'success');
  assert.equal(pin.receipt.named_tests.length, 1);
});

test('the fetch tool refuses an attestation that names another workflow, or a ref that is not main', () => {
  const other = envelope({ workflowPath: '.github/workflows/something-else.yml' });
  assert.match(runTool(stage({ zip: receipt, attestations: [other] })).stderr,
    /the attestation names workflow/);

  // A same-repository pull_request run executes the workflow definition from the pull request head, so a
  // signature over a receipt says nothing about which definition made it until the ref is read.
  const fromAPullRequest = envelope({ ref: 'refs/pull/162/merge' });
  const result = runTool(stage({ zip: receipt, attestations: [fromAPullRequest] }));
  assert.notEqual(result.code, 0, 'an attestation from another ref must be refused');
  assert.match(result.stderr, /names workflow ref "refs\/pull\/162\/merge", not refs\/heads\/main/);

  const branch = runTool(stage({ zip: receipt, attestations: [envelope({ ref: 'refs/heads/topic' })] }));
  assert.match(branch.stderr, /names workflow ref "refs\/heads\/topic", not refs\/heads\/main/);

  const silent = runTool(stage({ zip: receipt, attestations: [envelope({ ref: null })] }));
  assert.match(silent.stderr, /names workflow ref null, not refs\/heads\/main/);
});

// THE REAL RECEIPT. Every case above is written here; this one is not. See the fixture's README.md for what
// it is, what three keys were removed from it, and the digests GitHub reported for the artifact it came in.
const REAL_DIR = path.join(import.meta.dirname, 'fixtures', 'receipt-35869844952');
const REAL_TRIMMED_SHA256 = '93595c1e7238434d9df7377fa28d5b98924fce52116d5cd2e613ab8fdb7baad3';

// The API records of run 35869844952, read back with `gh api` on 2026-09-23 and copied here rather than
// invented. The run itself CONCLUDED FAILURE, and the artifact is the one GitHub digested.
const REAL_RUN = { path: WORKFLOW, event: 'workflow_dispatch', head_branch: 'main', status: 'completed',
  conclusion: 'failure', id: 35869844952, head_sha: '01409cc7e4ad5ab9aab2c24a9e3b1f6f45df2a1e', run_attempt: 1 };
const REAL_ARTIFACT = { id: 10754354187, name: 'verifier-receipt', expired: false, size_in_bytes: 61770,
  digest: 'sha256:b6c84e8325aec145cad7b912bbef0a29a560a85b4ed2d96d92668b39127736ff',
  created_at: '2026-09-23T13:56:11Z', workflow_run: { head_sha: '01409cc7e4ad5ab9aab2c24a9e3b1f6f45df2a1e' } };

const realReceipt = () => {
  const bytes = fs.readFileSync(path.join(REAL_DIR, 'receipt.trimmed.json'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), REAL_TRIMMED_SHA256,
    'the trimmed fixture has been edited; re-read its README.md before touching this digest');
  return { bytes, receipt: JSON.parse(bytes.toString('utf8')) };
};
const REAL_ARGS = { runId: String(REAL_RUN.id), repo: 'BAWES-Universe/studenthub-platform' };

test('the real receipt of run 35869844952 is refused as a pin, in the authority\'s own words', () => {
  const { bytes, receipt: real } = realReceipt();
  assert.equal(real.schema, 2);
  assert.equal(real.repository, REAL_ARGS.repo);
  assert.equal(real.workflow.head_sha, REAL_RUN.head_sha);
  assert.equal(real.provenance.admissible_as_pin, false);
  const [reason] = real.provenance.inadmissibility_reasons;

  const result = runTool(stage({
    ...REAL_ARGS,
    // COUNTERFACTUAL IN ONE FIELD, SAID PLAINLY: GitHub reports `conclusion: "failure"` for this run, which
    // the case below asserts is refused on its own. It is flipped here so that the RECEIPT's body is what
    // decides, which is the whole point of the fixture - admissibility is not a restatement of the run's
    // conclusion, and a consumer that only read the run would have nothing to say about a green run whose
    // receipt says it may not be pinned. Every other field is the API's own.
    run: { ...REAL_RUN, conclusion: 'success' },
    artifacts: { artifacts: [REAL_ARTIFACT] },
    zip: bytes.toString('utf8'),
    // None is supplied, and none is needed twice over: GitHub records no attestation over these bytes (the
    // authority's attest job refused it, and `gh api /attestations/sha256:74947a1b...` answers 404), and the
    // refusal below lands before the attestations API is asked at all.
    attestations: [],
  }), REAL_ARGS);

  assert.notEqual(result.code, 0, 'a failure receipt must never be pinned');
  assert.match(result.stderr, /may not be pinned, on \d+ ground\(s\) re-derived from its own body/);
  assert.ok(result.stderr.includes(`"${reason}"`),
    `the refusal must quote the authority's reason, gave: ${result.stderr}`);
  assert.equal(reason, "this receipt's verdict is failure, so there is nothing in it for a manifest to pin");
  // And the receipt's own recorded words are quoted beside the derivation, because they are the authority's.
  assert.match(result.stderr, new RegExp(`it records: "${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  // The derivation also names what this receipt's body supports that its own recorded reason did not reach:
  // 60 failing tests, and 8 skips it counts without naming. Neither is invented here - both are its fields.
  assert.equal(real.suite.not_ok, 60);
  assert.equal(real.suite.skipped, 8);
  assert.match(result.stderr, /the measured suite reports 60 failing test\(s\) out of 3649/);
  assert.match(result.stderr, /records 8 skipped test\(s\) and names 0 of them/);

  // It got that far, which is the other half of what this fixture shows: the identity of a genuine receipt
  // passes every identity check, so the refusal is about admissibility and not about shape.
  for (const notThis of [/schema/, /names repository/, /names workflow/, /workflow\.ref/, /head_sha/,
    /attestation/, /names run/]) {
    assert.doesNotMatch(result.stderr, notThis, `refused on the wrong ground: ${result.stderr}`);
  }
  assert.equal(result.stdout, '', 'a refused receipt emits no pin');
});

// MUTANT A. The real receipt, with ONE field changed: `provenance.admissible_as_pin` flipped to true and the
// reason it recorded removed. Nothing else is touched - the body still records a failure verdict over a red
// suite of 3649 tests with 60 failing. This is the shape of forgery that defeated the producer's own readers
// when they compared the computed boolean with itself; the refusal must name the grounds the BODY says no on.
test('MUTANT A: the real receipt with only its flag flipped is refused, and the refusal names the grounds', () => {
  const { receipt: real } = realReceipt();
  const flipped = JSON.parse(JSON.stringify(real));
  flipped.provenance.admissible_as_pin = true;
  flipped.provenance.inadmissibility_reasons = [];
  // The flip, and nothing else: everything the rule reads still says what the run recorded.
  assert.equal(flipped.conclusion.verdict, 'failure');
  assert.equal(flipped.suite.state, 'red');
  assert.equal(flipped.candidate.authority_identity[0].protected_sha,
    real.candidate.authority_identity[0].protected_sha);

  const result = runTool(stage({ ...REAL_ARGS, run: { ...REAL_RUN, conclusion: 'success' },
    artifacts: { artifacts: [REAL_ARTIFACT] }, zip: JSON.stringify(flipped), attestations: [envelope()] }),
  REAL_ARGS);

  assert.notEqual(result.code, 0, 'a flipped flag must not buy a pin');
  assert.match(result.stderr, /says provenance\.admissible_as_pin=true, but its own body says otherwise on \d+ ground\(s\), re-derived here with \.github\/verifier-receipt\/admissibility\.mjs/);
  assert.match(result.stderr, /"this receipt's verdict is failure, so there is nothing in it for a manifest to pin"/);
  assert.match(result.stderr, /the measured suite reports 60 failing test\(s\) out of 3649/);
  assert.equal(result.stdout, '', 'a refused receipt emits no pin');
});

test('the real run 35869844952, as GitHub reports it, is refused before its receipt is read', () => {
  const { bytes } = realReceipt();
  const result = runTool(stage({ ...REAL_ARGS, run: REAL_RUN,
    artifacts: { artifacts: [REAL_ARTIFACT] }, zip: bytes.toString('utf8') }), REAL_ARGS);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /run 35869844952 concluded failure/);
});

// An in-toto statement as GitHub's attestation service records it, wrapped the way the API returns it.
function envelope({ workflowPath = WORKFLOW, ref = 'refs/heads/main' } = {}) {
  return { bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({
    predicate: { buildDefinition: { externalParameters:
      { workflow: { path: workflowPath, ref, repository: REPO } } } },
  })).toString('base64') } } };
}
