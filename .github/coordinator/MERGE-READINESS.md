# Exact-head routine merge consumption

SHU-259 consumes the `merge-readiness / MISSING_AUTHORITY` handoff produced by
the durable SHU-258 path. It does not change worker dispatch, activate the host,
or grant itself general repository authority.

## Gates

The path exists only when both independent gates are true:

1. committed `routine_merge_authority.enabled=true` with authority reference
   `SHU-259`, repository, `merge_method=squash`, and `max_per_tick=1`; and
2. runtime `ENABLE_ROUTINE_MERGE=true`.

The repository commits the first gate as `false`. The coordinator workflow also
retains `contents: read`, so this implementation cannot merge live while it is
being reviewed. Worker dispatch and a single-run fixture activation do not imply
merge authority; an activation-requested tick never enters this path.

Immediately before a merge the coordinator re-fetches:

- the authenticated Linear issue, trusted receipt comments, and all explicit
  blocker/hold/protected-action labels;
- the unique open PR for the receipt repository and branch and its exact head;
- the current protected base branch and ancestry of the approved head;
- the approved commit tree;
- every required status/check result (bounded, complete reads);
- every review thread (paginated); and
- GitHub's clean/mergeable branch-protection result.

Only an exact-head `PASS` from the existing independent-review provenance gate
is eligible. The PASS must be the latest durable same-branch receipt, bind an
exact-head writer result, and carry exactly `merge-readiness / MISSING_AUTHORITY`.
Untrusted Linear comment authors are excluded by immutable actor ID.

The following issue or PR labels always HOLD: `production`, `deployment`,
`activation`, `credential`, `credentials`, `spend`, `destructive-migration`,
`product-decision`, `type:decision`, and `needs:decision`. `Blocked`, `hold`,
`on-hold`, `on hold`, and unresolved Linear `blockedBy` relations also HOLD.

## Durable transaction

The attempt ID is deterministically derived from the source verdict attempt and
approved head. The transaction is append-only in the existing Linear comment
store:

1. fetch all authority;
2. append and read back `PREPARED`, binding issue, PR, head, head tree, current
   base, squash method, and `SHU-259` authority;
3. re-fetch every authority input again;
4. send `PUT /pulls/{number}/merge` with both `sha=<approved head>` and
   `merge_method=squash`;
5. re-fetch the merged PR and merge commit; and
6. append and read back `COMPLETED` only when the landed tree equals the
   approved head tree.

Changed heads, advanced bases, ineligible verdicts, red/missing checks,
unresolved threads, explicit holds, forbidden work, incomplete/ambiguous API
responses, unsatisfied protection, and tree mismatches produce enumerated
durable HOLD records. They never fall through to another candidate in the same
tick.

A lost merge response is resolved from GitHub's durable PR state. If the PR is
merged at the approved head and the landed tree matches, the original attempt is
completed without another merge request. If the outcome cannot be proved, it is
held. Duplicate ticks, process restart, and already-merged replay read the same
deterministic terminal record and perform no second action.

## Tests

`test/merge-readiness.test.mjs` covers the successful transaction, main-loop
wiring with dispatch disabled, gates-off behavior, all protected-action labels,
explicit labels/blockers, advanced base, branch protection, stale head,
same-family verdict, required checks, blocking threads, duplicate/restart,
lost response, already-merged recovery, and landed-tree mismatch.

The named mutation battery kills eight independent changes: stale head,
self/same-family verdict, red check, unresolved thread, explicit hold, duplicate
merge, lost response recovery, and tree equality. Every mutant must die by the
named assertion rather than syntax/import failure.
