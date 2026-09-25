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
| attempt worktree | `SHU_WORKTREE_ROOT` configured and listed, and if the attempt's worktree exists, `HEAD` equals the receipt's `scoped_base_sha` and `git status --porcelain` is empty |
| remote branch | branch head still equals the order's `target_sha` |
| push/commit receipts | the workspace state dir listed, and no push receipt for the attempt |
| supervisor store | all four of `orders`/`runs`/`launches`/`completions` listed, and no record for the attempt |

Every probe stamps its own `observed_at`. An observation from **before** this
invocation started is a cached snapshot and is refused as `EVIDENCE_STALE`, not
believed. A probe that does not answer, or throws, is `EVIDENCE_MISSING`.

#### One clock, injected

Freshness is the only thing this operation compares timestamps for, and it
compares a probe's `observed_at` against this invocation's start. Both instants
must therefore come from the **same** clock. `reconcileDanglingAttempt` takes
`now` (default `nowIso`) and hands it to every probe it takes, so no probe reads
the wall clock behind the caller's back: with a clock injected, the operation's
verdict is identical whether the host clock is correct, a year fast or a year
slow. A probe that stamped the wall clock while the start came from anywhere else
would be measuring the disagreement between two clocks, not the age of the
evidence — and it would answer `EVIDENCE_STALE` or, worse, accept a genuinely
cached observation, depending only on which way the two clocks happened to
differ. The tests pin this: every shipped probe is asserted to stamp the
instant it was given, so a regression to `new Date()` fails in the suite rather
than in whichever timezone or clock-shifted job runs next.

### "I could not look" is never "there is nothing there"

Every condition above is an **absence** claim, so one confusion decides the
whole operation: a probe that could not read must never report an empty result.
The failure direction is releasing the slot, so all three of these fail closed.

* **No probe uses `fs.existsSync`.** It answers `false` on `EACCES`, `EIO` and
  `ENOTDIR` exactly as it does for a genuinely absent path, so an unreadable
  directory would be indistinguishable from an empty one. The probes list
  directory **entries** instead; a listing that throws is `EVIDENCE_MISSING`.
* **An unconfigured environment variable is not a measurement.** `defaultWorktree`
  reports `root_configured: false` when `SHU_WORKTREE_ROOT` is unset and the
  operation refuses `EVIDENCE_MISSING`. Without this, omitting one variable from
  the invocation below skipped the HEAD and porcelain comparison entirely and the
  terminal `HOLD` was written over a worktree that had moved off its base and was
  dirty. `defaultSupervisorStore` and `defaultPushReceipt` refuse the same way via
  `readable: false`.
* **The two supervisor-claim checks must be genuinely independent.**
  `supervisor.mjs` `status()` returns `hold_code: MISSING_CLAIM` from a
  **catch-all**: any read fault inside it — an unreadable `orders/`, a truncated
  run record — produces the same answer as a real absence. The on-disk store
  probe is only a second opinion if it can prove it actually read the store, so
  `readable: true` requires **all four** record directories to have been listed.
  A state dir a real supervisor has used always has all four, because
  `SupervisorStore`'s constructor creates them.

### Detecting a worker that is invisible to a `grep`

`supervisor-worker.mjs` forks the child with **empty argv**, delivers the order
over IPC, and `supervisorChildEnvironment()` is a fixed allow-list of variable
*names* that carries no attempt_id. So neither `/proc/<pid>/cmdline` nor
`/proc/<pid>/environ` ever contains the attempt_id, and a substring scan of them
cannot see a real worker at all. `defaultWorkerProcesses` therefore takes three
sightings:

1. a pid the **supervisor itself** recorded for the attempt in `launches/` or
   `runs/`, still present in the process table;
2. any process whose `cwd` resolves into the attempt's own worktree;
3. any process carrying the attempt_id in argv or the environment.

A `/proc` that cannot be listed, or a `launches/` that cannot be read, throws:
`EVIDENCE_MISSING`, never "no worker". Sighting 2 means that running this command
from **inside** the attempt worktree refuses on the operator's own shell; that is
the fail-closed direction — run it from elsewhere.

### A sighting is not a live worker

A sighting is an observation taken at **match time**. By the time the verdict is
formed the process may have exited, and the kernel may have handed its pid to
something else. Reporting a sighting as a confirmed live worker is how a refusal
becomes unauditable: `WORKER_LIVE -- live worker process(es) 2770495`, with pid
2770495 already absent from `/proc`, unknown to `ps` and absent from the journal,
is a refusal nobody can confirm or disprove afterwards.

