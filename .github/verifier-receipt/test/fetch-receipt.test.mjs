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
//   * the predicate module is FETCHED from refs/heads/main over the contents API, verified against the blob
//     id the API reports for it, and imported from a `data:` URL built out of those verified bytes - so the
//     module that decides is never a file of the checkout, and never a file at all. On a pull_request event
//     the checked-out code is the candidate's, so a consumer that imported its own copy would let a candidate
//     supply the rule that judges it, and it would do so BEFORE the check meant to catch that ran, because
//     ESM evaluates a dependency's top level at load;
//   * there is no filesystem path anywhere between the bytes that were hashed and the bytes that decide, so
//     the time-of-check-to-time-of-use gap is closed by construction rather than made unlikely. The two ITEM 1
//     cases below are the evidence: nothing is written into TMPDIR at all, and an adversary that owns TMPDIR
//     and overwrites every file appearing in it - the review's own attack, with the guesswork removed - gets
//     no pin;
//   * the pin records BOTH binaries this fetch rested on - the `gh` it read the API through and the
//     `python3` it opened the archive with - because those, and not GitHub, are where every fact in a pin
//     comes from. An earlier round named only the first and the file claimed there was only one channel; the
//     ITEM 1(B) cases are the second one, closed: a `python3` resolved once and refuseable against an
//     expectation, and an interpreter given `-P` and a working directory that is not the candidate's, so a
//     `zipfile.py` committed in the tree being judged is no longer the thing that decides what the receipt
//     said;
//   * and a run that is not the protected branch's emits no pin at all, whatever it found. That is a GUARD
//     RAIL and is labelled one: it stops an accident, and a run that sets GITHUB_REF and GITHUB_EVENT_NAME
//     itself gets past it. What binds is `verify-claim.yml`, dispatched from protected main.
//
// The suite reaches for no network and no git history: it runs under actions/checkout at fetch-depth 1. The
// blob ids and contents it serves are computed from this repository's own files rather than pinned as
// constants, so the rule and its permission list can be edited without a stale expectation silently passing
// here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
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

// THE PROTECTED BRANCH'S ANSWER FOR THE RULE ITSELF. The consumer no longer hashes a module it loaded off
// disk: it FETCHES the rule and its permission list from refs/heads/main over the contents API, requires the
// answer to be base64 with the decoded bytes hashing to the `sha` the API reports, and imports those bytes
// from a `data:` URL. So the healthy answer staged here carries CONTENT as well as a sha, both
// computed from the very files this repository holds - an edit to the rule changes them here too rather than
// leaving a stale constant behind, and a case that wants the fetch to disagree edits one of the two.
const gitBlobId = bytes => crypto.createHash('sha1')
  .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes])).digest('hex');
const RULE_FILES = {
  '.github/verifier-receipt/admissibility.mjs': path.join(import.meta.dirname, '..', 'admissibility.mjs'),
  '.github/verifier-receipt/tolerated-skips.json': path.join(import.meta.dirname, '..', 'tolerated-skips.json'),
};
const bytesOf = repoPath => fs.readFileSync(RULE_FILES[repoPath]);
const blobOf = repoPath => gitBlobId(bytesOf(repoPath));
const contentsAnswer = repoPath => ({ type: 'file', path: repoPath, sha: blobOf(repoPath),
  encoding: 'base64', content: bytesOf(repoPath).toString('base64'), size: bytesOf(repoPath).length });

// Prepare a directory holding the stub, its answers and optionally a real zip of the receipt. `zip` is either
// an object, which is serialised, or a string, which is written as the receipt's bytes unchanged.
//
// THE ARCHIVE'S DIGEST IS THE ARCHIVE'S. The tool now hashes the downloaded zip and requires it to equal
// `artifact.digest`, so a world staged with a zip gets the digest of the zip THIS FUNCTION BUILT written into
// the artifact record, replacing whatever the caller's artifact fixture carried. `keepDigest: true` opts out,
// which is what the case for a substituted archive needs.
const stage = ({ run = RUN, artifacts = { artifacts: [ARTIFACT] }, zip = null, attestations = [],
  runId = '4242', repo = REPO, contents = {}, keepDigest = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  const staged = JSON.parse(JSON.stringify(artifacts));
  if (zip) {
    const receiptPath = path.join(dir, 'receipt.json');
    fs.writeFileSync(receiptPath, typeof zip === 'string' ? zip : JSON.stringify(zip));
    execFileSync('python3', ['-c', [
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1], "w") as archive:',
      '    archive.write(sys.argv[2], "receipt.json")',
    ].join('\n'), path.join(dir, 'zip.bin'), receiptPath]);
    if (!keepDigest) {
      const digest = `sha256:${crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(dir, 'zip.bin'))).digest('hex')}`;
      for (const record of staged.artifacts ?? []) {
        if (record.name === 'verifier-receipt' && record.digest) record.digest = digest;
      }
    }
  }
  const answers = {
    [`/repos/${repo}/actions/runs/${runId}`]: run,
    [`/repos/${repo}/actions/runs/${runId}/artifacts`]: staged,
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
  return dir;
};

