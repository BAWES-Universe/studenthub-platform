// WHAT `verify-claim.yml` ACTUALLY DOES, asserted against the file rather than against a description of it.
//
// Two of this round's fixes live in a workflow rather than in a module, and a fix in a YAML step body is a fix
// no other test in this directory can reach. That is the same reason `compare-pin.mjs` stopped being a
// `node -e` string. So the steps are read here, out of the file, and the properties are asserted on them.
//
// ITEM 7a. The authority check used to be `gh api /compare/main...<sha> --jq .files[].filename` piped through
// `grep -E`, and a candidate that ran `git mv .github/verifier-receipt/admissibility.mjs tools/adm.mjs` -
// which DELETES the rule that decides - was admitted, because GitHub's compare endpoint reports a rename
// under its NEW name only. `decideAuthorityScope` was already in the protected checkout, reading git TREE
// object ids against the candidate's merge base, and this workflow checked that module out and never called
// it. The second case below drives that module with the review's own attack and watches it refuse.
//
// ITEM 7b. `Report what this proves` carried no `if:`, so on every candidate to date - all of them, because
// the gate below it has never been true - it printed a full account of work that had not happened, on a green
// job.
//
// No network, no git, no token: this file reads one YAML file as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { observeAuthorityScope, decideAuthorityScope, authorityRefusalMessage }
  from '../authority-scope.mjs';

const WORKFLOW = path.join(import.meta.dirname, '..', '..', 'workflows', 'verify-claim.yml');
const text = fs.readFileSync(WORKFLOW, 'utf8');

