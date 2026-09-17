# Execution-closure correction (repository evidence, not host authorization)

Branch `fix/execution-closure`, based on
`b14174c5d6dd57982e71f69469bd2583d72b0713` (`origin/main`).
No remote host contact, push, PR, merge, external comment, AppArmor or sysctl
change occurred. No production signing key was accessed. The final evidence
commit follows the implementation commit; obtain its exact ID with `git rev-parse HEAD`.

## A — requirement-driven preflight

The base inventory has zero `user_namespaces` requirements. Its distinct names
are bash, cvtsudoers, flock, git, linux_proc, loopback_socket, privilege,
shell_toolchain, systemd_analyze, unix_socket and worker_uid.

`host-suite-contract.mjs:221` now omits probes with zero derived requirements.
Evidence is `{required:false}`, **not a skip**. This also handles a probe that
would throw or return malformed evidence. Required probes retain named refusals
at `host-suite-contract.mjs:235`, `:237`, `:243`; only privilege/worker_uid can
use the existing exact authorized reasons (`:242`). Calls without a derived
inventory remain conservative and probe everything. The suite CLI always binds
the revision inventory. The lifecycle provider now passes its own explicit
requirements (`production-lifecycle.mjs:291`), excluding the obsolete technique
(`host-lifecycle.mjs:5`) but retaining all other lifecycle requirements.

This is safer than deleting one vocabulary member: the same stale-dependency
failure cannot recur for another unused capability, while an inventory that
actually declares the capability still refuses its absence. Tests retain the
namespace vocabulary and its named required-case mutation as a regression trap.

Production review isolation is the sudo rule for
`/usr/local/libexec/shu-reviewer-sandbox` (`service/shu-reviewer.sudoers:5`),
whose shipped implementation calls `/usr/bin/systemd-run`
(`../reviewer-sandbox.sh:220`) with `RestrictNamespaces=yes` (`:245`).
A source search of executable coordinator sources finds `unshare` only in the
contract probe and its two test files. The superseded `userns-profile` artifact
and historical documentation are not production execution paths. No production
adapter uses the unshare technique. This is repository evidence, not a fresh
measurement of the reported host/AppArmor refusal.

Executable proof:

```
node --test .github/coordinator/service/test/capability-requirements.test.mjs
```

Mutants `unneeded capability halts`, `namespace absence waived`, and
`uncovered requirement ignored` die by `UNNEEDED_NOT_PROBED`,
`NAMESPACE_REQUIRED`, and `UNCOVERED_BY_NAME`. Existing malformed-probe,
exception, reason-binding and outcome mutations remain. Eight entries remain in
`PERMITTED_SKIPS`, byte-identical to base; SHA-256 of its complete declaration:
`9d6eebfd832d8e76650aefd725c11059af1b0ab5a05c1d2adfee3269c456607f`.

## B — split ownership, including actual child delivery

Before: arming demanded secret + nine adapter keys from supervisor.env, while
status required secret only. After: `units.mjs:77` validates both separate
sources; `shu71-production.mjs:228` opens supervisor.env root:root 0600 and
coordinator.env 999:999 0600 separately. Combined/crossed content refuses with
`SHU251_ENV_CROSSED`, including the production HALT receipt (`:298`). Unit
rendering also rejects adapter keys in the supervisor source (`units.mjs:136`).
The nine presence checks and their existing `SHU71_SUPERVISOR_ENV_REQUIRED`
refusals are preserved. Staging still permits an unarmed coordinator file.

The supervisor retains only its secret source. The adapter **child**, after the
existing supervisor child-environment filter, opens the fixed coordinator source
(`../supervisor-worker.mjs:67`, `units.mjs:106`). Descriptor custody checks require
a regular, single-link, service-owned 0600 file. Only the nine adapter keys and
three existing model credential keys are selected; GitHub/Linear tokens and the
supervisor secret never enter the child environment. No unit gains another
EnvironmentFile, and no combined environment file is created. Coordinator
transport continues to use its existing systemd LoadCredential path.

