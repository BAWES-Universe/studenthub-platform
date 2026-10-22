// repair-eligibility.mjs — the one card rule a landing repair runs under
// (self-repair B1; Codex consult on SHU-86, Q3).
//
// WHY THIS EXISTS
//
// When a card run opens its pull request, Linear's GitHub integration moves the
// card to In Progress and assigns it to the owner (SHU-327 and SHU-328 both did,
// right as their pull requests opened). The coordinator dispatches only
// unassigned Todo cards with no open pull request (reconcile.mjs rules 2-5), and
// card-prepare refuses an owned or started card, so a repair of that very pull
// request would always be refused. A repair must never move a card either.
//
// So a landing-repair activation, and only it, replaces those rules for its own
// bound card with this predicate. Both the coordinator's eligibility and
// card-prepare call it, so the two can never disagree about which card a repair
// may touch. Every other card, and every activation without the repair keys,
// keeps today's rules unchanged.
//
// THE RULE (all must hold, else a named refusal):
//   * the state is Todo or In Progress;
//   * no delegate;
//   * no assignee, or an assignee whose immutable Linear user id is one of the
//     configured owners (linear_callback_actor_ids). Display names are never
//     compared: anyone can choose one;
//   * a COMPLETE read of the open pull requests finds exactly one claiming the
//     card, and it is the record's repair_pr. A read that could not prove it saw
//     every open pull request (a page cap, a failed page) refuses;
//   * that pull request is in the pilot repository (base and head), based on
//     main, from coordinator/<card>, open, and its head is the head this step is
//     bound to (the passed head for the first step).

export const REPAIR_STATES = Object.freeze(["Todo", "In Progress"]);
export const REPAIR_BASE_REF = "main";
const SHA_RE = /^[0-9a-f]{40}$/;

export function repairEligible({ issue, repair, owners, pulls, repo, head = repair?.initial_target_sha } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!issue || typeof issue.id !== "string" || !issue.id) return no("the repair card cannot be read");
  if (!repair || !Number.isSafeInteger(repair.repair_pr) || repair.repair_pr < 1 || !SHA_RE.test(head ?? "")) {
    return no("the repair binding is incomplete (repair_pr and head)");
  }
  if (!REPAIR_STATES.includes(issue.state)) return no(`state "${issue.state ?? "<unknown>"}" is not one of ${REPAIR_STATES.join(", ")}`);
  if (issue.delegate) return no("the card is delegated; a delegate owns it");
  if (issue.assignee) {
    const id = issue.assignee.id;
    if (typeof id !== "string" || !id || !Array.isArray(owners) || !owners.includes(id)) {
      return no("the card is assigned to someone other than the configured owner (compared by Linear user id)");
    }
  }
  if (!pulls || pulls.complete !== true || !Array.isArray(pulls.items)) {
    return no(`the open pull requests claiming the card could not be read completely${pulls?.reason ? ` (${pulls.reason})` : ""}`);
  }
  if (pulls.items.length !== 1) return no(`${pulls.items.length} open pull requests claim the card; a repair needs exactly one`);
  const [pr] = pulls.items;
  if (pr?.number !== repair.repair_pr) return no(`the open pull request claiming the card is #${pr?.number ?? "?"}, not repair_pr #${repair.repair_pr}`);
  if (typeof repo !== "string" || pr.base?.repo?.full_name !== repo || pr.head?.repo?.full_name !== repo) {
    return no(`#${pr.number} is not a ${repo ?? "<unconfigured>"} pull request from that repository`);
  }
  if (pr.base?.ref !== REPAIR_BASE_REF) return no(`#${pr.number} is based on ${pr.base?.ref ?? "<unknown>"}, not ${REPAIR_BASE_REF}`);
  if (pr.head?.ref !== `coordinator/${issue.id}`) return no(`#${pr.number} is from ${pr.head?.ref ?? "<unknown>"}, not coordinator/${issue.id}`);
  if (pr.state !== "open") return no(`#${pr.number} is ${pr.state ?? "in an unknown state"}, not open`);
  if (pr.head?.sha !== head) return no(`#${pr.number} head is ${pr.head?.sha ?? "<unknown>"}, not the bound head ${head}`);
  return { ok: true, reason: null };
}

// The open pull requests of a repository, every page of them, or a read that
// says it is incomplete. GitHub returns at most REPAIR_PULL_PAGE per page; a
// short page is the last. A read that reaches its page cap while pages are
// still full cannot prove it saw them all, so it is incomplete, never trimmed.
// A pull request seen twice (pages shift while they are read) counts once.
export const REPAIR_PULL_PAGE = 100;
export const REPAIR_PULL_MAX_PAGES = 10;

export async function readOpenPulls({ repo, token, fetchImpl = fetch, maxPages = REPAIR_PULL_MAX_PAGES } = {}) {
  const incomplete = (reason) => ({ complete: false, items: [], reason });
  if (!token) return incomplete("GITHUB_TOKEN is unavailable");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) return incomplete("no pilot repository is configured");
  const byNumber = new Map();
  for (let page = 1; page <= maxPages; page += 1) {
    let pulls;
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=${REPAIR_PULL_PAGE}&page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "coordinator-dry-run" },
      });
      if (!res.ok) return incomplete(`open pull request page ${page} failed with HTTP ${res.status}`);
      pulls = await res.json();
    } catch (error) {
      return incomplete(`open pull request page ${page} could not be read (${error?.message ?? "error"})`);
    }
    if (!Array.isArray(pulls)) return incomplete(`open pull request page ${page} was not an array`);
    for (const pr of pulls) if (Number.isSafeInteger(pr?.number) && !byNumber.has(pr.number)) byNumber.set(pr.number, pr);
    if (pulls.length < REPAIR_PULL_PAGE) return { complete: true, items: [...byNumber.values()], reason: null };
  }
  return incomplete(`more than ${maxPages * REPAIR_PULL_PAGE} open pull requests; the read stops at its page cap`);
}
