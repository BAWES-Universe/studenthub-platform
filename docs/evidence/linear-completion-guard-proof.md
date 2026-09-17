# Linear completion guard — disposable proof record

**Disposable card:** SHU-274 — Backlog at proof start; archive after this record is appended to the card.
**Owner decision (17 Sep 2026):** disable Linear's GitHub "On PR or commit merge" status mapping;
preserve PR linkage; add no Linear state-write authority. Setting changed to **No action**.

## Mechanism (from Linear's own documentation)

- A **closing** magic word (`close(s|d|ing)`, `fix(es|ed|ing)`, `resolve(s|d|ing)`,
  `complete(s|d|ing)`, `implement(s|ed|ing)`, `linear issue`) in a PR title/body applies the team's
  **"On PR or commit merge"** status when the PR merges; in a commit message reaching the default
  branch it moves the issue to Done.
- A **non-closing** word (`refs`, `part of`, `contributes to`, `toward(s)`) links the PR but does
  **not** apply the merge status. `relates to` / `related to` link with no status change at all.
- `skip <ID>` / `ignore <ID>` prevents linking entirely.
- A branch name containing the issue ID links the PR (started status) but does **not** itself apply
  the merge status — so branch names alone are not the completion channel.

**Incident this guards:** twelve Done->reopened events in ten days (SHU-71 x4, SHU-251 x3,
SHU-63 x5). Five of SHU-63's six Done transitions were reversed within 1-8 minutes
(1m46s, 8m28s, 1m16s, 2m45s) — automation, not a human catching a mistake.

## Pre-state

- Card SHU-274: **Backlog**, no state-history entries when the guard test ran.
- Setting under test: StudentHub team GitHub workflow, "On PR or commit merge" = **No action**.
- Guard test (channel A): a PR whose body carried a closing magic word had the required check
  `repository-policy` conclude **failure** (check run id 105113010425). That PR was closed unmerged.

## Harness defects I found and fixed while running this proof

Recorded because the proof is only credible if the harness is: (1) the first attempt gave PR A and
PR B the *same commit SHA*, so PR B inherited PR A's failed check run and the automated gate
correctly stopped; (2) a fresh checkout lost this record, which then lived only on a proof branch;
(3) `git checkout -B <branch>` with no start-point resets the branch to HEAD and discarded the
record commit. The final harness writes this file fresh from `origin/main` and gives each PR its own
commit.

## Results

| # | Channel | Expected | Observed |
|---|---|---|---|
| A | Closing magic word in PR body | required check `repository-policy` FAILS | **FAILURE** (check 105113010425) — confirmed |
| B | Branch-name linkage + non-closing `refs` reference, then merge | merges; the card does NOT reach Done; the PR attaches to the card | _pending observation_ |
| C | Explicit authorized transition to Done | reaches Done and holds | _pending_ |

Observation window for B: +2m, +15m and +60m after the merge, covering the slowest historical
false transition (8m28s) with margin.
