// Capture one measurement, hashing the stream AS IT PASSES THROUGH this process.
//
// WHY THIS FILE EXISTS. The measure job used to redirect the runner's output into a file and hash that file in
// the NEXT step. A review defeated it: the candidate's own test bodies run inside the capture step, as the same
// user, with RUNNER_TEMP in their environment, so a test could write a forged TAP stream beside the capture and
// rename(2) it over the top. rename detaches the reporter's still-open fd onto the now-unlinked inode, so the
// forged bytes were whole, the trusted step then hashed THEM, and every provenance check downstream - the
// artifact digest, the meta, the attestation - was computed over bytes the candidate had authored. Twenty-seven
// checks authenticated WHICH JOB uploaded the artifact and none authenticated WHO WROTE THE BYTES INSIDE IT.
//
// So the bytes are never left on disk for a later step to hash. This process:
//
//   * spawns the runner itself, with the command the PROTECTED enum names, in the candidate's checkout;
//   * hashes every byte of the runner's output incrementally as it arrives here, in this process's memory,
//     where no candidate process can reach it;
//   * learns the runner's exit status from waitpid, not from a file or a step output the measured code can
//     write (the candidate can append to $GITHUB_OUTPUT of the step it runs in - another finding of the same
//     review - so `suite_exit` no longer comes from there);
//   * creates the capture directory and writes both `suite.out` and `capture-meta.json` only AFTER the stream
//     has closed, which is after the runner and its children are gone. The capture does not exist as a file
//     while the measured code is running, so there is nothing for it to rename over.
//
// The emitter then re-hashes the bytes it fetched from the artifact and refuses unless they hash to the digest
// recorded here. That check existed before and could not fire, because both sides read the same replaceable
// file; now one side is a streaming hash taken in a process the candidate never entered, so a replacement of
// `suite.out` at any point after this program writes it is a refusal by name at `capture.sha256`.
//
// WHAT THIS ESTABLISHES, EXACTLY, AND WHAT IT DOES NOT.
//
//   IT ESTABLISHES: the bytes in the artifact are the bytes the runner's stdout and stderr produced during this
//   job, in the order they arrived, as recorded by a trusted process. A capture substituted, truncated,
//   extended or reordered after the run is refused.
//
//   IT DOES NOT ESTABLISH that those bytes are truthful. THE MEASURED TESTS SHARE THIS OUTPUT STREAM - that is
//   what the stream IS: the candidate's own test files print into it, which is the whole point of running them.
//   A candidate whose test bodies print their own well-formed TAP points, or which print a plausible summary
//   block, put those bytes into the stream this program hashes, and they are hashed exactly as faithfully as
//   the reporter's own. Streaming the hash removes the candidate's ability to replace the measurement AFTER it
//   was taken; it does not and cannot give this workflow the ability to tell a reporter's line from a line a
//   test printed on the same fd. That boundary is stated in the receipt, in the emitter's header, and in the
//   record of this change, and it is not closed by anything here.
//
//   ALSO NOT CLOSED: a candidate that detaches a background process which outlives its own suite - closing the
//   inherited stdout so this program sees EOF - can still race the writes below and overwrite BOTH files
//   afterwards. It must then forge a meta whose every field agrees with the API, which the emitter checks one
//   at a time; but nothing here makes that race impossible, because everything in this step runs as one uid.
//   Only a different uid, or a container the suite cannot reach out of, would close it.
//
// No dependency: node stdlib only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const env = process.env;
// Fails closed and names the thing that was missing, like every other refusal in this authority.
const refuse = (field, message) => {
  console.error(`REFUSING: ${field}: ${message}`);
  process.exit(1);
};
const need = name => {
  const value = env[name];
  if (value === undefined || value === '') {
    refuse(`env.${name}`, 'the trusted job must supply this; the capture defaults nothing that identifies the measurement');
  }
  return value;
};

// A capture larger than this is not a measurement this chain can carry: the emitter fetches the artifact
// through the API into memory, and the archive it reads is bounded too. Refused rather than truncated, because
// a truncated capture read as a measurement is exactly what the well-formedness check exists to catch.
const CAPTURE_BYTES_MAX = 128 * 1024 * 1024;

const captureDir = need('CAPTURE_DIR');
const candidateDir = need('CANDIDATE_DIR');
const runnerCommand = need('RUNNER_COMMAND');
const runnerKey = need('RUNNER_KEY');
const candidateSha = need('CANDIDATE_SHA');
const candidateTree = need('CANDIDATE_TREE');
const trustedSourceSha = need('TRUSTED_SOURCE_SHA');
const jobName = need('JOB_NAME');
const runId = need('GITHUB_RUN_ID');
const runAttempt = need('GITHUB_RUN_ATTEMPT');

