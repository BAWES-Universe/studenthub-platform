// One writer (the CLI holds flock) and an append-only, fsync'd write-ahead log.
// A torn last write is a refusal, never permission to forget an earlier effect.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function activationError(code) { return Object.assign(new Error(code), { code }); }
export function requireActivation(condition, code) { if (!condition) throw activationError(code); }
// THE REVIEWED REFUSAL VOCABULARY, stated once as a shape rather than as a
// hand-maintained list. Every refusal this system raises is named
// `ACT_*`/`SHU251_*`/`SHU71_*`; the allow-list that used to decide which of
// those a halt was allowed to REPORT had to be extended by hand for every new
// name, and everything it had not been taught - the environment codes,
// ACT_CREDENTIAL_UNAVAILABLE, the whole SHU71_RESEED_* family, the journal
// family - was silently reported as the generic ACT_PRODUCTION_FAILED. A
// reviewed name is preserved BY CONSTRUCTION now.
//
// The shape is also what makes this safe to report: upper case, digits and
// underscores after one of three fixed prefixes, at most 51 characters. No
// token, header, URL, path, response body or message text can be spelled that
// way, so nothing a credential could ride in on is admitted, and an error with
// no code, a non-string code or arbitrary text is not a reviewed name and is
// reported exactly as it is today.
export const REFUSAL_CODE_PATTERN = /^(?:ACT|SHU251|SHU71)_[A-Z0-9_]{2,44}$/;
export const reviewedCode = code => typeof code === 'string' && REFUSAL_CODE_PATTERN.test(code) ? code : null;
export function openActivationJournal(directory, f = fs, name = 'journal.jsonl', coordinator = null) {
  const C = f.constants;
  let current = '/';
  for (const part of directory.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const s = f.lstatSync(current);
    const state = current === '/srv/shu/state' && coordinator;
    requireActivation(s.isDirectory() && !s.isSymbolicLink() && (state
      ? s.uid === coordinator.uid && s.gid === coordinator.gid && (s.mode & 0o7777) === 0o700
      : s.uid === 0) && !(s.mode & 0o022), 'ACT_JOURNAL_CUSTODY');
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
export async function journalEffect(journal, step, effect, repeat = false) {
  if (!repeat && journal.entries.some(e => e.event === 'DONE' && e.step === step)) return;
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
    try {
      if (step === 'observation') await effect();
      else {
        // A completed physical effect can drift. Re-establish safety on every
        // invocation; retain once-only bookkeeping for remote restores/archive.
        const repeat = ['gate', 'activation', 'workers', 'reload', 'evidence-broker'].includes(step) || step.startsWith('stop-');
        if (step === 'expiry-timer' && failures.length) throw activationError('ACT_CLEANUP_FAILED');
        await journalEffect(journal, `teardown:${step}`, effect, repeat);
      }
    }
    catch (error) {
      const stepCode = `ACT_TEARDOWN_${step.toUpperCase().replaceAll('-', '_')}`;
      failures.push(stepCode);
      // The step's own failure says WHICH reviewed effect refused; a refusal
      // that carries its own name says WHY, and is reported under that name too
      // rather than being flattened into the step. Additive: no existing
      // failure entry is renamed, removed or reordered by this.
      //
      // Generalised from the single ACT_TEARDOWN_EXPIRY_SERVICE case to EVERY
      // reviewed refusal name. The teardown reported step codes only, so the
      // real cause of a failed step - ACT_SERVICE_CLEANUP from a unit that
      // would not stop, ACT_FILE_CUSTODY from a gate drop-in, ACT_API_FAILED
      // from a fixture restore, ACT_TEARDOWN_MEASUREMENT from a read that never
      // answered - was dropped, and an operator reading `failures` learned
      // which effect refused but never why. The name is admitted by the
      // reviewed shape rather than by a list, so a newly named refusal is
      // preserved without editing this line; an errno, an AssertionError or any
      // other unnamed failure adds nothing, and the step's own code is never
      // duplicated.
      if (error?.code !== stepCode && reviewedCode(error?.code)) failures.push(error.code);
      // If journal storage is unavailable, independent safety effects must still
      // be attempted. They are narrow, idempotent and do not grant authority.
      if (step !== 'expiry-timer') {
        try { await effect(); } catch { /* retained as failed, retry next invocation */ }
      }
    }
  }
  const event = failures.length ? 'TEARDOWN_INCOMPLETE' : 'TEARDOWN_COMPLETE';
  try { journal.append({ event, failures }); }
  catch { failures.push('ACT_EVIDENCE_WRITE_FAILED'); }
  return { ok: failures.length === 0, state: failures.length ? 'HALT' : 'REVOKED', code: failures.length ? 'ACT_CLEANUP_FAILED' : null, failures };
}
