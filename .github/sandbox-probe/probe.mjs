#!/usr/bin/env node
// A DISPOSABLE PROBE OF THE SANDBOX THE RECEIPT AUTHORITY ACTUALLY RUNS.
//
// WHY THIS EXISTS. An independent review of the authority could not execute the container half of its brief:
// this repository's own agent policy denies `Bash(docker:*)`, so every container measurement the review wanted
// to take was refused at the permission layer. The review said so plainly and declined to treat the author's
// recorded output as its own evidence. This is the answer to that: a run on protected main, taken by GitHub
// rather than by any author's shell, that proves the five properties and keeps the raw log and the artifact.
//
// WHAT IT IS NOT. It is verification only. It carries no receipt authority, it takes no candidate and no
// input, it holds `contents: read`, it does not touch the ruleset, and nothing downstream reads its output to
// decide anything. Its only product is evidence a reader can check.
//
// IT DOES NOT RESTATE THE FLAGS. `SANDBOX_FLAGS`, `TMPFS_TMP`, the bound, the invocation and the environment
// all come from `.github/verifier-receipt/sandbox.mjs` AT THE REVISION UNDER TEST - so this probe cannot
// outlive a change to them and keep passing, and a reader can see from the recorded hashes exactly which
// revision of the sandbox these observations are about.
//
// THE FIVE PROPERTIES, and why each is the interesting one:
//   P1  ordinary /tmp writes work, and the kernel's own mount line for /tmp carries rw,noexec,nosuid,nodev
//       and the configured size. Without this the suite dies EROFS before it declares a plan.
//   P2  /src, the controller's scratch, a receipt-shaped path, the CI workspace and a $GITHUB_OUTPUT-shaped
//       path all FAIL BY NAME from inside. This is the property that matters: /tmp must not become a route to
//       anything that decides an outcome.
//   P3  filling /tmp hits the configured bound and nothing else - no host disk, no runner memory beyond the
//       bound - and the bytes freed come back.
//   P4  noexec is enforced for a script AND for a copied binary, so /tmp cannot be used to run code the
//       measurement was not given.
//   P5  the tmpfs is fresh per container: a file written by one container is absent in the next.
//
// Usage (from the workflow; the paths are the runner's own):
//   PROBE_SOURCE=... PROBE_CONTROLLER=... PROBE_SCRATCH=... PROBE_IMAGE_JSON=... PROBE_OUT=... \
//     node .github/sandbox-probe/probe.mjs

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  SANDBOX_FLAGS, TMPFS_TMP, SOURCE_MOUNT, SCRATCH_MOUNT,
  sandboxArgv, measurementEnv, tmpfsBoundBytes, assertNoEscape,
} from '../verifier-receipt/sandbox.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const sourceDir = required('PROBE_SOURCE');
const controllerDir = required('PROBE_CONTROLLER');
const scratchDir = required('PROBE_SCRATCH');
const outPath = process.env.PROBE_OUT || null;
const workspaceDir = process.env.GITHUB_WORKSPACE || path.join(controllerDir, 'ci-workspace-shaped');
const githubOutput = process.env.GITHUB_OUTPUT || path.join(controllerDir, 'github-output-shaped');

function required(name) {
  const value = process.env[name];
  if (!value) { console.error(`probe: ${name} is not set`); process.exit(2); }
  return value;
}

const evidence = {
  probe: 'sandbox-probe',
  ran_at: new Date().toISOString(),
  authority_revision: git('rev-parse', 'HEAD'),
  authority_tree: git('rev-parse', 'HEAD^{tree}'),
  sandbox_mjs_sha256: sha256(path.join(repoRoot, '.github/verifier-receipt/sandbox.mjs')),
  image_json_sha256: sha256(path.join(repoRoot, '.github/verifier-receipt/image.json')),
  sandbox_flags: SANDBOX_FLAGS,
  tmpfs_tmp: TMPFS_TMP,
  tmpfs_bound_bytes: tmpfsBoundBytes(),
  flags_from_this_revision: null, // filled below, by reading the file we just hashed
  proofs: {},
  passed: false,
};

