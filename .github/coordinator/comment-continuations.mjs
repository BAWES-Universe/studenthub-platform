// Comment continuations: one comment thread carried across several Linear issues.
//
// Linear caps how many comments one issue may hold. The standing review card
// SHU-304 reached that cap on 23 Nov (2,000 comments), and from then on every
// receipt write to it was refused. comment_continuations in config.json names,
// for an issue whose thread is full, the issues its thread continues on:
//
//   "comment_continuations": { "SHU-304": ["SHU-711"] }
//
// Read: the thread of SHU-304 is its own comments followed by each
// continuation's comments, in the listed order, as if one thread. Each issue's
// comments keep the order Linear returned them in; all of the original's come
// before any continuation's.
// Write: every comment aimed at SHU-304 goes to the LAST continuation listed.
// A continuation issue is never a card of its own: the board read drops it.
// A missing key, or an empty list, changes nothing.
//
// This module is pure: validation and merging only. The Linear reads that
// resolve a continuation's UUID live beside sendLinear in reconcile.mjs.

export const COMMENT_CONTINUATIONS_KEY = "comment_continuations";
const ISSUE_ID_RE = /^SHU-\d+$/;

// resolveCommentContinuations — the committed continuations as a Map from the
// original issue identifier to its frozen, ordered continuation identifiers.
// Absent is an empty Map; present but malformed is a refusal (it throws), so a
// typo can never send receipts to the wrong card or hide one from the tick.
export function resolveCommentContinuations(config = {}) {
  const value = config?.[COMMENT_CONTINUATIONS_KEY];
  const map = new Map();
  if (value === undefined) return map;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${COMMENT_CONTINUATIONS_KEY} must map an issue identifier to a list of continuation issue identifiers`);
  }
  const claimed = new Map(); // continuation -> the original it continues
  for (const [original, list] of Object.entries(value)) {
    if (!ISSUE_ID_RE.test(original)) throw new Error(`${COMMENT_CONTINUATIONS_KEY} key ${JSON.stringify(original)} must be an issue identifier like SHU-123`);
    if (!Array.isArray(list)) throw new Error(`${COMMENT_CONTINUATIONS_KEY}.${original} must be a list of issue identifiers`);
    const seen = new Set();
    for (const id of list) {
      if (typeof id !== "string" || !ISSUE_ID_RE.test(id)) {
        throw new Error(`${COMMENT_CONTINUATIONS_KEY}.${original} may list only issue identifiers like SHU-123`);
      }
      if (id === original) throw new Error(`${COMMENT_CONTINUATIONS_KEY}.${original} may not list itself`);
      if (seen.has(id)) throw new Error(`${COMMENT_CONTINUATIONS_KEY}.${original} lists ${id} twice`);
      if (claimed.has(id)) throw new Error(`${COMMENT_CONTINUATIONS_KEY}: ${id} continues both ${claimed.get(id)} and ${original}`);
      seen.add(id);
      claimed.set(id, original);
    }
    map.set(original, Object.freeze([...list]));
  }
  // No chains: a continuation is not itself continued, and an original is
  // never another issue's continuation. Each thread is one original plus a list.
  for (const [id, original] of claimed) {
    if (map.has(id) && map.get(id).length) throw new Error(`${COMMENT_CONTINUATIONS_KEY}: ${id} continues ${original} and may not have continuations of its own`);
    if (map.has(id)) throw new Error(`${COMMENT_CONTINUATIONS_KEY}: ${id} continues ${original} and may not be listed as an original`);
  }
  return map;
}

// The continuation identifiers of a non-empty list, for every original.
// These are never cards: the board read leaves them out.
export function continuationIssueIds(continuations) {
  const ids = new Set();
  for (const list of continuations.values()) for (const id of list) ids.add(id);
  return ids;
}

// The continuations of one issue; [] when it has none.
export function continuationsOf(continuations, identifier) {
  return continuations.get(identifier) ?? [];
}

// mergeCommentThreads — the original's comments, then each continuation's, in
// the order given. Nothing is re-sorted: each issue keeps Linear's own order.
//
// A comment a later thread repeats exactly (same author, same receipt) is the
// same logical record and is kept once. Two receipts on different threads that
// claim the same attempt, stage and last_activity but say different things
// cannot both be true, so the merged read fails closed with an error instead.
// `parse` reads a receipt from a comment body (reconcile.mjs passes its own
// parser, so this module stays free of it); without it nothing is compared.
// Returns { comments } or { error }.
export function mergeCommentThreads(threads, { parse = null } = {}) {
  const merged = [];
  const seen = new Map(); // logical key -> canonical receipt JSON
  const seenComments = new Set(); // author + canonical receipt JSON
  for (const [index, thread] of (threads ?? []).entries()) {
    const own = [];
    for (const comment of thread ?? []) {
      const receipt = typeof parse === "function" ? parse(comment?.body) : null;
      if (!receipt || typeof receipt !== "object" || typeof receipt.attempt_id !== "string") { merged.push(comment); continue; }
      const canonical = JSON.stringify(receipt);
      const identity = `${comment?.user?.id ?? ""}\u0000${canonical}`;
      const key = `${receipt.attempt_id}\u0000${receipt.stage ?? ""}\u0000${receipt.last_activity ?? ""}`;
      if (index > 0 && seenComments.has(identity)) continue; // the same record, carried twice
      if (index > 0 && seen.has(key) && seen.get(key) !== canonical) {
        return { error: `conflicting receipts for attempt ${receipt.attempt_id} (${receipt.stage ?? "no stage"}) across the comment thread and its continuation` };
      }
      own.push([key, canonical, identity]);
      merged.push(comment);
    }
    for (const [key, canonical, identity] of own) {
      if (!seen.has(key)) seen.set(key, canonical);
      seenComments.add(identity);
    }
  }
  return { comments: merged };
}
