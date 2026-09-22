// Tests for the fetch tool, because it is the piece that turns a pin into evidence and it had none.
//
// `gh` is stubbed through PATH, so the checks run without network and without a token: each case supplies the
// API's answers in a fixture file and asserts what the tool does with them. The refusals are the point - a tool
// that accepted a run it was not asked to measure, an artifact GitHub never digested, or a receipt with no
// attestation would let a fabricated pin through.
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

const receipt = {
  run: { id: '4242' },
  workflow: { path: WORKFLOW, ref: 'refs/heads/main', head_sha: HEAD, event: 'workflow_dispatch' },
  candidate: { sha: HEAD, tree: TREE },
  manifest: { sha256: 'c'.repeat(64), code_revision: { head: HEAD, tree: TREE } },
  suite: { tests: 10, ok: 9, not_ok: 1, skipped: 0, exit: '1' },
  named_tests: [{ term: 'a/term', kind: 'control', name: 'a control', status: 'pass' }],
  conclusion: { verdict: 'success', scope: 'named tests' },
};

const RUN = { path: WORKFLOW, event: 'workflow_dispatch', head_branch: 'main', status: 'completed',
  conclusion: 'success', id: 4242, head_sha: HEAD, run_attempt: 1 };
const ARTIFACT = { id: 77, name: 'verifier-receipt', expired: false,
  digest: `sha256:${'d'.repeat(64)}`, workflow_run: { head_sha: HEAD } };

// Prepare a directory holding the stub, its answers and optionally a real zip of the receipt.
const stage = ({ run = RUN, artifacts = { artifacts: [ARTIFACT] }, zip = null, attestations = [] }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  const answers = {
    [`/repos/${REPO}/actions/runs/4242`]: run,
    [`/repos/${REPO}/actions/runs/4242/artifacts`]: artifacts,
  };
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
  fs.writeFileSync(path.join(dir, 'attestations.json'), JSON.stringify({ attestations }));
  fs.copyFileSync(STUB, path.join(dir, 'gh.cjs'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec node "${path.join(dir, 'gh.cjs')}" "$@"\n`);
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  if (zip) {
    const receiptPath = path.join(dir, 'receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify(zip));
    execFileSync('python3', ['-c', [
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1], "w") as archive:',
      '    archive.write(sys.argv[2], "receipt.json")',
    ].join('\n'), path.join(dir, 'zip.bin'), receiptPath]);
  }
  return dir;
};

const runTool = dir => {
  try {
    return { code: 0, stdout: execFileSync('node', [TOOL, '--run', '4242', '--repo', REPO],
      { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }), stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '' };
  }
};

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

  const wrongCommit = runTool(stage({ zip: { ...receipt,
    workflow: { ...receipt.workflow, head_sha: '0'.repeat(40) }, candidate: { sha: '0'.repeat(40), tree: TREE } },
    attestations: [envelope()] }));
  assert.match(wrongCommit.stderr, /agrees with the run on neither/);
});

test('the fetch tool emits a pin when the run, the artifact and the attestation agree', () => {
  const dir = stage({ zip: receipt, attestations: [envelope()] });
  const result = runTool(dir);
  assert.equal(result.code, 0, `expected success, got: ${result.stderr}`);
  const pin = JSON.parse(result.stdout);
  assert.equal(pin.run_id, '4242');
  assert.equal(pin.workflow_path, WORKFLOW);
  assert.equal(pin.workflow_ref, 'refs/heads/main');
  assert.equal(pin.workflow_head_sha, HEAD);
  assert.equal(pin.artifact_name, 'verifier-receipt');
  assert.equal(pin.artifact_digest, `sha256:${'d'.repeat(64)}`);
  // The receipt digest is computed from the bytes inside the artifact, never taken from the candidate.
  const expected = crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  assert.equal(pin.receipt_digest, `sha256:${expected}`);
  assert.equal(pin.attestation_digest, pin.receipt_digest);
  assert.equal(pin.receipt.conclusion.verdict, 'success');
  assert.equal(pin.receipt.named_tests.length, 1);
});

test('the fetch tool refuses an attestation that names another workflow', () => {
  const other = envelope('.github/workflows/something-else.yml');
  const result = runTool(stage({ zip: receipt, attestations: [other] }));
  assert.match(result.stderr, /the attestation names workflow/);
});

// An in-toto statement as GitHub's attestation service records it, wrapped the way the API returns it.
function envelope(workflowPath = WORKFLOW) {
  return { bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({
    predicate: { buildDefinition: { externalParameters:
      { workflow: { path: workflowPath, repository: REPO } } } },
  })).toString('base64') } } };
}
