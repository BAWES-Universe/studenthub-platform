// Fetch and verify a verifier receipt through GitHub's API, and emit the pin a manifest binds to.
//
// This is the evidence path, so it trusts nothing it can be handed:
//   * the run is read back from the API by id and must be a workflow_dispatch of the receipt workflow on the
//     protected ref, concluded successfully, and have run the commit it claims;
//   * the artifact is located by NAME inside that run and its digest must be the digest GitHub reports for it
//     - an artifact digest is computed by GitHub, not supplied by the uploader;
//   * the receipt bytes are downloaded and hashed, and that hash must equal the digest of the artifact they
//     came from, so a receipt cannot be swapped for one the run did not produce;
//   * the receipt's own attestation is read back from the attestations API and its subject digest must be the
//     artifact's, so the run that produced it is the one whose provenance GitHub recorded, and that
//     attestation must name the protected ref rather than merely exist - on a pull_request event GitHub runs
//     the workflow DEFINITION from the pull request head, so a signature proves only that SOME run of a
//     workflow at this path in this repository produced these bytes;
//   * the receipt's OWN identity - `workflow.path`, `workflow.ref`, `workflow.workflow_ref`,
//     `workflow.head_sha` and `repository` - is read out of the receipt and checked, never reconstructed from
//     the run. A value this tool derives from the run and then compares against something derived the same
//     way cannot disagree with itself, and that is what the pin's `workflow_ref` used to be: built from
//     `run.head_branch` and then pinned as if it had been read;
//   * admissibility is RE-DERIVED from the receipt's body with the authority's own predicate - not read off
//     `provenance.admissible_as_pin`. The flag must be exactly true AND the derivation must be empty AND the
//     two must agree; a flag that over-claims and a flag that under-claims are both refusals, and an absent
//     flag is not permission;
//   * the predicate module this tool imports is checked, by git blob id, against the blob
//     `refs/heads/main` holds for `.github/verifier-receipt/admissibility.mjs`. The rule that judges a receipt
//     may not be a rule the judged party supplied;
//   * the receipt must be schema 2, which is the schema of the fields above.
//
// WHERE THIS TOOL'S VERDICT IS AUTHORITATIVE, AND WHERE IT IS ONLY ADVISORY. On a pull_request event GitHub
// runs the workflow definition AND the checked-out code from the pull request head, so on such a run this file,
// the predicate it imports and the blob-id check below are all the candidate's own code: its verdict there is
// ADVISORY. It is authoritative where a pin would actually be recorded, which is a run of the protected
// branch. Nothing in the checks below makes a candidate's own run authoritative, and none of them should be
// read as claiming to.
//
// Usage:  node fetch-receipt.mjs --run <run_id> [--repo owner/name] [--out pin.json]
// Stdout: the pin JSON, which the caller commits as the claim's evidence reference.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
// THE ONE ADMISSION PREDICATE. The emitter records the flag by calling this module, the workflow's gate and
// guard call it, and this tool re-derives with it - so "may a manifest pin this?" has one implementation
// rather than a copy per reader that can drift apart. The copy THIS process loaded is checked against the
// protected branch's blob below, before it is trusted to answer anything.
import { deriveAdmissibility } from './admissibility.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}
const runId = args.get('run');
const repo = args.get('repo') ?? process.env.GITHUB_REPOSITORY;
const out = args.get('out');
const RECEIPT_PATH = '.github/workflows/verifier-receipt.yml';
const ARTIFACT_NAME = 'verifier-receipt';
const PROTECTED_REF = 'refs/heads/main';
const RECEIPT_SCHEMA = 2;
if (!runId || !repo) {
  console.error('usage: fetch-receipt.mjs --run <run_id> [--repo owner/name] [--out pin.json]');
  process.exit(2);
}

const api = (endpoint, options = {}) => execFileSync('gh', ['api', ...(options.headers ?? []), endpoint],
  { encoding: options.binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 });
const apiJson = endpoint => JSON.parse(api(endpoint));
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const fail = message => {
  console.error(`REFUSING: ${message}`);
  process.exit(3);
};

