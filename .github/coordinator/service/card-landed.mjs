// Self-repair plan step A: when a queued card counts as landed.
//
// A timer run that merged its own pull request lands the card, as before: its
// claim reads PASS, ok and MERGED. A card whose run passed its review and
// opened its pull request, but stopped at landing (red checks, a wait that ran
// out, a held merge or held threads), and that a person then merged by hand,
// now counts too, but only when GitHub shows that exact pull request merged
// into main at the head the run's own independent reviewer passed, with the
// merge commit on main's first-parent history. A branch name never proves a
// landing, and a head a person changed after the review never counts: that
// needs a re-arm. A claim written before the run recorded its pull request and
// reviewed head (self-watch 0a) never counts by hand.
//
// Any read that fails, is ambiguous or is incomplete is "not landed", never a
// guess. Once a hand landing is proven it is recorded in the root-owned state
// directory (written exclusively), so a later read failure, or main moving
// past the pages read here, never un-lands it. The read-only plan proves
// without recording.
//
// Self-repair B2: a landing repair's round record (card-repair-<rev>-<id>.json)
// counts like a claim. A finished round whose repair passed and merged is the
// timer's own landing. A finished round that passed and stopped at landing
// may be proven hand-landed exactly as above, at the head the repair's own
// review passed (repaired_head), never at the failed head.
//
// M15: with more than one card worker a landing first brings its pull request
// up to main, and a landing that stopped after that left the pull request at
// the updated head, recorded in the claim (or round) as updated_head. A merge
// at that head counts too, but only when GitHub shows it holds exactly the
// reviewed change: it descends from the reviewed head, merges a commit on
// main, and keeps the reviewed head's own blobs (card-land.mjs
// updatedHeadHolds, the rule the landing took it by). Any other head still
// never counts.
import path from "node:path";
import { updatedHeadHolds } from "./card-land.mjs";

export const HAND_LAND_OUTCOMES = Object.freeze(new Set(["PR_OPENED_CI_RED", "CI_TIMEOUT", "MERGE_HOLD", "THREADS_HELD"]));
// Main's history read for the first-parent walk: pages of 100, newest first.
export const HAND_LAND_PAGES = 3;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const handLandRecord = (paths, id) => path.join(paths.stateDir, `card-hand-landed-${id}.json`);

// Every claim a timer run wrote for this card, at any installed revision, that
// names this card and the revision in its own file name. Anything else proves
// nothing.
function cardClaims(io, paths, id) {
  const name = new RegExp(`^card-run-auto-([0-9a-f]{40})-${id}\\.json$`);
  const claims = [];
  for (const file of io.fs.readdirSync(paths.stateDir)) {
    const match = name.exec(file);
    if (!match) continue;
    try {
      const claim = JSON.parse(io.fs.readFileSync(path.join(paths.stateDir, file), "utf8"));
      if (claim?.card === id && claim.revision === match[1]) claims.push(claim);
    } catch { /* an unreadable claim proves nothing */ }
  }
  return claims;
}

// Self-repair B2: every finished repair round for this card, at any revision,
// that names this card and the revision in its own file name.
function repairRounds(io, paths, id) {
  const name = new RegExp(`^card-repair-([0-9a-f]{40})-${id}\\.json$`);
  const rounds = [];
  for (const file of io.fs.readdirSync(paths.stateDir)) {
    const match = name.exec(file);
    if (!match) continue;
    try {
      const round = JSON.parse(io.fs.readFileSync(path.join(paths.stateDir, file), "utf8"));
      if (round?.card === id && round.revision === match[1] && round.state === "finished") rounds.push(round);
    } catch { /* an unreadable round proves nothing */ }
  }
  return rounds;
}

const mergedByRepair = (round) => round.outcome === "PASS" && round.ok === true && round.land === "MERGED"
  && Number.isSafeInteger(round.pr) && SHA_RE.test(round.repaired_head ?? "");

// A finished repair round as the claim it stands for: the head its own review
// passed is the head a hand landing must have merged.
const roundAsClaim = (round) => ({ outcome: round.outcome, land: round.land, repo: round.repo, pr: round.pr,
  reviewed_head: round.repaired_head ?? null, ...(round.updated_head ? { updated_head: round.updated_head } : {}), revision: round.revision });

const mergedByTimer = (claim) => claim.outcome === "PASS" && claim.ok === true && claim.land === "MERGED";

// A run that passed its review and opened a pull request in the pilot
// repository, then stopped at landing, with the reviewed head recorded.
export function handLandCandidate(claim, repo) {
  return claim?.outcome === "PASS" && HAND_LAND_OUTCOMES.has(claim.land) && REPO_RE.test(repo ?? "") && claim.repo === repo
    && Number.isSafeInteger(claim.pr) && claim.pr > 0 && SHA_RE.test(claim.reviewed_head ?? "");
}

// A proven hand landing, as recorded: it must name this card and its proof.
function recordedHandLanding(io, paths, id) {
  try {
    const record = JSON.parse(io.fs.readFileSync(handLandRecord(paths, id), "utf8"));
    return record?.card === id && Number.isSafeInteger(record.pr) && SHA_RE.test(record.reviewed_head ?? "")
      && SHA_RE.test(record.merge_commit ?? "");
  } catch { return false; }
}

