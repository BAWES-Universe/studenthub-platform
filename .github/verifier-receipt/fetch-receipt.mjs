// Fetch and verify a verifier receipt through GitHub's API, and emit the pin a manifest binds to.
//
// This is the evidence path, so it trusts nothing it can be handed - EXCEPT the one thing it cannot check,
// which is named rather than assumed: see WHAT THIS TOOL'S TRUST ROOT ACTUALLY IS below.
//   * this file emits a pin only on a run of the protected branch. That is the first thing it decides and the
//     last thing it enforces, and it is a GUARD RAIL rather than a ground - see THE PROTECTED-REF GROUND
//     below for what it stops, what it does not, and what actually binds;
//   * the run is read back from the API by id and must be a workflow_dispatch of the receipt workflow on the
//     protected ref, concluded successfully, and have run the commit it claims;
//   * the artifact is located by NAME inside that run and its digest must be the digest GitHub reports for it
//     - an artifact digest is computed by GitHub, not supplied by the uploader;
//   * the downloaded ARCHIVE's bytes are hashed and must equal `artifact.digest`, which is the check that the
//     container is the one GitHub served rather than one substituted in flight; the receipt is then taken out
//     of THAT verified archive, in memory, by the named and isolated interpreter described under WHAT THIS
//     TOOL'S TRUST ROOTS ACTUALLY ARE - so the bytes this tool goes on to read are the ones inside it as far
//     as that interpreter can be relied on, and no further. The archive never becomes a file and no other
//     copy of it exists, so nothing but the reader itself stands between the digest and the parse. The
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
// WHAT THIS TOOL'S TRUST ROOTS ACTUALLY ARE, STATED RATHER THAN ASSUMED.
//
// There are TWO SUBPROCESSES, and both are trust roots. An earlier round of this comment said "Every fact
// above arrives through one channel: `gh api`, run as a subprocess", and a review showed that sentence was
// false while it was written: `python3` opens the archive, and the RECEIPT BODY - the thing every downstream
// check reads - comes back out of it. With that binary left as a bare name resolved through PATH at call
// time, the review put a dishonest `python3` ahead of the real one, left everything else honest, and got a
// pin reporting `{"verdict":"success","suite_state":"green"}` over the digest of a red archive.
//
//   * `gh api` answers every API QUESTION: the run, the artifact, the archive bytes, the attestation, and the
//     protected branch's copy of the rule. So the root of every such claim is THE `gh` BINARY THIS RUN FOUND
//     ON ITS PATH, AND THE CREDENTIAL THAT BINARY CARRIES - not GitHub.
//   * `python3` turns the VERIFIED ARCHIVE into the receipt's bytes, because node has no zip reader in its
//     standard library and this path must not depend on a package a candidate could supply. So the root of
//     every claim about what the receipt SAYS is that interpreter and the `zipfile` module it imported.
//
// A `gh` on PATH that answers from a file, an attacker who can prepend a directory to PATH, a wrapper that
// forges the contents API's reply, a token minted for another repository, a `python3` that returns a body
// nobody put in the archive: any of those and this tool reports whatever it is handed, carefully checked
// against itself. Nothing here can tell a spoofed channel from a real one, and no arrangement of checks over
// a channel that cannot be trusted makes it trustworthy.
//
// What this file does about that is name them and MEASURE them rather than assert them, and it does the same
// thing for both. Each binary is resolved on PATH to an absolute path before it is used, every call goes to
// THAT path rather than through a fresh PATH lookup, and its `--version` is read back; both paths and both
// versions travel in the pin as `fetched_with`, beside the `zipfile` module the interpreter reported loading
// - so a reader of a pin can see which binaries this fetch rested on instead of being asked to assume. That
// is true of the pin THIS TOOL EMITS; the pin a candidate COMMITS carries an unverified copy of the block,
// which `compare-pin.mjs` prints beside this one rather than comparing or trusting, and says so in the log.
// A run that knows which binaries it expects may say so in `VERIFIER_EXPECTED_GH` /
// `VERIFIER_EXPECTED_GH_VERSION` / `VERIFIER_EXPECTED_PYTHON` / `VERIFIER_EXPECTED_PYTHON_VERSION`, and this
// tool refuses an observation that contradicts one. A binary that cannot be resolved, or that will not say
// what it is, is a refusal outright: a trust root that cannot be named is not one a pin may rest on.
//
// AND THE INTERPRETER IS ISOLATED FROM THE TREE IT RUNS BESIDE, which is a second defect in the same channel
// and needed no control of PATH. `verify-claim.yml` does `cd candidate` before invoking this tool, and
// `python3 -c` puts the working directory FIRST on `sys.path`: a `zipfile.py` committed in a candidate's own
// repository was therefore the zip reader, and the review got a pin over a body that had decided nothing,
// recording main's real blob id as the rule that admitted it. The interpreter is now given `-P` and an
// explicit `cwd` that is not the candidate's tree, and it REPORTS BACK its own `sys.path` entries resolving
// to that directory - any at all being a refusal. See THE CONTAINER IS CHECKED BEFORE IT IS OPENED below.
//
// THE PROTECTED-REF GROUND: A CANDIDATE'S OWN RUN MAY NOT PRODUCE A PIN. IT IS A GUARD RAIL.
//
// Unless the run this tool is part of is ITSELF on the protected branch - `GITHUB_REF` exactly
// `refs/heads/main` and `GITHUB_EVENT_NAME` one of `push` or `workflow_dispatch` - this file emits no pin, no
// `--out` file, and nothing shaped like one; it exits non-zero naming the reason. It will still REPORT what it
// found, on stderr and labelled ADVISORY, because a report is useful and a pin is authority.
//
// AND THE HONEST ACCOUNT OF WHAT THAT COSTS AN ATTACKER, because an earlier round of this comment called it
// "THE STRUCTURAL GROUND", which overstates a `process.env` read. Measured: an honest `pull_request` run exits
// 4 with no pin and no `--out` file; the same run with `GITHUB_REF` and `GITHUB_EVENT_NAME` set to main's
// values by the workflow that invokes this tool exits 0 and writes one. A candidate edits the workflow that
// sets those variables, so this check stops an ACCIDENT - a copy of the consumer wired up on a branch, a local
// invocation, a reused step - and does not stop a candidate that is trying. It is a guard rail, and the
// refusal is kept because guard rails are worth having.
//
// WHAT ACTUALLY BINDS is downstream of this file: to become a record, a pin must be COMMITTED and then survive
// `verify-claim.yml`, which is `workflow_dispatch`-only from protected main with a real token and a verifier
// checked out from the dispatching ref. A green-looking check inside a candidate's own run is worth exactly
// nothing there, because that run's opinion is never consulted.
//
// WHY, said plainly: on a pull_request event GitHub runs the workflow DEFINITION and the checked-out CODE from
// the pull request head, so this tool, the files it reads and the checks it performs are all the candidate's.
// A verdict computed by the judged party is not evidence, however carefully it is computed. A review made
// exactly this point concrete: eight lines in the candidate's own `admissibility.mjs`, evaluated at import
// time before any check ran, could patch `fs.readFileSync` to hand back main's bytes for its own path - and
// out came a pin over a red, authority-absent body, recording main's real blob id as the rule that admitted
// it. The fetch below removes the file it patched; this guard rail removes the pin it produced by accident.
//
// Usage:  node fetch-receipt.mjs --run <run_id> [--repo owner/name] [--out pin.json]
// Stdout: the pin JSON, which the caller commits as the claim's evidence reference. Nothing on a run that may
//         not pin: the advisory report goes to stderr so that no reader can mistake it for the pin channel.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
// NOTHING OF THE CHECKOUT'S IS IMPORTED HERE, AND THAT IS THE POINT. This file used to carry
// `import { deriveAdmissibility } from './admissibility.mjs'` and check that module's blob id 160 lines later.
// ESM evaluates a dependency's top level at LOAD, so the candidate's module ran first, in this process, and
// could neutralise the check meant to catch it. Checking bytes on disk and then importing the path is a
// time-of-check-to-time-of-use gap in any case - and so is writing verified bytes to a temp file and importing
// THAT, which is what the round before this one did. The decider is fetched from the protected branch over the
// API and imported from a `data:` URL built out of the verified bytes, so no filesystem path is in the chain
// at all; see THE RULE THAT DECIDES and THE BYTES THAT DECIDE.

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

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const fail = message => {
  console.error(`REFUSING: ${message}`);
  process.exit(3);
};

