// Landing recovery: a card whose run passed its independent review and opened
// its pull request, then stopped at landing on a wait that ran out
// (CI_TIMEOUT) or a landing error (LAND_ERROR), lands that same pull request
// on a later start, once, under the box's own landing.
//
// WHY THIS EXISTS
//
// A passed run that stops at landing stops its card for good: the queue never
// runs it again ("a stopped card stays stopped"), Linear's GitHub integration
// assigned the card when the pull request opened, so card-prepare refuses it
// (CARD_RUN_CARD_OWNED), and a code install that keeps the queue dry-runs
// every queued card and is refused with it. The passed work could then only
// land by hand. 2026-11-27: SHU-748, SHU-749 and SHU-755 stopped this way
// (CI_TIMEOUT behind main, LAND_ERROR) and every code install was restored.
//
// WHAT IT DOES
//
// Nothing about the stopped run changes: its claim, its receipts, its merge
// attempts, the card's owner and its pull request stay as they are. A start
// that finds such a claim, with no recovery record for its reviewed head,
// first proves, reading only:
//
//   * the pull request is the claim's own: in the pilot repository, from
//     coordinator/<card> into main, open; its head is the reviewed head, or a
//     plain merge of main into it that keeps the reviewed head's own blobs
//     (card-land.mjs updatedHeadHolds, the exact-blobs rule): a head anyone
//     moved any other way needs a new review, and is never reset;
//   * the newest receipt on the card's branch is still the claim's own PASS
//     at the reviewed head, with trusted provenance (card-repair.mjs
//     priorPass): a newer verdict, a BLOCK or another episode, stops it;
//   * the card's owner is no one or a configured owner, by Linear user id, it
//     has no delegate, it is Todo or In Progress, and exactly one open pull
//     request claims it, this one, at this head (repair-eligibility.mjs, the
//     rule a landing repair runs under): anyone else's claim stops it;
//   * the pause file is absent.
//
// Only then is the recovery record written, exclusively, named by the
// reviewed head: one bounded attempt per passed head, whatever revision is
// installed and however often a start wakes. The landing then runs as a
// landing with more than one worker does: it brings the pull request up to
// main with the exact-blobs rule, waits for the required checks at that head,
// takes the host-wide landing lock for the merge step (so it is serialised
// with every other final landing), and merges through the SHU-259 consumer at
// that exact head. A merge attempt already recorded for the PASS at the head
// being landed is never resumed: a recovery only ever writes a new attempt
// for a new head. A merge whose completion could not be read back is proven
// from GitHub later (card-landed.mjs), never assumed.
//
// It never arms, builds or reviews anything, and it never moves the card.
import path from "node:path";
import { sendLinear, pullRequestClaimsIssue } from "../reconcile.mjs";
import { ACTIVATION_ID_RE } from "../single-run-activation.mjs";
import { repairEligible, readOpenPulls } from "../repair-eligibility.mjs";
import { claimRound, getJson, priorPass, readRound, repairPullIdentity } from "./card-repair.mjs";
import { updatedHeadHolds } from "./card-land.mjs";

export const RECOVER_LANDS = Object.freeze(new Set(["CI_TIMEOUT", "LAND_ERROR"]));
export const RECOVER_REQUEST_TIMEOUT_MS = 30 * 1000;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// One record per card and reviewed head, ever.
export const recoverRecordPath = (paths, id, reviewedHead) => path.join(paths.stateDir, `card-recover-${reviewedHead}-${id}.json`);
export const recoverActivationId = (id, reviewedHead) => `${String(id).toLowerCase()}-recover-${reviewedHead.slice(0, 12)}`;

// A claim a recovery may start from: this card's own timer run, at any
// revision (an appended install carries it over), which passed its review and
// stopped at landing on a wait that ran out or a landing error, with the pull
// request, the reviewed head and the episode it recorded.
export function recoverCandidate(claim, { id, repo }) {
  return claim?.card === id && claim.outcome === "PASS" && RECOVER_LANDS.has(claim.land)
    && REPO_RE.test(repo ?? "") && claim.repo === repo && Number.isSafeInteger(claim.pr) && claim.pr > 0
    && SHA_RE.test(claim.reviewed_head ?? "") && ACTIVATION_ID_RE.test(claim.activation_id ?? "");
}