// Only reads ever leave here, whatever token the caller holds.
function readOnly(gh) {
  return (url) => gh("GET", url);
}

// GitHub's word that pull request `pr` merged into main at `reviewedHead`,
// with its merge commit on main's first-parent history. Returns the merge
// commit, or null with the reason.
export async function provenHandLanding(gh, { repo, pr, reviewedHead, updatedHead = null, pages = HAND_LAND_PAGES }) {
  const get = readOnly(gh);
  const base = `https://api.github.com/repos/${repo}`;
  const pull = await get(`${base}/pulls/${pr}`);
  const detail = await pull.json();
  if (!pull.ok || !detail) return { merge: null, reason: `pull request #${pr} cannot be read (HTTP ${pull.status})` };
  if (detail.number !== pr || detail.merged !== true || !SHA_RE.test(detail.merge_commit_sha ?? "")) return { merge: null, reason: `#${pr} is not merged` };
  if (detail.base?.ref !== "main" || detail.base?.repo?.full_name !== repo) return { merge: null, reason: `#${pr} did not merge into main of ${repo}` };
  // M15: or at the head a landing updated it to, when that head still holds
  // exactly the reviewed change.
  const updated = SHA_RE.test(updatedHead ?? "") && updatedHead !== reviewedHead && detail.head?.sha === updatedHead;
  if (detail.head?.sha !== reviewedHead && !updated) {
    return { merge: null, reason: `#${pr} merged at ${detail.head?.sha ?? "an unknown head"}, not the reviewed head ${reviewedHead}${SHA_RE.test(updatedHead ?? "") ? ` or its update ${updatedHead}` : ""}` };
  }
  if (updated) {
    const wrong = await updatedHeadHolds((method, url) => get(url), { repo, passed: reviewedHead, head: updatedHead });
    if (wrong) return { merge: null, reason: `#${pr} merged at the updated head ${updatedHead}, which does not hold the reviewed change: ${wrong}` };
  }
  const merge = detail.merge_commit_sha;
  // Main's first parents, newest first: the merge commit must be one of them.
  const parents = new Map();
  let tip = null;
  for (let page = 1; page <= pages; page += 1) {
    const response = await get(`${base}/commits?sha=main&per_page=100&page=${page}`);
    const list = await response.json();
    if (!response.ok || !Array.isArray(list)) return { merge: null, reason: `main's history cannot be read (HTTP ${response.status})` };
    for (const commit of list) {
      if (!SHA_RE.test(commit?.sha ?? "") || !Array.isArray(commit.parents)) return { merge: null, reason: "main's history has an unreadable commit" };
      tip ??= commit.sha;
      parents.set(commit.sha, commit.parents[0]?.sha ?? null);
    }
    if (list.length < 100) break;
  }
  for (let sha = tip; sha && parents.has(sha); sha = parents.get(sha)) {
    if (sha === merge) return { merge, reason: null, ...(updated ? { updated: true } : {}) };
  }
  return { merge: null, reason: `${merge} is not on main's first-parent history as read` };
}

// Whether the card landed, and how. `gh` is a GitHub reader, or null when none
// is available, in which case only a timer landing or a recorded hand landing
// counts. With `record`, a newly proven hand landing is written down.
export async function cardLanded(io, paths, id, { repo = null, gh = null, record = false, now = () => new Date() } = {}) {
  const claims = cardClaims(io, paths, id);
  if (claims.some(mergedByTimer)) return { landed: true, by: "timer" };
  const rounds = repairRounds(io, paths, id);
  if (rounds.some(mergedByRepair)) return { landed: true, by: "repair" };
  if (recordedHandLanding(io, paths, id)) return { landed: true, by: "hand" };
  const candidates = [...claims, ...rounds.map(roundAsClaim)].filter((claim) => handLandCandidate(claim, repo));
  if (!candidates.length || !gh) return { landed: false };
  let reason = null;
  for (const claim of candidates) {
    let proof;
    try {
      proof = await provenHandLanding(gh, { repo, pr: claim.pr, reviewedHead: claim.reviewed_head, updatedHead: claim.updated_head ?? null });
    } catch (error) {
      proof = { merge: null, reason: `GitHub cannot be read: ${error.message}` };
    }
    if (!proof.merge) { reason = proof.reason; continue; }
    if (record) {
      try {
        io.fs.writeFileSync(handLandRecord(paths, id), `${JSON.stringify({ card: id, revision: claim.revision, pr: claim.pr,
          reviewed_head: claim.reviewed_head, ...(proof.updated ? { updated_head: claim.updated_head } : {}),
          merge_commit: proof.merge, recorded_at: now().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") return { landed: false, reason: `the hand landing cannot be recorded: ${error.code ?? error.message}` };
      }
    }
    return { landed: true, by: "hand", pr: claim.pr, merge: proof.merge };
  }
  return { landed: false, reason };
}
