// Fetch and verify a verifier receipt through GitHub's API, and emit the pin a manifest binds to.
//
// This is the evidence path, so it trusts nothing it can be handed:
//   * ONLY A RUN OF THE PROTECTED BRANCH MAY EMIT A PIN AT ALL. That is the first thing this file decides and
//     the last thing it enforces - see THE STRUCTURAL GROUND below;
//   * the run is read back from the API by id and must be a workflow_dispatch of the receipt workflow on the
//     protected ref, concluded successfully, and have run the commit it claims;
//   * the artifact is located by NAME inside that run and its digest must be the digest GitHub reports for it
//     - an artifact digest is computed by GitHub, not supplied by the uploader;
//   * the downloaded ARCHIVE's bytes are hashed and must equal `artifact.digest`, which is the check that the
//     container is the one GitHub served rather than one substituted in flight; the receipt is then taken out
//     of THAT verified archive, so the bytes this tool goes on to read are provably the ones inside it. The
//     receipt's own sha256 is a DIFFERENT quantity from the artifact digest - the artifact digest is over the
//     ZIP and the receipt hash is over `receipt.json` inside it - and this file does not claim otherwise: the
//     receipt hash is used as the attestation SUBJECT, never compared with the artifact's digest;
//   * the receipt's own attestation is read back from the attestations API and its subject digest must be the
//     receipt's, so the run that produced it is the one whose provenance GitHub recorded, and that
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
//   * THE MODULE THAT DECIDES IS FETCHED FROM THE PROTECTED BRANCH AND IS NEVER THE CHECKOUT'S. See THE RULE
//     THAT DECIDES below;
//   * the receipt must be schema 2, which is the schema of the fields above.
//
// THE STRUCTURAL GROUND: A CANDIDATE'S OWN RUN MAY NOT PRODUCE A PIN.
//
// Every round before this one wrote that down in prose and left the code able to do it anyway. It is now a
// refusal. Unless the run this tool is part of is ITSELF on the protected branch - `GITHUB_REF` exactly
// `refs/heads/main` and `GITHUB_EVENT_NAME` one of `push` or `workflow_dispatch` - this file emits no pin, no
// `--out` file, and nothing shaped like one; it exits non-zero naming the reason. It will still REPORT what it
// found, on stderr and labelled ADVISORY, because a report is useful and a pin is authority.
//
// WHY, said plainly: on a pull_request event GitHub runs the workflow DEFINITION and the checked-out CODE from
// the pull request head, so this tool, the files it reads and the checks it performs are all the candidate's.
// A verdict computed by the judged party is not evidence, however carefully it is computed. A review made
// exactly this point concrete: eight lines in the candidate's own `admissibility.mjs`, evaluated at import
// time before any check ran, could patch `fs.readFileSync` to hand back main's bytes for its own path - and
// out came a pin over a red, authority-absent body, recording main's real blob id as the rule that admitted
// it. The fetch below removes the file it patched; this ground removes the pin it produced.
//
// Usage:  node fetch-receipt.mjs --run <run_id> [--repo owner/name] [--out pin.json]
// Stdout: the pin JSON, which the caller commits as the claim's evidence reference. Nothing on a run that may
//         not pin: the advisory report goes to stderr so that no reader can mistake it for the pin channel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
// NOTHING OF THE CHECKOUT'S IS IMPORTED HERE, AND THAT IS THE POINT OF THIS ROUND. This file used to carry
// `import { deriveAdmissibility } from './admissibility.mjs'` and check that module's blob id 160 lines later.
// ESM evaluates a dependency's top level at LOAD, so the candidate's module ran first, in this process, and
// could neutralise the check meant to catch it. Checking bytes on disk and then importing the path is a
// time-of-check-to-time-of-use gap in any case. The decider is fetched from the protected branch over the API
// and imported from OUTSIDE the tree; see THE RULE THAT DECIDES.

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