// THE TRUST ROOT, RESOLVED AND MEASURED BEFORE IT IS USED. See the header: every fact this file states came
// out of this binary, so which binary it was is a fact the pin has to carry rather than one a reader assumes.
//
// PATH is walked here instead of being left to execFileSync, for two reasons that are the same reason: the
// resolution happens ONCE, so all fifty-odd calls below go to one binary rather than to whatever answers to
// the name `gh` at the moment each of them runs; and the absolute path that won is a value this file can print
// into the pin. `execFileSync` with a bare name re-resolves per call and tells the caller nothing.
const resolveOnPath = name => {
  for (const entry of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (entry === '') continue;
    const candidate = path.join(entry, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      // Not this directory's; keep walking. An unreadable entry is not an answer either way.
    }
  }
  return null;
};
const GH = resolveOnPath('gh');
if (!GH) {
  fail('no executable named `gh` is on this run\'s PATH, so this tool has no channel to read the API through '
    + '- and every fact a pin states comes out of that binary, so a run that cannot even name it has no trust '
    + 'root to rest a pin on');
}
let ghVersion = null;
try {
  ghVersion = String(execFileSync(GH, ['--version'], { encoding: 'utf8' })).split('\n')[0].trim();
} catch (error) {
  ghVersion = null;
}
if (!ghVersion) {
  fail(`the \`gh\` this run resolved (${GH}) would not state its version, so the binary every fact below is `
    + 'read through cannot be identified in the pin that rests on it');
}
// AN EXPECTATION IS THE RUN'S TO STATE, AND THIS FILE DOES NOT INVENT ONE. Hard-coding a path or a version
// here would be folklore: the runner image changes, and a constant nobody measured is the defect this
// repository keeps paying for. So the observation is always RECORDED, and it is a REFUSAL only where the run
// itself said what it expected and got something else.
const expectedGh = process.env.VERIFIER_EXPECTED_GH ?? null;
const expectedGhVersion = process.env.VERIFIER_EXPECTED_GH_VERSION ?? null;
if (expectedGh && expectedGh !== GH) {
  fail(`this run expects its \`gh\` at ${JSON.stringify(expectedGh)} (VERIFIER_EXPECTED_GH) and PATH resolved `
    + `${JSON.stringify(GH)}: the binary that would answer every API question here is not the one this run `
    + 'says it trusts');
}
if (expectedGhVersion && expectedGhVersion !== ghVersion) {
  fail(`this run expects gh ${JSON.stringify(expectedGhVersion)} (VERIFIER_EXPECTED_GH_VERSION) and ${GH} `
    + `reports ${JSON.stringify(ghVersion)}`);
}

