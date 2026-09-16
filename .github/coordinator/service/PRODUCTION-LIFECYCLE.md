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

## Round-2 verification record (2026-09-16)

Implementation/test commit: `2f911d2b99fb15e5f4a32e12c82519f0d02af98e`.
The subsequent evidence-only commit changes this document. The full coordinator
source tree was compared byte-for-byte with the tested depth-1 clone before
appending this record. Base was `ab6c634b` on the same branch.

| Run | Tests | Pass | Fail | Skip | Cancelled / Todo |
| --- | ---: | ---: | ---: | ---: | ---: |
| Base complete coordinator + service | 1489 | 1481 | 0 | 8 | 0 / 0 |
| Focused lifecycle + driver + production provider | 183 | 183 | 0 | 0 | 0 / 0 |
| Complete coordinator + service | 1536 | 1528 | 0 | 8 | 0 / 0 |
| Depth-1 clone, complete coordinator + service, clock +1 year | 1536 | 1528 | 0 | 8 | 0 / 0 |

Focused tests include **74 named mutation tests**: 37 existing lifecycle,
12 existing Phase-A, 20 provider (14 guard families including reused privilege,
three durability/lock mutations and three entrypoint mutations), and five routing.
All 74 permitted controls pass and all 74 syntax-clean mutants are killed by their
named assertions, with zero survivors. Every coordinator/service test file,
including all other mutation suites, ran in both complete runs. No new skip was
introduced and `PERMITTED_SKIPS` is unchanged.

An earlier focused iteration had 175 tests, 174 passes and one failure: the new
overlap mutation matched its own mutation string as well as the intended source.
The unique-match assertion detected this harness defect; it was corrected before
the final successful runs. No production or existing test assertion was relaxed.

Exact base/full/shallow skip profile (names and reasons compared, not just counts):

- SHU-227: worker owns its checkout and recovery preserves descendant commits — requires root or passwordless sudo for distinct-uid proof
- SHU-227: non-owner service account resolves revision with no global Git trust — requires distinct-uid execution
- SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches — requires distinct-uid execution
- SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches — requires distinct-uid execution
- SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity — host cannot switch to the fixture worker uid
- SHU-244 A10: distinct-root scoped handoff production workspace — host cannot switch worker uid
- SHU-71 restricted capability refusal — production vocabulary has no undeclared runtime/role pair
- READER operator-owned checkout read by non-root account — Not exercisable: non-root account, no passwordless elevation to create root-owned checkout

All temporary storage and clones are beneath this checkout. Suites use a private
user/mount namespace to bind repository storage over `/tmp` and then drop retained
capabilities, as in the original validation. Before suites:

```sh
chmod -R go-w .github/coordinator
umask 0002
```

Focused command:

```sh
TMPDIR="$PWD/node_modules/t" node --test \
  .github/coordinator/service/test/host-lifecycle.test.mjs \
  .github/coordinator/service/test/phase-a-driver.test.mjs \
  .github/coordinator/service/test/production-lifecycle.test.mjs
```

Complete command:

```sh
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/t"
```

Base ran the same complete command in a repository-local archive of `ab6c634b`.
The shallow clone was made with:

```sh
git clone --depth 1 --single-branch \
  --branch fix/shu251-typed-host-lifecycle-executor \
  "file://$PWD" node_modules/shu251-round2-shallow
```

It reported `--is-shallow-repository=true` and only this branch plus its origin
tracking ref/HEAD; no main ref existed. Its complete run used:

```sh
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && cd "$2" && TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$2/.github/coordinator/test/fixture/shift-wall-clock.mjs" setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/u" "$PWD/node_modules/shu251-round2-shallow"
```

Local TAP logs are retained in `node_modules/.cache/shu251-round2/` (untracked):

| Log | SHA-256 |
| --- | --- |
| `base.log` | `b2d85fd818fbd68b3d84bdf6afeac46a7b313ea429d18ad35db60ac83e938cf6` |
| `focused.log` | `f3ab6c795ca3e96bc8d0b2e8522a1ab44129398f0fe0a76e8d97734765fdc9bb` |
| `full.log` | `8515a63cac87a6dc117bb036ccf817b8ab48efa1dc8882e0ed8f513b71c8c5b4` |
| `shallow-future.log` | `c1835c0250836bf48196d9310eb4c62973555db53344fe646a5db8363b23ac15` |