// THE STRUCTURAL GROUND, SETTLED BEFORE ANY OTHER LINE RUNS. It is read here, at the top, from the environment
// the runner sets before node starts, so that no file this process later loads can be the thing that decided
// it. `mayPin` is consulted once, at the emit site; there is no other way out of this file with a pin.
const PIN_EVENTS = ['push', 'workflow_dispatch'];
const runRef = process.env.GITHUB_REF ?? null;
const runEvent = process.env.GITHUB_EVENT_NAME ?? null;
const mayPin = runRef === PROTECTED_REF && PIN_EVENTS.includes(String(runEvent));
const mayNotPinBecause = mayPin ? null
  : `this run is ${JSON.stringify(runEvent)} on ${JSON.stringify(runRef)}, and a pin may be emitted only by a `
    + `run that is itself on the protected branch (GITHUB_REF ${PROTECTED_REF}, GITHUB_EVENT_NAME one of `
    + `${PIN_EVENTS.join(' or ')}). On a pull_request event this tool, the rule it applies and every file it `
    + 'reads are the candidate\'s own, so its verdict is a report and not evidence';

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
//
// THE CONTAINER IS CHECKED BEFORE IT IS OPENED, which is the claim the header makes and this is where it is
// kept. `artifact.digest` is computed by GitHub over the ZIP it stored; the bytes that come back from the
// download endpoint must hash to it, or these are not the bytes GitHub served and nothing inside them is
// evidence of anything. Measured against the real world once, and recorded so the number is not folklore: for
// run 35869844952 GitHub reported `sha256:b6c84e83...` for a 61,770-byte `verifier-receipt` artifact, and the
// downloaded `artifact.zip` is 61,770 bytes hashing to `b6c84e83...`. Read back from the API on 2026-09-23:
//   $ gh api /repos/.../actions/artifacts/10754354187/zip > artifact.zip && sha256sum artifact.zip
//   b6c84e8325aec145cad7b912bbef0a29a560a85b4ed2d96d92668b39127736ff  artifact.zip   (61,770 bytes)
// and the `receipt.json` inside that archive hashes to `74947a1b...`, which is a DIFFERENT number - which is
// what made the sentence this comment replaces impossible to hold. See the fixture's README.md.
//
// AND THEN THE RECEIPT IS TAKEN OUT OF THAT VERIFIED ARCHIVE, never from anywhere else, so "the receipt used
// is the one inside the artifact GitHub digested" is a property of the order of these lines. The receipt's own
// sha256, computed further down, is a different quantity and is used as a different thing: the attestation's
// subject. It is never compared with the artifact digest, because the two are hashes of different objects.
const zip = api(`/repos/${repo}/actions/artifacts/${artifact.id}/zip`, { binary: true });
const zipDigest = `sha256:${sha256(zip)}`;
if (zipDigest !== artifact.digest) {
  fail(`the ${ARTIFACT_NAME} archive downloaded for run ${runId} is ${zip.length} bytes hashing to ${zipDigest}, `
    + `but GitHub reports ${artifact.digest} for artifact ${artifact.id}: these are not the bytes GitHub `
    + 'served, so nothing taken out of them can stand for what that run produced');
}
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

