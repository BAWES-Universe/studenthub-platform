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
//   IT ESTABLISHES: the digest this program prints and records was taken over the bytes the runner's stdout and
//   stderr produced during this job, in the order they arrived, in a process the measured code never entered.
//   A capture whose bytes do not hash to that digest - substituted, truncated, extended or reordered - is
//   refused. A cold review found the earlier wording of this paragraph ("a capture substituted ... after the run
//   is refused", full stop) to be FALSE, and it was: a candidate that detaches a process outliving its own suite
//   rewrites suite.out AND capture-meta.json together after the two writes below, so both sides of that digest
//   comparison become the forger's. The sentence above is the narrow thing that is true; what follows is the
//   part that is not closed.
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
//   NOT CLOSED, AND BLOCKING RATHER THAN RESIDUAL: a candidate that detaches a background process which outlives
//   its own suite - closing the inherited stdout so this program sees EOF - races the writes below and
//   overwrites BOTH files afterwards. A cold review ran exactly that, three times out of three, and reached
//   verdict success for a tree whose every named test had really FAILED. Everything in this step runs as one
//   uid, so nothing this program can do makes that race impossible: only a different uid for the measured suite
//   (a `container:` with a USER it cannot escape, or `sudo -u nobody` with this capture directory owned by the
//   runner user) closes it. That is an infrastructure change, and it is named as the open item in the record of
//   this change rather than described here as though it were done.
//
//   WHAT IS CLOSED HERE, and it is the half the same review said must stop being assertable on its own: the
//   SUITE'S EXIT STATUS. It used to reach the emitter only through capture-meta.json, so a forger that rewrote
//   both files chose it freely, and the emitter's two strongest well-formedness invariants - a non-zero exit
//   must come with a failing point, a zero exit must come with none - compared two numbers the same forger had
//   written. The exit status is now bound to the bytes that justify it, twice:
//
//     * IN THE STREAM. After the runner is gone this program appends ONE trailer line to the capture and hashes
//       it with the rest, so `capture_sha256` covers the exit status, the byte count and the digest of the
//       runner's own output. The exit status can no longer be stated apart from the bytes: a forger must now
//       write a stream, a trailer and a meta that all agree.
//     * OUT OF BAND. The same exit status is published as this job's step output, which the workflow passes to
//       the emit job as `needs.measure.outputs.exit`, and the emitter refuses a capture whose trailer or meta
//       disagrees with it. That channel travels through GitHub rather than through the artifact, so the
//       reviewer's forgery - which rewrote the two files and nothing else - is now a refusal by name at
//       `capture.suite_exit`. A forger that also beats this channel is not refused; the emitter's own tests pin
//       both of those facts, the second as the open residual it is.
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

  // THE RUNNER'S OWN OUTPUT, and its digest, are what the trailer is about - so they are taken BEFORE the
  // trailer is added and recorded under their own names. `body` is everything the runner wrote; `capture` is
  // the body plus this program's one trailer line.
  const bodyBytes = Buffer.concat(chunks);
  const bodyDigest = hash.digest('hex');
  // THE TRAILER: the one line in the capture that the measured code did not write, appended after its last
  // byte and hashed with it. It carries the exit status waitpid returned and the identity of this measurement,
  // so none of those can be asserted beside the bytes instead of inside them. It is a TAP diagnostic - a `#`
  // line at indent 0, matching no plan, point or summary shape - so a reader of the stream reads it as a
  // comment and the emitter's structural checks never see it at all: they are run over the body alone.
  //
  // Every value is written without a space in it, so the line parses as `key=value` pairs whatever a job name
  // or a runner key contains. The emitter requires EXACTLY ONE such line, requires it to be the last line, and
  // requires the body to contain none - so a test body that prints its own copy is a refusal rather than a
  // substitution.
  //
  // AND THE INTERPRETER AND THE IMAGE TRAVEL IN IT. A review put the gap plainly: four actions are pinned to
  // commits and the command comes from a protected enum, and then the measurement is handed to whatever `node`
  // the runner image resolves - an image that carries more than one. Which points carry a `location:`, what
  // `--test-timeout` bounds and the exact TAP shapes this chain reconciles are all facts about a node VERSION,
  // so a capture that does not name its interpreter is a measurement a third party cannot repeat. `node` is
  // this program's own `process.version`: the same `node` on the same PATH is what the runner command below
  // invokes, which is why it is taken from here rather than asserted by the workflow. `image` and
  // `image_version` are what the hosted runner says it is (`ImageOS`/`ImageVersion`), because `runs-on` pins a
  // LABEL and GitHub rebuilds what sits behind it.
  const field = value => encodeURIComponent(String(value));
  const trailer = `# verifier-capture v1 exit=${field(suiteExit)} signal=${field(signal ?? '-')} `
    + `body_bytes=${bodyBytes.length} body_sha256=${bodyDigest} run=${field(runId)} attempt=${field(runAttempt)} `
    + `job=${field(jobName)} candidate=${field(candidateSha)} tree=${field(candidateTree)} `
    + `runner=${field(runnerKey)} node=${field(process.version)} arch=${field(process.arch)} `
    + `image=${field(env.ImageOS ?? '-')} image_version=${field(env.ImageVersion ?? '-')}`;
  // The separator exists only when the runner's last byte is not a newline, so the body is never altered - the
  // emitter reconstructs this region exactly and refuses if the capture is not `body` followed by it.
  const separator = bodyBytes.length > 0 && bodyBytes[bodyBytes.length - 1] === 0x0a ? '' : '\n';
  const captureBytes = Buffer.concat([bodyBytes, Buffer.from(`${separator}${trailer}\n`, 'utf8')]);
  const digest = crypto.createHash('sha256').update(captureBytes).digest('hex');
  try {
    fs.mkdirSync(captureDir);
  } catch (error) {
    refuse('capture.directory', `${captureDir} could not be created after the runner finished (${error.code}), so `
      + 'this job cannot write a capture it vouches for');
  }
  fs.writeFileSync(path.join(captureDir, 'suite.out'), captureBytes);
  const meta = {
    schema: 2,
    job_name: jobName,
    run_id: runId,
    run_attempt: runAttempt,
    workflow_path: '.github/workflows/verifier-receipt.yml',
    trusted_source_sha: trustedSourceSha,
    candidate_sha: candidateSha,
    candidate_tree: candidateTree,
    runner_key: runnerKey,
    runner_command: runnerCommand,
    // THE INTERPRETER THAT DID THE MEASURING, AND THE IMAGE IT RAN ON. Repeated from the trailer, where they
    // are inside the hashed stream; the emitter requires the two accounts to agree and carries them into
    // `provenance.runner`, so a receipt names the node that produced it.
    runner_node: process.version,
    runner_arch: process.arch,
    runner_image: env.ImageOS ?? null,
    runner_image_version: env.ImageVersion ?? null,
    capture_file: 'suite.out',
    capture_bytes: captureBytes.length,
    capture_sha256: digest,
    // The runner's own output, apart from the trailer this program appended to it. The emitter checks both
    // halves: that the body hashes to this, and that what follows the body is exactly the trailer below.
    capture_body_bytes: bodyBytes.length,
    capture_body_sha256: bodyDigest,
    capture_trailer: trailer,
    suite_exit: suiteExit,
    suite_signal: signal ?? null,
    // WHERE THE EXIT STATUS CAME FROM, and where else it can be read. `waitpid` is the only source this program
    // uses; `capture_trailer` above repeats it inside the hashed bytes, and the step output below repeats it
    // through GitHub. The emitter requires all three to agree, so the field cannot be asserted on its own.
    suite_exit_source: 'waitpid',
    // WHERE THE DIGEST CAME FROM, as a fact the emitter checks rather than a claim a reader has to believe.
    // `stream` means: hashed in this process as the bytes arrived, before any of them were on disk. The
    // emitter refuses any other value by name, so a workflow that drifted back to hashing a file in a later
    // step would be refused rather than silently trusted.
    capture_hash_source: 'stream',
    capture_hashed_by: '.github/verifier-receipt/capture-stream.mjs',
  };
  fs.writeFileSync(path.join(captureDir, 'capture-meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  // THE SECOND CHANNEL, and it is read now rather than declared and dropped. These outputs are written from
  // here, after the measured code has exited; the workflow publishes them as the measure job's outputs and
  // passes them to the emit job, which refuses a capture whose trailer or meta disagrees with them. Before this
  // change the `exit` output existed and had no consumer anywhere in the repository, so the one fact the
  // emitter held from outside the stream travelled to it inside the file a forger rewrites.
  //
  // WHAT THIS CHANNEL IS WORTH, exactly: it travels through GitHub rather than through the artifact, so a
  // forgery that rewrites suite.out and capture-meta.json is refused by name. It is NOT out of the measured
  // code's reach - a same-uid process can read this file's path out of /proc/<pid>/environ and append its own
  // line, and a later line for the same key wins. It raises the cost of the open race; it does not close it.
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT,
      `exit=${suiteExit}\ncapture_sha256=${digest}\nbody_sha256=${bodyDigest}\ncapture_bytes=${captureBytes.length}\n`);
  }
  console.log(`captured ${bodyBytes.length} bytes as they passed through, sha256:${bodyDigest}; suite exit `
    + `${suiteExit}${signal ? ` (killed by ${signal})` : ''}`);
  console.log(`with this job's trailer, the capture is ${captureBytes.length} bytes, sha256:${digest}`);
  console.log(trailer);
  process.exit(0);
});
