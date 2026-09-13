# SHU-251 service staging and supervisor integration

This package supplies systemd templates, a temporary-directory staging installer,
exact file rollback, and lifecycle composition of the merged SHU-250 supervisor.
Nothing installs, enables or starts host services. All executed verification uses
local temporary fixtures. Running-system acceptance remains a host-only step.

## Local verification and required CI

Requirements: Linux, Node.js, `/usr/bin/flock`, `/usr/bin/systemd-notify` for an
actual service, and `systemd-analyze` for syntax verification. From the repo root:

```sh
chmod -R go-w .github/coordinator
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
node .github/coordinator/service/verify.mjs
```

`npm run test:coordinator` runs both globs. The required `fast-checks` job invokes
that command without failure suppression and checks `systemd-analyze` and flock
first. The future-clock job also runs both globs with these prerequisites. The
bare Git 2.43 container retains its targeted Git tests; it does not run service
syntax tests. Branch protection is not modified by this package.

`systemd-analyze verify` updates the mtime of
`/run/systemd/systemd-units-load`, a read-only unit-cache marker in tmpfs. Record
this verifier side effect separately in state-diff audits; it is not durable
supervisor/workspace state and does not justify excluding any such state.

## Render and stage

Create an owned private directory under the system temporary directory. The
`serviceParameters()` export in `units.mjs` builds concrete argv against this
clone: Node runs `service/supervisor-service.mjs` and `reconcile.mjs` directly.
Inputs are `workdir`, `workspaceStateDir`, and optional `supervisorStateDir`,
`supervisorSocket`, and absolute Node executable `node`. Defaults place supervisor
state in `workspaceStateDir/supervisor` and its socket in
`workspaceStateDir/supervisor.sock`. Serialize the returned object to parameters.json:

```sh
node .github/coordinator/service/install.mjs stage "$stage_dir" parameters.json
node .github/coordinator/service/install.mjs rollback "$stage_dir"
```

The lower-level `render()` also accepts explicit `supervisor` and `coordinator`
argv arrays. `fixtureParameters()` uses `/usr/bin/true` solely for syntax testing;
these commands cannot signal readiness and must not be promoted to a host.
The real entry point needs the same at-least-32-byte `SHU_SUPERVISOR_SECRET` as
coordinator transport. Units provide the shared socket path, workspace state
path and supervisor state path. Credentials, service identity, activation file,
`DISPATCH_TARGET_SHA`, and other adapter/workspace settings require reviewed host
configuration. No secret is rendered into staged units. The generated coordinator
argv does not arm an activation; an authorized deployment must supply its reviewed
arguments and environment. Dispatch remains false in both staged units.

The installer requires an existing, caller-owned, non-group/world-writable real
directory below the temporary directory. Missing destinations fail with
`SHU251_DESTINATION`. Symlink unit targets are refused. A directory lock serializes
staging, syntax is checked before writes, and `.shu251-backup.json` (0600) preserves
exact bytes, modes and prior absence. Atomic replacement, idempotent re-staging,
drift refusal and handled partial-write rollback are tested. Rollback restores
bytes/modes/absence, not timestamps, ownership, ACLs or service-manager state.

A crash can leave partial staging, a lock or temporary files. Confirm the staging
process is gone before removing `.shu251-operation`, run rollback, and discard
remaining `*.new`/`.verify-*` artifacts. Preserve the backup if recovery fails.

## Writer exclusion and timer behavior

The timer targets the single oneshot coordinator service. Wakes occur 60 seconds
after boot and 60 seconds after completion. Systemd does not overlap activations.
The writer also holds a nonblocking flock. Rendering and policy validation enforce
`SHU251_WRITER_LOCK`: the lock must equal
`SHU_WORKSPACE_STATE_DIR/host-tick.lock`, with the state directory explicitly
rendered into the coordinator environment. Canonical and foreign-path tests cover
both directions. Deployment must preserve that environment and path identity:
all manual drivers must use the same state directory and inode. Do not delete a
lock file that a writer may hold. Do not pass `host-tick.sh` as the coordinator
command: it would recursively acquire the lock. Remote or bypassing writers still
require an operational audit before activation.

`TimeoutStartSec=infinity` avoids killing a tick midway through durable work, but
a hung tick never times out and blocks all future timer wakes. There is no watchdog.
The operator must stop the timer, inspect the writer and durable evidence, terminate
the stuck coordinator through the service manager when appropriate, reconcile
ambiguous work, verify the lock is released, and only then resume the timer.
Never delete the lock to get another writer running.

