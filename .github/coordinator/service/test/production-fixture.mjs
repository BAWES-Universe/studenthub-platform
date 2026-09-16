import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture } from './lifecycle-fixture.mjs';
import { createProductionLifecycle } from '../production-lifecycle.mjs';
import { expectedManifest } from '../host-lifecycle.mjs';
import { UNIT_NAMES, drive, hash, canonical } from '../phase-a-driver.mjs';

// All FS paths are translated to disposable test storage. Every command is
// recorded and interpreted here; no command can escape to the actual host.
export function productionFixture(t, { operations = ['install', 'start', 'pin', 'host-rollback', 'pin-restore'], teardown = 'restore' } = {}) {
  const base = fixture(), { spec } = base;
  spec.window.fixture = { pid: 4321, start_token: '12345' };
  const bound = structuredClone(spec); delete bound.lifecycle.approval_sha256;
  const approval = { version: 'shu251-owner-approval-v1', spec_sha256: hash(canonical(bound)), not_before: 1000, expires_at: 10000, operations, teardown };
  const owner = generateKeyPairSync('ed25519'); // disposable fixture owner, never a production key
  const signed = () => JSON.stringify({ payload: approval, signature: sign(null, Buffer.from(canonical(approval)), owner.privateKey).toString('base64') });
  spec.lifecycle.approval_sha256 = hash(signed());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptors = new Map(), owners = new Map(), events = [], faults = {};
  const resolve = p => {
    if (typeof p === 'number') return p;
    const m = /^\/proc\/self\/fd\/(\d+)(.*)$/.exec(p);
    return m ? `${descriptors.get(Number(m[1]))}${m[2]}` : `${root}${p}`;
  };
  const logical = p => typeof p === 'number' ? descriptors.get(p).slice(root.length) : resolve(p).slice(root.length);
  const stats = (p, s) => {
    const [uid, gid] = owners.get(logical(p)) ?? ((logical(p).startsWith('/etc/systemd') || logical(p).startsWith('/etc/shu/approvals') || logical(p).startsWith(spec.lifecycle.evidence_root)) ? [0,0] : [1001,1001]);
    return new Proxy(s, { get(target, key) { if (key === 'uid') return uid; if (key === 'gid') return gid; const v = target[key]; return typeof v === 'function' ? v.bind(target) : v; } });
  };
  function mkdir(p, mode = 0o755) { fs.mkdirSync(resolve(p), { recursive: true, mode }); }
  function write(p, bytes, mode = 0o600) { mkdir(path.dirname(p)); fs.writeFileSync(resolve(p), bytes, { mode }); }
  for (const p of ['/etc/systemd/system', spec.lifecycle.evidence_dir, spec.window.workspace_state_dir, spec.window.supervisor_state_dir, '/reviewed/repo']) mkdir(p);
  for (const p of [spec.lifecycle.evidence_dir, spec.window.workspace_state_dir, spec.window.supervisor_state_dir]) fs.chmodSync(resolve(p), 0o700);
  for (const v of Object.values(spec.lifecycle.environment)) { write(v.path, 'NO_ENV_VALUES_READ'); owners.set(v.path, [v.uid, v.gid]); }
  write('/etc/shu/approvals/owner.pub', owner.publicKey.export({ format: 'pem', type: 'spki' }), 0o644);
  write(`/etc/shu/approvals/${spec.lifecycle.activation_id}.json`, signed());
  write(`${spec.lifecycle.evidence_dir}/manifest.json`, JSON.stringify(expectedManifest(spec)));
  write(`${spec.lifecycle.evidence_dir}/journal.lock`, ''); write(`${spec.window.workspace_state_dir}/host-tick.lock`, '');
  write('/proc/123/status', 'Uid:\t1001 1001 1001 1001\nGid:\t1001 1001 1001 1001\nGroups:\t1001 1002\n');
  write('/proc/123/task/123/children', '');
  write('/proc/123/environ', 'ENABLE_DISPATCH=false\0');
  let invocation = 'd'.repeat(32), pin = 'b'.repeat(40), tick = 500;
  const checkout = structuredClone(spec.lifecycle.checkout_before);
  const enabled = Object.fromEntries(UNIT_NAMES.map(n => [n, 'disabled'])), active = Object.fromEntries(UNIT_NAMES.map(n => [n, 'inactive']));
  const boundaryFS = {
    constants: fs.constants,
    watch(p, opts, fn) { return fs.watch(resolve(p), opts, fn); },
    lstatSync(p) { const s = stats(p, fs.lstatSync(resolve(p))); if (faults.stat) return faults.stat(p,s); return s; },
    fstatSync(fd) { return stats(fd, fs.fstatSync(fd)); },
    realpathSync(p) { return fs.realpathSync(resolve(p)).slice(root.length) || '/'; },
    openSync(p, flags, mode) { events.push(['open', logical(p), flags]); const fd = fs.openSync(resolve(p), flags, mode); descriptors.set(fd, resolve(p)); return fd; },
    closeSync(fd) { events.push(['close', descriptors.get(fd)]); fs.closeSync(fd); descriptors.delete(fd); },
    readFileSync(p, encoding) { events.push(['read', logical(p)]); assert.ok(!Object.values(spec.lifecycle.environment).some(v => v.path === logical(p)), 'never read environment secrets in probe'); return fs.readFileSync(resolve(p), encoding); },
    writeFileSync(p, bytes, options) { events.push(['write', logical(p)]); fs.writeFileSync(resolve(p), bytes, options); },
    fsyncSync(fd) { events.push(['fsync', logical(fd), fs.fstatSync(fd).isDirectory() ? 'directory' : 'file']); if (faults.fsync) throw new Error('fsync'); fs.fsyncSync(fd); },
    fchownSync(fd, uid, gid) { owners.set(logical(fd), [uid,gid]); },
    fchmodSync(fd, mode) { fs.fchmodSync(fd, mode); },
    chmodSync(p, mode) { fs.chmodSync(resolve(p), mode); },
    renameSync(a,b) { events.push(['rename', logical(a), logical(b)]); fs.renameSync(resolve(a),resolve(b)); if (owners.has(logical(a))) owners.set(logical(b), owners.get(logical(a))); },
    unlinkSync(p) { fs.unlinkSync(resolve(p)); }, rmdirSync(p) { fs.rmdirSync(resolve(p)); },
    mkdirSync(p, opts) { fs.mkdirSync(resolve(p),opts); },
    symlinkSync(target,p) { fs.symlinkSync(target,resolve(p)); }, readlinkSync(p) { return fs.readlinkSync(resolve(p)); },
    readdirSync(p) { return fs.readdirSync(resolve(p)); },
    mkdtempSync(p) { const d = fs.mkdtempSync(resolve(p)); owners.set(d.slice(root.length), [0,0]); return d.slice(root.length); },
    rmSync(p,opts) { fs.rmSync(resolve(p),opts); }, accessSync(p, mode) { fs.accessSync(resolve(p),mode); },
  };
  const commands = [];
  function commandImpl(file, args, opts) {
    commands.push({ file, args, opts });
    if (faults.command) { const result = faults.command(file,args,opts); if (result) return result; }
    const out = stdout => ({ status: 0, stdout: String(stdout), stderr: '' });
    if (file === '/usr/bin/flock') { assert.ok(descriptors.has(opts.stdio[3]), 'lock owns a live descriptor'); return out(''); }
    if (file === '/usr/bin/id') return out({ '-un': 'shu-coordinator', '-gn': 'shu-coordinator', '-u': '1001', '-g': '1001', '-G': '1001 1002' }[args[0]]);
    if (file === '/usr/bin/git') {
      const a = args.slice(2);
      if (a[0] === 'ls-remote') return out(`${spec.window.approved_sha}\trefs/heads/main`);
      if (a[0] === 'fetch') return out('');
      if (a[0] === 'symbolic-ref') return checkout.head_ref === null ? { status: 1, stdout: '' } : out(checkout.head_ref);
      if (a[0] === 'checkout') {
        if (a[1] === '--detach') { checkout.sha = a[2]; checkout.head_ref = null; checkout.tree = a[2] === spec.window.approved_sha ? spec.lifecycle.approved_tree : spec.lifecycle.checkout_before.tree; }
        else { assert.equal(checkout.sha, checkout.main); checkout.head_ref = 'refs/heads/main'; }
        return out('');
      }
      if (a[0] === 'update-ref' && a[1] === '--stdin') {
        assert.ok(opts.input.includes(`verify HEAD ${checkout.sha}`));
        for (const [ref, key] of [['refs/heads/main', 'main'], ['refs/remotes/origin/main', 'origin_main']]) {
          const line = opts.input.split('\n').find(l => l.startsWith(`update ${ref} `)).split(' ');
          assert.equal(line[3], checkout[key]); checkout[key] = line[2];
        }
        return out('');
      }
      if (a[0] === 'rev-parse' && a[1] === '--verify') return pin ? out(pin) : { status: 1, stdout: '', stderr: '' };
      if (a[0] === 'rev-parse') return out(({ HEAD: checkout.sha, 'HEAD^{tree}': checkout.tree, 'refs/heads/main': checkout.main, 'refs/remotes/origin/main': checkout.origin_main })[a[1]] ?? (a[1].startsWith(spec.window.approved_sha) ? spec.lifecycle.approved_tree : spec.lifecycle.checkout_before.tree));
      if (a[0] === 'status') return out(checkout.clean ? '' : ' M changed');
      if (a[0] === 'show') return out('{"enable_dispatch":false}');
      if (a[0] === 'update-ref') { const after = a[1] === '-d' ? null : a[2], before = a[1] === '-d' ? a[3] : a[3]; assert.equal(before, pin ?? '0'.repeat(40), 'Git expected-old-value'); pin = after; return out(''); }
    }
    if (file === '/usr/bin/systemctl') {
      if (args[0] === 'show') {
        if (args[1] === '--property=Version') return out('255');
        const property = args[2].slice('--property='.length), unit = args[1];
        return out({ UnitFileState: enabled[unit], ActiveState: active[unit], SubState: 'running', MainPID: '123', Result: 'success', ExecMainStatus: '0', ExecMainExitTimestampMonotonic: String(tick), InvocationID: invocation }[property]);
      }
      if (args[0] === 'enable') enabled[args[1]] = 'enabled';
      if (args[0] === 'disable') enabled[args[1]] = 'disabled';
      if (args[0] === 'start' && args[1] === 'shu-coordinator.service') {
        assert.ok(![...descriptors.values()].some(p => p.endsWith('/host-tick.lock')), 'coordinator owns writer lock during its tick');
        assert.ok([...descriptors.values()].some(p => p.endsWith('/journal.lock')), 'journal custody survives writer handoff');
        tick++;
      }
      if (args[0] === 'start') active[args[1]] = args[1] === 'shu-coordinator.service' ? 'inactive' : 'active';
      if (args[0] === 'stop') active[args[1]] = 'inactive';
      if (args[0] === 'restart') invocation = 'e'.repeat(32);
      return out('systemd 255');
    }
    if (file === '/usr/bin/gh') return out(`${spec.window.approved_sha}\t${spec.lifecycle.approved_tree}`);
    if (file === '/usr/bin/ss') return out(`u_str LISTEN 0 10 ${spec.window.supervisor_socket} 1 * 0 users:(("node",pid=123,fd=5))`);
    if (file === '/usr/bin/node') return out(JSON.stringify({ evidence: args[1] === 'worker' ? { ok: true, pid: 4321, start_token: '12345' } : { ok: true, stage: 'RUNNING' } }));
    if (file === '/usr/bin/setpriv') {
      if (args.includes('/usr/bin/id')) return out('65534');
      if (args.some(a => a.includes('resolveCvtsudoers'))) return out('{"available":true,"identity":"/usr/bin/cvtsudoers"}');
      return out(''); // recorded service-identity capability probe outputs
    }
    assert.fail(`unrecorded command: ${file} ${args.join(' ')}`);
  }
  function run(file, args, opts) { const result = commandImpl(file, args, opts); return faults.afterCommand?.(file, args, opts) ?? result; }
  const boundary = { fs: boundaryFS, uid: () => 0, now: () => 2000, run, async wait() { if (faults.wait) await faults.wait(); else tick++; await new Promise(resolve => setImmediate(resolve)); } };
  const provider = createProductionLifecycle(spec, boundary);
  const io = { ...base.io, lifecycle: provider };
  function approveFixture() {
    const bound = structuredClone(spec); delete bound.lifecycle.approval_sha256;
    approval.spec_sha256 = hash(canonical(bound));
    const bytes = signed(); spec.lifecycle.approval_sha256 = hash(bytes);
    write(`/etc/shu/approvals/${spec.lifecycle.activation_id}.json`, bytes);
    write(`${spec.lifecycle.evidence_dir}/manifest.json`, JSON.stringify(expectedManifest(spec)));
  }
  return { reopen() { io.lifecycle = createProductionLifecycle(spec, boundary); }, approveFixture, spec, approval, checkout, get provider() { return io.lifecycle; }, boundary, events, commands, faults, write, mkdir, resolve, root,
    run: step => drive(step, spec, { execute: true, approvedHostMutation: spec.window.approved_sha, env: { SHU251_HOST_MUTATION_APPROVED: 'true' } }, io) };
}
