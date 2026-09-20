import fs from 'node:fs';
import { secretText, coordinatorText } from './shu71-supervisor-environment-fixture.mjs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { sign } from 'node:crypto';
import { harness } from '../../test/fixture/shu71-package.mjs';
import { canonicalBytes } from '../../shu71-activation-package.mjs';
import { serializeReseedCommit, SEALED_SEED_BLOBS } from '../../reseed-append-contract.mjs';
import { digest } from '../shu71-journal.mjs';

// All paths map into this disposable tree. Every command and API is interpreted
// here. No production command, host service, API or signing key is reachable.
export function productionFixture(t, keys, signingPath = '/etc/shu/keys/shu71-activation-ed25519.pem', host = null) {
  const h = harness(keys), pkg = h.context.pkg, id = pkg.activation_id;
  pkg.reseed.patch_sha256 = digest(''); pkg.signature = ''; pkg.activation.signature = '';
  const tree = 'd'.repeat(40);
  const spec = { kind: 'shu71-production-v1', checkout: '/reviewed/repo', tree: 'c'.repeat(40), pkg,
    binding: { ...pkg.reseed, approvedExecutionRevision: pkg.coordinator_revision, tree, manifest_hex: '' } };
  const root = host?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-production-'));
  fs.chmodSync(root, 0o755); // Model the host / traversal mode inside the disposable tree.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = { user: 'shu-coordinator', group: 'shu-coordinator', uid: 999, gid: 982 };
  const owners = host?.owners ?? new Map(), handles = new Map(), events = [], faults = {};
  const logical = p => typeof p === 'number' ? handles.get(p) : p;
  const resolve = p => typeof p === 'number' ? p : root + p;
  const stat = (p, value) => new Proxy(value, { get(target, key) {
    if (key === 'isSocket' && logical(p) === '/run/shu71-evidence/fixture.sock') return () => true;
    if (key === 'uid') return owners.get(logical(p))?.[0] ?? 0;
    if (key === 'gid') return owners.get(logical(p))?.[1] ?? 0;
    const v = target[key]; return typeof v === 'function' ? v.bind(target) : v;
  } });
  const effect = (name, perform) => {
    events.push(name);
    if (faults.before?.(name)) throw new Error('SECRET_POISON');
    const value = perform();
    if (faults.after?.(name)) throw new Error('SECRET_POISON');
    return value;
  };
  const f = {
    constants: fs.constants,
    lstatSync: p => stat(p, fs.lstatSync(resolve(p))),
    fstatSync: p => stat(p, fs.fstatSync(p)),
    mkdirSync: (p, opts) => effect(`mkdir:${p}`, () => fs.mkdirSync(resolve(p), opts)),
    openSync(p, flags, mode) { const fd = fs.openSync(resolve(p), flags, mode); handles.set(fd, p); return fd; },
    closeSync(fd) { fs.closeSync(fd); handles.delete(fd); },
    readFileSync(p, encoding) {
      if (!host && p === '/etc/passwd') return `shu-coordinator:x:999:982::/nonexistent:/usr/sbin/nologin\n`;
      if (!host && p === '/etc/group') return `shu-coordinator:x:982:\nshu-workspace:x:980:shu-coordinator\nsystemd-journal:x:999:\n`;
      if (p instanceof URL) {
        if (p.pathname.endsWith('shu71-trust-anchor.json')) return JSON.stringify(h.context.anchor);
        return fs.readFileSync(p, encoding);
      }
      return fs.readFileSync(resolve(p), encoding);
    },
    writeFileSync: (p, data) => effect(`write:${logical(p)}`, () => fs.writeFileSync(resolve(p), data)),
    // Durability is a syscall boundary double: record/inject it without flushing
    // the developer machine's disk hundreds of times in the crash matrix.
    fsyncSync: fd => effect(`fsync:${logical(fd)}`, () => {}),
    fchownSync: (fd, uid, gid) => owners.set(logical(fd), [uid, gid]),
    fchmodSync: (fd, mode) => fs.fchmodSync(fd, mode),
    renameSync(a, b) { return effect(`rename:${b}`, () => { fs.renameSync(resolve(a), resolve(b)); owners.set(b, owners.get(a) ?? [0, 0]); }); },
    unlinkSync: p => effect(`unlink:${p}`, () => fs.unlinkSync(resolve(p))),
    readdirSync: p => fs.readdirSync(resolve(p)),
    rmSync: (p, opts) => effect(`remove:${p}`, () => fs.rmSync(resolve(p), opts)),
  };
  // Model fixture custody explicitly: mkdir/write creation modes are filtered
  // by the caller's umask. Only newly created ancestors receive the default,
  // so deliberate permission damage in refusal controls remains observable.
  function directory(p) {
    if (fs.existsSync(resolve(p))) return;
    directory(path.dirname(p));
    fs.mkdirSync(resolve(p), { mode: 0o755 });
    fs.chmodSync(resolve(p), 0o755);
  }
  function write(p, value, mode = 0o600, uid = 0, gid = uid === identity.uid ? identity.gid : uid) {
    directory(path.dirname(p));
    fs.writeFileSync(resolve(p), value, { mode });
    fs.chmodSync(resolve(p), mode); owners.set(p, [uid, gid]);
  }
  for (const p of ['/srv/shu/state', '/srv/shu/state/workspaces', '/etc/systemd/system', '/srv/shu/worktrees']) directory(p);
  for (const p of ['/srv/shu/state/shu71-evidence', `/srv/shu/state/shu71-evidence/${id}`]) { directory(p); fs.chmodSync(resolve(p), 0o700); }
  fs.chmodSync(resolve('/srv/shu/worktrees'), 0o3770);
  owners.set('/srv/shu/worktrees', [999, 980]);
  for (const p of ['/srv/shu/state', '/srv/shu/state/workspaces']) { fs.chmodSync(resolve(p), 0o700); owners.set(p, [999, 982]); }
  write(`/etc/shu/approvals/${id}.shu71.json`, JSON.stringify({ payload: spec, signature: sign(null, canonicalBytes(spec, false), keys.privateKey).toString('base64') }));
  write('/etc/shu/approvals/shu71-owner.pub', keys.publicKey.export({ type: 'spki', format: 'pem' }));
  write(signingPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  write('/usr/local/lib/shu71/coordinator/service/shu71-production.mjs', 'reviewed artifact', 0o644);
  write('/etc/shu/supervisor.env', secretText());
  write('/srv/shu/coordinator.env', coordinatorText(), 0o600, 999);
  let now = +h.context.now, local = pkg.reseed.expected_parent, remote = local;
  let signatures = 0;
  const active = new Map(), enabled = new Set(), started = new Set(), loaded = new Set();
  const systemd = { killRequiresProcesses: false, unitFileViewCached: false };
  // Enablement is a durable INSTALL SYMLINK in <target>.wants/, not a flag on
  // the unit file. `systemctl enable` creates it, `disable` removes it, and
  // removing the unit file does NOT take it with it - which is why a unit whose
  // own file is gone can still answer `enabled` or `disabled` rather than the
  // empty string. A model that derives enablement from the unit file alone
  // cannot represent that host state at all, so it is modelled as a real
  // symlink in a real directory here, independently of `enabled`, and
  // `daemon-reload` rebuilds the loaded view without touching it.
  const WANTS_DIR = '/etc/systemd/system/timers.target.wants';
  const wantsPath = unit => `${WANTS_DIR}/${unit}`;
  const wants = {
    has(unit) { try { fs.lstatSync(resolve(wantsPath(unit))); return true; } catch { return false; } },
    add(unit) {
      directory(WANTS_DIR);
      if (!this.has(unit)) fs.symlinkSync(`/etc/systemd/system/${unit}`, resolve(wantsPath(unit)));
    },
    delete(unit) { try { fs.unlinkSync(resolve(wantsPath(unit))); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
  };
  // systemd mints a fresh 128-bit InvocationID every time a unit STARTS, exports
  // that start's own id to its own processes as INVOCATION_ID, and keeps
  // ANSWERING with it after the unit exits - so an idle unit's id is STALE
  // rather than empty, and only a unit that never ran has none at all. Modelled
  // as first-class per-unit state rather than as a per-argv reply: a unit that
  // is measurably live has an id whether it was started through `run` or placed
  // directly in `active`, a restart mints a new one, a stop keeps the old one,
  // and `h.unitInvocations` lets a control pin or read an exact value.
  const invocations = new Map();
  let minted = 0;
  const mintInvocation = unit => invocations.set(unit, (++minted).toString(16).padStart(32, '0'));
  const invocationOf = unit => {
    if (['active', 'activating'].includes(active.get(unit) ?? 'inactive') && !invocations.has(unit)) mintInvocation(unit);
    return invocations.get(unit) ?? '';
  };
  // This process's own systemd invocation, exactly as INVOCATION_ID carries it
  // into a unit's ExecStart. `null` models an operator CLI run, outside systemd
  // entirely, where the variable is absent and nothing is ever excluded.
  const selfInvocation = { id: null };
  const boundary = { fs: f, runtimeWait: async () => {}, uid: () => 0, now: () => now,
    invocationId: () => selfInvocation.id,
    sign(bytes, key) { signatures++; return effect('sign', () => sign(null, bytes, key)); },
    run(exe, argv, options) {
      let output = '';
      effect(`command:${exe}:${argv.join(' ')}`, () => {
        if (exe === '/usr/bin/getent') {
          if (argv.join(' ') === 'passwd shu71-evidence') output = 'shu71-evidence:x:100:100::/nonexistent:/usr/sbin/nologin';
          else if (argv.join(' ') === 'group shu-workspace') output = 'shu-workspace:x:980:shu-coordinator';
          else throw new Error('unexpected account lookup');
          return;
        }
        if (exe === '/usr/bin/setpriv' && argv.includes('--init-groups') && argv.includes('/usr/bin/node')) {
          const probeFs = { ...f, accessSync(p, requested) {
            const st = f.lstatSync(p), shift = st.uid === 999 ? 6 : [identity.gid, 980].includes(st.gid) ? 3 : 0;
            if (((st.mode >> shift) & requested) !== requested) throw Error('EACCES');
          } };
          try { vm.runInNewContext(argv.at(-1).replace("import fs from 'node:fs'; ", ''), { fs: probeFs }); }
          catch { output = null; } return;
        }
        if (exe === '/usr/bin/systemctl') {
          if (argv[0] === 'start' && argv[1] === 'shu71-evidence.service') {
            write('/run/shu71-evidence/fixture.sock', '', 0o660, 100, 980);
            fs.chmodSync(resolve('/run/shu71-evidence'), 0o750); owners.set('/run/shu71-evidence', [100, 980]);
            faults.runtime?.();
          }
          if (argv.includes('--property=User')) { output = identity.user; return; }
          if (argv.includes('--property=Group')) { output = identity.group; return; }
          // systemd answers from the units it has loaded, and refreshes that
          // view on daemon-reload. Default keeps the previous direct-from-disk
          // model; systemd.unitFileViewCached opts into the loaded-view reading,
          // under which a unit file deleted without a reload is still disablable.
          if (argv[0] === 'daemon-reload') {
            // A reload re-reads the unit directory; a unit that is still running
            // is not forgotten because its file went away, and the install
            // symlinks in <target>.wants/ are not touched by it at all - only
            // the loaded view of unit FILES is rebuilt, which is why directory
            // entries such as `<unit>.d` and `timers.target.wants` are not units.
            loaded.clear();
            for (const entry of fs.readdirSync(resolve('/etc/systemd/system'), { withFileTypes: true }))
              if (!entry.isDirectory()) loaded.add(entry.name);
            for (const [unit, state] of active) if (['active', 'activating'].includes(state)) loaded.add(unit);
            return;
          }
          const unitFile = unit => systemd.unitFileViewCached ? loaded.has(unit) : fs.existsSync(resolve(`/etc/systemd/system/${unit}`));
          if (argv[0] === 'show' && argv.includes('--property=UnitFileState')) {
            // systemd answers from the unit file where it has one, and from the
            // install symlink it still finds in <target>.wants/ where it does
            // not. Only a unit with neither is unknown, and only then is the
            // answer empty - so `unit file gone, .wants symlink left behind` is
            // `enabled`/`disabled` here, exactly as the host reports it.
            const unit = argv.at(-1);
            output = `${unitFile(unit) || wants.has(unit) ? (enabled.has(unit) ? 'enabled' : 'disabled') : ''}\n`; return;
          }
          if (argv[0] === 'show' && argv.includes('--property=InvocationID')) { output = `${invocationOf(argv.at(-1))}\n`; return; }
          if (argv[0] === 'show') output = `${active.get(argv.at(-1)) ?? 'inactive'}\n`;
          // Measured on the target host during shu71-mint-00000017: systemctl
          // kill exits 1 for a unit this episode never started, and
          // enable/disable exit 1 for a unit whose file was never created.
          // `stop` is not modeled that way: every unit this teardown stops is
          // installed. systemd.killRequiresProcesses opts in to the stricter
          // reading - any unit that currently holds no processes - which the
          // approved window did not measure.
          if (argv[0] === 'kill') {
            const unit = argv.at(-1);
            const holds = systemd.killRequiresProcesses ? ['active', 'activating'].includes(active.get(unit) ?? 'inactive') : started.has(unit);
            if (!holds) output = null;
            return;
          }
          if (['enable', 'disable'].includes(argv[0])) {
            const unit = argv.at(-1);
            if (!unitFile(unit)) { output = null; return; }
            // enable/disable create and remove the durable install symlink.
            if (argv[0] === 'enable') { enabled.add(unit); wants.add(unit); }
            else { enabled.delete(unit); wants.delete(unit); }
            if (argv.includes('--now')) { active.set(unit, argv[0] === 'enable' ? 'active' : 'inactive'); if (argv[0] === 'enable') { started.add(unit); mintInvocation(unit); } }
            return;
          }
          if (['start', 'restart'].includes(argv[0])) { active.set(argv[1], 'active'); started.add(argv[1]); mintInvocation(argv[1]); }
          if (argv[0] === 'stop') active.set(argv[1], 'inactive');
          return;
        }
        if (exe === '/usr/bin/id') { output = argv[0] === '-Gn' ? 'shu-coordinator shu-workspace' : String(identity[{ '-u': 'uid', '-g': 'gid', '-gn': 'group' }[argv[0]]]); return; }
        if (exe !== '/usr/bin/setpriv') throw new Error('unexpected command');
        const args = argv.slice(argv.indexOf('-C') + 2), [verb, ...rest] = args;
        const ref = rest.at(-1);
        if (verb === 'rev-parse') {
          if (ref === '--show-object-format') output = 'sha1\n';
          else if (ref === 'HEAD^{tree}') output = `${spec.tree}\n`;
          else if (ref === 'refs/heads/coordinator/SHU-140') output = `${local}\n`;
          else if (ref === 'refs/heads/coordinator/SHU-254') output = `${pkg.fixtures[1].seed_head}\n`;
          else output = `${pkg.coordinator_revision}\n`;
        } else if (verb === 'ls-remote') {
          const sha = ref.endsWith('SHU-140') ? remote : ref.endsWith('SHU-254') ? pkg.fixtures[1].seed_head : pkg.coordinator_revision;
          output = `${sha}\t${ref}\n`;
        } else if (verb === 'merge-tree') output = `${tree}\n`;
        else if (verb === 'hash-object') output = rest.includes('-t') ? `${pkg.reseed.expected_seed_head}\n` : `${'e'.repeat(40)}\n`;
        else if (verb === 'cat-file') output = serializeReseedCommit(tree, pkg.reseed.expected_parent, pkg.coordinator_revision).toString();
        else if (verb === 'ls-tree' && rest.includes('.github/coordinator')) output = `100644 blob ${'e'.repeat(40)}\t.github/coordinator/service/shu71-production.mjs\0`;
        else if (verb === 'ls-tree') output = Object.entries(SEALED_SEED_BLOBS).map(([name, sha]) => `100644 blob ${sha}\t${name}\0`).join('');
        else if (verb === 'update-ref') {
          if (rest[2] !== local) throw new Error('old mismatch'); local = rest[1];
        } else if (verb === 'push') {
          if (!rest.includes(`--force-with-lease=refs/heads/coordinator/SHU-140:${remote}`)) throw new Error('lease absent');
          remote = pkg.reseed.expected_seed_head;
        } else if (!['status', 'check-ref-format', 'merge-base'].includes(verb)) throw new Error(`unexpected git ${verb}`);
      });
      return { status: output === null ? 1 : 0, stdout: output };
    },
    async fetch(url, opts) {
      return effect(`api:${url}`, () => {
        let result;
        if (url === 'https://api.linear.app/graphql') {
          const { query, variables } = JSON.parse(opts.body);
          const transition = pkg.issue_transitions.find(t => t.linear_id === variables.id);
          if (query.startsWith('mutation')) {
            effect(`card:${transition.issue_id}`, () => h.states.set(transition.issue_id, { state_id: variables.input.stateId, assignee_id: variables.input.assigneeId }));
            result = { data: { issueUpdate: { success: true } } };
          } else {
            const state = h.states.get(transition.issue_id);
            result = { data: { issue: { id: transition.linear_id, identifier: transition.issue_id, state: { id: state.state_id }, assignee: state.assignee_id && { id: state.assignee_id } } } };
          }
        } else if (url.includes('/compare/')) result = { status: 'ahead', merge_base_commit: { sha: pkg.reseed.expected_parent } };
        else result = { object: { sha: url.endsWith('main') ? pkg.coordinator_revision : url.endsWith('SHU-140') ? remote : pkg.fixtures[1].seed_head } };
        return { ok: true, text: async () => JSON.stringify(result) };
      });
    },
  };
  return { ...h, spec, id, root, identity, owners, boundary, events, faults, active, enabled, started, loaded, wants, systemd, write, signatures: () => signatures,
    unitInvocations: invocations, selfInvocation,
    expire: () => { now = Date.parse(pkg.expires_at); },
    journal: () => fs.readFileSync(resolve(`${pkg.cleanup.evidence_dir}/${id}/journal.jsonl`), 'utf8').trim().split('\n').map(JSON.parse),
    read: p => fs.readFileSync(resolve(p), 'utf8'), exists: p => fs.existsSync(resolve(p)),
  };
}