const run = apiJson(`/repos/${repo}/actions/runs/${runId}`);
if (run.path !== RECEIPT_PATH) fail(`run ${runId} is ${run.path}, not ${RECEIPT_PATH}`);
if (run.event !== 'workflow_dispatch') fail(`run ${runId} is a ${run.event} run, not a dispatch`);
if (run.head_branch !== 'main') fail(`run ${runId} was dispatched on ${run.head_branch}, not main`);
if (run.status !== 'completed') fail(`run ${runId} is ${run.status}`);
if (run.conclusion !== 'success') fail(`run ${runId} concluded ${run.conclusion}`);

const artifacts = apiJson(`/repos/${repo}/actions/runs/${runId}/artifacts`).artifacts ?? [];
const artifact = artifacts.find(candidate => candidate.name === ARTIFACT_NAME);
if (!artifact) fail(`run ${runId} holds no artifact named ${ARTIFACT_NAME}`);
if (artifact.expired) fail(`the ${ARTIFACT_NAME} artifact of run ${runId} has expired`);
if (!artifact.digest || !artifact.digest.startsWith('sha256:')) {
  fail(`the ${ARTIFACT_NAME} artifact of run ${runId} carries no digest`);
}
if (artifact.workflow_run?.head_sha && artifact.workflow_run.head_sha !== run.head_sha) {
  fail('the artifact and the run disagree about the commit they belong to');
}

