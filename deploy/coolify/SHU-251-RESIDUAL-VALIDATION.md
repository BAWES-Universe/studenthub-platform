# SHU-251 residual acceptance: prepared, host pending

Base main: `43c6d923f2f66b303f4851c2f01fa43a86566c75`. Implementation branch:
`feat/shu251-residual-acceptance`, clone `/home/bawes/work/shu251r`.
The delivery response identifies the committed SHA. No host access, /srv writes,
systemd interaction, deployment, Coolify action, push or PR was performed.
Committed `enable_dispatch` remains false. Test-only activation and runtime gates
exist solely inside private temporary sandboxes, with fake network IO.

## Boundary and future window prerequisites

All three items now have executable local acceptance assertions. They prove the
coordinator selection path, real-process supervisor lifecycle and status contract
in a sandbox. They do **not** prove installed unit startup, readiness notification,
service-manager worker preservation, deployed permissions/credentials, timer
wakes, crash recovery, or running-system rollback. A routine restart is tested:
the old supervisor process exits cleanly while its real worker stays alive.
An unclean crash leaves a stale socket and remains an operator-inspection HOLD.
No claim of SIGKILL crash recovery or automatic stale-socket removal is made.

In the later **approved** host window, use a reviewed checkout of the delivered
SHA as the intended non-root service identity, with Node and lockfile dependencies
available. Set `EVIDENCE` to a private evidence directory in that checkout or a
private temporary directory. Do not point sandbox paths at deployed durable state.
Run from the checkout root:

```sh
umask 0077
EVIDENCE=$(mktemp -d "${TMPDIR:-/tmp}/shu251-evidence.XXXXXX")
git rev-parse HEAD > "$EVIDENCE/revision.txt"
node --version > "$EVIDENCE/node-version.txt"
export SHU251_NO_SYSTEMD=1
```

Preserve exit codes (do not hide failures behind a pipe), the TAP files and revision.
The following commands close the **sandbox acceptance** items on the host runtime.
They alone cannot close acceptance of the deployed service. For that distinction,
record both the sandbox result and the separately approved live evidence below.
Never turn on the deployed dispatch gate merely to run these commands.

## 1. Non-vacuous gate-off inertness

```sh
node --test --test-name-pattern='SHU251_GATE_OFF_POSITIVE_CONTROL|suppress positive-control launch' .github/coordinator/service/test/residual.test.mjs > "$EVIDENCE/gate.tap" 2>&1
```

Test: `SHU251_GATE_OFF_POSITIVE_CONTROL same pending tick differs only by gate`.
The same `main()` tick uses one pending eligible issue/attempt opportunity and a
free slot. It runs off first, then on with only `ENABLE_DISPATCH` changed. Config,
activation, clock, selection inputs, injected adapters and IO are identical;
the committed-style fixture config gate stays false. The off report must say
`eligible=1`, name `SHU-140 via codex-cli` as the next reservation, and say dispatch
is disabled. Assert zero adapter launches, zero GraphQL mutations, and exact
bytes/modes/mtime/ctime plus in-memory state preservation. The on run must produce
exactly one launch and actual fixture receipt writes. TAP diagnostics record both.
The armed fixture activation permits the runtime-only positive control; this does
not redefine the production gate policy.

**Without this positive control, inertness is vacuous:** a tick with no eligible
work or no capacity can do nothing even with dispatch enabled. The older monitor
control in `verifyKillSwitch` does not establish this selection/launch fact.

Mutation test: `SHU251 mutation: suppress positive-control launch`. This substitutes
a non-launching adapter; it must die with AssertionError text:
`SHU251_GATE_OFF_POSITIVE_CONTROL: the same eligible pending work with free capacity must launch exactly once when only the gate changes`.
The existing quiet assertions independently reject launches, mutations and state drift.

Host closure additionally needs the approved deployed gate-off tick report and
before/after authoritative inventories (coordinator and supervisor), zero transport
launches and zero remote mutations. Pair that evidence with this controlled
would-launch test; do not enable production dispatch for the positive run.
HALT on a missing eligible candidate, an on-run count other than one, any off-run
write/launch, or a changed committed gate. Retain evidence, stop the fixture and
leave dispatch disabled; do not retry a production attempt or delete its receipts.

## 2. Routine restart with a live worker

```sh
node --test --test-name-pattern='live worker restart|duplicate spawn evidence|terminal receipt lost' .github/coordinator/service/test/residual.test.mjs > "$EVIDENCE/restart.tap" 2>&1
```