// THE SECOND TRUST ROOT, ON THE SAME TERMS AS THE FIRST. `gh` is not the only subprocess this file's evidence
// comes out of: node has no zip reader in its standard library, so the RECEIPT BODY - the thing every
// downstream check reads - is taken out of the verified archive by `python3`. A review measured what that
// cost while this binary was a bare name resolved through PATH at call time: a dishonest `python3` ahead of
// the real one on PATH, everything else honest, and out came a pin whose `receipt.conclusion` said
// `{"verdict":"success","suite_state":"green"}` over the digest of an archive that was red. So it is resolved
// once, read back, recorded and refuseable here, exactly as `gh` is above, rather than named at the call site.
const PY = resolveOnPath('python3');
if (!PY) {
  fail('no executable named `python3` is on this run\'s PATH, and this tool has no other way to open the '
    + 'artifact archive: the receipt body every check below reads comes out of that binary, so a run that '
    + 'cannot even name it has no trust root to rest a pin on');
}
let pyVersion = null;
try {
  pyVersion = String(execFileSync(PY, ['--version'], { encoding: 'utf8' })).split('\n')[0].trim();
} catch (error) {
  pyVersion = null;
}
if (!pyVersion) {
  fail(`the \`python3\` this run resolved (${PY}) would not state its version, so the binary the receipt body `
    + 'is read through cannot be identified in the pin that rests on it');
}
const expectedPython = process.env.VERIFIER_EXPECTED_PYTHON ?? null;
const expectedPythonVersion = process.env.VERIFIER_EXPECTED_PYTHON_VERSION ?? null;
if (expectedPython && expectedPython !== PY) {
  fail(`this run expects its \`python3\` at ${JSON.stringify(expectedPython)} (VERIFIER_EXPECTED_PYTHON) and `
    + `PATH resolved ${JSON.stringify(PY)}: the binary that would turn the verified archive into the receipt `
    + 'body is not the one this run says it trusts');
}
if (expectedPythonVersion && expectedPythonVersion !== pyVersion) {
  fail(`this run expects python3 ${JSON.stringify(expectedPythonVersion)} (VERIFIER_EXPECTED_PYTHON_VERSION) `
    + `and ${PY} reports ${JSON.stringify(pyVersion)}`);
}