// The steps of the `verify` job, as name / `if:` / body. Parsed rather than YAML-loaded so that this suite
// needs no dependency: a step starts at six spaces and `- name:`, its own content is indented further, and it
// ends at the next step or at the next SIX-SPACE COMMENT - which is the lead-in written above the next step,
// and belongs to that step rather than to this one.
const steps = (() => {
  const found = [];
  let current = null;
  for (const line of text.split('\n')) {
    const start = /^ {6}- name: (.*)$/.exec(line);
    if (start) {
      current = { name: start[1].trim(), lines: [] };
      found.push(current);
      continue;
    }
    if (/^ {6}#/.test(line)) current = null;
    if (current) current.lines.push(line);
  }
  return found.map(step => ({
    name: step.name,
    if: (/^ {8}if: (.*)$/m.exec(step.lines.join('\n')) ?? [])[1]?.trim() ?? null,
    body: step.lines.join('\n'),
  }));
})();
const step = name => {
  const found = steps.find(entry => entry.name === name);
  assert.ok(found, `no step named ${JSON.stringify(name)}; the file holds: `
    + steps.map(entry => JSON.stringify(entry.name)).join(', '));
  return found;
};

test('ITEM 7a: the authority check calls the module that decides, and greps no compare listing', () => {
  const authority = step('Refuse a candidate that alters the receipt authority');

  // It calls the module. Out of the VERIFIER checkout - the protected ref's - and not the candidate's.
  assert.match(authority.body, /node verifier\/\.github\/verifier-receipt\/authority-scope\.mjs/);
  assert.match(authority.body, /"\$REPO" main "\$CANDIDATE_SHA"/,
    `the CLI takes <owner/repo> <protected-ref> <candidate-sha>, gave: ${authority.body}`);
  assert.doesNotMatch(authority.body, /candidate\/\.github/,
    'the authority check must not run code out of the candidate\'s checkout');

  // And it greps nothing. These are the two halves of the form that admitted a rename.
  assert.doesNotMatch(authority.body, /files\[\]\.filename/,
    'the compare endpoint\'s file listing is the form this round removed');
  assert.doesNotMatch(authority.body, /grep/,
    'a pattern matched against a listing cannot see a rename or a truncation');

  // The step still has the token it needs and still refuses by exiting non-zero, which the module does itself.
  assert.match(authority.body, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(authority.body, /set -euo pipefail/);
});

test('ITEM 7a: the module the step now calls refuses the git mv the grep admitted', async () => {
  // THE REVIEW'S ATTACK, DRIVEN OFFLINE. `git mv .github/verifier-receipt/admissibility.mjs tools/adm.mjs`
  // deletes the rule that decides and leaves the workflow file alone. The compare endpoint answers
  // `tools/adm.mjs` and `apps/pad/unrelated.ts`, which matches no pattern - so the old step printed "the
  // candidate does not alter the receipt authority". A tree id moves when a file moves, so this one does not.
  const TREES = { base: { dir: 'vr-before', workflow: 'wf1' },
    candidate: { dir: 'vr-after-the-move', workflow: 'wf1' },
    protectedRef: { dir: 'vr-before', workflow: 'wf1' } };
  const sideOf = ref => (ref === 'merge-base' ? 'base' : ref === 'candidate-sha' ? 'candidate' : 'protectedRef');
  const api = async endpoint => {
    if (endpoint.includes('/compare/')) return { merge_base_commit: { sha: 'merge-base' } };
    const ref = endpoint.split('/git/trees/')[1];
    if (['merge-base', 'candidate-sha', 'main'].includes(ref)) {
      return { truncated: false, tree: [{ path: '.github', type: 'tree', sha: `dot-github-${sideOf(ref)}` }] };
    }
    if (ref.startsWith('dot-github-')) {
      const side = ref.slice('dot-github-'.length);
      return { truncated: false, tree: [
        { path: 'workflows', type: 'tree', sha: `workflows-${side}` },
        { path: 'verifier-receipt', type: 'tree', sha: TREES[side].dir, mode: '040000' }] };
    }
    if (ref.startsWith('workflows-')) {
      const side = ref.slice('workflows-'.length);
      return { truncated: false, tree: [
        { path: 'verifier-receipt.yml', type: 'blob', sha: TREES[side].workflow, mode: '100644' }] };
    }
    return null;
  };

  const decision = decideAuthorityScope(await observeAuthorityScope(
    { repo: 'owner/name', protectedRef: 'main', candidateSha: 'candidate-sha', api }));
  assert.equal(decision.ok, false, 'a candidate that moves the rule out of the authority must be refused');
  const why = authorityRefusalMessage(decision);
  assert.match(why, /this candidate changes the receipt authority relative to its merge base/);
  assert.match(why, /\.github\/verifier-receipt is modified relative to the merge base/);
  assert.match(why, /no receipt this authority produces may approve it/);

  // The unmoved workflow file is reported unchanged in the same decision, so the refusal names the object
  // that moved rather than accusing the whole authority.
  const entries = Object.fromEntries(decision.entries.map(entry => [entry.path, entry.change]));
  assert.equal(entries['.github/workflows/verifier-receipt.yml'], 'none');
  assert.equal(entries['.github/verifier-receipt'], 'modified');
});

test('ITEM 7b: no step claims work that a skipped gate means did not happen', () => {
  const gate = step('Verify every pin the candidate\'s manifest carries').if;
  assert.ok(gate, 'the verify step must still be gated');

  // The report of the work is gated on EXACTLY the condition that decides whether the work runs.
  assert.equal(step('Report what this proves').if, gate,
    'the step that claims the work must be gated on the same condition as the step that does it');

  // And the complement exists and says what actually happened, so a green job is not silent about it.
  const otherwise = step('Report that nothing was verified');
  assert.equal(otherwise.if, gate.replace("!= ''", "== ''"),
    `the complement must be the negation of the gate, gave: ${otherwise.if}`);
  assert.match(otherwise.body, /carries no manifest/);
  assert.match(otherwise.body, /nothing was verified/);
  assert.match(otherwise.body,
    /establishes only that the candidate does not alter the receipt authority/);
  assert.doesNotMatch(otherwise.body, /Every pin/,
    'the step for a candidate with no manifest must not describe verifying pins');
});

test('ITEM 7b: the gate carries the reason it is never true and a marker for the pending decision', () => {
  // PENDING-MANIFEST-PATH is the string to grep for when the owner settles which file the gate should name.
  // It has to appear on every step that depends on the condition, or the next reader moves one and not the
  // others.
  for (const name of ['Verify every pin the candidate\'s manifest carries', 'Report what this proves',
    'Report that nothing was verified']) {
    assert.match(step(name).body, /PENDING-MANIFEST-PATH/,
      `${name} depends on the pending condition and must carry the marker`);
  }
  // Measured, and written where a reader hits it: the file has never existed in any ref, so the only step
  // that fetches, verifies and compares a pin has never run.
  assert.match(text, /the file has never existed in any ref of this repository/);
  assert.match(text, /HAS NEVER RUN/);
  // And which file it should name is explicitly NOT settled here.
  assert.match(text, /WHICH FILE THIS SHOULD NAME IS NOT DECIDED HERE/);
});

// ITEM 3a. The one place in the repository that addressed the containment question stated the opposite of the
// truth: that a copy of this workflow from a pull request head "would get an advisory report on stderr and a
// non-zero exit instead, which is the intended outcome". A copy of this workflow from a PR head is edited by
// the same author who edits the env, so it sets the two variables itself and gets a pin.
test('ITEM 3a: the containment sentence says what binds, and the false one is quoted as false', () => {
  const verify = step('Verify every pin the candidate\'s manifest carries');
  // The sentence is still in the file, and that is deliberate: this repository corrects a false statement by
  // quoting it and saying why, rather than deleting it and leaving the next reader to rediscover the hole.
  // What matters is that it is now a QUOTATION with a refutation attached, and nowhere an assertion.
  assert.match(verify.body, /This comment used to say[\s\S]*would get an advisory\n?\s*#?\s*report on stderr/,
    'the false sentence must be introduced as the thing this round corrected');
  assert.match(verify.body, /which is the intended outcome"\. That is false/);
  assert.match(verify.body,
    /a copy of this workflow from a PR head is edited by the same\n?\s*#?\s*author who edits the env/);

  // What binds: this workflow, dispatch-only, from protected main, with a verifier from the dispatching ref.
  assert.match(verify.body, /WHAT ACTUALLY BINDS/);
  assert.match(verify.body, /dispatched from protected main/);
  assert.match(verify.body, /guard rail against ACCIDENT/);
  assert.match(verify.body, /not a defence against a candidate that is trying/);
  // And the measurement behind the correction is recorded beside it rather than asserted.
  assert.match(verify.body, /exits 4 with no pin and no --out file/);
  assert.match(verify.body, /setting those two variables itself exits 0 and writes one/);

  // The workflow really is dispatch-only from main, which is the fact the corrected sentence rests on.
  assert.match(text, /^on:\n {2}workflow_dispatch:/m,
    'the containment claim rests on this workflow being workflow_dispatch-only');
});
