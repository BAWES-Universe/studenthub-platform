# Reconciliation-only recovery of a dangling `LAUNCH_UNKNOWN`

`reconcile-dangling.mjs` is a **separate, explicit, hand-invoked operator
operation**. It is not part of the coordinator tick and it changes nothing about
the tick's behaviour.

## The state it repairs

`reconcile.mjs:54` counts a receipt as active unless its stage is in
`TERMINAL_STAGES = ["COMPLETED","FAILED","HOLD"]`. A chain left at
`LAUNCH_UNKNOWN` is therefore active **forever**:

* nothing in the lifecycle can terminate it, because `LAUNCH_UNKNOWN` is
  resolved by a supervisor decision about a claim the supervisor never accepted;
* with `max_dispatch: 1` that one chain holds the only capacity slot
  permanently, so no card can ever be dispatched again;
* a dispatch-off tick reports `DRY-RUN (dispatch disabled, no writes)` and makes
  zero writes, so the tick cannot repair it either.

The concrete case this was built for is attempt
`9c461519-4bc8-4e75-8d65-d61b8954e1f0` on issue `SHU-140`, whose chain is
`4bc8e75a` (`RESERVED`) followed by `d65c4d61` and `b8954e1f`
(both `LAUNCH_UNKNOWN`).

## What it does, and what it refuses to do

It writes a terminal `HOLD` receipt for **one** attempt, and only when every
condition below is independently established **during that invocation**.

**Condition 1 — the supervisor's own signed answer, `status` only.**
The operation signs and sends `signedSupervisorRequest(order, secret, "status")`
over `submitToSupervisor` using the service credential, and requires
`hold_code === "MISSING_CLAIM"`. Any other answer — an accepted/running stage, a
different hold code, or a reply carrying no hold code at all (a transport fault)
— leaves the claim unestablished and is refused.

It never signs any other operation. In `supervisor.mjs` `submit()` the status
branch returns **before** `store.accept()` and **before** any
`schedule(() => this.launch(...))`, so a `submit` would mint a durable order, a
branch claim, a run record, a launch marker and a child process.
`sendSupervisorStatus()` throws on any operation other than `status`, before it
reaches the socket.

**Condition 2 — no worker, no external effect.** Each of these is a probe taken
at run time, never a cached snapshot:

| probe | required result |
| --- | --- |
| process table | no live worker process for the attempt |
| attempt worktree | `HEAD` equals the receipt's `scoped_base_sha` and `git status --porcelain` is empty |
| remote branch | branch head still equals the order's `target_sha` |
| push/commit receipts | no push receipt for the attempt |
| supervisor store | no `orders`/`runs`/`launches`/`completions` record for the attempt |

Every probe stamps its own `observed_at`. An observation from **before** this
invocation started is a cached snapshot and is refused as `EVIDENCE_STALE`, not
believed. A probe that does not answer, or throws, is `EVIDENCE_MISSING`.

**It never** reads `ENABLE_DISPATCH`, arms or consumes an activation, loads an
adapter module, retries, resumes or launches anything. On success it writes
exactly one Linear comment (the terminal `HOLD` receipt, produced by the
reviewed `nextReceiptState` state machine). On any refusal it writes nothing and
the slot is preserved.

## Refusal codes

Refusals are by name. There is deliberately no generic failure: each code
implies a different repair.

| code | meaning |
| --- | --- |
| `RECONCILE_REFUSED: ALREADY_TERMINAL` | the chain is already `COMPLETED`/`FAILED`/`HOLD`; nothing to free |
| `RECONCILE_REFUSED: NOT_DANGLING` | the resolved stage is live (`RESERVED`/`RUNNING`), not a dangling launch |
| `RECONCILE_REFUSED: SUPERVISOR_CLAIM_PRESENT` | the supervisor still owns this attempt (status answer, or a durable store record) |
| `RECONCILE_REFUSED: WORKER_LIVE` | a worker process for this attempt is still running |
| `RECONCILE_REFUSED: WORKTREE_CHANGED` | the worktree moved off its recorded scoped base, or is dirty |
| `RECONCILE_REFUSED: BRANCH_MOVED` | the branch's remote head no longer equals `target_sha` |
| `RECONCILE_REFUSED: PUSH_RECEIPT_PRESENT` | a push/commit receipt exists: an external effect may have landed |
| `RECONCILE_REFUSED: EVIDENCE_MISSING` | a required probe did not answer |
| `RECONCILE_REFUSED: EVIDENCE_STALE` | a probe answered from before this invocation |

## Idempotence

Terminality is decided from the durable chain **before** any supervisor contact
and before any probe. A second invocation therefore refuses `ALREADY_TERMINAL`
without writing anything, without contacting the supervisor, and without any
possibility of creating a slot, a receipt or a launch.

## Running it

```
LINEAR_API_TOKEN=… GITHUB_TOKEN=… \
SHU_SUPERVISOR_SOCKET=… SHU_SUPERVISOR_STATE_DIR=… \
SHU_WORKTREE_ROOT=… SHU_WORKSPACE_STATE_DIR=… \
node .github/coordinator/reconcile-dangling.mjs \
  --reconcile-dangling 9c461519-4bc8-4e75-8d65-d61b8954e1f0
```

The flag takes exactly one argument and no other flags are accepted, so no
dispatch or activation switch can be smuggled onto the command line.

Exit codes: `0` terminalized, `2` bad usage, `3` refused by name (slot
preserved, nothing written).

## Proofs

`.github/coordinator/test/receipt-state.test.mjs`, the six
`SHU-140 reconcile-dangling:` cases. All I/O is injected, so the proofs need no
git, no `/proc`, no socket and no network, and the file's audited capability set
stays `[]`.
