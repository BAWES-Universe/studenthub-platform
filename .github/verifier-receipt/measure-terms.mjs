#!/usr/bin/env node
// THE MEASUREMENT JOB'S ENTRY POINT. It runs from the authority checkout, in a job that holds `contents:
// read` and nothing else, and it drives every container itself.
//
// WHAT THIS PROCESS IS AND IS NOT. It is the controller: protected code, choosing what runs, owning both
// pipes, taking every exit status from waitpid. It is NOT the attester - this job holds no id-token and no
// attestation permission, so a container escape from here reaches a job that cannot sign anything and
// cannot write to this repository. The job that CAN sign runs no candidate code at all, in or out of a
// container. Those are two different jobs on purpose: the one that could be attacked cannot sign, and the
// one that can sign cannot be attacked by a candidate.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { measure, readJson } from './controller.mjs';
import { sandboxArgv, assertNoEscape, measurementEnv, runSandbox, forbiddenEnvNames, SCRATCH_MOUNT, SOURCE_MOUNT } from './sandbox.mjs';
import { refuseAnyWriteScope } from './job-scope.mjs';

const need = name => { const value = process.env[name]; if (!value) { console.error(`::error::${name} is not set, and this controller does not guess its inputs`); process.exit(2); } return value; };

// ---------------------------------------------------------------------------------------------------
// THE EXEC. The one place this authority invokes a container, and the only interface the measurement has.
// ---------------------------------------------------------------------------------------------------
//
// stdin is /dev/null, stdout and stderr are pipes THIS process created and holds the read end of. The
// container is handed no writable end of anything: no file for its report, no output variable, no socket.
// The exit status below is the docker client's, which is the container's, from waitpid - never a line in
// the stream and never a value anything inside the container chose to print.
export function dockerExec(docker) {
  return (argv, onChunk) => new Promise((resolve, reject) => {
    const child = spawn(docker, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

// PREFLIGHT. The pinned image has to carry the interpreter this authority measures with and the binaries
// the suite shells out to. Finding that out from a red suite is finding it out wrong: a test that failed
// because `git` is absent looks exactly like a test that failed, and a mutant that "died" because the
// interpreter is missing establishes a term off a broken image. So it is probed first, in the same sandbox,
// with the same flags, and a mismatch refuses the whole run.
async function preflight({ image, sourceDir, scratchDir, controllerScratch, io, requires }) {
  // AND IT PROBES WHAT THE MEASUREMENT CAN REACH, not only what it is. Four writes are attempted from inside
  // the container and their errno recorded: the read-only source mount, the controller's scratch by its HOST
  // path, a $GITHUB_OUTPUT-shaped path, and the measurement's own scratch. The first three must fail and the
  // fourth must succeed - a run in which the source is writable, or the controller's own directory is
  // reachable, is a run whose capture and receipt the measured code could rewrite, and this refuses it before
  // a single term is measured rather than discovering it in a review.
  const probe = ['/usr/local/bin/node', '-e',
    'const {execFileSync}=require("node:child_process");const fs=require("node:fs");'
    + 'const out={node:process.versions.node,arch:process.arch,platform:process.platform,uid:process.getuid(),gid:process.getgid(),env:Object.keys(process.env).sort(),cwd:process.cwd(),writes:{},exists:{}};'
    + 'try{out.git=execFileSync("git",["--version"],{encoding:"utf8"}).trim();}catch(e){out.git=null;out.git_error=e.code||String(e);}'
    + 'for(const [what,target] of Object.entries(JSON.parse(process.env.PROBE_PATHS||"{}"))){'
    + 'out.exists[what]=fs.existsSync(target);'
    + 'try{fs.writeFileSync(target,"probe");out.writes[what]="WROTE";}catch(e){out.writes[what]=e.code||String(e);}}'
    + 'process.stdout.write("PREFLIGHT "+JSON.stringify(out));'];
  // PROBE_PATHS is passed as part of the measurement's own environment, so the probe is subject to exactly the
  // stripping it is measuring: it holds the allowlist plus this one name, and the allowlist check below
  // accounts for it explicitly rather than by widening what the allowlist is.
  const probePaths = {
    read_only_source_mount: `${SOURCE_MOUNT}/.probe-write`,
    controller_scratch_by_host_path: path.join(controllerScratch, '.probe-write'),
    receipt_path_by_host_path: path.join(controllerScratch, 'capture', 'suite.out'),
    ci_workspace_path: path.join(process.env.GITHUB_WORKSPACE || '/home/runner/work/repo/repo', 'candidate', '.probe-write'),
    github_output_path: process.env.GITHUB_OUTPUT || '/home/runner/work/_temp/_runner_file_commands/set_output_probe',
    measurement_scratch: `${SCRATCH_MOUNT}/tmp/.probe-write`,
  };
  const observed = await runSandbox({ image, sourceDir, scratchDir, argv: probe,
    env: { ...measurementEnv(), PROBE_PATHS: JSON.stringify(probePaths) } }, io);
  const line = /PREFLIGHT (\{.*\})/.exec(observed.stdout.toString('utf8'));
  if (observed.sandbox_fault !== null || !line)
    throw new Error(`the sandbox could not run the pinned image ${image} (exit ${observed.exit}): ${observed.stdout.toString('utf8').slice(-2000)}`);
  const report = JSON.parse(line[1]);
  const wrong = [];
  if (requires?.node && report.node !== requires.node) wrong.push(`the pinned image carries node ${report.node}, and this authority measures with ${requires.node}`);
  for (const binary of requires?.binaries ?? []) if (binary === 'git' && !report.git) wrong.push(`the pinned image carries no git (${report.git_error}), and this repository's suite shells out to it`);
  if (report.uid !== 10001 || report.gid !== 10001) wrong.push(`the measurement runs as ${report.uid}:${report.gid}, not as 10001:10001`);
  const leaked = forbiddenEnvNames(report.env);
  if (leaked.length > 0) wrong.push(`the measurement's environment carries ${leaked.join(', ')}`);
  const allowed = new Set([...Object.keys(measurementEnv()), 'PROBE_PATHS']);
  const extra = report.env.filter(name => !allowed.has(name));
  if (extra.length > 0) wrong.push(`the measurement's environment carries ${extra.join(', ')}, which this controller did not put there`);
  // WHAT MUST NOT BE WRITABLE, BY NAME. `WROTE` on any of these is the boundary not holding, and the run
  // stops here rather than producing a receipt nobody can tell from a sound one.
  for (const what of ['read_only_source_mount', 'controller_scratch_by_host_path', 'receipt_path_by_host_path',
    'ci_workspace_path', 'github_output_path']) {
    if (report.writes?.[what] === 'WROTE') wrong.push(`the measurement wrote ${what} (${probePaths[what]}), which it must not be able to reach`);
  }
  if (report.writes?.measurement_scratch !== 'WROTE') wrong.push(`the measurement cannot write its own scratch (${report.writes?.measurement_scratch}), so every test that needs a temporary file will fail for a reason that is not about the test`);
  if (wrong.length > 0) throw new Error(`the pinned measurement image is not the one this authority measures in: ${wrong.join('; ')}`);
  return report;
}

async function main() {
  const authorityDir = need('AUTHORITY_DIR');
  const candidateDir = need('CANDIDATE_DIR');
  const scratchRoot = need('SCRATCH_DIR');
  const runnerKey = need('RUNNER_KEY');
  const scope = process.env.MATRIX_SCOPE || runnerKey;
  const outPath = need('OUT_PATH');
  const docker = process.env.DOCKER_BIN || 'docker';

  const receipts = path.join(authorityDir, '.github/verifier-receipt');
  const matrixPath = path.join(receipts, 'matrix.json');
  const matrix = readJson(matrixPath);
  matrix._path = '.github/verifier-receipt/matrix.json';
  matrix._sha256 = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(matrixPath)).digest('hex');
  const runners = readJson(path.join(receipts, 'runners.json'));
  const imagePin = readJson(path.join(receipts, 'image.json'));
  const image = imagePin.reference;
  if (!/^[^@]+@sha256:[0-9a-f]{64}$/.test(image)) {
    console.error(`::error::the measurement image is pinned as ${JSON.stringify(image)}, which is not a digest; a tag is a pointer somebody else can move`);
    process.exit(2);
  }

  const scopes = refuseAnyWriteScope({ workflowPath: path.join(authorityDir, '.github/workflows/verifier-receipt.yml'), jobId: process.env.MEASURE_JOB_ID || 'measure' });
  console.log(`this job holds ${scopes.join(', ')} and no id-token request URL`);

  // THE CONTROLLER'S OWN SCRATCH, 0700 AND OWNED BY THE RUNNER USER, NEVER MOUNTED. The receipt and every
  // controller-observed record live here. The measurement's scratch is a DIFFERENT directory, created
  // inside it by the controller and handed to uid 10001; nothing else under this root is reachable from a
  // container at all, because nothing else under this root is mounted into one.
  const scratchDir = fs.mkdtempSync(path.join(scratchRoot, 'controller-'));
  fs.chmodSync(scratchDir, 0o700);

  const claimPath = path.join(candidateDir, matrix.scopes[scope]?.claim_path ?? '');
  let claim;
  try { claim = readJson(claimPath); }
  catch (error) {
    console.error(`::error::this candidate carries no claim at ${matrix.scopes[scope]?.claim_path} (${error.code ?? error.message}), so there is nothing for the protected matrix to be measured against`);
    process.exit(1);
  }

  const io = { exec: dockerExec(docker) };
  const measurementScratch = path.join(scratchDir, 'measurement');
  fs.mkdirSync(path.join(measurementScratch, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(measurementScratch, 'home'), { recursive: true });
  try { for (const dir of [measurementScratch, path.join(measurementScratch, 'tmp'), path.join(measurementScratch, 'home')]) fs.chownSync(dir, 10001, 10001); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
  const environment = await preflight({ image, sourceDir: candidateDir, scratchDir: measurementScratch,
    controllerScratch: scratchDir, io, requires: imagePin.requires });
  console.log(`sandbox preflight: node ${environment.node} ${environment.platform}/${environment.arch}, ${environment.git}, uid ${environment.uid}:${environment.gid}, env ${environment.env.join(' ')}`);

  // THE NORMAL RUN, TAKEN FROM THE CAPTURE THE CONTROLLER ALREADY MADE. capture-stream.mjs invoked the
  // protected runner command in this same sandbox, in this same job, and took its exit status from waitpid on
  // the container; it is this controller by another name. Re-running 3,667 tests here to observe the same
  // number would double the job's cost and establish nothing new. The counts below are parsed out of that
  // capture for a HUMAN and are labelled as having no authority, exactly like every other byte the candidate
  // printed - the number that matters is `exit`, which the controller observed.
  let normalRun = null;
  if (process.env.NORMAL_RUN_META) {
    const meta = readJson(process.env.NORMAL_RUN_META);
    const capture = fs.readFileSync(path.join(path.dirname(process.env.NORMAL_RUN_META), meta.capture_file), 'utf8');
    const count = name => { const m = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(capture); return m ? Number(m[1]) : null; };
    normalRun = {
      run_id: 'run-0000', label: 'normal-run', observed_by: 'controller',
      observed_in: '.github/verifier-receipt/capture-stream.mjs', exit_source: 'waitpid',
      argv: meta.measurement_sandbox?.argv ?? null,
      exit: Number(meta.suite_exit), signal: meta.suite_signal ?? null, sandbox_fault: null,
      runner_key: meta.runner_key, runner_command: meta.runner_command,
      diagnostic_stream: { sha256: meta.capture_body_sha256, bytes: meta.capture_body_bytes, truncated: false,
        authority: 'none: candidate output, kept for a human', capture_sha256: meta.capture_sha256 },
      diagnostic_counts: { authority: 'none: parsed from candidate output for a human to read',
        tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') },
    };
    if (!Number.isInteger(normalRun.exit)) throw new Error(`the capture's meta records suite_exit ${JSON.stringify(meta.suite_exit)}, which is not a status a process exited with`);
  }
  const observation = await measure({ matrix, scope, runners, runnerKey, candidateDir, scratchDir, image, claim, io, normalRun });
  observation.sandbox_preflight = environment;
  observation.candidate_sha = process.env.CANDIDATE_SHA ?? null;
  observation.claim = { path: matrix.scopes[scope].claim_path, entries: (claim.entries ?? []).length,
    sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(claimPath)).digest('hex') };
  fs.writeFileSync(outPath, JSON.stringify(observation, null, 2) + '\n');

  const established = observation.established.length;
  console.log(`controller-observed: ${observation.terms.length} term(s), ${established} established, `
    + `${observation.matrix_fidelity.refusals.length} matrix refusal(s), normal run exit ${observation.normal_run.exit}`);
  for (const refusal of observation.matrix_fidelity.refusals.slice(0, 40)) console.log(`::warning::matrix fidelity: ${refusal.detail}`);
  fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