So every sighting captures a **stable identity** at match time — the pid, the
kernel's process-start token (field 22 of `/proc/<pid>/stat`, the same slice
`supervisor-worker.mjs` records as `process_token`), a redacted command line, and
the **file that supplied the pid** — and `defaultWorkerLiveness` then looks again,
by pid, before any verdict is formed. Comparing the two observations gives one of
seven named dispositions:

| disposition | what was established | refusal |
| --- | --- | --- |
| `CONFIRMED_LIVE` | the pid is still present **and** its start token is unchanged | `WORKER_LIVE` |
| `UNVERIFIED` | the pid is still present, but its start token could not be read at the sighting or at the re-check | `WORKER_UNVERIFIED` |
| `UNOBSERVED` | the re-check returned no observation for the pid | `WORKER_UNVERIFIED` |
| `PRESENCE_UNREADABLE` | `/proc/<pid>` could not be read at the re-check (any stat fault but `ENOENT` — `EACCES`, `ENOTDIR`, an I/O error), so the pid was neither observed present nor proved gone | `WORKER_UNVERIFIED` |
| `VANISHED` | `/proc/<pid>` is gone: the sighted process exited before the verdict | `WORKER_STALE_RECORD` |
| `TOKEN_CHANGED` | the start token changed: the pid was reused by another process | `WORKER_STALE_RECORD` |
| `RECORD_TOKEN_MISMATCH` | the run record's `process_token` disagrees with the live process's start token **and** no independent sighting binds the pid to this attempt | `WORKER_STALE_RECORD` |

`WORKER_LIVE` now means **proved**, and nothing else can claim it. Precedence is
confirmed → unverified → disproved, so a single confirmed worker outranks any
number of stale sightings.

`VANISHED` is the only disposition that asserts an absence, so it is reserved for
an absence the kernel confirmed: `readProcessIdentity` reports `exists_known:
false` for every stat fault but `ENOENT`, and that is `PRESENCE_UNREADABLE`, which
fails closed as unverified. "I could not look" is never rendered as a fact — the
audit line prints `token_at_recheck=unreadable`, never `absent`.

`RECORD_TOKEN_MISMATCH` is a statement about a **record**, and the record is what
this operation was invoked because it does not trust. It therefore decides only a
pid that nothing but that record binds to the attempt. A process whose cwd is the
attempt's own worktree, or that carries the attempt_id, was bound to the attempt
*by observation* (`independently_bound=yes` in the audit line): a stale
`process_token` cannot exonerate it, so it falls through to the token checks,
which can reach only `CONFIRMED_LIVE`, `TOKEN_CHANGED` or `UNVERIFIED` — never a
release. The record's disagreement stays in the evidence either way:
`recorded_token` and `token_at_sighting` are both printed.

### Which combination is allowed to proceed, and why the slot stays protected

**No** sighting ever permits terminalization. Every one of the seven dispositions
above is a refusal. The only thing that proceeds past the worker checks is a
record naming a pid that was **never in the process table during this
invocation** — nothing was seen, so there is nothing to confirm and nothing to
disprove, and that is the case the old code already treated this way.

That path is not a hole, because it is still gated by every other safeguard,
none of which is weakened:

- the supervisor's own **signed `MISSING_CLAIM`** over its authenticated
  transport (any other answer, or an answer with no hold code, refuses);
- the **supervisor store**, listed independently, with all four record
  directories readable and **no record of any kind** for the attempt. Any pid
  from sighting 1 comes *from* such a record, so a stale supervisor record can
  never release the slot: the store guard necessarily refuses
  `SUPERVISOR_CLAIM_PRESENT` first;
- the attempt **worktree** measured at its recorded `scoped_base_sha` and clean,
  with an unconfigured root refusing `EVIDENCE_MISSING` rather than reading as
  absent;
- the **remote branch head** still equal to `target_sha`;
- **no push/commit receipt** in a directory that was actually listed;
- and **freshness** on every probe, so no verdict rests on an observation that
  predates this invocation.

Only all of those together release the slot.

### The refusal is the evidence

Each worker refusal carries one line per sighting, in the detail string, in the
structured `evidence.sightings`, and on stdout as `WORKER_SIGHTING …`:

```
WORKER_SIGHTING pid=2770495 disposition=VANISHED check=/proc/<pid> presence at re-check \
  source=worktree_cwd source_path=/proc/2770495/cwd recorded_token=none \
  token_at_sighting=900900 token_at_recheck=absent cmdline="/usr/bin/node …"
```

