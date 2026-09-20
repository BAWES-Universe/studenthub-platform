# SHU-71 L3 correction record — not an execution approval

Base: `0ccee5180e3f63e77028769b89dca226acd19c5c`, branch
`chore/shu71-production-composition`. This is the stacked L1/L2 history. The
starting index was clean; no merge conflicts required resolution. Authorship:
Codex, repository-only correction, 2026-09-17. The enclosing commit identifies
this candidate's exact head; no main/remote head is claimed.

This record reconciles B1, B2 and B4 against the governing Hermes final execution
closure directive and `/home/bawes/work/reconciliation-135.md`. It does not replace
the consolidated A–D gate or authorize a live window.

| Row | Disposition | Evidence and remaining limit |
| --- | --- | --- |
| B1 | `CONFIRMED_BLOCKER` — substantially implemented, not fully closed | `shu71-production.mjs` implements the owner-approved transaction through real filesystem, Git, HTTP and systemctl adapters. Tests exercise signing through teardown and interrupted recovery. A complete production-entrypoint proof of two concurrently running fixture lanes through build, BLOCK, revision and re-review is still missing. In particular, the rendered supervisor environment does not yet bind all non-secret worker/model runtime settings (wrapper, durable account home and push configuration). This must be resolved and composed with L1/L2 before claiming an executable window. Correction owner remains this lane. |
| B2 | `CLOSED_BY_NEW_HEAD` for the three named wiring contradictions; B1's broader runtime composition remains blocking | Fixed activation argv, a systemd transport credential, and a separate bounded API-evidence process replace the contradictory environment requirements. `shu71-delivery.test.mjs` and named source mutations exercise the actual delivery code. No existing split-environment assertion is removed. This is source-level closure, not a claim that the new unit/identity has been provisioned. |
| B4 | `CLOSED_BY_NEW_HEAD` for the new production command | Durable independent custody, a hashed append-only journal, recovery stream for torn evidence, aggregate cleanup, physical expiry service, and separate expiry/completion events. The crash matrix replaces the process before/after every modeled mutation/durability boundary. Kernel/systemd/disk behavior still requires the eventual authorized live proof. The callback library is sanitized and its gate failure no longer aborts independent teardown; it is not the production recovery entrypoint. |

## Production entrypoint and authority

The installed entrypoint is
`/usr/bin/node /usr/local/lib/shu71/coordinator/service/shu71-production.mjs run|resume|revoke|expire <activation-id>`.
It accepts only the action and bounded activation ID. It selects the frozen
production boundary itself, uses a common kernel flock, and never accepts an
operator-authored callback, URL or executable. The dependency tree must be
installed root-owned at `/usr/local/lib/shu71/coordinator`; the forward path
compares its non-test files with Git blobs at the exact approved revision.
Installation/provisioning of this reviewed release is a prerequisite, not an
operation performed in this correction session.

The owner artifact is `/etc/shu/approvals/<id>.shu71.json`, signed by the separate
Ed25519 owner key at `/etc/shu/approvals/shu71-owner.pub`. Its exact payload keys
are `kind`, `checkout`, `tree`, `pkg`, `binding`; kind is `shu71-production-v1`.
`pkg` is the existing package with both signatures empty; `binding` is the
reviewed deterministic reseed binding, including its tree and manifest. The
existing package's structural/trust guards run before signing and the complete
signature validation runs afterward. There is no generated production key,
activation-ID minting, owner-approval manufacture or assignee authority outside
the exact approved package.

One durable signing transaction produces the two signatures required by the
existing package and envelope formats. This necessarily makes **two Ed25519
sign calls**, not one cryptographic signature. If interrupted after signing
starts but before a durable result exists, it refuses `ACT_SIGNING_AMBIGUOUS`
and tears down. It never silently signs again. A new owner disposition is
required to proceed after that ambiguity. Resume of an already-armed episode
conservatively revokes, including when an earlier revoke died before its first
journal write.

| Authority/effect | Production adapter | Evidence/recovery |
| --- | --- | --- |
| Exact revision/tree and fixture parents | Git as UID/GID 999 with cleared supplementary groups; local refs, explicit HTTPS ls-remote, fixed GitHub repository API | `binding` intent/completion; clean checkout and main/API equality |
| Package and runtime envelope signing | Fixed root-only signing-key path `/etc/shu/keys/shu71-activation-ed25519.pem` | `SIGNING_STARTED`, durable signed package, adoption or ambiguous-signing refusal |
| Local append | Existing `createReseedAppendIo` and commit/manifest verifier | Deterministic commit, expected-parent update-ref; observes an already-installed result |
| Remote append | Explicit refspec and `--force-with-lease=<ref>:<expected-old>` after verified ancestry | Adopts an already-pushed exact SHA; local/remote/API readback, manifest and API ancestry |
| Exact fixture transitions | Fixed Linear GraphQL read/update operations; exact signed issue UUID, state and assignee; readback | Intent precedes each card change; restore runs independently for both fixtures |
| Activation and gates | Atomic activation file and fixed systemd drop-ins; fsync of file and parent | Intent before placement; reruns idempotent effects after interruption |
| Expiry/revoke | Persistent periodic expiry unit, also started at boot; fixed gates, activation removal, cgroup kill and service stop | `AUTHORIZATION_EXPIRED` is separate from `TEARDOWN_COMPLETE`; failed steps remain retryable |
| Fixture cleanup/archive | Episode-bound private workspace authority records, owner/inode checks, same-device tree, retained sidecars | Removal intent before deletion; archive, manifest and independent root-owned custody retained |

