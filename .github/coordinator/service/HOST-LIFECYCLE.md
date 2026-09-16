# Typed Phase-A host lifecycle

This extends `phase-a-driver.mjs` (`ACTIONS`, mutation approval and
`shu251-phase-a-receipt-v1`). It does not change the existing offline installer
or the legacy `rollback` action's staged-file-only meaning.

| Action | Executed operation and receipt |
| --- | --- |
| `preflight` | Check the approved clean SHA/tree, exact identity and supplementary groups, environment **metadata only**, owned state directories, exact systemd version, all existing host-suite capability names plus atomic rename/directory fsync, destination, writer lock, activation evidence path and manifest. |
| `install` | Render, stage privately, compare every staged byte/hash, capture the full prior state, journal and atomically replace the three units, two literal dispatch-off drop-ins and their two directories, reload, and compare installed bytes. |
| `start` | Enable the supervisor and timer; start the supervisor, the static coordinator oneshot, and timer. Prove identity, socket listener, supervisor/coordinator readiness and both dispatch gates off. A completed coordinator oneshot is inactive. |
| `readiness` | Repeat the installed-identity and readiness proof with a typed receipt. |
| `restart` | Record driver-observed before evidence using the existing restart custody format/validators; durably consume it **before** issuing the supervisor restart; require a new invocation with the same worker PID/start token. |
| `host-rollback` | Reconcile pending intents; undo changed active/enabled state and destinations in reverse order; reload and compare the complete prior host state. The pin has its own explicit disposition below. |
| `pin` | Compare-and-set `refs/shu251/activations/<activation_id>` to the approved SHA, capturing its prior SHA or absence. |
| `pin-restore` | After verified host rollback, compare-and-set that exact ref back to its prior SHA or absence. |
| `pin-retain` | Verify the ref still names the approval and emit an explicit retention receipt without changing it. |

All actions except preflight require the existing two-part mutation approval,
including receipt-producing observations that write journal custody. A dry run
never invokes lifecycle capabilities or returns acceptance. Caller-provided
`before` still fails with `SHU251_RESTART_CALLER_BEFORE`; additional caller options,
commands and argument passthrough are refused.

## Execution boundary

The executable API is `drive(action, spec, options, io)`. Supply the existing
`read` and reviewed `render` capabilities and an explicit `io.lifecycle` object.
There is **no ambient host adapter** in `defaultIO`: without that explicit object,
execution refuses `SHU251_LIFECYCLE_IO`. This repository change supplies and tests
the typed executor, not an unreviewed systemctl/filesystem adapter. No test calls
a real service manager, pin operation, destination, credential file or host.

The capability provider is trusted code, like the existing driver IO layer; it
is not caller evidence, a command string, a receipt importer or a security
boundary against its owner. Its contract is:

| Capability | Required behavior |
| --- | --- |
| `probe()` | Return observed metadata matching the closed preflight shapes. Inspect environment paths/owners/modes without reading their values. Prove existing regular writer-lock custody (`free` outside the lock, `held-by-driver` inside). Prove capabilities, not merely their names from the spec. Return the manifest read from the activation-specific evidence directory. |
| `withLock(callback)` | Exclusively hold both activation-journal custody and the existing writer lock for the entire callback, including final receipt persistence. Refuse contention. Never create a replacement writer lock or silently omit the callback. |
| `snapshot()` | Observe only the fixed destinations, effective enabled/active states of the fixed units, and the exact activation ref. The two drop-in directories are also captured as `{kind:'directory', mode:0o755, uid:0, gid:0}` or absence. A file is `{kind:'file', data:<canonical base64>, mode, uid, gid}`; absence is `{kind:'absent'}`; the only permitted prior symlink is `{kind:'symlink', target:'/dev/null', uid:0, gid:0}`. Base64 preserves arbitrary prior bytes. |
| `stage(units)` | Own a private temporary staging directory; safely write/read back and clean its files; return its path/canonical path, caller UID/owner, mode and byte-exact unit map. No host destination changes. |
| `load()` / `save(journal)` | Read driver-owned durable state, or `null` only for genuine absence. Reject symlinks/path substitutions, malformed state and storage failures. Save atomically, fsync the file and directory, and return `true` only once durable. In-memory sharing without durable persistence is sufficient **only for controlled tests**. |
| `place(name, before, after)` | Atomically compare and replace a fixed destination by basename, without following target or ancestor symlinks. Pin/verify destination directory identity; preserve exact bytes, modes, ownership, symlink target or absence. Reject races. Return `true` only after durable placement. The executor journals creation/restoration of the two allowlisted drop-in directories as explicit placements, before their children and in reverse order on rollback. Refuse nonempty directory removal or unreviewed directory contents. |
| `systemd(verb, unit)` | Execute only the driver-issued verbs: `enable`, `start`, `restart`, `stop`, `disable`, `daemon-reload`. Only `UNIT_NAMES` are eligible; reload uses `null`. Use fixed argv, no shell, interpolation, flags from callers or `--` passthrough. Return `true` only on successful completion. |
| `pin(ref, before, after)` | Compare-and-set the exact activation ref, including absence, using fixed Git argv and expected-old-value protection. No checkout reset, remote fetch, other ref or implicit retention. |
| `readiness()` | Observe service identity/groups, the exact supervisor listener, recovered/ready supervisor, successfully completed coordinator oneshot, committed/runtime dispatch-off, supervisor invocation ID, and a live worker PID/start token. No secret values belong in the result. |

