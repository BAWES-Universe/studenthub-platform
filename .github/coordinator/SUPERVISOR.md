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

## Dispatch transport (SHU-250)

Production dispatch and LAUNCH_UNKNOWN recovery submit through
`supervisor-dispatch.mjs`. RUNNING receipts query that same socket. There is no
production direct-adapter fallback. The existing `io.adapterModules` seam remains
for adapter unit fixtures; `io.supervisorTransport` exercises the real dispatch
transport in deterministic coordinator tests.

Set `SHU_SUPERVISOR_SOCKET` to the private Unix socket and supply the same
at-least-32-byte `SHU_SUPERVISOR_SECRET` to coordinator and supervisor. The HMAC
covers protocol version, operation (submit/status), and the entire work order,
including its prepared checkout and workspace scope. Credentials are inherited
by the service/child, never persisted in work orders. Protect the service's state
root and socket parent from other users. Only one service owns a socket.

The socket and durable result contract is **2.0.0**. Unknown versions fail closed.
Status requests authenticate and bind the attempt, repository, branch, role,
runtime, issue, authorization reference and input head. Successful acknowledgments
mean durable acceptance, not worker completion. An unavailable service or lost
acknowledgment leaves LAUNCH_UNKNOWN for an identical retry. A write-ahead note
identifies supervised launch intent; legacy ambiguous launches without it stay
occupied and are never submitted as new children. Status transport
failure HOLDs; it never authorizes successful completion.

Results retain the adapter's `callback` (attempt_id, target_sha, stage, links,
result_sha), worker_identity and diagnostic evidence verbatim. Exit-only records
have no callback authority and yield receipt HOLD, including a worker that dies
mid-session. The coordinator requires a verified live head and checks any carried
result_sha against it before the unchanged receipt machine checks callback and
review provenance. A wrapper heartbeat records wrapper liveness only, not worker
progress. Missing heartbeats never release capacity or declare a worker dead.
Deadlines and output limits retain their explicit supervisor HOLD behavior.

`createSupervisorSpawner` in `supervisor-worker.mjs` forks the adapter wrapper;
the supervisor owns its process group, deadline, output count and durable result.
The default reviewed `supervisor-authorization.mjs` rechecks the existing gates at
launch and publication. For an activation, the service needs
`SHU_SUPERVISOR_ACTIVATION_FILE` and `DISPATCH_TARGET_SHA`, as well as the same
credentials/workspace settings required by the adapters. Host policy can provide
an absolute authorization module exporting synchronous `authorizeWorkOrder(order)`;
only literal true permits work. Policy cannot be supplied by a work order.

Compose `DurableSupervisor({ stateDir, secret, spawnWorker:
createSupervisorSpawner({ stateDir, env }) })`, call `recover()` before listening,
and bind with `listenSupervisor`. SHU-251 owns service installation, credential
delivery and host-specific runtime wiring. Nothing in this change installs or
starts a daemon, enables dispatch, or proves live concurrency.

Each branch has an append-only ownership chain. Atomic claim creation elects
one owner across differing attempt IDs; an ambiguous claim or unfinished/HOLD
owner cannot be replaced. Existing attempt IDs still have immutable work orders
and the durable pre-spawn marker. Do not remove claims to retry ambiguous work.

## Reviewed fixture operator loop

`fixture-driver.sh` is the bounded replacement for the unversioned driver loop.
It shares the `host-tick.sh` nonblocking lock. It does not enable any dispatch gate.
Use an already approved activation and a private operator journal directory:

```sh
.github/coordinator/fixture-driver.sh run /absolute/activation.json /absolute/private/fixture.json <Todo-state-UUID> 120
```

The CLI verifies the activation targets the configured fixture and is armed,
snapshots its original assignee and state to a fsynced 0600 exclusive journal,
unassigns it and moves it to Todo, then runs at most 120 ticks, one second apart.
Each tick returns independently of its supervised worker. Episode termination is
computed by the existing routing code against durable receipts and the live head.
A single builder completion does not end the review/revision loop.

Normal terminal exit, tick refusal, preparation failure and tick-budget exhaustion
all restore the original state and assignee in `finally`, and read back to verify.
If restoration fails, the command fails and retains the journal. A crash can leave
the fixture prepared; the journal blocks another run until explicitly restored:

```sh
.github/coordinator/fixture-driver.sh restore /absolute/activation.json /absolute/private/fixture.json
```

Restore is deliberately available even when activation has expired. It binds the
journal to the configured fixture. Never delete a retained journal to bypass
recovery. General board selection does not unassign human-owned cards: this
procedure is restricted to the approved fixture. Tests use an in-memory card and
local temporary journals; no Linear updates or host actions are performed.