```
node --test .github/coordinator/service/test/closure-environment.test.mjs \
  .github/coordinator/service/test/shu71-supervisor-environment.test.mjs
```

Mutants accepting combined/crossed content or omitting child bindings die by
`CLOSURE_COMBINED_REFUSED`, `CLOSURE_CROSSED_REFUSED`,
`CLOSURE_CHILD_BINDINGS`. Production crossed-file controls assert
`SHU251_ENV_CROSSED` and zero signatures. Existing test names, expected values,
all nine missing-key controls and poison credential strings remain intact.

## C1 — canonical approval composition and validation

`compose-shu71-approval.mjs` composes the exact payload consumed at
`shu71-production.mjs:159`. It derives the execution tree, config lanes, trust
anchor and public key from the supplied exact Git revision, recomputes the
sealed append-only reseed binding locally, and compares it to the settled
package. The activation ID, revision, fixture pair, package policies and trust
anchor must agree. No time, identity, tree, digest or fixture value is invented.
Empty package/activation signatures are intentional; production signs them
only after owner approval. Supplied nonempty signatures must validate.

The input is the **settled package**, not a request to hand-author a new package.
This checkout does not contain that live package, its settled window ID/time
bounds, or the owner signature. The tooling is complete at this boundary; an
actual live signing artifact cannot honestly be emitted from absent inputs.

Exact argv (replace the variables with the settled inputs; all paths absolute):

```
node .github/coordinator/service/compose-shu71-approval.mjs compose \
  "$REPO" "$REVISION" "$ACTIVATION_ID" "$SETTLED_PACKAGE" "$DEPLOYED_CHECKOUT" "$PREFIX"
node .github/coordinator/service/compose-shu71-approval.mjs seal \
  "$REPO" "$REVISION" "$ACTIVATION_ID" "$SETTLED_PACKAGE" "$DEPLOYED_CHECKOUT" "$PREFIX" "$DETACHED_SIGNATURE" "$TRUSTED_OWNER_PUBLIC_KEY"
node .github/coordinator/service/compose-shu71-approval.mjs validate \
  "$REPO" "$REVISION" "$ACTIVATION_ID" "$SETTLED_PACKAGE" "$DEPLOYED_CHECKOUT" "$PREFIX" "$PREFIX.shu71.json" "$TRUSTED_OWNER_PUBLIC_KEY"
```

Compose emits `.canonical.json` (exact bytes, no trailing newline), `.sha256`,
and `.unsigned.json`, exclusively without overwriting prior inputs. The owner
signs **only those canonical bytes** using Ed25519. Seal reads the raw detached
64-byte signature and validates it before emitting `.shu71.json`; no manual JSON
editing or signature field transcription is needed. Validate recomposes the
expected payload and checks digest, exact payload and the supplied independently
trusted owner public key. That key must be the approved `shu71-owner.pub`; an
operator-selected replacement is not a new trust decision authorized here.
The installation destination is `/etc/shu/approvals/<activation_id>.shu71.json`.

The committed `execution-closure-evidence/synthetic-approval.canonical.json`
has SHA-256:

`75f655a743573fd324bd811ee85680bd27e60776aa69875e5ca4c04da870687b`

**Synthetic only: old fixture revision and expired fixture window. Do not sign
or install it.** Tests sign it with an ephemeral in-memory test key. A separate
real local Git fixture exercises compose → seal → validate with authentic sealed
seed blob bytes. No production key is stored in the repository.

```
node --test .github/coordinator/service/test/closure-approval.test.mjs
```

Wrong digest, foreign key, stale revision and missing fixture refuse by
`CLOSURE_APPROVAL_DIGEST`, `CLOSURE_APPROVAL_FOREIGN_KEY`,
`CLOSURE_APPROVAL_STALE_REVISION`, `CLOSURE_APPROVAL_MISSING_FIXTURE`.
Four syntax-clean production-source mutants die by `CLOSURE_WRONG_DIGEST`,
`CLOSURE_FOREIGN_KEY`, `CLOSURE_STALE_REVISION`, `CLOSURE_MISSING_FIXTURE`.