function git(...args) {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return (r.stdout || '').trim() || `<git ${args.join(' ')} failed: ${(r.stderr || '').trim()}>`;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// THE FLAGS THIS PROBE VERIFIED, FROZEN HERE ON PURPOSE.
//
// The authority checks its own flags every run (assertNoEscape, plus the REQUIRED table in sandbox.mjs), and
// that check is about escapes. This one is the opposite direction: the probe records which exact flag set its
// observations are evidence FOR. So a legitimate change to the bound or to an option fails this probe until
// someone re-reads these lines - which is the point, because a probe that follows the flag wherever it goes
// certifies a boundary nobody reviewed.
const EXPECTED_TMPFS = '/tmp:rw,noexec,nosuid,nodev,size=64m';
const EXPECTED_FLAGS = [
  '--rm', '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt',
  'no-new-privileges', '--network', 'none', '--cgroupns', 'private', '--pids-limit', '2048',
  '--tmpfs', EXPECTED_TMPFS,
];
evidence.flags_frozen_expectation = { tmpfs_tmp: EXPECTED_TMPFS, sandbox_flags: EXPECTED_FLAGS };
evidence.flags_from_this_revision =
  TMPFS_TMP === EXPECTED_TMPFS && JSON.stringify(SANDBOX_FLAGS) === JSON.stringify(EXPECTED_FLAGS);

// The in-container reporter's marker. It is one constant because the program that writes it and the host that
// parses it must agree, and a probe whose evidence silently fails to parse is worse than no probe at all.
const MARKER = '@@PROBE@@';

// ---------------------------------------------------------------------------------------------------
// The container runner: the invocation comes from the authority's own builder, so this probe cannot run
// flags the authority would not.
// ---------------------------------------------------------------------------------------------------
function runInSandbox(program, label, { workdir } = {}) {
  const argv = sandboxArgv({
    image: evidence.image_reference,
    sourceDir,
    scratchDir,
    argv: ['node', '-e', program],
    env: measurementEnv(),
    ...(workdir ? { workdir } : {}),
  });
  assertNoEscape(argv); // the authority's own refusal, applied to the argv this probe is about to execute
  const r = spawnSync('docker', argv, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const marker = (r.stdout || '').split('\n').filter(l => l.includes(MARKER)).pop() || null;
  let parsed = null;
  if (marker) {
    try { parsed = JSON.parse(marker.slice(marker.indexOf(MARKER) + MARKER.length)); } catch { parsed = null; }
  }
  return {
    label,
    invocation: ['docker', ...argv.slice(0, argv.indexOf(evidence.image_reference) + 1), '<env>', ...argv.slice(argv.length - 3)],
    exit_status: r.status,
    stderr: (r.stderr || '').trim().split('\n').slice(-4).join(' | '),
    result: parsed,
    raw_stdout_tail: (r.stdout || '').split('\n').slice(-3).join(' | '),
  };
}

// ---------------------------------------------------------------------------------------------------
// The image, pulled by digest: the pull IS the verification.
// ---------------------------------------------------------------------------------------------------
const imageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, '.github/verifier-receipt/image.json'), 'utf8'));
if (!/@sha256:/.test(imageJson.reference)) {
  console.error(`probe: the image is pinned as ${imageJson.reference}, which is not a digest`);
  process.exit(1);
}
evidence.image_reference = imageJson.reference;
evidence.image_tag_label = imageJson.tag;
if (spawnSync('docker', ['pull', '--quiet', imageJson.reference], { stdio: 'inherit' }).status !== 0) {
  console.error('probe: the pinned image could not be pulled by digest');
  process.exit(1);
}
evidence.image_id = (spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageJson.reference],
  { encoding: 'utf8' }).stdout || '').trim();

// ---------------------------------------------------------------------------------------------------
// A JSON reporter that the host reads back. Kept deliberately small: the probe's job is to report what it
// observed, and every assertion lives on the host where a failure is a failure of the run.
// ---------------------------------------------------------------------------------------------------
const REPORT = `
function report(o) { process.stdout.write('\\n${MARKER}' + JSON.stringify(o) + '\\n'); }
function errnoOf(fn) { try { fn(); return null; } catch (e) { return e.code || e.errno || e.message; } }
`;

