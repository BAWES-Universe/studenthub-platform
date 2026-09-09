# Durable worker supervisor

SHU-67 separates worker lifetime from the one-shot coordinator process. The
coordinator signs an exact work order and submits it to an owner-only Unix
socket. A successful acknowledgement means the order is durable; it does not
mean the child has completed. The supervisor schedules each attempt
independently and owns its child, deadline, bounded-output accounting, and
terminal state.

Safety properties:

- The HMAC covers the attempt, repository, branch, exact head, role, runtime,
  authorization reference, and task context. Tampering fails before disk or
  process side effects.
- An attempt ID is immutably bound to one work order. Exact retries are
  idempotent; conflicting retries HOLD.
- A durable `spawn_attempted` marker precedes process creation. An ambiguous
  restart HOLDs rather than launching a possible duplicate.
- RUNNING requires real process-start evidence supplied by the host adapter;
  a PID plus a timestamp manufactured by the supervisor is not identity.
- Accepted-but-not-launched work resumes after restart. Completed state remains
  terminal. Running workers whose identity cannot be proved remain occupied in
  HOLD and are never silently replaced.
- The worker wrapper receives a per-attempt completion token and calls
  `recordSupervisorCompletion` against the
  private state root. The receipt carries the token in its immutable 0600 file
  so restart re-validates it against the launch-time token hash before trusting
  it. Its terminal receipt is therefore recoverable even if the supervisor
  is unavailable when the child exits; forged or stale-head receipts fail.
- Worker output is counted, not stored, and is capped. Deadlines terminate and
  HOLD incomplete work.
- An unavailable daemon returns HOLD. There is intentionally no direct-spawn
  fallback in the client.
- The one-shot entry seam checks `dispatchEnabled === true` before contacting
  IPC. Disabled dispatch performs no launch or durable write.
- Selection precedes the seam. Eligibility Rule 6 (SHU-219): a child of an open
  or Done parent is dispatchable (a sub-issue completes before its parent); only
  children of terminal-canceled parents (`Canceled`/`Duplicate`) are excluded.
  Blockers (Rule 7), not parent state, are the ordering mechanism.

The host service must preserve children across a routine supervisor restart
(for systemd, `KillMode=process`, not `control-group`). The default shutdown
path leaves owned children running so their completion receipt remains
authoritative. An explicitly terminating shutdown sends `SIGTERM` and records
HOLD before doing so.

This slice supplies the protocol, durable state machine, private IPC, and
deterministic tests. It does **not** install or activate a daemon, change
`enable_dispatch`, or modify reconcile/routing behavior. Live activation
requires a separately reviewed host service configuration and rollback plan.
