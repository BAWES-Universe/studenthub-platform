// Emit the canonical receipt for one measurement, from evidence this process fetched itself.
//
// PROVENANCE IS THE PROPERTY. An earlier version of this file accepted a TAP stream from a path it was handed
// and asked whether the stream looked plausible. That rejects malformed fabrication and nothing else: a
// candidate whose own test file prints `ok 1 - a test that never ran` produces perfectly well-formed TAP. What
// makes a capture evidence is not its shape but where it came from, so this emitter refuses to read any byte it
// cannot trace to the trusted measure job of THIS workflow run:
//
//   * the run is read back from the API by id and must be this workflow's run, at this attempt;
//   * the `measure` job of that run must have concluded success;
//   * the capture must arrive as that run's own artifact, located by name through the API, whose digest GitHub
//     computed and which the archive GitHub serves actually hashes to;
//   * the capture's digest must have been taken IN THE TRUSTED JOB AS THE STREAM PASSED THROUGH IT, which the
//     meta records and this emitter requires by name. A review defeated the previous arrangement, where the
//     measure job redirected the runner into a file and hashed that file in the next step: the candidate's own
//     test bodies run in that step, as that user, so one of them renamed a forged stream over the capture and
//     the trusted job hashed the forgery. Every check in this list authenticates WHICH JOB uploaded the
//     artifact; this is the one that binds WHO WROTE THE BYTES INSIDE IT, as far as that can be bound at all;
//   * the capture must end in the trusted process's own TRAILER - one line, the last line, carrying the exit
//     status waitpid returned, the byte count and digest of the runner's own output, and this run's identity -
//     and that trailer must agree with the exit status the measure job published as a JOB OUTPUT, which
//     travels through GitHub rather than through the artifact. A review found that the one fact this emitter
//     held from outside the stream reached it inside the file a forger rewrites, and that the out-of-band
//     channel already existed with no consumer. Both ends are now read, and section 5b says exactly how far
//     that goes and where it stops;
//   * the artifact must carry the measure job's own capture-meta, and that meta must agree with the candidate
//     commit, the candidate tree the API reports for it, the trusted authority commit, and the runner key and
//     command taken from the protected enum - not from the candidate;
//   * the claim is fetched from the candidate commit through the contents API, never from an artifact and never
//     from a path anyone supplied.
//
// Nothing here is a path, a field, a command or an artifact the candidate chose. The candidate contributes the
// code under test and the claim it commits, and nothing else reaches this process.
//
// AND HERE IS THE LIMIT OF THAT SENTENCE, because two reviews have now shown versions of it to be false. The
// candidate also writes bytes into the capture - it cannot not, since the capture IS its suite's output stream -
// and a candidate that detaches a process outliving its own suite rewrites the capture and its meta together
// after the trusted job has written them. That second route is OPEN, it is blocking, and no check in this file
// closes it: only a uid boundary for the measured suite does. What this file adds against it is that the exit
// status can no longer be asserted apart from the bytes (section 5b), so the forgery a review ran three times
// out of three is now refused by name - and a forgery that also beats the job-output channel is not.
//
// Beneath both of those sits the limit no arrangement of jobs reaches: A TERM IS ESTABLISHED BY A NAME, AND THE
// CANDIDATE WRITES THE TESTS. Three empty function bodies with the claim's names produce a genuine verdict of
// success. What this workflow proves is the ORIGIN of the bytes and the identity of the code they were taken
// over; what it cannot prove is that a test named in the claim did the work the claim says it did. Every one of
// these is recorded in the receipt itself as `provenance.limits`, so no consumer has to infer any of them from
// what this file does not say.
//
// WHICH CODE WAS MEASURED, AND WHAT THAT ESTABLISHES. Two more questions decide whether a verdict means
// anything, and a review found both answered by a list GitHub truncates:
//
//   * does the candidate leave this authority alone? Settled in section 8 by the OBJECT ID of each authority
//     path on main and at the candidate - not by filtering a compare listing, which is capped at 300 entries,
//     sorted by filename, truncated with no flag, and which reports a rename under its new name only;
//   * is the claim about the code that ran? Settled in section 9: the claim names the measured commit or its
//     IMMEDIATE PARENT, that step is one commit wide, and the only paths it may touch are the claim's own
//     bookkeeping files, named exactly.
//
// And the verdict is per-term: every term the manifest lists is enumerated in the receipt with what this run
// established about it, so a term that names no test cannot ride to `success` on a sibling term's coverage.
// Per term and per test, `pass` means the runner reported a `type: 'test'` point ok with no TAP directive on
// it. A `# SKIP` marker and an empty `describe()` both put `ok` on the wire without executing anything, and
// neither is read as a measurement.
//
// DEFENCE IN DEPTH, AND NOT MORE THAN THAT. The TAP structure and count reconciliation further down is a check
// that the capture is WELL FORMED. It is not, and must never be described as, a check that it is GENUINE: a
// candidate's suite can emit any well-formed stream it likes. It is kept because it catches truncation, a
// concatenation of two runs, and a summary that does not add up - all of which would otherwise be read as a
// measurement. The receipt labels it as such.
//
// Fails closed everywhere, and every refusal names the field that did not match.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const env = process.env;
const GH = env.GH_BIN ?? 'gh';
const PY = env.PY_BIN ?? 'python3';

// Constants of the authority. None of them is an input, because an input is something a caller chooses.
const WORKFLOW_PATH = '.github/workflows/verifier-receipt.yml';
// The authority, named as OBJECTS rather than as a pattern to test a diff listing against. Section 8 explains
// why: a listing can be truncated and a rename can be reported under a name this set does not contain, but the
// object id GitHub reports for a path at a ref is neither truncated nor renameable.
const AUTHORITY_PATHS = [
  { dir: '.github/workflows', name: 'verifier-receipt.yml', kind: 'file' },
  { dir: '.github', name: 'verifier-receipt', kind: 'directory' },
];
const PROTECTED_REF = 'main';
const CLAIM_PATH = '.github/coordinator/service/claim-manifest.json';
// Paths inside a manifest entry's `artifact` field are relative to the manifest's own directory: the real
// manifest says `test/shu71-postpush-readback-checks.mjs` for a file this repository holds at
// `.github/coordinator/service/test/shu71-postpush-readback-checks.mjs`. Resolved here once, so the binding in
// section 10c compares repository paths rather than two different spellings of one.
const CLAIM_DIR = CLAIM_PATH.slice(0, CLAIM_PATH.lastIndexOf('/'));

// THE MANIFEST'S OWN VERDICT ON EACH TERM, AND THE ONLY VALUE OF IT THAT PERMITS THE WORD "ESTABLISHED".
//
// A cold review measured this on the repository's own pinned candidate and it is the finding that decides what
// this authority is for: all 53 entries of 7e7ac70e's claim-manifest.json carry `"disposition": "BLOCK"`, 12 of
// them carry `"approvable": false`, and this emitter read neither field, mentioned neither in the receipt, and
// reported `terms: 53 listed, 53 established`, `without_evidence: []`, `admissible as pin: true`. The receipt
// contradicted the claim it was validating: the authority's word "established" silently overrode the claim's own
// word "BLOCK", and a consumer that requires every `term.establishes === true` would have armed a change off 53
// terms the manifest itself says are not approvable.
//
// WHICH FIELD IS AUTHORITATIVE: `entries[].disposition`. It is the manifest's own per-term verdict, and this
// repository's generator writes exactly two values into it - measured over every commit that ever touched the
// manifest: `BLOCK` (53/53 at 7e7ac70e, 6feac01, e7e72ec; 46/46 at the seven older manifests) and `PASS` (2
// entries at 07fb13d, the commit whose message is "the verifier's receipt, and the manifest regenerated to carry
// it"). `PASS` is therefore the only value in this vocabulary that says the term is in a state where a term may
// be called established, and it is the only value this emitter accepts as one. An absent, null or unrecognised
// disposition is NOT read as permission: an entry that states no verdict states no permission.
//
// `approvable: false` is a SECOND and INDEPENDENT bar, and a permanent one: the 12 entries that carry it carry
// the reason "no mutant is paired with this control in the registry", and the manifest's own coverage block
// counts them as `controls_never_approvable_through_this_path: 12`. It is checked separately from the
// disposition so that a manifest which ever flipped one without the other is refused on whichever still says no.
//
// WHAT THIS CHECK IS, AND WHAT IT IS NOT. It is a CONTRADICTION check: it stops this receipt from saying more
// about a term than the term's own claim says. It is NOT an anti-forgery boundary - the candidate writes the
// manifest, so a candidate that wants `PASS` can write `PASS`, exactly as it can write the test names. What it
// buys is that such a candidate has to put the lie in its own committed file, where the receipt now carries it
// verbatim (`terms[].disposition`, `terms[].approvable`) for a reader and for the gate to re-read.
//
// AND THE ORDER THIS IMPLIES, because it is not circular and it must not be read as circular. A fresh manifest
// says BLOCK with the reason "no verifying receipt names this control at the code revision" precisely because no
// receipt exists yet. This authority does not resolve that inside one document. It emits a receipt that records
// the MEASUREMENT (`terms[].measured`) while establishing nothing; that receipt is what this repository's
// manifest routine consumes to regenerate the manifest with `disposition: PASS` for the entries that also have a
// paired mutant - which is what commit 07fb13d did - and a SECOND run against the regenerated manifest is the
// one that may establish them. The 12 entries with `approvable: false` never flip, by construction.
const ESTABLISHING_DISPOSITIONS = ['PASS'];
const CAPTURE_FILE = 'suite.out';
const META_FILE = 'capture-meta.json';
// A claim is normally committed on top of the code revision it names - the manifest cannot name the commit that
// contains it, because that commit's sha depends on the manifest's bytes. So the claim may name the measured
// commit itself, or that commit's IMMEDIATE PARENT, and nothing further: the justification reaches exactly one
// commit, so the rule may not reach further than one commit either. An earlier version of this file required
// only `status === 'ahead'`, which a review defeated by presenting a claim 137 commits behind the code that was
// measured.
//
// The widening is also narrow in FILES. The hard bound is the one that matters and it does not move: NO CODE
// PATH may change between the claim's code revision and the candidate, because the suite that ran would then
// not be the suite the claim describes. What may change is the claim's own bookkeeping, and the set below is
// exactly what this repository actually writes beside a manifest - measured over every commit that ever touched
// the manifest:
//
//   claim-manifest.json      11 commits     the claim itself
//   receipts/<name>.json      4 commits     the suite receipt the manifest pins; data, never read as evidence
//   suite-inventory.json      2 commits     the inventory the generator regenerates alongside
//
// A review found the previous list on the wrong side of this: it refused `receipts/*.json`, the file the
// routine really writes - 4 of 11 manifest commits, and it repinned the rehearsal candidate to dodge one - while
// tolerating `verifier-receipts.json`, a name that has never existed in 614 commits. Both are corrected here.
//
// The receipts directory is tolerated as a BOUNDED shape, not as a prefix. An earlier version allowlisted the
// whole prefix `.github/coordinator/service/receipts/`, an unbounded number of paths all sorting ahead of
// `apps/`, `packages/` and `tools/` - the exact filler for pushing real code changes off a truncated compare
// listing. That lever is now closed twice over: the listing itself is refused at COMPARE_FILE_CAP (so the
// filler can never be dense enough to truncate anything), and what the prefix admits is restricted to plain
// `.json` files sitting directly in that one directory. `receipts/x/y.ts`, `receipts/run.mjs` and
// `receipts/../../apps/x.ts` are all beyond the bookkeeping and all named in the refusal.
const CLAIM_ONLY = [
  '.github/coordinator/service/claim-manifest.json',
  '.github/coordinator/service/suite-inventory.json',
];
const CLAIM_ONLY_DIR = '.github/coordinator/service/receipts/';
const CLAIM_ONLY_DIR_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const isBookkeeping = name => CLAIM_ONLY.includes(name)
  || (name.startsWith(CLAIM_ONLY_DIR) && CLAIM_ONLY_DIR_ENTRY.test(name.slice(CLAIM_ONLY_DIR.length)));
// GitHub's compare endpoint returns at most this many entries in `files`, sorted by filename, and says nothing
// in the response about having truncated the list. Measured on this repository: 300 returned for a comparison
// that changed 429 files. A listing at or beyond the cap therefore bounds nothing, and is refused rather than
// read.
const COMPARE_FILE_CAP = 300;

const refuse = (field, message) => {
  console.error(`REFUSING: ${field}: ${message}`);
  process.exit(3);
};
const fail = message => refuse('capture.structure', message);
// A refusal has to be readable to be acted on, and a list of hundreds of paths is not. The count is always
// exact; only the enumeration is cut.
const listing = (names, limit = 10) => (names.length <= limit
  ? names.join(', ')
  : `${names.slice(0, limit).join(', ')}, and ${names.length - limit} more`);
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
// Names what a value IS, for a refusal that has to be read by someone fixing a manifest.
const shapeOf = value => (value === null ? 'literal `null`'
  : Array.isArray(value) ? 'a list'
    : typeof value === 'object' ? 'an object' : `a ${typeof value}`);
const need = name => {
  // An unset expression in a workflow arrives as the empty string, not as an absent variable, so both are the
  // same failure: the trusted workflow did not say which evidence this is.
  const value = env[name];
  if (value === undefined || value === '') {
    refuse(`env.${name}`, 'the trusted workflow must supply this; the emitter defaults nothing that identifies the evidence');
  }
  return value;
};

