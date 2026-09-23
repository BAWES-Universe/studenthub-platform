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
  // AND IT PROBES WHAT THE MEASUREMENT CAN REACH, not only what it is. Writes are attempted from inside the
  // container and their errno recorded: the read-only source mount, the controller's scratch by its HOST
  // path, a receipt-shaped path, a $GITHUB_OUTPUT-shaped path, and the measurement's own scratch. The first
  // four must fail and the last must succeed - a run in which the source is writable, or the controller's own
  // directory is reachable, is a run whose capture and receipt the measured code could rewrite, and this
  // refuses it before a single term is measured rather than discovering it in a review.
  //
  // EVERY DENIED PROBE NAMES A FILE INSIDE THE DIRECTORY, NEVER THE DIRECTORY. This is not a style point. A
  // write aimed at a directory fails with EISDIR before the filesystem's permissions are consulted at all, so
  // it "fails" identically on a mount that is read-only and on one that is wide open - it proves nothing. An
  // earlier hand-rolled probe made exactly that mistake and two of its rows were worthless. `.probe-write`
  // inside the directory is a real create, and its errno is the boundary's answer.
  //
  // AND SINCE /tmp IS NOW A TMPFS THIS SANDBOX GRANTS, THE PREFLIGHT PROVES WHAT THAT GRANT COST. Four things,
  // in the same container, with the same flags, every run:
  //
  //   (a) AN ORDINARY /tmp WRITE WORKS. mkdtemp under the literal name, write, read back. This is the new
  //       POSITIVE probe and it is the whole defect: before the tmpfs it failed EROFS, and 27 of 122 test
  //       files died on it without declaring a plan.
  //   (b) THE FOUR DENIALS ABOVE STILL HOLD. A writable /tmp is only safe if it did not become a route to
  //       anything else, so the same run that proves (a) re-proves each refusal BY NAME.
  //   (c) FILLING /tmp REACHES THE CONFIGURED BOUND. A tmpfs is memory; an unbounded one is a candidate's
  //       test body exhausting the runner. The probe writes until the filesystem refuses and records the
  //       byte count at refusal beside the bound statfs reports - then REMOVES the fill file, so nothing
  //       measured afterwards is measured on a full filesystem.
  //   (d) noexec IS STILL ENFORCED. A script and a COPIED BINARY are both executed from /tmp and both must be
  //       refused by the kernel. A script alone would not do: it could fail on its interpreter rather than on
  //       the mount, and the binary is the case an attacker would actually use.
  //
  // All of it lands in `sandbox_preflight` in the controller's observation, and any of it going the wrong way
  // refuses the run.
  const probe = ['/usr/local/bin/node', '-e', [
    'const {execFileSync}=require("node:child_process");const fs=require("node:fs");const path=require("node:path");',
    'const out={node:process.versions.node,arch:process.arch,platform:process.platform,uid:process.getuid(),gid:process.getgid(),env:Object.keys(process.env).sort(),cwd:process.cwd(),writes:{},exists:{},tmpfs:{}};',
    'try{out.git=execFileSync("git",["--version"],{encoding:"utf8"}).trim();}catch(e){out.git=null;out.git_error=e.code||String(e);}',
    // (b) the denials, each aimed at a FILE inside the directory.
    'for(const [what,target] of Object.entries(JSON.parse(process.env.PROBE_PATHS||"{}"))){',
    'out.exists[what]=fs.existsSync(target);',
    'try{fs.writeFileSync(target,"probe");out.writes[what]="WROTE";}catch(e){out.writes[what]=e.code||String(e);}}',
    // (a) the ordinary /tmp write, by the literal name the defective call sites use.
    'try{const d=fs.mkdtempSync("/tmp/preflight-");const f=path.join(d,"ordinary");fs.writeFileSync(f,"ordinary");',
    'out.tmpfs.ordinary_write=fs.readFileSync(f,"utf8")==="ordinary"?"WROTE_AND_READ_BACK":"READ_BACK_DIFFERENT_BYTES";',
    'out.tmpfs.ordinary_write_dir=d;fs.rmSync(d,{recursive:true,force:true});}',
    'catch(e){out.tmpfs.ordinary_write=e.code||String(e);}',
    // (d) noexec, on a script and on a copied binary. Done BEFORE the fill, so neither is competing for space.
    'try{fs.writeFileSync("/tmp/noexec-probe.sh","#!/bin/sh\\necho ran\\n",{mode:0o755});',
    'try{execFileSync("/tmp/noexec-probe.sh",[],{encoding:"utf8"});out.tmpfs.exec_script="RAN";}',
    'catch(e){out.tmpfs.exec_script=(e.code||"no-errno")+": "+String(e.message||"").split("\\n")[0];}}',
    'catch(e){out.tmpfs.exec_script_setup=e.code||String(e);}',
    'try{fs.copyFileSync("/bin/echo","/tmp/noexec-probe-binary");fs.chmodSync("/tmp/noexec-probe-binary",0o755);',
    'try{execFileSync("/tmp/noexec-probe-binary",["ran"],{encoding:"utf8"});out.tmpfs.exec_binary="RAN";}',
    'catch(e){out.tmpfs.exec_binary=(e.code||"no-errno")+": "+String(e.message||"").split("\\n")[0];}}',
    'catch(e){out.tmpfs.exec_binary_setup=e.code||String(e);}',
    // (c) the size bound, reached rather than grown through, and then handed back.
    'try{const before=fs.statfsSync("/tmp");out.tmpfs.bound_bytes=before.blocks*before.bsize;',
    'const fd=fs.openSync("/tmp/fill.bin","w");const block=Buffer.alloc(1048576);let written=0;',
    'try{for(;;){fs.writeSync(fd,block);written+=block.length;}}catch(e){out.tmpfs.fill_errno=e.code||String(e);}',
    'finally{fs.closeSync(fd);}',
    'out.tmpfs.fill_bytes_at_refusal=written;',
    'const full=fs.statfsSync("/tmp");out.tmpfs.free_bytes_when_full=full.bavail*full.bsize;',
    'fs.rmSync("/tmp/fill.bin",{force:true});out.tmpfs.fill_file_removed=!fs.existsSync("/tmp/fill.bin");',
    'const after=fs.statfsSync("/tmp");out.tmpfs.free_bytes_after_removal=after.bavail*after.bsize;}',
    'catch(e){out.tmpfs.fill_error=e.code||String(e);}',
    'for(const f of ["/tmp/noexec-probe.sh","/tmp/noexec-probe-binary"])fs.rmSync(f,{force:true});',
    'process.stdout.write("PREFLIGHT "+JSON.stringify(out));',
  ].join('')];
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

  // THE FOUR TMPFS PROOFS, READ BACK. Each one refuses the run rather than being noted, because each one is a
  // property a receipt produced by this run would otherwise be silently resting on.
  const tmpfs = report.tmpfs ?? {};
  // (a) the grant works. If this fails the tmpfs is absent or unusable, and the capture that follows will
  // carry one dead file per literal /tmp call site - which is the defect this flag exists to fix.
  if (tmpfs.ordinary_write !== 'WROTE_AND_READ_BACK')
    wrong.push(`an ordinary write under /tmp reports ${JSON.stringify(tmpfs.ordinary_write)} rather than writing and reading back, so every call site that names /tmp literally will die before its file declares a plan`);
  // (c) the grant is bounded, and the bound is the kernel's. ENOSPC is the only refusal that means "this
  // filesystem is the size it was configured to be"; anything else, including no refusal at all, is a tmpfs
  // whose ceiling nothing here has established.
  if (tmpfs.fill_errno !== 'ENOSPC')
    wrong.push(`filling /tmp stopped with ${JSON.stringify(tmpfs.fill_errno ?? tmpfs.fill_error ?? 'no refusal at all')} after ${tmpfs.fill_bytes_at_refusal} bytes rather than ENOSPC, so the size= bound is not the one holding it`);
  else if (!(tmpfs.fill_bytes_at_refusal > 0) || tmpfs.fill_bytes_at_refusal > tmpfs.bound_bytes)
    wrong.push(`filling /tmp wrote ${tmpfs.fill_bytes_at_refusal} bytes against a bound statfs reports as ${tmpfs.bound_bytes}, which is not a bound being reached`);
  if (tmpfs.fill_file_removed !== true)
    wrong.push('the preflight could not remove its own fill file, so every measurement after it would run against a full /tmp');
  // (d) noexec stands. `RAN` here is the escape a writable directory would otherwise reopen, and it is the
  // one outcome that must stop the run outright.
  for (const [what, observedValue] of [['a script', tmpfs.exec_script], ['a copied binary', tmpfs.exec_binary]]) {
    if (observedValue === 'RAN') wrong.push(`${what} executed from /tmp, so the tmpfs is not noexec and a candidate can run code it dropped there`);
    else if (observedValue === undefined) wrong.push(`the preflight never established whether ${what} can be executed from /tmp (${JSON.stringify(tmpfs)})`);
  }
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
  const scratchDir = fs.mkdtempSync(path.join(scratchRoot, 'overlays-'));
  fs.chmodSync(scratchDir, 0o700);

  const claimPath = path.join(candidateDir, matrix.scopes[scope]?.claim_path ?? '');
  let claim;
  try { claim = readJson(claimPath); }
  catch (error) {
    console.error(`::error::this candidate carries no claim at ${matrix.scopes[scope]?.claim_path} (${error.code ?? error.message}), so there is nothing for the protected matrix to be measured against`);
    process.exit(1);
  }

  const io = { exec: dockerExec(docker) };
  // Prepared and chowned to 10001 by the workflow, because chowning to another uid needs root. See the note
  // in controller.mjs: an earlier form created this here and swallowed its own EPERM, and every measurement
  // then failed its preflight with EACCES on its own TMPDIR.
  const measurementScratch = need('MEASUREMENT_SCRATCH');
  for (const dir of ['tmp', 'home']) {
    if (!fs.existsSync(path.join(measurementScratch, dir))) {
      console.error(`::error::the measurement scratch ${measurementScratch} has no ${dir}/ - the job has to create it and chown it to 10001 before this runs`);
      process.exit(2);
    }
  }
  const environment = await preflight({ image, sourceDir: candidateDir, scratchDir: measurementScratch,
    controllerScratch: scratchDir, io, requires: imagePin.requires });
  console.log(`sandbox preflight: node ${environment.node} ${environment.platform}/${environment.arch}, ${environment.git}, uid ${environment.uid}:${environment.gid}, env ${environment.env.join(' ')}`);
  // THE FOUR TMPFS PROOFS IN THE LOG, not only in the artifact. The preflight already refused the run if any
  // of them went the wrong way, so these lines are the record of a boundary that held - and a reader who has
  // only the job log is the reader who most needs to see it.
  const mib = bytes => (Number.isFinite(bytes) ? `${(bytes / 1048576).toFixed(1)} MiB` : String(bytes));
  const proofs = environment.tmpfs ?? {};
  console.log(`sandbox /tmp (a) an ordinary write: ${proofs.ordinary_write} in ${proofs.ordinary_write_dir}`);
  console.log('sandbox /tmp (b) still refused by name: '
    + ['read_only_source_mount', 'controller_scratch_by_host_path', 'receipt_path_by_host_path',
      'ci_workspace_path', 'github_output_path'].map(what => `${what}=${environment.writes?.[what]}`).join(' '));
  console.log(`sandbox /tmp (c) the size bound: filled ${mib(proofs.fill_bytes_at_refusal)} of a `
    + `${mib(proofs.bound_bytes)} bound, refused ${proofs.fill_errno}, ${mib(proofs.free_bytes_when_full)} free when full; `
    + `fill file removed ${proofs.fill_file_removed}, ${mib(proofs.free_bytes_after_removal)} free again`);
  console.log(`sandbox /tmp (d) noexec: a script -> ${proofs.exec_script}; a copied binary -> ${proofs.exec_binary}`);

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
  const observation = await measure({ matrix, scope, runners, runnerKey, candidateDir, scratchDir, image, claim,
    io, normalRun, measurementScratch });
  observation.sandbox_preflight = environment;
  observation.candidate_sha = process.env.CANDIDATE_SHA ?? null;
  observation.claim = { path: matrix.scopes[scope].claim_path, entries: (claim.entries ?? []).length,
    sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(claimPath)).digest('hex') };
  fs.writeFileSync(outPath, JSON.stringify(observation, null, 2) + '\n');

  const established = observation.established.length;
  console.log(`controller-observed: ${observation.terms.length} term(s), ${established} established, `
    + `${observation.matrix_fidelity.refusals.length} matrix refusal(s), normal run exit ${observation.normal_run.exit}`);
  for (const refusal of observation.matrix_fidelity.refusals.slice(0, 40)) console.log(`::warning::matrix fidelity: ${refusal.detail}`);
  // WHY EACH TERM WAS REFUSED, IN THE LOG, GROUPED. A run that establishes nothing is a legitimate answer,
  // and the first question anyone asks of it is "why" - which was previously answerable only by downloading
  // the artifact. The first reason per term is the one that decided it.
  const grouped = new Map();
  for (const term of observation.terms.filter(term => !term.established)) {
    const why = term.why_not[0] ?? 'no reason recorded';
    grouped.set(why, [...(grouped.get(why) ?? []), term.id]);
  }
  for (const [why, ids] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`refused (${ids.length}): ${why}`);
    console.log(`  ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? `, and ${ids.length - 6} more` : ''}`);
  }
  // AND THE NORMAL RUN AS THE CONTROLLER OBSERVED IT, with the candidate's own counts beside it labelled as
  // what they are, so a reader can tell a suite that went red from a suite that could not run.
  console.log(`normal run: controller-observed exit ${observation.normal_run.exit}; the candidate's own output `
    + `reports ${JSON.stringify(observation.normal_run.diagnostic_counts ?? null)} (diagnostic, establishes nothing)`);
  fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });
}