export function recoverSkip(code, detail) {
  throw Object.assign(new Error(`${code}: ${detail}`), { code, recoverSkip: true });
}

// The proofs that can never pass again for this reviewed head: the pull
// request or its head is not the claim's, a newer verdict or another owner
// holds the card. Each is recorded once as the head's finished record, so the
// card stays stopped, the start says why, and with more than one worker the
// cards queued after it still run. A read that failed, the pause or a race
// records nothing, and a later start tries again.
export const RECOVER_REFUSALS = Object.freeze(new Set(["RECOVER_NOT_ELIGIBLE", "RECOVER_HEAD_UNPROVEN"]));
function recordRefusal(io, file, fields) {
  try {
    io.fs.writeFileSync(file, `${JSON.stringify({ ...fields, state: "finished", land: null })}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch { return false; /* a record is already there, or none could be written: a later start reads it, or proves again */ }
}

// What a recoverable claim means for this start. No record: recover it. A
// record another worker is still working: running elsewhere. Any other
// record, finished, refused or never finished: no second attempt, the card
// stays stopped, and the stop says why.
export function recoverStep(io, paths, id, claim, { live = () => false } = {}) {
  const file = recoverRecordPath(paths, id, claim.reviewed_head);
  if (!io.fs.existsSync(file)) return { next: { id, recover: claim } };
  const round = readRound(io, file);
  if (round?.state !== "finished" && live(round)) return { live: true };
  if (round?.state !== "finished") {
    return { note: `; its one landing recovery never finished (${round ? `state ${round.state}` : "an unreadable record"}) and is never run again: ${file}` };
  }
  if (round.refused) return { note: `; its one landing recovery was refused (${round.refused}: ${round.reason ?? "no reason"}): ${file}` };
  return { note: `; its one landing recovery finished (${round.land ?? "no landing"}): ${file}` };
}

export const RECOVER_ISSUE_QUERY = `
  query CardRecoverIssue($id: String!) {
    issue(id: $id) { id identifier state { name type } assignee { id } delegate { id } }
  }`;

// The proof above, then the exclusive record. Every stop before the record is
// a named skip; one that can never pass for this head (RECOVER_REFUSALS) is
// recorded as the head's finished record, any other writes nothing. Returns
// the round and the head to land.
export async function claimRecovery(args) {
  try {
    return await proveAndClaim(args);
  } catch (error) {
    const { io, paths, id, claim, claimant = {} } = args;
    if (error.recoverSkip && RECOVER_REFUSALS.has(error.code) && SHA_RE.test(claim?.reviewed_head ?? "") && claim?.card === id) {
      recordRefusal(io, recoverRecordPath(paths, id, claim.reviewed_head), { card: id, revision: claim.revision ?? null, reviewed_head: claim.reviewed_head,
        recover_of: claim.activation_id ?? null, pr: claim.pr ?? null, stopped_land: claim.land ?? null, refused: error.code,
        reason: error.message.replace(/^[A-Z_]+: /, ""), refused_at: io.now().toISOString(), ...claimant });
    }
    throw error;
  }
}

async function proveAndClaim({ io, paths, config, id, claim, credentials, fetchImpl, gh, holder = null, timeoutMs = RECOVER_REQUEST_TIMEOUT_MS, claimant = {} }) {
  const repo = config.pilot_repo ?? null;
  if (!recoverCandidate(claim, { id, repo })) {
    recoverSkip("RECOVER_NOT_ELIGIBLE", `${id}'s claim is not a passed run of ${repo ?? "the pilot repository"} stopped at landing on ${[...RECOVER_LANDS].join(" or ")}`);
  }
  const file = recoverRecordPath(paths, id, claim.reviewed_head);
  if (io.fs.existsSync(file)) recoverSkip("RECOVER_CLAIMED", `a landing recovery is already recorded: ${file}`);
  const branch = `coordinator/${id}`;
  // The pull request, read now, by the claim's number.
  let read;
  try { read = await getJson(io, `https://api.github.com/repos/${repo}/pulls/${claim.pr}`, credentials.GITHUB_TOKEN, timeoutMs); } catch (error) {
    recoverSkip("RECOVER_UNREADABLE", `pull request #${claim.pr} cannot be read (${error.message})`);
  }
  if (read.status === 404) recoverSkip("RECOVER_NOT_ELIGIBLE", `pull request #${claim.pr} is not in ${repo}`);
  if (!read.ok || !read.body) recoverSkip("RECOVER_UNREADABLE", `pull request #${claim.pr} cannot be read (HTTP ${read.status})`);
  const wrong = repairPullIdentity(read.body, { repo, number: claim.pr, branch });
  if (wrong) recoverSkip("RECOVER_NOT_ELIGIBLE", wrong);
  const head = read.body.head?.sha;
  if (!SHA_RE.test(head ?? "")) recoverSkip("RECOVER_UNREADABLE", `#${claim.pr} has no readable head`);
  // A head other than the reviewed one counts only as a plain merge of main
  // into it that keeps the reviewed blobs; anything else needs a new review.
  if (head !== claim.reviewed_head) {
    const why = await updatedHeadHolds(gh, { repo, passed: claim.reviewed_head, head });
    if (why) recoverSkip("RECOVER_HEAD_UNPROVEN", `#${claim.pr} is at ${head}, which is not proven to hold exactly the change reviewed at ${claim.reviewed_head} (${why}); it needs a new review and is never reset`);
  }
  // The PASS is still the newest word on the card's branch.
  let pass;
  try {
    pass = await priorPass({ fetchImpl, linearToken: credentials.LINEAR_API_TOKEN, actorIds: config.linear_receipt_actor_ids, card: id, repo, claim, config });
  } catch (error) {
    if (!error.repairSkip) throw error;
    recoverSkip(error.code === "REPAIR_UNREADABLE" ? "RECOVER_UNREADABLE" : "RECOVER_NOT_ELIGIBLE", error.message.replace(/^[A-Z_]+: /, ""));
  }
  // Who owns the card now, and which open pull requests claim it.
  let issue;
  try {
    const data = await sendLinear(RECOVER_ISSUE_QUERY, { id }, credentials.LINEAR_API_TOKEN, fetchImpl);
    issue = data?.issue ?? data?.data?.issue ?? null;
  } catch (error) {
    recoverSkip("RECOVER_UNREADABLE", `${id} cannot be read from Linear (${error.message})`);
  }
  if (!issue || issue.identifier !== id) recoverSkip("RECOVER_UNREADABLE", `${id} cannot be read from Linear`);
  const pulls = await readOpenPulls({ repo, token: credentials.GITHUB_TOKEN, fetchImpl });
  const claimedBy = { complete: pulls.complete === true, items: (pulls.items ?? []).filter((pull) => pullRequestClaimsIssue(pull, id)), reason: pulls.reason ?? null };
  const owners = Array.isArray(config.linear_callback_actor_ids) ? config.linear_callback_actor_ids : [];
  const eligible = repairEligible({ issue: { id: issue.identifier, state: issue.state?.name ?? null, assignee: issue.assignee ?? null, delegate: issue.delegate ?? null },
    repair: { repair_pr: claim.pr }, owners, pulls: claimedBy, repo, head });
  if (!eligible.ok) recoverSkip("RECOVER_NOT_ELIGIBLE", `${id}: ${eligible.reason}`);
  // The owner may have paused while GitHub and Linear were read; the pause wins.
  if (io.fs.existsSync(paths.pause)) recoverSkip("PAUSED", `${paths.pause} exists`);
  let round;
  try {
    round = claimRound(io, file, { card: id, revision: claim.revision ?? null, activation_id: recoverActivationId(id, claim.reviewed_head),
      recover_of: claim.activation_id, repo, pr: claim.pr, reviewed_head: claim.reviewed_head, head, pass_attempt_id: pass.attempt_id,
      stopped_land: claim.land, claimed_at: io.now().toISOString(), ...claimant });
  } catch (error) {
    if (error.code === "REPAIR_CLAIMED") recoverSkip("RECOVER_CLAIMED", `a landing recovery is already recorded: ${file}`);
    throw error;
  }
  if (holder) holder.round = round;
  return { round, head };
}
