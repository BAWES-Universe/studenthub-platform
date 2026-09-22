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
//   * the artifact must carry the measure job's own capture-meta, and that meta must agree with the candidate
//     commit, the candidate tree the API reports for it, the trusted authority commit, and the runner key and
//     command taken from the protected enum - not from the candidate;
//   * the claim is fetched from the candidate commit through the contents API, never from an artifact and never
//     from a path anyone supplied.
//
// Nothing here is a path, a field, a command or an artifact the candidate chose. The candidate contributes the
// code under test and the claim it commits, and nothing else reaches this process.
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
const AUTHORITY_RE = /^\.github\/(?:workflows\/verifier-receipt\.yml$|verifier-receipt\/)/;
const CLAIM_PATH = '.github/coordinator/service/claim-manifest.json';
const CAPTURE_FILE = 'suite.out';
const META_FILE = 'capture-meta.json';
// A claim is normally committed on top of the code revision it names - the manifest cannot name the commit that
// contains it, because that commit's sha depends on the manifest's bytes. So the claim may sit one step ahead of
// the revision it describes, provided GitHub's own comparison says the step changed nothing but bookkeeping.
const CLAIM_ONLY = [
  '.github/coordinator/service/claim-manifest.json',
  '.github/coordinator/service/verifier-receipts.json',
];
const CLAIM_ONLY_PREFIX = '.github/coordinator/service/receipts/';

const refuse = (field, message) => {
  console.error(`REFUSING: ${field}: ${message}`);
  process.exit(3);
};
const fail = message => refuse('capture.structure', message);
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
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
const runnerKey = need('RUNNER_KEY');
const runnerSpecPath = need('RUNNER_SPEC_PATH');
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
const suiteExit = String(meta.suite_exit ?? '');
if (!/^\d+$/.test(suiteExit)) refuse('capture.suite_exit', `the capture records no numeric suite exit code: ${meta.suite_exit}`);

// 7. The candidate commit, read back from the API. The tree is GitHub's answer for that sha, so the receipt's
//    tree is not a number the measure job could have mistyped.
const candidateCommit = apiJson(`/repos/${repo}/commits/${candidateSha}`);
if (!candidateCommit) refuse('candidate.sha', `the API reports no commit ${candidateSha} in ${repo}`);
const candidateTree = candidateCommit.commit?.tree?.sha ?? null;
if (!candidateTree) refuse('candidate.tree', `the API reports no tree for commit ${candidateSha}`);
if (env.CANDIDATE_TREE && env.CANDIDATE_TREE !== candidateTree) {
  refuse('candidate.tree', `the measure job checked out tree ${env.CANDIDATE_TREE}, but the API reports `
    + `${candidateTree} for ${candidateSha}`);
}
if (meta.candidate_tree && meta.candidate_tree !== candidateTree) {
  refuse('capture.candidate_tree', `the capture records tree ${meta.candidate_tree}, but the API reports `
    + `${candidateTree} for ${candidateSha}`);
}

