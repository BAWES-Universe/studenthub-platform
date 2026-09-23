// Builds the world one run of the receipt authority sees: a capture the trusted measure job wrote, zipped as
// that job's artifact, and the API facts that describe the run, the job, the artifact, the candidate and the
// claim. Every test starts from a world that holds together and breaks exactly one fact, so a refusal can be
// attributed to the field it names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EMITTER = path.join(HERE, '..', 'emit-receipt.mjs');
export const RUNNERS = path.join(HERE, '..', 'runners.json');
export const GH_STUB = path.join(HERE, 'gh-stub.mjs');

export const REPO = 'BAWES-Universe/studenthub-platform';
export const RUN_ID = '34900000001';
export const RUN_ATTEMPT = '1';
export const TRUSTED_SHA = 'a'.repeat(40);
export const CANDIDATE_SHA = 'b'.repeat(40);
export const CANDIDATE_TREE = 'c'.repeat(40);
export const CLAIM_HEAD = 'd'.repeat(40);
export const CLAIM_TREE = 'e'.repeat(40);
export const ARTIFACT_ID = '10400000001';
export const MEASURE_JOB_NAME = 'measure';
export const ARTIFACT_NAME = 'measure-capture';
export const RUNNER_KEY = 'coordinator';
export const RUNNER_COMMAND = JSON.parse(fs.readFileSync(RUNNERS, 'utf8')).runners[RUNNER_KEY].command;
export const CLAIM_PATH = '.github/coordinator/service/claim-manifest.json';
// The object ids the contents API reports for the authority paths. The emitter compares these between main and
// the candidate, so a world in which they agree is a world whose candidate leaves the authority alone.
export const AUTHORITY_WORKFLOW_SHA = '1a'.repeat(20);
export const AUTHORITY_DIR_SHA = '2b'.repeat(20);

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
// What `node --test` would have exited with for a capture: non-zero if and only if it reported a failing or a
// cancelled point. A capture with no summary at all (a truncated or hand-written stream, which several tests
// supply deliberately) reads as 0, and is refused on its structure long before the exit code is reconciled.
const exitFor = capture => {
  const of = field => Number(new RegExp(`^# ${field} (\\d+)$`, 'm').exec(capture)?.[1] ?? 0);
  return of('fail') + of('cancelled') > 0 ? '1' : '0';
};

// A genuine capture: `node --test --test-reporter=tap` run over a fixture file, so what the parser is fed is
// the reporter's own bytes rather than a hand-shaped imitation of them. Used where the point of the test is
// what a REAL runner reports - duplicate point names, nesting - and not what a world asserts.
export const genuineTap = fixture => {
  const file = path.join(HERE, 'fixtures', fixture);
  // NODE_TEST_CONTEXT is set in the environment of a process the test runner started, and a nested
  // `node --test` that sees it reports to its parent in v8-serialised frames instead of writing TAP. This run
  // is a capture, not a subtest, so the variable is removed for it.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    return execFileSync(process.execPath, ['--test', '--test-reporter=tap', file],
      { encoding: 'utf8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // A fixture with a failing test exits non-zero; its stdout is still the capture the measure job would
    // have taken, and the suite exit code travels separately.
    return String(error.stdout ?? '');
  }
};

