#!/usr/bin/env node
// Repository-only mint. No signing, host reads, ref writes, or caller package input.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalBytes, SHU71_FIXED_SEEDS } from '../shu71-activation-package.mjs';
import { createGitAdapter, precomputeReseedBinding } from '../reseed-append-contract.mjs';
import { composeApproval } from './compose-shu71-approval.mjs';
import { hash, UNIT_NAMES } from './phase-a-driver.mjs';
import { serviceParameters, quote, WORKSPACE_STATE_DIR } from './units.mjs';
import { REQUIRED_CAPABILITIES } from './host-lifecycle.mjs';
import { validateWindowSpec } from './host-window-bindings.mjs';

const ROOT = '/srv/shu/state/shu71-evidence';
// Reviewed retained lineage tip. Advancing it requires a reviewed policy change.
export const RETAINED_PARENT = '6e5ad86cc0a993097d2e642132077b665ad49481';
const SEALED_PARENT = '0d3b65a4ca7588905952a57086394f264c2e24d4';
const REPO = 'https://github.com/BAWES-Universe/studenthub-platform.git';
const PAIR = ['SHU-140', 'SHU-254'];
const bytes = v => canonicalBytes(v, false);
const same = (a, b) => bytes(a).equals(bytes(b));
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && same(Object.keys(v).sort(), [...keys].sort());
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const absolute = v => typeof v === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(v) && path.normalize(v) === v && !v.endsWith('/');
function read(file, code) {
  try { const s = fs.lstatSync(file); need(s.isFile() && !s.isSymbolicLink(), code); return JSON.parse(fs.readFileSync(file)); }
  catch { need(false, code); }
}
export function validateIdLedger(l) {
  need(exact(l, ['version', 'captured_at', 'source', 'ids', 'count', 'sha256']) && l.version === 'shu71-activation-id-ledger-v1'
    && typeof l.source === 'string' && l.source.length > 0 && Number.isFinite(Date.parse(l.captured_at))
    && Array.isArray(l.ids) && l.ids.length > 0 && l.count === l.ids.length && new Set(l.ids).size === l.ids.length
    && l.ids.every(id => /^[A-Za-z0-9_-]{8,64}$/.test(id)), 'MINT_ID_LEDGER');
  need(hash(l.ids.join('\n') + '\n') === l.sha256, 'MINT_ID_LEDGER_DIGEST');
  return l;
}
export function activationId(l) {
  validateIdLedger(l);
  // Candidate comes only from ledger cardinality; a collision fails closed.
  // The explicit membership check remains mandatory (and separately tested).
  const id = `shu71-mint-${String(l.count + 1).padStart(8, '0')}`;
  need(!l.ids.includes(id), 'MINT_ID_REUSED');
  return id;
}
export function validateObservations(l) {
  need(exact(l, ['version', 'captured_at', 'source', 'observations', 'sha256'])
    && l.version === 'shu71-mint-observations-v1' && typeof l.source === 'string' && l.source.length > 0
    && Number.isFinite(Date.parse(l.captured_at)), 'MINT_OBSERVATIONS_REQUIRED');
  const { sha256, ...body } = l;
  need(hash(bytes(body)) === sha256, 'MINT_OBSERVATIONS_DIGEST');
  const o = l.observations;
  need(exact(o, ['identity', 'environment', 'directories', 'checkout_before', 'systemd_version', 'capabilities', 'issues', 'ready_state_id', 'worker_uid', 'reviewer_uid']), 'MINT_OBSERVATIONS_SHAPE');
  const i = o.identity;
  need(exact(i, ['user', 'group', 'uid', 'gid', 'groups']) && i.user === 'shu-coordinator' && i.group === 'shu-coordinator'
    && i.uid === 999 && Number.isSafeInteger(i.gid) && i.gid > 0 && Array.isArray(i.groups)
    && i.groups.every(g => Number.isSafeInteger(g) && g > 0) && new Set(i.groups).size === i.groups.length
    && o.worker_uid === 995 && o.reviewer_uid === 994, 'MINT_IDENTITY');
  const environment = { supervisor: { path: '/etc/shu/supervisor.env', uid: 0, gid: 0, mode: 0o600, kind: 'file' },
    coordinator: { path: '/srv/shu/coordinator.env', uid: i.uid, gid: i.gid, mode: 0o600, kind: 'file' } };
  need(same(o.environment, environment), 'MINT_ENVIRONMENT');
  need(same(o.directories, [WORKSPACE_STATE_DIR, `${WORKSPACE_STATE_DIR}/supervisor`].map(p => ({ path: p, kind: 'directory', uid: i.uid, gid: i.gid, mode: 0o700 }))), 'MINT_DIRECTORIES');
  const c = o.checkout_before;
  need(exact(c, ['sha', 'head_ref', 'main', 'origin_main', 'tree', 'clean']) && [c.sha, c.main, c.origin_main, c.tree].every(sha)
    && [null, 'refs/heads/main'].includes(c.head_ref) && (c.head_ref === null || c.sha === c.main) && c.clean === true, 'MINT_PRIOR_GIT');
  need(Number.isSafeInteger(o.systemd_version) && o.systemd_version >= 250 && same(o.capabilities, REQUIRED_CAPABILITIES), 'MINT_CAPABILITIES');
  need(Array.isArray(o.issues) && o.issues.length === 2 && same(o.issues.map(v => v.issue_id).sort(), PAIR)
    && o.issues.every(v => exact(v, ['issue_id', 'linear_id', 'state_id', 'assignee_id']) && uuid(v.linear_id) && uuid(v.state_id) && (v.assignee_id === null || uuid(v.assignee_id)))
    && new Set(o.issues.map(v => v.linear_id)).size === 2 && uuid(o.ready_state_id), 'MINT_ISSUES');
  return l;
}

