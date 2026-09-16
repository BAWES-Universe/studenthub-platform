// Receipt-bound progression. The signed seed never changes. An authenticated
// reservation carries the digest observed at arming; the broker's private
// pre-push journal binds each edge independently of worker callback claims.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { receiptCommentActorId, validateReceipt } from './reconcile.mjs';
import { resolveReceiptRoleAuthority } from './launch-vocabulary.mjs';

export const activationDigest = bytes => createHash('sha256').update(bytes).digest('hex');

export function readProgressionPush(receipt, env) {
  if (!/^[0-9a-f-]{36}$/.test(receipt?.attempt_id ?? '')) return null;
  const home = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, '.codex') : null);
  if (!home) return null;
  const dir = path.join(home, 'coordinator-runs');
  const file = path.join(dir, `push-${receipt.attempt_id}.json`);
  try {
    for (const p of [dir, file]) {
      const s = fs.lstatSync(p);
      if (s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) return null;
    }
    if (!fs.statSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

export function progressionHeads({ record, config, receipts, digest, readPush, isAncestor }) {
  const heads = {};
  for (const fixture of record.fixtures) {
    let head = fixture.seed_head;
    const edges = [];
    for (const receipt of receipts) {
      if (!receipt || receipt.issue_id !== fixture.issue_id) continue;
      // A stale episode's journal must not participate in this activation.
      if (receipt.episode_id !== record.activation_id) continue;
      let push;
      try { push = readPush(receipt); } catch { return null; }
      if (!push) {
        if (['BUILD_READY', 'REVISION_READY'].includes(receipt.verdict_stage) && receipt.result_sha !== receipt.target_sha) return null;
        continue;
      }
      if (!config.linear_receipt_actor_ids?.includes(receiptCommentActorId(receipt))) return null;
      if (!validateReceipt(receipt).valid || receipt.activation_digest !== digest) return null;
      const authority = resolveReceiptRoleAuthority(receipt);
      if (!authority.ok || !['build', 'revise'].includes(authority.role) ||
          receipt.branch !== fixture.branch || receipt.repo !== config.pilot_repo ||
          receipt.authorization_ref !== fixture.lane.authorization_ref) return null;
      if (!['PENDING', 'PUSHED'].includes(push.stage) || push.attempt_id !== receipt.attempt_id ||
          push.target_sha !== receipt.target_sha || push.branch !== fixture.branch || push.repo !== receipt.repo ||
          !/^[0-9a-f]{40}$/.test(push.result_sha ?? '') || push.update_mode !== 'fast-forward') return null;
      try {
        if (isAncestor(receipt.target_sha, push.result_sha) !== true) return null;
      } catch { return null; }
      edges.push({ from: receipt.target_sha, to: push.result_sha });
    }
    // Order by parent binding, not timestamps or API comment ordering. Forks,
    // disconnected edges and rewinds refuse; a sibling lane need not advance.
    while (edges.length) {
      const next = edges.filter(edge => edge.from === head);
      if (next.length !== 1 || next[0].to === head) return null;
      head = next[0].to;
      edges.splice(edges.indexOf(next[0]), 1);
    }
    heads[fixture.branch] = head;
  }
  return heads;
}