const api = (endpoint, { binary = false } = {}) => {
  try {
    return execFileSync(GH, ['api', endpoint], {
      encoding: binary ? 'buffer' : 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return null;
  }
};
const apiJson = endpoint => {
  const body = api(endpoint);
  if (body === null) return null;
  try { return JSON.parse(body); } catch { return null; }
};

const repo = need('REPO');
const runId = String(need('RUN_ID'));
const runAttempt = String(need('RUN_ATTEMPT'));
const trustedSha = need('TRUSTED_SOURCE_SHA');
const trustedOrigin = need('TRUSTED_SOURCE_ORIGIN');
const measureJobName = need('MEASURE_JOB_NAME');
const artifactName = need('MEASURE_ARTIFACT_NAME');
const expectedArtifactId = String(need('MEASURE_ARTIFACT_ID'));
const expectedArtifactDigest = need('MEASURE_ARTIFACT_DIGEST');
const candidateSha = need('CANDIDATE_SHA');
// Required, like every other field that identifies the evidence. It used to be the one optional input, and an
// unset workflow expression arrives as the empty string - exactly the case `need()` exists to catch - so the
// single cross-check that the measure job checked out the tree the API reports defaulted to being skipped.
const candidateTreeInput = need('CANDIDATE_TREE');
const runnerKey = need('RUNNER_KEY');
const runnerSpecPath = need('RUNNER_SPEC_PATH');
// THE ONE FACT ABOUT THE MEASUREMENT THAT DOES NOT TRAVEL INSIDE THE ARTIFACT. The measure job takes the
// runner's exit status from waitpid in its trusted capture process and publishes it as that job's own output;
// the workflow passes it here. A review found this channel already built and unused - the job declared the
// output and no step in the repository read it - so the single fact the emitter held from OUTSIDE the stream
// reached it through capture-meta.json, i.e. through a file a candidate's detached process rewrites along with
// the capture. Required, not optional: an emitter that silently skips this check when the workflow forgets to
// pass it is an emitter with no out-of-band channel at all.
const jobOutputExit = String(need('MEASURE_SUITE_EXIT'));
if (!/^\d+$/.test(jobOutputExit)) {
  refuse('measure_job.exit', `the measure job published ${JSON.stringify(jobOutputExit)} as the suite's exit `
    + 'status, which is not a number a process exited with');
}
const outPath = env.OUT_PATH ?? path.join(process.cwd(), 'receipt.json');
if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
  refuse('candidate.sha', `not a full commit sha: ${candidateSha}`);
}
if (!/^[0-9a-f]{40}$/.test(trustedSha)) {
  refuse('workflow.trusted_source_sha', `not a full commit sha: ${trustedSha}`);
}

// 1. The runner command is the protected enum's, read from the authority checkout by key. The dispatch chooses
//    a key; it cannot choose, extend or escape the command the key names.
const runnerSpec = (() => {
  let body;
  try { body = JSON.parse(fs.readFileSync(runnerSpecPath, 'utf8')); }
  catch { return refuse('runner.spec', `the runner enum is not readable at ${runnerSpecPath}`); }
  const spec = body.runners?.[runnerKey];
  if (!spec?.command) {
    refuse('runner.key', `"${runnerKey}" is not a key of the protected runner enum `
      + `(${Object.keys(body.runners ?? {}).join(', ') || 'none'})`);
  }
  return spec;
})();
const runnerCommand = runnerSpec.command;

// 2. The run, read back from the API by id. Everything downstream is scoped to this run, so if this is not the
//    run the emitter is executing inside, nothing it fetches is this run's evidence.
const run = apiJson(`/repos/${repo}/actions/runs/${runId}`);
if (!run) refuse('run.id', `the API reports no run ${runId} in ${repo}`);
if (String(run.id) !== runId) refuse('run.id', `the API returned run ${run.id} for a request for run ${runId}`);
if (run.path !== WORKFLOW_PATH) refuse('workflow.path', `run ${runId} is ${run.path}, not ${WORKFLOW_PATH}`);
if (String(run.run_attempt ?? 1) !== runAttempt) {
  refuse('run.attempt', `run ${runId} is at attempt ${run.run_attempt}, but this process was told attempt ${runAttempt}`);
}

// 3. The measure job of this run, at this attempt, must have concluded success. A capture from a job that failed,
//    was cancelled, or is still running is not a measurement.
const jobs = apiJson(`/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs`)?.jobs ?? null;
if (!jobs) refuse('measure_job.name', `the API reports no jobs for run ${runId} attempt ${runAttempt}`);
const measureJob = jobs.find(job => job.name === measureJobName);
if (!measureJob) {
  refuse('measure_job.name', `run ${runId} attempt ${runAttempt} has no job named "${measureJobName}" `
    + `(it has: ${jobs.map(job => job.name).join(' | ')})`);
}
if (measureJob.status !== 'completed') {
  refuse('measure_job.status', `the measure job of run ${runId} is ${measureJob.status}, not completed`);
}
if (measureJob.conclusion !== 'success') {
  refuse('measure_job.conclusion', `the measure job of run ${runId} concluded ${measureJob.conclusion}, not success`);
}

// 4. The artifact, located by name inside THIS run. Its digest is computed by GitHub on upload, so it is not a
//    number the uploader chooses; the archive the API serves must hash to it, or the bytes are not the bytes
//    GitHub digested. Both facts are also cross-checked against what the trusted measure job reported.
const artifacts = apiJson(`/repos/${repo}/actions/runs/${runId}/artifacts`)?.artifacts ?? null;
if (!artifacts) refuse('artifact.name', `the API reports no artifacts for run ${runId}`);
const artifact = artifacts.find(entry => entry.name === artifactName);
if (!artifact) {
  refuse('artifact.name', `run ${runId} holds no artifact named "${artifactName}" `
    + `(it holds: ${artifacts.map(entry => entry.name).join(' | ') || 'none'})`);
}
if (artifact.expired) refuse('artifact.expired', `the "${artifactName}" artifact of run ${runId} has expired`);
if (String(artifact.workflow_run?.id ?? '') !== runId) {
  refuse('artifact.workflow_run.id', `artifact ${artifact.id} belongs to run ${artifact.workflow_run?.id}, not ${runId}`);
}
if (String(artifact.id) !== expectedArtifactId) {
  refuse('artifact.id', `the measure job uploaded artifact ${expectedArtifactId}, but the API names ${artifact.id} `
    + `as this run's "${artifactName}"`);
}
if (String(artifact.digest ?? '') !== expectedArtifactDigest) {
  refuse('artifact.digest', `the measure job reported ${expectedArtifactDigest} for its artifact, but the API `
    + `reports ${artifact.digest}`);
}
if (!/^sha256:[0-9a-f]{64}$/.test(String(artifact.digest ?? ''))) {
  refuse('artifact.digest', `the API reports no usable digest for artifact ${artifact.id}: ${artifact.digest}`);
}

const archive = api(`/repos/${repo}/actions/artifacts/${artifact.id}/zip`, { binary: true });
if (!archive) refuse('artifact.archive', `the artifact archive for ${artifact.id} could not be downloaded`);
const archiveDigest = `sha256:${sha256(archive)}`;
if (archiveDigest !== artifact.digest) {
  refuse('artifact.digest', `the archive GitHub served for artifact ${artifact.id} hashes to ${archiveDigest}, `
    + `but GitHub reports its digest as ${artifact.digest}`);
}

// 5. The capture inside the archive. The measure job uploads exactly two files it wrote itself; anything else in
//    there means the artifact is not the one this authority defines.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
const archivePath = path.join(work, 'artifact.zip');
fs.writeFileSync(archivePath, archive);
let entries;
try {
  entries = JSON.parse(execFileSync(PY, ['-c', [
    'import json, sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    '    names = sorted(archive.namelist())',
    '    for name in names:',
    '        if name in (sys.argv[3], sys.argv[4]):',
    '            open(sys.argv[2] + "/" + name, "wb").write(archive.read(name))',
    '    print(json.dumps(names))',
  ].join('\n'), archivePath, work, CAPTURE_FILE, META_FILE], { encoding: 'utf8' }));
} catch {
  refuse('artifact.archive', `the artifact archive for ${artifact.id} is not readable as a zip`);
}
const expectedEntries = [CAPTURE_FILE, META_FILE].sort();
if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
  refuse('artifact.contents', `the "${artifactName}" artifact holds ${JSON.stringify(entries)}, but the measure `
    + `job uploads exactly ${JSON.stringify(expectedEntries)}`);
}

const captureBytes = fs.readFileSync(path.join(work, CAPTURE_FILE));
let meta;
try { meta = JSON.parse(fs.readFileSync(path.join(work, META_FILE), 'utf8')); }
catch { refuse('capture.meta', `${META_FILE} in the artifact is not readable JSON`); }
const captureDigest = sha256(captureBytes);
if (meta.capture_sha256 !== captureDigest) {
  refuse('capture.sha256', `the measure job recorded ${meta.capture_sha256} for its capture, but the bytes in `
    + `the artifact hash to ${captureDigest}`);
}
// WHERE THAT DIGEST CAME FROM IS PART OF THE EVIDENCE. The check above is only worth something if the two sides
// of it are independent. It used to compare a file the measure job had read back from disk against the same
// file's bytes in the artifact - and a review defeated exactly that: the candidate's own suite renamed a forged
// stream over the capture BEFORE the trusted step hashed it, so both sides read the forgery and agreed.
//
// The measure job now hashes the stream in a trusted process as it passes through, and records HOW in the meta.
// A meta that does not say `stream` is a meta produced by a job that hashed something it had read back, which is
// the defeated shape, and it is refused by name rather than trusted. This cannot be satisfied by a candidate
// saying so: the field is checked against the digest above, which is over the artifact's bytes, and the whole
// meta is bound to this run by the fields in section 6.
if (meta.capture_hash_source !== 'stream') {
  refuse('capture.hash_source', `the capture records its digest as ${JSON.stringify(meta.capture_hash_source ?? null)}, `
    + 'not as `stream`: this authority accepts only a capture whose digest was taken in the trusted job as the '
    + 'bytes passed through it, because a digest taken over a file the measured suite could have replaced '
    + 'authenticates nothing about who wrote those bytes');
}
if (Number(meta.capture_bytes) !== captureBytes.length) {
  refuse('capture.bytes', `the capture records ${JSON.stringify(meta.capture_bytes ?? null)} bytes, but the `
    + `artifact holds ${captureBytes.length}`);
}

// 5b. THE TRAILER: THE ONE LINE OF THE CAPTURE THE MEASURED CODE DID NOT WRITE.
//
// A review put the previous arrangement precisely: the emitter's two strongest well-formedness invariants - a
// non-zero exit must come with a failing point, a zero exit must come with none - were described in this file
// as "the only two checks that read a fact from OUTSIDE the stream". They did not. They read `meta.suite_exit`,
// i.e. a field of capture-meta.json, i.e. a file inside the artifact; and the forgery that rewrites the capture
// rewrites the meta beside it, so both operands of both invariants were the forger's and both were satisfied.
//
// So the exit status is no longer a fact stated BESIDE the bytes. The trusted capture process appends one
// trailer line to the stream after the runner is gone and hashes it with the rest, and this section requires:
//
//   * exactly one such line in the whole capture, and it is the LAST line. A test body that prints its own copy
//     therefore makes the capture refused rather than making its own line the one that is read;
//   * the capture is EXACTLY the runner's output followed by that trailer - reconstructed byte for byte from
//     the trailer's own body length, not from anything the meta says;
//   * the runner's output hashes to the digest the trailer carries;
//   * the trailer's identity fields are this run, this job, this candidate, this runner;
//   * the exit status agrees across all three channels it now travels in: the trailer (inside the hashed
//     bytes), the meta (beside them) and the measure job's own output (through GitHub, outside the artifact).
//
// What that is worth, stated exactly: a forgery that rewrites suite.out and capture-meta.json together is now
// refused at `capture.suite_exit`, because it cannot reach the job output. A forgery that ALSO appends to
// $GITHUB_OUTPUT - which a same-uid process can locate through /proc - is not refused by anything here. That
// residual is open, it is recorded in `provenance.limits`, and only a uid boundary for the measured suite
// closes it.
const TRAILER_PREFIX = '# verifier-capture v1 ';
const TRAILER_FIELDS = ['exit', 'signal', 'body_bytes', 'body_sha256', 'run', 'attempt', 'job', 'candidate',
  'tree', 'runner'];