// THE RULE THAT DECIDES: FETCHED FROM THE PROTECTED BRANCH, VERIFIED, AND IMPORTED FROM OUTSIDE THE TREE.
//
// WHY THE EARLIER SHAPE WAS NOT ENOUGH. The previous round imported `./admissibility.mjs` at the top of this
// file and checked its blob id here. Two things are wrong with that and only one of them is a race: ESM
// evaluates a dependency's top level at LOAD, so on a pull_request event the candidate's module had already
// run in this process before any check did, and eight lines of it - patching `fs.readFileSync` to return the
// protected bytes for its own path - made the check report exactly what it wanted; and even with the order
// reversed, reading bytes off a path and then importing that path is a time-of-check-to-time-of-use gap. On a
// pull_request event the WHOLE TREE is the candidate's, so there is no file here to read that fixes this.
//
// SO THE BYTES THAT DECIDE DO NOT COME FROM THE CHECKOUT AT ALL. They are fetched over the contents API at
// refs/heads/main, and three things are required of the answer before a byte of it is used: the API must
// serve it, its `encoding` must be base64 (GitHub answers `"encoding": "none"` with an empty `content` for a
// file it will not inline, and a check that can pass by decoding nothing is not a check), and the decoded
// bytes must hash to the `sha` the API reports for that path. That sha is the git blob id, so it is recomputed
// the way git computes one - sha1("blob <len>\0" + bytes), with node crypto and never with a git binary,
// because this path must not depend on a working tree or on history. Verified bytes are written to a temp
// directory OUTSIDE the repository and imported from there; `.github/verifier-receipt/admissibility.mjs` in
// the checkout is never imported, never read for the decision, and never trusted.
//
// The permission list travels the same way and for the same reason: `tolerated-skips.json` says which skipped
// tests are tolerable, so it is permission, and permission must come from the branch that grants it. It is
// written into the same temp directory, which is also where the fetched module resolves its own default path
// to - and it is passed explicitly besides, so the deciding list is named rather than inferred.
//
// AND THE CHECKOUT IS STILL COMPARED, because a tree that disagrees with the rule it is about to be judged by
// is a fact worth refusing on rather than passing over quietly. The comparison decides nothing; it only
// refuses, and it refuses naming both blob ids even when the fetch succeeded.
//
// WHAT THE API ACTUALLY ANSWERS, MEASURED RATHER THAN ASSUMED (2026-09-23, this repository):
//   $ gh api '/repos/.../contents/.github/workflows/ci.yml?ref=refs/heads/main' --jq '{type,sha,encoding,size}'
//   {"encoding":"base64","sha":"995a8375198bb92bad0c7a37135ccc452b04e64e","size":6483,"type":"file"}
// and the base64 decodes to 6483 bytes whose git blob id is 995a8375..., so `sha` really is the blob id of
// the content the same response carries. That is the relation this code rests on, and it is checked here
// rather than trusted, because a response that carried one without the other would establish nothing.
//
// AND THE BOOTSTRAP, WHICH IS THE CLOSED DIRECTION AND IS NOT A BUG. On the same day:
//   $ gh api '/repos/.../contents/.github/verifier-receipt/admissibility.mjs?ref=refs/heads/main'
//   gh: Not Found (HTTP 404)
// refs/heads/main does not carry this authority yet. Until it does, this tool refuses every pin with "would
// not serve", because there is no protected rule for it to decide with - which is exactly right and is the
// same bootstrap the producer's trust job has: an authority cannot judge an amendment to itself until the
// amendment lands. A fallback to the checkout's copy here would be the whole defect this round is fixing.
const gitBlobId = bytes => crypto.createHash('sha1')
  .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes])).digest('hex');
const fetchedFromMain = repoPath => {
  let entry;
  try {
    // Through the same injected `gh` every other read in this file goes through, so there is one API path.
    entry = apiJson(`/repos/${repo}/contents/${repoPath}?ref=${PROTECTED_REF}`);
  } catch (error) {
    fail(`${PROTECTED_REF} would not serve ${repoPath} (${error.message}), so this tool has no protected copy `
      + 'of the rule that decides and will not decide with an unprotected one');
  }
  if (entry?.type !== 'file' || !/^[0-9a-f]{40}$/.test(String(entry?.sha ?? ''))) {
    fail(`${PROTECTED_REF} reports no file blob for ${repoPath} (${JSON.stringify(entry?.sha ?? null)}), so `
      + 'there is nothing protected for this tool to decide with');
  }
  if (entry.encoding !== 'base64') {
    fail(`${PROTECTED_REF} would not inline ${repoPath} (encoding ${JSON.stringify(entry.encoding ?? null)}, `
      + 'not base64), so this tool holds no bytes of the rule that decides');
  }
  const bytes = Buffer.from(String(entry.content ?? ''), 'base64');
  const blob = gitBlobId(bytes);
  if (blob !== entry.sha) {
    fail(`the ${repoPath} bytes ${PROTECTED_REF} served are ${bytes.length} bytes hashing to blob ${blob}, but `
      + `the API reports blob ${entry.sha} for that path: the content and the identity of the rule that `
      + 'decides disagree, and this tool decides with neither');
  }
  return { bytes, blob };
};
const MODULE_PATH = '.github/verifier-receipt/admissibility.mjs';
const TOLERATED_SKIPS = '.github/verifier-receipt/tolerated-skips.json';
const fetchedModule = fetchedFromMain(MODULE_PATH);
const fetchedSkips = fetchedFromMain(TOLERATED_SKIPS);
const moduleBlob = fetchedModule.blob;
const toleratedSkipsBlob = fetchedSkips.blob;

// OUTSIDE THE REPOSITORY TREE. `os.tmpdir()` is not a path the checkout can place a file into ahead of this
// process, and the directory is created by mkdtemp, so the name is not one anything could have predicted.
const ruleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-rule-'));
const modulePath = path.join(ruleDir, 'admissibility.mjs');
const skipsPath = path.join(ruleDir, 'tolerated-skips.json');
fs.writeFileSync(modulePath, fetchedModule.bytes);
fs.writeFileSync(skipsPath, fetchedSkips.bytes);