pid, the check that decided, where the pid came from, the token then and now (or
`unreadable`/`absent`), whether an independent sighting bound the pid to the
attempt, and the command line — so any refusal can be reconstructed from the log
alone. The command line is redacted **per argv entry**: the NUL separators are
honoured *first*, because they are the only evidence of where one argument ends,
and each whole entry is then redacted — the complete next entry after a sensitive
flag, a `NAME=` assignment matched without regard to case, an HTTP
`Bearer`/`Basic` value, and the userinfo of a URL. Flattening argv to spaces
before redacting would publish any credential containing a space, since a
one-word rule hides exactly one of its words. A redacted argument keeps its name
and loses its value, so a refusal stays readable enough to recognise the process;
collapsing whitespace and truncating to `WORKER_CMDLINE_MAX` characters happen
last, where they can only remove characters.
`/proc/<pid>/environ` is read to *match* the attempt_id and then discarded: an
environment block is a secret store and no truncation makes it safe to log.

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
| `RECONCILE_REFUSED: WORKER_LIVE` | a worker process for this attempt is **confirmed** still running: the sighted pid is still present and its process-start token is unchanged |
| `RECONCILE_REFUSED: WORKER_STALE_RECORD` | a sighted pid is provably not that process any more — it vanished, its start token changed, or a run record's `process_token` disagrees with the live process |
| `RECONCILE_REFUSED: WORKER_UNVERIFIED` | a sighted pid is still present but its identity could not be established (its start token could not be read, or the re-check did not answer for it) |
| `RECONCILE_REFUSED: WORKTREE_CHANGED` | the worktree moved off its recorded scoped base, or is dirty |
| `RECONCILE_REFUSED: BRANCH_MOVED` | the branch's remote head no longer equals `target_sha` |
| `RECONCILE_REFUSED: PUSH_RECEIPT_PRESENT` | a push/commit receipt exists: an external effect may have landed |
| `RECONCILE_REFUSED: EVIDENCE_MISSING` | a required probe did not answer |
| `RECONCILE_REFUSED: EVIDENCE_STALE` | a probe answered from before this invocation |
| `RECONCILE_REFUSED: WRITE_UNCONFIRMED` | every condition held, but the Linear write did not confirm |

`WRITE_UNCONFIRMED` is the one code that does not assert the slot is preserved:
the comment may or may not have landed. Re-running is safe and is the repair — a
landed write makes the second run refuse `ALREADY_TERMINAL`.

Configuration that cannot be loaded and a Linear write that throws are reported
by name like everything else; no path leaves the operator reading a bare stack
trace, which is the one moment the naming discipline exists for.

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

## Running it ON THE HOST: the coordinator service's own recovery request

The command above cannot be used on the brick box. `supervisorTransportSecret()`
pins the credential directory to `/run/credentials/shu-coordinator.service`, so a
transient unit — even with the same uid and the same `LoadCredential=` — gets its
credentials materialised under its **own** unit name and the operation refuses
`EVIDENCE_MISSING: ACT_CREDENTIAL_UNAVAILABLE`. Measured twice on the live host.

The pin is not the bug; it is the guard that makes the transport secret
unreachable from anywhere but the reviewed unit. So the operation is not moved to
the credential — the **request** is moved to the unit.

### The mechanism

`recovery-request.mjs` adds a single-use, attempt-bound request file that the
coordinator service's normal entry point consumes:

* the file is `$SHU_WORKSPACE_STATE_DIR/recovery-request.json`, mode **0600**,
  owned by the service's own uid, inside the unit's private (`0700`) state
  directory. That path is the **whole** channel: `recoveryPaths()` joins
  `recovery-request.json` onto `env.SHU_WORKSPACE_STATE_DIR` and looks nowhere
  else — never a guessed path, never a fallback. A request written to any other
  directory is **silently ignored**: the entry point's one `open()` still fails
  `ENOENT`, the wake is an ordinary dry-run tick, and *nothing reports that a
  request existed*. Deriving the directory from anything but the deployed
  `SHU_WORKSPACE_STATE_DIR` is therefore a silent no-op, not an error. The
  request is created by `service/request-recovery.mjs`, which obtains that
  directory from the deployed unit rather than accepting one, so the writer
  cannot be pointed anywhere the reader does not look;