const trailer = (() => {
  const whole = captureBytes.toString('utf8');
  if (!whole.endsWith('\n')) {
    refuse('capture.trailer', 'the capture does not end with a newline, so it does not end with the trailer the '
      + 'trusted capture process appends after the runner is gone');
  }
  const lines = whole.slice(0, -1).split('\n');
  const at = lines.flatMap((line, index) => (line.startsWith(TRAILER_PREFIX) ? [index] : []));
  if (at.length === 0) {
    refuse('capture.trailer', 'the capture carries no `' + TRAILER_PREFIX.trim() + '` line: this is not a capture '
      + 'the trusted process of this authority wrote, or its bytes were replaced by ones that are not');
  }
  if (at.length > 1) {
    refuse('capture.trailer', `the capture carries ${at.length} \`${TRAILER_PREFIX.trim()}\` lines, at lines `
      + `${at.map(index => index + 1).join(', ')}; the trusted process writes exactly one, so a second is either `
      + 'a line the measured code printed or two captures concatenated');
  }
  if (at[0] !== lines.length - 1) {
    refuse('capture.trailer', `the capture's trailer is at line ${at[0] + 1} of ${lines.length}, not at the end; `
      + 'the trusted process appends it after the runner\'s last byte, so anything after it was written later');
  }
  const line = lines[at[0]];
  const pairs = line.slice(TRAILER_PREFIX.length).split(' ').map(part => {
    const split = part.indexOf('=');
    return split < 0 ? [part, null] : [part.slice(0, split), decodeURIComponent(part.slice(split + 1))];
  });
  if (JSON.stringify(pairs.map(([key]) => key)) !== JSON.stringify(TRAILER_FIELDS)) {
    refuse('capture.trailer', `the capture's trailer carries ${JSON.stringify(pairs.map(([key]) => key))}, not `
      + `the ${JSON.stringify(TRAILER_FIELDS)} the trusted process writes`);
  }
  const fields = Object.fromEntries(pairs);
  if (!/^\d+$/.test(fields.body_bytes) || !/^[0-9a-f]{64}$/.test(fields.body_sha256)) {
    refuse('capture.trailer', `the capture's trailer states body_bytes=${JSON.stringify(fields.body_bytes)} and `
      + `body_sha256=${JSON.stringify(fields.body_sha256)}, which are not a byte count and a digest`);
  }
  // The split is taken from the TRAILER's own byte count - a number inside the hashed bytes - and then the
  // remainder is required to be exactly the region the trusted process appends. Nothing here reads the meta:
  // the capture is made to account for itself, byte for byte, before any field beside it is believed.
  const bodyLength = Number(fields.body_bytes);
  if (bodyLength > captureBytes.length) {
    refuse('capture.trailer', `the capture's trailer states ${bodyLength} bytes of runner output, but the whole `
      + `capture is ${captureBytes.length} bytes`);
  }
  const body = captureBytes.subarray(0, bodyLength);
  const separator = body.length > 0 && body[body.length - 1] === 0x0a ? '' : '\n';
  const expected = Buffer.from(`${separator}${line}\n`, 'utf8');
  if (!captureBytes.subarray(bodyLength).equals(expected)) {
    refuse('capture.trailer', `the capture is not ${bodyLength} bytes of runner output followed by this job's `
      + 'trailer: what follows the runner\'s output is not the trailer line this capture carries');
  }
  const bodyDigest = sha256(body);
  if (bodyDigest !== fields.body_sha256) {
    refuse('capture.trailer.body_sha256', `the capture's trailer records ${fields.body_sha256} for the runner's `
      + `own output, but those ${bodyLength} bytes hash to ${bodyDigest}`);
  }
  return { line, fields, body, bodyDigest };
})();
const captureBody = trailer.body;

// 6. The meta must describe this run, this candidate, this authority and this runner. Each of these is a field
//    the emitter also knows from somewhere else, so a capture lifted from another run fails one of them by name.
const metaChecks = [
  ['capture.run_id', String(meta.run_id ?? ''), runId, 'the run the capture was taken in'],
  ['capture.run_attempt', String(meta.run_attempt ?? ''), runAttempt, 'the attempt the capture was taken in'],
  ['capture.job_name', String(meta.job_name ?? ''), measureJobName, 'the job that took the capture'],
  ['capture.candidate_sha', String(meta.candidate_sha ?? ''), candidateSha, 'the candidate the capture measured'],
  ['capture.trusted_source_sha', String(meta.trusted_source_sha ?? ''), trustedSha, 'the authority commit the measure job ran from'],
  ['capture.runner_key', String(meta.runner_key ?? ''), runnerKey, 'the runner key the measurement used'],
  ['capture.runner_command', String(meta.runner_command ?? ''), runnerCommand, 'the command the measurement ran'],
];
for (const [field, actual, expected, what] of metaChecks) {
  if (actual !== expected) {
    refuse(field, `the capture reports ${JSON.stringify(actual)} as ${what}, but this run requires ${JSON.stringify(expected)}`);
  }
}

// 6b. THE TRAILER SAYS WHICH MEASUREMENT THIS IS, AND THE EXIT STATUS AGREES ACROSS EVERY CHANNEL IT TRAVELS IN.
//
// The fields above bind the META to this run. These bind the bytes: a capture lifted whole from another run -
// meta and all - now also has to carry a trailer naming that other run inside the hashed stream, and the
// digest that covers the trailer is the digest GitHub computed for the artifact.
const trailerChecks = [
  ['capture.trailer.run', trailer.fields.run, runId, 'the run the capture was taken in'],
  ['capture.trailer.attempt', trailer.fields.attempt, runAttempt, 'the attempt the capture was taken in'],
  ['capture.trailer.job', trailer.fields.job, measureJobName, 'the job that took the capture'],
  ['capture.trailer.candidate', trailer.fields.candidate, candidateSha, 'the candidate the capture measured'],
  ['capture.trailer.runner', trailer.fields.runner, runnerKey, 'the runner key the measurement used'],
];
for (const [field, actual, expected, what] of trailerChecks) {
  if (actual !== expected) {
    refuse(field, `the capture's own trailer names ${JSON.stringify(actual)} as ${what}, but this run requires `
      + `${JSON.stringify(expected)}`);
  }
}
// The meta's account of the runner's output must be the trailer's account of it. Both are in the artifact, so
// this is not independence - it is the check that stops the two halves of the artifact from disagreeing and
// the emitter from picking whichever one it read first.
const metaBodyChecks = [
  ['capture.body_bytes', String(meta.capture_body_bytes ?? ''), trailer.fields.body_bytes, 'the bytes the runner wrote'],
  ['capture.body_sha256', String(meta.capture_body_sha256 ?? ''), trailer.fields.body_sha256, 'the digest of the bytes the runner wrote'],
  ['capture.trailer', String(meta.capture_trailer ?? ''), trailer.line, 'the trailer this job appended'],
];
for (const [field, actual, expected, what] of metaBodyChecks) {
  if (actual !== expected) {
    refuse(field, `the capture's meta records ${JSON.stringify(actual)} as ${what}, but the capture's own `
      + `trailer records ${JSON.stringify(expected)}`);
  }
}
if (meta.suite_exit_source !== 'waitpid') {
  refuse('capture.suite_exit_source', `the capture records its suite exit status as coming from `
    + `${JSON.stringify(meta.suite_exit_source ?? null)}, not from \`waitpid\`: this authority accepts only an `
    + 'exit status the trusted capture process took from the runner itself, never one read back from a file or '
    + 'a step output the measured code can append to');
}

// THE EXIT STATUS, TRIANGULATED. Three channels, and every one of them must say the same number:
//
//   * the trailer, INSIDE the hashed bytes, so it cannot be stated apart from the stream that justifies it;
//   * the meta, beside them, which is what this file used to read and nothing else;
//   * the measure job's own output, which travels through GitHub rather than through the artifact.
//
// The reviewer's forgery rewrites the first two together and is refused here by name. A forgery that also
// beats the third is not, and that is stated in `provenance.limits` rather than implied to be closed.
const trailerExit = trailer.fields.exit;
if (!/^\d+$/.test(trailerExit)) {
  refuse('capture.suite_exit', `the capture's trailer records no numeric suite exit code: ${JSON.stringify(trailerExit)}`);
}
if (trailerExit !== jobOutputExit) {
  refuse('capture.suite_exit', `the measure job published exit ${jobOutputExit} as its own output, taken from `
    + `waitpid in the trusted capture process, but the capture's trailer says ${trailerExit}; the bytes in this `
    + 'artifact are not the bytes that run produced');
}
const suiteExit = String(meta.suite_exit ?? '');
if (!/^\d+$/.test(suiteExit)) refuse('capture.suite_exit', `the capture records no numeric suite exit code: ${meta.suite_exit}`);
if (suiteExit !== trailerExit) {
  refuse('capture.suite_exit', `the capture's meta records suite exit ${suiteExit}, but the trailer inside the `
    + `hashed bytes records ${trailerExit}`);
}

// 7. The candidate commit, read back from the API. The tree is GitHub's answer for that sha, so the receipt's
//    tree is not a number the measure job could have mistyped.
const candidateCommit = apiJson(`/repos/${repo}/commits/${candidateSha}`);
if (!candidateCommit) refuse('candidate.sha', `the API reports no commit ${candidateSha} in ${repo}`);
const candidateTree = candidateCommit.commit?.tree?.sha ?? null;
if (!candidateTree) refuse('candidate.tree', `the API reports no tree for commit ${candidateSha}`);
if (candidateTreeInput !== candidateTree) {
  refuse('candidate.tree', `the measure job checked out tree ${candidateTreeInput}, but the API reports `
    + `${candidateTree} for ${candidateSha}`);
}
if (!meta.candidate_tree) {
  refuse('capture.candidate_tree', 'the capture records no candidate tree, so it does not say which tree was measured');
}
if (meta.candidate_tree !== candidateTree) {
  refuse('capture.candidate_tree', `the capture records tree ${meta.candidate_tree}, but the API reports `
    + `${candidateTree} for ${candidateSha}`);
}
// And the same fact inside the hashed bytes. The tree is checked here rather than with the other trailer
// fields in 6b because this is where the API's answer for the candidate is known: the meta's tree and the
// trailer's tree are each compared to GitHub, not to one another.
if (trailer.fields.tree !== candidateTree) {
  refuse('capture.trailer.tree', `the capture's own trailer names tree ${trailer.fields.tree}, but the API `
    + `reports ${candidateTree} for ${candidateSha}`);
}

// 8. A candidate that alters the receipt authority cannot be approved by a receipt this authority produces.
//
//    This is settled by OBJECT IDENTITY, not by reading a diff listing. Two reviews of the listing form found
//    the same two holes in it. (a) GitHub's compare endpoint caps `files` at 300, sorts it by filename and
//    truncates it with no flag anywhere in the response - measured on this repository, 300 entries returned for
//    a comparison that changed 429 files - so a candidate that adds 300 files sorting before `.github/v...`
//    pushes its own authority edit off the end of the list, and the check reports `touches_authority: false`.
//    (b) A rename is reported under its NEW name, with the old path only in `previous_filename`, so moving
//    `.github/verifier-receipt/emit-receipt.mjs` to `.github/parked/` - which deletes the authority - matched
//    no pattern at all.
//
//    Asking GitHub for the object id of each authority path, at main and at the candidate, closes both: a
//    directory's sha covers every byte under it however many other files the candidate touched, an absent path
//    answers with no sha at all, and neither answer is a page of a list. Unreadable is refused, not skipped.
const objectAt = (dir, name, ref) => {
  const listing = apiJson(`/repos/${repo}/contents/${encodeURI(dir)}?ref=${ref}`);
  if (!Array.isArray(listing)) return { listed: false, sha: null, type: null };
  const found = listing.find(item => item.name === name);
  return { listed: true, sha: found?.sha ?? null, type: found?.type ?? null };
};
const authorityIdentity = AUTHORITY_PATHS.map(entry => {
  const full = `${entry.dir}/${entry.name}`;
  const onProtected = objectAt(entry.dir, entry.name, PROTECTED_REF);
  if (!onProtected.listed) {
    refuse('candidate.authority', `the API cannot list ${entry.dir} on ${PROTECTED_REF}, so this run cannot `
      + `establish what ${full} is on the protected branch`);
  }
  const onCandidate = objectAt(entry.dir, entry.name, candidateSha);
  if (!onCandidate.listed) {
    refuse('candidate.authority', `the API cannot list ${entry.dir} at ${candidateSha.slice(0, 12)}, so this run `
      + `cannot establish that the candidate leaves ${full} alone`);
  }
  return { path: full, kind: entry.kind, protected_sha: onProtected.sha, candidate_sha: onCandidate.sha };
});
const altered = authorityIdentity.filter(entry => entry.protected_sha !== entry.candidate_sha);
if (altered.length > 0) {
  const how = altered.map(entry => {
    if (entry.candidate_sha === null) return `${entry.path} is absent at the candidate (deleted or renamed away)`;
    if (entry.protected_sha === null) return `${entry.path} is absent on ${PROTECTED_REF} but present at the candidate`;
    return `${entry.path} is ${entry.candidate_sha.slice(0, 12)} at the candidate, not ${entry.protected_sha.slice(0, 12)}`;
  });
  refuse('candidate.authority', `this candidate alters the receipt authority (${how.join('; ')}), so no receipt `
    + 'this authority produces may approve it');
}

// 9. The claim, fetched from the candidate commit through the contents API. Not from the artifact, not from a
//    path a caller passed: the claim's address is fixed here and its revision is the candidate's own sha.
const claimResponse = apiJson(`/repos/${repo}/contents/${CLAIM_PATH}?ref=${candidateSha}`);
if (!claimResponse?.content) {
  refuse('claim.path', `commit ${candidateSha.slice(0, 12)} carries no ${CLAIM_PATH}, so it makes no claim this `
    + 'run could measure');
}
const claimBytes = Buffer.from(claimResponse.content, 'base64');
let manifest;
try { manifest = JSON.parse(claimBytes.toString('utf8')); }
catch { refuse('claim.json', `${CLAIM_PATH} at ${candidateSha.slice(0, 12)} is not readable JSON`); }