export function repositoryFacts(repo, gitBoundary = createGitAdapter) {
  need(absolute(repo) && fs.realpathSync(repo) === repo, 'MINT_CHECKOUT');
  const git = gitBoundary(repo), str = args => git(args).toString().trim();
  const revision = str(['rev-parse', 'HEAD']);
  need(str(['remote', 'get-url', 'origin']) === REPO, 'MINT_REMOTE');
  const refs = ['refs/heads/main', ...PAIR.map(id => `refs/heads/coordinator/${id}`)];
  const lines = str(['ls-remote', '--refs', 'origin', ...refs]).split('\n');
  const remote = Object.fromEntries(lines.map(line => { const [oid, ref] = line.split('\t'); return [ref, oid]; }));
  need(lines.length === 3 && refs.every(ref => sha(remote[ref])), 'MINT_REMOTE');
  need(revision === remote[refs[0]] && revision === str(['rev-parse', 'refs/remotes/origin/main']), 'MINT_REVISION');
  const tree = str(['rev-parse', `${revision}^{tree}`]);
  need(str(['rev-parse', 'HEAD^{tree}']) === tree && str(['status', '--porcelain=v1', '--untracked-files=all']) === '', 'MINT_TREE');
  // Read actual tracked bytes as well: index flags cannot conceal substitutions.
  const tracked = git(['ls-tree', '-r', '-z', revision]).toString().split('\0').filter(Boolean);
  for (const row of tracked) {
    const tab = row.indexOf('\t'), [mode, type, oid] = row.slice(0, tab).split(' '), name = row.slice(tab + 1);
    need(type === 'blob', 'MINT_TREE');
    const file = path.join(repo, name), stat = fs.lstatSync(file);
    need(mode === '120000' ? stat.isSymbolicLink() : stat.isFile() && !stat.isSymbolicLink()
      && Boolean(stat.mode & 0o111) === (mode === '100755'), 'MINT_TREE');
    const content = mode === '120000' ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
    const actual = createHash('sha1').update(Buffer.from(`blob ${content.length}\0`)).update(content).digest('hex');
    need(actual === oid, 'MINT_TREE');
  }
  const readAt = name => git(['show', `${revision}:.github/coordinator/${name}`]);
  const config = JSON.parse(readAt('config.json'));
  const lanes = [config.fixture_lane, ...config.fixture_lanes];
  need(same(lanes.map(l => l.id), PAIR) && same(config.dispatch_scope.issue_ids, PAIR), 'MINT_FIXTURES');
  for (const id of PAIR) {
    const head = remote[`refs/heads/coordinator/${id}`];
    need(head === str(['rev-parse', `refs/heads/coordinator/${id}`])
      && head === str(['rev-parse', `refs/remotes/origin/coordinator/${id}`])
      && head === (id === 'SHU-140' ? RETAINED_PARENT : SHU71_FIXED_SEEDS[id]), 'MINT_LINEAGE');
  }
  git(['merge-base', '--is-ancestor', SEALED_PARENT, RETAINED_PARENT], { code: 'PARENT_MISMATCH' });
  const binding = precomputeReseedBinding({ git, branch: `coordinator/${lanes[0].id}`, expected_parent: remote[refs[1]], approvedExecutionRevision: revision });
  return { revision, tree, lanes, binding, remote, anchor: JSON.parse(readAt('shu71-trust-anchor.json')),
    publicKeyPem: readAt('shu71-activation-public-key.pem').toString(),
    templates: Object.fromEntries(UNIT_NAMES.map(n => [n, readAt(`service/${n}.in`).toString()])) };
}

