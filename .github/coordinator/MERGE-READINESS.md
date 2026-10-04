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
- the current protected base branch, its ref and SHA, ancestry of the approved
  head, and `required_status_checks.strict === true`;
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
   base ref and SHA, squash method, and `SHU-259` authority;
3. re-fetch every authority input again and compare the PR number, base ref,
   base SHA, and approved tree with the durable intent;
4. send `PUT /pulls/{prepared.pr_number}/merge` with both `sha=<approved head>` and
   `merge_method=squash`;
5. re-fetch the merged PR and merge commit; and
6. append and read back `COMPLETED` only when the landed tree equals the
   approved head tree.

GitHub's REST merge endpoint binds `sha` to the head; it has no expected-base-SHA
parameter. Base freshness therefore requires GitHub's server-enforced strict
status-check protection, in addition to the base ref/SHA and ancestry checks
above. A base advance after the final read must be rejected by that protection
before landing. The merge credential must be subject to branch protection
(without a bypass); this module never requests a bypass or changes protection.
Missing or false `strict` yields `BRANCH_PROTECTION_UNSATISFIED` before any PUT.
See [GitHub's strict protection API](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection)
and [merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).

Changed heads, advanced bases, ineligible verdicts, red/missing checks,
unresolved threads, explicit holds, forbidden work, incomplete/ambiguous API
responses, unsatisfied protection, and tree mismatches produce enumerated
durable HOLD records. They never fall through to another candidate in the same
tick.

A lost merge response is resolved from GitHub's durable PR state. If the PR is
merged at the approved head and the landed tree matches, the original attempt is
completed without another merge request. If the outcome cannot be proved, it is
held. Recovery also compares the PR number and base ref with the prepared
intent before attesting completion. A surviving `PREPARED` that fails authority
becomes a typed HOLD retaining all immutable fields. Legacy intents without a
base ref remain readable and can only HOLD, never authorize another PUT.
Duplicate ticks, process restart, and already-merged replay read the same
deterministic terminal record and perform no second action.

## Tests

`test/merge-readiness.test.mjs` covers the successful transaction, main-loop
wiring with dispatch disabled, gates-off behavior, all protected-action labels,
explicit labels/blockers, advanced base, branch protection, stale head,
same-family verdict, required checks, blocking threads, duplicate/restart,
lost response, already-merged recovery, landed-tree mismatch, both restart entry
points after a durable PREPARED write, a frozen intent captured at blocked head
`79c82947f376112a422457ae822f8c3e27e72a7b`, PR/base-ref drift through pre-merge and
recovery, missing strict protection, server rejection of a base race, and the
`SHU259_SCHEMA_BINDING` assertion for all eleven resolved schema hold codes.

The named mutation battery kills eight independent changes: stale head,
self/same-family verdict, red check, unresolved thread, explicit hold, duplicate
merge, lost response recovery, and tree equality. Every mutant must die by the
named assertion rather than syntax/import failure.
