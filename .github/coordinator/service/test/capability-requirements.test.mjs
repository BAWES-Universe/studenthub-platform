import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as contract from '../host-suite-contract.mjs';
const spec = { service_uid: 999, service_gid: 982, service_groups: [980, 982], checkout: '/fixture', temp_dir: '/fixture/tmp' };
const name = 'SHU-227: worker owns its checkout and recovery preserves descendant commits';
const reason = 'requires root or passwordless sudo for distinct-uid proof';
const covered = { names: [name], requirements: [{ name, capabilities: [{ name: 'privilege', reason }, { name: 'worker_uid', reason }] }] };
const probe = key => key === 'cvtsudoers' ? { available: true, identity: '/usr/bin/cvtsudoers.ws' } : !['privilege', 'worker_uid'].includes(key);
async function controls(api = contract) {
  let accepted;
  await assert.doesNotReject(async () => { accepted = await api.preflight(spec, probe, covered); }, 'COVERED_ABSENCE');
  assert.deepEqual(accepted.capabilities.privilege, { available: false, authorized_skips: [{ name, reason }] }, 'COVERED_ABSENCE');
  assert.deepEqual(accepted.capabilities.worker_uid, accepted.capabilities.privilege, 'WORKER_COVERED_ABSENCE');
  const result = await api.runSuite(spec, { probe, contract: async () => ({ ...covered, files: ['/fixture/test.mjs'], expected_tests: 1 }),
    run: () => ({ status: 0, stdout: JSON.stringify({ type: 'outcome', name, status: 'skip', reason }) + '\n{"type":"complete"}' }) });
  assert.deepEqual(result.counts, { tests: 1, pass: 0, fail: 0, skipped: 1 }, 'COVERED_SUITE');
  for (const capability of ['privilege', 'worker_uid']) {
    const required = { names: [name, 'uncovered proof'], requirements: [...covered.requirements, { name: 'uncovered proof', capabilities: [{ name: capability }] }] };
    await assert.rejects(() => api.preflight(spec, probe, required), error => error.code === (capability === 'privilege' ? 'SHU251_PREFLIGHT_PRIVILEGE' : 'SHU251_PREFLIGHT_WORKER_UID') && error.message.includes('uncovered proof'), 'UNCOVERED_BY_NAME');
  }
  await assert.rejects(() => api.preflight(spec, probe, { ...covered, requirements: [] }), { code: 'SHU251_PREFLIGHT_REQUIREMENTS' }, 'SHU251_PREFLIGHT_REQUIREMENTS');
  for (const change of [ { name: 'new test' }, { capabilities: [{ name: 'privilege', reason: reason + ' ' }] } ]) {
    const row = { ...covered.requirements[0], ...change };
    await assert.rejects(() => api.preflight(spec, probe, { names: [row.name], requirements: [row] }), { code: 'SHU251_PREFLIGHT_SKIP_BINDING' }, 'SHU251_PREFLIGHT_SKIP_BINDING');
  }
  await assert.rejects(() => api.preflight(spec, () => { throw Error('new failure'); }, covered), { code: 'SHU251_PREFLIGHT_PRIVILEGE' }, 'PROBE_FAILURE_NOT_SKIP');
  for (const value of [undefined, null, {}, 'missing'])
    await assert.rejects(() => api.preflight(spec, () => value, covered), { code: 'SHU251_PREFLIGHT_PRIVILEGE' }, 'MALFORMED_PROBE_NOT_SKIP');
  const ns = { names: ['M3 namespace capability control'], requirements: [{ name: 'M3 namespace capability control', capabilities: [{ name: 'user_namespaces' }] }] };
  await assert.rejects(() => api.preflight(spec, key => key === 'user_namespaces' ? false : probe(key), ns), error => error.code === 'SHU251_PREFLIGHT_USER_NAMESPACES' && error.message.includes(ns.names[0]), 'NAMESPACE_REQUIRED');
  for (const [status, why, code] of [['fail', reason, 'SHU251_SUITE_FAILURE'], ['skip', reason + ' ', 'SHU251_SUITE_UNPERMITTED_SKIP']])
    assert.throws(() => api.evaluateSuite({ complete: true, exit_code: 0, outcomes: [{ name, status, reason: why }] }, 1), { code }, 'OUTCOME_NOT_RECLASSIFIED');
}
// Reviewed requirement mapping only, not an authoritative suite inventory.
// The removed namespace startup row required user_namespaces. Its replacement
// proofs require the parser or Bash; no namespace requirement transfers to them.
test('SHU251 C2 Option A wrapper proofs have no namespace requirement', () => {
  const requirements = [
    { name: 'SHU261_NO_SETENV_POLICY', capabilities: [{ name: 'cvtsudoers' }] },
    { name: 'SHU261 wrapper contract isolates both reviewer phases and every protected class', capabilities: [] },
    { name: 'SHU261 root wrapper startup ignores PATH and BASH_ENV before parsing', capabilities: [{ name: 'bash' }] },
  ];
  const derived = contract.deriveRequirements(requirements.map(row => row.name), requirements);
  assert.deepEqual(derived.user_namespaces, []);
  assert.equal(derived.cvtsudoers[0].test, requirements[0].name);
  assert.equal(derived.bash[0].test, requirements[2].name);
});
test('SHU251 C2 derived capability positive and refusal controls', () => controls());
test('SHU251 C2 supplied identities do not imply sudo authority', async () => {
  for (const [uid, gid] of [[999, 982], [994, 979]]) {
    const calls = [];
    const p = contract.hostProbe({ ...spec, service_uid: uid, service_gid: gid }, { uid: () => uid, run: (file, args) => { calls.push([file, args]); return { status: 1, stdout: '' }; } });
    assert.equal(await p('privilege'), false); assert.equal(await p('worker_uid'), false);
    assert.ok(calls.every(([file]) => file === '/usr/bin/sudo'));
    assert.equal(await p('user_namespaces'), false);
    assert.deepEqual(calls.at(-1), ['/usr/bin/unshare', ['--user', '--map-root-user', '/bin/true']]);
  }
});
const mutations = [
  ['covered absence rejected', "if (!available && derived)", 'if (false)', 'COVERED_ABSENCE'],
  ['uncovered requirement ignored', '|| uncovered.length)', '|| false)', 'UNCOVERED_BY_NAME'],
  ['required set omitted', 'requirements.length !== names.length', 'false', 'SHU251_PREFLIGHT_REQUIREMENTS'],
  ['skip binding bypassed', "(!Object.hasOwn(PERMITTED_SKIPS, row.name) || need.reason !== PERMITTED_SKIPS[row.name])", 'false', 'SHU251_PREFLIGHT_SKIP_BINDING'],
  ['malformed probe reclassified', 'if (!available && resolved !== false)', 'if (false)', 'MALFORMED_PROBE_NOT_SKIP'],
  ['probe failure reclassified', '      halt(capability.code, capability.name);', '      available = false; resolved = false;', 'PROBE_FAILURE_NOT_SKIP'],
  ['namespace absence waived', "!['privilege', 'worker_uid'].includes(capability.name) || uncovered.length", "capability.name !== 'user_namespaces' && (!['privilege', 'worker_uid'].includes(capability.name) || uncovered.length)", 'NAMESPACE_REQUIRED'],
  ['new outcome failure accepted', "if (status === 'fail')", 'if (false)', 'OUTCOME_NOT_RECLASSIFIED'],
  ['different outcome reason accepted', 'reason !== PERMITTED_SKIPS[name]', 'false', 'OUTCOME_NOT_RECLASSIFIED'],
];
for (const [label, from, to, assertion] of mutations) test(`SHU251 C2 mutation ${label}`, async t => {
  await controls();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-mutation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mutant.mjs');
  const source = fs.readFileSync(new URL('../host-suite-contract.mjs', import.meta.url), 'utf8');
  assert.equal(source.split(from).length, 2, 'unique mutation');
  fs.writeFileSync(file, source.replace(from, to));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, 'syntax clean');
  const mutant = await import(pathToFileURL(file));
  await assert.rejects(() => controls(mutant), error => error.code === 'ERR_ASSERTION' && error.message.includes(assertion), assertion);
});
