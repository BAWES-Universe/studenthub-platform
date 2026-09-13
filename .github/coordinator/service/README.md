# SHU-251: interface-independent service staging

This directory adds host systemd templates, a **temporary-directory staging
installer**, rollback, and local verification. It changes no coordinator code.
Nothing here calls systemctl, installs host services, enables dispatch, contacts
production, or supplies a guessed SHU-250 supervisor socket/CLI. This is a partial
SHU-251 implementation, not its running-system acceptance proof.

## Render and stage locally

Requirements: Linux, Node.js, `/usr/bin/flock`, and `systemd-analyze`. From the
repository root:

```sh
chmod -R go-w .github/coordinator
node .github/coordinator/service/verify.mjs
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
```

For reviewable unit artifacts, create an owned private directory under the
system temporary directory (`mktemp -d`). Supply a JSON parameters file:

```json
{
  "workdir": "/absolute/reviewed/clone",
  "supervisor": ["/absolute/reviewed/supervisor-entry", "reviewed-argument"],
  "coordinator": ["/absolute/reviewed/tick-entry", "reviewed-argument"],
  "writerLock": "/absolute/private/state/host-tick.lock"
}
```

These are placeholders, not an approved SHU-250 interface. The executable files
must exist for syntax validation. `fixtureParameters()` uses `/usr/bin/true`
only for local syntax testing; those fixture commands do not run a coordinator
or supervisor and must never be promoted to the host.

```sh
node .github/coordinator/service/install.mjs stage "$stage_dir" parameters.json
node .github/coordinator/service/install.mjs rollback "$stage_dir"
```

The installer accepts only an existing, caller-owned, non-group/world-writable,
real directory below the temporary directory. It refuses symlink unit targets,
serializes operations with a directory lock, validates all units before writes,
and backs up exact bytes, permission modes and prior absence in
`.shu251-backup.json` (0600). Each unit replacement is atomic. Repeating an
identical stage preserves the original backup and unit mtimes. Drift or changed
parameters require rollback first. A handled write failure restores prior files;
rollback is itself repeatable and removes files that were previously absent.
Unrelated files are untouched. This is file rollback, not service-manager rollback.

A process crash can leave a lock, backup, temporary files, or a partial set of
units. Do not promote such a directory. After confirming the staging process is
gone, remove only `.shu251-operation`, run rollback, and discard remaining
`*.new`/`.verify-*` artifacts. Keep the backup if recovery fails. There is no
claim of power-loss transactional durability, ownership/ACL restoration, or
preservation of original timestamps; bytes, modes and absence are the contract.

## Wake, restart and one writer

`shu-coordinator.timer` addresses exactly `shu-coordinator.service` on the host.
Its first wake is after 60 seconds; subsequent wakes follow completion by 60
seconds. The oneshot invokes the parameterised command and exits. Systemd does
not overlap activations of the same service. A shared nonblocking `flock`
also excludes concurrent reviewed manual drivers; its path **must equal** the
existing `SHU_WORKSPACE_STATE_DIR/host-tick.lock`. All writers must use that same
path and inode. Do not delete the lock file while any writer could hold it.

The coordinator argv must enter the reviewed tick directly: do not pass
`host-tick.sh` here, since that wrapper would acquire the same lock again.
Selecting the eventual tick arguments, activation and supervisor integration is
left to the integration review. Manual runs through the existing host-tick
wrapper use the common lock. Other workflows/drivers must be disabled or routed
through this lock before host activation; a local flock cannot exclude remote
writers. There is no assertion that arbitrary bypassing processes are excluded.

Both services have `Restart=on-failure`, bounded retries and a restart delay.
Exit 2 is a successful coordinator refusal (including lock contention), so it
waits for the next timer wake instead of retrying immediately. Supervisor
`KillMode=process` preserves workers across routine supervisor restart, as the
existing supervisor contract requires. `After` orders starts when both are
scheduled; it does not establish readiness or automatically start the
supervisor. SHU-250 must supply that readiness/lifecycle integration. The local
flock test proves exclusion and release after exit; unit validation and mutation
tests prove configured restart policy, **not actual systemd restart behaviour**.

## Kill switch verification and separately gated host step

The local harness calls the reviewed `main()` via the existing episode test
fixture, with the config gate false and runtime `ENABLE_DISPATCH=false`. It seeds
a valid RUNNING receipt without dispatching, then executes two disabled ticks.
Injected transport and adapters use local state only. Assertions cover adapter
calls, remote mutation requests, full fake remote state, and local file hashes,
modes, mtimes and ctimes. Empty state diffs and zero counters prove quiet fixture
ticks. A separate staged-unit round trip proves rollback, including prior absent
units. No actual worker or persistent supervisor runs in this harness.

Future host installation is **separately gated and has not been attempted**.
After SHU-250 lands, review concrete argv, environment, service identity, state
permissions, common lock path, readiness, credentials, existing unit/drop-in
backups and existing enabled/active state before requesting that gate. The
host-copy/service-manager installer is deliberately omitted here: promoting
staged units alone cannot safely claim installation or rollback of a running
service plane. Once explicitly authorised, host work must include daemon reload,
supervisor activation/readiness, timer activation, one-writer audit, and controlled
crash/restart evidence showing worker preservation and no duplicate writer.

The future running-system kill-switch sequence is:

1. Record the active system and authoritative state. Turn off the committed
   config gate and runtime dispatch gate through the reviewed deployment path;
   stop the timer and quiesce the writer, checking that no tick remains in flight.
2. Use SHU-250's reviewed shutdown/admission controls to account for queued work
   and existing workers. Changing coordinator gates alone does not prove the
   supervisor or surviving workers cannot write or launch.
3. Once quiescent, record the post-switch baseline (including the pre-existing
   lock file, remote comments/receipts/pauses, durable supervisor/workspace state
   and process launch counters). Run the reviewed disabled tick repeatedly and
   observe across at least two wake intervals. Require zero new launches, zero
   write requests and an empty authoritative state diff. Exclude only explicitly
   documented operational logs, never receipt/workspace state.
4. Keep gates off and services quiescent during rollback. Restore backed-up host
   files and modes, remove newly introduced files, reload the manager and verify
   file and service-state diffs. Do not restore prior active/enabled settings that
   would resume work without separate authorisation. Preserve evidence.

This sequence is documentation, not an executed demonstration. Concrete shutdown,
admission, readiness, durable-state enumeration and restart/recovery proofs depend
on SHU-250. Actual installation, crash tests and running-system kill-switch proof
also require host access expressly excluded from this task.

## Deterministic tests and mutation scope

`test/service.test.mjs` contains the local harness, parameter escaping and syntax,
idempotency/backup, drift/symlink rejection, destination/transaction exclusion,
validation-before-write, real local flock exclusion/release, and partial-write
rollback tests. Ten negative controls assert named `AssertionError` messages:
six mutations of rendered unit policies, three mutations of collected evidence,
and one source mutation omitting rollback restoration. These do not claim mutation
coverage of SHU-250 or the existing coordinator. No existing source is mutated;
the rollback source mutation executes from a temporary copy.
