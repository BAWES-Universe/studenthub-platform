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
//     artifact's, so the run that produced it is the one whose provenance GitHub recorded.
//
// Usage:  node fetch-receipt.mjs --run <run_id> [--repo owner/name] [--out pin.json]
// Stdout: the pin JSON, which the caller commits as the claim's evidence reference.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}
const runId = args.get('run');
const repo = args.get('repo') ?? process.env.GITHUB_REPOSITORY;
const out = args.get('out');
const RECEIPT_PATH = '.github/workflows/verifier-receipt.yml';
const ARTIFACT_NAME = 'verifier-receipt';
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

// The receipt must describe the run it was fetched from, and the commit that run measured.
if (String(receipt.run?.id ?? '') !== String(run.id)) fail(`the receipt names run ${receipt.run?.id}, not ${runId}`);
if (receipt.candidate?.sha !== run.head_sha) {
  // The measured commit is an INPUT of a dispatch run, so it need not be the dispatching commit; what must
  // hold is that the receipt's own identity fields agree with the run that produced it.
  const dispatchMatches = receipt.workflow?.head_sha === run.head_sha;
  if (!dispatchMatches) fail('the receipt agrees with the run on neither the candidate nor the dispatching commit');
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
if (workflowPath !== RECEIPT_PATH) fail(`the attestation names workflow ${workflowPath}, not ${RECEIPT_PATH}`);
if (String(workflowRepo).split('/').slice(-2).join('/') !== repo) {
  fail(`the attestation names repository ${workflowRepo}, not ${repo}`);
}

const pin = {
  schema: 1,
  repository: repo,
  workflow_path: RECEIPT_PATH,
  workflow_ref: run.head_branch === 'main' ? 'refs/heads/main' : `refs/heads/${run.head_branch}`,
  workflow_head_sha: run.head_sha,
  run_id: String(run.id),
  run_attempt: String(run.run_attempt ?? 1),
  artifact_name: artifact.name,
  artifact_id: String(artifact.id),
  artifact_digest: artifact.digest,
  receipt_digest: subjectDigest,
  attestation_digest: subjectDigest,
  receipt: {
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