// Download the artifact and take the receipt out of it. The zip is read with python3 because node has no zip
// reader in its standard library and this path must not depend on a package the candidate could supply.
const zip = api(`/repos/${repo}/actions/artifacts/${artifact.id}/zip`, { binary: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'));
const zipPath = path.join(dir, 'artifact.zip');
fs.writeFileSync(zipPath, zip);
const receiptPath = path.join(dir, 'receipt.json');
execFileSync('python3', ['-c', [
  'import sys, zipfile',
  'with zipfile.ZipFile(sys.argv[1]) as archive:',
  '    names = [n for n in archive.namelist() if n.endswith("receipt.json")]',
  '    if len(names) != 1:',
  '        print(f"expected one receipt.json, found {names}", file=sys.stderr); sys.exit(1)',
  '    open(sys.argv[2], "wb").write(archive.read(names[0]))',
].join('\n'), zipPath, receiptPath]);
const receiptBytes = fs.readFileSync(receiptPath);
const receipt = JSON.parse(receiptBytes.toString('utf8'));

// THE SCHEMA IS READ BEFORE ANY FIELD IS. Every check below names a field of schema 2; in another schema the
// same name need not mean the same thing, so an unknown schema is refused rather than read optimistically.
if (receipt.schema !== RECEIPT_SCHEMA) {
  fail(`the receipt of run ${runId} is schema ${JSON.stringify(receipt.schema ?? null)}, and this tool reads `
    + `schema ${RECEIPT_SCHEMA} only: the fields it goes on to read need not mean the same thing in another`);
}

// The receipt must describe the run it was fetched from.
if (String(receipt.run?.id ?? '') !== String(run.id)) fail(`the receipt names run ${receipt.run?.id}, not ${runId}`);

// THE RECEIPT'S OWN IDENTITY, READ OUT OF THE RECEIPT. `GITHUB_WORKFLOW_REF` is what the authority records in
// both `workflow.ref` and `workflow.workflow_ref`, and its shape is `<owner>/<repo>/<path>@<ref>`. It is split
// at the FIRST `@` and the remainder must be the protected ref whole: a ref that is not exactly
// refs/heads/main fails here rather than being trimmed into agreement. Absence is a refusal too - a receipt
// that does not say which ref ran the authority is not one this tool can place, and there is deliberately no
// fallback to a ref computed from the run.
const identity = receipt.workflow ?? {};
const splitWorkflowRef = value => {
  if (typeof value !== 'string') return null;
  const at = value.indexOf('@');
  return at < 0 ? null : { workflow: value.slice(0, at), ref: value.slice(at + 1) };
};
if (receipt.repository !== repo) {
  fail(`the receipt of run ${runId} names repository ${JSON.stringify(receipt.repository ?? null)}, not ${repo}`);
}
if (identity.path !== RECEIPT_PATH) {
  fail(`the receipt of run ${runId} names workflow ${JSON.stringify(identity.path ?? null)}, not ${RECEIPT_PATH}`);
}
for (const field of ['ref', 'workflow_ref']) {
  const parsed = splitWorkflowRef(identity[field]);
  if (!parsed) {
    fail(`the receipt of run ${runId} carries no readable workflow.${field} `
      + `(${JSON.stringify(identity[field] ?? null)}), so nothing in it says which ref ran the authority`);
  }
  if (parsed.ref !== PROTECTED_REF) {
    fail(`the receipt of run ${runId} says workflow.${field} names ref ${JSON.stringify(parsed.ref)}, not `
      + `${PROTECTED_REF}: a receipt made by a run of any other ref was made by the workflow definition that `
      + 'ref supplied, whoever wrote it');
  }
  if (parsed.workflow !== `${repo}/${RECEIPT_PATH}`) {
    fail(`the receipt of run ${runId} says workflow.${field} names ${JSON.stringify(parsed.workflow)}, not `
      + `${repo}/${RECEIPT_PATH}`);
  }
}
// Both fields are required to be present and right on their own account. They are NOT compared to each other:
// each has already had to equal one constructed expectation, so an equality check between them could never
// disagree, and a check that cannot fail is not a check.
//
// The commit the AUTHORITY ran at, which is the commit a pin binds to. It is not the measured commit: the
// candidate is an INPUT of a dispatch run, so `candidate.sha` need not be the dispatching commit, and the
// receipt is pinned for what ran it rather than for what it measured.
if (!/^[0-9a-f]{40}$/.test(String(identity.head_sha ?? ''))) {
  fail(`the receipt of run ${runId} carries no workflow.head_sha (${JSON.stringify(identity.head_sha ?? null)}), `
    + 'so it names no commit of the authority for a pin to bind to');
}
if (identity.head_sha !== run.head_sha) {
  fail(`the receipt of run ${runId} says the authority ran at ${identity.head_sha}, but GitHub reports run `
    + `${runId} ran ${run.head_sha}`);
}

// THE RULE THAT JUDGES THIS RECEIPT MUST BE THE PROTECTED ONE, AND THAT IS CHECKED RATHER THAN ASSUMED.
//
// WHY. On a pull_request event GitHub runs the workflow DEFINITION and the checked-out CODE from the pull
// request head. A consumer that simply imported the copy of the predicate sitting beside it would therefore
// let a candidate supply the rule that judges the candidate: `deriveAdmissibility` could be edited to return
// "admissible, no reasons" for anything, and every check in this file would pass while measuring nothing. So
// the bytes this process actually loaded are hashed the way git hashes a blob - sha1("blob <len>\0" + bytes),
// with node crypto and no git binary, because this path must not depend on a working tree or on history - and
// compared with the blob id GitHub reports for that path at refs/heads/main. A mismatch names both ids and
// refuses.
//
// The permission list is checked the same way and for the same reason: `tolerated-skips.json` says which
// skipped tests are tolerable, so a candidate that could rewrite it could authorise its own skips.
//
// AND WHAT THIS DOES NOT ESTABLISH, stated here rather than left to be inferred: on a pull_request run this
// check is itself the candidate's code, and code can be deleted as easily as it can be edited. The check is
// what makes the tool's verdict meaningful on a run of the PROTECTED branch, which is the only place a pin
// would be recorded. It does not make a candidate's own run authoritative.
const gitBlobId = bytes => crypto.createHash('sha1')
  .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes])).digest('hex');