## C2 — one service-plane entrypoint

`service-plane.mjs:11` is the single typed entrypoint. It composes the existing
production driver/provider/executor, not shell commands supplied by a caller.
There was no single prior CLI that chained these actions with failure cleanup.

Exact execution argv, as root from the approved checkout, with
`SHU251_HOST_MUTATION_APPROVED=true` and `GH_TOKEN` for the provider's existing
GitHub main check:

```
node .github/coordinator/service/service-plane.mjs start /absolute/driver.json \
  --execute --approved-host-mutation <approved-40-hex-revision>
```

It performs pin → preflight → install → start → readiness, leaving the supervisor
listening and both dispatch gates off. There is no additional start command.
Explicit later rollback uses the **same entrypoint**:

```
node .github/coordinator/service/service-plane.mjs rollback /absolute/driver.json \
  --execute --approved-host-mutation <approved-40-hex-revision>
```

Rollback performs host-rollback → pin-restore, attempting both even if one fails.
The lifecycle owner approval must authorize forward operations exactly
`["pin","install","start","readiness"]` and teardown `restore`. Preflight is
an observation outside that operation list. Existing signature, expiry, exact
spec hash, custody and operation-order assertions remain unchanged.

Successful stdout: `shu251-service-plane-receipt-v1`, `ok:true`, state
`READY_GATE_OFF` or `ROLLED_BACK`, revision/spec/approval binding, every original
per-step receipt and a SHA-256 of the enclosing receipt excluding its digest.
Caught forward failure: `ok:false`, `state:"HALT"`, `failures:[{step,code},…]`,
completed forward and cleanup receipts. Each cleanup failure is retained; cleanup
continues. Exit status is 2 for HALT. Usage/spec/authorization failures before
execution emit `shu251-service-plane-refusal-v1` with a named code and exit 2.
Unknown exceptions are redacted as `CLOSURE_SERVICE_PLANE_IO`. Abrupt process
termination cannot emit stdout; the existing durable intent journal remains the
recovery authority and the same rollback command is required. Success stdout
alone does not replace the provider's durable archive.

Actual repository-only dry-run argv:

```
node .github/coordinator/service/service-plane.mjs start \
  /home/bawes/work/a12inv/.github/coordinator/service/execution-closure-evidence/synthetic-driver.json
```

Saved stdout: `execution-closure-evidence/service-plane-dry-run.json`:
`dry_run:true`, steps `[pin,preflight,install,start,readiness]`, rollback
`[host-rollback,pin-restore]`, **acceptance:false**. This does not contact a host.

```
node --test .github/coordinator/service/test/service-plane.test.mjs
```

The recorded production-provider execution yields `READY_GATE_OFF` then
`ROLLED_BACK` with exact modeled snapshot restoration. Every forward step has a
named failure/rollback control, plus a failed-rollback continuation control.
Mutants omitting start, readiness or cleanup die by `CLOSURE_START_CHAIN`,
`CLOSURE_READINESS_CHAIN`, `CLOSURE_ROLLBACK_CHAIN`. The committed model trace
records 57 unique command argv and 18 read paths. Commands, rendering, clock and
filesystem paths are modeled; it is not a systemd acceptance run.

## Complete dependency boundary and remaining prerequisites

These are prerequisites, not implicit permission to provision or contact a host:

1. The exact final driver JSON and its separately stored window JSON must agree.
   `phase-a-driver.mjs:206` validates the window and requires the executable
   checkout path to equal `window.repo_dir`. The lifecycle spec includes identity,
   groups, environment metadata, directories, systemd version, capability list,
   approved tree, rendered hashes, evidence paths and the exact clean prior Git
   tuple. A stale baseline cannot be guessed. These live inputs are not present.
2. `/etc/shu/approvals/<id>.json` and `/etc/shu/approvals/owner.pub` are the separate
   lifecycle signature artifacts (`production-lifecycle.mjs:152`). The signed
   payload binds the spec with only `approval_sha256` removed; the spec stores
   the hash of the entire signed envelope. Its time window, operation order and
   restore teardown must match the command above. C1 does **not** replace it.