// THE CLAIM BODY IS A CONTAINER TOO, AND A WRONG CONTAINER IS A REFUSAL RATHER THAN A CRASH. A review found a
// claim of literal `null` crashing the next line with an unhandled TypeError - fail-closed in effect, but in the
// log indistinguishable from a broken workflow, so a malformed candidate manifest read as an infrastructure
// fault instead of as a refused claim. A bare string, a number and a list already refused by name below; `null`
// did not, because `null.code_revision` throws before any refusal is reached.
if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
  refuse('claim.json', `${CLAIM_PATH} at ${candidateSha.slice(0, 12)} is ${shapeOf(manifest)}, not an object, `
    + 'so it states no code revision and names no terms');
}

const claimedHead = manifest.code_revision?.head ?? null;
const short = String(claimedHead).slice(0, 12);
let claimDelta = [];
if (claimedHead !== candidateSha) {
  // ONE COMMIT, AND ONE COMMIT ONLY. The reason a claim may name a revision other than the commit measured is
  // that the manifest's own bytes are part of the commit that carries it, so it names the commit it was written
  // on top of - its parent. That reason reaches exactly one commit, so this rule does too, and it is expressed
  // twice over: the named revision must BE one of the measured commit's parents (GitHub's answer for the
  // commit, not a distance), and the comparison must be one commit wide.
  if (!/^[0-9a-f]{40}$/.test(String(claimedHead ?? ''))) {
    refuse('claim.code_revision.head', `the claim names ${JSON.stringify(claimedHead)} as its code revision, `
      + 'which is not a full commit sha');
  }
  const parents = (candidateCommit.parents ?? []).map(parent => parent.sha);
  if (!parents.includes(claimedHead)) {
    refuse('claim.code_revision.head', `the claim names ${short} as its code revision, but that is neither the `
      + `measured commit ${candidateSha.slice(0, 12)} nor one of its parents `
      + `(${parents.map(sha => sha.slice(0, 12)).join(', ') || 'none'}); a claim may only be committed directly `
      + 'on top of the revision it names');
  }
  const step = apiJson(`/repos/${repo}/compare/${claimedHead}...${candidateSha}`);
  if (!step) {
    refuse('claim.code_revision.head', `the claim names ${short} as its code revision, and GitHub cannot compare `
      + `that to the measured commit ${candidateSha.slice(0, 12)}`);
  }
  if (step.status !== 'ahead') {
    refuse('claim.code_revision.head', `the claim names ${short} as its code revision, but the measured commit `
      + `${candidateSha.slice(0, 12)} is ${step.status} of it, not a descendant`);
  }
  const aheadBy = Number(step.ahead_by);
  const totalCommits = Number(step.total_commits);
  if (!Number.isInteger(aheadBy) || !Number.isInteger(totalCommits)) {
    refuse('claim.code_revision.head', `the claim names ${short} as its code revision, and GitHub's comparison `
      + `to ${candidateSha.slice(0, 12)} reports no commit count, so the width of the step is unknown`);
  }
  if (aheadBy !== 1 || totalCommits !== 1) {
    refuse('claim.code_revision.head', `the claim names ${short} as its code revision, but the measured commit `
      + `${candidateSha.slice(0, 12)} is ${aheadBy} commit(s) and ${totalCommits} total commit(s) ahead of it; `
      + 'the only widening this authority allows is the one commit that carries the claim itself');
  }
  // The delta is read from a list GitHub caps and silently truncates, so the cap is a refusal, not a boundary
  // to read up to. An absent list is a refusal too: `(step.files ?? [])` read as "nothing changed", which is
  // the fail-open reading of "GitHub did not say".
  if (!Array.isArray(step.files)) {
    refuse('claim.code_revision.delta', `GitHub's comparison of ${short} to ${candidateSha.slice(0, 12)} carries `
      + 'no file list, so what that commit changed cannot be bounded');
  }
  if (step.files.length >= COMPARE_FILE_CAP) {
    refuse('claim.code_revision.delta', `GitHub's comparison of ${short} to ${candidateSha.slice(0, 12)} lists `
      + `${step.files.length} files, at or beyond the ${COMPARE_FILE_CAP}-file cap where that list is truncated `
      + 'with no flag; a truncated list bounds nothing, and one commit of the claim\'s own bookkeeping is never '
      + 'this wide');
  }
  // A rename is reported under its new name, so a commit that renames `apps/x.ts` ONTO a bookkeeping path
  // would pass a check that reads `filename` alone. Both ends of every entry are tested.
  claimDelta = step.files.map(file => file.filename);
  const beyond = [...new Set(step.files
    .flatMap(file => [file.filename, file.previous_filename].filter(Boolean))
    .filter(name => !isBookkeeping(name)))];
  if (beyond.length > 0) {
    refuse('claim.code_revision.head', `the claim names ${short} as its code revision, but the measured commit `
      + `${candidateSha.slice(0, 12)} changes code beyond the claim's own bookkeeping `
      + `(${beyond.length} path(s): ${listing(beyond)}), so the suite that ran is not the suite `
      + 'the claim describes');
  }
}
const claimedCommit = claimedHead === candidateSha ? candidateCommit : apiJson(`/repos/${repo}/commits/${claimedHead}`);
if (!claimedCommit) refuse('claim.code_revision.head', `the API reports no commit ${claimedHead} in ${repo}`);
if (manifest.code_revision?.tree !== claimedCommit.commit?.tree?.sha) {
  refuse('claim.code_revision.tree', `the claim names tree ${manifest.code_revision?.tree} for its code revision, `
    + `but the API reports ${claimedCommit.commit?.tree?.sha} for ${String(claimedHead).slice(0, 12)}`);
}

// THE CLAIM'S SHAPE IS SETTLED BEFORE ANY COVERAGE IS COMPUTED, AND AN INVALID SHAPE IS A REFUSAL.
//
// The manifest is read from the CANDIDATE, so its shape is the candidate's to choose, and two shapes it could
// choose used to defeat the per-term rule outright - because a term's coverage was looked up by term ID over a
// flat list of named tests, so entries that shared an id pooled their tests:
//
//   * two entries SHARING one id - `TERM-X` twice, the first naming a test that passes and the second naming
//     nothing at all - reported `named: 1, pass: 1, establishes: true` on BOTH rows. Ten such entries
//     established ten terms off one test.
//   * two entries with NO id at all - `entry.id ?? null` read both as `null`, which pooled them identically.
//
// Either produced verdict success with no reason recorded anywhere, and the workflow's gate step could not
// catch it: its per-term check is `!(term.named > 0)` and the pooled row reports `named: 1`, so the second
// reader re-read the very field the first one had inflated.
//
// A term id is therefore required to be present, a non-empty string, and unique across the manifest. None of
// those is a thing to guess at: a claim whose terms cannot be told apart is not a claim this run can measure
// term by term, and the honest answer is to refuse it by name rather than to measure something else and report
// the result under the claim's name. An absent `entries` is NOT this refusal - it is a claim that lists no
// terms, which the verdict below already records as establishing nothing.
const claimEntries = manifest.entries ?? [];
if (!Array.isArray(claimEntries)) {
  refuse('claim.entries', `${CLAIM_PATH} at ${candidateSha.slice(0, 12)} carries \`entries\` as `
    + `a ${typeof claimEntries}, not a list of terms, so this run has no terms it could measure`);
}
const notObjects = claimEntries.flatMap((entry, index) => (entry !== null && typeof entry === 'object'
  && !Array.isArray(entry)
  ? []
  : [`${index} (${entry === null ? 'null' : Array.isArray(entry) ? 'a list' : typeof entry})`]));
if (notObjects.length > 0) {
  refuse('claim.entries', `${notObjects.length} entry/entries of ${CLAIM_PATH} at `
    + `${candidateSha.slice(0, 12)} are not objects, so they name no term: entry ${listing(notObjects)}`);
}
// An id that is absent, null, not a string, or blank names nothing. It is refused rather than defaulted,
// because the default - `null` - is itself a colliding id, and every such entry would share one bucket.
const unnamed = claimEntries.flatMap((entry, index) => (typeof entry.id === 'string' && entry.id.trim() !== ''
  ? []
  : [`${index} (${entry.id === undefined ? 'absent' : JSON.stringify(entry.id)})`]));
if (unnamed.length > 0) {
  refuse('claim.entries.id', `${unnamed.length} entry/entries of ${CLAIM_PATH} at `
    + `${candidateSha.slice(0, 12)} carry no term id, so the claim does not say which term they are about, and `
    + `a term this run cannot name is a term it cannot measure: entry ${listing(unnamed)}`);
}
// AND THE TWO CONTAINERS THE COVERAGE JOIN ITERATES. The block above validated `entries` and `entries[].id`
// but not `control.test_names` or `killing_mutants`, which a review then supplied as strings: `.map is not a
// function` and `.filter is not a function`, unhandled, with no field named. A container of the wrong type is
// the candidate's mistake in the candidate's own file and it is refused as one. `absent` stays absent - a term
// that names no control and no mutant is a term this run establishes nothing about, which the verdict already
// records - so only a PRESENT value of the wrong shape refuses here.
const containers = [];
claimEntries.forEach((entry, index) => {
  const control = entry.control;
  if (control !== undefined && control !== null && (typeof control !== 'object' || Array.isArray(control))) {
    containers.push(['claim.entries.control', index, `\`control\` as ${shapeOf(control)}, not an object`]);
    return;
  }
  const names = control?.test_names;
  if (names !== undefined && names !== null && !Array.isArray(names)) {
    containers.push(['claim.entries.control.test_names', index,
      `\`control.test_names\` as ${shapeOf(names)}, not a list of test names`]);
  }
  const mutants = entry.killing_mutants;
  if (mutants !== undefined && mutants !== null && !Array.isArray(mutants)) {
    containers.push(['claim.entries.killing_mutants', index,
      `\`killing_mutants\` as ${shapeOf(mutants)}, not a list of mutants`]);
  } else if (Array.isArray(mutants)) {
    // `[null]` and `['x']` are the same mistake one level down: the join reads `mutant.test_name`, which throws
    // on null and is silently undefined on a string, so an element that is not an object is named here too.
    const bad = mutants.flatMap((mutant, at) => (mutant !== null && typeof mutant === 'object' && !Array.isArray(mutant)
      ? []
      : [`${at} (${shapeOf(mutant)})`]));
    if (bad.length > 0) {
      containers.push(['claim.entries.killing_mutants', index,
        `\`killing_mutants\` element ${listing(bad)}, which names no test`]);
    }
  }
});
if (containers.length > 0) {
  const [field] = containers[0];
  refuse(field, `${containers.length} entry/entries of ${CLAIM_PATH} at ${candidateSha.slice(0, 12)} carry a `
    + `container this run cannot read as one: ${listing(containers.map(([, index, what]) => `entry ${index} carries ${what}`))}`);
}

// AND THE THREE FIELDS THE RECEIPT MUST NOT CONTRADICT OR MISREAD: the entry's own verdict on itself, and the
// file it says its term's test lives in. Each is refused when PRESENT and of the wrong shape, because a
// disposition this run cannot read is a disposition it cannot honour, and silently ignoring it is the defect
// this block exists to close. Absent stays absent: it is answered below by `permits_establishment: false` and by
// an unbindable artifact, not by a refusal, so a manifest that predates these fields is measurable and simply
// establishes nothing.
const fields = [];
claimEntries.forEach((entry, index) => {
  const { disposition, approvable, artifact } = entry;
  if (disposition !== undefined && disposition !== null && typeof disposition !== 'string') {
    fields.push(['claim.entries.disposition', `entry ${index} carries \`disposition\` as ${shapeOf(disposition)}, not a verdict this run can read`]);
  }
  if (approvable !== undefined && approvable !== null && typeof approvable !== 'boolean') {
    fields.push(['claim.entries.approvable', `entry ${index} carries \`approvable\` as ${shapeOf(approvable)}, not a yes or a no`]);
  }
  if (artifact !== undefined && artifact !== null && (typeof artifact !== 'string' || artifact.trim() === '')) {
    fields.push(['claim.entries.artifact', `entry ${index} carries \`artifact\` as ${shapeOf(artifact)}, not a path this run can bind a test to`]);
  }
});
if (fields.length > 0) {
  const [field] = fields[0];
  refuse(field, `${fields.length} entry/entries of ${CLAIM_PATH} at ${candidateSha.slice(0, 12)} carry a field `
    + `this run cannot read: ${listing(fields.map(([, what]) => what))}`);
}

const idIndices = new Map();
claimEntries.forEach((entry, index) => { idIndices.set(entry.id, [...(idIndices.get(entry.id) ?? []), index]); });
const collisions = [...idIndices.entries()].filter(([, at]) => at.length > 1)
  .map(([id, at]) => `${id} (entries ${at.join(', ')})`);
if (collisions.length > 0) {
  refuse('claim.entries.id', `${collisions.length} term id(s) in ${CLAIM_PATH} at `
    + `${candidateSha.slice(0, 12)} are claimed by more than one entry, so what this run measures about one of `
    + `them cannot be told from what it measures about another: ${listing(collisions)}`);
}

// What the claim says must exist. A control is a test the claim names; a mutant is a test that must die when its
// term is removed. Both are read from the candidate's claim - as data, never as code.
//
// KEYED BY THE ENTRY'S INDEX, not by its id and not by name. Each of the two earlier keyings lost something a
// receipt has to keep:
//
//   * by NAME alone, two terms naming the same test collapsed to one entry attributed to whichever term the
//     manifest happened to list last, so the other term vanished from the receipt while still riding on that
//     test's result.
//   * by TERM ID, two entries sharing an id pooled their tests, so an entry naming nothing inherited a
//     sibling's coverage.
//
// The index is unique by construction, so no manifest - well formed or not - can make two rows share a bucket.
// This and the shape check above are deliberately redundant: the shape check is what refuses a colliding
// manifest by name, and this keying is what makes pooling structurally impossible if that check is ever
// relaxed. The index travels into the receipt as `entry`, on the term row and on every test attributed to it,
// so a reader can see for themselves which entry each measurement was counted under.
const entryTests = claimEntries.map(entry => [
  ...(entry.control?.test_names ?? []).map(name => ({ kind: 'control', name })),
  ...(entry.killing_mutants ?? []).filter(mutant => mutant.test_name)
    .map(mutant => ({ kind: 'mutant', name: mutant.test_name })),
]);