// A capture shaped exactly as `node --test --test-reporter=tap` writes one, naming the tests the claim names.
//
// `locations` maps a test name to the file the runner would have reported the point in, and it DEFAULTS to
// `ARTIFACT_LOCATION` for every name - the file the default claim's entries name. That default is a change,
// and the reason for it is the rule it exercises: the emitter no longer establishes a term from a point the
// runner reported no file for, so a world whose points carry no `location:` establishes nothing and could not
// be a positive control for anything else. What such a world models is the REPORTER, not the runner: the stock
// `node --test --test-reporter=tap` at v22.22.3 writes `location:` on a FAILING point and on no other, which
// is why no capture from it can establish a term and why the repository-level fix is written out in
// .github/verifier-receipt/LOCATION-REPORTER.md. A test that wants the stock shape passes `locations: null`
// and asserts exactly that - there is one below that does.
//
// A partial map is MERGED over the default, so a test that moves one name to another file keeps the others
// bound where their claim says they are and the assertion stays about the one name it moved.
//
// `at` overrides the LINE a point is declared at, which is otherwise distinct per point - because a real
// runner declares two different tests on two different lines, and two points sharing one `<file>:<line>` is
// the shape the emitter refuses as one test reported under two names. A test that wants that shape asks for
// it here.
export const tapFor = (names, { failing = [], locations, at = {} } = {}) => {
  const where = locations === null ? {}
    : { ...Object.fromEntries(names.map(name => [name, ARTIFACT_LOCATION])), ...(locations ?? {}) };
  const lines = ['TAP version 13'];
  names.forEach((name, index) => {
    const ok = failing.includes(name) ? 'not ok' : 'ok';
    lines.push(`# Subtest: ${name}`, `${ok} ${index + 1} - ${name}`, '  ---', '  duration_ms: 1.5', "  type: 'test'");
    if (where[name]) lines.push(`  location: '${where[name]}:${at[name] ?? 12 + index}:1'`);
    lines.push('  ...');
  });
  lines.push(`1..${names.length}`, `# tests ${names.length}`, '# suites 0', `# pass ${names.length - failing.length}`,
    `# fail ${failing.length}`, '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 12.5', '');
  return lines.join('\n');
};

export const CAPTURE_PROGRAM = path.join(HERE, '..', 'capture-stream.mjs');