* `coordinator-tick.mjs` — the unit's unchanged `ExecStart`, unchanged argv —
  consumes it *before* it would otherwise tick, and then invokes **only** the
  operation it names;
* the unit, the timer, `ExecStart=` and `Environment=ENABLE_DISPATCH=false` are
  untouched. **No unit edit swaps `ExecStart` for a one-off run**: that would
  replace the reviewed command with an unreviewed one and leave the unit in that
  state if the operator's session died.

The operation therefore executes inside `shu-coordinator.service`, in the process
systemd gave the credential to, and inherits the existing delivery exactly.

```
                       no request   ->  the tick, with exactly the argv it
  timer/systemctl start                 always got (dispatch-off => [])
      |                             ->  ORDINARY WAKE, byte-identical
      v
  coordinator-tick.mjs  --  one open() that fails ENOENT
      |
                       request      ->  ONLY reconcileDanglingAttempt({attempt_id})
                                        the tick does not run at all
```

### Single use, and replay

Consumption is **unconditional and happens before the operation runs**. Whatever
the outcome, the request file is gone and its `request_id` has been recorded in
`recovery-consumed/` with `O_EXCL`, so:

* exactly one invocation can ever act on a given request file;
* a re-presented `request_id` loses the exclusive create and is refused
  `REQUEST_REPLAYED`, by name, having run nothing;
* a refusal **removes** the request, so the next wake finds none and is an
  ordinary tick again. The one case where removal can fail is an object at the
  request path that will not unlink — a directory there (an operator typo, a
  `mkdir`, a `cp -r`/rsync of a staging tree) or a `SHU_WORKSPACE_STATE_DIR` that
  is not a directory. That case would otherwise refuse on **every** wake forever
  while `SuccessExitStatus=2` kept systemd reporting the unit as *succeeding*, so
  `systemctl status` and `is-failed` would look healthy while the coordinator had
  silently stopped ticking. It is therefore refused by its own name,
  `REQUEST_UNREMOVABLE`, and exits `4` — a code the unit does **not** list, so the
  wedge fails the unit and is visible. The refusal names the path to remove by
  hand, and nothing was consumed and no operation ran;
* a **fresh** `request_id` for an attempt that has already been terminalized runs
  the operation, which refuses `ALREADY_TERMINAL` from the durable chain before
  any supervisor contact and writes nothing. Second use is idempotent.

The ledger entry carries the canonical request and **no timestamp**: journald
records when, and no clock has any part in deciding whether a request is valid.

### What this path cannot do

* **It cannot dispatch or launch.** `RECOVERY_OPERATIONS` is a frozen table with
  exactly one entry, bound at module scope to `reconcileDanglingAttempt`; any
  other operation name is refused `REQUEST_OPERATION_UNKNOWN` before any I/O. The
  module performs no dynamic `import()`, names no adapter, no dispatch entry
  point and no launcher, and takes only two validators (`UUID_RE`,
  `authorizationRefValid`) from `reconcile.mjs`. Its transitive **static** import
  closure adds nothing at all to the closure the reviewed operation already had,
  and contains no `adapters/*`, no `supervisor-worker.mjs` and no
  `capacity-scheduler.mjs` — the launchers are reachable only through
  `reconcile.mjs`'s dynamic `import()`, which nothing here can perform or name.
  The operation it does reach still signs only `status`.
* **It cannot run the tick.** The entry takes one branch or the other, never
  both.
* **It cannot enable dispatch or arm anything.** It never writes
  `ENABLE_DISPATCH`, never touches the activation file, never starts or enables a
  unit or timer, and refuses `REQUEST_DISPATCH_ENABLED` outright if it is ever
  reached with `ENABLE_DISPATCH=true`.
* **It handles no secret.** The request carries three non-secret identifiers and
  a marker. Nothing is placed in the unit's argv, which stays byte-identical; the
  requester's own command line carries those same three non-secret identifiers
  and never a credential. A malformed request's bytes are never
  echoed — only the shape violation is named — because an operator may paste
  anything into that file.

### Request refusal codes

Everything is by name here too, and every refusal runs nothing. All but one
consume the request as well; `REQUEST_UNREMOVABLE` is the exception, and it says
so, because the request path is precisely what could not be removed.