const substitutions = { revision: 'REVISION', coordinator_revision: 'REVISION', fixtures: 'FIXTURES', branch: 'BRANCH',
  expected_parent: 'LINEAGE', expected_seed_head: 'LINEAGE', seed_head: 'LINEAGE', patch_sha256: 'PATCH', evidence: 'EVIDENCE',
  signature: 'SIGNATURE', signatures: 'SIGNATURE', commands: 'COMMANDS', driver: 'COMMANDS', activation_id: 'ID_UNKNOWN', pkg: 'CALLER_PACKAGE', spec: 'CALLER_SPEC' };
export function optionsCheck(options) {
  const keys = ['repo', 'checkout', 'idLedger', 'observations', 'windowFile', 'lifetimeMs', 'maxObservationAgeMs'];
  for (const key of Object.keys(options)) need(keys.includes(key), `MINT_${substitutions[key] ?? 'CALLER_FIELD'}`);
  need(keys.every(k => Object.hasOwn(options, k)), 'MINT_REQUIRED');
  need([options.repo, options.checkout, options.windowFile].every(absolute), 'MINT_PATH');
  need(Number.isSafeInteger(options.lifetimeMs) && options.lifetimeMs > 0 && options.lifetimeMs <= 43_200_000
    && Number.isSafeInteger(options.maxObservationAgeMs) && options.maxObservationAgeMs > 0 && options.maxObservationAgeMs <= 43_200_000, 'MINT_EXPIRY');
}
// Internal derivation seam for synthetic tests; CLI never accepts facts or a clock.
export function derive(options, facts, now = Date.now()) {
  optionsCheck(options);
  const ledger = validateIdLedger(options.idLedger), observation = validateObservations(options.observations);
  const at = Date.parse(observation.captured_at), age = now - at;
  need(age >= 0 && age <= options.maxObservationAgeMs && at >= Date.parse(ledger.captured_at), 'MINT_OBSERVATION_STALE');
  need(at + options.lifetimeMs > now, 'MINT_EXPIRED');
  const activation_id = activationId(ledger), o = observation.observations;
  const { revision, tree, lanes, binding } = facts;
  need(sha(revision) && sha(tree) && binding.approvedExecutionRevision === revision, 'MINT_REVISION');
  need(same(lanes.map(l => l.id), PAIR), 'MINT_FIXTURES');
  const fixtures = lanes.map(lane => ({ issue_id: lane.id, linear_id: o.issues.find(i => i.issue_id === lane.id).linear_id,
    branch: `coordinator/${lane.id}`, seed_head: lane.id === 'SHU-140' ? binding.expected_seed_head : SHU71_FIXED_SEEDS[lane.id], lane }));
  const expires_at = new Date(at + options.lifetimeMs).toISOString();
  const episode = `${ROOT}/${activation_id}`;
  const pkg = { kind: 'shu71-activation-package-v1', activation_id, coordinator_revision: revision,
    created_at: new Date(at).toISOString(), expires_at, slots: 2, stop_before_merge: true, merge_authority: 'none', fixtures,
    reseed: { issue_id: 'SHU-140', ...Object.fromEntries(['branch', 'expected_parent', 'expected_seed_head', 'patch_sha256'].map(k => [k, binding[k]])), append_only: true, force: false },
    issue_transitions: fixtures.map(f => { const i = o.issues.find(i => i.issue_id === f.issue_id), before = { state_id: i.state_id, assignee_id: i.assignee_id };
      return { issue_id: f.issue_id, linear_id: f.linear_id, before, ready: { state_id: o.ready_state_id, assignee_id: null }, restore: { ...before } }; }),
    cleanup: { worktree_root: '/srv/shu/worktrees', evidence_dir: ROOT, coordinator_uid: o.identity.uid, worker_uid: o.worker_uid,
      reviewer_uid: o.reviewer_uid, identity_bound: true, retain_evidence: true },
    evidence: { journal_path: `${episode}/journal.jsonl`, archive_path: `${episode}/activation.json`, append_only: true, retain_on_failure: true },
    activation: { kind: 'two-fixture-v1', activation_id, coordinator_revision: revision, slots: 2, expires_at, stop_before_merge: true,
      fixtures: fixtures.map(({ linear_id, ...f }) => f), gates: { reviewed: true, runtime: true }, signature: '' }, signature: '' };
  const render = { workdir: options.checkout, node: '/usr/bin/node', serviceUser: o.identity.user, serviceGroup: o.identity.group,
    supervisorEnvironmentFile: o.environment.supervisor.path, coordinatorEnvironmentFile: o.environment.coordinator.path,
    workspaceStateDir: WORKSPACE_STATE_DIR, supervisorStateDir: `${WORKSPACE_STATE_DIR}/supervisor`, supervisorSocket: `${WORKSPACE_STATE_DIR}/supervisor.sock` };
  const p = serviceParameters(render), command = argv => argv.map(quote).join(' ');
  const values = { SERVICE_USER: p.serviceUser, SERVICE_GROUP: p.serviceGroup, WORKDIR: p.workdir, WORKSPACE_STATE_DIR,
    SUPERVISOR_STATE_DIR: p.supervisorStateDir, SUPERVISOR_SOCKET: p.supervisorSocket,
    SUPERVISOR_ENVIRONMENT_FILE: p.supervisorEnvironmentFile, COORDINATOR_ENVIRONMENT_FILE: p.coordinatorEnvironmentFile,
    SUPERVISOR_EXEC: command(p.supervisor), COORDINATOR_EXEC: command(['/usr/bin/flock', '--nonblock', '--conflict-exit-code', '2', p.writerLock, ...p.coordinator]) };
  const rendered = Object.fromEntries(UNIT_NAMES.map(n => [n, facts.templates[n].replace(/@([A-Z_]+)@/g, (_, key) => {
    need(Object.hasOwn(values, key), 'MINT_RENDER'); return values[key]; })]));
  for (const n of ['shu-supervisor.service', 'shu-coordinator.service']) rendered[`${n}.d/10-shu251.conf`] = '[Service]\nEnvironment=ENABLE_DISPATCH=false\n';
  // Launch identity is minted deterministically; a process has not been launched.
  const hex = hash(bytes({ activation_id, revision }));
  const attempt_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const window = { version: 'shu251-host-window-v2', approved_sha: revision, repo_dir: options.checkout, remote_url: REPO, remote_ref: 'refs/heads/main',
    workspace_state_dir: render.workspaceStateDir, supervisor_state_dir: render.supervisorStateDir, supervisor_socket: render.supervisorSocket,
    status_environment_file: render.coordinatorEnvironmentFile, service_uid: o.identity.uid,
    fixture: { issue_id: fixtures[0].issue_id, attempt_id, target_sha: fixtures[0].seed_head,
      order_json: `${episode}/order.json`, release_file: `${episode}/release.json`, journal_file: `${episode}/fixture-journal.jsonl`, pid: null, start_token: null },
    unit_directory: '/etc/systemd/system', staged_unit_directory: `${episode}/units`, prior_state_file: `${episode}/prior-state.json` };
  validateWindowSpec(window);
  const production = composeApproval({ pkg, revision, activationId: activation_id, checkout: options.checkout, tree, binding,
    anchor: facts.anchor, publicKeyPem: facts.publicKeyPem }).payload;
  const spec = { window, window_spec_path: options.windowFile, render, production, lifecycle: { activation_id, approval_sha256: '', approved_tree: tree,
    identity: o.identity, environment: o.environment, directories: o.directories, systemd_version: o.systemd_version, capabilities: o.capabilities,
    evidence_root: ROOT, evidence_dir: episode, rendered_sha256: Object.fromEntries(Object.entries(rendered).map(([n, v]) => [n, hash(v)])), checkout_before: o.checkout_before } };
  return { pkg, spec, window };
}
function shape(actual, expected) {
  need(actual !== undefined, 'MINT_REQUIRED');
  if (expected && typeof expected === 'object') {
    need(actual && typeof actual === 'object' && Array.isArray(actual) === Array.isArray(expected), 'MINT_REQUIRED');
    for (const key of Object.keys(expected)) { need(Object.hasOwn(actual, key), 'MINT_REQUIRED'); shape(actual[key], expected[key]); }
  }
}
export function validateMint(actual, expected) {
  shape(actual, expected);
  const p = actual.pkg, s = actual.spec;
  need(p.signature === '' && p.activation.signature === '' && s.production.pkg.signature === '' && s.production.pkg.activation.signature === '', 'MINT_SIGNATURE');
  need(p.coordinator_revision === expected.pkg.coordinator_revision && p.activation.coordinator_revision === p.coordinator_revision, 'MINT_REVISION');
  need(p.activation_id === expected.pkg.activation_id && p.activation.activation_id === p.activation_id, 'MINT_ID_UNKNOWN');
  need(same(p.fixtures, expected.pkg.fixtures) && same(p.activation.fixtures, expected.pkg.activation.fixtures), 'MINT_FIXTURES');
  need(p.reseed.branch === expected.pkg.reseed.branch, 'MINT_BRANCH');
  need(p.reseed.expected_parent === expected.pkg.reseed.expected_parent && p.reseed.expected_seed_head === expected.pkg.reseed.expected_seed_head, 'MINT_LINEAGE');
  need(p.reseed.patch_sha256 === expected.pkg.reseed.patch_sha256, 'MINT_PATCH');
  need(same(p.evidence, expected.pkg.evidence) && s.lifecycle.evidence_root === ROOT && s.lifecycle.evidence_dir === expected.spec.lifecycle.evidence_dir, 'MINT_EVIDENCE');
  need(same(s.render, expected.spec.render), 'MINT_COMMANDS');
  need(same(s.production.pkg, p) && s.lifecycle.activation_id === p.activation_id && s.window.approved_sha === p.coordinator_revision
    && same(actual.window, s.window) && s.lifecycle.approved_tree === s.production.tree, 'MINT_DISAGREEMENT');
  need(same(actual, expected), 'MINT_NONDETERMINISTIC');
  return actual;
}
export function mint(options) {
  optionsCheck(options);
  validateIdLedger(options.idLedger); validateObservations(options.observations);
  const facts = repositoryFacts(options.repo), now = Date.now();
  const first = derive(options, facts, now), second = derive(options, facts, now);
  validateMint(first, second);
  return first;
}
export function main(argv = process.argv.slice(2)) {
  // Positional, closed vocabulary: paths and two policy bounds only.
  const [action, repo, checkout, idFile, observationsFile, output, lifetime, maxAge] = argv;
  need(['mint', 'validate'].includes(action) && argv.length === 8, 'MINT_USAGE');
  need([repo, checkout, idFile, observationsFile, output].every(absolute), 'MINT_PATH');
  need(/^[1-9][0-9]*$/.test(lifetime) && /^[1-9][0-9]*$/.test(maxAge), 'MINT_EXPIRY');
  const options = { repo, checkout, idLedger: read(idFile, 'MINT_ID_LEDGER'), observations: read(observationsFile, 'MINT_OBSERVATIONS_REQUIRED'),
    windowFile: `${output}/window.json`, lifetimeMs: Number(lifetime), maxObservationAgeMs: Number(maxAge) };
  const expected = mint(options);
  if (action === 'validate') {
    const actual = Object.fromEntries(['pkg', 'spec', 'window'].map(n => [n, read(`${output}/${n === 'pkg' ? 'package' : n}.json`, 'MINT_REQUIRED')]));
    validateMint(actual, expected);
  } else {
    // Exclusive directory creation prevents partial output from looking complete.
    fs.mkdirSync(output, { mode: 0o700 });
    for (const [n, v] of Object.entries(expected)) fs.writeFileSync(`${output}/${n === 'pkg' ? 'package' : n}.json`, bytes(v), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(`${output}/complete.json`, bytes({ package_sha256: hash(bytes(expected.pkg)), spec_sha256: hash(bytes(expected.spec)), window_sha256: hash(bytes(expected.window)) }), { flag: 'wx', mode: 0o600 });
  }
  return { ok: true, signed: false, activation_id: expected.pkg.activation_id, revision: expected.pkg.coordinator_revision };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(main())); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error.code ?? 'MINT_INPUT' })); process.exitCode = 2; }
}