// P0 - the environment and the mounts, observed from inside.
//
// THE MOUNTS ARE READ, NOT ASSERTED. This program used to carry a literal `source_mount_is_readonly: false`
// beside the measured fields - a claim about the source mount that the probe never took, and one that
// contradicted the probe's own P2 observation that a write to /src fails EROFS. A Sentry review of the merged
// probe caught it, correctly: an evidence file whose fields are typed rather than measured is exactly the
// defect this whole boundary exists to refuse. Every mount option here now comes out of /proc/mounts.
const p0 = runInSandbox(`${REPORT}
const fs = require('node:fs');
const mountLines = fs.readFileSync('/proc/mounts', 'utf8').split('\\n');
const mountAt = target => {
  const line = mountLines.find(l => l.split(' ')[1] === target);
  return { target, line: line || null, options: line ? (line.split(' ')[3] || '').split(',') : null };
};
const st = fs.statfsSync('/tmp');
report({
  uid: process.getuid(), gid: process.getgid(),
  env_names: Object.keys(process.env).sort(),
  cwd: process.cwd(),
  tmp_entries_before: fs.readdirSync('/tmp'),
  tmp_mount: mountAt('/tmp'),
  scratch_mount: mountAt('/scratch'),
  source_mount: mountAt('/src'),
  tmp_total_bytes: st.bsize * st.blocks,
  tmp_free_bytes: st.bsize * st.bavail,
});
`, 'P0 environment and the kernel mount lines');
evidence.proofs.p0_environment = p0;

// P1 - an ordinary /tmp write works.
const p1 = runInSandbox(`${REPORT}
const fs = require('node:fs');
fs.writeFileSync('/tmp/probe.txt', 'probe-payload');
const back = fs.readFileSync('/tmp/probe.txt', 'utf8');
fs.mkdirSync('/tmp/probe-dir', { recursive: true });
fs.writeFileSync('/tmp/probe-dir/nested.txt', 'nested');
report({ wrote: true, read_back: back, nested: fs.readFileSync('/tmp/probe-dir/nested.txt', 'utf8') === 'nested' });
`, 'P1 ordinary /tmp writes');
evidence.proofs.p1_writes_work = p1;

// P2 - the refusals, by name.
const refusalTargets = [
  ['source_mount', `${SOURCE_MOUNT}/.probe-write`, 'EROFS'],
  ['controller_scratch', `${controllerDir}/probe-write`, 'ENOENT'],
  ['receipt_path', `${controllerDir}/receipt/receipt.json`, 'ENOENT'],
  ['ci_workspace', `${workspaceDir}/probe-write`, 'ENOENT'],
  ['github_output', githubOutput, 'ENOENT'],
];
const p2 = runInSandbox(`${REPORT}
const fs = require('node:fs');
const targets = ${JSON.stringify(refusalTargets.map(([name, target]) => ({ name, target })))};
const observed = {};
for (const t of targets) {
  observed[t.name] = { target: t.target, errno: errnoOf(() => fs.appendFileSync(t.target, 'probe-write\\n')) };
}
observed.host_scratch_target_from_inside = errnoOf(() => fs.appendFileSync('${scratchDir}/probe-write', 'x'));
report(observed);
`, 'P2 refusals by name');
evidence.proofs.p2_refusals = p2;

// P3 - the bound, from the kernel read-back and then by filling it.
const bound = tmpfsBoundBytes();
const p3 = runInSandbox(`${REPORT}
const fs = require('node:fs');
const bound = ${bound};
const before = fs.statfsSync('/tmp');
const fd = fs.openSync('/tmp/fill.bin', 'w');
const chunk = Buffer.alloc(1024 * 1024, 0x61);
let written = 0, errno = null;
try {
  for (;;) { fs.writeSync(fd, chunk); written += chunk.length; if (written > 4 * bound) break; }
} catch (e) { errno = e.code || String(e); }
fs.closeSync(fd);
const afterFill = fs.statfsSync('/tmp');
fs.unlinkSync('/tmp/fill.bin');
const afterRemoval = fs.statfsSync('/tmp');
report({
  bound_bytes: bound,
  tmp_total_before: before.bsize * before.blocks,
  fill_errno: errno,
  bytes_at_refusal: written,
  free_at_full: afterFill.bsize * afterFill.bavail,
  fill_file_removed: fs.readdirSync('/tmp').filter(f => f === 'fill.bin').length === 0,
  free_after_removal: afterRemoval.bsize * afterRemoval.bavail,
});
`, 'P3 the bound and the fill');
evidence.proofs.p3_bound = p3;