// RUN THE TRUSTED CAPTURE PROGRAM FOR REAL, the way the measure job runs it: a fresh RUNNER_TEMP, the capture
// directory it is expected to create itself, a candidate directory to run in, and the runner command the
// protected enum would have supplied. What comes back is what that program really wrote - the bytes, its meta,
// its exit code and its diagnostics - so the tests below are about a capture this authority produced rather than
// one a test assembled.
export const runCapture = ({ fixture, runnerCommand, preCreateDir = false, env: envPatch = {} } = {}) => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-temp-'));
  const captureDir = path.join(runnerTemp, 'capture');
  if (preCreateDir) fs.mkdirSync(captureDir);
  // The measure job's $GITHUB_OUTPUT, so the tests can read the channel that travels through GitHub rather
  // than through the artifact - and so a fixture that forges the artifact can be shown NOT to have reached it.
  const outputFile = path.join(runnerTemp, 'github-output');
  fs.writeFileSync(outputFile, '');
  const childEnv = {
    GITHUB_OUTPUT: outputFile,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RUNNER_TEMP: runnerTemp,
    CAPTURE_DIR: captureDir,
    CANDIDATE_DIR: HERE,
    RUNNER_COMMAND: runnerCommand ?? `node --test --test-reporter=tap fixtures/${fixture}`,
    RUNNER_KEY,
    CANDIDATE_SHA,
    CANDIDATE_TREE,
    TRUSTED_SOURCE_SHA: TRUSTED_SHA,
    JOB_NAME: MEASURE_JOB_NAME,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
    ...envPatch,
  };
  // NODE_TEST_CONTEXT is deliberately absent: a nested `node --test` that sees it reports to its parent in
  // v8-serialised frames instead of writing TAP, and what these tests need is the reporter's own bytes.
  let out;
  try {
    out = { code: 0, stdout: execFileSync(process.execPath, [CAPTURE_PROGRAM],
      { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (error) {
    out = { code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
  const capturePath = path.join(captureDir, 'suite.out');
  const metaPath = path.join(captureDir, 'capture-meta.json');
  const outputs = Object.fromEntries(fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean)
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return {
    ...out,
    captureDir,
    runnerTemp,
    outputs,
    outputFile,
    entries: fs.existsSync(captureDir) ? fs.readdirSync(captureDir).sort() : [],
    bytes: fs.existsSync(capturePath) ? fs.readFileSync(capturePath, 'utf8') : null,
    meta: fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null,
  };
};

// The artifact a manifest entry names, in the manifest's own spelling (relative to the manifest's directory)
// and in the repository spelling the emitter resolves it to. The real manifest looks exactly like this: it says
// `test/shu71-postpush-readback-checks.mjs` for a file the repository holds under
// `.github/coordinator/service/test/`.
export const ARTIFACT = 'test/coordinator-checks.mjs';
export const ARTIFACT_PATH = `.github/coordinator/service/${ARTIFACT}`;
// Where the runner would report a point of that file: an absolute path into whatever directory the candidate was
// checked out to, which is why the emitter matches it as a component-aligned suffix rather than for equality.
export const ARTIFACT_LOCATION = `/home/runner/work/repo/repo/candidate/${ARTIFACT_PATH}`;

// THE TWO FIELDS EVERY ENTRY OF THE REAL MANIFEST CARRIES AND THIS WORLD DEFAULTS. `disposition` is the
// manifest's own verdict on the term and `PASS` is the only value that permits establishment; `approvable: false`
// bars it independently. The worlds below are worlds that HOLD TOGETHER, so their entries say PASS - a claim
// stating no disposition establishes nothing, which is a refusal several tests provoke deliberately by setting
// the field themselves. `'disposition' in entry` is the test, so an entry that says `null` keeps saying null.
// AND THE TWO EVIDENCE FIELDS AN ENTRY THAT SAYS `PASS` MUST NOW CARRY. The emitter refuses an entry that
// claims an establishing disposition while naming no receipt that verified it and no mutant that must die for
// it - the defeat it closes is flipping the real manifest's 53 `BLOCK`s to `PASS` and changing nothing else,
// leaving `receipts: []` on every one of them. So a world that HOLDS TOGETHER carries both, and a test that
// wants the empty shape sets it and asserts the refusal.
//
// `receipts` is defaulted here because nothing in these tests is about its contents - the emitter reads its
// LENGTH and carries the count. `killing_mutants` is NOT defaulted, because a mutant is a test NAME and a name
// this world's capture does not report would make every term `absent`; each claim below names its own.
const PERMITTED = { approvable: true, disposition: 'PASS',
  receipts: [{ path: 'receipts/coordinator.json', sha256: `${'9'.repeat(64)}` }] };
const withDisposition = claim => (claim === null || typeof claim !== 'object' || !Array.isArray(claim.entries)
  ? claim
  : { ...claim, entries: claim.entries.map(entry => (entry === null || typeof entry !== 'object' || Array.isArray(entry)
    ? entry
    : { ...PERMITTED, artifact: ARTIFACT, ...entry })) });

// AND A KILLING MUTANT ON EVERY ESTABLISHING ENTRY. The emitter refuses an entry that states an establishing
// disposition while naming no mutant that must die for it, so each entry below names one - and each name is a
// point this world's capture reports, because a mutant is a test and a test the runner never reported is
// `absent`. That is why NAMED_TESTS is four names for two terms: a control and a mutant each.
export const CLAIM = {
  code_revision: { head: CLAIM_HEAD, tree: CLAIM_TREE },
  entries: [
    { id: 'TERM-1', artifact: ARTIFACT, control: { test_names: ['the coordinator refuses a stale head'] },
      killing_mutants: [{ test_name: 'the mutant that removes the stale-head guard dies' }], ...PERMITTED },
    { id: 'TERM-2', artifact: ARTIFACT, control: { test_names: ['the push broker retries only reads'] },
      killing_mutants: [{ test_name: 'the mutant that removes the read-only retry guard dies' }], ...PERMITTED },
  ],
};
export const NAMED_TESTS = ['the coordinator refuses a stale head',
  'the mutant that removes the stale-head guard dies', 'the push broker retries only reads',
  'the mutant that removes the read-only retry guard dies'];

// Build a world on disk. `patch` may replace any part of it before the artifact is zipped and the routes are
// written, which is how each refusal below is provoked with one wrong fact and everything else intact.
// THE TRAILER THE TRUSTED CAPTURE PROCESS APPENDS, rebuilt here exactly as capture-stream.mjs writes it. A
// world builds the BODY - the bytes a runner produced - and this adds the one line the measured code did not
// write, so every world below is the shape the emitter now requires and a test that wants a capture with no
// trailer, two trailers or a forged one asks for that deliberately.
// The interpreter and the image the trusted capture program now records - in the trailer, inside the hashed
// stream, and in the meta beside it. `process.version` is used rather than a fixed string so that a world
// built here says what the node running these tests really is, exactly as the capture program does.
export const RUNNER_NODE = process.version;
export const RUNNER_ARCH = process.arch;
export const RUNNER_IMAGE = 'ubuntu24';
export const RUNNER_IMAGE_VERSION = '20260901.1.0';
const field = value => encodeURIComponent(String(value));
export const trailerFor = ({ body, exit, signal = null, run = RUN_ID, attempt = RUN_ATTEMPT,
  job = MEASURE_JOB_NAME, candidate = CANDIDATE_SHA, tree = CANDIDATE_TREE, runner = RUNNER_KEY,
  node = RUNNER_NODE, arch = RUNNER_ARCH, image = RUNNER_IMAGE, imageVersion = RUNNER_IMAGE_VERSION } = {}) => {
  const bytes = Buffer.from(body);
  return `# verifier-capture v1 exit=${field(exit)} signal=${field(signal ?? '-')} `
    + `body_bytes=${bytes.length} body_sha256=${sha256(bytes)} run=${field(run)} attempt=${field(attempt)} `
    + `job=${field(job)} candidate=${field(candidate)} tree=${field(tree)} runner=${field(runner)} `
    + `node=${field(node)} arch=${field(arch)} image=${field(image)} image_version=${field(imageVersion)}`;
};
export const withTrailer = (body, trailer) => {
  const bytes = Buffer.from(body);
  const separator = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a ? '' : '\n';
  return Buffer.concat([bytes, Buffer.from(`${separator}${trailer}\n`, 'utf8')]).toString('utf8');
};

export const build = (patch = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-world-'));
  const captureDir = path.join(root, 'capture');
  fs.mkdirSync(captureDir);

  // `capture` is the runner's own output; the world appends the trusted trailer to it, the way the measure job
  // does. `wholeCapture` is for the two callers that hold real bytes a real capture program already wrote -
  // the positive control over the pinned candidate's suite, and the tests that take a capture for real.
  const body = patch.capture ?? tapFor(NAMED_TESTS);
  const suiteExit = patch.meta?.suite_exit ?? exitFor(body);
  const capture = patch.wholeCapture ?? withTrailer(body,
    patch.trailer ?? trailerFor({ body, exit: suiteExit }));
  fs.writeFileSync(path.join(captureDir, 'suite.out'), capture);
  const bodyBytes = Buffer.from(patch.wholeCapture ? (patch.body ?? body) : body);
  const meta = {
    schema: 2,
    job_name: MEASURE_JOB_NAME,
    run_id: RUN_ID,
    run_attempt: RUN_ATTEMPT,
    workflow_path: '.github/workflows/verifier-receipt.yml',
    trusted_source_sha: TRUSTED_SHA,
    candidate_sha: CANDIDATE_SHA,
    candidate_tree: CANDIDATE_TREE,
    runner_key: RUNNER_KEY,
    runner_command: RUNNER_COMMAND,
    runner_node: RUNNER_NODE,
    runner_arch: RUNNER_ARCH,
    runner_image: RUNNER_IMAGE,
    runner_image_version: RUNNER_IMAGE_VERSION,
    capture_file: 'suite.out',
    capture_bytes: Buffer.byteLength(capture),
    capture_sha256: sha256(Buffer.from(capture)),
    capture_body_bytes: bodyBytes.length,
    capture_body_sha256: sha256(bodyBytes),
    capture_trailer: capture.slice(0, -1).split('\n').pop(),
    suite_exit_source: 'waitpid',
    // The exit status the runner really returned, DERIVED FROM THE CAPTURE the world holds rather than fixed at
    // '0'. The emitter now refuses a capture whose counts contradict the exit code the trusted job recorded, so a
    // world whose capture reports a failing point beside `suite_exit: '0'` is a self-contradictory world and
    // would be refused on that rather than on the fact each test is about. `node --test` exits non-zero exactly
    // when it reports a failing or cancelled point, and this reproduces that rule.
    suite_exit: suiteExit,
    suite_signal: null,
    // The measure job hashes the stream as it passes through a trusted process and records that it did. The
    // emitter refuses any other value, because a digest taken over a file the measured suite could have replaced
    // authenticates nothing about who wrote the bytes.
    capture_hash_source: 'stream',
    capture_hashed_by: '.github/verifier-receipt/capture-stream.mjs',
    ...(patch.meta ?? {}),
  };
  fs.writeFileSync(path.join(captureDir, 'capture-meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  for (const [name, body] of Object.entries(patch.extraArtifactFiles ?? {})) {
    fs.writeFileSync(path.join(captureDir, name), body);
  }

  const zipPath = path.join(root, 'artifact.zip');
  execFileSync('python3', ['-c', [
    'import os, sys, zipfile',
    'root = sys.argv[1]',
    'with zipfile.ZipFile(sys.argv[2], "w") as archive:',
    '    for name in sorted(os.listdir(root)):',
    '        archive.write(os.path.join(root, name), name)',
  ].join('\n'), captureDir, zipPath]);
  const archiveDigest = `sha256:${sha256(fs.readFileSync(zipPath))}`;

  const claim = patch.rawClaim ?? withDisposition(patch.claim ?? CLAIM);
  const claimBytes = Buffer.from(`${JSON.stringify(claim, null, 2)}\n`);

  const run = {
    id: Number(RUN_ID), path: '.github/workflows/verifier-receipt.yml', event: 'workflow_dispatch',
    head_branch: 'main', head_sha: TRUSTED_SHA, run_attempt: Number(RUN_ATTEMPT), status: 'completed',
    conclusion: 'success', ...(patch.run ?? {}),
  };
  const job = {
    id: 99000001, name: MEASURE_JOB_NAME, status: 'completed', conclusion: 'success',
    started_at: '2026-09-23T00:00:00Z', completed_at: '2026-09-23T00:09:00Z', ...(patch.job ?? {}),
  };
  const artifact = {
    id: Number(ARTIFACT_ID), name: ARTIFACT_NAME, expired: false, digest: archiveDigest,
    size_in_bytes: fs.statSync(zipPath).size, created_at: '2026-09-23T00:09:10Z',
    workflow_run: { id: Number(RUN_ID) }, ...(patch.artifact ?? {}),
  };

  const routes = {
    [`/repos/${REPO}/actions/runs/${RUN_ID}`]: { json: run },
    [`/repos/${REPO}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}/jobs`]: { json: { jobs: [{ id: 99000000, name: 'trust', status: 'completed', conclusion: 'success' }, job] } },
    [`/repos/${REPO}/actions/runs/${RUN_ID}/artifacts`]: { json: { artifacts: [artifact] } },
    [`/repos/${REPO}/actions/artifacts/${artifact.id}/zip`]: { binary_file: zipPath },
    [`/repos/${REPO}/commits/${CANDIDATE_SHA}`]: { json: { sha: CANDIDATE_SHA, commit: { tree: { sha: CANDIDATE_TREE } },
      parents: patch.candidateParents ?? [{ sha: CLAIM_HEAD }] } },
    [`/repos/${REPO}/commits/${CLAIM_HEAD}`]: { json: { sha: CLAIM_HEAD, commit: { tree: { sha: CLAIM_TREE } } } },
    // The authority as the contents API reports it: the same object ids on main and at the candidate.
    [`/repos/${REPO}/contents/.github/workflows?ref=main`]: { json: [{ name: 'ci.yml', type: 'file', sha: '3c'.repeat(20) },
      { name: 'verifier-receipt.yml', type: 'file', sha: AUTHORITY_WORKFLOW_SHA }] },
    [`/repos/${REPO}/contents/.github/workflows?ref=${CANDIDATE_SHA}`]: { json: [{ name: 'ci.yml', type: 'file', sha: '3c'.repeat(20) },
      { name: 'verifier-receipt.yml', type: 'file', sha: AUTHORITY_WORKFLOW_SHA }] },
    [`/repos/${REPO}/contents/.github?ref=main`]: { json: [{ name: 'coordinator', type: 'dir', sha: '4d'.repeat(20) },
      { name: 'verifier-receipt', type: 'dir', sha: AUTHORITY_DIR_SHA }, { name: 'workflows', type: 'dir', sha: '5e'.repeat(20) }] },
    [`/repos/${REPO}/contents/.github?ref=${CANDIDATE_SHA}`]: { json: [{ name: 'coordinator', type: 'dir', sha: '6f'.repeat(20) },
      { name: 'verifier-receipt', type: 'dir', sha: AUTHORITY_DIR_SHA }, { name: 'workflows', type: 'dir', sha: '5e'.repeat(20) }] },
    [`/repos/${REPO}/compare/${CLAIM_HEAD}...${CANDIDATE_SHA}`]: { json: { status: 'ahead', ahead_by: 1, behind_by: 0,
      total_commits: 1, files: [{ filename: CLAIM_PATH, status: 'modified' }] } },
    [`/repos/${REPO}/contents/${CLAIM_PATH}?ref=${CANDIDATE_SHA}`]: { json: { sha: 'f'.repeat(40), content: claimBytes.toString('base64') } },
    [`/repos/${REPO}/compare/${TRUSTED_SHA}...main`]: { json: { status: 'identical' } },
    ...(patch.routes ?? {}),
  };
  for (const key of patch.dropRoutes ?? []) delete routes[key];
  const routesPath = path.join(root, 'routes.json');
  fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2));

  return { root, routesPath, zipPath, archiveDigest, artifact, meta, capture, claimBytes,
    receiptPath: path.join(root, 'receipt.json') };
};

// `emitter` names which emitter to run, defaulting to the shipped one. Only the tests that show the per-entry
// keying holds ON ITS OWN override it, by running a copy of the emitter with the manifest shape refusals
// neutered. Two defences that are each load-bearing have to be tested apart, or the pair proves only that at
// least one of them works.
export const emit = (world, envPatch = {}, emitter = EMITTER) => {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GH_BIN: GH_STUB,
    PY_BIN: 'python3',
    GH_STUB_ROUTES: world.routesPath,
    REPO,
    RUN_ID,
    RUN_ATTEMPT,
    TRUSTED_SOURCE_SHA: TRUSTED_SHA,
    TRUSTED_SOURCE_ORIGIN: 'protected-main',
    MEASURE_JOB_NAME,
    MEASURE_ARTIFACT_NAME: ARTIFACT_NAME,
    MEASURE_ARTIFACT_ID: ARTIFACT_ID,
    MEASURE_ARTIFACT_DIGEST: world.archiveDigest,
    // The exit status the trusted capture process published as the measure job's own output - the one fact the
    // emitter holds from outside the artifact. A world's default is the one its own capture justifies.
    MEASURE_SUITE_EXIT: world.meta.suite_exit,
    CANDIDATE_SHA,
    CANDIDATE_TREE,
    RUNNER_KEY,
    RUNNER_SPEC_PATH: RUNNERS,
    OUT_PATH: world.receiptPath,
    ...envPatch,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  try {
    const stdout = execFileSync(process.execPath, [emitter], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
};

export const receiptOf = world => JSON.parse(fs.readFileSync(world.receiptPath, 'utf8'));

// Run a node process and REPORT what it did rather than throwing, so a test can assert on a non-zero exit and
// on what was written to stderr. Used to run the workflow's gate step - whose body the tests lift verbatim out
// of the YAML - against receipts this emitter really produced, so that second check is exercised rather than
// assumed to say what its source says.
export const runNode = (args, { cwd, env = {} } = {}) => {
  try {
    const stdout = execFileSync(process.execPath, args,
      { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
};