The root custody snapshot and original journal remain at
`/srv/shu/state/shu71-evidence/<id>/`. A damaged journal is retained byte-for-byte;
`recovery.jsonl` records narrow cleanup under the authenticated custody snapshot.
A recovery stream cannot authorize forward activation. An old expiry wake cannot
tear down a successor activation. A global active-episode marker prevents two
activation IDs from sharing the physical gates.

## Least-privilege delivery

| Process | Identity | Credential access and fixed delivery |
| --- | --- | --- |
| Production signer/teardown | root | Fixed owner artifact/key and signing-key paths; reads only the required GitHub/Linear bindings for its fixed operations. Git runs as 999, with only GitHub authentication passed to that bounded Git process. No command stderr or secret values enter receipts. |
| Coordinator tick | `shu-coordinator` (package contract UID 999) | Its existing coordinator environment stays separate. `LoadCredential=supervisor-transport:/etc/shu/supervisor.env` exposes only the single-key transport file under `/run/credentials/shu-coordinator.service/`; it is read at the transport call site, never exported into `process.env`. |
| Supervisor | same existing service identity | Its root-owned `0600` environment still contains only `SHU_SUPERVISOR_SECRET`; no GitHub/Linear token is added. |
| Trusted supervisor adapter child | same service identity; sandboxed writer/reviewer remain 995/994 | An exact allowlist admits runtime configuration plus the two required adapter model credentials, CLAUDE_CODE_OAUTH_TOKEN and WORKSPACE_AGENT_ACCESS_TOKEN. GitHub/Linear API and supervisor transport credentials, aliases and unknown keys are refused. Fixed evidence-client argv sends only an `evidence` or SHA-bounded `ancestry` request to the local broker. |
| Fixture evidence broker | named `shu71-evidence`, service primary group `shu-workspace` | Separate systemd service reads the existing coordinator environment; its code consumes GitHub/Linear bindings only. Socket `/run/shu71-evidence/fixture.sock`, mode 0660, shared-group runtime directory 0750. The fixed repository and two fixture IDs are compiled into the broker; caller-supplied URLs, queries, writes and executables are rejected. |

