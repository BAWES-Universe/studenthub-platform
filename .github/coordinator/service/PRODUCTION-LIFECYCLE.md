# Reviewed production lifecycle provider

`phase-a-driver.mjs` is the executable entrypoint. Its default lifecycle path
constructs `createProductionLifecycle` from `production-lifecycle.mjs`, after
`defaultIO.pin` validates the entrypoint's checkout location and window bindings.
It then enters the existing typed executor, including mutation approval, exact
preflight, durable intents, restart custody, receipt validation and rollback.
No CLI option loads a provider, command, module or caller receipt. The internal
boundary is for tests; this is not a sandbox against someone who can edit the
reviewed program or control its Node runtime.

The authorized operator runs the reviewed checkout as root with the existing
approved spec and two-part mutation approval. The evidence root and private
activation directory must already exist, owned by the approved service identity.
The activation directory contains the reviewed `manifest.json` (0600), matching
`expectedManifest(spec)`, and a regular private `journal.lock`. The state directory
contains the existing regular private `host-tick.lock`; the provider never creates
or replaces that writer lock. These are window provisioning artifacts, not new
implementation code. The provider refuses writable-by-group/other or symlinked
ancestors. Unit destinations must be `/etc/systemd/system`.

The production boundary uses Node filesystem syscalls and `spawnSync` with fixed
absolute executable paths, a sanitized environment and no shell. Unit operations
are restricted to exported unit names and the two reviewed drop-in paths. No
systemctl flags or arbitrary arguments pass through from the operator. The
existing dispatch-off renderer and environment guards remain in place.

Directory descriptors pin filesystem parents; writes use `/proc/self/fd/N` paths.
Ancestors, inode identity, no-follow regular files and destination preconditions
are checked. Only a prior `/dev/null` masking symlink is supported. Placement is
same-directory atomic rename, or explicit directory creation/removal. File data,
ownership and mode are persisted before rename; the containing directory is
fsynced after rename, creation and removal. Rollback restores original bytes,
mode, ownership, masking or absence, then the executor compares a fresh snapshot.
Unreviewed drop-in contents cause preflight refusal. Nonempty directories cannot
be removed. This relies on Linux `/proc` and on the trust of root and the approved
service account; it does not promise a transaction against a malicious root.

`flock --exclusive --nonblock 3` operates on an inherited open-file description.
The parent retains the descriptor across the complete callback and final journal
receipt, and closes it in `finally`. The provider holds both the existing writer
lock and the activation journal lock. Probe reports free only after acquiring and
releasing the writer lock; inside custody it verifies the retained descriptors.
The rendered coordinator oneshot uses the same nonblocking writer lock and
accepts lock-conflict exit code 2. While the driver holds custody, the oneshot
cannot launch work; its completed Result and exit status are observed. The
dispatch-off gate also remains in the rendered service configuration.

Journal storage is activation-scoped, no-follow, private, atomic and fsynced.
Probe exercises rename and file/directory fsync in that evidence filesystem and
runs the existing host capability detectors through the same injectable boundary.
Preflight environment inspection reads metadata only. Render retains the existing
coordinator environment-content guard; readiness reads the supervisor process's
environment to verify its actual dispatch gate, without returning secret values.

Git uses an activation-specific ref and `update-ref` with an expected old SHA
(including all-zero absence), never `--force`, reset, fetch or remote operations.
Fresh ref observations verify the operation. The executor emits typed retain and
restore receipts and requires host rollback before restoration. Retention emits
an observation without a ref write.

Readiness observes systemd MainPID, ActiveState, SubState, InvocationID and the
coordinator's Result, ExecMainStatus and nonzero exit timestamp. It reads that
process's UID/GID/groups and actual environment, matches the exact Unix listener
and PID using `ss`, invokes the existing authenticated transport and live-worker
bindings, and reads committed dispatch configuration from the approved Git blob.
A restart must change InvocationID while preserving the live worker identity.
These are observations made by the provider, not booleans supplied by the operator.

## Tests and load-bearing mutations

`production-fixture.mjs` translates every filesystem operation into disposable
repository-backed storage and interprets every command with recorded outputs.
Unrecognized commands fail; no command is forwarded to the actual machine.
Tests run the real provider through the entire typed lifecycle, compare exact
before/after state, verify syscall ordering and inject failures and substitutions.
The existing executor's per-effect/per-save recovery matrix remains unchanged;
its shared fixture moved to `lifecycle-fixture.mjs` without weakening assertions.

Every row below has a successful control and a syntax-clean mutant that disables
only that code's guard family. The mutant must die in the matching
`PROVIDER guard CODE` test with `CODE_REQUIRED`, an AssertionError and exactly one
failure. Syntax/module/type crashes do not count as kills.

| New code (`SHU251_PROVIDER_` prefix) | Perturbation / killed mutation |
| --- | --- |
| SCOPE | Evidence directory escapes activation scope / disable SCOPE |
| PATH | Group/world-writable destination / disable PATH |
| SUBSTITUTION | Pinned descriptor inode differs / disable SUBSTITUTION |
| SYMLINK | Arbitrary destination symlink / disable SYMLINK |
| FILE | Hardlinked destination / disable FILE |
| STORAGE | Cross-activation journal / disable STORAGE |
| CUSTODY | Save outside writer custody / disable CUSTODY |
| ALLOWLIST | Unreviewed unit placement / disable ALLOWLIST |
| COMPARE | Destination differs from expected before / disable COMPARE |
| ARGV | Unreviewed systemd unit / disable ARGV |
| PIN | Ref outside activation / disable PIN |
| COMMAND | Nonzero systemctl result / disable COMMAND |
| READINESS | Missing observed listener / disable READINESS |

The reused `SHU251_PREFLIGHT_PRIVILEGE` also has a positive/negative control and
named guard mutation. Further mutants remove file fsync, directory fsync, flock
success checking, default entrypoint selection, production factory construction,
and reviewed-checkout validation. Each has its own named assertion. Existing
executor, driver and service mutations continue to run.

The routing test uses explicit independent reviewed legacy and lifecycle maps.
It asserts their disjointness, their union equals `Object.keys(ACTIONS)`, the
exported lifecycle set equals the reviewed set, and every action completes through
its intended route with the expected binding. Legacy command sequences are exact;
lifecycle tests fail if the legacy shell/pin route is invoked. Mutations:

| Property | Mutation | Named killing assertion |
| --- | --- | --- |
| Disjoint sets | Insert lifecycle preflight in legacy map | ROUTING_DISJOINT_REQUIRED |
| Complete union | Remove exported inventory action | ROUTING_COMPLETE_REQUIRED |
| Every intended legacy route | Route worker to launch | ROUTING_LEGACY_REQUIRED |
| Every intended lifecycle route | Route readiness to preflight | ROUTING_LIFECYCLE_REQUIRED |
| Untested additions fail | Register new `untested` action | ROUTING_COMPLETE_REQUIRED |

## Scope of evidence

No tests contact a host, service manager, credential store or remote Git server.
Recorded responses prove provider interpretation and fixed argv, not the behavior
of a real systemd installation. Repository-backed syscalls exercise real file
writes, fsync and rename; UID/GID and command outputs are simulated. Kernel flock
custody, physical power-loss durability, live authenticated readiness and host
rollback equality require an authorized host window and are not claimed here.
No signing, reseeding, fixture activation, dispatch, push or PR operation was done.