if (!fs.existsSync(candidateDir)) {
  refuse('capture.candidate_dir', `the candidate checkout ${candidateDir} is not there, so there is nothing to measure`);
}
// The directory is created after the stream closes, so its existence NOW means something else made it - a
// previous step, or the candidate racing ahead of its own measurement. Either way this is not a capture this
// job can vouch for, and the honest answer is to refuse rather than to write into a directory someone else
// prepared. A candidate that pre-creates it turns its own measurement red; it cannot make one pass.
if (fs.existsSync(captureDir)) {
  refuse('capture.directory', `${captureDir} already exists before the runner has been invoked, so this job `
    + 'cannot vouch for what is in it');
}

const hash = crypto.createHash('sha256');
const chunks = [];
let bytes = 0;
let overflowed = false;
// Both of the child's streams are absorbed here, in arrival order. The child is wrapped so that its stderr is
// already redirected onto its stdout - one stream, exactly as `> file 2>&1` produced before - and this handler
// is what catches anything bash itself writes to fd 2 before that redirect applies, so no byte of the child's
// output escapes the hash.
const absorb = chunk => {
  if (overflowed) return;
  bytes += chunk.length;
  if (bytes > CAPTURE_BYTES_MAX) {
    overflowed = true;
    return;
  }
  hash.update(chunk);
  chunks.push(chunk);
};

// THE RUNNER IS SPAWNED BY THIS PROCESS, not by a shell whose exit status has to be reported through a file.
// The command text is the protected enum's, passed as one argument to bash exactly as the workflow used to
// pass it, and wrapped in a group whose stderr is redirected onto its stdout so the capture is the same
// interleaved stream the redirect produced.
const script = `{\n${runnerCommand}\n} 2>&1\n`;
const child = spawn('bash', ['-euo', 'pipefail', '-c', script], {
  cwd: candidateDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', absorb);
child.stderr.on('data', absorb);

child.on('error', error => {
  refuse('capture.runner', `the runner could not be started: ${error.message}`);
});

child.on('close', (code, signal) => {
  if (overflowed) {
    refuse('capture.bytes', `the runner produced more than ${CAPTURE_BYTES_MAX} bytes of output, which is not a `
      + 'capture this chain can carry');
  }
  // A signalled runner did not report an exit code. It is recorded the way a shell reports one, so the field
  // stays numeric and a killed suite is never read as a suite that exited 0.
  const signalNumber = signal ? (os.constants.signals[signal] ?? 0) : null;
  const suiteExit = signal ? String(128 + signalNumber) : String(code ?? 0);

  const captureBytes = Buffer.concat(chunks);
  const digest = hash.digest('hex');
  try {
    fs.mkdirSync(captureDir);
  } catch (error) {
    refuse('capture.directory', `${captureDir} could not be created after the runner finished (${error.code}), so `
      + 'this job cannot write a capture it vouches for');
  }
  fs.writeFileSync(path.join(captureDir, 'suite.out'), captureBytes);
  const meta = {
    schema: 1,
    job_name: jobName,
    run_id: runId,
    run_attempt: runAttempt,
    workflow_path: '.github/workflows/verifier-receipt.yml',
    trusted_source_sha: trustedSourceSha,
    candidate_sha: candidateSha,
    candidate_tree: candidateTree,
    runner_key: runnerKey,
    runner_command: runnerCommand,
    capture_file: 'suite.out',
    capture_bytes: captureBytes.length,
    capture_sha256: digest,
    suite_exit: suiteExit,
    suite_signal: signal ?? null,
    // WHERE THE DIGEST CAME FROM, as a fact the emitter checks rather than a claim a reader has to believe.
    // `stream` means: hashed in this process as the bytes arrived, before any of them were on disk. The
    // emitter refuses any other value by name, so a workflow that drifted back to hashing a file in a later
    // step would be refused rather than silently trusted.
    capture_hash_source: 'stream',
    capture_hashed_by: '.github/verifier-receipt/capture-stream.mjs',
  };
  fs.writeFileSync(path.join(captureDir, 'capture-meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  // The step output is written from here, after the measured code has exited, so it is not read from a file
  // that code could append to while it ran. Nothing the emitter reads comes from this line: the meta above is
  // the binding, and this is for the job's own outputs and its log.
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `exit=${suiteExit}\n`);
  }
  console.log(`captured ${captureBytes.length} bytes as they passed through, sha256:${digest}; suite exit `
    + `${suiteExit}${signal ? ` (killed by ${signal})` : ''}`);
  process.exit(0);
});