`spec.lifecycle` is a closed object. Its fields are `activation_id`,
`approval_sha256`, `approved_tree`, `identity`, `environment`, `directories`,
`systemd_version`, `capabilities`, `evidence_root`, `evidence_dir`, and
`rendered_sha256`. The executable fake fixture in `test/host-lifecycle.test.mjs`
shows every field and exact observation shape. The directory must be
`<evidence_root>/<activation_id>`, never the generic root.
`expectedManifest(spec)` defines the manifest: activation, approval, approved
SHA/tree, complete spec digest, and hashes for all five reviewed destinations.
The approval hash is a binding supplied by the reviewed window, not a signature
created or independently authenticated by this executor.

The default renderer and offline installer retain their original writer-lock,
crossed-environment, destination, owner, private-directory and dispatch-off
checks. The old nine-action routing test still asserts all nine routes explicitly;
new lifecycle routing is asserted separately for all nine additions.

## Recovery and receipts

The full prior snapshot is durable before the first destination/ref operation.
Each journal entry contains an ID, allowlisted verb/target, expected before and
after values, and `pending`/`done`/`undone` status. A pending entry is saved before
effect execution. An interrupted effect may have left either its before or after
value; neither is silently assumed. Any third value is substitution and refuses.
Journal replay checks that intents follow from the prior state and approved
render/ref values, so a forged journal cannot inject an arbitrary placement.

Every effect and completion-save boundary is recoverable by retrying the same
action or rolling back. Rollback checks pending operations too, restores in
reverse order and saves each completion. Effective `masked`, `static`, `indirect`
and `not-found` enablement is proved after original configuration is restored
and reloaded. The oneshot tick is explicitly issued even though successful
completion returns it to the same inactive state. A pending oneshot may be
reissued after interruption; dispatch remains off.

Restart is deliberately different: its before custody and consumed marker are
saved together before the restart. An ambiguous restart or later save failure
cannot authorize another restart. Recovery is host rollback, not replay. The
existing `SHU251_RESTART_FORGED`, `SHU251_RESTART_CROSS_RUN`,
`SHU251_RESTART_SUBSTITUTED`, `SHU251_RESTART_REPLAYED`, and
`SHU251_RESTART_ACCEPTANCE` checks remain in use.

Prior active/enabled service state and prior bytes that could re-enable dispatch
are refused **before mutation**. This preserves the existing rollback safety
boundary; this change does not authorize restoring a previously dispatching
service. Only masking symlinks are accepted; arbitrary linked unit targets are
refused. These are conservative exclusions, not claims to restore every possible
systemd configuration.

Receipts retain the existing version, spec/approved-SHA binding and evidence
digest, with closed lifecycle evidence fields: binding, success, activation ID,
approval hash, installed hashes, before/after, journal hash and disposition.
The journal hash identifies the state immediately before appending that receipt.
Acceptance is returned only after saving the receipt. Rollback receipts prove
host state equality excluding the explicitly separate pin; `pin-restore` closes
full equality, or `pin-retain` documents the retained pin.

## Named guard mutations

Each row has a successful permitted control and a failing perturbation. The
mutation named `LIFECYCLE named mutation <CODE>` disables only that invariant
family. Each mutant must pass `node --check`, then fail exactly one test by an
`AssertionError` containing `<CODE>_REQUIRED`; crashes and module/syntax errors
are not kills. Mutants use copied source, not Git history or a baseline branch.

All new codes have the prefix `SHU251_LIFECYCLE_`:

