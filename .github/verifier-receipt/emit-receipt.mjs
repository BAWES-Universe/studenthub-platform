// The verifier's receipt emitter. This file lives on protected main and is checked out from main when the
// receipt workflow runs, so a candidate commit can neither change it nor select another version: the receipt
// that measures a candidate is produced by code the candidate does not contain.
//
// It reads the candidate's own claim manifest to learn WHICH tests the claim names - a claim is the thing
// being measured - then reads the TAP the suite produced in the candidate's tree and reports, per named test,
// whether it passed, failed or never appeared. It reports counts, and it refuses to emit a receipt at all if
// the checkout is not the commit it was asked to measure.
//
// Usage: node emit-receipt.mjs --candidate <sha> --workspace <dir> --tap <file> --out <file>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}
const candidate = args.get('candidate');
const workspace = path.resolve(args.get('workspace') ?? '.');
const tapPath = args.get('tap');
const out = args.get('out');
if (!candidate || !tapPath || !out) {
  console.error('usage: emit-receipt.mjs --candidate <sha> --workspace <dir> --tap <file> --out <file>');
  process.exit(2);
}

const git = (...argv) => execFileSync('git', ['-C', workspace, ...argv], { encoding: 'utf8' }).trim();
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

// The checkout must be the commit this receipt claims to be about. A receipt that measures a different tree
// than the one it names is worse than no receipt: it is a measurement attributed to the wrong revision.
const head = git('rev-parse', 'HEAD');
if (head !== candidate) {
  console.error(`REFUSING: the workspace is at ${head}, not the requested ${candidate}`);
  process.exit(3);
}
const tree = git('rev-parse', 'HEAD^{tree}');

const manifestPath = path.join(workspace, '.github/coordinator/service/claim-manifest.json');
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));

// Every test the claim names, grouped by the term it belongs to. Both halves matter: the control asserts the
// behaviour, and the mutant is what proves the control would notice the behaviour going away.
const named = [];
for (const entry of manifest.entries ?? []) {
  for (const name of entry.control?.test_names ?? []) {
    named.push({ term: entry.id, kind: 'control', name });
  }
  for (const mutant of entry.killing_mutants ?? []) {
    named.push({ term: entry.id, kind: 'mutant', name: mutant.test_name });
  }
}

const tap = fs.readFileSync(tapPath, 'utf8');
const observed = new Map();
for (const line of tap.split('\n')) {
  const match = /^(not ok|ok) \d+ - (.*?)(?:\s+#\s*(.*))?$/.exec(line.trimEnd());
  if (!match) continue;
  const [, verdict, rawName, comment] = match;
  const name = rawName.trim();
  const status = verdict === 'not ok' ? 'fail' : /SKIP/i.test(comment ?? '') ? 'skipped' : 'pass';
  // A name can appear more than once (a re-run inside one file); a failure anywhere is the status.
  if (observed.get(name) !== 'fail') observed.set(name, status);
}
const tests = named.map(({ term, kind, name }) => ({
  term, kind, name, status: observed.get(name) ?? 'absent',
}));

const totals = { tests: 0, ok: 0, not_ok: 0, skipped: 0 };
for (const line of tap.split('\n')) {
  const summary = /^# (tests|pass|fail|skipped|cancelled) (\d+)$/.exec(line.trim());
  if (!summary) continue;
  if (summary[1] === 'tests') totals.tests = Number(summary[2]);
  if (summary[1] === 'pass') totals.ok = Number(summary[2]);
  if (summary[1] === 'fail') totals.not_ok = Number(summary[2]);
  if (summary[1] === 'skipped') totals.skipped = Number(summary[2]);
}
const runFailures = [...observed].filter(([, status]) => status === 'fail').map(([name]) => name);
const missing = tests.filter(test => test.status === 'absent').map(test => `${test.kind}: ${test.name}`);

const receipt = {
  schema: 1,
  repository: process.env.GITHUB_REPOSITORY ?? null,
  workflow: {
    path: (process.env.GITHUB_WORKFLOW_REF ?? '').split('@')[0] || null,
    ref: process.env.GITHUB_REF ?? null,
    head_sha: process.env.GITHUB_SHA ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
  },
  run: {
    id: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    actor: process.env.GITHUB_ACTOR ?? null,
  },
  candidate: { sha: head, tree },
  manifest: {
    sha256: digest(manifestBytes),
    code_revision: manifest.code_revision ?? null,
  },
  suite: {
    command: process.env.VERIFIER_SUITE_COMMAND ?? null,
    exit: Number(process.env.VERIFIER_SUITE_EXIT ?? '1'),
    ...totals,
    run_failures: runFailures,
  },
  named_tests: tests,
  named_tests_summary: {
    named: tests.length,
    pass: tests.filter(test => test.status === 'pass').length,
    fail: tests.filter(test => test.status === 'fail').length,
    absent: tests.filter(test => test.status === 'absent').length,
    absent_names: missing,
  },
  // The conclusion of the measurement this receipt makes, and nothing wider. The claim under measurement is
  // a set of named terms: a control that asserts a behaviour and the mutant that proves the control would
  // notice the behaviour going away. That measurement succeeds when every named test passes and none is
  // absent - if a named test never ran, the claim was not measured at all and no receipt can say it was.
  //
  // It is deliberately NOT a verdict on the whole suite. This suite carries a known intermittent test
  // unrelated to these terms, and folding it in here would make the receipt a coin toss that lanes learn to
  // re-run until it lands green - the failure mode this whole exercise exists to remove. The suite's own
  // exit code, its counts and the names of every failing test are reported verbatim alongside, so nothing is
  // hidden and the reader judges the rest for themselves.
  conclusion: {
    verdict: missing.length === 0 && tests.every(test => test.status === 'pass') ? 'success' : 'failure',
    scope: 'the named tests of the claim this receipt measured, not the whole suite',
    suite_exit: Number(process.env.VERIFIER_SUITE_EXIT ?? '1'),
    suite_run_failures: runFailures,
  },
};

// Canonical: sorted keys, two-space indent, one trailing newline. The manifest pins this file's digest, so its
// bytes are part of the claim.
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};
fs.writeFileSync(out, `${JSON.stringify(canonical(receipt), null, 2)}\n`);
console.log(`receipt: ${out}`);
console.log(`candidate ${head.slice(0, 12)} tree ${tree.slice(0, 12)} `
  + `conclusion ${receipt.conclusion.verdict} (${receipt.conclusion.scope})`);
console.log(`named tests ${tests.length}: pass ${receipt.named_tests_summary.pass}, `
  + `fail ${receipt.named_tests_summary.fail}, absent ${receipt.named_tests_summary.absent}`);
console.log(`suite: tests ${totals.tests}, ok ${totals.ok}, not_ok ${totals.not_ok}, exit ${receipt.suite.exit}`);
