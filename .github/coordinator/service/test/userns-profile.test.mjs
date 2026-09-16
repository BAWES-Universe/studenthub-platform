import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { candidate, validateDesign, lifecycle, REQUIRED_PLATFORM, platformGate, canonical, sha256 } from '../userns-profile/contract.mjs';
import { controls } from '../userns-profile/controls.mjs';
const text = fs.readFileSync(new URL('../userns-profile/a12.apparmor', import.meta.url), 'utf8');
const pins = Object.fromEntries(['checkout', 'parser', 'runner', 'runtime'].map(k => [k, sha256(`FAKE:${k}`)]));
const create = () => lifecycle(candidate(text), text, { ...REQUIRED_PLATFORM }, pins);
const named = code => error => error.code === code;

for (const [name, code, mutate] of controls) {
  test(`A12 control ${name}`, () => {
    const design = candidate(text);
    const model = create();
    const facts = Object.fromEntries(['install', 'verify', 'teardown'].map(a => [a, model.requiredFacts(a)]));
    if (process.env.SHU251_USERNS_MUTATION === name) mutate(design, facts);
    assert.doesNotThrow(() => {
      validateDesign(design, text);
      for (const action of ['install', 'verify', 'teardown']) model.accept(action, facts[action]);
    }, code);
  });
}

test('A12 deterministic receipts bind complete facts and previous digest', () => {
  const run = () => {
    const model = create();
    return ['install', 'verify', 'teardown'].map(a => model.accept(a, model.requiredFacts(a)));
  };
  const first = run();
  assert.equal(canonical(first), canonical(run()));
  assert.equal(first[0].previous, null);
  for (let i = 0; i < first.length; i++) {
    const { digest, ...body } = first[i];
    assert.equal(digest, sha256(canonical(body)));
    if (i) assert.equal(first[i].previous, first[i - 1].digest);
    assert.equal(first[i].kind, 'design-simulation');
  }
});
test('A12 absent or changed platform support is a hard blocker', () => {
  assert.throws(() => platformGate(undefined), named('A12_DESIGN_BLOCKER'));
  for (const key of Object.keys(REQUIRED_PLATFORM)) {
    assert.throws(() => platformGate({ ...REQUIRED_PLATFORM, [key]: false }), named('A12_DESIGN_BLOCKER'));
    const missing = { ...REQUIRED_PLATFORM }; delete missing[key];
    assert.throws(() => platformGate(missing), named('A12_DESIGN_BLOCKER'));
  }
});
test('A12 every missing install or verification field refuses and permits only cleanup', () => {
  for (const action of ['install', 'verify']) {
    for (const key of Object.keys(create().requiredFacts(action))) {
      const m = create();
      if (action === 'verify') m.accept('install', m.requiredFacts('install'));
      const facts = m.requiredFacts(action); delete facts[key];
      assert.throws(() => m.accept(action, facts), error => /^A12_/.test(error.code), key);
      assert.throws(() => m.accept('verify', m.requiredFacts('verify')), named('A12_RECEIPT_ORDER'));
      m.accept('teardown', m.requiredFacts('teardown'));
    }
  }
});
test('A12 substituted parser, loaded identity, profile, runtime and checkout fail closed', () => {
  for (const action of ['install', 'verify']) {
    for (const key of ['parserDigest', 'mode', 'loadedNames', 'profileDigest', 'runnerDigest', 'runtimeDigest', ...(action === 'verify' ? ['checkoutDigest', 'identity', 'beforeLabel', 'afterLabel'] : ['attachment'])]) {
      const m = create();
      if (action === 'verify') m.accept('install', m.requiredFacts('install'));
      const facts = m.requiredFacts(action); facts[key] = 'substituted';
      assert.throws(() => m.accept(action, facts), error => /^A12_/.test(error.code), key);
    }
  }
});
test('A12 missing transition, extra authority, arbitrary argv and identities refuse', () => {
  for (const change of [d => { d.transition = null; }, d => { d.identity.uid = 0; },
    d => { d.identity.groups.push(0); }, d => { d.probe.push('/bin/bash'); },
    d => { d.profileText = d.profileText.replace('    capability sys_admin,', '    capability,'); },
    d => { d.sudoChanges.push('ALL'); }, d => { d.extra = true; }]) {
    const d = candidate(text); change(d);
    assert.throws(() => validateDesign(d, text), error => /^A12_/.test(error.code));
  }
});
test('A12 rollback requires no tasks, files, cache or labels and cannot be replayed', () => {
  for (const key of ['attachedTasks', 'policyFilePresent', 'runnerPresent', 'cachePresent', 'checkoutPresent', 'baselineRestored']) {
    const m = create(); m.accept('install', m.requiredFacts('install'));
    const facts = m.requiredFacts('teardown'); facts[key] = key === 'attachedTasks' ? [123] : !facts[key];
    assert.throws(() => m.accept('teardown', facts), error => /^A12_/.test(error.code));
    m.accept('teardown', m.requiredFacts('teardown'));
    assert.throws(() => m.accept('install', m.requiredFacts('install')), named('A12_RECEIPT_ORDER'));
  }
});
test('A12 policy bytes require an independent review pin', () => {
  assert.equal(sha256(text), '4e229ce4faef8e6b0303e84052b466b7dc0b297a3b6a662b53bc7cf424d6f63b', 'A12_PROFILE_REVIEW_PIN');
});
test('A12 ordinary Node, coordinator and supervisor each remain excluded', () => {
  for (const key of ['nodeLabelChanged', 'coordinatorLabelChanged', 'supervisorLabelChanged']) {
    const m = create(); m.accept('install', m.requiredFacts('install'));
    const facts = m.requiredFacts('verify'); facts[key] = true;
    assert.throws(() => m.accept('verify', facts), named('A12_ORDINARY_EXCLUDED'));
  }
});
test('A12 undefined pins and out-of-order receipts cannot authorize execution', () => {
  assert.throws(() => lifecycle(candidate(text), text, REQUIRED_PLATFORM, {}), named('A12_PINS_REQUIRED'));
  const m = create();
  assert.throws(() => m.accept('verify', m.requiredFacts('verify')), named('A12_RECEIPT_ORDER'));
  m.accept('install', m.requiredFacts('install'));
  assert.throws(() => m.accept('install', m.requiredFacts('install')), named('A12_RECEIPT_ORDER'));
  const facts = m.requiredFacts('verify'); facts.unreviewed = true;
  assert.throws(() => m.accept('verify', facts), named('A12_VERIFY_EVIDENCE'));
});