| code | meaning |
| --- | --- |
| `RECOVERY_REFUSED: REQUEST_UNREADABLE` | a request exists but could not be opened or read |
| `RECOVERY_REFUSED: REQUEST_INSECURE` | not mode 0600, not owned by the service uid, not a regular file, or a symlink |
| `RECOVERY_REFUSED: REQUEST_MALFORMED` | not JSON, or not exactly the five reviewed fields with a valid marker and `request_id` |
| `RECOVERY_REFUSED: REQUEST_TOO_LARGE` | over `RECOVERY_REQUEST_MAX_BYTES` (4096) by the `fstat` already in hand — refused *before* the bytes are read into the unit |
| `RECOVERY_REFUSED: REQUEST_OPERATION_UNKNOWN` | the named operation is not in `RECOVERY_OPERATIONS` |
| `RECOVERY_REFUSED: REQUEST_ATTEMPT_INVALID` | `attempt_id` is not a UUID |
| `RECOVERY_REFUSED: REQUEST_UNAUTHORIZED` | `authorization_ref` is not a card ref or a seeded fixture contract ref |
| `RECOVERY_REFUSED: REQUEST_UNRECORDED` | the single-use ledger could not be written, so single use is not guaranteed |
| `RECOVERY_REFUSED: REQUEST_REPLAYED` | this `request_id` was already consumed |
| `RECOVERY_REFUSED: REQUEST_UNREMOVABLE` | the object at the request path outlived the refusal, so every later wake would refuse it again — **exits 4 and fails the unit**, see above |
| `RECOVERY_REFUSED: REQUEST_DISPATCH_ENABLED` | `ENABLE_DISPATCH` is true; recovery runs only with dispatch off |
| `RECOVERY_REFUSED: REQUEST_OPERATION_FAILED` | the reviewed operation did not complete |

A well-formed request for an attempt that the operation then refuses reports the
**operation's** own `RECONCILE_REFUSED: …` code verbatim: the request channel
narrows what may be *asked*, and the reviewed operation still decides.

Exit codes: `0` terminalized, `2` refused, `4` wedged (`REQUEST_UNREMOVABLE`).
`2` is deliberate — the unit lists it in `SuccessExitStatus=`, so a correct
refusal cannot trip `Restart=on-failure` into `StartLimitBurst=` and leave the
unit failed. `4` is equally deliberate and for the opposite reason: it is **not**
listed, because a request that cannot be removed means the coordinator will never
tick again, and that must fail the unit rather than be reported as success.

`WRITE_UNCONFIRMED` is the one refusal whose line does **not** say "nothing
written": it means the terminal HOLD comment may have landed without confirming,
and the repair is to re-run the recovery. Every other refusal line ends
`; nothing written, slot preserved`, which is the literal truth for it.

### The operator command

The destination is not a choice, and it is **not the operator's to supply**. The
request file must be exactly `$SHU_WORKSPACE_STATE_DIR/recovery-request.json` on
the deployed host. **A request written anywhere else is silently ignored**: the
entry point's one `open()` still fails `ENOENT`, the wake is an ordinary dry-run
tick, and the journal shows no `RECOVERY_*` line at all — so a misrouted request
is indistinguishable from a recovery that ran, and an operator who typed the
wrong directory would reasonably believe it had.

That is why there is no directory to type. `service/request-recovery.mjs`
**obtains** `SHU_WORKSPACE_STATE_DIR` from the deployed unit itself —
`systemctl show -p Environment --value shu-coordinator.service`, parsed strictly
— writes into that directory and no other, and refuses **by name, before any
file is created**, if the unit's value cannot be obtained or if anything the
operator did supply disagrees with it. A request that would have been misrouted
therefore cannot be created at all, rather than being created somewhere the tick
never looks.

```sh
sudo -u shu-coordinator \
  node .github/coordinator/service/request-recovery.mjs \
    --attempt 9c461519-4bc8-4e75-8d65-d61b8954e1f0 \
    --authorization-ref SHU-140

sudo systemctl start shu-coordinator.service
sudo journalctl -u shu-coordinator.service -n 20 --no-pager
```

Run it as the service user, from the coordinator checkout (the unit's
`WorkingDirectory=`). The command takes `--attempt` and `--authorization-ref`
and nothing else is required. `--state-dir` is accepted **only to be checked** against the unit's
deployed value — it is never written to and never trusted — so passing it can
only ever turn a wrong assumption into a named refusal. `--request-id` defaults
to a fresh UUID.

On success it prints exactly the path it created, and nothing else:

```
REQUEST_WRITTEN path=/srv/shu/state/workspaces/recovery-request.json
```

