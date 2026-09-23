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
export const tapFor = (names, { failing = [] } = {}) => {
  const lines = ['TAP version 13'];
  names.forEach((name, index) => {
    const ok = failing.includes(name) ? 'not ok' : 'ok';
    lines.push(`# Subtest: ${name}`, `${ok} ${index + 1} - ${name}`, '  ---', '  duration_ms: 1.5', "  type: 'test'", '  ...');
  });
  lines.push(`1..${names.length}`, `# tests ${names.length}`, '# suites 0', `# pass ${names.length - failing.length}`,
    `# fail ${failing.length}`, '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 12.5', '');
  return lines.join('\n');
};

export const CLAIM = {
  code_revision: { head: CLAIM_HEAD, tree: CLAIM_TREE },
  entries: [
    { id: 'TERM-1', control: { test_names: ['the coordinator refuses a stale head'] },
      killing_mutants: [{ test_name: 'the mutant that removes the stale-head guard dies' }] },
    { id: 'TERM-2', control: { test_names: ['the push broker retries only reads'] }, killing_mutants: [] },
  ],
};
export const NAMED_TESTS = ['the coordinator refuses a stale head',
  'the mutant that removes the stale-head guard dies', 'the push broker retries only reads'];

// Build a world on disk. `patch` may replace any part of it before the artifact is zipped and the routes are
// written, which is how each refusal below is provoked with one wrong fact and everything else intact.
export const build = (patch = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-world-'));
  const captureDir = path.join(root, 'capture');
  fs.mkdirSync(captureDir);

  const capture = patch.capture ?? tapFor(NAMED_TESTS);
  fs.writeFileSync(path.join(captureDir, 'suite.out'), capture);
  const meta = {
    schema: 1,
    job_name: MEASURE_JOB_NAME,
    run_id: RUN_ID,
    run_attempt: RUN_ATTEMPT,
    workflow_path: '.github/workflows/verifier-receipt.yml',
    trusted_source_sha: TRUSTED_SHA,
    candidate_sha: CANDIDATE_SHA,
    candidate_tree: CANDIDATE_TREE,
    runner_key: RUNNER_KEY,
    runner_command: RUNNER_COMMAND,
    capture_file: 'suite.out',
    capture_bytes: Buffer.byteLength(capture),
    capture_sha256: sha256(Buffer.from(capture)),
    suite_exit: '0',
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

  const claim = patch.claim ?? CLAIM;
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
