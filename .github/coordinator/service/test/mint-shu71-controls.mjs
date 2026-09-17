import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { activationId, validateIdLedger, validateObservations, derive, validateMint, optionsCheck, repositoryFacts, mint, main, RETAINED_PARENT } from '../mint-shu71-package.mjs';
import { hash } from '../phase-a-driver.mjs';
import { canonicalBytes } from '../../shu71-activation-package.mjs';
import { REQUIRED_CAPABILITIES } from '../host-lifecycle.mjs';
import { createGitAdapter, SEALED_SEED_BLOBS } from '../../reseed-append-contract.mjs';
import { composeApproval } from '../compose-shu71-approval.mjs';
import { render, serviceParameters } from '../units.mjs';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const bytes = v => canonicalBytes(v, false);
export const mintControlName = 'SHU71 mint positive controls and named refusals';
export function controls() {
  const config = JSON.parse(fs.readFileSync(path.join(root, '.github/coordinator/config.json')));
  const at = Date.now();
  const ids = ['shu71-existing-0001'];
  const ledger = { version: 'shu71-activation-id-ledger-v1', captured_at: new Date(at).toISOString(), source: 'synthetic observation', ids, count: 1, sha256: hash(ids.join('\n') + '\n') };
  const identity = { user: 'shu-coordinator', group: 'shu-coordinator', uid: 999, gid: 999, groups: [999] };
  const observations = { version: 'shu71-mint-observations-v1', captured_at: ledger.captured_at, source: 'synthetic; never host evidence', observations: {
    identity, environment: { supervisor: { path: '/etc/shu/supervisor.env', uid: 0, gid: 0, mode: 384, kind: 'file' }, coordinator: { path: '/srv/shu/coordinator.env', uid: 999, gid: 999, mode: 384, kind: 'file' } },
    directories: ['/srv/shu/state/workspaces', '/srv/shu/state/workspaces/supervisor'].map(path => ({ path, kind: 'directory', uid: 999, gid: 999, mode: 448 })),
    checkout_before: { sha: 'a'.repeat(40), head_ref: null, main: 'a'.repeat(40), origin_main: 'a'.repeat(40), tree: 'b'.repeat(40), clean: true },
    systemd_version: 255, capabilities: [...REQUIRED_CAPABILITIES], worker_uid: 995, reviewer_uid: 994,
    ready_state_id: '68ef4514-566d-4ea8-8040-d933575b99d0',
    issues: ['SHU-140', 'SHU-254'].map((issue_id, i) => ({ issue_id, linear_id: ['3c2b8f0e-9608-477f-beb3-84d51b3dcb0f', '8254e831-be6b-4d55-a99c-7f9437ac5981'][i], state_id: 'd7847882-e3dc-42d3-8a81-4657d6161500', assignee_id: null })) } };
  observations.sha256 = hash(bytes(observations));
  const options = { repo: root.replace(/\/$/, ''), checkout: '/srv/shu/repo', idLedger: ledger, observations, windowFile: '/reviewed/mint/window.json', lifetimeMs: 3600000, maxObservationAgeMs: 60000 };
  const facts = { revision: 'a'.repeat(40), tree: 'b'.repeat(40), lanes: [config.fixture_lane, ...config.fixture_lanes],
    binding: { branch: 'coordinator/SHU-140', expected_parent: RETAINED_PARENT, expected_seed_head: 'c'.repeat(40), patch_sha256: hash(''), approvedExecutionRevision: 'a'.repeat(40), tree: 'd'.repeat(40), manifest_hex: '' },
    anchor: JSON.parse(fs.readFileSync(path.join(root, '.github/coordinator/shu71-trust-anchor.json'))), publicKeyPem: fs.readFileSync(path.join(root, '.github/coordinator/shu71-activation-public-key.pem'), 'utf8'),
    templates: Object.fromEntries(['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer'].map(n => [n, fs.readFileSync(path.join(root, `.github/coordinator/service/${n}.in`), 'utf8')])) };
  return { options, facts, at };
}
export function runMintControls() {
  const { options, facts, at } = controls();
  const result = derive(options, facts, at);
  assert.deepEqual(validateMint(result, derive(options, facts, at)), result, 'MINT_POSITIVE');
  assert.ok(bytes(result).equals(bytes(derive(options, facts, at + 1))), 'MINT_IDENTICAL_REPEATS');
  assert.equal(Date.parse(result.pkg.expires_at) - Date.parse(result.pkg.created_at), options.lifetimeMs, 'MINT_BOUND');
  assert.equal(result.pkg.signature, '', 'MINT_UNSIGNED');
  const composed = composeApproval({ pkg: result.pkg, revision: facts.revision, activationId: result.pkg.activation_id, checkout: options.checkout,
    tree: facts.tree, binding: facts.binding, anchor: facts.anchor, publicKeyPem: facts.publicKeyPem });
  assert.deepEqual(composed.payload, result.spec.production, 'MINT_COMPOSER_CONSUMES');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-render-control-'));
  try {
    const supervisor = path.join(tmp, 'supervisor.env'), coordinator = path.join(tmp, 'coordinator.env');
    fs.writeFileSync(supervisor, 'SHU_SUPERVISOR_SECRET=' + 'x'.repeat(32) + '\n');
    fs.writeFileSync(coordinator, 'GITHUB_TOKEN=synthetic\nLINEAR_API_TOKEN=synthetic\n');
    const units = render(serviceParameters({ ...result.spec.render, supervisorEnvironmentFile: supervisor, coordinatorEnvironmentFile: coordinator }));
    for (const [name, text] of Object.entries(units)) {
      const normalized = text.replaceAll(supervisor, result.spec.render.supervisorEnvironmentFile).replaceAll(coordinator, result.spec.render.coordinatorEnvironmentFile);
      assert.equal(hash(normalized), result.spec.lifecycle.rendered_sha256[name], `MINT_EXISTING_RENDERER: ${name}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const kill = (name, fn, code) => assert.throws(fn, e => e.code === code, `${name}: ${code}`);
  const outputMutants = [
    ['stale revision', x => x.pkg.coordinator_revision = 'f'.repeat(40), 'MINT_REVISION'],
    ['unknown activation', x => x.pkg.activation_id = 'unknown-activation', 'MINT_ID_UNKNOWN'],
    ['fixture substitution', x => x.pkg.fixtures[0].issue_id = 'SHU-999', 'MINT_FIXTURES'],
    ['lane substitution', x => x.pkg.fixtures[0].lane.id = 'SHU-254', 'MINT_FIXTURES'],
    ['branch substitution', x => x.pkg.reseed.branch = 'coordinator/SHU-254', 'MINT_BRANCH'],
    ['rewritten parent', x => x.pkg.reseed.expected_parent = 'f'.repeat(40), 'MINT_LINEAGE'],
    ['stale seed', x => x.pkg.reseed.expected_seed_head = 'f'.repeat(40), 'MINT_LINEAGE'],
    ['patch digest', x => x.pkg.reseed.patch_sha256 = 'f'.repeat(64), 'MINT_PATCH'],
    ['evidence escape', x => x.pkg.evidence.journal_path += '/../escape', 'MINT_EVIDENCE'],
    ['package signature', x => x.pkg.signature = 'signed', 'MINT_SIGNATURE'],
    ['envelope signature', x => x.pkg.activation.signature = 'signed', 'MINT_SIGNATURE'],
    ['spec disagreement', x => x.spec.lifecycle.activation_id = 'another-activation', 'MINT_DISAGREEMENT'],
    ['driver commands', x => x.spec.render.node = '/bin/sh', 'MINT_COMMANDS'],
    ['nondeterministic timestamp', x => { x.pkg.created_at = new Date(at + 1).toISOString(); x.spec.production.pkg.created_at = x.pkg.created_at; }, 'MINT_NONDETERMINISTIC'],
    ['omitted required field', x => delete x.pkg.evidence, 'MINT_REQUIRED'],
    ['extra output field', x => x.random = 1, 'MINT_NONDETERMINISTIC'],
    ['premature approval', x => x.spec.lifecycle.approval_sha256 = 'f'.repeat(64), 'MINT_NONDETERMINISTIC'],
  ];
  for (const [name, change, code] of outputMutants) { const v = structuredClone(result); change(v); kill(name, () => validateMint(v, result), code); }
  for (const [key, code] of Object.entries({ revision: 'REVISION', fixtures: 'FIXTURES', branch: 'BRANCH', expected_parent: 'LINEAGE', expected_seed_head: 'LINEAGE', patch_sha256: 'PATCH', evidence: 'EVIDENCE', signature: 'SIGNATURE', commands: 'COMMANDS', activation_id: 'ID_UNKNOWN', pkg: 'CALLER_PACKAGE', spec: 'CALLER_SPEC' }))
    kill(`caller ${key}`, () => optionsCheck({ ...options, [key]: '' }), `MINT_${code}`);
  kill('numeric ledger ID', () => validateIdLedger({ ...options.idLedger, ids: [12345678], sha256: hash('12345678\n') }), 'MINT_ID_LEDGER');
  kill('numeric capture time', () => validateIdLedger({ ...options.idLedger, captured_at: 0 }), 'MINT_ID_LEDGER');
  kill('ambiguous capture time', () => validateIdLedger({ ...options.idLedger, captured_at: '2026-09-17' }), 'MINT_ID_LEDGER');
  kill('rolled calendar date', () => validateIdLedger({ ...options.idLedger, captured_at: '2026-02-30T00:00:00Z' }), 'MINT_ID_LEDGER');
  const ambiguous = structuredClone(options.observations); delete ambiguous.sha256; ambiguous.captured_at = '2026-09-17'; ambiguous.sha256 = hash(bytes(ambiguous));
  kill('ambiguous observation time', () => validateObservations(ambiguous), 'MINT_OBSERVATIONS_REQUIRED');
  kill('missing ledger', () => validateIdLedger(null), 'MINT_ID_LEDGER');
  kill('empty ledger', () => validateIdLedger({ ...options.idLedger, ids: [], count: 0 }), 'MINT_ID_LEDGER');
  kill('ledger digest', () => validateIdLedger({ ...options.idLedger, sha256: '0'.repeat(64) }), 'MINT_ID_LEDGER_DIGEST');
  const reused = { ...options.idLedger, ids: ['shu71-mint-00000002'] }; reused.sha256 = hash(reused.ids.join('\n') + '\n');
  kill('reused activation', () => activationId(reused), 'MINT_ID_REUSED');
  kill('missing observations', () => validateObservations(null), 'MINT_OBSERVATIONS_REQUIRED');
  kill('observation digest', () => validateObservations({ ...options.observations, sha256: '0'.repeat(64) }), 'MINT_OBSERVATIONS_DIGEST');
  for (const [name, mutate, code] of [
    ['observed commands', o => o.commands = [], 'MINT_OBSERVATIONS_SHAPE'],
    ['identity', o => o.identity.uid = 0, 'MINT_IDENTITY'],
    ['environment', o => o.environment.supervisor.mode = 511, 'MINT_ENVIRONMENT'],
    ['directories', o => o.directories[0].path = '/tmp', 'MINT_DIRECTORIES'],
    ['dirty prior git', o => o.checkout_before.clean = false, 'MINT_PRIOR_GIT'],
    ['main capture SHA mismatch', o => { o.checkout_before.head_ref = 'refs/heads/main'; o.checkout_before.sha = 'f'.repeat(40); }, 'MINT_PRIOR_GIT'],
    ['detached capture SHA mismatch', o => o.checkout_before.sha = 'f'.repeat(40), 'MINT_PRIOR_GIT'],
    ['capabilities', o => o.capabilities.pop(), 'MINT_CAPABILITIES'],
    ['observed fixture', o => o.issues[0].issue_id = 'SHU-999', 'MINT_ISSUES'],
  ]) { const v = structuredClone(options.observations); delete v.sha256; mutate(v.observations); v.sha256 = hash(bytes(v)); kill(name, () => validateObservations(v), code); }
  kill('expiry exceeds twelve hours', () => derive({ ...options, lifetimeMs: 43200001 }, facts, at), 'MINT_EXPIRY');
  kill('stale ID capture', () => derive({ ...options, idLedger: { ...options.idLedger, captured_at: new Date(at - 60001).toISOString() } }, facts, at), 'MINT_OBSERVATION_STALE');
  kill('stale observation', () => derive(options, facts, at + 60001), 'MINT_OBSERVATION_STALE');
  kill('expired output', () => derive({ ...options, lifetimeMs: 1 }, facts, at + 1), 'MINT_EXPIRED');
  kill('missing option', () => { const v = { ...options }; delete v.windowFile; optionsCheck(v); }, 'MINT_REQUIRED');
  return { outputMutants: outputMutants.map(([name,,code]) => ({ name, assertion: code })), result };
}

// Actual local checkout bytes; remote refs and historical reseed objects are doubled.
// Does not rewrite refs, consume credentials, or contact a host.
export function repositoryControls() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-git-control-'));
  try {
  const repo = path.join(temp, 'checkout');
  createGitAdapter(root)(['clone', '--shared', '--no-checkout', root, repo]);
  const real = createGitAdapter(repo);
  real(['checkout', '--detach', 'HEAD']);
  const revision = real(['rev-parse', 'HEAD']).toString().trim();
  const tree = real(['rev-parse', 'HEAD^{tree}']).toString().trim();
  const remote = `${revision}\trefs/heads/main\n${RETAINED_PARENT}\trefs/heads/coordinator/SHU-140\n6c9c14907189fe3af733969c3d8f3a2c4e21f9b0\trefs/heads/coordinator/SHU-254\n`;
  // Clean disposable checkout: actual bytes and status are checked, not bypassed.
  const boundary = change => () => (args, opts) => {
    const key = args.join(' ');
    const changed = change?.(key);
    if (changed !== undefined) return Buffer.from(changed);
    if (key === 'remote get-url origin') return Buffer.from('https://github.com/BAWES-Universe/studenthub-platform.git');
    if (key.startsWith('rev-parse ') && key.endsWith('coordinator/SHU-140')) return Buffer.from(RETAINED_PARENT);
    if (key.startsWith('rev-parse ') && key.endsWith('coordinator/SHU-254')) return Buffer.from('6c9c14907189fe3af733969c3d8f3a2c4e21f9b0');
    if (args[0] === 'merge-base') return Buffer.from('');
    if (args[0] === 'merge-tree') return Buffer.from(tree);
    if (args[0] === 'ls-tree' && args.includes('-t')) return Buffer.from(Object.entries(SEALED_SEED_BLOBS).map(([name, oid]) => `100644 blob ${oid}\t${name}\0`).join(''));
    if (args[0] === 'ls-remote') return Buffer.from(remote);
    if (key === 'rev-parse refs/remotes/origin/main') return Buffer.from(revision);
    return real(args, opts);
  };
  const good = repositoryFacts(repo, boundary());
  assert.equal(good.revision, revision, 'MINT_ACTUAL_CHECKOUT');
  assert.equal(good.binding.expected_parent, RETAINED_PARENT, 'MINT_ACTUAL_PARENT');
  for (const [name, changed, code] of [
    ['non-current main', key => key.startsWith('ls-remote ') ? remote.replace(revision, 'f'.repeat(40)) : undefined, 'MINT_REVISION'],
    ['rewritten remote lineage', key => key.startsWith('ls-remote ') ? remote.replace(RETAINED_PARENT, 'f'.repeat(40)) : undefined, 'MINT_LINEAGE'],
    ['dirty checkout', key => key.startsWith('status ') ? ' M package.json' : undefined, 'MINT_TREE'],
    ['wrong actual tree', key => key === 'rev-parse HEAD^{tree}' ? 'f'.repeat(40) : undefined, 'MINT_TREE'],
    ['wrong remote', key => key === 'remote get-url origin' ? 'https://example.invalid/repo' : undefined, 'MINT_REMOTE'],
  ]) assert.throws(() => repositoryFacts(repo, boundary(changed)), e => e.code === code, `${name}: ${code}`);
  const tracked = '.github/coordinator/config.json', file = path.join(repo, tracked);
  real(['update-index', '--skip-worktree', tracked]);
  fs.appendFileSync(file, '\n ');
  assert.equal(real(['status', '--porcelain=v1', '--untracked-files=all']).toString(), '', 'MINT_HIDDEN_TREE_STATUS_CLEAN');
  assert.throws(() => repositoryFacts(repo, boundary()), e => e.code === 'MINT_TREE', 'index-hidden tracked bytes: MINT_TREE');
  fs.writeFileSync(file, real(['show', `HEAD:${tracked}`]));
  real(['update-index', '--no-skip-worktree', tracked]);
  runEntrypointControls(repo, boundary()(repo));
  return { revision, binding: good.binding };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

// Exercise the unmodified mint()/main() through the synchronous Git IO boundary.
// Only remote authority and historical objects use the existing repository double.
export function runEntrypointControls(repo, git) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-cli-control-'));
  const spawn = childProcess.spawnSync, mkdir = fs.mkdirSync, oldMask = process.umask(0o022);
  let inside = false;
  childProcess.spawnSync = (command, args, options) => {
    if (inside) return spawn(command, args, options);
    assert.equal(command, 'git', 'MINT_CLI_GIT_ONLY');
    assert.equal(options.cwd, repo, 'MINT_CLI_GIT_CHECKOUT');
    inside = true;
    try {
      const gitOptions = { input: options.input };
      if (options.env.GIT_OBJECT_DIRECTORY) gitOptions.objectDirectory = {
        directory: options.env.GIT_OBJECT_DIRECTORY, alternates: options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      };
      return { status: 0, stdout: git(args.slice(2), gitOptions), stderr: Buffer.alloc(0) };
    }
    finally { inside = false; }
  };
  syncBuiltinESMExports();
  try {
    const { options } = controls();
    const idFile = path.join(temp, 'ids.json'), observationsFile = path.join(temp, 'observations.json'), output = path.join(temp, 'output');
    fs.writeFileSync(idFile, bytes(options.idLedger));
    fs.writeFileSync(observationsFile, bytes(options.observations));
    const argv = ['mint', repo, options.checkout, idFile, observationsFile, output, '3600000', '60000'];
    const kill = (name, fn, code) => assert.throws(fn, e => e.code === code, `${name}: ${code}`);
    for (const action of ['', 'sign', 'compose', '--help']) kill(`CLI action ${action}`, () => main([action, ...argv.slice(1)]), 'MINT_USAGE');
    for (let n = 0; n < 8; n++) kill(`CLI arity ${n}`, () => main(argv.slice(0, n)), 'MINT_USAGE');
    kill('CLI extra argument', () => main([...argv, 'revision']), 'MINT_USAGE');
    for (let n = 1; n <= 5; n++) { const a = [...argv]; a[n] = 'relative'; kill(`CLI path ${n}`, () => main(a), 'MINT_PATH'); }
    for (const n of [6, 7]) for (const value of ['0', '-1', '1.5', '01', '1e3', '43200001']) {
      const a = [...argv]; a[n] = value; kill(`CLI bound ${n} ${value}`, () => main(a), 'MINT_EXPIRY');
    }
    for (const [n, code] of [[3, 'MINT_ID_LEDGER'], [4, 'MINT_OBSERVATIONS_REQUIRED']]) {
      const target = argv[n], saved = fs.readFileSync(target);
      fs.unlinkSync(target);
      kill(`CLI missing input ${n}`, () => main(argv), code);
      fs.writeFileSync(target, '{');
      kill(`CLI malformed input ${n}`, () => main(argv), code);
      fs.unlinkSync(target); fs.mkdirSync(target);
      kill(`CLI directory input ${n}`, () => main(argv), code);
      fs.rmdirSync(target);
      const backing = `${target}.backing`; fs.writeFileSync(backing, saved); fs.symlinkSync(backing, target);
      kill(`CLI symlink input ${n}`, () => main(argv), code);
      fs.unlinkSync(target); fs.writeFileSync(target, saved);
    }
    assert.equal(fs.existsSync(output), false, 'MINT_CLI_REFUSAL_NO_OUTPUT');
    const empty = path.join(temp, 'existing-empty'); fs.mkdirSync(empty);
    kill('CLI existing empty directory', () => main([...argv.slice(0, 5), empty, ...argv.slice(6)]), 'EEXIST');
    const result = main(argv);
    assert.deepEqual(result, { ok: true, signed: false, activation_id: 'shu71-mint-00000002', revision: git(['rev-parse', 'HEAD']).toString().trim() }, 'MINT_CLI_SUCCESS');
    assert.equal(fs.statSync(output).mode & 0o777, 0o700, 'MINT_OUTPUT_DIRECTORY_MODE');
    const names = ['package', 'spec', 'window', 'complete'];
    assert.deepEqual(fs.readdirSync(output).sort(), names.map(n => `${n}.json`).sort(), 'MINT_COMPLETE_FILE_SET');
    const saved = Object.fromEntries(names.map(n => [n, fs.readFileSync(`${output}/${n}.json`)]));
    for (const n of names) assert.equal(fs.statSync(`${output}/${n}.json`).mode & 0o777, 0o600, `MINT_OUTPUT_FILE_MODE: ${n}`);
    assert.deepEqual(JSON.parse(saved.complete), Object.fromEntries(names.slice(0, 3).map(n => [`${n}_sha256`, hash(saved[n])])), 'MINT_COMPLETE_DIGESTS');
    assert.deepEqual(main(['validate', ...argv.slice(1)]), result, 'MINT_CLI_VALIDATE_ROUND_TRIP');
    kill('CLI existing output directory', () => main(argv), 'EEXIST');
    for (const n of names) assert.deepEqual(fs.readFileSync(`${output}/${n}.json`), saved[n], `MINT_EXISTING_OUTPUT_PRESERVED: ${n}`);
    for (const n of names.slice(0, 3)) {
      const file = `${output}/${n}.json`, backing = `${temp}/${n}.backing`;
      fs.renameSync(file, backing); fs.symlinkSync(backing, file);
      kill(`CLI symlink artifact ${n}`, () => main(['validate', ...argv.slice(1)]), 'MINT_REQUIRED');
      fs.unlinkSync(file); fs.renameSync(backing, file);
    }
    const pkg = JSON.parse(saved.package); pkg.signature = 'substitution';
    fs.writeFileSync(`${output}/package.json`, bytes(pkg));
    kill('CLI validate substitution', () => main(['validate', ...argv.slice(1)]), 'MINT_SIGNATURE');
    fs.writeFileSync(`${output}/package.json`, saved.package);
    // Race a file into the freshly created directory, before each exclusive write.
    for (const n of names) {
      const race = path.join(temp, `race-${n}`), target = `${race}/${n}.json`;
      fs.mkdirSync = (dir, opts) => { const value = mkdir(dir, opts); if (dir === race) fs.writeFileSync(target, 'sentinel'); return value; };
      try { kill(`CLI exclusive ${n} write`, () => main([...argv.slice(0, 5), race, ...argv.slice(6)]), 'EEXIST'); }
      finally { fs.mkdirSync = mkdir; }
      assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel', `MINT_EXCLUSIVE_WRITE_PRESERVED: ${n}`);
      if (n !== 'complete') assert.equal(fs.existsSync(`${race}/complete.json`), false, 'MINT_FAILED_WRITE_NO_COMPLETE');
    }
    // The two derivations receive individually valid captures that differ by 1ms.
    // No derive implementation is replaced: aliasing second=first must survive
    // the stimulus and therefore fail the named refusal assertion below.
    const baseline = structuredClone(options.observations);
    options.idLedger.captured_at = new Date(Date.parse(baseline.captured_at) - 2).toISOString();
    let reads = 0;
    const varying = { ...options, repo, get observations() {
      const v = structuredClone(baseline); delete v.sha256;
      v.captured_at = new Date(Date.parse(baseline.captured_at) - (++reads >= 3 ? 1 : 0)).toISOString();
      v.sha256 = hash(bytes(v)); return v;
    } };
    kill('in-process double derive', () => mint(varying), 'MINT_NONDETERMINISTIC');
  } finally {
    childProcess.spawnSync = spawn; fs.mkdirSync = mkdir; syncBuiltinESMExports();
    process.umask(oldMask); fs.rmSync(temp, { recursive: true, force: true });
  }
}