// THE RUN THE TOOL IS PART OF. The tool refuses to emit a pin unless its OWN run is on the protected branch,
// so every case that expects a pin has to say it is one; a case that wants the refusal overrides `env`.
const PROTECTED_RUN = { GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch' };
// `cwd` is a parameter because the WORKING DIRECTORY is an attack surface of its own: `verify-claim.yml` does
// `cd candidate` before invoking this tool, so in production the inherited cwd is the tree being judged. The
// default here is the staging directory, which is nobody's checkout; the ITEM 1 cases below pass a candidate
// tree deliberately.
const runTool = (dir, { runId = '4242', repo = REPO, env = PROTECTED_RUN, cwd = dir } = {}) => {
  try {
    return { code: 0, stdout: execFileSync('node', [TOOL, '--run', runId, '--repo', repo],
      { encoding: 'utf8', cwd, env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` } }),
    stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '' };
  }
};

// WHAT PATH REALLY RESOLVES, WALKED THE WAY THE TOOL WALKS IT. The pin records an ABSOLUTE path, and a test
// that hard-coded `/usr/bin/python3` would be asserting this machine's layout rather than the tool's
// behaviour. This is `resolveOnPath` from the tool, kept here so the expectation is computed and not folklore.
const onPath = name => {
  for (const entry of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (entry === '') continue;
    const candidate = path.join(entry, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) { /* not this directory's; keep walking */ }
  }
  return null;
};
const REAL_PYTHON = onPath('python3');
const REAL_PYTHON_VERSION = REAL_PYTHON
  && String(execFileSync(REAL_PYTHON, ['--version'], { encoding: 'utf8' })).split('\n')[0].trim();

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

// THE MODULE VERIFICATION MUST VERIFY THE MODULE THAT DECIDES.
//
// The previous round imported `./admissibility.mjs` at the top of the tool and checked its blob id 160 lines
// later. ESM evaluates a dependency's top level at LOAD, so the candidate's module ran first, in the same
// process, and eight lines of it - patching `fs.readFileSync` to hand back the protected bytes for its own
// path - made that check report exactly what it wanted. The tool now FETCHES the rule from refs/heads/main
// over the contents API and imports it from a temp directory outside the tree, so the module that decides is
// bytes the API served and never a file of the checkout. The cases below are the ways that fetch can fail.
const MODULE = '.github/verifier-receipt/admissibility.mjs';
const SKIPS = '.github/verifier-receipt/tolerated-skips.json';
const healthy = repoPath => JSON.parse(JSON.stringify(contentsAnswer(repoPath)));

test('the fetch tool refuses a rule whose fetched bytes disagree with the sha the API reports', () => {
  // The decisive case: the API serves CONTENT and a SHA, and this world's content is not what its sha names.
  // Nothing here is the checkout's - the tool is deciding from what it was served, so what it was served has
  // to hash to what it was told, or the rule's content and its identity disagree and neither is usable.
  const tampered = healthy(MODULE);
  tampered.content = Buffer.from('export const deriveAdmissibility = () => ({ admissible: true, reasons: [] });\n')
    .toString('base64');
  const result = runTool(stage({ zip: receipt, attestations: [envelope()],
    contents: { [MODULE]: tampered } }));
  assert.notEqual(result.code, 0, 'bytes that do not hash to their reported blob must be refused');
  // BOTH ids are named: the blob the served bytes hash to, and the blob the API reports for that path.
  assert.match(result.stderr,
    /the \.github\/verifier-receipt\/admissibility\.mjs bytes refs\/heads\/main served are \d+ bytes hashing to blob [0-9a-f]{40}, but the API reports blob [0-9a-f]{40}/);
  assert.ok(result.stderr.includes(blobOf(MODULE)), `the refusal must name main's blob: ${result.stderr}`);
  assert.match(result.stderr, /the content and the identity of the rule that decides disagree/);
  assert.equal(result.stdout, '', 'a refused rule emits no pin');

  // The permission list travels the same way and is checked the same way: it is permission, so it must come
  // from the branch that grants it, and a candidate that could rewrite it would authorise its own skips.
  const forgedSkips = healthy(SKIPS);
  forgedSkips.content = Buffer.from(JSON.stringify({ authorized: [
    { test: 'anything at all', reason: 'because the candidate says so', authorized_by: 'the candidate' }] }))
    .toString('base64');
  const skips = runTool(stage({ zip: receipt, attestations: [envelope()],
    contents: { [SKIPS]: forgedSkips } }));
  assert.notEqual(skips.code, 0, 'a permission list that is not main\'s must be refused');
  assert.match(skips.stderr,
    /the \.github\/verifier-receipt\/tolerated-skips\.json bytes refs\/heads\/main served are \d+ bytes hashing to blob [0-9a-f]{40}/);
  assert.equal(skips.stdout, '', 'a refused permission list emits no pin');
});

test('the fetch tool refuses a fetch the API will not serve, or will not serve as base64', () => {
  // An API that answers nothing at all. There is then no protected copy of the rule, and a tool that decided
  // anyway would be deciding with the checkout's - which on a pull_request event is the candidate's.
  const unanswered = runTool(stage({ zip: receipt, attestations: [envelope()],
    contents: { [MODULE]: undefined } }));
  assert.notEqual(unanswered.code, 0, 'an unanswered fetch must be refused');
  assert.match(unanswered.stderr,
    /refs\/heads\/main would not serve \.github\/verifier-receipt\/admissibility\.mjs/);
  assert.match(unanswered.stderr, /will not decide with an unprotected one/);
  assert.equal(unanswered.stdout, '', 'an unanswered fetch emits no pin');

  const skipsUnanswered = runTool(stage({ zip: receipt, attestations: [envelope()],
    contents: { [SKIPS]: undefined } }));
  assert.match(skipsUnanswered.stderr,
    /refs\/heads\/main would not serve \.github\/verifier-receipt\/tolerated-skips\.json/);

  // An answer that is not a file blob establishes nothing either.
  const notAFile = runTool(stage({ zip: receipt, attestations: [envelope()],
    contents: { [MODULE]: { type: 'dir', sha: null } } }));
  assert.match(notAFile.stderr, /reports no file blob for \.github\/verifier-receipt\/admissibility\.mjs/);

  // GitHub answers `"encoding": "none"` with an empty `content` for a file it will not inline. Decoding that
  // writes a zero-byte module, which imports happily and decides nothing, so the shape is refused.
  const notInlined = healthy(MODULE);
  notInlined.encoding = 'none';
  notInlined.content = '';
  const none = runTool(stage({ zip: receipt, attestations: [envelope()], contents: { [MODULE]: notInlined } }));
  assert.notEqual(none.code, 0, 'a non-base64 answer must be refused');
  assert.match(none.stderr,
    /would not inline \.github\/verifier-receipt\/admissibility\.mjs \(encoding "none", not base64\)/);
  assert.equal(none.stdout, '', 'a non-base64 answer emits no pin');
});

test('the fetch tool refuses a checkout whose rule disagrees with the rule that decided, naming both', () => {
  // The fetched bytes decide; the checkout is compared and never used. A tree that disagrees with the rule
  // judging it is refused even though the decision was made with the protected bytes - and the refusal names
  // both blob ids, so a reader can see which two objects were not the same.
  const main = healthy(MODULE);
  const other = Buffer.from('// a rule that is not this repository\'s\n');
  main.content = other.toString('base64');
  main.sha = gitBlobId(other);
  const result = runTool(stage({ zip: receipt, attestations: [envelope()], contents: { [MODULE]: main } }));
  assert.notEqual(result.code, 0, 'a checkout that disagrees with main must be refused');
  assert.ok(result.stderr.includes(blobOf(MODULE)) && result.stderr.includes(main.sha),
    `the refusal must name both blob ids, gave: ${result.stderr}`);
  assert.match(result.stderr, /the rule that judges a receipt may not be a rule the judged party supplied/);
  assert.match(result.stderr, /it decided with the protected bytes and not with these/);
  assert.equal(result.stdout, '', 'a disagreeing checkout emits no pin');
});

// A CANDIDATE'S OWN RUN MAY NOT PRODUCE A PIN, AS A GUARD RAIL. On a pull_request event this tool, the rule
// it applies and every file it reads are the candidate's, so no arrangement of them is evidence. These cases
// assert the rail: each of these runs gets a labelled report and no pin. What the rail does NOT stop - a run
// that sets the two variables itself - is measured in the ITEM 3 case further down, and what actually binds
// is `verify-claim.yml` running from protected main. The import-time patch is not stopped by this at all; it
// is stopped by the rule being fetched rather than imported from the tree.
test('the fetch tool emits no pin on a run that is not the protected branch\'s, and says why', () => {
  for (const [what, env] of [
    ['a pull request', { GITHUB_REF: 'refs/pull/167/merge', GITHUB_EVENT_NAME: 'pull_request' }],
    ['another branch', { GITHUB_REF: 'refs/heads/topic', GITHUB_EVENT_NAME: 'push' }],
    ['a tag', { GITHUB_REF: 'refs/tags/v1', GITHUB_EVENT_NAME: 'push' }],
    ['an event that is not a push or a dispatch', { GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule' }],
    ['no run at all', { GITHUB_REF: '', GITHUB_EVENT_NAME: '' }],
  ]) {
    const result = runTool(stage({ zip: receipt, attestations: [envelope()] }), { env });
    assert.notEqual(result.code, 0, `${what} must emit no pin`);
    assert.equal(result.stdout, '', `${what} emitted something on the pin channel: ${result.stdout}`);
    assert.match(result.stderr, /REFUSING TO PIN/, `${what} gave: ${result.stderr}`);
    assert.match(result.stderr, /a pin may be emitted only by a run that is itself on the protected branch/,
      `${what} gave: ${result.stderr}`);
    assert.match(result.stderr, /this tool, the rule it applies and every file it reads are the candidate's/);
    // It may still REPORT, clearly labelled, and nothing it reports is shaped like a pin.
    assert.match(result.stderr, /ADVISORY - what this run found, which is a report and not evidence/);
    assert.match(result.stderr, /ADVISORY - no pin was emitted/);
  }

  // A world in which everything else is healthy: the refusal is the ground, not a defect of the evidence.
  const wouldHavePinned = runTool(stage({ zip: receipt, attestations: [envelope()] }));
  assert.equal(wouldHavePinned.code, 0, `expected success on main, got: ${wouldHavePinned.stderr}`);

  // And no `--out` file is written on such a run, so nothing downstream can pick one up off the filesystem.
  const dir = stage({ zip: receipt, attestations: [envelope()] });
  const outPath = path.join(dir, 'pin.json');
  const spawned = (() => {
    try {
      execFileSync('node', [TOOL, '--run', '4242', '--repo', REPO, '--out', outPath], { encoding: 'utf8',
        env: { ...process.env, GITHUB_REF: 'refs/pull/167/merge', GITHUB_EVENT_NAME: 'pull_request',
          PATH: `${dir}:${process.env.PATH}` } });
      return 0;
    } catch (error) {
      return error.status ?? 1;
    }
  })();
  assert.notEqual(spawned, 0, 'a pull request run must exit non-zero');
  assert.equal(fs.existsSync(outPath), false, 'a pull request run must write no pin file');
});

// THE CONTAINER IS THE ONE GITHUB SERVED. `artifact.digest` is computed by GitHub over the ZIP it stored, so
// the downloaded archive must hash to it. This is the check the header used to CLAIM and the code did not
// perform - the old sentence said the receipt's hash must equal the artifact's digest, which could not hold:
// the digest is over the zip and the hash is over `receipt.json` inside it.
test('the fetch tool refuses an archive whose bytes are not the ones GitHub digested', () => {
  const substituted = runTool(stage({ zip: receipt, attestations: [envelope()], keepDigest: true }));
  assert.notEqual(substituted.code, 0, 'an archive that is not the digested one must be refused');
  assert.match(substituted.stderr,
    /the verifier-receipt archive downloaded for run 4242 is \d+ bytes hashing to sha256:[0-9a-f]{64}, but GitHub reports sha256:d{64} for artifact 77/);
  assert.match(substituted.stderr, /these are not the bytes GitHub served/);
  assert.equal(substituted.stdout, '', 'a substituted archive emits no pin');

  // And the two quantities stay distinct: the receipt's own digest is the ATTESTATION's subject and is never
  // required to equal the artifact's. A healthy world has them different, and is accepted.
  const dir = stage({ zip: receipt, attestations: [envelope()] });
  const ok = runTool(dir);
  assert.equal(ok.code, 0, `expected success, got: ${ok.stderr}`);
  const pin = JSON.parse(ok.stdout);
  assert.notEqual(pin.receipt_digest, pin.artifact_digest,
    'the receipt hash and the artifact digest are hashes of different objects');
  assert.equal(pin.artifact_digest, `sha256:${crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(dir, 'zip.bin'))).digest('hex')}`);
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
  // The digest of the archive the world served, which the tool hashed and required to match before opening it.
  assert.equal(pin.artifact_digest, `sha256:${crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(dir, 'zip.bin'))).digest('hex')}`);
  // The receipt digest is computed from the bytes inside the artifact, never taken from the candidate.
  const expected = crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  assert.equal(pin.receipt_digest, `sha256:${expected}`);
  assert.equal(pin.attestation_digest, pin.receipt_digest);
  // The pin states the basis it was admitted on rather than leaving a reader to take it on trust: the rule
  // that admitted it, by the blob id of THE BYTES THAT DECIDED - fetched from refs/heads/main and verified
  // against the sha the API reported - and the derivation it came back with. In a healthy world those bytes
  // are also what this checkout holds, which is why the expectation can be computed from the file here.
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

// ITEM 1. THE TIME-OF-CHECK-TO-TIME-OF-USE GAP, CLOSED BY CONSTRUCTION AND ATTACKED TO SHOW IT.
//
// The round before this one hashed the fetched rule IN MEMORY, wrote it to `mkdtemp(os.tmpdir() + ...)`, and
// imported THAT PATH - and did the same with `tolerated-skips.json`, the verified zip and the extracted
// receipt. `os.tmpdir()` is `TMPDIR`, an environment variable. A review set it, watched the directory for the
// file to appear, replaced it between the write and the import, and got a pin over a red body with
// `derived_reasons: []` naming main's real blob id as the rule that admitted it. The defence written beside
// that code argued the mkdtemp NAME could not be predicted, which is the wrong property: the attack does not
// predict the name, it watches for it.
//
// There is now no name to watch. The rule is imported from a `data:` URL built out of the verified bytes, the
// permission list is handed to it as bytes, and the archive goes to python3 on stdin with the receipt coming
// back on stdout. The two cases below are the two halves of that claim: nothing is written, and an adversary
// that would have won against the old shape does not win against this one.
const attackerTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'attacker-tmpdir-'));

test('ITEM 1: the tool writes NOTHING into TMPDIR, so there is no file for an attacker to swap', () => {
  const dir = stage({ zip: receipt, attestations: [envelope()] });
  const tmp = attackerTmp();
  const result = runTool(dir, { env: { ...PROTECTED_RUN, TMPDIR: tmp } });
  assert.equal(result.code, 0, `expected success, got: ${result.stderr}`);

  // THE EVIDENCE, AND IT IS AN OBSERVATION RATHER THAN AN ARGUMENT: the directory the tool would have used is
  // empty afterwards. Not "held briefly", not "named unpredictably" - never written to at all. A gap needs
  // two moments and a shared object between them, and there is no object.
  assert.deepEqual(fs.readdirSync(tmp), [],
    `the tool left files in TMPDIR: ${fs.readdirSync(tmp).join(', ')}`);

  // And the pin it emitted is the honest one, decided with main's own bytes.
  const pin = JSON.parse(result.stdout);
  assert.equal(pin.admissibility.module_blob, blobOf(MODULE));
  assert.deepEqual(pin.admissibility.derived_reasons, []);
});

test('ITEM 1: an adversary holding TMPDIR and replacing every file that appears still gets no pin of its own',
  () => {
    // THE ATTACK, RUN. A process the test controls owns `TMPDIR` and, for as long as the tool runs, walks it
    // in a tight loop replacing EVERY file it finds - whatever its name, however it was created - with a
    // module that admits anything and a permission list that authorizes anything. This is the review's attack
    // with the guesswork removed: it does not have to predict the mkdtemp name, and it does not have to win a
    // race against one write, because it overwrites continuously for the whole life of the process.
    //
    // THE ARENA IS LAID OUT SO THAT NOTHING HAS TO BE CLEANED UP WHILE THE ATTACKER IS RUNNING. `arena/tool`
    // is what the tool gets as TMPDIR and `arena/bait` holds this test's liveness probe; the attacker walks
    // the arena, so it owns both. Removing the bait mid-attack would be this test racing its own adversary.
    const dir = stage({ zip: receipt, attestations: [envelope()] });
    const arena = attackerTmp();
    const tmp = path.join(arena, 'tool');
    fs.mkdirSync(tmp);
    const watcher = path.join(dir, 'attacker.cjs');
    fs.writeFileSync(watcher, `
    const fs = require('node:fs');
    const path = require('node:path');
    const PERMISSIVE_RULE = 'export const deriveAdmissibility = () => ({ admissible: true, reasons: [] });\\n';
    const PERMISSIVE_LIST = JSON.stringify({ authorized: [{ test: 'anything at all',
      reason: 'the attacker says so', authorized_by: 'the attacker' }] });
    const until = Date.now() + 20000;
    const walk = where => {
      for (const entry of fs.readdirSync(where, { withFileTypes: true })) {
        const full = path.join(where, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        try {
          fs.writeFileSync(full, entry.name.endsWith('.json') ? PERMISSIVE_LIST : PERMISSIVE_RULE);
        } catch (error) { /* it vanished under us; keep going */ }
      }
    };
    while (Date.now() < until) {
      try { walk(process.argv[2]); } catch (error) { /* the directory may not exist yet */ }
    }
  `);
    const attacker = spawn(process.execPath, [watcher, arena], { stdio: 'ignore', detached: true });
    try {
      // THE ATTACKER IS LIVE, ASSERTED RATHER THAN HOPED FOR. Without this, a test that spawned a watcher
      // which crashed on its first line would pass for the wrong reason and report an attack that never ran.
      // A file of this test's own, named exactly what the tool's used to be, is overwritten within seconds.
      const bait = path.join(arena, 'bait', 'admissibility.mjs');
      fs.mkdirSync(path.dirname(bait), { recursive: true });
      fs.writeFileSync(bait, '// the honest rule, as the tool would have written it\n');
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline
        && !fs.readFileSync(bait, 'utf8').includes('admissible: true')) { /* let it work */ }
      assert.match(fs.readFileSync(bait, 'utf8'), /admissible: true/,
        'the attacker did not overwrite a file placed where the tool\'s would have gone, so the case below '
        + 'would prove nothing: fix the watcher rather than the assertion');

      // The body the attacker wants admitted: RED, with the authority absent on main. Its own recorded flag
      // says true, so the only thing standing between it and a pin is the rule that decides.
      const red = JSON.parse(JSON.stringify(receipt));
      red.conclusion = { ...red.conclusion, verdict: 'success', suite_state: 'red' };
      red.suite = { ...red.suite, state: 'red', not_ok: 2, ok: 8, exit: '1',
        failing_tests: ['a test the attacker needed to pass', 'another'] };
      red.candidate = { ...red.candidate,
        authority_identity: [{ path: '.github/verifier-receipt', protected_sha: null, change: 'none' }] };
      red.provenance = { admissible_as_pin: true, inadmissibility_reasons: [] };

      const attacked = stage({ zip: red, attestations: [envelope()] });
      const result = runTool(attacked, { env: { ...PROTECTED_RUN, TMPDIR: tmp } });

      assert.notEqual(result.code, 0, 'the attacked run must emit no pin');
      assert.equal(result.stdout, '', `a pin came out of the attacked run: ${result.stdout}`);
      // Refused on the grounds the BODY says no on - which is only possible if main's rule decided, not the
      // attacker's. The attacker's rule returns `{ admissible: true, reasons: [] }` and would have said
      // nothing at all.
      assert.match(result.stderr, /says provenance\.admissible_as_pin=true, but its own body says otherwise/);
      assert.match(result.stderr, /the measured suite reports 2 failing test\(s\) out of 10/);
      assert.match(result.stderr, /the receipt authority is absent on main/);
      assert.match(result.stderr, /the runner that measured this suite exited "1", not "0"/);

      // And the honest world, run under the same adversary, still produces the honest pin - so the attack is
      // not merely failing to help, it is failing to reach anything.
      const honest = runTool(dir, { env: { ...PROTECTED_RUN, TMPDIR: tmp } });
      assert.equal(honest.code, 0, `expected success under attack, got: ${honest.stderr}`);
      const pin = JSON.parse(honest.stdout);
      assert.equal(pin.admissibility.module_blob, blobOf(MODULE));
      assert.equal(pin.admissibility.tolerated_skips_blob, blobOf(SKIPS));
      assert.deepEqual(pin.admissibility.derived_reasons, []);
      // The TMPDIR the tool was handed, under an adversary that owned it throughout, is still empty: there
      // was never a file there for the attack to reach.
      assert.deepEqual(fs.readdirSync(tmp), [],
        'the tool still wrote nothing the attacker could have held');
    } finally {
      try { process.kill(-attacker.pid); } catch (error) { attacker.kill('SIGKILL'); }
    }
  });

// ITEM 1(B). THE SECOND CHANNEL, WHICH THE ROUND ABOVE LEFT OPEN AND THE FILE SAID DID NOT EXIST.
//
// The header used to say "Every fact above arrives through one channel: `gh api`, run as a subprocess". It
// was false while it was written. `python3` opens the archive, and the RECEIPT BODY - what every check below
// reads - comes back out of it. A review found two ways in, and both are exercised here:
//
//   * the binary was a BARE NAME resolved through PATH at call time, so a dishonest `python3` ahead of the
//     real one produced a pin saying `{"verdict":"success","suite_state":"green"}` over the digest of a red
//     archive, with nothing in the pin naming the binary that had said so;
//   * and it needed no control of PATH at all: `verify-claim.yml` does `cd candidate`, the subprocess
//     inherited that directory, and `python3 -c` puts the working directory FIRST on `sys.path` - so a
//     `zipfile.py` COMMITTED IN THE CANDIDATE'S OWN REPOSITORY was the zip reader. Out came a pin over a body
//     that had decided nothing, recording main's real blob id as the rule that admitted it.
//
// The fix is the three things the review asked for, and each has a case: `-P`, an explicit `cwd` that is not
// the candidate's, and a `python3` resolved, version-read, recorded and refuseable on the same terms as `gh`.

// A stand-in for `python3` staged on PATH ahead of the real one, so a case can make the interpreter behave in
// a way no real one would. `behaviour` is JavaScript run with `argv` and `stdin` in scope; whatever it writes
// with `out(...)` is this interpreter's stdout.
const stagePython = (dir, behaviour, { version = 'Python 3.99.0' } = {}) => {
  fs.writeFileSync(path.join(dir, 'python-stub.cjs'), `
    const fs = require('node:fs');
    const argv = process.argv.slice(2);
    if (argv.includes('--version')) { process.stdout.write(${JSON.stringify(`${version}\n`)}); process.exit(0); }
    const stdin = fs.readFileSync(0);
    const out = buffer => process.stdout.write(buffer);
    ${behaviour}
  `);
  fs.writeFileSync(path.join(dir, 'python3'),
    `#!/bin/sh\nexec ${process.execPath} "${path.join(dir, 'python-stub.cjs')}" "$@"\n`);
  fs.chmodSync(path.join(dir, 'python3'), 0o755);
  return dir;
};

test('ITEM 1(B): the pin records the python3 the receipt body was read through, beside the gh', () => {
  const dir = stage({ zip: receipt, attestations: [envelope()] });
  const result = runTool(dir);
  assert.equal(result.code, 0, `expected success, got: ${result.stderr}`);
  const pin = JSON.parse(result.stdout);
  // The ABSOLUTE path PATH resolved, not the name `python3` - which is what the call site used to carry.
  assert.equal(pin.fetched_with.python, REAL_PYTHON);
  assert.equal(pin.fetched_with.python_version, REAL_PYTHON_VERSION);
  assert.equal(pin.fetched_with.expected_python, null);
  assert.equal(pin.fetched_with.expected_python_version, null);
  // And what that interpreter said its zip reader was. It is the interpreter's own answer, recorded as such;
  // the isolation is what makes it trustworthy, not this field. Under `-P` it is the standard library's.
  assert.match(pin.fetched_with.zip_reader, /zipfile/);
  assert.doesNotMatch(pin.fetched_with.zip_reader, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // The advisory report names both binaries too, since it is the same statement in the channel a run that may
  // not pin gets.
  const advisory = runTool(dir, { env: { GITHUB_REF: 'refs/pull/1/merge', GITHUB_EVENT_NAME: 'pull_request' } });
  assert.match(advisory.stderr, new RegExp(`opened with ${REAL_PYTHON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('ITEM 1(B): a run that says which python3 it expects is refused when PATH resolves another', () => {
  const dir = stage({ zip: receipt, attestations: [envelope()] });

  // The expectation is the RUN's to state, so stating the right one changes nothing.
  const agreed = runTool(dir, { env: { ...PROTECTED_RUN, VERIFIER_EXPECTED_PYTHON: REAL_PYTHON } });
  assert.equal(agreed.code, 0, `expected success, got: ${agreed.stderr}`);
  assert.equal(JSON.parse(agreed.stdout).fetched_with.expected_python, REAL_PYTHON);

  const wrongPath = runTool(dir, { env: { ...PROTECTED_RUN, VERIFIER_EXPECTED_PYTHON: '/opt/elsewhere/python3' } });
  assert.notEqual(wrongPath.code, 0, 'a python3 that is not the expected one must be refused');
  assert.match(wrongPath.stderr,
    /this run expects its `python3` at "\/opt\/elsewhere\/python3" \(VERIFIER_EXPECTED_PYTHON\)/);
  assert.match(wrongPath.stderr, /is not the one this run says it trusts/);
  assert.equal(wrongPath.stdout, '', 'an unexpected python3 emits no pin');

  const wrongVersion = runTool(dir,
    { env: { ...PROTECTED_RUN, VERIFIER_EXPECTED_PYTHON_VERSION: 'Python 9.9.9' } });
  assert.notEqual(wrongVersion.code, 0, 'a python3 of the wrong version must be refused');
  assert.match(wrongVersion.stderr, /expects python3 "Python 9\.9\.9" \(VERIFIER_EXPECTED_PYTHON_VERSION\)/);
  assert.match(wrongVersion.stderr, new RegExp(`reports ${JSON.stringify(REAL_PYTHON_VERSION)}`));
  assert.equal(wrongVersion.stdout, '', 'an unexpected python3 version emits no pin');

  // AND THE ATTACK THE EXPECTATION IS FOR, RUN: the review's dishonest `python3` staged ahead of the real
  // one, everything else honest. The archive is RED; the interpreter hands back a GREEN body and an
  // innocent-looking report, and every digest above still checks out because the digests are over the
  // ARCHIVE and this substitutes what comes out of it.
  const red = JSON.parse(JSON.stringify(receipt));
  red.conclusion = { ...red.conclusion, suite_state: 'red' };
  red.suite = { ...red.suite, state: 'red', ok: 8, not_ok: 2, exit: '1', failing_tests: ['one', 'another'] };
  const dishonest = stagePython(stage({ zip: red, attestations: [envelope()] }), `
    out(Buffer.from(JSON.stringify({ cwd: '/tmp', zip_reader: '/usr/lib/python3/zipfile.py',
      working_directory_on_path: [] }) + '\\n'));
    out(Buffer.from(${JSON.stringify(JSON.stringify(receipt))}));
  `);
  const caught = runTool(dishonest,
    { env: { ...PROTECTED_RUN, VERIFIER_EXPECTED_PYTHON: REAL_PYTHON } });
  assert.notEqual(caught.code, 0, 'a substituted python3 must be refused where the run named the real one');
  assert.match(caught.stderr, /PATH resolved/);
  assert.equal(caught.stdout, '', 'a substituted python3 emits no pin');

  // WITHOUT an expectation it is not refused - it is RECORDED, and that is the honest limit of this defence,
  // asserted here rather than left implied. It is the same standing `gh` has: this file cannot make a channel
  // trustworthy, it can stop assuming one. What changed is that the pin the review got with nothing in it
  // naming the binary now names the binary, so a reader sees the trust root instead of assuming python3.
  const unstated = runTool(dishonest);
  assert.notEqual(unstated.stdout, '', `expected a pin, got: ${unstated.stderr}`);
  const bought = JSON.parse(unstated.stdout);
  assert.equal(bought.receipt.conclusion.suite_state, 'green', 'the substituted body is what was pinned');
  assert.equal(bought.fetched_with.python, path.join(dishonest, 'python3'));
  assert.equal(bought.fetched_with.python_version, 'Python 3.99.0');
  assert.notEqual(bought.fetched_with.python, REAL_PYTHON);
});

test('ITEM 1(B): a python3 this run cannot resolve, or that will not say what it is, is a refusal', () => {
  // NO `python3` ON PATH, BUT `gh` STILL THERE - otherwise the refusal would be about `gh` and this case
  // would prove nothing. The stub's shim is rewritten to an absolute interpreter so the bare PATH still runs.
  const dir = stage({ zip: receipt, attestations: [envelope()] });
  fs.writeFileSync(path.join(dir, 'gh'),
    `#!/bin/sh\nexec ${process.execPath} "${path.join(dir, 'gh.cjs')}" "$@"\n`);
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  const spawned = env => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [TOOL, '--run', '4242', '--repo', REPO],
        { encoding: 'utf8', cwd: dir, env }), stderr: '' };
    } catch (error) {
      return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? '',
        stderr: error.stderr?.toString() ?? '' };
    }
  };
  const unresolvable = spawned({ ...PROTECTED_RUN, PATH: dir });
  assert.notEqual(unresolvable.code, 0, 'a run with no python3 on PATH must be refused');
  assert.match(unresolvable.stderr, /no executable named `python3` is on this run's PATH/);
  assert.match(unresolvable.stderr, /has no trust root to rest a pin on/);
  assert.equal(unresolvable.stdout, '', 'a run with no python3 emits no pin');

  // A `python3` that will not state its version cannot be identified in the pin that would rest on it.
  const mute = stagePython(stage({ zip: receipt, attestations: [envelope()] }),
    'out(stdin);', { version: '' });
  const silent = runTool(mute);
  assert.notEqual(silent.code, 0, 'a python3 that will not identify itself must be refused');
  assert.match(silent.stderr, /would not state its version/);
  assert.match(silent.stderr, /cannot be identified in the pin that rests on it/);
  assert.equal(silent.stdout, '', 'an unidentifiable python3 emits no pin');
});

test('ITEM 1(B): a candidate tree holding a module that shadows a stdlib name decides nothing', () => {
  // THE WORKING DIRECTORY IS THE CANDIDATE'S, exactly as `verify-claim.yml` leaves it after `cd candidate`.
  // The tree holds one file: a `zipfile.py` that answers with whatever body its author wants.
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-tree-'));
  const green = JSON.stringify(receipt);
  fs.writeFileSync(path.join(candidate, 'zipfile.py'), [
    'import json, io',
    `GREEN = ${JSON.stringify(green)}`,
    'class ZipFile:',
    '    def __init__(self, *a, **k):',
    '        try: a[0].read()',
    '        except Exception: pass',
    '    def __enter__(self): return self',
    '    def __exit__(self, *a): return False',
    '    def namelist(self): return ["receipt.json"]',
    '    def read(self, name): return GREEN.encode()',
    '',
  ].join('\n'));

  // THE SHADOW IS REAL, MEASURED BEFORE IT IS DEFENDED AGAINST. Without `-P` this interpreter imports the
  // candidate's file; with `-P` it imports the standard library's. Asserting the flag's effect here rather
  // than asserting the tool's outcome alone is what makes the case below about the tool and not about python.
  const importedBy = flags => execFileSync(REAL_PYTHON, [...flags, '-c', 'import zipfile; print(zipfile.__file__)'],
    { encoding: 'utf8', cwd: candidate }).trim();
  assert.equal(importedBy([]), path.join(candidate, 'zipfile.py'),
    'the shadow does not shadow, so this case would prove nothing: fix the fixture, not the assertion');
  assert.notEqual(importedBy(['-P']), path.join(candidate, 'zipfile.py'));

  // THE ARCHIVE IS RED AND AUTHORITY-ABSENT: nothing in it may be pinned. The shadow would hand back the
  // green body above instead, and the whole chain of digests would still check out, because the digests are
  // over the ARCHIVE and the shadow substitutes what comes out of it.
  const red = JSON.parse(JSON.stringify(receipt));
  red.conclusion = { ...red.conclusion, suite_state: 'red' };
  red.suite = { ...red.suite, state: 'red', ok: 8, not_ok: 2, exit: '1',
    failing_tests: ['a test the candidate needed to pass', 'another'] };
  red.candidate = { ...red.candidate,
    authority_identity: [{ path: '.github/verifier-receipt', protected_sha: null, change: 'none' }] };
  const dir = stage({ zip: red, attestations: [envelope()] });

  const result = runTool(dir, { cwd: candidate });
  assert.notEqual(result.code, 0, 'a candidate that supplies the zip reader must get no pin');
  assert.equal(result.stdout, '', `a pin came out of the shadowed run: ${result.stdout}`);
  // Refused on the grounds the REAL body says no on, which is only possible if the real archive was read.
  assert.match(result.stderr, /the measured suite reports 2 failing test\(s\) out of 10/);
  assert.match(result.stderr, /the runner that measured this suite exited "1", not "0"/);
  assert.match(result.stderr, /the receipt authority is absent on main/);

  // And the honest world, run from the same poisoned directory, still produces the honest pin: the isolation
  // is not the tool failing to work near a candidate tree, it is the tool ignoring it.
  const honest = runTool(stage({ zip: receipt, attestations: [envelope()] }), { cwd: candidate });
  assert.equal(honest.code, 0, `expected success beside the shadow, got: ${honest.stderr}`);
  const pin = JSON.parse(honest.stdout);
  assert.equal(pin.admissibility.module_blob, blobOf(MODULE));
  assert.deepEqual(pin.admissibility.derived_reasons, []);
  assert.doesNotMatch(pin.fetched_with.zip_reader,
    new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('ITEM 1(B): an interpreter that reports its working directory on the import path is refused', () => {
  // `-P` IS A FLAG, AND A FLAG IS A CLAIM ABOUT AN INTERPRETER THIS TOOL DID NOT BUILD. So the tool asks the
  // subprocess what its `sys.path` actually was and refuses an answer that still names the working directory
  // - an interpreter too old for the flag, or one invoked in some way that put the entry back.
  const reinstated = stagePython(stage({ zip: receipt, attestations: [envelope()] }), `
    out(Buffer.from(JSON.stringify({ cwd: '/somewhere/the/candidate/owns',
      zip_reader: '/somewhere/the/candidate/owns/zipfile.py',
      working_directory_on_path: ['', '.'] }) + '\\n'));
    out(Buffer.from(${JSON.stringify(JSON.stringify(receipt))}));
  `);
  const result = runTool(reinstated);
  assert.notEqual(result.code, 0, 'an interpreter that is not isolated must be refused');
  assert.match(result.stderr, /was run with `-P` and still reports its working directory on the import path/);
  assert.match(result.stderr, /\["","\."\] resolving to "\/somewhere\/the\/candidate\/owns"/);
  assert.match(result.stderr, /a file sitting beside it could have been the zip reader/);
  assert.equal(result.stdout, '', 'an unisolated interpreter emits no pin');

  // AND AN INTERPRETER THAT WILL NOT TAKE `-P` AT ALL is refused by name rather than silently read without
  // it. This is what a python older than the flag does, and the refusal says what the tool will not do.
  const refusesFlag = stagePython(stage({ zip: receipt, attestations: [envelope()] }), `
    if (argv.includes('-P')) {
      process.stderr.write("Unknown option: -P\\nusage: python3 [option] ...\\n");
      process.exit(2);
    }
    out(stdin);
  `);
  const old = runTool(refusesFlag);
  assert.notEqual(old.code, 0, 'a python3 that will not take -P must be refused');
  assert.match(old.stderr, /holds no single receipt\.json this tool could read with [^\s]*python3 -P/);
  assert.match(old.stderr, /Unknown option: -P/);
  assert.match(old.stderr, /will not read a receipt through an interpreter it cannot isolate/);
  assert.equal(old.stdout, '', 'an un-isolatable interpreter emits no pin');
});

// ITEM 2. THE TRUST ROOT, MEASURED AND NAMED. `api()` is `gh api` in a subprocess, so every fact in a pin came
// out of whatever binary answered to `gh` - not out of GitHub. The tool cannot make that channel trustworthy;
// what it can do is stop assuming it. The binary is resolved on PATH once, its version is read back, both
// travel in the pin, and a run that says which binary it expects gets a refusal when it sees another.
test('ITEM 2: the pin records the gh binary and version the fetch actually rested on', () => {
  const dir = stage({ zip: receipt, attestations: [envelope()] });
  const result = runTool(dir);
  assert.equal(result.code, 0, `expected success, got: ${result.stderr}`);
  const pin = JSON.parse(result.stdout);
  // The ABSOLUTE path PATH resolved, which is the staged stub and not the name `gh`.
  assert.equal(pin.fetched_with.gh, path.join(dir, 'gh'));
  assert.equal(pin.fetched_with.gh_version, 'gh version 2.63.2 (2025-01-01)');
  assert.equal(pin.fetched_with.expected_gh, null);
  assert.equal(pin.fetched_with.expected_gh_version, null);

  // A different binary on PATH is a different recorded fact, which is the whole point of measuring it.
  const other = stage({ zip: receipt, attestations: [envelope()] });
  fs.writeFileSync(path.join(other, 'gh-version.txt'), 'gh version 1.0.0 (2020-01-01)\n');
  const elsewhere = JSON.parse(runTool(other).stdout);
  assert.equal(elsewhere.fetched_with.gh, path.join(other, 'gh'));
  assert.equal(elsewhere.fetched_with.gh_version, 'gh version 1.0.0 (2020-01-01)');
});

test('ITEM 2: a run that says which gh it expects is refused when PATH resolves another', () => {
  const dir = stage({ zip: receipt, attestations: [envelope()] });

  // The expectation is the RUN's to state, so stating the right one changes nothing.
  const agreed = runTool(dir, { env: { ...PROTECTED_RUN, VERIFIER_EXPECTED_GH: path.join(dir, 'gh') } });
  assert.equal(agreed.code, 0, `expected success, got: ${agreed.stderr}`);
  assert.equal(JSON.parse(agreed.stdout).fetched_with.expected_gh, path.join(dir, 'gh'));

  const wrongPath = runTool(dir, { env: { ...PROTECTED_RUN, VERIFIER_EXPECTED_GH: '/usr/bin/gh' } });
  assert.notEqual(wrongPath.code, 0, 'a gh that is not the expected one must be refused');
  assert.match(wrongPath.stderr, /this run expects its `gh` at "\/usr\/bin\/gh" \(VERIFIER_EXPECTED_GH\)/);
  assert.match(wrongPath.stderr, /is not the one this run says it trusts/);
  assert.equal(wrongPath.stdout, '', 'an unexpected gh emits no pin');

  const wrongVersion = runTool(dir,
    { env: { ...PROTECTED_RUN, VERIFIER_EXPECTED_GH_VERSION: 'gh version 9.9.9' } });
  assert.notEqual(wrongVersion.code, 0, 'a gh of the wrong version must be refused');
  assert.match(wrongVersion.stderr, /expects gh "gh version 9\.9\.9" \(VERIFIER_EXPECTED_GH_VERSION\)/);
  assert.match(wrongVersion.stderr, /reports "gh version 2\.63\.2 \(2025-01-01\)"/);
  assert.equal(wrongVersion.stdout, '', 'an unexpected gh version emits no pin');
});

test('ITEM 2: a gh this run cannot resolve, or that will not say what it is, is a refusal', () => {
  // NO `gh` ON PATH AT ALL. The tool is spawned through an absolute node path so that emptying PATH of `gh`
  // does not also empty it of the interpreter.
  const dir = stage({ zip: receipt, attestations: [envelope()] });
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'no-gh-'));
  const spawned = (options) => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [TOOL, '--run', '4242', '--repo', REPO],
        { encoding: 'utf8', ...options }), stderr: '' };
    } catch (error) {
      return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? '',
        stderr: error.stderr?.toString() ?? '' };
    }
  };
  const unresolvable = spawned({ env: { ...process.env, ...PROTECTED_RUN, PATH: bare } });
  assert.notEqual(unresolvable.code, 0, 'a run with no gh on PATH must be refused');
  assert.match(unresolvable.stderr, /no executable named `gh` is on this run's PATH/);
  assert.match(unresolvable.stderr, /has no trust root to rest a pin on/);
  assert.equal(unresolvable.stdout, '', 'a run with no gh emits no pin');

  // A `gh` that is there but not executable is not on PATH for this purpose either, and says the same thing.
  const notExecutable = fs.mkdtempSync(path.join(os.tmpdir(), 'unexecutable-gh-'));
  fs.writeFileSync(path.join(notExecutable, 'gh'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(notExecutable, 'gh'), 0o644);
  assert.match(spawned({ env: { ...process.env, ...PROTECTED_RUN, PATH: notExecutable } }).stderr,
    /no executable named `gh` is on this run's PATH/);

  // A `gh` that will not state its version cannot be identified in the pin that would rest on it.
  const silent = stage({ zip: receipt, attestations: [envelope()] });
  fs.writeFileSync(path.join(silent, 'gh-version.txt'), '');
  const mute = runTool(silent);
  assert.notEqual(mute.code, 0, 'a gh that will not identify itself must be refused');
  assert.match(mute.stderr, /would not state its version/);
  assert.match(mute.stderr, /cannot be identified in the pin that rests on it/);
  assert.equal(mute.stdout, '', 'an unidentifiable gh emits no pin');
});

// ITEM 3. THE PROTECTED-REF CHECK IS A GUARD RAIL, AND THIS IS THE MEASUREMENT THAT SAYS SO. The header used
// to call it "THE STRUCTURAL GROUND ... It is now a refusal", which overstates a `process.env` read: a
// candidate edits the workflow that sets those variables. The refusal is kept because a rail against accident
// is worth having; what is corrected is the claim made about it.
test('ITEM 3: the protected-ref check stops an accident, and a run that sets the variables itself gets past it',
  () => {
    const dir = stage({ zip: receipt, attestations: [envelope()] });
    const honestPullRequest = runTool(dir,
      { env: { GITHUB_REF: 'refs/pull/167/merge', GITHUB_EVENT_NAME: 'pull_request' } });
    assert.equal(honestPullRequest.code, 4, 'an honest pull_request run exits 4');
    assert.equal(honestPullRequest.stdout, '', 'and emits no pin');

    // The same run, with the two variables set to main's values by the workflow that invokes the tool. This
    // is not a defect being reported as one: it is the measurement behind calling this a guard rail, and the
    // reason the header now says what actually binds is `verify-claim.yml` running from protected main.
    const sameRunLying = runTool(dir, { env: PROTECTED_RUN });
    assert.equal(sameRunLying.code, 0, 'a run that sets the variables itself gets a pin');
    assert.notEqual(sameRunLying.stdout, '', 'which is exactly what a guard rail does not stop');
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
    // receipt says it may not be pinned.
    //
    // AND ONE MORE, WHICH `stage` MAKES RATHER THAN THIS CASE: the tool now requires the downloaded archive to
    // hash to `artifact.digest`, and the archive staged here is one `stage` builds around the TRIMMED receipt.
    // It is not GitHub's 61,770-byte `artifact.zip` - that file is not in this repository, only its digest is
    // (see the fixture's README.md, where `sha256:b6c84e83...` is recorded as the digest of the archive as
    // GitHub served it, which is the measurement that says this check can hold at all). So `stage` writes the
    // digest of the archive it built into REAL_ARTIFACT's record. Every other field below is the API's own.
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