// A NAMED TEST IS THE EVIDENCE OF ONE TERM, NOT OF AS MANY TERMS AS THE CLAIM CARES TO LIST.
//
// This is the finding the commit titled "coverage cannot pool" did not close, and the review that found it said
// so exactly: the id refusal and the per-entry keying stop two entries SHARING a bucket, and nothing stopped
// ten entries with distinct, well-formed ids from all naming the SAME single test. Ten terms then reported
// `establishes: true` off one passing point, `terms_summary` said establishing 10 without_evidence [], and the
// gate's reconciliation agreed with itself because there really were ten named_tests rows - one per entry, all
// for one name. One measurement, ten terms established: the pooling the previous commit's title claimed.
//
// So a measured NAME may belong to exactly one entry. This is a rule about the claim, checked before anything
// is measured, and it is refused rather than reported: a manifest in which two terms rest on one test does not
// say which of them that test is evidence for, and a receipt that picked one would be inventing the answer.
// A term may of course name several tests, and may name one test as both its control and the mutant that kills
// it - what it may not do is be the second claimant of a name another term already rests on.
const nameClaimants = new Map();
entryTests.forEach((tests, index) => {
  for (const test of tests) {
    nameClaimants.set(test.name, [...new Set([...(nameClaimants.get(test.name) ?? []), index])]);
  }
});
const sharedNames = [...nameClaimants.entries()].filter(([, at]) => at.length > 1)
  .map(([name, at]) => `"${name}" (entries ${at.join(', ')}: ${at.map(index => claimEntries[index].id).join(', ')})`);
if (sharedNames.length > 0) {
  refuse('claim.entries.control.test_names', `${sharedNames.length} test name(s) in ${CLAIM_PATH} at `
    + `${candidateSha.slice(0, 12)} are named by more than one entry, so one measurement would be the evidence `
    + `for more than one term and this run cannot say which term it establishes: ${listing(sharedNames)}`);
}

// The entry's `artifact`, resolved against the manifest's own directory into a repository path, so the binding
// in section 10c compares repository paths rather than two spellings of one. `null` where the entry names none:
// such a term says nothing about where its test lives, so there is nothing to bind it to, and the receipt
// records that rather than inventing a path.
const artifactOf = entry => {
  const artifact = typeof entry.artifact === 'string' ? entry.artifact.trim() : '';
  if (artifact === '') return null;
  if (artifact.startsWith('/')) return path.posix.normalize(artifact);
  return path.posix.normalize(`${CLAIM_DIR}/${artifact}`);
};

const named = new Map();
const claimTerms = [];
claimEntries.forEach((entry, index) => {
  const term = entry.id;
  const tests = entryTests[index];
  const artifact = artifactOf(entry);
  for (const test of tests) {
    named.set(`${index}\u0000${test.kind}\u0000${test.name}`,
      { entry: index, term, kind: test.kind, name: test.name, artifact });
  }
  // THE ENTRY'S OWN VERDICT ON ITSELF, carried term by term into the receipt rather than discarded.
  // `disposition` is authoritative and `PASS` is the only value of it that permits establishment; `approvable:
  // false` bars establishment independently and permanently. Both are read here, once, so every later reading -
  // the term row, the claim-wide verdict, and the workflow's gate - reads the same two fields.
  const disposition = typeof entry.disposition === 'string' ? entry.disposition : null;
  const approvable = typeof entry.approvable === 'boolean' ? entry.approvable : null;
  claimTerms.push({
    entry: index,
    id: term,
    names: tests.length,
    artifact,
    disposition,
    approvable,
    permits: approvable !== false && disposition !== null && ESTABLISHING_DISPOSITIONS.includes(disposition),
  });
});
// DEFENCE IN DEPTH: is the capture WELL FORMED? This is not, and may not be reported as, a check that it is
// GENUINE - genuineness is settled above, by provenance, and by nothing in this section. The candidate's own
// test files print into this stream, so any rule here can be satisfied by a candidate that decides to satisfy
// it. Two reviews defeated the versions of this emitter that had only this section: one with `ok 1 - a test
// that never ran` and nothing else, one with a genuine run whose failing test carried that same line inside its
// YAML error block. Both produced verdict success for a test that never existed. What closed that hole was
// measuring with a runner the candidate does not choose and refusing a capture the trusted job did not produce.
//
// What this section still earns: it catches a truncated stream, two runs concatenated, a plan that disagrees
// with what was reported under it, and a summary that does not add up - each of which would otherwise be read
// as a measurement. It reads the stream as the artifact of a runner: a `TAP version` header, one plan per
// nesting level whose count equals the points reported under it, a `type:` diagnostic on every point, the
// reporter's `# duration_ms` footer, and a summary block whose counts reconcile with each other and with the
// points enumerated. Diagnostics (`# ...`) and the contents of a point's YAML block are never read as evidence.
// THE RUNNER'S OWN OUTPUT, not the whole capture: the trailer this authority appended is not a line of the
// measurement and is never read as one. It has already been accounted for, byte for byte, in section 5b.
const tap = captureBody.toString('utf8');
const SUMMARY_FIELD = { tests: 'tests', suites: 'suites', pass: 'ok', fail: 'not_ok', cancelled: 'cancelled', skipped: 'skipped', todo: 'todo' };
const counts = { tests: null, suites: null, ok: null, not_ok: null, cancelled: null, skipped: null, todo: null };
const observed = new Map();
const problems = [];
const pointsAtIndent = new Map();  // nesting indent -> points reported at it since that level's last plan
const plans = [];                  // every plan line, with what was reported under it
const typed = { test: 0, suite: 0 };
const tally = { pass: 0, fail: 0, skip: 0, todo: 0 };  // test points, by the status the runner reported them with
let headers = 0;
let footers = 0;
let yamlIndent = null;             // indent of the `---` of the YAML block currently open, or null
let open = null;                   // the point whose YAML block is expected next, until its type is read
let lineNo = 0;

// A SKIPPED TEST IS NOT A MEASUREMENT, AND A DESCRIBE BLOCK IS NOT A TEST. A point line says `ok`, and two
// different things that are not a passing test say it too:
//
//   * `ok 1 - the stale-head guard holds # SKIP` - a `{ skip: true }` test. Its body never ran. TAP marks such
//     a point with a trailing directive, and `node --test --test-reporter=tap` escapes a `#` inside a
//     description as `\#`, so an unescaped `#` after whitespace at the end of the line is the directive and
//     never part of the name. An earlier version of this file captured ` # SKIP` INTO the name, so a claim
//     naming the test verbatim-with-marker matched, and a body that never ran was recorded `pass`.
//   * `ok 6 - an empty describe` with `type: 'suite'` - an empty `describe()`. The runner reports it `ok`
//     while reporting `# tests 0` under it. An earlier version recorded suite points and test points
//     indistinguishably, so a claim naming an empty suite after a test it requires was recorded `pass`.
//
// The runner's own summary accounts for all of this separately - `# tests` excludes suites, and `# pass` and
// `# fail` exclude both skipped and todo - so reading a point this way is reading it as the runner meant it.
// Each of these is recorded under its own status, never as `pass`, and named in the receipt's reasons.
const TAP_DIRECTIVE = /\s+#\s*(SKIP|TODO)\b.*$/i;
// Worst status wins where one name is reported more than once. `fail` outranks everything; a suite point
// outranks a directive, because it means the name was never a test at all; a directive outranks `pass`.
const STATUS_RANK = { fail: 4, suite: 3, skip: 2, todo: 2, pass: 1 };
const statusOf = point => {
  if (point.type !== 'test') return 'suite';
  if (point.directive) return point.directive;
  return point.ok ? 'pass' : 'fail';
};

const close = () => {
  if (!open) return;
  if (!open.type) problems.push(`point "${open.name}" carries no \`type:\` diagnostic, which the runner writes on every point`);
  // Recorded here, not at the point line, because the point's `type:` arrives in the YAML block that follows
  // it: what a point MEANS is not known until its block closes.
  //
  // A name reported twice is not last-writer-wins. It used to be, so a named test the protected runner watched
  // FAIL was reported `pass` whenever any later point shared its name - the failure stayed in the summary
  // counts the receipt carries, but was discarded from the verdict for that test. Duplicate names across two
  // files of one glob are ordinary, so this collapses pessimistically rather than refusing: the worst status
  // any point under that name reported wins, and the repeat itself is recorded.
  const status = statusOf(open);
  // Tallied here so the summary block can be reconciled against the POINTS, status by status, rather than only
  // against the total. `# pass` excludes a directive and a suite point; `# skipped` and `# todo` are where the
  // directives land; a cancelled test is reported as an undirected `not ok` point and counted in `# cancelled`,
  // so the point line cannot tell a cancellation from a failure and the reconciliation below adds the two.
  if (open.type === 'test') tally[open.directive ?? (open.ok ? 'pass' : 'fail')] += 1;
  const prior = observed.get(open.name);
  // EVERY FILE THIS NAME WAS REPORTED IN, not the last one. A name reported twice from two files is exactly the
  // shape the binding below has to see, so the locations collapse into a set rather than overwriting: if any one
  // of them is outside the entry's artifact, the name is not bound to that artifact.
  const locations = open.location
    ? [...new Set([...(prior?.locations ?? []), open.location])]
    : (prior?.locations ?? []);
  observed.set(open.name, prior
    ? { status: STATUS_RANK[status] > STATUS_RANK[prior.status] ? status : prior.status,
      points: prior.points + 1,
      statuses: prior.statuses.includes(status) ? prior.statuses : [...prior.statuses, status],
      locations }
    : { status, points: 1, statuses: [status], locations });
  open = null;
};

