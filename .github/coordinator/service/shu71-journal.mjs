// One writer (the CLI holds flock) and an append-only, fsync'd write-ahead log.
// A torn last write is a refusal, never permission to forget an earlier effect.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function activationError(code) { return Object.assign(new Error(code), { code }); }
export function requireActivation(condition, code) { if (!condition) throw activationError(code); }
export function openActivationJournal(directory, f = fs, name = 'journal.jsonl') {
  const C = f.constants;
  let current = '/';
  for (const part of directory.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const s = f.lstatSync(current);
    requireActivation(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022), 'ACT_JOURNAL_CUSTODY');
  }
  const filename = path.join(directory, name);
  const fd = f.openSync(filename, C.O_RDWR | C.O_CREAT | C.O_APPEND | C.O_NOFOLLOW, 0o600);
  let parent;
  try {
  const stat = f.fstatSync(fd);
  requireActivation(stat.isFile() && stat.uid === 0 && stat.nlink === 1 && !(stat.mode & 0o077), 'ACT_JOURNAL_CUSTODY');
  let source = f.readFileSync(fd, 'utf8');
  requireActivation(!source || source.endsWith('\n'), 'ACT_JOURNAL_TORN');
  const entries = source.trim() ? source.trim().split('\n').map(line => JSON.parse(line)) : [];
  let previous = '0'.repeat(64);
  for (const [index, entry] of entries.entries()) {
    const { sha256, ...payload } = entry;
    requireActivation(payload.seq === index && payload.previous === previous && sha256 === digest(JSON.stringify(payload)), 'ACT_JOURNAL_INVALID');
    previous = sha256;
  }
  parent = f.openSync(directory, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  f.fsyncSync(fd); f.fsyncSync(parent);
  return {
    entries,
    append(event) {
      const payload = { seq: entries.length, previous, ...event };
      requireActivation(payload.seq === entries.length && payload.previous === previous, 'ACT_JOURNAL_INVALID');
      const row = { ...payload, sha256: digest(JSON.stringify(payload)) };
      f.writeFileSync(fd, JSON.stringify(row) + '\n'); f.fsyncSync(fd); f.fsyncSync(parent);
      entries.push(row); previous = row.sha256;
      return row;
    },
    close() { f.closeSync(fd); f.closeSync(parent); },
  };
  } catch (error) {
    f.closeSync(fd); if (parent !== undefined) f.closeSync(parent); throw error;
  }
}

// All effects are idempotent or compare-and-set against the durable intent.
// Completion is recorded only after read-back; an interrupted intent is retried.
export async function journalEffect(journal, step, effect) {
  if (journal.entries.some(e => e.event === 'DONE' && e.step === step)) return;
  if (!journal.entries.some(e => e.event === 'INTENT' && e.step === step)) journal.append({ event: 'INTENT', step });
  await effect();
  journal.append({ event: 'DONE', step });
}

export async function teardownActivation(journal, effects, reason) {
  // Expiry is an authorization fact; it is not a claim that cleanup succeeded.
  const failures = [];
  try { journal.append({ event: reason === 'expiry' ? 'AUTHORIZATION_EXPIRED' : 'REVOKE_REQUESTED' }); }
  catch { failures.push('ACT_EVIDENCE_WRITE_FAILED'); }
  for (const [step, effect] of effects) {
    try { await journalEffect(journal, `teardown:${step}`, effect); }
    catch {
      failures.push(`ACT_TEARDOWN_${step.toUpperCase().replaceAll('-', '_')}`);
      // If journal storage is unavailable, independent safety effects must still
      // be attempted. They are narrow, idempotent and do not grant authority.
      try { await effect(); } catch { /* retained as failed, retry next invocation */ }
    }
  }
  const event = failures.length ? 'TEARDOWN_INCOMPLETE' : 'TEARDOWN_COMPLETE';
  try { journal.append({ event, failures }); }
  catch { failures.push('ACT_EVIDENCE_WRITE_FAILED'); }
  return { ok: failures.length === 0, state: failures.length ? 'HALT' : 'REVOKED', code: failures.length ? 'ACT_CLEANUP_FAILED' : null, failures };
}