// 8. A candidate that alters the receipt authority cannot be approved by a receipt this authority produces. The
//    file list comes from GitHub's own comparison, which the candidate cannot influence.
const authorityCompare = apiJson(`/repos/${repo}/compare/main...${candidateSha}`);
if (!authorityCompare) refuse('candidate.authority', `the API could not compare main...${candidateSha}`);
const touched = (authorityCompare.files ?? []).map(file => file.filename).filter(name => AUTHORITY_RE.test(name));
if (touched.length > 0) {
  refuse('candidate.authority', `this candidate modifies the receipt authority (${touched.join(', ')}), so no `
    + 'receipt this authority produces may approve it');
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

const claimedHead = manifest.code_revision?.head ?? null;
let claimDelta = [];
if (claimedHead !== candidateSha) {
  const step = apiJson(`/repos/${repo}/compare/${claimedHead}...${candidateSha}`);
  if (!step) {
    refuse('claim.code_revision.head', `the claim names ${String(claimedHead).slice(0, 12)} as its code revision, `
      + `and GitHub cannot compare that to the measured commit ${candidateSha.slice(0, 12)}`);
  }
  if (step.status !== 'ahead') {
    refuse('claim.code_revision.head', `the claim names ${String(claimedHead).slice(0, 12)} as its code revision, `
      + `but the measured commit ${candidateSha.slice(0, 12)} is ${step.status} of it, not a descendant`);
  }
  claimDelta = (step.files ?? []).map(file => file.filename);
  const beyond = claimDelta.filter(name => !CLAIM_ONLY.includes(name) && !name.startsWith(CLAIM_ONLY_PREFIX));
  if (beyond.length > 0) {
    refuse('claim.code_revision.head', `the claim names ${String(claimedHead).slice(0, 12)} as its code revision, `
      + `but the measured commit ${candidateSha.slice(0, 12)} changes code beyond the claim's own bookkeeping `
      + `(${beyond.join(', ')}), so the suite that ran is not the suite the claim describes`);
  }
}
const claimedCommit = claimedHead === candidateSha ? candidateCommit : apiJson(`/repos/${repo}/commits/${claimedHead}`);
if (!claimedCommit) refuse('claim.code_revision.head', `the API reports no commit ${claimedHead} in ${repo}`);
if (manifest.code_revision?.tree !== claimedCommit.commit?.tree?.sha) {
  refuse('claim.code_revision.tree', `the claim names tree ${manifest.code_revision?.tree} for its code revision, `
    + `but the API reports ${claimedCommit.commit?.tree?.sha} for ${String(claimedHead).slice(0, 12)}`);
}

// What the claim says must exist. A control is a test the claim names; a mutant is a test that must die when its
// term is removed. Both are read from the candidate's claim - as data, never as code.
const named = new Map();
for (const entry of manifest.entries ?? []) {
  for (const test of entry.control?.test_names ?? []) {
    named.set(test, { term: entry.id, kind: 'control', name: test });
  }
  for (const mutant of entry.killing_mutants ?? []) {
    if (mutant.test_name) named.set(mutant.test_name, { term: entry.id, kind: 'mutant', name: mutant.test_name });
  }
}
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
const tap = captureBytes.toString('utf8');
const SUMMARY_FIELD = { tests: 'tests', suites: 'suites', pass: 'ok', fail: 'not_ok', cancelled: 'cancelled', skipped: 'skipped', todo: 'todo' };
const counts = { tests: null, suites: null, ok: null, not_ok: null, cancelled: null, skipped: null, todo: null };
const observed = new Map();
const problems = [];
const pointsAtIndent = new Map();  // nesting indent -> points reported at it since that level's last plan
const plans = [];                  // every plan line, with what was reported under it
const typed = { test: 0, suite: 0 };
let headers = 0;
let footers = 0;
let yamlIndent = null;             // indent of the `---` of the YAML block currently open, or null
let open = null;                   // the point whose YAML block is expected next, until its type is read
let lineNo = 0;

const close = () => {
  if (open && !open.type) problems.push(`point "${open.name}" carries no \`type:\` diagnostic, which the runner writes on every point`);
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
    } else if (open && !open.type && indent === yamlIndent) {
      const type = /^type: '(test|suite)'$/.exec(body);
      if (type) {
        open.type = type[1];
        typed[type[1]] += 1;
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
    open = { indent, name: point[3], type: null };
    observed.set(point[3], point[1] === 'ok' ? 'pass' : 'fail');
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

const perTest = [...named.values()].map(test => ({ ...test, status: observed.get(test.name) ?? 'absent' }));
const summary = {
  named: perTest.length,
  pass: perTest.filter(test => test.status === 'pass').length,
  fail: perTest.filter(test => test.status === 'fail').length,
  absent: perTest.filter(test => test.status === 'absent').length,
};

// Success means: the claim names tests, every one of them was observed in this run's capture, and every one
// passed. The suite's own exit code and counts travel with the receipt so an unrelated failure is visible
// rather than smoothed over.
const established = summary.named > 0 && summary.fail === 0 && summary.absent === 0;
const reasons = [];
if (summary.named === 0) reasons.push('the claim names no tests, so this run establishes nothing about any term');
if (summary.fail > 0) reasons.push(`${summary.fail} named test(s) failed in the measured run`);
if (summary.absent > 0) reasons.push(`${summary.absent} named test(s) did not appear in the measured run`);

// Admissibility is separate from the verdict, and deliberately so. A receipt produced by a run that is not a
// dispatch of this workflow on the protected default branch is a rehearsal: every provenance check above still
// had to pass, but the authority the run executed was not necessarily the authority main holds. Such a receipt
// may never be pinned, and `verify-claim.yml` refuses it independently - this field explains why, it does not
// grant anything.
const trustedOnMain = (() => {
  const compare = apiJson(`/repos/${repo}/compare/${trustedSha}...main`);
  return compare ? ['identical', 'ahead'].includes(compare.status) : false;
})();
const inadmissible = [];
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
  candidate: { sha: candidateSha, tree: candidateTree, touches_authority: false },
  // Everything a third party needs to re-fetch and re-check this receipt through the API, without trusting any
  // part of it. Each field below is something GitHub reports, not something a job asserted.
  provenance: {
    statement: 'the capture this receipt reads was produced by the trusted measure job of this run, which chose '
      + 'and invoked the runner; the candidate contributed only the code under test and the claim it commits',
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
      suite_exit: suiteExit,
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
  // Kept for the pin format `verify-claim.yml` already reads.
  manifest: {
    path: CLAIM_PATH,
    sha256: sha256(claimBytes),
    blob_sha: claimResponse.sha ?? null,
    code_revision: { head: claimedHead, tree: manifest.code_revision?.tree ?? null },
  },
  suite: {
    tests: counts.tests, suites: counts.suites, ok: counts.ok, not_ok: counts.not_ok,
    cancelled: counts.cancelled, skipped: counts.skipped, todo: counts.todo, exit: suiteExit,
  },
  structure_check: {
    kind: 'well-formedness',
    passed: true,
    note: 'the capture parses as one runner\'s TAP and its counts reconcile. This says the capture is WELL '
      + 'FORMED. It does not say it is GENUINE - that is what the provenance block above establishes, and '
      + 'nothing in this check would notice a candidate suite printing a well-formed stream of its own.',
  },
  named_tests: perTest,
  named_tests_summary: summary,
  conclusion: {
    verdict: established ? 'success' : 'failure',
    scope: 'the named tests of the claim this measured, as observed in this run\'s own capture',
    reasons,
  },
};

fs.rmSync(work, { recursive: true, force: true });
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`receipt for ${candidateSha.slice(0, 12)} tree ${candidateTree.slice(0, 8)}: verdict `
  + `${receipt.conclusion.verdict}; named ${summary.named} pass ${summary.pass} fail ${summary.fail} `
  + `absent ${summary.absent}; suite exit ${suiteExit}, tests ${counts.tests}`);
console.log(`provenance: run ${runId} attempt ${runAttempt}, measure job ${measureJob.id} ${measureJob.conclusion}, `
  + `artifact ${artifact.name}#${artifact.id} ${artifact.digest}, capture sha256:${captureDigest}, `
  + `runner "${runnerKey}"; admissible as pin: ${receipt.provenance.admissible_as_pin}`
  + (inadmissible.length > 0 ? ` (${inadmissible.join('; ')})` : ''));
process.exit(0);
