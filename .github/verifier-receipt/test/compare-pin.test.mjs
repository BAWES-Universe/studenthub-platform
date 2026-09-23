// The comparison step of `verify-claim.yml`, which is the step that gates a candidate.
//
// It used to be a `node -e` string inside the workflow, and this file is half the reason it no longer is: a
// string in a YAML step body is a thing no test can reach, so the one defect in it - `pins.find(...)` handed
// straight to a property read - sat there as a TypeError waiting for a manifest that did not name the run
// being verified. Fails-closed-by-crash is not this repository's standard. A refusal names what it refused.
//
// No network, no git, no token: the module reads two files and writes a sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TOOL = path.join(import.meta.dirname, '..', 'compare-pin.mjs');

// The pin `fetch-receipt.mjs` emits, in the shape it emits it. Nothing here was measured.
const FETCHED = {
  schema: 1,
  repository: 'owner/name',
  workflow_path: '.github/workflows/verifier-receipt.yml',
  workflow_ref: 'refs/heads/main',
  workflow_head_sha: 'a'.repeat(40),
  run_id: '4242',
  run_attempt: '1',
  artifact_name: 'verifier-receipt',
  artifact_id: '77',
  artifact_digest: `sha256:${'d'.repeat(64)}`,
  receipt_digest: `sha256:${'e'.repeat(64)}`,
  attestation_digest: `sha256:${'e'.repeat(64)}`,
  attestation_workflow_ref: 'refs/heads/main',
  receipt: { schema: 2, admissible_as_pin: true, conclusion: { verdict: 'success', suite_state: 'green' } },
};
// What a candidate commits: the same object, minus the fields a pin file does not have to carry.
const claimedFrom = (patch = {}) => ({ ...JSON.parse(JSON.stringify(FETCHED)), ...patch });

const run = ({ fetched = FETCHED, manifest = { pins: [claimedFrom()] } } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-pin-'));
  const fetchedPath = path.join(dir, 'pin.json');
  const manifestPath = path.join(dir, 'verifier-receipts.json');
  fs.writeFileSync(fetchedPath, JSON.stringify(fetched));
  fs.writeFileSync(manifestPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  try {
    return { code: 0, stdout: execFileSync('node',
      [TOOL, '--fetched', fetchedPath, '--manifest', manifestPath], { encoding: 'utf8' }), stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '' };
  }
};

test('a manifest that carries the pin it should agrees with the run the API describes', () => {
  const result = run();
  assert.equal(result.code, 0, `expected success, got: ${result.stderr}`);
  assert.match(result.stdout, /pin for run 4242 matches the API, verdict success/);

  // A bare array is the other shape a pin file is written in, and it is read the same way.
  assert.equal(run({ manifest: [claimedFrom()] }).code, 0);
});

// ITEM 5. `pins.find(...)` answers `undefined` for a manifest that does not name this run, and the line after
// it read a field off that. The refusal now says what was looked for and what was there.
test('a manifest with no pin for the run being verified is a named refusal, not a TypeError', () => {
  const empty = run({ manifest: { pins: [] } });
  assert.notEqual(empty.code, 0, 'a manifest with no pin for this run must be refused');
  assert.match(empty.stderr, /carries no pin for run 4242, which is the run this verification fetched/);
  assert.match(empty.stderr, /it holds 0 pin\(s\)/);
  assert.doesNotMatch(empty.stderr, /TypeError/, `refused by crashing: ${empty.stderr}`);
  assert.match(empty.stderr, /its absence is refused by name rather than read off an undefined object/);

  // A manifest that names OTHER runs says which, so a reader can see whether a run id was edited.
  const others = run({ manifest: { pins: [claimedFrom({ run_id: '1' }), claimedFrom({ run_id: '2' })] } });
  assert.notEqual(others.code, 0);
  assert.match(others.stderr, /it holds 2 pin\(s\) naming 1, 2/);
  assert.doesNotMatch(others.stderr, /TypeError/);

  // A pin file with no array in it at all, and one that is not JSON, are refusals of their own.
  assert.match(run({ manifest: { pins: 'a string' } }).stderr, /carries no array of pins \("string"\)/);
  assert.match(run({ manifest: '{ not json' }).stderr,
    /the candidate's committed pin file could not be read as JSON/);
});

// C10. Two fields a previous round added to the pin and never compared. A field computed at fetch time and
// never compared is a field the candidate is free to write anything into.
test('the claimed pin must agree on every field, including attestation_workflow_ref and schema', () => {
  for (const [field, value] of [
    ['schema', 2],
    ['attestation_workflow_ref', 'refs/pull/167/merge'],
    ['workflow_path', '.github/workflows/ci.yml'],
    ['workflow_ref', 'refs/heads/topic'],
    ['workflow_head_sha', 'b'.repeat(40)],
    ['run_attempt', '2'],
    ['artifact_name', 'something-else'],
    ['artifact_digest', `sha256:${'0'.repeat(64)}`],
    ['receipt_digest', `sha256:${'0'.repeat(64)}`],
  ]) {
    const result = run({ manifest: { pins: [claimedFrom({ [field]: value })] } });
    assert.notEqual(result.code, 0, `a claimed ${field} of ${value} must be refused`);
    assert.match(result.stderr,
      new RegExp(`disagrees with the run it names on: ${field} \\(claimed `), `${field} gave: ${result.stderr}`);
  }
});

// C9. The step used to ask only that the two objects AGREE about the verdict, so a pin honestly copying
// `verdict: "failure"` passed the step that gates the candidate. Agreement is not success.
test('the fetched receipt must record a success that is admissible as a pin, not merely one both agree on', () => {
  const agreedFailure = {
    ...FETCHED,
    receipt: { ...FETCHED.receipt, conclusion: { verdict: 'failure', suite_state: 'red' } },
  };
  const result = run({ fetched: agreedFailure,
    manifest: { pins: [claimedFrom({ receipt: agreedFailure.receipt })] } });
  assert.notEqual(result.code, 0, 'an honestly copied failure must still be refused');
  assert.match(result.stderr,
    /the pin names a run whose receipt records verdict "failure", and only a success establishes anything/);

  const noVerdict = { ...FETCHED, receipt: { ...FETCHED.receipt, conclusion: {} } };
  assert.match(run({ fetched: noVerdict, manifest: { pins: [claimedFrom({ receipt: noVerdict.receipt })] } })
    .stderr, /records verdict null/);

  for (const value of [false, undefined, 'true']) {
    const receipt = { ...FETCHED.receipt, admissible_as_pin: value };
    const inadmissible = { ...FETCHED, receipt };
    const result = run({ fetched: inadmissible, manifest: { pins: [claimedFrom({ receipt })] } });
    assert.notEqual(result.code, 0, `admissible_as_pin=${JSON.stringify(value)} must be refused`);
    assert.match(result.stderr, /names a receipt that is not admissible as a pin/,
      `gave: ${result.stderr}`);
  }
});

test('the claimed verdict must be the fetched one, and the disagreement names both', () => {
  const lying = claimedFrom({ receipt: { ...FETCHED.receipt, conclusion: { verdict: 'failure' } } });
  const result = run({ manifest: { pins: [lying] } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /the claimed pin reports verdict "failure" and the receipt it names reports "success"/);
});