// AND IT IS RUN SOMEWHERE THAT IS NOT THE TREE BEING JUDGED. `verify-claim.yml` does `cd candidate` before it
// invokes this tool, so a subprocess started with no `cwd` inherits the CANDIDATE'S REPOSITORY ROOT - and
// `python3 -c` puts `''`, the working directory, FIRST on `sys.path`. A review dropped a `zipfile.py` in the
// candidate tree and got a pin over a body that decided nothing, recording main's real blob id as the rule
// that admitted it: the round that moved the filesystem out of the MODULE chain had left it in the
// RECEIPT-BYTES chain. Reproduced here before the fix and refused after it; see the test named for it.
//
// The directory chosen is the filesystem root of this tool's own location. It is not a value read out of the
// inherited environment, no checkout can be it, and nothing this run writes goes there - so no relative
// resolution the subprocess performs can land in the tree under judgement. It is the belt; `-P` below is the
// braces, and the braces are what actually decide.
const SUBPROCESS_CWD = path.parse(import.meta.dirname).root;

const api = (endpoint, options = {}) => execFileSync(GH, ['api', ...(options.headers ?? []), endpoint],
  { encoding: options.binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 });
const apiJson = endpoint => JSON.parse(api(endpoint));

// THE PROTECTED-REF GUARD RAIL, SETTLED BEFORE ANY OTHER LINE RUNS. It is read here, at the top, from the
// environment the runner sets before node starts, so that no FILE this process later loads can be the thing
// that decided it. `mayPin` is consulted once, at the emit site; there is no other way out of this file with a
// pin. What it stops and what it does not is set out in the header: a workflow that sets these two variables
// itself gets past it, so this is a rail against accident and not a defence against a candidate. The binding
// consumer is `verify-claim.yml`, dispatched from protected main.
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
// is the one inside the artifact GitHub digested" holds to the extent the READER can be relied on - and the
// reader is named, resolved, version-read, isolated and recorded rather than being the bare word `python3` at
// a call site, which is what it was when a review last read this sentence. What the order of these lines
// establishes on its own is narrower and worth saying separately: these bytes were hashed before they were
// opened, and the only thing they were ever handed to is the interpreter below. The receipt's own
// sha256, computed further down, is a different quantity and is used as a different thing: the attestation's
// subject. It is never compared with the artifact digest, because the two are hashes of different objects.
const zip = api(`/repos/${repo}/actions/artifacts/${artifact.id}/zip`, { binary: true });
const zipDigest = `sha256:${sha256(zip)}`;
if (zipDigest !== artifact.digest) {
  fail(`the ${ARTIFACT_NAME} archive downloaded for run ${runId} is ${zip.length} bytes hashing to ${zipDigest}, `
    + `but GitHub reports ${artifact.digest} for artifact ${artifact.id}: these are not the bytes GitHub `
    + 'served, so nothing taken out of them can stand for what that run produced');
}

