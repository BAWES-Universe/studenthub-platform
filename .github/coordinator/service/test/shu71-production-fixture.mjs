import fs from 'node:fs';
import { secretText, coordinatorText } from './shu71-supervisor-environment-fixture.mjs';
import os from 'node:os';
import path from 'node:path';
import { sign } from 'node:crypto';
import { harness } from '../../test/fixture/shu71-package.mjs';
import { canonicalBytes } from '../../shu71-activation-package.mjs';
import { serializeReseedCommit, SEALED_SEED_BLOBS } from '../../reseed-append-contract.mjs';
import { digest } from '../shu71-journal.mjs';

// All paths map into this disposable tree. Every command and API is interpreted
// here. No production command, host service, API or signing key is reachable.
export function productionFixture(t, keys) {
  const h = harness(keys), pkg = h.context.pkg, id = pkg.activation_id;
  pkg.reseed.patch_sha256 = digest(''); pkg.signature = ''; pkg.activation.signature = '';
  const tree = 'd'.repeat(40);
  const spec = { kind: 'shu71-production-v1', checkout: '/reviewed/repo', tree: 'c'.repeat(40), pkg,
    binding: { ...pkg.reseed, approvedExecutionRevision: pkg.coordinator_revision, tree, manifest_hex: '' } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-production-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owners = new Map(), handles = new Map(), events = [], faults = {};
  const logical = p => typeof p === 'number' ? handles.get(p) : p;
  const resolve = p => typeof p === 'number' ? p : root + p;
  const stat = (p, value) => new Proxy(value, { get(target, key) {
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
  function write(p, value, mode = 0o600, uid = 0) {
    fs.mkdirSync(path.dirname(resolve(p)), { recursive: true, mode: 0o755 });
    fs.writeFileSync(resolve(p), value, { mode }); owners.set(p, [uid, uid]);
  }
  for (const p of ['/srv/shu/state', '/srv/shu/state/workspaces', '/etc/systemd/system', '/srv/shu/worktrees']) fs.mkdirSync(resolve(p), { recursive: true, mode: 0o755 });
  fs.chmodSync(resolve('/srv/shu/worktrees'), 0o3770);
  write(`/etc/shu/approvals/${id}.shu71.json`, JSON.stringify({ payload: spec, signature: sign(null, canonicalBytes(spec, false), keys.privateKey).toString('base64') }));
  write('/etc/shu/approvals/shu71-owner.pub', keys.publicKey.export({ type: 'spki', format: 'pem' }));
  write('/etc/shu/keys/shu71-signing.pem', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  write('/usr/local/lib/shu71/coordinator/service/shu71-production.mjs', 'reviewed artifact', 0o644);
  write('/etc/shu/supervisor.env', secretText());
  write('/srv/shu/coordinator.env', coordinatorText(), 0o600, 999);
  let now = +h.context.now, local = pkg.reseed.expected_parent, remote = local;
  let signatures = 0;
  const active = new Map();
  const boundary = { fs: f, uid: () => 0, now: () => now,
    sign(bytes, key) { signatures++; return effect('sign', () => sign(null, bytes, key)); },
    run(exe, argv, options) {
      let output = '';
      effect(`command:${exe}:${argv.join(' ')}`, () => {
        if (exe === '/usr/bin/systemctl') {
          if (argv[0] === 'show') output = `${active.get(argv.at(-1)) ?? 'inactive'}\n`;
          if (['start', 'restart'].includes(argv[0])) active.set(argv[1], 'active');
          if (argv[0] === 'stop') active.set(argv[1], 'inactive');
          return;
        }
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
      return { status: 0, stdout: output };
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
  return { ...h, spec, id, root, boundary, events, faults, active, write, signatures: () => signatures,
    expire: () => { now = Date.parse(pkg.expires_at); },
    journal: () => fs.readFileSync(resolve(`${pkg.cleanup.evidence_dir}/${id}/journal.jsonl`), 'utf8').trim().split('\n').map(JSON.parse),
    read: p => fs.readFileSync(resolve(p), 'utf8'), exists: p => fs.existsSync(resolve(p)),
  };
}
