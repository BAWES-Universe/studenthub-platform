// Reviewed Phase-B composition. The CLI selects this boundary; it accepts no
// provider, callback, executable, URL or credential path from the operator.
import fs from 'node:fs';
import { measureBrokerRuntime, RUNTIME_CODES } from './shu71-runtime.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sign, verify, createPublicKey } from 'node:crypto';
import { canonicalBytes, validateShu71Package } from '../shu71-activation-package.mjs';
import { createReseedAppendIo, verifyReseedCommit } from '../reseed-append-contract.mjs';
import { assertSupervisorLaunchEnvironment } from './units.mjs';
import { ACTIVATION_FILE } from './credential-delivery.mjs';
import { digest, requireActivation as need, openActivationJournal, journalEffect, teardownActivation } from './shu71-journal.mjs';
const ROOT = '/srv/shu/state/shu71-evidence';
const REPO = 'BAWES-Universe/studenthub-platform';
const REMOTE = `https://github.com/${REPO}.git`;
const IDS = ['SHU-140', 'SHU-254'];
const SERVICES = ['shu-coordinator.timer', 'shu-coordinator.service', 'shu-supervisor.service'];
const GATES = SERVICES.filter(n => n.endsWith('.service')).map(n => `/etc/systemd/system/${n}.d/90-shu71.conf`);
export const installedModule = '/usr/local/lib/shu71/coordinator/service/shu71-production.mjs';
export const shu71Boundary = Object.freeze({ fs, uid: () => process.getuid(), now: () => Date.now(),
  run: (file, args, options) => spawnSync(file, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', ...options }),
  fetch: (...args) => fetch(...args), sign: (bytes, key) => sign(null, bytes, key) });

export function createShu71Production(id, b = shu71Boundary) {
  need(/^[A-Za-z0-9_-]{8,64}$/.test(id) && id !== 'shu71abproof0007', 'ACT_ID_OR_EXPIRY_INVALID');
  need(b.uid() === 0, 'ACT_PROCESS_IDENTITY');
  const f = b.fs, C = f.constants, dir = `${ROOT}/${id}`;
  const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
  const command = (exe, args, options = {}) => {
    const r = b.run(exe, args, { env, ...options });
    need(!r.error && r.status === 0, 'ACT_COMMAND_FAILED');
    return String(r.stdout ?? '');
  };
  function privateRead(file, uid = 0, exactMode = null, gid = 0) {
    const fd = f.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const s = f.fstatSync(fd);
      need(s.isFile() && s.nlink === 1 && s.uid === uid && !(s.mode & 0o077) && s.size <= 4 * 1024 * 1024
        && (exactMode === null || s.gid === gid && (s.mode & 0o777) === exactMode), 'ACT_FILE_CUSTODY');
      return f.readFileSync(fd, 'utf8');
    } finally { f.closeSync(fd); }
  }
  function directory(target, mode = 0o700) {
    try { f.mkdirSync(target, { mode }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const s = f.lstatSync(target);
    need(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022), 'ACT_FILE_CUSTODY');
  }
  function atomic(file, value, uid = 0, gid = 0, mode = 0o600) {
    const parent = path.dirname(file), name = `${file}.pending`;
    const parentStat = f.lstatSync(parent);
    need(parentStat.isDirectory() && !parentStat.isSymbolicLink() && parentStat.uid === 0 && !(parentStat.mode & 0o022), 'ACT_FILE_CUSTODY');
    try { f.unlinkSync(name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const fd = f.openSync(name, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
    try { f.writeFileSync(fd, value); f.fchownSync(fd, uid, gid); f.fchmodSync(fd, mode); f.fsyncSync(fd); }
    finally { f.closeSync(fd); }
    f.renameSync(name, file);
    const parentFd = f.openSync(parent, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try { f.fsyncSync(parentFd); } finally { f.closeSync(parentFd); }
  }
  const remove = file => {
    try { f.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const fd = f.openSync(path.dirname(file), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try { f.fsyncSync(fd); } finally { f.closeSync(fd); }
  };
  function credentials() {
    const raw = privateRead('/srv/shu/coordinator.env', 999), result = {};
    for (const key of ['GITHUB_TOKEN', 'LINEAR_API_TOKEN']) {
      const matches = raw.split('\n').filter(line => line.startsWith(`${key}=`));
      need(matches.length === 1, 'ACT_CREDENTIAL_UNAVAILABLE');
      const value = matches[0].slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
      need(value.length > 0 && !/[\s\\$\x00-\x1f]/.test(value), 'ACT_CREDENTIAL_UNAVAILABLE');
      result[key] = value;
    }
    return result;
  }
  async function api(url, options = {}) {
    const result = await b.fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    need(result.ok, 'ACT_API_FAILED');
    const text = await result.text();
    need(Buffer.byteLength(text) <= 1024 * 1024, 'ACT_API_FAILED');
    return JSON.parse(text);
  }
  const github = route => api(`https://api.github.com/repos/${REPO}/${route}`, {
    headers: { Authorization: `Bearer ${credentials().GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  async function linear(query, variables) {
    const result = await api('https://api.linear.app/graphql', { method: 'POST',
      headers: { Authorization: credentials().LINEAR_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    need(!result.errors && result.data, 'ACT_API_FAILED'); return result.data;
  }
  async function issue(t) {
    const { issue: v } = await linear('query Shu71Fixture($id: String!) { issue(id: $id) { id identifier state { id } assignee { id } } }', { id: t.linear_id });
    need(v?.identifier === t.issue_id && v.id === t.linear_id && v.state?.id, 'ACT_WRONG_FIXTURE');
    return { state_id: v.state.id, assignee_id: v.assignee?.id ?? null };
  }
  async function transition(t, target, restoring = false) {
    const current = await issue(t);
    if (JSON.stringify(current) === JSON.stringify(target)) return;
    need(restoring || JSON.stringify(current) === JSON.stringify(t.before), 'ACT_PRIOR_STATE_DRIFT');
    const result = await linear('mutation Shu71Fixture($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
      { id: t.linear_id, input: { stateId: target.state_id, assigneeId: target.assignee_id } });
    need(result.issueUpdate?.success === true && JSON.stringify(await issue(t)) === JSON.stringify(target), 'ACT_PARTIAL_ARMING');
  }
  function git(spec, args, options = {}) {
    // Git runs as the checkout identity, never as root with a safe.directory bypass.
    const gitEnv = { ...env };
    if (options.remote) {
      gitEnv.GIT_CONFIG_COUNT = '1'; gitEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      gitEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${credentials().GITHUB_TOKEN}`).toString('base64')}`;
    }
    return Buffer.from(command('/usr/bin/setpriv', ['--reuid=999', '--regid=999', '--clear-groups', '/usr/bin/git',
      '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', spec.checkout, ...args], { env: gitEnv, input: options.input }));
  }
  const gitText = (spec, args, options) => git(spec, args, options).toString().trim();
  function verifyInstallation(spec) {
    const entries = gitText(spec, ['ls-tree', '-r', '-z', '--full-tree', spec.pkg.coordinator_revision, '--', '.github/coordinator']).split('\0').filter(Boolean);
    let entrypoint = false;
    for (const row of entries) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(\.github\/coordinator\/[a-zA-Z0-9_./-]+)$/.exec(row);
      need(match && !match[3].split('/').includes('..'), 'ACT_CODE_BINDING');
      const relative = match[3].slice('.github/coordinator/'.length);
      if (relative.split('/').includes('test')) continue;
      const file = `/usr/local/lib/shu71/coordinator/${relative}`;
      if (file === installedModule) entrypoint = true;
      let parent = path.dirname(file);
      while (parent !== '/') {
        const st = f.lstatSync(parent);
        need(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && !(st.mode & 0o022), 'ACT_CODE_BINDING');
        parent = path.dirname(parent);
      }
      const fd = f.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const st = f.fstatSync(fd);
        need(st.isFile() && st.nlink === 1 && st.uid === 0 && !(st.mode & 0o022), 'ACT_CODE_BINDING');
        need(gitText(spec, ['hash-object', '--stdin'], { input: f.readFileSync(fd) }) === match[2], 'ACT_CODE_BINDING');
      } finally { f.closeSync(fd); }
    }
    need(entrypoint, 'ACT_CODE_BINDING');
  }
  async function heads(spec, seeded = false) {
    const result = {};
    for (const fixture of spec.pkg.fixtures) {
      const expected = fixture.issue_id === 'SHU-140' && !seeded ? spec.pkg.reseed.expected_parent : fixture.seed_head;
      const ref = `refs/heads/${fixture.branch}`;
      const local = gitText(spec, ['rev-parse', '--verify', ref]);
      const remote = gitText(spec, ['ls-remote', '--refs', REMOTE, ref], { remote: true });
      const readback = await github(`git/ref/heads/${encodeURIComponent(fixture.branch)}`);
      need(local === expected && remote === `${expected}\t${ref}` && readback.object?.sha === expected, 'ACT_REF_BINDING');
      result[fixture.branch] = expected;
    }
    const revision = spec.pkg.coordinator_revision;
    need(gitText(spec, ['rev-parse', 'HEAD']) === revision && gitText(spec, ['rev-parse', 'refs/heads/main']) === revision
      && gitText(spec, ['status', '--porcelain']) === '' && gitText(spec, ['rev-parse', 'HEAD^{tree}']) === spec.tree, 'ACT_REVISION_BINDING');
    need(gitText(spec, ['ls-remote', '--refs', REMOTE, 'refs/heads/main'], { remote: true }) === `${revision}\trefs/heads/main`
      && (await github('git/ref/heads/main')).object?.sha === revision, 'ACT_REVISION_BINDING');
    return result;
  }
  function authority() {
    const doc = JSON.parse(privateRead(`/etc/shu/approvals/${id}.shu71.json`));
    const ownerKey = privateRead('/etc/shu/approvals/shu71-owner.pub');
    need(createPublicKey(ownerKey).asymmetricKeyType === 'ed25519' && verify(null, canonicalBytes(doc.payload, false), ownerKey, Buffer.from(doc.signature, 'base64')), 'ACT_OWNER_APPROVAL');
    const spec = doc.payload;
    need(Object.keys(spec).sort().join() === ['kind', 'checkout', 'tree', 'pkg', 'binding'].sort().join()
      && spec.pkg?.signature === '' && spec.pkg?.activation?.signature === '', 'ACT_OWNER_APPROVAL');
    // Reuse every existing structural/trust-anchor guard before key use. The
    // only expected refusal here is the intentionally absent package signature;
    // the complete signed validation remains mandatory after signing.
    const unsigned = validateShu71Package({ pkg: spec.pkg,
      anchor: JSON.parse(f.readFileSync(new URL('../shu71-trust-anchor.json', import.meta.url), 'utf8')),
      revision: spec.pkg.coordinator_revision, mainRevision: spec.pkg.coordinator_revision,
      phase: 'revocation', now: new Date(b.now()) });
    need(unsigned.code === 'ACT_FORGED_ENVELOPE', 'ACT_OWNER_APPROVAL');
    need(spec.kind === 'shu71-production-v1' && spec.pkg?.activation_id === id && /^\/[a-zA-Z0-9_/-]+$/.test(spec.checkout)
      && !spec.checkout.split('/').includes('..') && /^[a-f0-9]{40}$/.test(spec.tree)
      && spec.pkg.evidence.journal_path === `${dir}/journal.jsonl` && spec.pkg.evidence.archive_path === `${dir}/activation.json`, 'ACT_OWNER_APPROVAL');
    need(spec.binding?.approvedExecutionRevision === spec.pkg.coordinator_revision && spec.binding.branch === spec.pkg.reseed.branch
      && ['expected_parent', 'expected_seed_head', 'patch_sha256'].every(k => spec.binding[k] === spec.pkg.reseed[k]), 'ACT_OWNER_APPROVAL');
    return spec;
  }
  async function execute(action) {
    need(['run', 'resume', 'revoke', 'expire'].includes(action), 'ACT_COMMAND_INVALID');
    directory(ROOT); directory(dir);
    let spec, journal, recovered = false;
    try { spec = JSON.parse(privateRead(`${dir}/custody.json`)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!spec) {
      spec = authority();
      // Independent cleanup authority precedes the journal and every mutation.
      atomic(`${dir}/custody.json`, JSON.stringify(spec));
    }
    need(spec.pkg?.activation_id === id, 'ACT_OWNER_APPROVAL');
    try {
      try { privateRead(`${dir}/recovery.jsonl`); recovered = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      journal = openActivationJournal(dir, f, recovered ? 'recovery.jsonl' : 'journal.jsonl');
    }
    catch {
      // Preserve a damaged log byte-for-byte. Custody is enough to revoke the
      // exact episode, but never to resume forward signing or activation.
      recovered = true;
      try { journal = openActivationJournal(dir, f, 'recovery.jsonl'); }
      catch { journal = { entries: [], append() { throw new Error('ACT_EVIDENCE_WRITE_FAILED'); }, close() {} }; }
    }
    journal.recovered = recovered;
    const initial = journal.entries.find(e => e.event === 'APPROVED');
    try {
      if (!initial) journal.append({ event: 'APPROVED', spec });
      let active;
      try { active = JSON.parse(privateRead(`${ROOT}/active.json`)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (journal.entries.some(e => e.event === 'TEARDOWN_COMPLETE')) {
        // A successor owns the shared gates. This receipt is historical only.
        if (active && active.activation_id !== id) return { ok: true, state: 'REVOKED', activation_id: id, receipt_scope: 'retired_episode', physical_teardown_observed: false };
        try { observeTeardown(); }
        catch { return { ok: false, state: 'HALT', code: 'ACT_TEARDOWN_DRIFT' }; }
        if (active) remove(`${ROOT}/active.json`);
        return { ok: true, state: 'REVOKED', activation_id: id, physical_teardown_observed: true };
      }
      if (active && active.activation_id !== id) return { ok: false, state: 'HALT', code: 'ACT_ACTIVATION_CONFLICT' };
      if (!active) atomic(`${ROOT}/active.json`, JSON.stringify({ activation_id: id }));
      if (recovered) {
        journal.recovered = true;
        return await cleanup(spec, journal, 'recovery', action === 'expire');
      }
      const expired = b.now() >= Date.parse(spec.pkg.expires_at);
      const teardownStarted = journal.entries.some(e => ['REVOKE_REQUESTED', 'AUTHORIZATION_EXPIRED', 'TEARDOWN_INCOMPLETE', 'TEARDOWN_COMPLETE'].includes(e.event));
      if (action === 'expire' && !expired && !teardownStarted) return { ok: true, state: 'NOT_EXPIRED' };
      if (action === 'revoke' || expired || teardownStarted || action === 'resume' && journal.entries.some(e => e.event === 'ARMED')) return await cleanup(spec, journal, expired ? 'expiry' : 'revoke', action === 'expire');
      journal.append({ event: 'RUN_ATTEMPT_STARTED' });
      need(b.now() >= Date.parse(spec.pkg.created_at) && !expired, 'ACT_ID_OR_EXPIRY_INVALID');
      // Lifecycle renders User/Group from spec.lifecycle.identity and verifies
      // the account's primary group. Resolve that installed identity, not uid=gid.
      const user = command('/usr/bin/systemctl', ['show', '--property=User', '--value', 'shu-supervisor.service']).trim();
      const group = command('/usr/bin/systemctl', ['show', '--property=Group', '--value', 'shu-supervisor.service']).trim();
      need(/^[a-z_][a-z0-9_-]*$/.test(user) && /^[a-z_][a-z0-9_-]*$/.test(group), 'ACT_FILE_CUSTODY');
      const uid = Number(command('/usr/bin/id', ['-u', user]).trim());
      const gid = Number(command('/usr/bin/id', ['-g', user]).trim());
      need(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0
        && command('/usr/bin/id', ['-gn', user]).trim() === group, 'ACT_FILE_CUSTODY');
      assertSupervisorLaunchEnvironment(privateRead('/etc/shu/supervisor.env', 0, 0o600), privateRead('/srv/shu/coordinator.env', uid, 0o600, gid));
      verifyInstallation(spec);
      const step = (name, fn, repeat = false) => journalEffect(journal, name, async () => {
        need(b.now() < Date.parse(spec.pkg.expires_at), 'ACT_ID_OR_EXPIRY_INVALID'); await fn();
      }, repeat);
      await step('binding', async () => {
        await heads(spec);
        for (const t of spec.pkg.issue_transitions) need(JSON.stringify(await issue(t)) === JSON.stringify(t.before), 'ACT_PRIOR_STATE_DRIFT');
      });
      await step('sign', async () => {
        // If completion is ambiguous, never consume the key again. A durable
        // signed package is adoptable; otherwise fail into narrow teardown.
        let signed;
        try { signed = JSON.parse(privateRead(`${dir}/signed-package.json`)); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (!signed) {
          need(!journal.entries.some(e => e.event === 'SIGNING_STARTED'), 'ACT_SIGNING_AMBIGUOUS');
          journal.append({ event: 'SIGNING_STARTED' });
          const key = privateRead('/etc/shu/keys/shu71-activation-ed25519.pem');
          signed = structuredClone(spec.pkg);
          signed.activation.signature = b.sign(canonicalBytes(signed.activation), key).toString('base64');
          signed.signature = b.sign(canonicalBytes(signed), key).toString('base64');
          atomic(`${dir}/signed-package.json`, JSON.stringify(signed));
        }
        need(digest(canonicalBytes({ ...signed, activation: { ...signed.activation, signature: '' }, signature: '' }))
          === digest(canonicalBytes({ ...spec.pkg, activation: { ...spec.pkg.activation, signature: '' }, signature: '' })), 'ACT_OWNER_APPROVAL');
      });
      const pkg = JSON.parse(privateRead(`${dir}/signed-package.json`));
      // Validate every package guard before the first fixture/ref mutation.
      const checked = validateShu71Package({ pkg, anchor: JSON.parse(f.readFileSync(new URL('../shu71-trust-anchor.json', import.meta.url), 'utf8')),
        revision: pkg.coordinator_revision, mainRevision: pkg.coordinator_revision, now: new Date(b.now()),
        heads: Object.fromEntries(pkg.fixtures.map(v => [v.branch, v.issue_id === 'SHU-140' ? pkg.reseed.expected_parent : v.seed_head])),
        issues: pkg.fixtures.map(v => ({ issue_id: v.issue_id, linear_id: v.linear_id })) });
      need(checked.ok, 'ACT_PACKAGE_VALIDATION');
      await step('expiry-watch', () => installExpiry(spec));
      await step('local-reseed', async () => {
        const adapter = createReseedAppendIo({ git: (args, options) => git(spec, args, options), binding: spec.binding });
        const local = gitText(spec, ['rev-parse', `refs/heads/${pkg.reseed.branch}`]);
        if (local === pkg.reseed.expected_seed_head) adapter.observeReseed(pkg.reseed);
        else adapter.appendReseed(pkg.reseed);
      });
      await step('remote-push', async () => {
        const ref = `refs/heads/${pkg.reseed.branch}`, old = pkg.reseed.expected_parent, next = pkg.reseed.expected_seed_head;
        verifyReseedCommit({ git: (args, options) => git(spec, args, options), binding: spec.binding, oid: next });
        const observed = gitText(spec, ['ls-remote', '--refs', REMOTE, ref], { remote: true });
        if (observed !== `${next}\t${ref}`) {
          need(observed === `${old}\t${ref}`, 'ACT_REF_BINDING');
          git(spec, ['merge-base', '--is-ancestor', old, next]);
          git(spec, ['push', '--porcelain', `--force-with-lease=${ref}:${old}`, REMOTE, `${next}:${ref}`], { remote: true });
        }
        await heads(spec, true);
        const comparison = await github(`compare/${old}...${next}`);
        need(comparison.status === 'ahead' && comparison.merge_base_commit?.sha === old, 'ACT_REMOTE_ANCESTRY');
      });
      await step('evidence-broker', () => {
        atomic('/etc/systemd/system/shu71-evidence.service', renderEvidenceBroker(), 0, 0, 0o644);
        command('/usr/bin/systemctl', ['daemon-reload']);
        command('/usr/bin/systemctl', ['start', 'shu71-evidence.service']);
      });
      await step('broker-runtime', async () => {
        journal.append({ event: 'BROKER_RUNTIME_CHECK_STARTED' });
        // Type=simple can return from start before bind(). Retry absence only;
        // custody, mode, identity and measurement failures are immediate refusals.
        for (let attempt = 0; ; attempt++) {
          need(b.now() < Date.parse(spec.pkg.expires_at), 'ACT_ID_OR_EXPIRY_INVALID');
          try {
            const runtime = measureBrokerRuntime(b, env);
            journal.append({ event: 'BROKER_RUNTIME_MEASURED', ...runtime });
            atomic(`${dir}/broker-runtime.json`, JSON.stringify(runtime));
            break;
          } catch (e) {
            if (!['ACT_RUNTIME_DIRECTORY_MISSING', 'ACT_RUNTIME_SOCKET_MISSING'].includes(e.code) || attempt >= 19) throw e;
            await (b.runtimeWait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(50);
          }
        }
      }, true);
      for (const t of pkg.issue_transitions) await step(`ready-${t.issue_id}`, () => transition(t, t.ready));
      await step('activation', () => atomic(ACTIVATION_FILE, JSON.stringify(pkg.activation), 0, 999, 0o640));
      await step('gate', () => {
        for (const file of GATES) { directory(path.dirname(file), 0o755); atomic(file, '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 0, 0, 0o644); }
        command('/usr/bin/systemctl', ['daemon-reload']);
        command('/usr/bin/systemctl', ['restart', 'shu-supervisor.service']);
        command('/usr/bin/systemctl', ['start', 'shu-coordinator.timer']);
      });
      journal.append({ event: 'ARMED', authorization_expires_at: pkg.expires_at, teardown_complete: false });
      return { ok: true, state: 'ARMED', activation_id: id };
    } catch (error) {
      const code = [...RUNTIME_CODES, 'SHU251_ENV_CROSSED', 'SHU71_SUPERVISOR_ENV_REQUIRED', 'ACT_ID_OR_EXPIRY_INVALID', 'ACT_SIGNING_AMBIGUOUS', 'ACT_REF_BINDING', 'ACT_REVISION_BINDING',
        'ACT_PRIOR_STATE_DRIFT', 'ACT_PACKAGE_VALIDATION', 'ACT_COMMAND_FAILED', 'ACT_REMOTE_ANCESTRY',
        'ACT_CODE_BINDING', 'ACT_OWNER_APPROVAL', 'ACT_FILE_CUSTODY', 'ACT_API_FAILED', 'ACT_WRONG_FIXTURE', 'ACT_PARTIAL_ARMING'].includes(error?.code)
        ? error.code : 'ACT_PRODUCTION_FAILED';
      try { journal.append({ event: 'HALTED', code }); } catch { /* safety effects still run */ }
      if (spec) return { ok: false, state: 'HALT', code, teardown: await cleanup(spec, journal, 'failure', action === 'expire') };
      return { ok: false, state: 'HALT', code: 'ACT_OWNER_APPROVAL' };
    } finally { journal.close(); }
  }
  function installExpiry() {
    // Periodic + boot activation survives CLI death and reboot. Expiry time is
    // read from the authenticated durable snapshot, never from a timer argument.
    const service = `[Unit]\nDescription=SHU71 durable expiry ${id}\n[Service]\nType=oneshot\nUser=root\nRestart=on-failure\nRestartSec=1s\nExecStart=/usr/bin/node ${installedModule} expire ${id}\n`;
    const timer = `[Unit]\nDescription=SHU71 expiry wake ${id}\n[Timer]\nOnBootSec=1s\nOnUnitActiveSec=1s\nAccuracySec=1s\nUnit=shu71-expiry-${id}.service\n[Install]\nWantedBy=timers.target\n`;
    atomic(`/etc/systemd/system/shu71-expiry-${id}.service`, service, 0, 0, 0o644);
    atomic(`/etc/systemd/system/shu71-expiry-${id}.timer`, timer, 0, 0, 0o644);
    command('/usr/bin/systemctl', ['daemon-reload']);
    command('/usr/bin/systemctl', ['enable', '--now', `shu71-expiry-${id}.timer`]);
  }
  function cleanupWorkspaces(spec, journal) {
    need(journal.entries.some(e => e.event === 'DONE' && e.step === 'teardown:workers'), 'ACT_FIXTURE_CLEANUP');
    const state = '/srv/shu/state/workspaces', root = '/srv/shu/worktrees';
    const rootStat = f.lstatSync(root);
    need(rootStat.isDirectory() && !rootStat.isSymbolicLink() && (rootStat.mode & 0o7777) === 0o3770, 'ACT_FIXTURE_CLEANUP');
    // Authority sidecars are retained. Only episode-bound attempt directories
    // are removable, and a durable inode receipt precedes recursive removal.
    for (const name of f.readdirSync(state)) {
      if (!/^[a-f0-9-]{36}\.workspace\.json$/.test(name)) continue;
      const record = JSON.parse(privateRead(`${state}/${name}`, 999));
      if (record.episode_id !== id) continue;
      need(IDS.includes(record.issue_id) && record.repo === REPO && record.branch === `coordinator/${record.issue_id}`
        && name === `${record.attempt_id}.workspace.json`, 'ACT_FIXTURE_CLEANUP');
      const target = `${root}/${record.attempt_id}`;
      let st;
      try { st = f.lstatSync(target); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      need(st.isDirectory() && !st.isSymbolicLink() && [999, 995, 994].includes(st.uid), 'ACT_FIXTURE_CLEANUP');
      const earlier = journal.entries.find(e => e.event === 'FIXTURE_REMOVE_INTENT' && e.attempt_id === record.attempt_id);
      need(!earlier || earlier.dev === st.dev && earlier.ino === st.ino && earlier.uid === st.uid, 'ACT_FIXTURE_CLEANUP');
      if (!earlier) journal.append({ event: 'FIXTURE_REMOVE_INTENT', attempt_id: record.attempt_id, dev: st.dev, ino: st.ino, uid: st.uid });
      // The service cgroup has already been killed and admission stopped. rm
      // does not follow symlinks; mounted filesystems are refused below.
      const walk = p => {
        const s = f.lstatSync(p);
        need(s.dev === rootStat.dev, 'ACT_FIXTURE_CLEANUP');
        if (s.isDirectory() && !s.isSymbolicLink()) for (const n of f.readdirSync(p)) walk(path.join(p, n));
      };
      walk(target);
      f.rmSync(target, { recursive: true, force: false });
    }
  }
  function observeGateFiles() {
    for (const file of GATES) {
      const fd = f.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const st = f.fstatSync(fd);
        need(st.isFile() && st.uid === 0 && st.nlink === 1 && !(st.mode & 0o022)
          && f.readFileSync(fd, 'utf8') === '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 'ACT_TEARDOWN_DRIFT');
      } finally { f.closeSync(fd); }
    }
  }
  function observeTeardown() {
    observeGateFiles();
    let absent = false;
    try { f.lstatSync(ACTIVATION_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; absent = true; }
    need(absent, 'ACT_TEARDOWN_DRIFT');
    for (const name of [...SERVICES, 'shu71-evidence.service']) {
      need(['inactive', 'failed'].includes(command('/usr/bin/systemctl', ['show', '--property=ActiveState', '--value', name]).trim()), 'ACT_TEARDOWN_DRIFT');
    }
  }
  async function cleanup(spec, journal, reason, automatic = false) {
    // Separate from either journal so damaged-log recovery cannot reset the
    // automatic budget. Reserve durably before ordinary effects, including crash
    // retries; counter failure has its own independent gate-disarm fallback.
    // Explicit resume/revoke remain available without resetting this budget.
    let exhausted = false;
    let evidenceUnavailable = false;
    if (automatic) {
      try {
        let attempts = 0;
        try { attempts = JSON.parse(privateRead(`${dir}/automatic-teardown.json`)).attempts; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        need(Number.isSafeInteger(attempts) && attempts >= 0 && attempts <= 32, 'ACT_RETRY_BUDGET_INVALID');
        if (attempts >= 32) exhausted = true;
        else atomic(`${dir}/automatic-teardown.json`, JSON.stringify({ attempts: attempts + 1 }));
        if (exhausted === true) {
          // A counter alone cannot prove that the allowance was spent. Missing
          // evidence (including damaged-log recovery) takes the safety fallback,
          // never permission to reset the counter or replay ordinary effects.
          evidenceUnavailable = journal.recovered;
          const reservations = journal.entries.filter(e => e.event === 'AUTOMATIC_TEARDOWN_RESERVED');
          need(reservations.length === 32 && reservations.every((e, i) => e.attempts === i + 1), 'ACT_RETRY_BUDGET_INVALID');
        } else journal.append({ event: 'AUTOMATIC_TEARDOWN_RESERVED', attempts: attempts + 1 });
      } catch (error) {
        // Counter storage must never veto the independent disk gate disarm.
        // Do not rely on journal availability or issue commands without a reservation.
        const failures = [];
        for (const file of GATES) {
          try { directory(path.dirname(file), 0o755); atomic(file, '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 0, 0, 0o644); }
          catch { failures.push('ACT_TEARDOWN_GATE'); }
        }
        try { remove(ACTIVATION_FILE); }
        catch { failures.push('ACT_TEARDOWN_ACTIVATION'); }
        return { ok: false, state: 'HALT', code: evidenceUnavailable ? 'ACT_RETRY_BUDGET_EXHAUSTED' : 'ACT_RETRY_BUDGET_UNAVAILABLE',
          budget_error: error.code === 'ACT_RETRY_BUDGET_INVALID' || error instanceof SyntaxError ? 'ACT_RETRY_BUDGET_INVALID' : 'ACT_RETRY_BUDGET_UNAVAILABLE',
          failures, operator_action: 'resume_or_revoke' };
      }
    }

    const effects = [
      ['gate', () => { for (const file of GATES) { directory(path.dirname(file), 0o755); atomic(file, '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 0, 0, 0o644); } }],
      ['activation', () => remove(ACTIVATION_FILE)],
      ['workers', () => command('/usr/bin/systemctl', ['kill', '--kill-whom=all', '--signal=SIGKILL', 'shu-supervisor.service'])],
      ...SERVICES.map(name => [`stop-${name.replaceAll('.', '-')}`, () => {
        command('/usr/bin/systemctl', ['stop', name]);
        need(['inactive', 'failed'].includes(command('/usr/bin/systemctl', ['show', '--property=ActiveState', '--value', name]).trim()), 'ACT_SERVICE_CLEANUP');
      }]),
      ['reload', () => command('/usr/bin/systemctl', ['daemon-reload'])],
      ...IDS.map(id => [`restore-${id.toLowerCase()}`, async () => {
        const t = spec.pkg.issue_transitions.find(t => t.issue_id === id);
        need(t, 'ACT_WRONG_FIXTURE');
        if (journal.recovered || journal.entries.some(e => e.event === 'INTENT' && e.step === `ready-${id}`)) await transition(t, t.restore, true);
      }]),
      ['fixtures', () => cleanupWorkspaces(spec, journal)],
      ['evidence-broker', () => command('/usr/bin/systemctl', ['stop', 'shu71-evidence.service'])],
      ['archive', () => atomic(`${dir}/activation.json`, JSON.stringify({ activation_id: id, pkg: spec.pkg, retained: true, broker_runtime: (() => { const last = journal.entries.findLast(e => ['RUN_ATTEMPT_STARTED', 'BROKER_RUNTIME_CHECK_STARTED', 'BROKER_RUNTIME_MEASURED'].includes(e.event)); if (last?.event !== 'BROKER_RUNTIME_MEASURED') return null; const { rows, coordinator_access, kernel_connect } = last; return { rows, coordinator_access, kernel_connect }; })() }))],
      ['manifest', () => atomic(`${dir}/manifest.json`, JSON.stringify({ activation_id: id,
        journal_sha256: digest(JSON.stringify(journal.entries)), authorization_expired: reason === 'expiry' }))],
    ];
    // Observation must run on every retry, even when earlier DONE rows exist.
    effects.push(['observation', observeTeardown]);
    // Retire the retry mechanism only after every effect and observation passed.
    effects.push(
      ['expiry-timer', () => {
        need(journal.entries.filter(e => e.event === 'INTENT' && e.step.startsWith('teardown:') && e.step !== 'teardown:expiry-timer' && e.step !== 'teardown:manifest')
          .every(e => journal.entries.some(v => v.event === 'DONE' && v.step === e.step)), 'ACT_CLEANUP_FAILED');
        observeTeardown();
        command('/usr/bin/systemctl', ['disable', '--now', `shu71-expiry-${id}.timer`]);
      }],
    );
    if (exhausted) {
      const refusal = { ok: false, state: 'HALT', code: 'ACT_RETRY_BUDGET_EXHAUSTED', operator_action: 'resume_or_revoke' };
      // No repair after exhaustion. Reap a physically safe episode only when
      // all non-observational work is already durably complete. Check files
      // first so an armed gate still costs zero commands or writes per wake.
      try {
        observeGateFiles();
        need(effects.filter(([step]) => !['observation', 'expiry-timer'].includes(step))
          .every(([step]) => journal.entries.some(e => e.event === 'DONE' && e.step === `teardown:${step}`)), 'ACT_CLEANUP_FAILED');
        JSON.parse(privateRead(`${dir}/automatic-teardown.json`));
        if (journal.entries.some(e => e.event === 'SETTLEMENT_STARTED')) return refusal;
        observeTeardown();
        // The journal, not a plantable counter boolean, consumes this allowance.
        // Reserve there first: interruption at either durable write cannot reuse it.
        journal.append({ event: 'SETTLEMENT_STARTED' });
        // One durable settlement allowance; interruption requires explicit recovery.
        atomic(`${dir}/automatic-teardown.json`, JSON.stringify({ attempts: 32, settlement_started: true }));
      } catch { return refusal; }
      const result = await teardownActivation(journal, effects.filter(([step]) => ['observation', 'expiry-timer'].includes(step)), reason);
      if (result.ok) remove(`${ROOT}/active.json`);
      return result;
    }
    const result = await teardownActivation(journal, effects, reason);
    if (result.ok) {
      // A retired episode's periodic wake must never tear down its successor.
      remove(`${ROOT}/active.json`);

    }
    return result;
  }
  return Object.freeze({ execute });
}

export function renderEvidenceBroker() {
  return `[Unit]\nDescription=SHU71 bounded fixture evidence\n[Service]\nUser=shu71-evidence\nGroup=shu-workspace\nEnvironmentFile=/srv/shu/coordinator.env\nRuntimeDirectory=shu71-evidence\nRuntimeDirectoryMode=0750\nUMask=0007\nExecStart=/usr/bin/node /usr/local/lib/shu71/coordinator/service/fixture-evidence-broker.mjs\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\nRestart=on-failure\n`;
}

// A kernel lock survives exceptions and is automatically released on death.
// No JS API can replace the production boundary through CLI input.
export async function shu71Cli(argv) {
  const [action, id] = argv;
  need(argv.length === 2 && ['run', 'resume', 'revoke', 'expire'].includes(action) && /^[A-Za-z0-9_-]{8,64}$/.test(id ?? ''), 'ACT_COMMAND_INVALID');
  return createShu71Production(id).execute(action);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (process.env.SHU71_LOCKED !== '1') {
      need(process.getuid() === 0, 'ACT_PROCESS_IDENTITY');
      const r = spawnSync('/usr/bin/flock', ['--nonblock', '/run/lock/shu71-production.lock', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1', '/usr/bin/node', installedModule, ...argv], { stdio: 'inherit' });
      process.exitCode = r.status ?? 1;
    } else {
      const result = await shu71Cli(argv); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : 1;
    }
  } catch { process.stdout.write('{"ok":false,"code":"ACT_PRODUCTION_FAILED"}\n'); process.exitCode = 1; }
}
