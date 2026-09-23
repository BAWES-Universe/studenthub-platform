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
// The suite reaches for no network and no git history: it runs under actions/checkout at fetch-depth 1.
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
// the state an admissible receipt would carry it.
const SYNTHETIC_GREEN = {
  schema: 2,
  repository: REPO,
  workflow: { path: WORKFLOW, ref: WORKFLOW_REF, workflow_ref: WORKFLOW_REF, head_sha: HEAD,
    head_branch: 'main', event: 'workflow_dispatch' },
  run: { id: '4242', attempt: '1' },
  candidate: { sha: HEAD, tree: TREE },
  provenance: { admissible_as_pin: true, inadmissibility_reasons: [] },
  manifest: { sha256: 'c'.repeat(64), code_revision: { head: HEAD, tree: TREE } },
  suite: { tests: 10, ok: 9, not_ok: 1, skipped: 0, exit: '1' },
  named_tests: [{ term: 'a/term', kind: 'control', name: 'a control', status: 'pass' }],
  named_tests_summary: { named: 1, pass: 1 },
  conclusion: { verdict: 'success', scope: 'named tests' },
};
const receipt = SYNTHETIC_GREEN;

const RUN = { path: WORKFLOW, event: 'workflow_dispatch', head_branch: 'main', status: 'completed',
  conclusion: 'success', id: 4242, head_sha: HEAD, run_attempt: 1 };
const ARTIFACT = { id: 77, name: 'verifier-receipt', expired: false,
  digest: `sha256:${'d'.repeat(64)}`, workflow_run: { head_sha: HEAD } };

// Prepare a directory holding the stub, its answers and optionally a real zip of the receipt. `zip` is either
// an object, which is serialised, or a string, which is written as the receipt's bytes unchanged.
const stage = ({ run = RUN, artifacts = { artifacts: [ARTIFACT] }, zip = null, attestations = [],
  runId = '4242', repo = REPO } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  const answers = {
    [`/repos/${repo}/actions/runs/${runId}`]: run,
    [`/repos/${repo}/actions/runs/${runId}/artifacts`]: artifacts,
  };
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
  const otherCandidate = withReceipt({ ...receipt, candidate: { sha: '1'.repeat(40), tree: TREE } });
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

// ITEM 2. `provenance.admissible_as_pin` is the authority's own answer to "may a manifest pin this?".
test('the fetch tool refuses a receipt that does not say a manifest may pin it', () => {
  const provenance = fields => withReceipt({ ...receipt, provenance: { ...receipt.provenance, ...fields } });

  const absent = withReceipt({ ...receipt, provenance: { inadmissibility_reasons: [] } });
  assert.notEqual(absent.code, 0, 'an absent admissible_as_pin must be refused');
  assert.match(absent.stderr, /carries no provenance\.admissible_as_pin, and an absent field is not permission/);

  const noProvenance = withReceipt({ ...receipt, provenance: undefined });
  assert.match(noProvenance.stderr, /carries no provenance\.admissible_as_pin/);

  const silentlyFalse = provenance({ admissible_as_pin: false, inadmissibility_reasons: [] });
  assert.notEqual(silentlyFalse.code, 0, 'false with no reasons must be refused');
  assert.match(silentlyFalse.stderr,
    /admissible_as_pin=false: and it records no reason, which is not a reason to pin it/);

  const withReasons = provenance({ admissible_as_pin: false,
    inadmissibility_reasons: ['the authority is absent on refs/heads/main', 'its verdict is failure'] });
  assert.match(withReasons.stderr,
    /admissible_as_pin=false: "the authority is absent on refs\/heads\/main"; "its verdict is failure"/);

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
  // The pin states the basis it was admitted on rather than leaving a reader to take it on trust.
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

test('the real receipt of run 35869844952 is refused as a pin, in the authority\'s own words', () => {
  const bytes = fs.readFileSync(path.join(REAL_DIR, 'receipt.trimmed.json'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), REAL_TRIMMED_SHA256,
    'the trimmed fixture has been edited; re-read its README.md before touching this digest');
  const real = JSON.parse(bytes.toString('utf8'));
  assert.equal(real.schema, 2);
  assert.equal(real.provenance.admissible_as_pin, false);
  const [reason] = real.provenance.inadmissibility_reasons;

  const runId = String(real.run.id);
  const result = runTool(stage({
    runId,
    repo: real.repository,
    // What GitHub reports for that run: a completed, successful dispatch of the authority on main. The run
    // is healthy; it is the receipt that says it may not be pinned.
    run: { path: WORKFLOW, event: 'workflow_dispatch', head_branch: 'main', status: 'completed',
      conclusion: 'success', id: Number(runId), head_sha: real.workflow.head_sha, run_attempt: 1 },
    // The artifact's digest and size are the ones GitHub reported for the real `verifier-receipt` artifact
    // of this run (61,770 bytes of zip). Its id is this suite's, because the API record was not kept.
    artifacts: { artifacts: [{ id: 77, name: 'verifier-receipt', expired: false, size_in_bytes: 61770,
      digest: 'sha256:b6c84e8325aec145cad7b912bbef0a29a560a85b4ed2d96d92668b39127736ff',
      workflow_run: { head_sha: real.workflow.head_sha } }] },
    zip: bytes.toString('utf8'),
    // None is supplied, and none is needed: the authority's attest job refused to attest this receipt, and
    // the refusal below lands before the attestations API is asked.
    attestations: [],
  }), { runId, repo: real.repository });

  assert.notEqual(result.code, 0, 'a failure receipt must never be pinned');
  assert.match(result.stderr, /says provenance\.admissible_as_pin=false/);
  assert.ok(result.stderr.includes(`"${reason}"`),
    `the refusal must quote the authority's reason, gave: ${result.stderr}`);
  assert.equal(reason, "this receipt's verdict is failure, so there is nothing in it for a manifest to pin");

  // It got that far, which is the other half of what this fixture shows: the identity of a genuine receipt
  // passes every identity check, so the refusal is about admissibility and not about shape.
  for (const notThis of [/schema/, /names repository/, /names workflow/, /workflow\.ref/, /head_sha/,
    /attestation/, /names run/]) {
    assert.doesNotMatch(result.stderr, notThis, `refused on the wrong ground: ${result.stderr}`);
  }
  assert.equal(result.stdout, '', 'a refused receipt emits no pin');
});

// An in-toto statement as GitHub's attestation service records it, wrapped the way the API returns it.
function envelope({ workflowPath = WORKFLOW, ref = 'refs/heads/main' } = {}) {
  return { bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({
    predicate: { buildDefinition: { externalParameters:
      { workflow: { path: workflowPath, ref, repository: REPO } } } },
  })).toString('base64') } } };
}