| Code suffix | Perturbation that the named mutation exposes |
| --- | --- |
| `SPEC` | Unreviewed destination directory. |
| `PATHS` | Generic evidence directory instead of activation directory. |
| `INPUT` | Caller-supplied command option. |
| `IO` | Missing required durable-save capability. |
| `CHECKOUT` | Dirty checkout (also separately tests wrong SHA/tree). |
| `IDENTITY` | Wrong service UID (also tests extra groups). |
| `ENVIRONMENT` | Extra environment value field (also wrong owner/mode/path/type). |
| `DIRECTORIES` | Missing owned state directories. |
| `CAPABILITIES` | Missing host capabilities (also wrong systemd version). |
| `EVIDENCE` | Generic observed evidence path (also wrong approval manifest). |
| `SNAPSHOT` | Socket substituted for a destination file. |
| `ROLLBACK_REENABLE` | Previously enabled service. |
| `JOURNAL` | Forged activation binding in stored journal. |
| `INTENT` | Forged pending/completed pin target value. |
| `DURABILITY` | Journal persistence fails. |
| `RENDER` | Changed rendered bytes. |
| `STAGE` | Changed staged bytes. |
| `PLACE` | Second placement fails after partial installation. |
| `RELOAD` | Daemon reload fails. |
| `ENABLE` | Service enable fails. |
| `START` | Service start fails. |
| `PIN` | Ref compare-and-set fails. |
| `SUBSTITUTION` | Masking symlink replaces a pending destination. |
| `EFFECT` | Provider reports success without applying the pin. |
| `ORDER` | Attempt to install after services have started. |
| `INSTALLED` | Installed bytes drift before start. |
| `READINESS` | Runtime dispatch becomes true. |
| `RESTART` | Restart process boundary fails. |
| `ROLLBACK` | Stop fails during rollback. |
| `ROLLBACK_EQUALITY` | Stop reports success without restoring state. |
| `PIN_RESTORE` | Restore requested before verified host rollback. |
| `PIN_RETAIN` | Ref no longer names the approved SHA. |
| `RECEIPT` | Forged activation in receipt with recomputed evidence digest. |

The new matrix also mutates reused `SHU251_WRITER_LOCK`, `SHU251_DESTINATION`,
`SHU251_OWNER`, and `SHU251_PRIVATE` checks. The pre-existing Phase-A mutations
continue to verify approval, custody, evidence digests and legacy rollback.

## Verification scope

Tests use a controlled in-memory filesystem/service/ref model, explicit injected
process boundaries, faults before and after every install/start/rollback/pin
operation, and faults at every journal-save boundary. New process spawning is
limited to syntax checks and copied fake-only mutation tests. There is no signing,
reseeding, activation, dispatch, credential change or host connection.

This does **not** prove physical fsync/rename behavior, kernel locking, actual
service identity/permissions, real systemd readiness, crash recovery across OS
processes, or running-host equality. Those require a separately reviewed concrete
capability provider and a future explicitly authorized host window. An arbitrary
provider returning fabricated observations is outside the trusted IO model.

## Repository verification commands

All temporary storage and local clones were placed below this checkout. Some
existing tests require a literal `/tmp` path and a temporary directory outside
any apparent Git root. A private user/mount namespace binds repository-backed
storage onto `/tmp` for the suite process only; it does not change the host's
mount namespace. Capabilities are dropped after the bind, preserving ordinary
non-root unreadable-file tests. No existing assertion or skip was relaxed.

Preparation, run before the suites:

```sh
mkdir -p node_modules/t node_modules/u node_modules/.cache/shu251
chmod 700 node_modules/t node_modules/u
chmod -R go-w .github/coordinator
umask 0002
```

Focused command (new lifecycle tests plus existing Phase-A driver tests):

```sh
TMPDIR="$PWD/node_modules/t" node --test \
  .github/coordinator/service/test/host-lifecycle.test.mjs \
  .github/coordinator/service/test/phase-a-driver.test.mjs
```

Normal complete coordinator and service suites:

```sh
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/t"
```

The shallow check used a local `file://` clone with `--depth 1 --single-branch
--branch fix/shu251-typed-host-lifecycle-executor`, under
`node_modules/shu251-shallow`. The changed files were overlaid from the working
tree, then its coordinator tree was made non-group/world-writable.
`rev-parse --is-shallow-repository` printed `true`; the only branch and remote
tracking ref named this task branch (no `main`). The executable files and tests
were compared byte-for-byte with the working tree.

Future-clock complete coordinator and service suites in that shallow clone:

```sh
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && cd "$2" && TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$2/.github/coordinator/test/fixture/shift-wall-clock.mjs" setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/u" "$PWD/node_modules/shu251-shallow"
```

Earlier diagnostic runs found three existing-test failures when `TMPDIR` was a
path inside the checkout, then two unreadable-file failures when the temporary
namespace retained capabilities. The final commands above resolve those runner
conditions without changing tests, guards or skip allowances.

The tracked `config.json` blob remains
`8a0317173d76f4c09811b9365e25b380b38dc93d`, identical to the pre-change HEAD.

Final observed results (2026-09-16):

| Run | Tests | Pass | Fail | Skip | Cancelled / Todo |
| --- | ---: | ---: | ---: | ---: | ---: |
| Focused lifecycle + existing Phase-A driver | 136 | 136 | 0 | 0 | 0 / 0 |
| Complete normal coordinator + service | 1489 | 1481 | 0 | 8 | 0 / 0 |
| Complete future-clock coordinator + service, depth-1 clone | 1489 | 1481 | 0 | 8 | 0 / 0 |

All 37 new named mutation tests passed: 37 matched permitted controls and
37 syntax-clean mutants killed by their named assertions, no survivors.
The final durability matrix includes failures both before and after a save
becomes durable. The eight full-suite skips retain the existing exact
`PERMITTED_SKIPS` names/reasons. These results are fake-only executor validation,
not host-window acceptance or evidence for an ambient OS capability provider.
