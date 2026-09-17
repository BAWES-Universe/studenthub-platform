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
| B | Branch-name linkage + non-closing `refs` reference, then merge | merges; the card does NOT reach Done; the PR attaches to the card | **PASS** — merged as `3133fdf5a18e5dd56959be9c43a4764cb029686a` at `2026-09-17T07:26:52Z`; landed tree == PR head tree; all three PRs attached to the card; **no Done transition** at +2m or +63m |
| C | Explicit authorized transition to Done | reaches Done and holds | **PASS** — deliberate transition at `2026-09-17T08:30:27Z`; still Done at `2026-09-17T08:33:03Z` with no reversion |

**Channel B detail.** After the merge the card's state history remained `Backlog (07:19:46 → 07:20:47)` →
`In Progress (07:20:47 → …)`. The `In Progress` transition at 07:20:47 occurred on the **branch push**,
before the merge, and is the documented behaviour of a *non-closing* reference: linkage still applies the
team's other workflow statuses while the **merge-status** mapping stays off. There was no completion
transition at or after the merge, checked live at +2m and re-read at +63m — which covers the slowest
historical false transition (8m28s) with margin.

**Channel C detail.** The historical false completions were reversed within 1–8 minutes (1m46s, 1m16s,
8m28s, 2m45s); this deliberate transition held for the whole re-check interval, which is the observable
difference between automation and explicit acceptance.

## Recording

- Disposable card `SHU-274`; Linear comment `7be7249a-50d7-43f3-8626-1d28ad2d0f3e` (2026-09-17T08:33:18Z)
  carries this result set; the card is Done and may be archived.
- Harness: `/tmp/linear_proof_d.py` (final form) — the three earlier defects listed above are recorded
  because a proof is only credible if its harness is.
- This file is the in-repository record; the mechanism and the exact setting change are documented in
  the guard package referenced on the card.

## What this does NOT establish

That no other unmeasured channel exists — a custom automation, another integration, or a manual
transition by any actor holding the shared Linear identity. Those remain disclosed exactly as the
repository-policy audit listed them.