That is the unit's `Environment=SHU_WORKSPACE_STATE_DIR`, which expands
`WORKSPACE_STATE_DIR` from `service/units.mjs`, joined with the reader's own
`recoveryPaths()`. The file is created under a staging name with `umask 077`,
`chmod 0600`, then linked into place, so the entry point can never read a
half-written request and an unconsumed request is never silently replaced. Exit codes: `0` written, `2` bad usage, `3` refused by
name (nothing created).

#### Requester refusal codes

| code | meaning |
| --- | --- |
| `RECOVERY_REQUEST_REFUSED: STATE_DIR_UNKNOWN` | the unit's `SHU_WORKSPACE_STATE_DIR` could not be obtained or parsed — the directory is not guessed, and no request is written |
| `RECOVERY_REQUEST_REFUSED: STATE_DIR_MISMATCH` | a supplied directory (`--state-dir`, or `SHU_WORKSPACE_STATE_DIR` in the invoking environment) is not the unit's deployed one |
| `RECOVERY_REQUEST_REFUSED: ATTEMPT_INVALID` | `--attempt` is not a UUID |
| `RECOVERY_REQUEST_REFUSED: AUTHORIZATION_REF_INVALID` | `--authorization-ref` is not a card ref or a seeded fixture contract ref |
| `RECOVERY_REQUEST_REFUSED: REQUEST_ID_INVALID` | `--request-id` is not a UUID |
| `RECOVERY_REQUEST_REFUSED: REQUEST_PENDING` | an unconsumed request is already at that path — the channel is one slot, and replacing it would drop the first request silently |
| `RECOVERY_REQUEST_REFUSED: REQUEST_NOT_WRITTEN` | every check held, but the file could not be created or renamed into place |

The first two are the ones that close the silent misrouting: between them, the
directory the request lands in is always the one the tick reads, or there is no
request and a named reason on stderr.

If you nonetheless see neither `RECOVERY_TERMINALIZED` nor a `RECOVERY_REFUSED:`
line in the journal after the start, the request was never seen — do not conclude
the recovery ran.

`systemctl start` runs the existing, unmodified unit once. It does not enable the
timer, does not enable dispatch and arms nothing; `ENABLE_DISPATCH=false` stays
exactly as the unit declares it. The journal reports either

```
RECOVERY_TERMINALIZED attempt=<id> stage=HOLD slot=released authorization_ref=<ref> request_id=<id>
```

or a single named refusal line. Re-running is safe: a landed write makes the next
request refuse `ALREADY_TERMINAL`, and re-presenting the same `request_id`
refuses `REQUEST_REPLAYED`.

## Proofs

`.github/coordinator/test/receipt-state.test.mjs`, the eleven `SHU-140
reconcile-dangling` cases, in two layers.

The **decision** cases inject every probe, so each one degrades exactly one
condition and a refusal can only come from the guard that case names.

The **probe** cases (`SHU-140 reconcile-dangling probe: …`) run the shipped
default probes for real, against a real directory tree and a real synthetic
`/proc` built with node core `fs` — because a suite that pins only the decision
logic cannot see a probe that reports "I found nothing" when it never looked,
which is how both of the fail-opens above reached review. The boundaries the
sandbox cannot supply are injected at the probe (`gitImpl`, `procRoot`), so the
proofs still need no real git, no real `/proc`, no socket and no network, and the
file's audited capability set stays `[]`.

The **requester** cases (`SHU-140 request-recovery: …`, three of them) cover the
operator command above: the positive, in which the request lands at exactly the
unit-configured `$SHU_WORKSPACE_STATE_DIR/recovery-request.json`, mode 0600, with
the neighbouring wrong directory untouched and the service side really consuming
what was written; and the two refusals that close the silent misrouting — a
mismatched directory and an unobtainable or unparseable unit value, each proved
to leave no request and no staging residue at either path, and to leave the entry
point taking its ordinary tick branch. The unit read is injected, so the proofs
need no systemd; the files are real on disk, because "nothing was created" is a
property of the filesystem and not of a decision function.

The **service-request** cases (`SHU-140 recovery-request: …`, seven of them) cover
the mechanism above: the unchanged ordinary wake, the exact-attempt binding,
single use and replay, every named request refusal, the static and
by-construction proof that dispatch and launch are unreachable from this path,
and the preserved dispatch-off/timer-disabled posture. The request file is real
on disk in those proofs — a real 0600 file in a real directory, consumed for real
— because single use, replay refusal and "the ordinary wake is untouched" are
properties of the filesystem handshake, not of a decision function. Still no
socket, no network, no real git and no spawned process, so the capability set
stays `[]`.
