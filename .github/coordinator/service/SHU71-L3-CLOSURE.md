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
| Package and runtime envelope signing | Fixed root-only signing-key path `/etc/shu/keys/shu71-signing.pem` | `SIGNING_STARTED`, durable signed package, adoption or ambiguous-signing refusal |
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
| Fixture evidence broker | numeric UID 996, GID 999 | Separate systemd service reads the existing coordinator environment; its code consumes GitHub/Linear bindings only. Socket `/run/shu71-evidence/fixture.sock`, mode 0660, private runtime directory 0750. The fixed repository and two fixture IDs are compiled into the broker; caller-supplied URLs, queries, writes and executables are rejected. |

No secret files are combined, re-owned or copied into supervisor/worker
configuration. The broker is a trusted credential consumer, not a secret-export
endpoint. Receipt metadata and errors contain no credential values. Numeric UID
996 availability, installed-library custody, actual service IDs, source-file
metadata and real systemd credential behavior remain unmeasured host facts.

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
still block all successor activations until explicit recovery. Restoring that
broader self-healing property conflicts with the preserved no-repair exhaustion
contract, so it is not claimed here. Successor protection is exercised with a
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

R4-response validation: focused **245/245**, genuine assertions **196/196**,
coordinator **1736 total / 1718 pass / 0 fail / 18 unchanged skips**, application
**486/486** (459 Node + 27 Vitest), **85/85** standalone application kills,
**49/49** targeted source mutants, **512** process-death injections, and the
un-gated rollback mutant **1/1**. Mutation-named TAP checks: focused **90**,
coordinator **525**, all passing. The standalone independent-site recheck runs
56 genuine trust tests per mutant: **10 killed / 2 surviving** (MX13/MX14,
worker/reload, unchanged and not claimed equivalent). Logs and hashes are in
SHU71-L3-TESTS.json; raw local logs are under `/tmp/l3-r4-results/`.