3. Root authority, the reviewed service account/groups, both private environment
   files, workspace and supervisor directories, an existing writer lock, evidence
   root and `/etc/systemd/system` must exist with reviewed ownership/modes. The
   provider creates the activation evidence directory, manifest and journal lock;
   it does not create service accounts, credentials or the evidence parent.
4. Local Git objects, HEAD/main/origin-main and activation pin must have the
   recorded baseline; the provider reads/fetches the approved revision and reads
   remote main plus GitHub API main. This requires network/authentication during
   a future authorized execution. No such call was made for this correction.
5. Linux `/proc`, Unix sockets, Node >=22, systemd >=250, systemctl, systemd-notify,
   systemd-analyze, id/setpriv/sudo where needed, flock, Git, gh, ss, the parser
   provider and fixed shell toolchain must satisfy the existing probes. Evidence
   storage must support fsync and atomic rename. User-namespace mapping is not a
   dependency. Systemd/PID/listener readings and process environment prove readiness.
6. Rendering reads `shu-{supervisor,coordinator}.service.in`, the timer template,
   both separate environment sources and the reviewed JS modules. Installation
   reads prior unit files and the two `10-shu251.conf` drop-ins (or their absence),
   enable/active state and stages exact dispatch-off bytes. No preinstalled SHU
   unit is required. Unreviewed drop-ins still refuse.
7. Runtime reads include the Git config at the approved revision, supervisor
   state, and `/proc/<supervisor-pid>/{status,environ}`. Provider evidence reads
   are manifest, journal, archive, preflight, staged unit bytes and locks beneath
   the signed paths. The modeled trace lists concrete examples. System libraries,
   executable binaries, systemd's own state and Git's object/ref files are also
   platform dependencies, not independently provisioned by this command.
8. Phase B additionally requires the C1 artifact and `shu71-owner.pub`, the existing
   activation trust anchor/public key and production signing key, the immutable
   `/usr/local/lib/shu71` module installation, reviewer sandbox/sudo policy and
   adapter/model tooling and credentials. Arming performs its own installation
   identity, fixture/ref and API checks. The service-plane command intentionally
   establishes gate-off readiness; it does not grant dispatch authorization or
   manufacture any of these Phase-B dependencies.

Consequently there is **no proof that every live prerequisite is already present**.
The missing settled inputs and signatures prevent such a claim. The command's
complete modeled chain has no separate manual install/start action, but deployment
closure remains open until these declared inputs are available and validated.
No new owner choice about environment placement or namespace policy is needed.

| Owner proof item | Status | Evidence and limit |
| --- | --- | --- |
| 1. Every required signed artifact exists and validates | OPEN | Synthetic owner-signature controls pass; actual C1 and lifecycle envelopes, live settled package/spec and trusted owner-key bindings were not supplied. |
| 2. Every mutation has a reviewed executable entrypoint | PROVEN (repository scope) | Named Node test entrypoints above execute controls and production-source mutant kills; existing mutation lists retained. This does not assert independent approval of this new commit. |
| 3. Supervisor/coordinator ownership stays split | PROVEN (repository scope) | Split file validation, child delivery, crossed-file named refusal and zero-signature controls. Host file contents were not inspected. |
| 4. M3 matches production dependencies | PROVEN (repository scope) | Zero namespace rows, derived gating, both-direction kills, unchanged eight-skip declaration; lifecycle no longer implicitly probes namespace mapping. |
| 5. Install/start/readiness/rollback executable end to end | PARTIAL | Single CLI and real provider run through a recorded boundary with failures/rollback; no live systemd acceptance, actual spec or signed lifecycle envelope. |
| 6. Nothing additional discovered during live window | OPEN | The entire known dependency boundary is enumerated above; absent settled inputs, signatures and host verification preclude certifying completeness. |

## Changed files and reasons