// AND IT IS OPENED IN MEMORY, WITH NO FILE ANYWHERE IN BETWEEN. This used to write the verified zip to a temp
// directory, hand python3 the PATH, and read the extracted `receipt.json` back off another path - three
// filesystem round trips between the bytes that were hashed and the bytes that were read, every one of them a
// time-of-check-to-time-of-use gap, and `os.tmpdir()` is `TMPDIR`, an environment variable. The verified bytes
// now go to python3 on stdin and the receipt comes back on stdout, so the bytes parsed below are the bytes
// that hashed to `artifact.digest` by construction rather than by the absence of an interloper.
//
// AND THE INTERPRETER IS ISOLATED FROM THE TREE IT IS RUN BESIDE, which is the other half of that sentence and
// the half a review found missing. `python3 -c` prepends `''` - the working directory - to `sys.path`, so
// until this round a `zipfile.py` in the candidate's checkout was the zip reader, and a candidate could hand
// this tool any receipt body it liked while every digest above still checked out. `-P` stops that prepending;
// `cwd` is set so that the working directory is not the candidate's anyway.
//
// THE ISOLATION IS THEN MEASURED RATHER THAN ASSUMED, because `-P` is a flag and a flag is a claim about an
// interpreter this file did not build. The subprocess reports its own `sys.path` entries that resolve to its
// working directory, and any at all is a refusal naming `-P`: an interpreter too old for the flag, or one
// invoked in some way that reinstated the entry, is refused instead of silently trusted.
//
// WHAT THAT MEASUREMENT DOES NOT ESTABLISH, said here rather than left to be inferred: the report is produced
// BY the interpreter, so it is a description and not a proof. A `python3` that lies about `sys.path` lies
// about this too. That is the same standing this file gives `gh`, and it is handled the same way - the binary
// is resolved once, read back, recorded in the pin, and refuseable against an expectation the run states.
let receiptBytes;
let importReport;
try {
  const answer = execFileSync(PY, ['-P', '-c', [
    'import sys, os, io, json, zipfile',
    'here = os.getcwd()',
    'report = {"cwd": here, "zip_reader": getattr(zipfile, "__file__", None),',
    '          "working_directory_on_path": [p for p in sys.path if os.path.abspath(p) == here]}',
    'with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:',
    '    names = [n for n in archive.namelist() if n.endswith("receipt.json")]',
    '    if len(names) != 1:',
    '        print(f"expected one receipt.json, found {names}", file=sys.stderr); sys.exit(1)',
    '    body = archive.read(names[0])',
    'sys.stdout.buffer.write(json.dumps(report).encode("utf8") + b"\\n")',
    'sys.stdout.buffer.write(body)',
  ].join('\n')], { input: zip, cwd: SUBPROCESS_CWD, maxBuffer: 256 * 1024 * 1024 });
  // The report is one line, then the bytes. Splitting at the first newline rather than parsing the whole
  // answer keeps the receipt's bytes untouched - JSON may carry newlines, and these bytes are hashed.
  const newline = answer.indexOf(0x0a);
  if (newline < 0) throw new Error('the reader wrote no import report before the receipt');
  importReport = JSON.parse(answer.subarray(0, newline).toString('utf8'));
  receiptBytes = answer.subarray(newline + 1);
} catch (error) {
  fail(`the ${ARTIFACT_NAME} archive of run ${runId} holds no single receipt.json this tool could read with `
    + `${PY} -P (${String(error.stderr ?? error.message).trim()}). A \`python3\` that does not accept \`-P\` `
    + 'cannot be kept off the working directory it was started in, and this tool will not read a receipt '
    + 'through an interpreter it cannot isolate');
}
if (importReport.working_directory_on_path.length > 0) {
  fail(`${PY} was run with \`-P\` and still reports its working directory on the import path `
    + `(${JSON.stringify(importReport.working_directory_on_path)} resolving to `
    + `${JSON.stringify(importReport.cwd)}), so a file sitting beside it could have been the zip reader that `
    + 'produced the receipt body every check below reads');
}
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
// THE BYTES THAT DECIDE, AND NOT A PATH TO THEM. The round before this one fetched the rule, hashed it in
// memory, WROTE IT TO A TEMP DIRECTORY and imported that path - which is the same time-of-check-to-time-of-use
// shape the paragraph above names, one stage later. `os.tmpdir()` is `TMPDIR`, an environment variable, and a
// mkdtemp name being unpredictable defends the wrong property: an attacker with the variable does not have to
// PREDICT the name, it watches the directory it chose and replaces the file between the write and the import.
// A review did exactly that and got a pin over a red body with `derived_reasons: []`, recording main's real
// blob id as the rule that admitted it while a permissive module decided.
//
// So there is no path. The module is imported from a `data:` URL built out of the verified bytes themselves,
// and the permission list is handed to it AS BYTES through `toleratedSkipsBytes`. Between the hash check and
// the decision there is now no filesystem object for anything to substitute - not a directory, not a file,
// not a name - so the gap is closed by construction rather than made unlikely.
//
// SO THE BYTES THAT DECIDE DO NOT COME FROM THE CHECKOUT AT ALL. They are fetched over the contents API at
// refs/heads/main, and three things are required of the answer before a byte of it is used: the API must
// serve it, its `encoding` must be base64 (GitHub answers `"encoding": "none"` with an empty `content` for a
// file it will not inline, and a check that can pass by decoding nothing is not a check), and the decoded
// bytes must hash to the `sha` the API reports for that path. That sha is the git blob id, so it is recomputed
// the way git computes one - sha1("blob <len>\0" + bytes), with node crypto and never with a git binary,
// because this path must not depend on a working tree or on history. The verified bytes are imported directly
// as a `data:` module; `.github/verifier-receipt/admissibility.mjs` in the checkout is never imported, never
// read for the decision, and never trusted.
//
// The permission list travels the same way and for the same reason: `tolerated-skips.json` says which skipped
// tests are tolerable, so it is permission, and permission must come from the branch that grants it. Its
// verified bytes are handed to the rule directly, so the list that decides is the list that was checked.
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
// process is not here: what is imported is a `data:` URL whose payload IS the verified bytes. There is no file
// to swap, no directory to watch and no name to race - the module's identity and its contents are the same
// object. The rule is loaded from bytes, so it has no directory to resolve its own permission list against;
// that is why the list is passed in below rather than left to a default.
const RULE_URL = `data:text/javascript;base64,${fetchedModule.bytes.toString('base64')}`;
const { deriveAdmissibility } = await import(RULE_URL);
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
// The permission list decides AS BYTES. Not a path to bytes that were once these: the fetched, hash-checked
// bytes themselves, so there is nothing between the check and the decision for anything to substitute.
const derived = deriveAdmissibility(receipt, { toleratedSkipsBytes: fetchedSkips.bytes });
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
  // WHAT THIS FETCH ACTUALLY RESTED ON, MEASURED AT RUN TIME. Two binaries, because there are two channels:
  // `gh` answered every API question above, and `python3` turned the verified archive into the receipt body.
  // Naming both is the difference between a pin that states its trust roots and one that leaves a reader to
  // assume GitHub. `zip_reader` is the file the isolated interpreter reported for its `zipfile` module - the
  // interpreter's own answer, recorded as such, not a fact this file established about it.
  //
  // It describes THIS run's channels and not the receipt, which is why `compare-pin.mjs` names it as
  // deliberately not compared: the candidate's committed pin was produced by another run on another machine,
  // so requiring the two to agree would refuse honest pins and establish nothing. What that step does instead
  // is PRINT the committed block beside this one, so the durable record's unverified trust-root statement is
  // in the log rather than passing silently.
  fetched_with: {
    gh: GH,
    gh_version: ghVersion,
    expected_gh: expectedGh,
    expected_gh_version: expectedGhVersion,
    python: PY,
    python_version: pyVersion,
    expected_python: expectedPython,
    expected_python_version: expectedPythonVersion,
    zip_reader: importReport.zip_reader,
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
// Nothing to clean up: this tool writes no temp file, so there is none to remove and none to race. The only
// file it can write is the `--out` pin, and only on a run that may emit one.

// THE PROTECTED-REF GUARD RAIL, ENFORCED. Everything above has passed; on a run that is not the protected branch's,
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
  console.error(`ADVISORY   read through ${GH} (${ghVersion}) and opened with ${PY} (${pyVersion}), which is `
    + 'what all of the above rests on');
  console.error('ADVISORY - no pin was emitted, and nothing above may be committed as one.');
  process.exit(4);
}
const serialised = `${JSON.stringify(pin, null, 2)}\n`;
if (out) fs.writeFileSync(out, serialised);
console.log(serialised);
