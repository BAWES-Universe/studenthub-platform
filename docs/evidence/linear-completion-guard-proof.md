# Linear completion guard — disposable proof record

**Disposable card:** SHU-274 (Backlog at proof start) — archive after recording.
**Owner decision:** disable Linear's GitHub "On PR or commit merge" status mapping; preserve PR
linkage; add no Linear state-write authority. Setting changed 2026-09-17 to **No action**.
**Mechanism (Linear's own docs):** a *closing* magic word in a PR title/body applies the team's
"On PR or commit merge" status; a *non-closing* word (`refs`, `part of`, `contributes to`,
`toward(s)`) links without applying it; `relates to` links with no status change; `skip`/`ignore`
+ ID prevents linking entirely. Branch names containing the issue ID link the PR (started status)
but do not themselves apply the merge status.
**Record of the incident this guards:** twelve Done→reopened events in ten days (SHU-71 x4,
SHU-251 x3, SHU-63 x5); five of SHU-63's six Done transitions were reversed within 1-8 minutes.

## Results

| # | Channel | Expected | Observed |
|---|---|---|---|
| A | Closing magic word in PR body | required check `repository-policy` FAILS | _pending_ |
| B | Branch-name linkage + non-closing reference, then merge | merges; SHU-274 stays non-terminal; PR attaches to SHU-274 | _pending_ |
| C | Explicit authorized transition to Done | reaches Done and holds | _pending_ |

Observations for B are taken at +2m, +15m and +60m after the merge so the window covers the
slowest historical false transition (8m28s) with margin. The disposable card is archived after
the record is appended to the Linear card.