Test: `SHU251 live worker restart adopts once and recovers durable completion`.
A real coordinator tick submits through authenticated Unix IPC. A separate daemon
forks a detached, release-controlled worker. The harness waits at least one second
and proves its PID/start token live before stopping the daemon. The worker has no
fixed short success timeout; it waits for a release file, with a 15-second failure
bound to limit orphan risk. A new daemon PID opens the same socket and reports the
same attempt RUNNING. Replaying admission cannot spawn another worker. Releasing
the worker writes a token-bound terminal receipt exactly once; the PID disappears.
Status reports COMPLETED from that durable receipt. A further restart folds the
receipt into the run record and must leave the original launch receipt unchanged.
This proves durable adoption/status, not restoration of the original ChildProcess
object, heartbeat IPC, deadline timer, or output stream on the new daemon.

Expected diagnostic evidence: distinct supervisor PIDs, one unchanged worker
PID/start token, one start and completion, no orphan, RUNNING/RUNNING/COMPLETED,
validated terminal receipt and unchanged launch receipt. All child processes and
private state are cleaned up on success and assertion failure. Named assertions:
`SHU251_RESTART_LIVE`, `SHU251_RESTART_SOCKET`, `SHU251_RESTART_ADOPTED`,
`SHU251_RESTART_NO_DUPLICATE`, `SHU251_RESTART_TERMINAL`,
`SHU251_RESTART_NO_ORPHAN`, `SHU251_RESTART_DURABLE`.

Mutation tests and exact AssertionError text:

| Test | Required AssertionError text |
| --- | --- |
| `SHU251 mutation: duplicate spawn evidence after restart` | `SHU251_RESTART_NO_DUPLICATE: restart and replay must spawn exactly one worker` |
| `SHU251 mutation: terminal receipt lost after restart` | `SHU251_RESTART_DURABLE: recovery must retain the bound terminal receipt` |

The first is explicitly a synthetic duplicate journal mutation; the second deletes
the real sandbox terminal receipt. Neither is claimed as a source mutation of the
spawn implementation. The unmutated test exercises real processes throughout.

To close **installed service** restart acceptance, the approved window must also
supply a separately authorized test work order and long-running fixture worker,
record the live worker PID/start token and durable launch receipt, restart the
installed supervisor using the approved host procedure, and run the status client
below before restart, after restart while live, and after terminal recovery. Require
the same one-launch/one-terminal/no-orphan evidence and returned service/socket.
The production work order, identity, restart command and rollback target must come
from that host's approved change plan; this implementation does not authorize or
invent them. This installed-service exercise remains pending.
HALT if PID identity is unknown, any duplicate appears, readiness/status fails,
a receipt is missing/conflicting, or a worker outlives its controlled completion.
Quiesce admissions under the approved rollback plan, preserve durable evidence,
terminate only identity-verified fixture processes if authorized, and restore the
previous service artifact/configuration. Never erase launch markers to retry.

## 3. Explicit status schema and launch evidence

```sh
node --test --test-name-pattern='SHU251_STATUS_SHAPE|required status field|status claims launch' .github/coordinator/service/test/residual.test.mjs > "$EVIDENCE/status.tap" 2>&1
```

The authenticated `operation: status` response is a JSON object with exactly one
of the exact state-specific shapes below. This schema covers status, not submission acknowledgements.

| Success field (all required; no additional fields) | Type/value |
| --- | --- |
| `version` | string, exactly `2.0.0` |
| `ok` | boolean, exactly `true` |
| `durable` | boolean, exactly `true` |
| `attempt_id` | UUID string, bound to the requested attempt |
| `target_sha` | 40 lowercase hexadecimal characters, bound to the order |
| `stage` | `ACCEPTED`, `RUNNING`, `HOLD`, `COMPLETED`, or `FAILED` |
| `result` | JSON object or null; adapter payload, whose callback authority is validated separately |
| `heartbeat` | parseable timestamp string or null |

Every success retains all eight base fields above. ACCEPTED and receiptless HOLD additionally
require exactly one `hold_code` from `intended-work.mjs`'s enumerated HOLD_CODES.
ACCEPTED has null result and heartbeat. RUNNING/COMPLETED/FAILED and confirmed-spawn
operational HOLD instead require exactly one `launch_receipt`, equal to the durable confirmed-spawn receipt. No
other fields are accepted; fields cannot be removed or renamed.

Ordinary refusals have exactly `ok: false`, `stage: "HOLD"`, and string `reason`.
The unavailable-attempt refusal additionally requires `hold_code: "MISSING_CLAIM"`.
Missing/invalid execution receipts have exactly `ok: false`, `stage: "UNLAUNCHED"`,
and `reason: "launch receipt missing or invalid"`.