Both services restart on failure with bounded retries and a delay. Exit 2 is a
successful coordinator refusal, including lock contention, so it waits for the
next timer wake. Local flock tests prove exclusion and release; template tests do
not prove actual systemd restart behavior.

## Supervisor startup, readiness and shutdown

`supervisor-service.mjs` composes the actual `DurableSupervisor`,
`createSupervisorSpawner` and `listenSupervisor` APIs. It recovers durable state
before listening and calls `systemd-notify --ready` only after the private socket
is listening. `Type=notify`, `NotifyAccess=all` (the notifier is a child), and a
30-second startup timeout make readiness part of systemd activation. The
coordinator has both `Requires=shu-supervisor.service` and
`After=shu-supervisor.service`: starting it pulls in the supervisor and waits for
readiness; supervisor startup failure prevents the writer from starting. Stopping
the supervisor also stops its dependent coordinator. Timer wakes may subsequently
start the dependency again, so stop the timer first for maintenance.

SIGTERM/SIGINT close admission, cancel pending launches logically, close IPC, and
call `shutdown({ terminateChildren: false })`. `KillMode=process` preserves worker
processes on routine service restart. Recovery probes Linux process-start tokens;
unknown identities HOLD instead of spawning duplicates. Disabled runtime dispatch
blocks both recovered queued launches and new submissions; authenticated status
remains available. This does not stop already running workers or prove quiet
recovery (recovery may update durable HOLD/completion evidence).

The exported `stop({ terminateChildren: true })` records HOLD before signaling
owned children, using the merged shutdown API. It is an explicit in-process control,
not a new unauthenticated remote operation. After restart, recovered workers are
not in the new daemon's owned-child map: operator quiescence must account for them
separately. Existing worker authorization is rechecked by the merged wrapper before
launch/publication; coordinator gates alone do not quiesce surviving workers.

An existing/stale socket fails closed before recovery. Routine shutdown removes
the socket through Node's server close. After an unclean crash, bounded retries can
fail until an operator confirms the prior daemon is gone, inspects workers/state,
and removes only its stale socket. There is deliberately no automatic deletion of
an occupied socket. Deployment must also ensure only one supervisor owns a state
root; filesystem claim safety is not a substitute for that service ownership.

## Authoritative state and kill-switch evidence

`supervisorState(stateDir)` is read-only and recursively enumerates **all** entries,
including branches, orders, runs, launches, completions, orphan launch records,
unknown files and temporary files. It records bytes, modes, file mtimes and ctimes;
missing durable trees, symlinks and special files fail with
`SHU251_SUPERVISOR_STATE`. It does not construct `SupervisorStore`, whose constructor
changes permissions. Compare inventories only while quiescent. Snapshots include
sensitive work orders/completion tokens; keep them in private evidence storage.
The socket lives outside this durable tree. Combine this inventory with workspace
state, remote receipts/comments/pauses, process identities and launch/write counts
for any eventual authoritative host audit.

The local kill-switch harness seeds a RUNNING receipt and executes two ticks with
runtime `ENABLE_DISPATCH=false` and committed config false. A tick with both fixture gates enabled, and a separate runtime-enabled/config-false
tick through the same real coordinator harness, throw `SHU251_ZERO_LAUNCH`, proving
adapter-call discrimination. The fixture's write and state channels are observation
checks only: this scenario does not establish positive discrimination for
`SHU251_ZERO_WRITE` or `SHU251_STATE_DIFF`. Synthetic evidence mutations test those
assertions, not a live write-producing gate control. Do not claim a full
running-system kill-switch proof from this fixture.

The committed config gate is **not an independent kill switch**. Runtime
`ENABLE_DISPATCH=true` can allow an authorized activation despite config false.
There is no defence-in-depth claim for those two settings. Use the runtime gate,
stop the timer and quiesce in-flight coordinator/supervisor/worker activity through
the reviewed operational path. Keep both staged service gates false.

## Host-only work excluded

Host installation, credential delivery, service identity/permissions, unit/drop-in
and enabled/active-state backups, daemon reload, activation, crash/restart proof,
and running-system one-writer/kill-switch/rollback evidence require host access
and remain unexecuted by design. No SHU-250 interface work remains deferred here.
Before a future host audit, stop the timer, disable runtime admission and account
for all existing workers; then baseline remote, workspace and supervisor state.
Observe repeated disabled ticks across at least two wake intervals, requiring
zero launches/writes and no authoritative durable changes. Preserve only the
explicit unit-cache marker exception above. File staging rollback does not claim
rollback of running services, and must never implicitly re-enable dispatch.