// P4 - noexec, for a script and for a copied binary.
const p4 = runInSandbox(`${REPORT}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
fs.writeFileSync('/tmp/probe.sh', '#!/bin/sh\\necho ran\\n');
fs.chmodSync('/tmp/probe.sh', 0o755);
fs.copyFileSync('/usr/bin/env', '/tmp/probe-bin');
fs.chmodSync('/tmp/probe-bin', 0o755);
const script = spawnSync('/tmp/probe.sh', { encoding: 'utf8' });
const binary = spawnSync('/tmp/probe-bin', { encoding: 'utf8' });
report({
  script: { status: script.status, error_code: script.error && script.error.code, stderr_tail: (script.stderr||'').split('\\n')[0] },
  copied_binary: { status: binary.status, error_code: binary.error && binary.error.code, stderr_tail: (binary.stderr||'').split('\\n')[0] },
  exec_bits_are_set: (fs.statSync('/tmp/probe.sh').mode & 0o111) !== 0,
});
`, 'P4 noexec');
evidence.proofs.p4_noexec = p4;

// P5 - freshness: a file written in one container must be absent in the next.
const p5a = runInSandbox(`${REPORT}
const fs = require('node:fs');
fs.writeFileSync('/tmp/freshness-marker', 'written-by-the-first-container');
report({ wrote: fs.readFileSync('/tmp/freshness-marker', 'utf8'), tmp_entries: fs.readdirSync('/tmp') });
`, 'P5a freshness - the first container writes');
const p5b = runInSandbox(`${REPORT}
const fs = require('node:fs');
report({ tmp_entries: fs.readdirSync('/tmp'), marker_present: fs.existsSync('/tmp/freshness-marker') });
`, 'P5b freshness - the second container must not see it');
evidence.proofs.p5_freshness = { first: p5a, second: p5b };

// ---------------------------------------------------------------------------------------------------
// THE ASSERTIONS. Every one of these is a refusal, not a warning: the point of a probe is to fail loudly.
// ---------------------------------------------------------------------------------------------------
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(evidence.flags_from_this_revision === true,
  `the flags at this revision are not the flags this probe is evidence for (TMPFS_TMP=${TMPFS_TMP})`);

const r0 = p0.result;
check(!!r0, 'P0 produced no observation');
if (r0) {
  check(r0.uid === 10001, `P0: the measurement ran as uid ${r0.uid}, not 10001`);
  // The options live in the fourth field of the mount line, separated from the fstype by a space, so this
  // reads that field rather than searching the line - a substring test for "rw" would match inside another
  // word and a test anchored on commas would miss the first option, which is exactly the mistake this line
  // used to make. Nothing here is a literal: every option below is the kernel's own answer.
  const tmpOptions = (r0.tmp_mount && r0.tmp_mount.options) || [];
  for (const option of ['rw', 'noexec', 'nosuid', 'nodev']) {
    check(tmpOptions.includes(option),
      `P1: the kernel's /tmp mount options do not carry ${option}: ${r0.tmp_mount && r0.tmp_mount.line}`);
  }
  check(tmpOptions.some(o => o === 'size=65536k' || o === 'size=64m' || o === 'size=67108864'),
    `P3: the kernel's /tmp mount options do not carry the configured size: ${r0.tmp_mount && r0.tmp_mount.line}`);
  // THE SOURCE MOUNT, MEASURED. P2 proves a write to /src fails; this proves the kernel says why it must
  // fail, and that the two agree. The old form of this line was a hardcoded `false` that contradicted P2.
  const srcOptions = (r0.source_mount && r0.source_mount.options) || [];
  check(srcOptions.includes('ro'),
    `P2: the kernel's /src mount options do not carry ro: ${r0.source_mount && r0.source_mount.line}`);
  check(tmpOptions.length > 0, 'P1: /tmp is not a mount of its own');
  check((r0.scratch_mount && r0.scratch_mount.options || []).length > 0,
    'P2: /scratch is not a mount of its own, so the probe cannot say what the measurement may write');
  check(!((r0.scratch_mount && r0.scratch_mount.options) || []).includes('ro'),
    'P1: /scratch is mounted read-only, so the measurement has nowhere to write at all');
  check(r0.tmp_total_bytes === tmpfsBoundBytes(), `P3: the kernel reports ${r0.tmp_total_bytes} bytes of /tmp, the flag asks for ${tmpfsBoundBytes()}`);
  const leaked = r0.env_names.filter(n => /^GITHUB_|^ACTIONS_|^RUNNER_|^CI$|TOKEN|SECRET|PASSWORD/i.test(n));
  check(leaked.length === 0, `P2: the measurement holds environment names it must not: ${leaked.join(', ')}`);
}

