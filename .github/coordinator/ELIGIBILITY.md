# Coordinator eligibility contract

The coordinator may reserve a card only when every rule below is true at the
authoritative recheck immediately before the reservation comment is written.

- State is exactly `Todo`. `Backlog` is parked work, not a ready queue.
- No delegate, assignee, active receipt, or claiming open pull request exists.
- All `blockedBy` relations resolve to `Done`. Missing/inaccessible blocker
  state and canceled predecessors remain blocking until the relation is
  explicitly removed or dispositioned.
- `needs:decision` is absent.
- `risk:R2` and `risk:R3` cards name `verifier:<name>`. An implementation worker
  cannot also be its named verifier.
- Exactly one recognized repository ownership label exists:
  `repo:platform`, `repo:legacy`, or `repo:infrastructure`. A label is resolved
  to its real repository; the Linear query's repository never supplies or
  overwrites ownership. Missing, unknown, multiple, or out-of-pilot ownership
  HOLDs.
- GitHub open-PR claim evidence is available. A PR claims a card through its
  branch, title, or an explicit `Fixes`/`Closes`/`Resolves` body reference. A
  bare dependency or contextual body mention is not a claim.

The same checks run again after lifecycle/backfill processing and before the
coordinator writes `RESERVED`. A failed lookup, changed claim, changed blocker,
changed verifier, or changed repository aborts with no reservation or launch.

`enable_dispatch` remains the independent activation gate; satisfying this
contract does not enable dispatch.