Authenticated ACCEPTED means durable queue admission. Announcement `status`
remains UNLAUNCHED until confirmed spawn. RUNNING is recorded execution;
COMPLETED/FAILED do not imply callback or publication authority. A genuinely
attempted, failed spawn retains internal failed/SPAWN_FAILED evidence but reports
UNLAUNCHED publicly because no confirmed-spawn receipt exists.

RUNNING/COMPLETED/FAILED require a durable `launches/<attempt_id>.json` with
`phase: "launched"`, matching issue ID, attempt ID and target SHA, a positive
integer PID, and the preserved 64-hex completion token hash. The earlier
`spawn_attempted` phase and hash are persisted before process creation and remain
necessary duplicate-prevention evidence, but are insufficient for execution
claims. Recovery never manufactures confirmed spawn from process liveness.

Validation order is authentication/request binding, known stored run state,
present completion integrity, then intent integrity and execution receipt.
Unknown stored states cannot be masked by a completion or an UNLAUNCHED projection.
Status reads never create intent or receipt files. Pending recovery and submission
honor existing enumerated holds; only AWAITING_LAUNCH may schedule a launch.
Legacy accepted records without markers may recover a bound intent; records with
markers receive an ambiguity intent and never elect another spawn. Legacy running
records retain process identity without gaining launch authority. Intent filenames
support only issue identifiers matching `[A-Za-z0-9-]+`; integrity assertions remain
local errors and the socket retains its existing invalid-request boundary.

Tests:

- `SHU251_STATUS_SHAPE pins all states and launch receipt binding`
- `SHU251 mutation: required status field removed or renamed` (every required
  success field; also invalid field types/values)
- `SHU251 mutation: status claims launch without receipt`

Mutation AssertionErrors, respectively:
`SHU251_STATUS_SHAPE: status must match the documented v2 schema` and
`SHU251_STATUS_RECEIPT: a launch claim requires a matching durable launch receipt`.
These mutate real status output before the acceptance validator; the production
missing-receipt refusal is also exercised for all three launch-claiming stages.

In the approved window, supply `SHU_SUPERVISOR_STATE_DIR`,
`SHU_SUPERVISOR_SOCKET`, and `SHU_SUPERVISOR_SECRET` through the approved credential
mechanism (never echo the secret). Set `ORDER_JSON` to the approved plain work-order
JSON, not the durable wrapper. Run for the acceptance attempt at each lifecycle step:

```sh
node .github/coordinator/service/check-status.mjs "$ORDER_JSON" > "$EVIDENCE/status-live.json"
```

Use distinct output filenames for before/after/terminal observations. The client
only reads durable order/launch files and sends authenticated status; it does not
construct a store or chmod state. The same client is tested against the sandbox
socket. HALT on any schema/assertion failure, unavailable/refused status, or launch
claim without evidence. Preserve output and receipts, keep dispatch disabled,
and use the approved prior-artifact rollback without deleting durable state.

## Verification in this implementation lane

The required coordinator command is run from the repository root after:

```sh
umask 0002
chmod -R go-w .github/coordinator
export SHU251_NO_SYSTEMD=1
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
```

`SHU251_NO_SYSTEMD=1` explicitly skips eleven existing tests that invoke
`systemd-analyze`, including staging tests that invoke it indirectly. Their normal
CI behavior is unchanged when the variable is absent. Six other skips need a
distinct worker UID; one vocabulary test is inapplicable. Do not report those
checks as passed. A later approved systemd-capable window may unset the variable
and rerun the exact command to obtain syntax/staging evidence.

The separate required repository-root command is `npm test`. Its initial attempt
stopped at build with missing Node type definitions (zero tests executed).
`npm ci --ignore-scripts` installed lockfile dependencies locally before rerunning.
Final command counts are recorded in the delivery response and the table below.

| Command | Result | Counts |
| --- | --- | --- |
| `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` with the above umask/chmod and no-systemd environment | exit 0 | 905 tests: 887 pass, 0 fail, 18 skip, 0 cancelled |
| Repository root `npm test` after dependency installation | exit 0 | Node TAP: 407 pass, 0 fail, 0 skip; Vitest: 27 pass, 0 fail (1 file); separate mutation runners: 79/79 killed; synthetic observability exercise succeeded |

The 79 separate mutation kills are profile 10, idempotency 3, documents 17,
hardening 10, observability 17, lifecycle 22. They are not added to TAP/Vitest
counts. Deployment mutation tests already included in its 58 TAP tests are not
counted again. All eight new residual tests pass, including five mutation/negative
control tests. `git diff --check` passes. No remote CI or host acceptance was run.