// THE CHECKOUT'S COPIES, COMPARED AND NOT USED. Read after the fetch, so this reads a tree that has had no
// opportunity to learn what it would be compared against; a path that is not there is reported as absent
// rather than skipped, because a missing rule is a disagreement too.
const blobInCheckout = name => {
  try {
    return gitBlobId(fs.readFileSync(path.join(import.meta.dirname, name)));
  } catch (error) {
    return null;
  }
};
for (const [repoPath, name, fetchedBlob] of [[MODULE_PATH, 'admissibility.mjs', moduleBlob],
  [TOLERATED_SKIPS, 'tolerated-skips.json', toleratedSkipsBlob]]) {
  const inCheckout = blobInCheckout(name);
  if (inCheckout !== fetchedBlob) {
    fail(`the ${repoPath} in this checkout is blob ${JSON.stringify(inCheckout)} and ${PROTECTED_REF} holds `
      + `blob ${fetchedBlob}: the rule that judges a receipt may not be a rule the judged party supplied, and `
      + 'this tool refuses a tree that disagrees with the rule deciding it even though it decided with the '
      + 'protected bytes and not with these');
  }
}

// AND ONLY NOW IS ANYTHING EXECUTED. The first line of candidate-influenced code that could have run in this
// process is not here: this import is of bytes the API served for refs/heads/main, whose blob id the API
// itself reported, written to a path nothing in the tree can reach.
const { deriveAdmissibility } = await import(pathToFileURL(modulePath).href);
if (typeof deriveAdmissibility !== 'function') {
  fail(`the ${MODULE_PATH} fetched from ${PROTECTED_REF} exports no deriveAdmissibility function, so there is `
    + 'no rule in it to decide with');
}

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
// The permission list is named rather than left to the module's own default - both resolve to the fetched
// bytes in `ruleDir`, and saying which one decided is cheaper than leaving a reader to work it out.
const derived = deriveAdmissibility(receipt, { toleratedSkipsPath: skipsPath });
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
  // THE RULE THIS PIN WAS ADMITTED UNDER, by the blob id of THE BYTES THAT DECIDED - fetched from
  // refs/heads/main over the API and verified against the sha the API reports for that path, never the blob
  // id of a file in this checkout. A reader re-checking this pin fetches these two blobs and re-derives; a pin
  // that named no rule would leave them to guess which rule had been applied, and a pin that named the
  // checkout's copy would name a rule that did not decide it.
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
fs.rmSync(ruleDir, { recursive: true, force: true });

// THE STRUCTURAL GROUND, ENFORCED. Everything above has passed; on a run that is not the protected branch's,
// what that establishes is a REPORT and not a pin. The report goes to stderr in prose, so that nothing
// downstream - a shell capturing stdout, a step that redirects it to a file, a reader skimming a log - can
// take it for the pin channel, and no `--out` file is written. The exit status is non-zero because a caller
// that asked for a pin did not get one.
if (!mayPin) {
  console.error(`REFUSING TO PIN: ${mayNotPinBecause}.`);
  console.error('ADVISORY - what this run found, which is a report and not evidence:');
  console.error(`ADVISORY   run ${pin.run_id} of ${pin.repository}, ${pin.workflow_path} at ${pin.workflow_ref}`);
  console.error(`ADVISORY   authority commit ${pin.workflow_head_sha}, attested at ${pin.attestation_workflow_ref}`);
  console.error(`ADVISORY   artifact ${pin.artifact_name} (${pin.artifact_id}) digest ${pin.artifact_digest}`);
  console.error(`ADVISORY   receipt digest ${pin.receipt_digest}, schema ${pin.receipt.schema}`);
  console.error(`ADVISORY   verdict ${JSON.stringify(pin.receipt.conclusion?.verdict ?? null)}, `
    + `admissible_as_pin ${JSON.stringify(pin.receipt.admissible_as_pin)}, `
    + `${derived.reasons.length} derived reason(s)`);
  console.error(`ADVISORY   decided with ${MODULE_PATH} blob ${moduleBlob} and ${TOLERATED_SKIPS} blob `
    + `${toleratedSkipsBlob}, both fetched from ${PROTECTED_REF}`);
  console.error('ADVISORY - no pin was emitted, and nothing above may be committed as one.');
  process.exit(4);
}
const serialised = `${JSON.stringify(pin, null, 2)}\n`;
if (out) fs.writeFileSync(out, serialised);
console.log(serialised);