const r1 = p1.result;
check(!!r1 && r1.read_back === 'probe-payload', 'P1: an ordinary /tmp write did not read back');
check(!!r1 && r1.nested === true, 'P1: /tmp could not hold a directory');

const r2 = p2.result;
if (!r2) { failures.push('P2 produced no observation'); } else {
  for (const [name, , expected] of refusalTargets) {
    const got = r2[name] && r2[name].errno;
    check(got === expected, `P2: ${name} gave ${got}, expected ${expected}`);
  }
  check(r2.host_scratch_target_from_inside === 'ENOENT',
    `P2: the measurement scratch reached the host path ${scratchDir} (got ${r2.host_scratch_target_from_inside})`);
}

const r3 = p3.result;
if (!r3) { failures.push('P3 produced no observation'); } else {
  check(r3.fill_errno === 'ENOSPC', `P3: filling /tmp gave ${r3.fill_errno}, expected ENOSPC`);
  check(r3.bytes_at_refusal === bound, `P3: the fill stopped at ${r3.bytes_at_refusal}, the bound is ${bound}`);
  check(r3.free_at_full === 0, `P3: ${r3.free_at_full} bytes were still free when the fill refused`);
  check(r3.fill_file_removed === true, 'P3: the fill file was still present after the probe');
  check(r3.free_after_removal === bound, `P3: ${r3.free_after_removal} bytes came back after removal, expected ${bound}`);
}

const r4 = p4.result;
if (!r4) { failures.push('P4 produced no observation'); } else {
  const refused = v => v && (v.error_code === 'EACCES' || v.error_code === 'EPERM' || v.status === 126);
  check(refused(r4.script), `P4: a script in /tmp was not refused (status ${r4.script && r4.script.status}, ${r4.script && r4.script.error_code})`);
  check(refused(r4.copied_binary), `P4: a copied binary in /tmp was not refused (status ${r4.copied_binary && r4.copied_binary.status}, ${r4.copied_binary && r4.copied_binary.error_code})`);
  check(r4.exec_bits_are_set === true, 'P4: the probe could not set the exec bits, so this proves nothing about noexec');
}

const r5 = evidence.proofs.p5_freshness;
const firstTmp = r5.first.result && r5.first.result.tmp_entries;
const secondTmp = r5.second.result && r5.second.result.tmp_entries;
check(!!firstTmp && firstTmp.includes('freshness-marker'), 'P5: the first container did not write the marker');
check(!!secondTmp && !secondTmp.includes('freshness-marker'), `P5: the marker survived into the next container: ${JSON.stringify(secondTmp)}`);
check(!!secondTmp && secondTmp.length === 0, `P5: a fresh /tmp should be empty, saw ${JSON.stringify(secondTmp)}`);

evidence.failures = failures;
evidence.passed = failures.length === 0;

const out = JSON.stringify(evidence, null, 2);
if (outPath) fs.writeFileSync(outPath, out + '\n');
console.log('@@PROBE-EVIDENCE@@');
console.log(out);
console.log('@@PROBE-EVIDENCE-END@@');
console.log(evidence.passed
  ? 'PROBE_RESULT=PASS every property held'
  : `PROBE_RESULT=FAIL\n${failures.map(f => `  - ${f}`).join('\n')}`);
process.exit(evidence.passed ? 0 : 1);
