// Offline staging installer only. No service manager calls or host destinations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { names, render, assertPolicy, verifySyntax } from './units.mjs';

function rootCheck(root) {
  root = resolve(root);
  const temp = fs.realpathSync(tmpdir());
  let real;
  try { real = fs.realpathSync(root); } catch { /* named destination refusal below */ }
  assert.ok(root.startsWith(temp + sep) && real === root && fs.lstatSync(root).isDirectory(), 'SHU251_DESTINATION: existing real temporary staging directory required');
  assert.equal(fs.statSync(root).uid, process.getuid(), 'SHU251_OWNER: staging directory must be owned by caller');
  assert.equal(fs.statSync(root).mode & 0o022, 0, 'SHU251_PRIVATE: staging directory must not be group/world writable');
  return root;
}
export function snapshot(root) {
  return Object.fromEntries(names.map(name => {
    const file = join(root, name);
    if (!fs.existsSync(file) && !fs.lstatSync(file, { throwIfNoEntry: false })) return [name, null];
    assert.ok(fs.lstatSync(file).isFile(), 'SHU251_FILE: unit targets must be regular files');
    return [name, { data: fs.readFileSync(file).toString('base64'), mode: fs.statSync(file).mode & 0o777 }];
  }));
}
function atomic(file, data, mode) {
  const temporary = `${file}.${randomUUID()}.new`;
  try {
    const fd = fs.openSync(temporary, 'wx', mode);
    try { fs.writeFileSync(fd, data); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function restore(root, prior) {
  assert.deepEqual(Object.keys(prior).sort(), [...names].sort(), 'SHU251_BACKUP: backup unit set must match');
  for (const name of names) {
    const item = prior[name];
    if (item === null) fs.rmSync(join(root, name), { force: true });
    else atomic(join(root, name), Buffer.from(item.data, 'base64'), item.mode);
  }
  assert.deepEqual(snapshot(root), prior, 'SHU251_ROLLBACK: prior bytes, modes and absence must be restored');
}
export function install(root, options) {
  root = rootCheck(root);
  const units = render(options);
  assertPolicy(units);
  const lock = join(root, '.shu251-operation');
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const prior = snapshot(root);
    const desired = Object.fromEntries(names.map(n => [n, { data: Buffer.from(units[n]).toString('base64'), mode: 0o644 }]));
    const backup = join(root, '.shu251-backup.json');
    if (fs.existsSync(backup)) {
      assert.deepEqual(prior, desired, 'SHU251_DRIFT: rollback existing transaction before changing staged units');
      verifySyntax(root);
      return { changed: false };
    }
    const check = fs.mkdtempSync(join(root, '.verify-'));
    try {
      for (const name of names) fs.writeFileSync(join(check, name), units[name], { mode: 0o644 });
      verifySyntax(check);
    } finally { fs.rmSync(check, { recursive: true, force: true }); }
    atomic(backup, JSON.stringify(prior), 0o600);
    try {
      for (const name of names) atomic(join(root, name), units[name], 0o644);
      assert.deepEqual(snapshot(root), desired, 'SHU251_INSTALL: staged units must match rendered units');
    } catch (error) { restore(root, prior); fs.unlinkSync(backup); throw error; }
    return { changed: true };
  } finally { fs.rmdirSync(lock); }
}
export function rollback(root) {
  root = rootCheck(root);
  const lock = join(root, '.shu251-operation');
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const backup = join(root, '.shu251-backup.json');
    if (!fs.existsSync(backup)) return { changed: false };
    assert.ok(fs.lstatSync(backup).isFile(), 'SHU251_BACKUP: backup must be a regular file');
    restore(root, JSON.parse(fs.readFileSync(backup, 'utf8')));
    fs.unlinkSync(backup);
    return { changed: true };
  } finally { fs.rmdirSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, root, config] = process.argv.slice(2);
  assert.ok(root && ((action === 'stage' && config) || (action === 'rollback' && !config)), 'usage: install.mjs stage TEMP_DIRECTORY parameters.json | rollback TEMP_DIRECTORY');
  console.log(JSON.stringify(action === 'stage' ? install(root, JSON.parse(fs.readFileSync(config, 'utf8'))) : rollback(root)));
}