No secret files are combined, re-owned or copied into supervisor/worker
configuration. The broker is a trusted credential consumer, not a secret-export
endpoint. Receipt metadata and errors contain no credential values. The operative
[`renderEvidenceBroker()`](shu71-production.mjs#L1531) binds
`User=shu71-evidence` and `Group=shu-workspace`; the provisioner's
[`identity()`](provision-shu71-prerequisites.mjs#L182) and
[`sharedAccess()`](provision-shu71-prerequisites.mjs#L195)
resolve the identities by name and refuse messagebus/UID 996 substitution.
Actual host identity allocation, coordinator membership, installed-library
custody, source-file metadata and systemd behavior remain unmeasured host facts.

The service primary group is a bounded expansion of the broker's read scope:
`shu-workspace` allows reading and traversing group-accessible files, including
coordinator attempt worktrees ([workspace layout](SHU-261-VALIDATION.md#L12)).
`ProtectSystem=strict` makes that hierarchy read-only in the service;
`NoNewPrivileges` and `PrivateTmp` constrain privilege gain and temporary-file
visibility. The broker exposes only its two fixed requests
([broker implementation](fixture-evidence-broker.mjs)), not arbitrary file
reads. Group membership does not grant root identity, bypass owner-only file
permissions, grant worktree writes through the service sandbox, or add arbitrary
API requests, commands or a credential-export endpoint. These mitigations bound
the expansion; they do not eliminate the additional filesystem read authority.

`coordinator-tick.mjs --activation /srv/shu/state/shu71-activation.json` is rendered
literally. With the runtime gate off it invokes a normal disabled tick; with the
gate on it requests exactly that activation. This preserves runnable Phase-A
zero-write ticks without weakening missing/invalid activation guards. Children
obtain actor-bearing fixture comments through the bounded reader and use the
existing receipt parser and L2 progression verifier; pagination beyond the
bounded response refuses rather than accepting partial provenance.

## Verification and limits

Test counts and failure classification are recorded in `SHU71-L3-TESTS.json`.
All new production tests inject command/API/syscall boundaries and disposable
keys. None can invoke a real systemctl, network API, production key or host path.
The filesystem double records fsync boundaries and injects failures; it does not
claim to prove kernel durability. Existing assertions, refusal codes, security
guards and skip allowances have not been weakened. Two older mutation harnesses
now copy the new dependency alongside `units.mjs`; their assertions are intact.

Outstanding: complete worker-runtime delivery and the production-entrypoint
concurrent L1/L2/B1 composition; exact-head independent-family verification; the
historical environment-dependent test claims (not retroactively certified); and the directive's later
read-only host reconciliation and controlled live proof. Linear state updates
have before/readback checks, but this code does not claim a server-side Linear
compare-and-swap primitive. Only Git updates carry expected-old-value semantics.
No acceptance card is moved to Done by this implementation.

No target host was accessed, no production signing/reseed/activation occurred,
no push/PR/main merge happened, and no GitHub or Linear message was sent. No new
approval block should be issued from this candidate.


## Response to independent verifier at dae5948

The full `/home/bawes/work/verdict-140.md` and `.json` were read before editing.
The B1, B2 and B4 disposition markers above are unchanged: overall **BLOCK**,
B1 blocked, B2/B4 source-level only. These repairs do not authorize execution.
The verifier did not upgrade those markers. Its exact-head review does not
cover this later commit, which still requires independent verification.

- **F1 — stale completion receipt:** a completed journal no longer suffices to
  attest present teardown. Both fixed gate files must be custody-checked and
  contain the disabled value, the activation path must be absent, and all three
  dispatch services plus the evidence broker must report inactive/failed.
  Missing/unreadable evidence or drift returns `ACT_TEARDOWN_DRIFT`, never a
  successful physical receipt. First completion and incomplete retries also
  observe these conditions before `TEARDOWN_COMPLETE`. Drift after a previously
  completed episode is refused, not automatically repaired. If another episode
  owns the shared gates, the old episode returns an explicitly historical
  `retired_episode` receipt with `physical_teardown_observed: false` and performs
  no service commands or shared-gate mutations.
- **F4 — credential denylist:** supervisor children now receive exact named
  runtime keys only (expanded for N1 below to include the two required model credentials). Case variants, suffixes, whitespace aliases and unknown variables cannot bypass the list.
  Tests also intercept the actual spawner's fork boundary. The three original
  secret-removal mutations now introduce those keys into the allowlist; their
  original assertions remain intact. F5's adjacent environment-secret bypass is
  repaired by sharing the same type/length/character validation with the fixed
  systemd credential path.
- **F2/F3 — trust-guard coverage:** direct tests reject journal payload/hash,
  previous-link, sequence, torn-record and custody attacks under their named
  refusal codes. Forged completion evidence is retained byte-for-byte while
  recovery removes activation. All six verifier survivors now have named
  assertion kills: NV1 installation binding, NV2 transition readback, NV3 atomic
  file fsync, NV4 journal hash chain, NV5 active-episode conflict, and NV6 owner
  Ed25519 verification. The durability oracle enumerates required files and
  write/file-fsync/rename/parent-fsync order independently of observed crash
  boundaries. Additional tests name process identity, approval-file custody,
  fixture-ref binding and remote-ancestry refusals.

The systemd credential, UID-996 broker, separate secret files and bounded,
credential-free receipts are preserved. No production operator callback was
added. All edits remain under `.github/coordinator/`; the declared PR base and
inherited L2 content were not changed.

Still unsupported or open: B1's complete worker runtime and concurrent lane
proof; every host/live-system property identified by the verifier; broker access
to the entire coordinator EnvironmentFile; F6's pre-journal owner-approval error
reporting; F7's callback-library validation-failure cleanup; and the verifier's
minor observations about installed-file inventory, unconditional restoration,
expiry operational behavior and the older authorization error path. These are
not claimed fixed by the guard/coverage repair. Historical test results are
retained as historical evidence, not retroactively certified.


## Response to R2 at eb29fc2

Read both verdict-140-r2 files in full. B1 remains blocked; B2 and B4 remain
source-level only. Prior F1/F4 guards, F5 validation, journal integrity coverage,
and all prior mutation kills remain required. No live acceptance is claimed.

**N1:** the exact allowlist now includes the model credentials actually consumed
by Claude Code and Workspace Agents, their trigger setting, CODEX_HOME, HERMES_BIN,
and the four push/lane configuration keys. These model credentials are distinct
from GitHub/Linear and supervisor transport authority, which remain excluded.
Parent-only supervisor socket/state settings remain excluded; stateDir uses IPC.
The test that wrongly classified the two legitimate model credentials as aliases
now rejects their suffixed aliases. A positive assertion at the real fork boundary
requires all nine adapter keys unchanged while rejecting unknown/aliased names
and control-plane secrets. Nine deletion mutations prove this positive coverage.
This repairs delivery when configured; rendering/provisioning those settings is
still part of blocked B1.

**N2:** incomplete teardown now replays gate disable, activation removal, worker
kill, service stops, reload and broker stop even when their journal rows say DONE.
Forward effects and remote fixture restoration retain their prior journal rules.
Observation remains mandatory on every attempt. Timer retirement follows the
manifest and observation, checks physical state again, and cannot run while the
current attempt has any failure, including on the fallback path.

The corrected test retains refusal and no-false-completion assertions under
persistent drift, additionally requires the retry timer to survive, then removes
the transient fault and requires recovery through each of resume/revoke/expire:
both gates disabled, activation absent, active lease released, completion recorded
and timer retired. Separate broker/service restart checks require another stop
and observed inactivity. Three source mutations reinstate DONE-based suppression
and are killed by these same genuine recovery assertions.

**Rollback mutation:** removed only its over-broad noSystemd gate. It passes with
SHU251_NO_SYSTEMD=1, using the temporary-directory-only installer. The earlier
claim that no-host constraints required this skip was wrong. Other skip allowances
and refusal codes are unchanged.

Exact current counts, commands and log hashes are in SHU71-L3-TESTS.json.
R2's minor R1 (higher-priority drop-in inventory) remains open, as do F6/F7,
broker whole-EnvironmentFile scope, B1 concurrent production-entrypoint proof,
and all host/live-system properties. This correction does not support claims
about real systemd, real durability, deployed custody, or live adapter execution.

## Response to R3 at 5e25c65

Both R3 verdict files were read in full. Overall remains **BLOCK**; B1 remains
blocked and B2/B4 remain **source-level only**. The confirmed N1 delivery fix,
pre-completion drift recovery and un-gated rollback mutation are preserved.

- **P1:** the genuine assertion suite now re-arms a real fixture gate when the
  expiry-timer INTENT is written, after the first observation and before timer
  retirement. It requires `ACT_CLEANUP_FAILED`, retained ownership and timer,
  and no completion row, then demonstrates recovery. Removing only the second
  `observeTeardown()` is killed by `B4_RETIREMENT_REOBSERVATION`.
- **P4:** a fixture re-creates the activation file after unlink. It asserts
  refusal during drift and recovery via resume/revoke/expire after the fault
  clears. Removing only activation from the replay list is killed by
  `B4_ACTIVATION_DRIFT_RECOVERED`.
- **P5:** repeated wedged wakes must issue zero further remote API calls and
  zero archive replacements after their first successful completion. Forcing
  every effect to repeat is killed by `B4_RESTORES_ONCE_ONLY`. These are
  once-only rules for completed journal steps, not an exactly-once guarantee
  for a remote effect interrupted before its DONE record.
- **P3:** automatic cleanup is limited to **32 reserved attempts per activation
  ID**, including the initial automatic teardown. The counter is a root-owned
  private atomic file, `shu71-evidence/<id>/automatic-teardown.json`, fsync'd
  before cleanup effects. It survives process replacement and is independent
  of both journal streams, so damaged-journal recovery cannot renew the budget.
  Manual run/resume/revoke do not reset the counter. The genuine test drives all
  32 attempts and 40 further wakes, requiring no more cleanup commands, remote
  calls, file writes or journal rows after exhaustion. Removing the cap is
  killed by `B4_AUTOMATIC_REPLAY_BOUNDED`. Interrupted reservation and invalid
  counter tests also require refusal and subsequent explicit manual recovery.

### Retry cost, exhaustion and operator recovery

Previously, sustained drift produced an **unbounded 1 Hz replay**. R3 measured
10 journal rows, 9 systemctl calls and 27 modeled fsyncs per wedged wake; the
whole hash chain was re-read on each wake. That cost was omitted from the prior
correction record. The 32-attempt budget bounds automatic cleanup replay and its
journal growth; reserving each attempt adds an atomic counter write and its
file/parent fsyncs. Explicit operator invocations remain independently retryable.

At exhaustion, `expire` returns `HALT / ACT_RETRY_BUDGET_EXHAUSTED` with
`operator_action: resume_or_revoke`. It does **not** claim teardown succeeded,
append TEARDOWN_COMPLETE, release ownership or retire the timer. Physical drift
may still be present, including an armed gate. Automatic repair no longer runs
after the budget is spent, even if the original drift later clears. An operator
must resolve the drift and explicitly invoke the installed production entrypoint
with `resume <activation-id>` or `revoke <activation-id>`. Those commands retain
all cleanup/readback guards and can complete and retire the timer without
resetting or deleting the counter. Do not delete custody, ownership or budget
files to obtain a fresh automatic allowance.

Unreadable, malformed or non-durable budget storage returns
`ACT_RETRY_BUDGET_UNAVAILABLE`; R4 now attempts both disk gate disarms
independently before returning that refusal, even if counter storage or the
journal is unavailable. A separate gate-write fault is surfaced in `failures`.
Explicit resume/revoke remain available using the existing independent cleanup path.
A reservation interrupted after persistence consumes an attempt, conservatively.
The cap is not a time guarantee: crashes can consume attempts without completing
any cleanup. The retained expiry timer and service restart policy still produce
1 Hz process wakes/refusal receipts and fixed-size journal verification/fsync
work after exhaustion; this change bounds **effect replay and evidence-journal
growth**, not process wakes or system journal retention. No host wake rate,
operator alert delivery, systemd behavior or disk durability was measured.

**P2 scope limit:** replay applies only before TEARDOWN_COMPLETE. Out-of-band
drift after completion returns ACT_TEARDOWN_DRIFT without repair; the timer has
already been retired. This pre-existing limitation remains open, as does R1's
lack of effective-systemd/higher-priority drop-in observation. The second
observation narrows the completion race; it cannot exclude a privileged writer
changing files after the final observation. P6's worker/reload/failure-guard and
fallback survivors are not claimed killed or equivalent by this correction.
F6/F7, B1 provisioning/concurrency, broker whole-EnvironmentFile scope and all
host/live-system proof obligations remain open. Exact current suite counts and
mutation results are recorded in SHU71-L3-TESTS.json.


### Response to R4 (repository-only)

The eleven confirmed retry/exhaustion statements above are retained. Their
no-completion/no-release statements describe the exhausted, physically drifting
case. No automatic **repair** is introduced after the 32-attempt budget.

**Q1 differential:** the genuine assertion suite executes the same mode-0644
counter input four times against repository objects at parent `5e25c65`, blocked
head `e9a68c1`, and this candidate. The parent disarms and completes; the blocked
head returns ACT_RETRY_BUDGET_UNAVAILABLE with zero effects and an armed gate on
every wake; the candidate disarms both disk gates and returns that refusal.
Counter failure now has an independent, non-journalled gate-disarm fallback.
Ordinary cleanup retains durable reservation before effects. Tests also cover
hard-link custody, malformed/range-invalid counters, and counter write, fsync
and rename failures. A simultaneous gate-write failure is separately surfaced,
and does not skip the other gate. Disk disarm does not establish systemd's
effective value: the pre-existing R1 host/effective-drop-in limitation remains.
A persistent counter fault can repeat these narrow gate writes; the zero-write
exhaustion claim concerns a valid exhausted counter, not broken counter storage.

**Q2:** the rendered `OnUnitActiveSec=1s` / `AccuracySec=1s` timer implies a
nominal grace of **about 32 seconds** for 32 attempts. Its accompanying
`Restart=on-failure` / `RestartSec=1s` loop can bring that to **about 16 seconds**
if the two wake sources contribute independently. These are artifact-derived
estimates, not measured host scheduling guarantees. A roughly forty-second drift
can outlast the entire automatic repair allowance. The failing restart loop
also contributes process wakes and system-journal churn after exhaustion.

**Q3:** automatic observation can now settle an exhausted episode after physical
safety has been restored, provided every non-observational cleanup step already
has a durable DONE row. It checks gate files before commands, observes activation
absence and stopped services, reserves one durable settlement attempt, repeats
the existing final observation/retirement guards, then records completion and
releases ownership. It performs no gate, worker, service, restore or archive
repair. An armed gate still yields zero commands/writes and unchanged evidence.
A failed/interrupted reserved settlement requires explicit recovery; this does
not open another unbounded effect/journal replay. Observational service queries
may recur while gates are disarmed but a service remains active. Storage failures
before settlement reservation persistence can retry that reservation write.

This restores automatic lease release for an already-safe exhausted episode;
it does **not** restore the parent's ability to repair an armed gate after the
budget is spent. Merely stopping a drift writer can leave the gate armed and
still block all successor activations until explicit recovery. Declining that
broader self-healing property is a scope choice. A bounded post-exhaustion repair
allowance is possible, but is not implemented here. Successor protection is exercised with a
foreign lease after settlement; a genuine second signed activation remains
unproved. B1 remains BLOCKED; B2/B4 remain source-level only; overall BLOCK.

**Q4–Q6:** the existing unavailable refusal code is preserved; `budget_error`
now distinguishes ACT_RETRY_BUDGET_INVALID from storage/custody failure. Genuine
tests read the counter after three failed explicit run/resume/revoke attempts
and prove only 22 automatic attempts remain after ten spent attempts. The
counter-deleting mutant is killed by B4_MANUAL_BUDGET_RETAINED. `run <id>` is
also an explicit recovery path, in addition to the two commands named above.
B4_BUDGET_NOT_SPENT_BEFORE_EXPIRY applies to the intact-journal, not-yet-started
teardown case; damaged-journal expiry still tears down early, fail-safe. The
counter remains outside the archive/manifest digest; no bundled retry-count
attestation is claimed. No existing assertion, guard, error code or skip
allowance was weakened.

Historical R4 validation is retained in the report at the R4-response commit,
not declared as current-head measurements. MX13/MX14 (worker/reload) remain
unclaimed kills and are not claimed equivalent. Current counts and mutation
results are in SHU71-L3-TESTS.json.



### Response to R5 (repository-only)

R5-A/B/C were reproduced at `0eeadd5f05abc8cd82968a855b2bff8cc137c65a`
before production edits, including MY6 surviving all 56 genuine trust tests.
The new genuine differential loads parent `5e25c65`, blocked head `0eeadd5`,
and candidate source into the same disposable boundary and applies identical
inputs. Both named gates are `/etc/systemd/system/shu-coordinator.service.d/90-shu71.conf`
and `/etc/systemd/system/shu-supervisor.service.d/90-shu71.conf`.

**R5-A:** counter-fault fallback now independently attempts activation credential
removal after attempting each gate. It needs neither a journal append nor a
command reservation. An unlink/fsync failure is reported as
`ACT_TEARDOWN_ACTIVATION`; failure of a gate does not skip credential removal.
With the same mode-0644 counter, parent disarms both gates, removes the credential,
stops the services, releases ownership and completes. Blocked head disarms both
gates but keeps the credential. Candidate disarms both gates and removes the
credential on every wake. This revokes the credential checked by the running
supervisor even though its start-time environment remains unchanged.

Candidate intentionally still retains the lease, leaves the supervisor,
coordinator timer and evidence broker running, and does not record completion
on this fallback. Explicit recovery remains necessary for those effects. Narrow
file effects can repeat on every persistent fault; no bounded-fallback-cost or
host-effective-systemd claim is made. Filesystem failures can prevent removal
and are surfaced, not treated as success. Clean foreign leases refuse with
`ACT_ACTIVATION_CONFLICT` and zero writes/commands for invalid counters, planted
exhaustion and planted settlement. The evidence-directory-mode veto and
custody-invalid foreign-lease residual remain pre-existing and outside scope.

**R5-B:** each successful automatic reservation now appends its attempt number
to the hash-linked journal before ordinary effects. Zero-effect exhaustion
requires all 32 ordered reservation records (1 through 32). A counter with 32
but no supporting history is an invalid budget, takes the credential/gate safety
fallback and returns `ACT_RETRY_BUDGET_UNAVAILABLE` with
`budget_error: ACT_RETRY_BUDGET_INVALID`. It cannot silently enter zero-effect
exhaustion. Parent completes the identical planted-counter input; blocked head
leaves both gates armed and credential present; candidate disarms both gates and
removes the credential, retaining ownership and incomplete evidence.

A reservation whose journal append was interrupted still consumes its counter
attempt. Missing proof never resets the counter or grants ordinary retries.
Damaged-journal recovery conservatively retains the existing
`ACT_RETRY_BUDGET_EXHAUSTED` code for a counter of 32, but now takes the same
independent safety fallback and exposes invalid/missing evidence via
`budget_error`. It does not enter the zero-effect settlement branch. Old exhausted
episodes lacking the new reservation records likewise take the safety fallback
and need explicit recovery. This is a local journal cross-check, not a signature,
remote attestation or protection against root rewriting both counter and journal.
The earlier zero-effect exhaustion disclosures concern evidence-supported
exhaustion; unsupported counters are now faults.

Settlement consumption now requires a `SETTLEMENT_STARTED` journal record,
written before the counter marker and before settlement effects. The counter's
boolean alone grants or consumes no allowance. For an already-safe episode,
the identical planted `settlement_started:true` leaves blocked head frozen but
parent and candidate complete and release ownership. Interruptions before and
after the reservation append are tested: an absent reservation may retry, a
persisted reservation cannot. Clearing the boolean cannot replenish it.

**R5-C:** failed settlement now explicitly asserts incomplete evidence, retained
lease and unretired timer, both immediately and after 40 exhausted wakes. MY6
is killed on `B4_SETTLEMENT_FAILED_OWNERSHIP_RETAINED`. The same interrupted
retirement input retains ownership at parent, blocked head and candidate; the
old suite's failure was coverage. The new assertion detects the mutant's release
on that same failure. No production ownership guard was removed or relaxed.

**Q3 disposition:** retaining no automatic gate repair after evidence-supported
exhaustion is a **scope choice**, not an impossibility or external constraint.
The existing armed-gate refusal and its assertions remain unchanged. Stopping a
drift writer alone can still leave a disk gate armed and ownership blocked until
explicit recovery. In the reproduced gate-drift case the activation credential was removed by
the earlier cleanup attempts; disk-gate restoration and automatic successor
admission are not claimed. Persistent failures of credential removal throughout
the ordinary allowance likewise require explicit recovery after exhaustion.
The one-shot settlement of already-safe episodes remains available, now protected
against a planted counter boolean. B1 remains BLOCKED, B2/B4 source-level only,
and overall execution closure remains BLOCK.

Historical R5 measurements and differential snapshots remain in the report
at `58527b2`. Current measurements replace those older declarations in
`SHU71-L3-TESTS.json`. MX13 and MX14 remain the
two disclosed acceptable survivors, neither killed nor claimed equivalent.


R5 measurements are historical, not current-head counts. The current R6
measurements are recorded below and in SHU71-L3-TESTS.json. The application
suite was not rerun this round.
`PERMITTED_SKIPS` remains byte-identical lane-wide (SHA-256
`37e8824a22c5bf5c7313305dcb3ca551dd917212f8dff00503dd092e70a3971f`).


### Response to R6 (repository-only)

R6-A and R6-B were reproduced before edits at `58527b27b15fc3c817b2cb978285688e6fee69f0`:
each independently written evidence mutant (length >= 1; length == 32 without
ordering) passed all 67 genuine trust tests. A fresh depth-1 clone accepted
candidate production source in the parent slot with a re-recorded manifest
digest: all three custody tests passed. Logs are under `/tmp/l3-r6-results/`.

**R6-A:** genuine tests now produce reservation rows through real automatic
cleanup, with a disposable remote-restore fault preventing completion. They
exercise every partial length 1..31, a duplicate, reordered rows, a gap and an
extra row. Tampered histories are rebuilt with the real journal writer so their
hash chain is valid, then consumed by a fresh production instance. Each malformed
history must return INVALID/UNAVAILABLE, disarm both gates, revoke the credential
and retain ownership without claiming completion. R6-M2 dies on
`B4_R6_PARTIAL_1_EVIDENCE_REFUSED`; R6-M1 dies on
`B4_R6_REORDERED_EVIDENCE_REFUSED` (and duplicate/gap assertions).
An append-interruption assertion also checks that the durable counter was
consumed before the reservation append. Moving that append ahead of the counter
dies on `B4_R6_APPEND_INTERRUPTION_COUNTER_CONSUMED`. A positive 32-ordered-row
control explicitly retains the R5-B root-forgery residual. The production evidence check and other production behavior are unchanged.

**R6-B:** candidate production substitution is rejected by
`SHU71_HISTORY_CONTROL_CONTENT`, including without Git. The content guard is
pure text matching after stripping whole-line comments and whitespace: a diagnostic
aid, not a security control or provenance proof. Equivalent source rewrites can
evade it; older real revisions `eb29fc2` and `dae5948` satisfy every checked
property and the behavioral premises, so it does not uniquely pin `5e25c65`.
The load-bearing backstop is the executed `historical control semantics` tests
and downstream behavioral differentials. These tests remain intact.
The Git cross-check cannot run in shallow CI. Recorded digests establish local
consistency only; a full clone re-establishes provenance against Git. Loads print
`SHU71_HISTORY_GIT_UNAVAILABLE` or `SHU71_HISTORY_GIT_VERIFIED`; neither is a skip.
The synthetic Git test checks the comparison mechanism. No CI workflow, fixture
bytes, assertion, guard, error code or skip allowance was weakened.

**R5-B disposition (b):** this evidence check bounds accidents and non-root
tampering, but **not a root adversary**. The chain is unkeyed and shares the
0700/uid-0 evidence directory with the counter. Existing signing material is a
root-readable local private key; authenticating with that same trust domain
would not exclude root. Protecting against that adversary requires an external
trust boundary unavailable in this repository-only lane. Root can rewrite a
valid 32-row chain and counter to obtain the armed-gate, credential-present,
zero-effect exhaustion signature; the positive test demonstrates that limit.
No root-tamper protection is claimed. R5-A containment residuals, Q3's scope
choice and all other open limitations above remain unchanged. B1 stays BLOCKED;
B2/B4 remain source-level only; overall execution closure stays BLOCK.

**Historical R6-C validation at `5690245` (superseded counts, preserved record):** focused **309/309**, genuine baseline **254/254**,
full coordinator **1800 total / 1782 pass / 0 fail / 18 unchanged skips**.
Focused and genuine commands now include the custody test file. All **55/55**
targeted production/delivery/trust/recovery mutants are killed; **512** crash
injections remain **240 forward + 272 teardown**. Mutation-named TAP checks:
focused **96**, genuine **41**, coordinator **531**. Un-gated rollback: **1/1**.
Standalone genuine trust baseline: **104/104**. R6-M1: **101 pass / 3 named
failures**; R6-M2: **69 pass / 35 named failures**. All other R6 sites were also
run: five kills, three disclosed survivors (M7/M8/M9). The actual append-before-
counter mutation is killed by the new interruption assertion. R4 independent
sites: **10 killed / 2 disclosed survivors**; R5 MY sites: **5 killed / 2
disclosed survivors**; each runs all **104** genuine trust tests. No survivor
is counted as a kill.

Full-clone and fresh depth-1 custody-plus-trust controls each pass **114/114**;
coordinated candidate-source/manifest substitution fails **7** named-dependent
tests in each (**107 pass**), with `SHU71_HISTORY_CONTROL_CONTENT`. All six
Git comparisons are byte-identical in the full clone. Each missing historical
object is disclosed by name in the depth-1 output. Digests, commands, complete
mutant results and local artifact paths are in `SHU71-L3-TESTS.json`. These R6 suite totals are historical and are not current-head declarations. The
application suite and new-head CI were not verified. No host access, push, PR
change, merge, GitHub comment or Linear comment occurred.

## Response to R7 — coverage closure and stopping rule

Starting head: `569024577c8c96c0ef161798c3c541ea14b309d5`. Both full verdict
artifacts were read before changes. Production source remains byte-identical;
only tests, the history test helper, and documentation changed. All R5-B
root-adversary disclosure and `B4_R6_ORDERED_ZERO_EFFECTS_RESIDUAL` remain intact.
B1 is BLOCKED; B2/B4 are source-level ONLY; overall execution closure is BLOCK.

**R8 replacement of the lane stopping rule:** every demonstrated shape must die
by name. Acceptance is a total transition function over the explicitly bounded
state domain in [SHU71-R8-STATE-MODEL.md](SHU71-R8-STATE-MODEL.md), not an open-ended
bypass-shape enumeration. The four R8 witnesses are W7, W13, W1b and W15; existing
V12/V14 kills and individually pinned control properties remain required. This
supersedes the unachievable universal mutant-signature criterion while retaining
the accepted ORDERED root-forgery residual and all B1/host scope limits.

**R7-B reproduction and closure:** before edits, V12 and V14 each survived
104/104 genuine trust assertions. Whole-state probes reproduced V12's two armed
gates, present credential, held lease and zero effects (HEAD: disarmed, removed,
held, seven effects), and V14's same unsafe state with one effect (HEAD: eight).
V14 and HEAD return the same `ACT_RETRY_BUDGET_EXHAUSTED` code, but only HEAD
returns `budget_error: ACT_RETRY_BUDGET_INVALID`; the mutant has no budget error.
V12 instead returns EXHAUSTED where HEAD returns UNAVAILABLE with INVALID.
The damaged-journal test now restores armed inputs after its earlier interrupted
fallback so that previous disarm/revocation cannot mask the missing check.
It retains every original assertion and additionally pins both exact gate file
contents, credential absence, lease retention, eight effects, absence of
TEARDOWN_COMPLETE in both journals, and the budget error. The descending case
uses 32 real reservations and the real journal writer, and pins the corresponding
full state, including seven effects. The accepted ORDERED case is unchanged.

| Mutant | Before tests/pass/fail | After tests/pass/fail | Named kill |
| --- | --- | --- | --- |
| V12 descending also accepted | 104/104/0 | 105/104/1 | `B4_R6_DESCENDING_EVIDENCE_REFUSED` |
| V14 recovered journal bypass | 104/104/0 | 105/104/1 | `B4_R7_RECOVERY_BOTH_GATES_DISARMED` |

**R7-A deletion sweep:** real depth-1 clone; each require line removed alone,
entire history-plus-trust suite run, then source restored. Before: 114 tests;
after: 134 tests; zero skips throughout. The verdict lists 17 undetected names
but says 16; the actual all-18 sweep found 17 survivors and one kill. All 18
properties remain, all 18 now die individually by name. No property was removed.
Each after-change kill includes `SHU71_CONTROL_PROPERTY_` followed by the exact
property in the table; an unrelated rejection does not satisfy the test.

| Property deleted | Before pass/fail | After pass/fail |
| --- | ---: | ---: |
| `JOURNAL_VALIDATES_CHAIN` | 114/0 | 133/1 |
| `JOURNAL_REPEATS_PHYSICAL_EFFECTS` | 114/0 | 133/1 |
| `JOURNAL_APPLIES_REPEAT` | 113/1 | 132/2 |
| `JOURNAL_FAILURE_VETOES_RETIREMENT` | 114/0 | 133/1 |
| `KNOWN_CONTROL_MODULE` | 114/0 | 133/1 |
| `CLEANUP_BODY_PRESENT` | 114/0 | 133/1 |
| `ORDERED_EFFECTS_PRESENT` | 114/0 | 133/1 |
| `GATE_FIRST_ORDINARY_EFFECT` | 114/0 | 133/1 |
| `DISARM_BEFORE_CREDENTIAL_REMOVAL` | 114/0 | 133/1 |
| `NO_CREDENTIAL_REVOCATION_IN_FAULT_FALLBACK` | 114/0 | 133/1 |
| `NO_RESERVATION_EVIDENCE_BINDING` | 114/0 | 133/1 |
| `PARENT_NO_RESERVATION_BEFORE_DISARM` | 114/0 | 133/1 |
| `PARENT_NO_COUNTER_FAULT_FALLBACK` | 114/0 | 133/1 |
| `BLOCKED_RESERVATION_BEFORE_DISARM` | 114/0 | 133/1 |
| `R4_FAULT_RETURNS_WITHOUT_DISARM` | 114/0 | 133/1 |
| `R4_NO_FAULT_GATE_LOOP` | 114/0 | 133/1 |
| `R5_FAULT_DISARMS_GATES_ONLY` | 114/0 | 133/1 |
| `R5_COUNTER_BOOLEAN_SETTLEMENT_AUTHORITY` | 114/0 | 133/1 |

A fixture revision with a matching manifest digest but no content specification
now raises `SHU71_HISTORY_CONTROL_UNREGISTERED`. Reinstating the silent return
fails `SHU71_CONTROL_UNREGISTERED_VENDOR_REFUSED` (134/133/1). The synthetic Git
mechanism test explicitly registers its generated revision in its disposable
helper and still checks digest, Git-byte drift and missing-file failures.
The text guard remains only a diagnostic aid; the behavioral historical-control
executions and differentials are the load-bearing backstop, unchanged. No
uniqueness, arbitrary rewrite resistance, or security-control claim is made.

**Historical R7 measurements:** focused 331/331; genuine baseline 274/274; full
coordinator 1822 total, 1804 passed, zero failed, 18 unchanged skips. Mutation-named
TAP checks (`/mutation|mutant/i`, every nesting depth): 98 focused, 41 genuine,
533 coordinator. Targeted mutations: 57/57 killed (11 production, 17 delivery,
11 trust, 18 recovery). Crash injections: 512 (240 forward + 272 teardown).
Un-gated disposable rollback mutation: 1/1. Genuine trust baseline: 105/105.
All 22 verifier V sites rerun: 21 kills, V15 equivalent survivor. Prior independent
sites rerun: R4 MX 10 kills/2 disclosed survivors, R5 MY 5/2, R6 M1–M10 7/3.
No disclosed survivor is counted as a kill or newly claimed equivalent.

Depth-1 clean: 134/134/0, 35 named Git-unavailable diagnostics, no skip. All three
historical commits are absent and rev-list count is one. Coordinated candidate
source plus re-recorded digest substitutions fail with CONTROL_CONTENT: parent
134/117/17, R4 134/128/6, R5 134/126/8. The new per-property cases explain the
additional substitution failures. All six actual fixtures still match full Git
history byte-for-byte. PERMITTED_SKIPS and the CI workflow are byte-identical
lane-wide; the coordinator skip-name set is identical to the starting head.

Detailed results, command lines, source/log hashes and all deletion rows are in
`SHU71-L3-TESTS.json`; local audit logs/scripts are under `/tmp/l3-r7-results/`.
Application tests were not rerun; no application count is claimed. Host, systemd,
cgroup, live durability, external APIs and two-lane production execution remain
unproved. New-head CI is UNVERIFIED and belongs to the orchestrator after pushing.
No host access, push, PR action, merge, or GitHub/Linear comment occurred.