for (const raw of tap.split('\n')) {
  lineNo += 1;
  const line = raw.replace(/\s+$/, '');
  if (line === '') continue;
  const indent = line.length - line.trimStart().length;
  const body = line.trimStart();

  // Inside a point's YAML block nothing is a point, a plan or a summary line. Its keys - including the `type:`
  // the runner writes on every point - sit at exactly the indent of its `---`, and it ends only on a `...` at
  // that same indent. An error message's own lines are indented deeper than the keys, so a failing test cannot
  // close its block early, forge a `type:`, or write points into the stream through the text of its failure.
  if (yamlIndent !== null) {
    if (body === '...' && indent === yamlIndent) {
      yamlIndent = null;
      close();
    } else if (open && indent === yamlIndent) {
      if (!open.type) {
        const type = /^type: '(test|suite)'$/.exec(body);
        if (type) {
          open.type = type[1];
          typed[type[1]] += 1;
        }
      }
      // WHERE THE RUNNER SAYS THIS POINT IS, read out of the same YAML block and at the same indent as `type:`,
      // so a failing test's own error text - which is indented deeper - cannot supply one. `node --test` writes
      // `location: '<file>:<line>:<column>'`; only the file is kept, because a term is bound to the file its
      // claim names and not to a line number that moves with every edit. The first such key wins, so a block
      // carrying two cannot promote the second over the runner's own.
      if (!open.location) {
        const where = /^location: '(.+):(\d+):(\d+)'$/.exec(body);
        if (where) open.location = where[1];
      }
    }
    continue;
  }
  if (body === '---') {
    if (open && indent === open.indent + 2) yamlIndent = indent;
    else { close(); problems.push(`line ${lineNo}: a YAML block opens where no point precedes it`); }
    continue;
  }

  if (indent === 0 && /^TAP version \d+$/.test(body)) { close(); headers += 1; continue; }
  if (indent === 0 && /^# duration_ms [\d.]+$/.test(body)) { close(); footers += 1; continue; }

  const plan = /^1\.\.(\d+)$/.exec(body);
  if (plan) {
    close();
    plans.push({ indent, line: lineNo, planned: Number(plan[1]), reported: pointsAtIndent.get(indent) ?? 0 });
    for (const at of [...pointsAtIndent.keys()]) if (at >= indent) pointsAtIndent.delete(at);
    continue;
  }

  if (indent === 0) {
    const summary = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(body);
    if (summary) {
      close();
      const field = SUMMARY_FIELD[summary[1]];
      if (counts[field] !== null) problems.push(`the summary reports \`# ${summary[1]}\` more than once`);
      counts[field] = Number(summary[2]);
      continue;
    }
  }

  const point = /^(ok|not ok) (\d+) - (.*?)\s*$/.exec(body);
  if (point) {
    close();
    const seen = (pointsAtIndent.get(indent) ?? 0) + 1;
    pointsAtIndent.set(indent, seen);
    if (Number(point[2]) !== seen) {
      problems.push(`line ${lineNo}: point numbered ${point[2]} where the runner would have numbered it ${seen}`);
    }
    const directive = TAP_DIRECTIVE.exec(point[3]);
    open = {
      indent,
      name: directive ? point[3].slice(0, directive.index) : point[3],
      ok: point[1] === 'ok',
      directive: directive ? directive[1].toLowerCase() : null,
      type: null,
      location: null,
    };
    continue;
  }

  close();  // a diagnostic, or anything else: not evidence, and it ends any point awaiting its block
}
close();
if (yamlIndent !== null) problems.push('the stream ends inside a YAML block: this output was truncated');

// 3. The stream must identify itself as the runner's. `node --test --test-reporter=tap` opens with the version
//    header and closes with its own `# duration_ms` footer; a stream with neither is not a reporter's output.
if (headers === 0) problems.push('no `TAP version` header: this output does not identify itself as TAP');
if (headers > 1) problems.push(`${headers} \`TAP version\` headers: this is more than one run's output concatenated, and the counts below describe only one of them`);
if (footers !== 1) problems.push(`the reporter's \`# duration_ms\` footer appears ${footers} time(s), not once`);

// 1. A plan, and a plan that agrees with what was reported under it - at every nesting level the runner planned.
const topLevel = plans.filter(plan => plan.indent === 0);
if (topLevel.length === 0) problems.push('no plan line (`1..N`): a runner states how many points it is about to report, and nothing here does');
if (topLevel.length > 1) problems.push(`${topLevel.length} top-level plan lines: this is more than one run's output concatenated`);
for (const plan of plans) {
  if (plan.planned !== plan.reported) {
    problems.push(`line ${plan.line}: the plan \`1..${plan.planned}\` does not match the ${plan.reported} point(s) reported under it`);
  }
}

// 2. The summary must be complete, must add up, and must account for exactly the points that were enumerated.
for (const [key, field] of Object.entries(SUMMARY_FIELD)) {
  if (counts[field] === null) problems.push(`the summary line \`# ${key}\` is missing`);
}
if (Object.values(counts).every(count => count !== null)) {
  const accounted = counts.ok + counts.not_ok + counts.skipped + counts.todo;
  if (counts.tests !== accounted) {
    problems.push(`the summary does not reconcile: \`# tests ${counts.tests}\` against pass ${counts.ok} + fail `
      + `${counts.not_ok} + skipped ${counts.skipped} + todo ${counts.todo} = ${accounted}`
      + (counts.cancelled > 0 ? ` (${counts.cancelled} cancelled: this run did not finish)` : ''));
  }
  if (counts.tests !== typed.test) {
    problems.push(`the summary claims ${counts.tests} test(s) but ${typed.test} test point(s) were reported`);
  }
  if (counts.suites !== typed.suite) {
    problems.push(`the summary claims ${counts.suites} suite(s) but ${typed.suite} suite point(s) were reported`);
  }
}
if (problems.length > 0) {
  fail(`the captured output is not a measurement a runner produced:\n  - ${problems.join('\n  - ')}`);
}

// A CAPTURE WHOSE OWN NUMBERS DISAGREE WITH ITSELF IS REFUSED BY NAME.
//
// A review produced a capture reporting `# tests 3 / # pass 3 / # fail 0` beside a suite exit code of 1 - the
// residue of a forgery that replaced the stream but could not reach the exit status the trusted job recorded -
// and the emitter accepted it: verdict success, admissible, attested. The structural checks above reconcile the
// summary against the plan and against the count of points, but nothing reconciled the capture against the one
// number that does not come from the stream at all.
//
// So every invariant `node --test --test-reporter=tap` holds over its own output is enforced here, and each is
// a refusal naming the field that broke:
//
//   1. `# pass`      == the ok test points carrying no directive.
//   2. `# fail` + `# cancelled` == the `not ok` test points carrying no directive. Added together because a
//      cancelled test is reported as an undirected `not ok` point exactly like a failing one - the difference is
//      in the YAML block, which this emitter deliberately never reads as evidence.
//   3. `# skipped`   == the test points carrying a `# SKIP` directive.
//   4. `# todo`      == the test points carrying a `# TODO` directive.
//   5. `# tests`     == the count of `type: 'test'` points          (checked above, with the plan).
//   6. `# suites`    == the count of `type: 'suite'` points         (checked above, with the plan).
//   7. `# tests`     == pass + fail + skipped + todo                (checked above).
//   8. exit != 0     -> `# fail` + `# cancelled` > 0. A run the runner exited non-zero on reported at least one
//      failing or cancelled point; `ok 3 / fail 0 / exit 1` is not a state this runner can produce.
//   9. exit == 0     -> `# fail` + `# cancelled` == 0. The mirror: this runner exits non-zero whenever a test
//      failed or was cancelled, so a failure beside exit 0 means the exit code and the stream describe
//      different runs.
//
// 8 and 9 reconcile the stream against the exit status the trusted capture process took from waitpid. A review
// found the sentence that used to stand here - that these are "the only two checks in this file that read a
// fact from OUTSIDE the stream, so they are the only well-formedness checks a candidate cannot satisfy from
// inside its own output" - to be FALSE, and it was: the exit status was read from `meta.suite_exit`, a field of
// a file inside the artifact, and the forgery that rewrites the capture rewrites the meta beside it, so both
// operands were the forger's. Section 5b is what makes the statement true of anything: the exit status is now
// required to agree across the trailer inside the hashed bytes, the meta, and the measure job's own output,
// which travels through GitHub. The honest scope of that is written there and in `provenance.limits`: a
// forgery that appends to $GITHUB_OUTPUT as well still satisfies these. They are refusals and not receipt
// `reasons` because a capture that
// contradicts itself is not a measurement to report a verdict about. The direction of the risk is stated
// plainly: if some future runner legitimately exits non-zero with no failing point (a coverage threshold, say),
// this refuses a genuine run rather than passing a forged one. That is the direction this authority errs in,
// and the enum's commands are `node --test` with no such flag.
const exitCode = Number(suiteExit);
const unfinished = counts.not_ok + counts.cancelled;
const summaryChecks = [
  ['capture.summary.pass', counts.ok, tally.pass, '`# pass` against the ok test points carrying no directive'],
  ['capture.summary.fail', unfinished, tally.fail, '`# fail` + `# cancelled` against the `not ok` test points carrying no directive'],
  ['capture.summary.skipped', counts.skipped, tally.skip, '`# skipped` against the test points carrying a `# SKIP` directive'],
  ['capture.summary.todo', counts.todo, tally.todo, '`# todo` against the test points carrying a `# TODO` directive'],
];
for (const [field, reported, counted, what] of summaryChecks) {
  if (reported !== counted) {
    refuse(field, `the capture contradicts itself: ${what} is ${reported} against ${counted}, so its summary `
      + 'does not describe the points it enumerated');
  }
}
if (exitCode !== 0 && unfinished === 0) {
  refuse('capture.suite_exit', `the capture contradicts itself: the trusted job recorded suite exit ${suiteExit}, `
    + `but the stream reports ${counts.not_ok} failing and ${counts.cancelled} cancelled point(s) out of `
    + `${counts.tests} test(s) - a run this runner exited non-zero on reported at least one of them`);
}
if (exitCode === 0 && unfinished > 0) {
  refuse('capture.suite_exit', `the capture contradicts itself: the stream reports ${counts.not_ok} failing and `
    + `${counts.cancelled} cancelled point(s), but the trusted job recorded suite exit 0 - this runner exits `
    + 'non-zero whenever a test failed or was cancelled');
}

// 10c. BIND THE NAME TO THE FILE THE CLAIM SAYS IT LIVES IN.
//
// A term is established by a NAME matched anywhere in the stream, and a cold review put the consequence plainly:
// two empty function bodies carrying the claim's names, in a file of the candidate's choosing, produce a wholly
// genuine `verdict: success` with every provenance check telling the truth. Every manifest entry already carries
// an `artifact` naming the file its term's test lives in, and `node --test --test-reporter=tap` writes
// `location: '<file>:<line>:<column>'` into the YAML block this parser already reads for `type:`. So the two are
// bound here: a named test the runner reported in a file other than its entry's artifact is NOT a measurement of
// that term, it is recorded `misplaced`, and the term establishes nothing.
//
// The location is a path on the runner - an absolute path into whatever directory the candidate was checked out
// to - and the artifact is a repository path, so the match is a component-aligned SUFFIX: the reported file must
// be the artifact, or must end with `/` followed by it. `/elsewhere/test/x.mjs` therefore does not match
// `test/x.mjs` resolved to `.github/coordinator/service/test/x.mjs`, and a candidate cannot satisfy the rule by
// nesting a stub under a similarly named directory, because every component of the resolved path must line up.
//
// HOW FAR THIS REACHES, MEASURED RATHER THAN ASSERTED, because the review that asked for it states the premise
// too widely and a receipt may not inherit the error. `node --test --test-reporter=tap` at v22.22.3 - the
// runtime this repository measures with - writes `location:` ONLY on a point it reports as FAILING. On this
// repository's own pinned capture that is 28 points out of 3667: 28 of 28 failing points carry one, 0 of 3631
// passing points and 0 of 8 skipped points do. So the binding below refuses a moved name whose test FAILED, and
// cannot see a moved name whose empty stub PASSED - which is the case the attack actually uses. What is closed
// is therefore: the location is now read, carried in the receipt per test, reconciled by the gate, and a
// DISAGREEMENT between the claim and the runner is a refusal by name. What is not closed is the silence: a
// passing point reports no file, so `location_bound: 'unreported'` is carried per test and counted in the
// summary, and it is the honest measure of how much of this claim rests on names no file was reported for.
// Closing the rest needs a location for every point, which needs a reporter this authority owns writing on a
// channel the trusted capture process hashes - an authority change, not an emitter change, and it is named as
// open in the record rather than described here as done.
const bindsTo = (reported, artifact) => reported === artifact || reported.endsWith(`/${artifact}`);
const perTest = [...named.values()].map(test => {
  const seen = observed.get(test.name);
  const status = seen?.status ?? 'absent';
  const locations = seen?.locations ?? [];
  const bound = test.artifact === null ? 'unclaimed'
    : locations.length === 0 ? 'unreported'
      : locations.every(where => bindsTo(where, test.artifact)) ? 'matched' : 'mismatched';
  return {
    ...test,
    // `misplaced` outranks the status the point itself reported: a point in the wrong file is not evidence for
    // this term whatever the runner said about it, and calling it `pass` is the exact reading this closes.
    status: bound === 'mismatched' ? 'misplaced' : status,
    reported_status: status,
    points: seen?.points ?? 0,
    location_bound: bound,
    locations,
  };
});
const duplicatePoints = [...observed.entries()]
  .filter(([, seen]) => seen.points > 1)
  .map(([name, seen]) => ({ name, points: seen.points, statuses: seen.statuses, collapsed_to: seen.status }));
// `pass` is the only status that is a measurement. The other five each record a distinct way this run did NOT
// measure a named test, and each is carried separately so a consumer can see which.
const withStatus = status => perTest.filter(test => test.status === status);
const summary = {
  named: perTest.length,
  // THE COUNT THAT MAKES POOLING VISIBLE RATHER THAN ONLY REFUSED. A review established ten terms off one
  // passing test and observed that nothing in the emitter, the receipt or the gate recorded the distinct-name
  // count that would have exposed it: `named: 10` over one measured name reads exactly like ten measurements.
  // The refusal above makes that manifest unreadable to this authority; this number is what a reader - and the
  // gate, which recomputes it - can check for themselves.
  distinct_names: new Set(perTest.map(test => test.name)).size,
  pass: withStatus('pass').length,
  fail: withStatus('fail').length,
  absent: withStatus('absent').length,
  skipped: withStatus('skip').length,
  todo: withStatus('todo').length,
  suite_points: withStatus('suite').length,
  // A named test the runner reported in a file other than the one its claim names. Its own point may have said
  // `ok`; it is not a measurement of this term.
  misplaced: withStatus('misplaced').length,
  // HOW MUCH OF THIS CLAIM IS ACTUALLY BOUND TO A FILE, carried as four counts rather than left to a reader to
  // infer from the rows. `matched` is a name the runner reported in the file the claim names; `mismatched` is
  // the refusal above; `unreported` is a point the runner gave no location for at all (every passing point, at
  // node v22.22.3) and is the open part of this; `unclaimed` is an entry that names no artifact to bind to.
  location_bound: Object.fromEntries(['matched', 'mismatched', 'unreported', 'unclaimed']
    .map(kind => [kind, perTest.filter(test => test.location_bound === kind).length])),
};

// EVERY TERM, NAMED. The claim-wide `named > 0` rule let a term that names no test at all ride to `success` on
// a sibling term's coverage, with no entry, no reason and no marker anywhere in the receipt - the per-term form
// of the hole that was closed claim-wide. So the receipt enumerates every term the manifest lists, with what
// this run establishes about it, and a term this run establishes nothing about is a reason the claim as a whole
// is not established.
const termReport = claimTerms.map(term => {
  // BY ENTRY INDEX, never by `term.id`. `test.term === term.id` is what pooled two entries that shared an id
  // into one bucket that both then reported as their own coverage; the index cannot be shared, so it cannot
  // pool. The ids are unique by the refusal above, so on any manifest this emitter accepts the two readings
  // agree - this one just cannot be made to disagree.
  const tests = perTest.filter(test => test.entry === term.entry);
  const counted = status => tests.filter(test => test.status === status).length;
  // WHAT THIS RUN MEASURED about the term: every test it names ran and passed, in the file its claim names.
  // Failed, absent, skipped, marked todo, matched by a suite point rather than a test point, or reported in
  // another file: none of those is a measurement of the term.
  const measured = tests.length > 0 && tests.every(test => test.status === 'pass');
  return {
    entry: term.entry,
    id: term.id,
    // The entry's own verdict on itself, verbatim, so that no reader - and no gate - has to fetch the manifest
    // to see what the claim said about the term this row reports on.
    artifact: term.artifact,
    disposition: term.disposition,
    approvable: term.approvable,
    permits_establishment: term.permits,
    named: tests.length,
    pass: counted('pass'),
    fail: counted('fail'),
    absent: counted('absent'),
    skipped: counted('skip'),
    todo: counted('todo'),
    suite_points: counted('suite'),
    misplaced: counted('misplaced'),
    measured,
    // AND ESTABLISHED IS MEASURED **AND** PERMITTED. A term whose own manifest entry says `disposition: BLOCK`
    // or `approvable: false` is not in a state where this authority may call it established, however green its
    // named tests are - the measurement is still recorded, above, under its own name.
    establishes: measured && term.permits,
  };
});
const uncoveredTerms = termReport.filter(term => term.named === 0).map(term => String(term.id));
// Terms this run really measured green and still may not call established, because the claim itself says they
// are not in a state to be. Kept apart from every other reason so that a reader can tell "the tests did not
// pass" from "the tests passed and the claim says that is not enough".
const barredTerms = termReport.filter(term => term.measured && !term.permits_establishment);

// THE SUITE'S OWN RESULT, AND WHAT A VERDICT MAY SAY BESIDE IT.
//
// A review produced `verdict: success` with `reasons: []` for a run the runner exited 1 on, with two failing
// tests in the same tree, and put it plainly: a receipt must never carry an UNQUALIFIED success when the runner
// reported failure. The verdict is computed over the claim's named tests - that is what a term is established
// by, and widening it to the whole tree would make every receipt hostage to an unrelated flake - so the answer
// is not to redefine the verdict but to stop it from being unqualified:
//
//   * the failing tests of the run are enumerated BY NAME in the receipt, from the capture's own points;
//   * the receipt states, as a field rather than as an inference, whether the suite was green or red and
//     whether every red test is outside the set of names the claim makes its case on;
//   * a success beside a red suite carries that statement in `conclusion.qualifications`, so `reasons: []`
//     is never the whole of what the receipt says about a red run;
//   * and success is not reachable at all when a red test IS one the claim names - it never was, because such
//     a test is recorded `fail` and its term establishes nothing, but it is now also stated in these terms and
//     re-checked by the workflow's gate, which refuses to let such a receipt be attested.
const failingPointNames = [...observed.entries()].filter(([, seen]) => seen.status === 'fail').map(([name]) => name);
const namedSet = new Set(perTest.map(test => test.name));
const redInsideTheClaim = failingPointNames.filter(name => namedSet.has(name));
const redOutsideTheClaim = failingPointNames.filter(name => !namedSet.has(name));
const suiteRed = exitCode !== 0 || unfinished > 0;
const qualifications = [];
if (suiteRed) {
  qualifications.push(`the measured suite is RED: the runner exited ${suiteExit} and its summary reports `
    + `${counts.not_ok} failing and ${counts.cancelled} cancelled point(s) out of ${counts.tests} test(s). This `
    + `receipt's verdict is about the ${summary.named} test(s) this claim names and about nothing else in that `
    + 'tree.');
  qualifications.push(redInsideTheClaim.length === 0
    ? `every failing test of that run is OUTSIDE the set of names this claim rests on: `
      + `${redOutsideTheClaim.length} failing name(s), none of them named by any term `
      + `(${listing(redOutsideTheClaim)})`
    : `${redInsideTheClaim.length} failing test(s) of that run ARE named by this claim, so this run establishes `
      + `nothing about the term(s) that name them: ${listing(redInsideTheClaim)}`);
}

// Success means: the claim lists terms, every term names at least one test, every named test was observed in
// this run's capture, and every one passed - and, when the suite was red, that every red test is outside the
// claim's own named set and the receipt says so. The last clause cannot fire on its own (a red named test is
// recorded `fail`, which fails the clause before it), and it is written out anyway so that the rule the gate
// re-checks is a rule this file states rather than one a reader has to derive.
const established = termReport.length > 0 && termReport.every(term => term.establishes)
  && summary.named > 0 && perTest.every(test => test.status === 'pass')
  && (!suiteRed || redInsideTheClaim.length === 0);
const reasons = [];
if (termReport.length === 0) reasons.push('the claim lists no terms, so this run establishes nothing');
if (summary.named === 0 && termReport.length > 0) {
  reasons.push('the claim names no tests, so this run establishes nothing about any term');
}
if (uncoveredTerms.length > 0) {
  reasons.push(`${uncoveredTerms.length} term(s) name no tests, so this run establishes nothing about them: `
    + uncoveredTerms.join(', '));
}
if (summary.fail > 0) {
  reasons.push(`${summary.fail} named test(s) failed in the measured run: ${listing(withStatus('fail').map(t => t.name))}`);
}
if (summary.absent > 0) reasons.push(`${summary.absent} named test(s) did not appear in the measured run`);
if (summary.skipped > 0) {
  reasons.push(`${summary.skipped} named test(s) were reported with a \`# SKIP\` directive, so the runner `
    + `never executed them and this run measured nothing about them: ${listing(withStatus('skip').map(t => t.name))}`);
}
if (summary.todo > 0) {
  reasons.push(`${summary.todo} named test(s) were reported with a \`# TODO\` directive, which the runner `
    + `counts as neither pass nor fail: ${listing(withStatus('todo').map(t => t.name))}`);
}
if (summary.suite_points > 0) {
  reasons.push(`${summary.suite_points} named test(s) were matched only by a \`type: 'suite'\` point - a `
    + `describe() block, which reports \`ok\` whether or not it contains a test: `
    + `${listing(withStatus('suite').map(t => t.name))}`);
}
if (summary.misplaced > 0) {
  reasons.push(`${summary.misplaced} named test(s) were reported by the runner in a file other than the one `
    + `their own manifest entry names, so this run measured a test of that name and not the test the claim `
    + `describes: ${listing(withStatus('misplaced')
      .map(t => `"${t.name}" claimed in ${t.artifact}, reported in ${t.locations.join(', ')}`))}`);
}
// THE CLAIM'S OWN VERDICT, AS A REASON THIS RECEIPT ESTABLISHES NOTHING. This is the finding that decides what
// the word "established" may be read as: on this repository's own pinned manifest every entry says
// `disposition: BLOCK` and twelve say `approvable: false`, and this emitter used to report all 53 established.
// The measurement is not discarded - `terms[].measured` still records that every named test passed - but the
// claim as a whole is not established, and the reason names the field and the count.
if (barredTerms.length > 0) {
  const blocked = barredTerms.filter(term => term.disposition !== null
    && !ESTABLISHING_DISPOSITIONS.includes(term.disposition));
  const unapprovable = barredTerms.filter(term => term.approvable === false);
  const silent = barredTerms.filter(term => term.disposition === null);
  reasons.push(`${barredTerms.length} term(s) were measured green and are not in a state this claim permits `
    + `establishment from, so this run establishes nothing about them: `
    + `${blocked.length} carry a disposition other than ${ESTABLISHING_DISPOSITIONS.join('/')} `
    + `(${listing([...new Set(blocked.map(term => term.disposition))])}), `
    + `${unapprovable.length} carry \`approvable: false\`, `
    + `${silent.length} state no disposition at all: ${listing(barredTerms.map(term => String(term.id)))}`);
}
for (const duplicate of duplicatePoints) {
  // Every repeat is recorded in `duplicate_points`; only a repeat whose points DISAGREE is a reason, because a
  // disagreement means the run contains a failure of a named test that a naive reading would have lost.
  if (duplicate.statuses.length < 2 || !perTest.some(test => test.name === duplicate.name)) continue;
  reasons.push(`the named test "${duplicate.name}" was reported ${duplicate.points} times, as `
    + `${duplicate.statuses.join(' and ')}; it is recorded as ${duplicate.collapsed_to}`);
}

// Admissibility is separate from the verdict, and deliberately so. A receipt produced by a run that is not a
// dispatch of this workflow on the protected default branch is a rehearsal: every provenance check above still
// had to pass, but the authority the run executed was not necessarily the authority main holds. Such a receipt
// may never be pinned.
//
// WHAT ENFORCES THAT, AND WHERE THAT ENFORCEMENT STOPS. A review found the field unenforced and bypassable and
// it was right on both counts, so what enforces it now is written here as a list of places rather than as a
// claim:
//
//   * this block, which computes the field and refuses to call a run admissible on any of the grounds below;
//   * the workflow's gate step, which re-reads the receipt and refuses to publish an `admissible` output that
//     disagrees with the receipt's own body - a bypass that wrote `admissible=true` beside a receipt saying
//     false is what the review used;
//   * the workflow's separate `attest` job, which is the only job of this authority holding `attestations:
//     write`, which runs at all only on a workflow_dispatch of the default branch, and which re-reads
//     `provenance.admissible_as_pin` and `conclusion.verdict` out of the signed subject itself before signing.
//
// AND WHERE IT STOPS, because this file may not overstate it twice. On a `pull_request` event GitHub runs the
// workflow DEFINITION from the pull request head, so every one of those enforcers is code the candidate's
// author supplied for that run; no arrangement of this file can bind it. What binds it is outside this
// repository's files: the repository's Actions settings (whether a pull request run is granted attestations at
// all, and whether it needs approval), and a CONSUMER that requires `provenance.admissible_as_pin === true`,
// `conclusion.verdict === 'success'` and an attestation whose workflow REF is the protected branch - not
// merely the presence of an attestation. That consumer requirement is written out, edit by edit, in
// /home/bawes/work/consumer-required-changes.md, because the consumer lives on another branch.
const trustedOnMain = (() => {
  const compare = apiJson(`/repos/${repo}/compare/${trustedSha}...main`);
  return compare ? ['identical', 'ahead'].includes(compare.status) : false;
})();
const inadmissible = [];
// A receipt that does not record a successful measurement has nothing in it to pin, so it is not merely
// unattested for want of a dispatch - it is inadmissible on its own contents. Stated here so that the field a
// consumer reads answers the whole question rather than only the question of where the run happened.
if (!established) {
  inadmissible.push(`this receipt's verdict is failure, so there is nothing in it for a manifest to pin`);
}
// SECTION 8 CANNOT DISTINGUISH "THE AUTHORITY IS INTACT" FROM "THE AUTHORITY IS NOWHERE", and a review found
// this repository in exactly the second state: `.github/verifier-receipt` does not exist on the protected
// branch, so `objectAt` answers null there, answers null at any candidate that does not carry it, and the
// comparison of two nulls reports `touches_authority: false`. That is the state the FIRST receipts would be
// produced in, so it is named here instead of passing quietly.
const authorityAbsent = authorityIdentity.filter(entry => entry.protected_sha === null).map(entry => entry.path);
if (authorityAbsent.length > 0) {
  inadmissible.push(`the receipt authority is absent on ${PROTECTED_REF} (${listing(authorityAbsent)}), so this `
    + 'run compared the candidate against nothing and cannot establish that it leaves the authority alone');
}
if (run.event !== 'workflow_dispatch') {
  inadmissible.push(`this run's event is ${run.event}; only a workflow_dispatch of ${WORKFLOW_PATH} may be pinned`);
}
if (run.head_branch !== 'main') {
  inadmissible.push(`this run was made on ${run.head_branch}, not the protected default branch`);
}
if (trustedOrigin !== 'protected-main') {
  inadmissible.push(`the authority files came from ${trustedOrigin}, not from protected main`);
}
if (!trustedOnMain) {
  inadmissible.push(`the authority commit ${trustedSha.slice(0, 12)} is not contained in main`);
}

const receipt = {
  schema: 2,
  repository: repo,
  workflow: {
    path: WORKFLOW_PATH,
    ref: env.GITHUB_WORKFLOW_REF ?? null,
    workflow_ref: env.GITHUB_WORKFLOW_REF ?? null,
    head_sha: run.head_sha ?? null,
    head_branch: run.head_branch ?? null,
    event: run.event ?? null,
    trusted_source_sha: trustedSha,
    trusted_source_origin: trustedOrigin,
    trusted_source_on_main: trustedOnMain,
  },
  run: { id: String(run.id), attempt: runAttempt },
  candidate: {
    sha: candidateSha,
    tree: candidateTree,
    touches_authority: false,
    // The evidence for the line above: the object id of each authority path on the protected branch and at the
    // candidate, which is what was compared. Not a filtered diff listing, which GitHub truncates at
    // COMPARE_FILE_CAP and which reports a rename under its new name only.
    authority_identity: authorityIdentity,
  },
  // Everything a third party needs to re-fetch and re-check this receipt through the API, without trusting any
  // part of it. Each field below is something GitHub reports, not something a job asserted.
  provenance: {
    statement: 'the capture this receipt reads was produced by the trusted measure job of this run, which chose '
      + 'and invoked the runner and hashed its output stream as the bytes passed through it; the candidate chose '
      + 'the code under test and the claim it commits, and no path, field, command or artifact this process read',
    // WHAT THIS RECEIPT DOES NOT ESTABLISH, carried in the receipt itself rather than left to a reader to infer.
    // An earlier version of the statement above said the candidate contributed "only the code under test and the
    // claim it commits", full stop. A review showed that to be false as written - the candidate also wrote the
    // capture's bytes, by renaming a forged stream over the file the trusted job hashed in a later step. That
    // route is closed (the digest is now taken in the trusted process as the stream passes through, and a
    // replacement is refused at capture.sha256), but the deeper limit below is NOT closed and cannot be closed
    // by anything in this workflow, so it is stated as a field of every receipt this authority emits.
    limits: [
      'A TERM IS ESTABLISHED BY A NAME, AND THE CANDIDATE WRITES THE TESTS. Three empty function bodies named '
        + 'exactly what a claim names produce a wholly genuine measurement that this authority accepts: every '
        + 'provenance check passes and every one of them is telling the truth. This receipt says that the '
        + 'protected runner reported those names passing on this tree. It does not say the tests did the work '
        + 'the claim describes, and nothing in a receipt of this shape can; that would take coverage of the '
        + 'term\'s own source attributed to the named test, a mutation run whose kill result the candidate does '
        + 'not write, or a second independent measurement.',
      'THE NAME IS BOUND TO A FILE ONLY AS FAR AS THE RUNNER REPORTS ONE. Every named test carries '
        + '`location_bound` and `locations`: the file `node --test` reported the point in, checked against the '
        + 'manifest entry\'s own `artifact` path. A disagreement is recorded `misplaced`, establishes nothing, '
        + 'and is refused again by this workflow\'s gate. But `node --test --test-reporter=tap` at v22.22.3 '
        + 'writes `location:` only on a point it reports FAILING - measured on this repository\'s own pinned '
        + 'capture: 28 of 28 failing points carry one, 0 of 3631 passing and 0 of 8 skipped do - so a name '
        + 'whose empty stub in another file PASSES is `location_bound: "unreported"` and is not caught. The '
        + 'count of unreported names is in `named_tests_summary.location_bound` and is the honest measure of '
        + 'this gap. Closing it needs a location on every point, which needs a reporter this authority owns '
        + 'writing on a channel the trusted capture process hashes; that is not done.',
      'THE CLAIM\'S OWN VERDICT IS NOW LOAD-BEARING, AND IT IS STILL THE CANDIDATE\'S FILE. A term is '
        + 'established only when the measurement is green AND the manifest entry it comes from carries '
        + '`disposition: PASS` and not `approvable: false`; `terms[].measured` records the measurement '
        + 'separately, so a blocked term still shows what this run saw. That stops this receipt from '
        + 'contradicting the claim it validates - a review found all 53 entries of this repository\'s pinned '
        + 'manifest saying BLOCK while the receipt said 53 established - but it is a CONTRADICTION check, not '
        + 'an anti-forgery boundary: the candidate writes the manifest, so a candidate that wants PASS writes '
        + 'PASS. What it buys is that the lie has to be in the candidate\'s own committed file, and this '
        + 'receipt carries that file\'s words verbatim in every term row.',
      'the measured tests print into the very stream this capture is, so a candidate whose test bodies emit '
        + 'plausible TAP of their own put those bytes into the stream the trusted job hashed. A correction a '
        + 'review measured and this file previously had backwards: at Node 22 `node --test --test-reporter=tap` '
        + 'absorbs each test child\'s stdout AND stderr and re-emits every line as an escaped `# ` diagnostic, '
        + 'which this emitter never reads as evidence - eight routes into the stream from inside a test body '
        + 'were tried and all eight came back as diagnostics. That is undocumented, version-dependent reporter '
        + 'behaviour and it is NOT a defence this authority relies on; it is recorded so that no consumer reads '
        + 'this limit as the open one. The open one is the next item.',
      'THE OPEN ONE, and it is blocking rather than residual: the capture is written by a process running as '
        + 'the same user as the measured suite, so a candidate that detaches a process outliving its own run '
        + 'rewrites suite.out and capture-meta.json together after the trusted write and before the upload. A '
        + 'review did exactly that, three runs out of three, for a tree whose every named test really failed. '
        + 'What this receipt now forces that forgery to do as well: write a trailer inside the hashed bytes '
        + 'that agrees with the stream, and beat the exit status the measure job publishes as its own output '
        + 'through GitHub (`capture.suite_exit` refuses any disagreement). A forger that also appends to '
        + '$GITHUB_OUTPUT - whose path a same-uid process can read out of /proc - defeats that too. Only a '
        + 'different uid for the measured suite, or a container it cannot escape, closes this.',
      'admissible_as_pin is RE-DERIVED, not re-read, in three places. A review found the previous wording of '
        + 'this item false: it said "enforced in three places" when one place computed the field and the other '
        + 'two compared the computed boolean to itself, so a receipt whose body still recorded the authority as '
        + 'absent on main, with only this flag flipped to true, passed the gate, the guard and the attest '
        + 'job\'s subject re-read. Each of the three now recomputes the field from the six grounds recorded in '
        + 'this receipt\'s own body - conclusion.verdict, candidate.authority_identity[].protected_sha, '
        + 'workflow.event, workflow.head_branch, workflow.trusted_source_origin and '
        + 'workflow.trusted_source_on_main - and refuses when the recomputation disagrees with the flag. That '
        + 'enforcement is still in workflow FILES, and on a pull_request event GitHub runs the workflow '
        + 'definition from the pull request head, so for such a run all three are the candidate author\'s. A '
        + 'consumer must therefore re-derive this field itself from the same six grounds, require '
        + 'conclusion.verdict === "success", and require any attestation it trusts to name a workflow ref on '
        + 'the protected branch rather than merely to exist.',
    ],
    measure_job: {
      name: measureJob.name,
      id: String(measureJob.id),
      conclusion: measureJob.conclusion,
      started_at: measureJob.started_at ?? null,
      completed_at: measureJob.completed_at ?? null,
    },
    artifact: {
      name: artifact.name,
      id: String(artifact.id),
      digest: artifact.digest,
      archive_sha256: archiveDigest,
      size_in_bytes: artifact.size_in_bytes ?? null,
      created_at: artifact.created_at ?? null,
      contents: expectedEntries,
    },
    capture: {
      file: CAPTURE_FILE,
      sha256: captureDigest,
      bytes: captureBytes.length,
      // The runner's own output, apart from the one trailer line the trusted capture process appended to it.
      // A third party re-checking this receipt splits the artifact at `body_bytes` and re-hashes both halves.
      body_bytes: captureBody.length,
      body_sha256: trailer.bodyDigest,
      trailer: trailer.line,
      suite_exit: suiteExit,
      // WHERE THE EXIT STATUS WAS READ, all three of them, because a number that agrees with itself in one
      // place is what the forgery this closes looked like.
      suite_exit_channels: {
        trailer_in_the_hashed_stream: trailerExit,
        capture_meta: String(meta.suite_exit ?? ''),
        measure_job_output: jobOutputExit,
      },
      // HOW the digest was taken, because it is the difference between a capture whose origin is established and
      // one whose bytes the measured code could have replaced after the fact. `stream` is the only value this
      // emitter accepts; a meta saying anything else is refused at capture.hash_source.
      hashed: 'in the trusted job, as the stream passed through it',
      hashed_by: meta.capture_hashed_by ?? null,
      hash_source: meta.capture_hash_source,
      suite_signal: meta.suite_signal ?? null,
    },
    runner: {
      key: runnerKey,
      command: runnerCommand,
      enum_path: '.github/verifier-receipt/runners.json',
      enum_source_sha: trustedSha,
      chosen_by: 'the protected workflow, from a closed enum; never by the candidate',
    },
    claim: {
      path: CLAIM_PATH,
      ref: candidateSha,
      blob_sha: claimResponse.sha ?? null,
      sha256: sha256(claimBytes),
      code_revision: { head: claimedHead, tree: manifest.code_revision?.tree ?? null },
      delta_from_code_revision: claimDelta,
    },
    admissible_as_pin: inadmissible.length === 0,
    inadmissibility_reasons: inadmissible,
  },
  // Kept for the pin format a claim verifier reads. No such verifier exists in this repository yet; this block
  // is the shape one would read, not evidence that one does.
  manifest: {
    path: CLAIM_PATH,
    sha256: sha256(claimBytes),
    blob_sha: claimResponse.sha ?? null,
    code_revision: { head: claimedHead, tree: manifest.code_revision?.tree ?? null },
  },
  suite: {
    tests: counts.tests, suites: counts.suites, ok: counts.ok, not_ok: counts.not_ok,
    cancelled: counts.cancelled, skipped: counts.skipped, todo: counts.todo, exit: suiteExit,
    // GREEN or RED, as a field rather than as something a consumer has to derive from two counts and an exit
    // code - and, when red, WHICH tests were red, by name, from the capture's own points. A review found
    // `verdict: success` with `reasons: []` beside a non-zero exit and two failing tests, and the receipt said
    // nothing anywhere that a reader could act on. These three fields are that statement.
    state: suiteRed ? 'red' : 'green',
    failing_tests: failingPointNames,
    failing_tests_named_by_the_claim: redInsideTheClaim,
  },
  structure_check: {
    kind: 'well-formedness',
    passed: true,
    note: 'the capture parses as one runner\'s TAP and its counts reconcile. This says the capture is WELL '
      + 'FORMED. It does not say it is GENUINE - that is what the provenance block above establishes, and '
      + 'nothing in this check would notice a candidate suite printing a well-formed stream of its own.',
  },
  // Each named test with the status this run's capture gives it: `pass` (a `type: 'test'` point the runner
  // reported ok, with no directive) or one of `fail`, `absent`, `skip`, `todo`, `suite`. Only `pass` is a
  // measurement; the other five say, distinctly, how this run failed to make one.
  named_tests: perTest,
  named_tests_summary: summary,
  // Every term the manifest lists, whether or not it names a test. A term with `named: 0` is a term this run
  // establishes nothing about, and it is enumerated here so that no consumer can read a claim-wide `success`
  // as covering it.
  terms: termReport,
  terms_summary: {
    total: termReport.length,
    establishing: termReport.filter(term => term.establishes).length,
    // WHAT THIS RUN MEASURED, kept apart from what it ESTABLISHES. The two are equal only on a manifest whose
    // every entry is in a state that permits establishment; on this repository's own pinned manifest, measured
    // is 53 and establishing is 0, and a receipt that reported one number for both is what this separates.
    measured: termReport.filter(term => term.measured).length,
    permitted_by_the_manifest: termReport.filter(term => term.permits_establishment).length,
    naming_no_tests: uncoveredTerms.length,
    barred_by_the_manifest: barredTerms.map(term => String(term.id)),
    dispositions: Object.fromEntries([...new Set(termReport.map(term => String(term.disposition)))].sort()
      .map(value => [value, termReport.filter(term => String(term.disposition) === value).length])),
    without_evidence: termReport.filter(term => !term.establishes).map(term => String(term.id)),
  },
  // Names the capture reported more than once. Recorded because a repeated name is not a measurement of that
  // name: the status carried above is the WORST of them, never the last.
  duplicate_points: duplicatePoints,
  conclusion: {
    verdict: established ? 'success' : 'failure',
    scope: 'the named tests of the claim this measured, as observed in this run\'s own capture',
    // THE SUITE'S OWN RESULT, CARRIED IN THE CONCLUSION rather than only in the block above it, because the
    // conclusion is the field every consumer reads. A `success` here is never unqualified beside a red suite:
    // `suite_state` says the runner reported failure, and `qualifications` says, in words, what this verdict
    // does and does not cover. The workflow's gate refuses to publish an `admissible` output for a receipt
    // whose suite is red unless every red test is outside the claim's named set AND these fields say so.
    suite_state: suiteRed ? 'red' : 'green',
    qualifications,
    reasons,
  },
};

fs.rmSync(work, { recursive: true, force: true });
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`receipt for ${candidateSha.slice(0, 12)} tree ${candidateTree.slice(0, 8)}: verdict `
  + `${receipt.conclusion.verdict}; named ${summary.named} pass ${summary.pass} fail ${summary.fail} `
  + `absent ${summary.absent} skipped ${summary.skipped} todo ${summary.todo} `
  + `suite-points ${summary.suite_points} over ${summary.distinct_names} distinct name(s); suite `
  + `${receipt.suite.state} (exit ${suiteExit}, tests ${counts.tests})`);
