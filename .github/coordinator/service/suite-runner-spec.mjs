// A12 revision and identity binding. Command/filesystem injection is test-only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { halt, suiteNames, deriveRequirements } from './host-suite-contract.mjs';

export const INVENTORY_PATH = '.github/coordinator/service/suite-inventory.json';
export const SUITE_ROOTS = Object.freeze(['.github/coordinator/test/', '.github/coordinator/service/test/']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = values => [...values].sort();
export const suiteBoundary = Object.freeze({
  fs,
  identity: () => ({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups().sort((a, b) => a - b) }),
  run: (file, args, options) => spawnSync(file, args, { encoding: 'utf8', timeout: 30000, ...options }),
});
export function suiteIdentity(spec, io = suiteBoundary) {
  const actual = io.identity();
  if (actual.uid === 0 || actual.uid !== spec.service_uid || actual.gid !== spec.service_gid ||
      !Array.isArray(spec.service_groups) || !equal(actual.groups, [...new Set(spec.service_groups)].sort((a, b) => a - b))) halt('SHU251_SUITE_IDENTITY');
  return actual;
}
export function suiteGit(checkout, args, io = suiteBoundary, raw = false) {
  const result = io.run('/usr/bin/git', ['-C', checkout, ...args], { encoding: raw ? null : 'utf8', env: {
    PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
  } });
  if (result.error || result.status !== 0) halt('SHU251_SUITE_REVISION');
  return raw ? result.stdout : result.stdout.trimEnd();
}
export function bindSuite(spec, io = suiteBoundary) {
  const identity = suiteIdentity(spec, io);
  // No caller-selected execution or alternate inventory authority. Keep the
  // existing files/count guards below (and their mutation controls) intact.
  const fields = ['service_uid', 'service_gid', 'service_groups', 'checkout', 'temp_dir', 'revision', 'tree',
    'disposable_parent', 'source_checkout', 'activation_id', 'files', 'expected_tests'];
  if (Object.keys(spec).some(key => !fields.includes(key))) halt('SHU251_SUITE_CALLER_SELECTION');
  if (!/^[a-f0-9]{40}$/.test(spec.revision ?? '') || !/^[a-f0-9]{40}$/.test(spec.tree ?? '') ||
      !path.isAbsolute(spec.checkout ?? '') || suiteGit(spec.checkout, ['rev-parse', 'HEAD'], io) !== spec.revision ||
      suiteGit(spec.checkout, ['rev-parse', 'HEAD^{tree}'], io) !== spec.tree ||
      suiteGit(spec.checkout, ['status', '--porcelain=v1', '--untracked-files=all'], io) !== '') halt('SHU251_SUITE_REVISION');
  const tracked = suiteGit(spec.checkout, ['ls-tree', '-r', '--name-only', spec.revision], io).split('\n');
  const files = sorted(tracked.filter(f => SUITE_ROOTS.some(root => f.startsWith(root) && !f.slice(root.length).includes('/') && f.endsWith('.test.mjs'))));
  let inventory, inventoryBytes;
  try {
    inventoryBytes = suiteGit(spec.checkout, ['show', `${spec.revision}:${INVENTORY_PATH}`], io, true);
    inventory = JSON.parse(inventoryBytes);
  }
  catch { halt('SHU251_SUITE_INVENTORY'); }
  if (inventory?.version !== 'shu251-suite-inventory-v1' || !Array.isArray(inventory.files) || !files.length ||
      !equal(files, inventory.files) || !Array.isArray(inventory.names) || !inventory.names.length ||
      inventory.names.some(name => typeof name !== 'string' || !name) ||
      Object.hasOwn(spec, 'files') || Object.hasOwn(spec, 'expected_tests')) halt('SHU251_SUITE_INVENTORY');
  deriveRequirements(inventory.names, inventory.requirements);
  const digest = value => createHash('sha256').update(value).digest('hex');
  // Git status alone is insufficient: assume-unchanged/skip-worktree can hide
  // modified bytes. Verify every tracked coordinator input, including wrappers,
  // against its revision object, without executing any of those inputs.
  const entries = sorted(tracked.filter(file => file.startsWith('.github/coordinator/')));
  let checkout, perFile;
  try {
    checkout = io.fs.realpathSync(spec.checkout);
    if (checkout !== spec.checkout || !io.fs.lstatSync(checkout).isDirectory()) halt('SHU251_SUITE_CHECKOUT_REALPATH');
    perFile = entries.map(file => {
      if (file.split('/').some(part => !part || part === '.' || part === '..')) halt('SHU251_SUITE_FILE_DIGEST');
      const absolute = path.join(checkout, file);
      const stat = io.fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || io.fs.realpathSync(absolute) !== absolute) halt('SHU251_SUITE_FILE_DIGEST');
      const expected = digest(suiteGit(checkout, ['show', `${spec.revision}:${file}`], io, true));
      if (digest(io.fs.readFileSync(absolute)) !== expected) halt('SHU251_SUITE_FILE_DIGEST');
      return { file, sha256: expected };
    });
  } catch (error) {
    if (error.code === 'SHU251_SUITE_CHECKOUT_REALPATH') throw error;
    halt('SHU251_SUITE_FILE_DIGEST');
  }
  const binding = { revision: spec.revision, tree: spec.tree, checkout,
    inventory_sha256: digest(inventoryBytes), entries: perFile, expected_tests: inventory.names.length };
  return { requirements: inventory.requirements, identity, files: files.map(file => path.join(spec.checkout, file)),
    names: inventory.names, expected_tests: inventory.names.length, binding };
}
export function suiteQuiescence(io = suiteBoundary) {
  const states = {};
  for (const unit of ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer']) {
    const result = io.run('/usr/bin/systemctl', ['show', '--property=ActiveState', '--value', unit], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    if (result.error || result.status !== 0 || result.stdout.trim() !== 'inactive') halt('SHU251_SUITE_QUIESCENCE');
    states[unit] = 'inactive';
  }
  return states;
}
export { suiteNames };

// Metadata only. Namespace creation is a separate approved capability probe.
export function measureSuite(spec, io = suiteBoundary) {
  const identity = suiteIdentity(spec, io);
  const metadata = target => {
    const chain = [];
    for (let current = path.resolve(target); ; current = path.dirname(current)) {
      const stat = io.fs.lstatSync(current);
      const mode = stat.mode & 0o7777;
      const permission = uid => uid === stat.uid ? (mode >> 6) & 7 :
        (uid === identity.uid && [identity.gid, ...identity.groups].includes(stat.gid)) ? (mode >> 3) & 7 : mode & 7;
      chain.push({ path: current, uid: stat.uid, gid: stat.gid, mode, directory: stat.isDirectory(), symlink: stat.isSymbolicLink(),
        service_traversable: stat.isDirectory() && !!(permission(identity.uid) & 1),
        worker_other_traversable: stat.isDirectory() && !!(permission(65534) & 1) });
      if (current === '/') break;
    }
    return chain;
  };
  const read = file => { try { return io.fs.readFileSync(file, 'utf8').trim(); } catch (e) { return { unavailable: e.code ?? 'UNKNOWN' }; } };
  return { version: 'shu251-suite-host-facts-v1', identity,
    checkout: metadata(spec.checkout), temporary: metadata(spec.temp_dir),
    namespace: { service_identity: identity, result: 'NOT_PROBED' },
    kernel: Object.fromEntries([
      '/proc/sys/kernel/unprivileged_userns_clone', '/proc/sys/user/max_user_namespaces',
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '/sys/module/apparmor/parameters/enabled',
      '/proc/self/attr/current',
    ].map(file => [file, read(file)])),
    sudo: { result: 'NOT_PROBED', legacy_preflight: ['/usr/bin/sudo', '-n', '/usr/bin/id', '-u'],
      worker_probe: ['/usr/bin/sudo', '-n', '/usr/bin/setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '/usr/bin/id', '-u'],
      limitation: 'The id probes do not authorize the suite worker commands or prove their supplementary groups. No sudo policy change is implied.' },
  };
}