Paths below are relative to `.github/coordinator/` unless prefixed otherwise.

| File | Reason |
| --- | --- |
| `service/host-suite-contract.mjs` | Requirement-driven probe admission without skip changes. |
| `service/host-lifecycle.mjs` | Explicit lifecycle capability set excludes the unused namespace technique. |
| `service/production-lifecycle.mjs` | Pass and report that explicit derived set to the real provider. |
| `service/units.mjs` | Split arming/staging guards and fixed-source adapter-child loader. |
| `service/shu71-production.mjs` | Read both reviewed sources; preserve the named crossed-file refusal in receipts. |
| `supervisor-worker.mjs` | Deliver coordinator-owned adapter bindings inside the child, not the supervisor environment. |
| `service/compose-shu71-approval.mjs` | Deterministic repository composer, detached-signature sealing and validator CLI. |
| `service/service-plane.mjs` | Single start/rollback composition and bounded aggregate failure receipt. |
| `service/test/capability-requirements.test.mjs` | Zero-requirement controls, production-source mutation and eight-skip assertion. |
| `service/test/shu71-supervisor-environment-fixture.mjs` | Separate source serializers; retain exact adapter values and poison credentials. |
| `service/test/shu71-production-fixture.mjs` | Model the corrected two-source production inputs. |
| `service/test/shu71-supervisor-environment.test.mjs` | Move existing checks to the correct source; add production combined/crossed controls. |
| `service/test/closure-environment.test.mjs` | Split/child custody proofs and named mutant kills. |
| `service/test/closure-approval.test.mjs` | Canonical artifact, four refusals/kills and real local Git CLI pipeline. |
| `service/test/service-plane.test.mjs` | Production-provider chain, every-step failures, rollback continuation and three mutants. |
| `service/test/fixtures/closure-seed/scan-vacuous.expectations.mjs` | Exact sealed blob `4d19f13e35b592971dc453321a79d1dd6dde4d2d` for history-independent CLI test. |
| `service/test/fixtures/closure-seed/scan-vacuous.mjs` | Exact sealed blob `6b18133a75c24c573892f9e229eb49420cd51466` for the same test. |
| `service/test/fixtures/closure-seed/scan-vacuous.test.mjs` | Exact sealed blob `e3abeb362a4d84195f8a3afac82a983930cf50ef` for the same test (not separately executed). |
| `service/test/fixtures/closure-seed/README.md` | Exact sealed blob `f614ea04e10a455a5ada3a077ff1e604aa8a19bd` for the same test. |
| `service/suite-inventory.json` | Rebind the full test census, preserving every prior name and requirement. |
| `service/a12-evidence/file-requirements.json` | Audit the three new suites; only the actual local Git pipeline adds a Git dependency. |
| `service/a12-evidence/required-files.json` | Include those three suites in the exact file set. |
| `service/execution-closure-evidence/synthetic-approval.canonical.json` | Stable synthetic signing-byte example, explicitly not live authority. |
| `service/execution-closure-evidence/synthetic-driver.json` | Synthetic CLI plan input, explicitly not a deployable driver spec. |
| `service/execution-closure-evidence/service-plane-dry-run.json` | Actual CLI plan stdout, acceptance false. |
| `service/execution-closure-evidence/service-plane-model-trace.json` | Recorded production-provider commands/read paths, success and rollback stages. |
| `service/EXECUTION-CLOSURE.md` | This report, exact entrypoints, dependencies and remaining gaps. |

## Validation record

Focused production/contract/closure tests: 424 passed, zero failed/skipped.
Subsequent final approval CLI suite: 6 passed, zero failed/skipped. Final split
source suites also pass. The first broad census run used a repository-local
TMPDIR and had two pre-existing ephemeral-path test failures; the unchanged two
tests pass with normal `/tmp`. This unsuccessful run is not claimed as a suite
PASS. All earlier test names are retained in the new 2,785-row, 101-file inventory.
The committed inventory guard must additionally execute and validate the entire
current suite under normal `/tmp`; its final result is recorded below when complete.