if (suiteRed) console.log(`qualified: ${qualifications.join(' ')}`);
console.log(`terms: ${termReport.length} listed, ${receipt.terms_summary.measured} measured, `
  + `${receipt.terms_summary.establishing} established`
  + (barredTerms.length > 0
    ? `; ${barredTerms.length} measured term(s) the manifest does not permit establishment from `
      + `(${listing([...new Set(barredTerms.map(term => `disposition=${term.disposition}`
        + (term.approvable === false ? ' approvable=false' : '')))], 4)})`
    : '')
  + (summary.misplaced > 0 ? `; ${summary.misplaced} named test(s) reported outside their claimed artifact` : '')
  + `; names bound to a file: ${JSON.stringify(summary.location_bound)}`
  + (uncoveredTerms.length > 0 ? `; naming no tests: ${uncoveredTerms.join(', ')}` : '')
  + (duplicatePoints.length > 0 ? `; repeated point names: ${duplicatePoints.map(d => `"${d.name}" x${d.points}`).join(', ')}` : ''));
console.log(`provenance: run ${runId} attempt ${runAttempt}, measure job ${measureJob.id} ${measureJob.conclusion}, `
  + `artifact ${artifact.name}#${artifact.id} ${artifact.digest}, capture sha256:${captureDigest}, `
  + `runner "${runnerKey}"; admissible as pin: ${receipt.provenance.admissible_as_pin}`
  + (inadmissible.length > 0 ? ` (${inadmissible.join('; ')})` : ''));
process.exit(0);