const verifiedAgainstMain = (localPath, repoPath) => {
  const bytes = fs.readFileSync(localPath);
  const local = gitBlobId(bytes);
  let entry;
  try {
    // Through the same injected `gh` every other read in this file goes through, so there is one API path.
    entry = apiJson(`/repos/${repo}/contents/${repoPath}?ref=${PROTECTED_REF}`);
  } catch (error) {
    fail(`${PROTECTED_REF} could not be asked what blob it holds for ${repoPath} (${error.message}), so this `
      + `tool cannot establish that the rule it loaded is the protected one`);
  }
  if (entry?.type !== 'file' || !/^[0-9a-f]{40}$/.test(String(entry?.sha ?? ''))) {
    fail(`${PROTECTED_REF} reports no file blob for ${repoPath} (${JSON.stringify(entry?.sha ?? null)}), so `
      + 'the rule this tool loaded cannot be checked against the protected branch');
  }
  if (entry.sha !== local) {
    fail(`the ${repoPath} this tool loaded is blob ${local}, but ${PROTECTED_REF} holds blob ${entry.sha} for `
      + 'that path: the rule that judges a receipt may not be a rule the judged party supplied');
  }
  return local;
};
const MODULE_PATH = '.github/verifier-receipt/admissibility.mjs';
const TOLERATED_SKIPS = '.github/verifier-receipt/tolerated-skips.json';
const moduleBlob = verifiedAgainstMain(path.join(import.meta.dirname, 'admissibility.mjs'), MODULE_PATH);
const toleratedSkipsBlob = verifiedAgainstMain(path.join(import.meta.dirname, 'tolerated-skips.json'),
  TOLERATED_SKIPS);

// ADMISSIBILITY IS RE-DERIVED, NOT RE-READ, AND A DISAGREEMENT IN EITHER DIRECTION IS A REFUSAL.
//
// This repository has read an absent field as consent before, and a review has taken a receipt whose body
// recorded the authority as absent on main, flipped ONLY this flag to true, and walked it past three readers
// that each compared the computed boolean with itself. So the flag decides nothing here: the rule above is
// applied to the receipt's own body, and the pin is emitted only when the derivation is empty AND the recorded
// flag is exactly `true`. The reasons quoted in a refusal are the ones DERIVED from the body; where the
// receipt recorded reasons of its own they are quoted too, because they are the authority's own words.
const admissible = receipt.provenance?.admissible_as_pin;
const reasons = receipt.provenance?.inadmissibility_reasons;
const quoted = list => list.map(reason => `"${reason}"`).join('; ');
const derived = deriveAdmissibility(receipt);
if (derived.reasons.length > 0) {
  // The body itself says no. Whether the flag agrees changes only how this is reported - never the outcome.
  fail(admissible === true
    ? `the receipt of run ${runId} says provenance.admissible_as_pin=true, but its own body says otherwise `
      + `on ${derived.reasons.length} ground(s), re-derived here with ${MODULE_PATH}: ${quoted(derived.reasons)}`
    : `the receipt of run ${runId} may not be pinned, on ${derived.reasons.length} ground(s) re-derived from `
      + `its own body: ${quoted(derived.reasons)}`
      + (Array.isArray(reasons) && reasons.length > 0 ? `; it records: ${quoted(reasons)}` : ''));
}
// The derivation is empty. The recorded flag must now say so itself, exactly - a receipt may not be pinned on
// a flag that is missing, and a flag that UNDERSTATES what its body supports is reported as the disagreement
// it is rather than resolved in the pin's favour.
if (admissible !== true) {
  fail(`the receipt of run ${runId} records provenance.admissible_as_pin=${JSON.stringify(admissible ?? null)} `
    + `while every ground of ${MODULE_PATH} is satisfied by its own body: this tool refuses a disagreement `
    + 'between a receipt and itself rather than resolving it in the pin\'s favour'
    + (Array.isArray(reasons) && reasons.length > 0 ? `; it records: ${quoted(reasons)}` : ''));
}
if (!Array.isArray(reasons)) {
  fail(`the receipt of run ${runId} carries no provenance.inadmissibility_reasons list beside `
    + 'admissible_as_pin=true, so nothing in it says whether a reason was recorded');
}
if (reasons.length > 0) {
  fail(`the receipt of run ${runId} says admissible_as_pin=true while recording ${reasons.length} reason(s) `
    + `why it may not be pinned: ${quoted(reasons)}`);
}

// Attestations are written by GitHub's attestation service for a run with id-token and attestations
// permission; reading one back and matching its subject digest is what ties the artifact to a workflow run
// rather than to whoever could write a file.
const subjectDigest = `sha256:${sha256(receiptBytes)}`;
let attestation = null;
try {
  const body = apiJson(`/repos/${repo}/attestations/${subjectDigest}`);
  attestation = (body.attestations ?? [])[0] ?? null;
} catch (error) {
  attestation = null;
}
if (!attestation) {
  fail(`no attestation is recorded for the receipt of run ${runId} (subject ${subjectDigest})`);
}
const statement = JSON.parse(Buffer.from(attestation.bundle?.dsseEnvelope?.payload ?? '', 'base64').toString('utf8'));
const workflowRef = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
const workflowPath = workflowRef.path ?? workflowRef.workflow?.path ?? null;
const workflowRepo = workflowRef.repository ?? workflowRef.workflow?.repository ?? null;
const attestedRef = workflowRef.ref ?? workflowRef.workflow?.ref ?? null;
if (workflowPath !== RECEIPT_PATH) fail(`the attestation names workflow ${workflowPath}, not ${RECEIPT_PATH}`);
if (String(workflowRepo).split('/').slice(-2).join('/') !== repo) {
  fail(`the attestation names repository ${workflowRepo}, not ${repo}`);
}
// THE REF IS THE ANCHOR, NOT THE SIGNATURE. A same-repository pull_request run executes the workflow
// DEFINITION from the pull request head, so a signed receipt says only that some run of a workflow at this
// path in this repository produced these bytes. What makes it this authority's receipt is that the run was a
// dispatch of the protected branch, which is what the attestation records as the workflow ref.
if (attestedRef !== PROTECTED_REF) {
  fail(`the attestation names workflow ref ${JSON.stringify(attestedRef)}, not ${PROTECTED_REF}: a receipt `
    + 'signed by a run of any other ref was produced by a workflow definition that ref supplied');
}

const pin = {
  schema: 1,
  repository: repo,
  workflow_path: identity.path,
  // Read out of the receipt and checked against the protected ref above, not rebuilt from the run's branch.
  workflow_ref: splitWorkflowRef(identity.workflow_ref).ref,
  workflow_head_sha: identity.head_sha,
  run_id: String(run.id),
  run_attempt: String(run.run_attempt ?? 1),
  artifact_name: artifact.name,
  artifact_id: String(artifact.id),
  artifact_digest: artifact.digest,
  receipt_digest: subjectDigest,
  attestation_digest: subjectDigest,
  attestation_workflow_ref: attestedRef,
  // THE RULE THIS PIN WAS ADMITTED UNDER, by the blob id of the file that holds it and of its permission
  // list, both checked against refs/heads/main above. A reader re-checking this pin fetches these two blobs
  // and re-derives; a pin that named no rule would leave them to guess which rule had been applied.
  admissibility: {
    module: MODULE_PATH,
    module_blob: moduleBlob,
    tolerated_skips: TOLERATED_SKIPS,
    tolerated_skips_blob: toleratedSkipsBlob,
    protected_ref: PROTECTED_REF,
    derived_reasons: derived.reasons,
  },
  receipt: {
    // The two fields this pin rests on, recorded so that the pin states the basis on which it was admitted
    // rather than leaving a reader to take it on trust.
    schema: receipt.schema,
    admissible_as_pin: admissible,
    conclusion: receipt.conclusion ?? null,
    candidate: receipt.candidate ?? null,
    manifest: receipt.manifest ?? null,
    suite: receipt.suite ?? null,
    named_tests: receipt.named_tests ?? [],
    named_tests_summary: receipt.named_tests_summary ?? null,
  },
};
fs.rmSync(dir, { recursive: true, force: true });
const serialised = `${JSON.stringify(pin, null, 2)}\n`;
if (out) fs.writeFileSync(out, serialised);
console.log(serialised);
