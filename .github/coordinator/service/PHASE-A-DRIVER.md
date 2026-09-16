# SHU-251 Phase A and A12 contract

Repository-only preparation. These entry points are inert on import. Nothing here
installs packages or units, enables dispatch, or initiates a service start/restart.
No host acceptance is claimed by repository tests.

## Phase A input and execution

`node phase-a-driver.mjs STEP /absolute/driver.json` prints a dry-run plan.
`--execute` performs observations and writes only the driver custody files described below. A plan is deliberately not an acceptance
receipt. Mutation steps additionally require **both**
`SHU251_HOST_MUTATION_APPROVED=true` and
`--approved-host-mutation <full-40-character-SHA>` matching the spec. Missing,
partial or mismatched approval gives `SHU251_HOST_MUTATION_APPROVAL`, including
for a dry-run mutation request. Approval is never inferred from an earlier file.
Output is JSON on stdout; the caller may archive it outside monitored state.
Errors are JSON on stderr with a named code and exit 2.

The driver JSON has these fields:

```json
{
  "window_spec_path": "/absolute/window.json",
  "window": "the complete parsed shu251-host-window-v2 object from window.json",
  "render": {
    "workdir": "/absolute/pinned-checkout",
    "workspaceStateDir": "/absolute/workspace-state",
    "supervisorStateDir": "/absolute/supervisor-state",
    "supervisorSocket": "/absolute/supervisor.sock",
    "serviceUser": "shu-coordinator",
    "serviceGroup": "shu-coordinator",
    "supervisorEnvironmentFile": "/absolute/supervisor.env",
    "coordinatorEnvironmentFile": "/absolute/coordinator.env"
  }
}
```

The `window` string above is explanatory: replace it with the actual object.
The existing `SHU-251-HOST-BINDINGS.md` and `validateWindowSpec` define its closed
fields, including approved SHA, fixture process identity and prior-state path.
For a noncanonical workspace state directory, explicitly supply the renderer's
`allowWorkspaceStateDirOverride: true`. Rendering uses `serviceParameters`,
`render` and `assertPolicy` from the pinned checkout, never arbitrary commands.
The driver must itself run from that checkout. Workspace and supervisor render
paths must agree with the window. The separately read window file must match
byte-independent canonical JSON before any execution.

Every executed step first invokes reviewed `inventory`, which binds clean local
HEAD and remote main to the approved SHA. Git trust is passed only to that child
process for the one checkout, through `GIT_CONFIG_COUNT`; no configuration file
is written. All nine operations route through
`shu251-operational-bindings.sh ACTION /absolute/window.json`. No binding logic
is copied. The driver checks the returned success envelope, binding discriminator
and relevant identity fields; malformed/missing evidence is
`SHU251_BINDING_RECEIPT`.

| Step | Evidence / refusal |
| --- | --- |
| `identity` | Fresh rendered bytes versus each of the three installed files; both SHA-256 maps. Any byte, including whitespace, differs: `SHU251_UNIT_IDENTITY`. |
| `gate-off` | Identity, three inventory/quiescence samples and full local state file hashes/metadata over two complete timer intervals (60+1 seconds each for current template). State differences: `SHU251_GATE_OFF_DIFF`; any filesystem watch event: `SHU251_GATE_OFF_WRITES`; insufficient elapsed time: `SHU251_WAKE_INTERVAL`. |
| `restart-before` | Reviewed launch, live worker and authenticated transport/status acceptance, installed identity, supervisor systemd InvocationID. |
| `restart-after` | Read and consume driver-owned custody below; require a different supervisor InvocationID with identical launch and live worker PID/start token, and RUNNING status again. Failure: `SHU251_RESTART_ACCEPTANCE` or `SHU251_RESTART_STATUS`. |
| `inventory`, `quiescence`, `transport`, `launch`, `worker` | Individually archived reviewed binding evidence. Transport calls reviewed `check-status.mjs`, which checks full status shape against durable launch/order records. |
| `capture-prior`, `replay-release`, `cleanup` | Explicitly approved reviewed mutations; no installation or activation. |
| `rollback` | Explicitly approved reviewed rollback, followed by reviewed quiescence. `SHU251_ROLLBACK_REENABLE` refuses any active/enabled prior unit or dispatch-on service bytes; `SHU251_ROLLBACK_BYTES` refuses prior bytes other than a fresh reviewed render. |

Gate-off measures an **inactive/quiescent** window, as required by the reviewed
quiescence binding. It does not initiate ticks or pretend an inactive timer fired.
The lock must already exist, so observing it cannot create a state file. Both
workspace and supervisor state trees are watched and inventoried; remote fixture
branch/comments are inventoried by the reviewed binding. Zero launches/writes
means no observed change within those authoritative scopes, not a host-wide
claim about unrelated processes or remote objects. Missing watches, unreadable
state or unexpected file types fail closed. Coordinator environment-file dispatch
overrides are refused (`SHU251_ENV_GATE_OVERRIDE`).

Restart acceptance is deliberately split around an **externally authorized**
supervisor restart. The driver never performs that restart: the reviewed nine
bindings have no restart action, and this track forbids starting services. Run
`restart-before`, perform the separately authorized operation, then run
`restart-after` with the same driver spec. `--before` and API `options.before`
are refused as `SHU251_RESTART_CALLER_BEFORE`; archived stdout cannot supply custody.
The driver refuses an unchanged supervisor invocation, changed worker PID/start
token, missing launch or invalid status. A reused
PID with a different start token is refused by the reviewed worker binding.

`restart-before` generates a UUID for the driver run and writes two exclusive,
mode-0600 files beneath this driver-derived directory (no CLI path override):

```text
<window.workspace_state_dir>/.shu251-phase-a/<window.approved_sha>/<SHA256(canonical(driver spec))>/
  custody.json
  record.json
  consumed.json    # created only after successful restart-after validation
```

`custody.json` has exactly `version: shu251-restart-custody-v1`, `run_id`,
`identity`, and `receipt_sha256`. `record.json` has exactly
`version: shu251-restart-record-v1`, `run_id`, `identity`,
`position: restart-before`, and `receipt` (the observed v1 receipt).
Both identities contain the approved SHA, canonical spec digest and canonical
window digest. The separate custody digest pins the original observed receipt,
so recomputing an edited receipt's evidence digest or fabricating its invocation
ID does not bypass the comparison. Reads validate shapes, versions, run identities,
position, custody digest and the complete receipt. Directory/file symlinks refuse.

- `SHU251_RESTART_FORGED`: missing/malformed custody or record, invalid shape,
  changed observed receipt, or invalid receipt digest/structure.
- `SHU251_RESTART_SUBSTITUTED`: wrong record position or receipt step.
- `SHU251_RESTART_CROSS_RUN`: wrong approved SHA, spec/window digest or driver UUID.
- `SHU251_RESTART_REPLAYED`: duplicate recording or consumption.

After validating observations and the output receipt, `restart-after` exclusively
creates `consumed.json` with exactly `version: shu251-restart-consumed-v1`,
`run_id`, and `receipt_sha256`. Any existing marker refuses, even malformed bytes;
its contents cannot authorize another consumption. Exclusive creation arbitrates
concurrent consumers. Files are fsynced before close and parent directories are
fsynced after creation, including newly created custody directories. The receipt
is emitted only after marker persistence. Separate processes therefore share the
same single-use state. A crash may leave an incomplete run or consume a run without
emitting stdout; both fail closed. A repeated `restart-before` cannot overwrite
custody. A fresh run requires a distinct spec/window and hence a distinct path.

These local records provide integrity against isolated record edits and enforce
run binding and single use, without signing or keys. They are not tamper-proof
against their owning UID: that UID can replace **both** record and custody
consistently, delete the consumed marker, restore an old entire custody directory,
or modify the executing code. Such coordinated custody tampering remains outside
this mechanism's guarantee. A caller-supplied or independently edited receipt is
no longer sufficient to forge acceptance. Driver filesystem writes are limited
to its own custody files/directories; operational mutations still use only the nine
reviewed bindings and retain their approval gate. `replay-release` remains a
separate approved operation, never an implicit part of restart acceptance.

The rollback binding can normally enable/start captured units. This driver
**refuses those snapshots before calling it**, even if their bytes say dispatch
is off. Only inactive and non-enabled snapshots with absent units or exactly the
freshly rendered gate-off bytes are admissible. Thus no enable/start branch of
the reviewed rollback can be selected by an accepted snapshot. Prior files and
unit state must remain exclusively operator-controlled during the operation;
this interface does not authorize concurrent edits.

## Receipt schema

`RECEIPT_SCHEMA` in `phase-a-driver.mjs` is an exported JSON Schema (2020-12).
`EVIDENCE_FIELDS` supplies its closed per-step `oneOf` evidence contracts.

```js
required: ['version', 'step', 'approved_sha', 'spec_sha256', 'evidence', 'evidence_sha256']
version: 'shu251-phase-a-receipt-v1'
approved_sha: /^[0-9a-f]{40}$/
spec_sha256: /^[0-9a-f]{64}$/
evidence_sha256: /^[0-9a-f]{64}$/
```

The digest algorithm is SHA-256 over UTF-8 canonical JSON: lexicographically
sorted object keys, preserved array order, JSON primitive encoding, no whitespace.
`spec_sha256` covers the whole driver spec; `evidence_sha256` covers the complete
step evidence. `validateReceipt` enforces the closed envelope and per-step field
names/types, the exact SHA/spec/step and the recomputed evidence digest.
Digest disagreement is `SHU251_EVIDENCE_DIGEST`. These are integrity bindings,
not signatures or proof of an untrusted producer's identity. No keys are created.

## A12 host contract

`node host-suite-contract.mjs preflight /absolute/suite.json` detects capabilities.
`node host-suite-contract.mjs run /absolute/suite.json` always performs that same
preflight before invoking Node tests. The suite spec contains `service_uid`
(non-root), `service_gid`, absolute `checkout`, absolute `temp_dir`, absolute
`files` under the checkout, and positive integer `expected_tests`. Supply the
complete reviewed test list and its exact reviewed count. The process identity
is the suite identity; service-specific probes explicitly use the supplied service
UID/GID. No automatic identity escalation is used for the suite itself.

| Capability | Detection | Named refusal |
| --- | --- | --- |
| Root/passwordless sudo | effective UID 0 or `sudo -n id -u` equals 0 | `SHU251_PREFLIGHT_PRIVILEGE` |
| Distinct worker UID | root/sudo `setpriv --reuid=65534 --regid=65534 --clear-groups id -u` equals 65534; differs from service UID | `SHU251_PREFLIGHT_WORKER_UID` |
| cvtsudoers | parse temporary policy into JSON with `cvtsudoers -f json` | `SHU251_PREFLIGHT_CVTSUDOERS` |
| User namespaces | service identity `unshare --user --map-root-user /bin/true` succeeds | `SHU251_PREFLIGHT_USER_NAMESPACES` |
| Checkout (A12 suite run only) | root directory owned by service UID; service identity traverses directories and can read every file, including Git metadata; symlinks refused | `SHU251_PREFLIGHT_CHECKOUT` |
| Writable temp | service identity creates, writes, reads and removes private temp fixture | `SHU251_PREFLIGHT_TEMP` |
| systemd | service identity `systemctl --version` and manager `show --property=Version --value` | `SHU251_PREFLIGHT_SYSTEMD` |
| systemd-analyze | service identity verifies temporary oneshot unit | `SHU251_PREFLIGHT_SYSTEMD_ANALYZE` |
| flock | service identity acquires temp lock nonblocking | `SHU251_PREFLIGHT_FLOCK` |
| systemd-notify | service identity `systemd-notify --version` | `SHU251_PREFLIGHT_SYSTEMD_NOTIFY` |
| Git | service identity `git --version` | `SHU251_PREFLIGHT_GIT` |
| Bash | service identity `bash --noprofile --norc -c 'exit 0'` | `SHU251_PREFLIGHT_BASH` |
| Unix sockets | service identity binds/closes a temp Unix socket | `SHU251_PREFLIGHT_UNIX_SOCKET` |
| Node | major version >=22, structured test reporter support | `SHU251_PREFLIGHT_NODE` |

These capability and outcome conditions establish sufficiency only for the A12
suite run, not the deployed service plane. The checkout ownership requirement
also applies only to the A12 suite run. The deployed
service plane deliberately reads an operator-owned checkout using the SHU-71
process-scoped inline Git trust described above.

Probe exceptions also become the corresponding named refusal, never a skip.
Preflight creates only bounded temporary probes, cleans them up, and never
installs capabilities. A missing capability requires a separate operator action.

`PERMITTED_SKIPS` preserves eight exact sanctioned exceptions: the seven historical
exceptions documented in `ENV-CONTENT-VALIDATION.md` and
`ACTIVATION-WINDOW-RECONCILIATION.md`, plus the PR #130 reader exception:

| Test name | Exact reason |
| --- | --- |
| SHU-227: worker owns its checkout and recovery preserves descendant commits | requires root or passwordless sudo for distinct-uid proof |
| SHU-227: non-owner service account resolves revision with no global Git trust | requires distinct-uid execution |
| SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches | requires distinct-uid execution |
| SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches | requires distinct-uid execution |
| SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity | host cannot switch to the fixture worker uid |
| SHU-244 A10: distinct-root scoped handoff production workspace | host cannot switch worker uid |
| SHU-71 restricted capability refusal | production vocabulary has no undeclared runtime/role pair |
| READER operator-owned checkout read by non-root account | Not exercisable: non-root account, no passwordless elevation to create root-owned checkout |

A repository test scans every coordinator `.test.mjs` source for literal skip
reasons. The guard supports the current single-line literal, conjunction and
ternary forms and fails closed on unsupported expressions; it is not a general
JavaScript parser. Every discovered reason must be sanctioned, except the explicit
`SHU251_NO_SYSTEMD` prohibition, which must remain refused by A12. Consequently,
a literal superset of *all* source reasons would be incorrect: disabling systemd
is not a sanctioned host run. This exception is checked with its exact environment
condition. Runtime acceptance still requires the exact test name and reason.

The historical skip allowlist is not a preflight waiver. A missing capability
prevents any host run, including a run that would have produced those skips.
An exact name **and** reason must match for an observed skip. All failures,
including failures of allowlisted tests, are `SHU251_SUITE_FAILURE` with the test
name. An extra skip or changed reason is `SHU251_SUITE_UNPERMITTED_SKIP` with the
name/reason. Todo/cancelled/unknown outcomes are refused. The reporter consumes
Node's structured events, not human TAP strings. A final completion event,
exact expected count and exit 0 are mandatory (`SHU251_SUITE_INCOMPLETE`,
`SHU251_SUITE_EXIT`). Neither a truncated stream nor a process failure is a pass.

## Repository tests and mutation controls

The two new test modules use only temporary fixtures and injected runner,
filesystem, clock and systemd observations. The source guard reads repository test
sources without executing them. Custody regressions use temporary on-disk records
and separate Node processes.
No tests outside `service/` or fixtures are changed by this revision. Mutation harnesses copy only the
four new module/test sources into a temp directory; they do not consult Git,
main, another branch, installed units, or host state.

Each mutation has a matched unmutated control with exactly one passing test,
exactly one unique replacement, a successful `node --check`, and exactly one
failure containing both `code: 'ERR_ASSERTION'` and
`failureType: 'testCodeFailure'`. SyntaxError, TypeError and module-loading crashes
are rejected as kills.

| Mutation | Exact AssertionError text |
| --- | --- |
| replay acceptance | Missing expected rejection: SINGLE_USE_REQUIRED: second consumption must refuse |
| cross-run acceptance | Missing expected rejection: RUN_BOUND: another run identity must refuse |
| forged record acceptance | Missing expected rejection: FORGERY_REFUSED: recomputed invocation must refuse |
| substituted record acceptance | Missing expected rejection: POSITION_REQUIRED: substituted step must refuse |
| caller supplied before acceptance | Missing expected rejection: CALLER_BEFORE_REFUSED: caller receipt must refuse |
| caller before CLI acceptance | Missing expected rejection: CLI_BEFORE_REFUSED: before flag must refuse |
| missing capability classified as skip | Missing expected rejection: CAPABILITY_REQUIRED: missing privilege must refuse |
| out of set skip accepted | Missing expected exception: SKIP_SET_REQUIRED: undocumented skip must refuse |
| mutation approval bypassed | Missing expected rejection: APPROVAL_REQUIRED: mutation must require both exact approvals |
| evidence digest unbound | Missing expected exception: EVIDENCE_BOUND: changed evidence must refuse |
| rollback implicitly reenables dispatch | Missing expected rejection: ROLLBACK_STAYS_OFF: active or enabled prior state must refuse |
| installed identity compared leniently | Missing expected rejection: UNIT_BYTES_REQUIRED: trailing newline mismatch must refuse |

Driver/contract test names (the former custody-limitation test is replaced):

- `SHU251 driver dry run invokes no binding`
- `SHU251 driver approval is explicit for every mutation`
- `SHU251 driver installed identity is byte exact`
- `SHU251 driver receipt binds the evidence digest`
- `SHU251 driver receipt rejects wrong revision spec step and keys`
- `SHU251 driver gate off observes two complete wake intervals`
- `SHU251 driver refuses inventory differences writes and short waits`
- `SHU251 driver refuses malformed and unbound binding receipts`
- `SHU251 driver restart accepts new supervisor and same live worker`
- `SHU251 driver refuses caller supplied before files`
- `SHU251 driver refuses forged recomputed observed records`
- `SHU251 driver refuses substituted step records`
- `SHU251 driver refuses replayed successful restart records`
- `SHU251 driver refuses cross run custody identities`
- `SHU251 driver refuses genuine records copied from another run`
- `SHU251 driver concurrent consumers emit only one receipt`
- `SHU251 driver restart refuses changed worker missing launch and invalid status`
- `SHU251 driver refuses malformed missing and symlink custody`
- `SHU251 driver custody survives separate processes`
- `SHU251 driver rollback cannot restore active or enabled dispatch`
- `SHU251 driver rollback uses reviewed path and verifies quiescence`
- `SHU251 driver routes all nine reviewed actions`
- `SHU251 driver refuses changed window spec before execution`
- `SHU251 contract missing capabilities never become skips`
- `SHU251 contract probe errors are named preflight refusals`
- `SHU251 contract publishes eight exact sanctioned skips`
- `SHU251 contract refuses outcomes outside the exact permitted set`
- `SHU251 contract rejects incomplete suite and nonzero exit`
- `SHU251 contract preflight failure prevents suite execution`
- `SHU251 contract structured reporter runs only temp fixture tests`
- `SHU251 contract detects capabilities through injectable command boundaries`
- `SHU251 contract source skip reasons remain covered or explicitly prohibited`
- `SHU251 contract source skip guard fails closed on unsupported expressions`
- `SHU251 phase A mutation: missing capability classified as skip`
- `SHU251 phase A mutation: out of set skip accepted`
- `SHU251 phase A mutation: mutation approval bypassed`
- `SHU251 phase A mutation: evidence digest unbound`
- `SHU251 phase A mutation: rollback implicitly reenables dispatch`
- `SHU251 phase A mutation: installed identity compared leniently`

- `SHU251 phase A mutation: replay acceptance`
- `SHU251 phase A mutation: cross-run acceptance`
- `SHU251 phase A mutation: forged record acceptance`
- `SHU251 phase A mutation: substituted record acceptance`
- `SHU251 phase A mutation: caller supplied before acceptance`
- `SHU251 phase A mutation: caller before CLI acceptance`

## Repository verification record

After `chmod -R go-w .github/coordinator`, both required invocations completed:

```sh
TMPDIR=/tmp node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs" npm run test:coordinator
```

Each: **1320 tests / 1312 pass / 0 fail / 8 skipped / 0 cancelled / 0 todo**.
The preceding revision was 1305 / 1297 / 0 / 8. This revision replaces the former
custody-limitation test with a refusal test and adds nine behavioral tests and six
mutation controls. The accepted eight-entry skip allowlist and source guard are
unchanged. The positive restart pair emits a validated `shu251-phase-a-receipt-v1`;
the permitted-skip positive controls continue to pass.

Before committing, a `file://` clone was created with `--depth 1 --single-branch`
and `--branch feat/shu251-phase-a-driver-host-suite-contract`. The three revised
service files were overlaid onto that shallow checkout; `rev-parse
--is-shallow-repository` returned `true`, and `branch -a` showed only that branch
and its origin tracking ref (no `main`). Its full ordinary suite completed with
**1320 tests / 1312 pass / 0 fail / 8 skipped**. No other branch was required.

`config.json` blob OID, before and after, both equal `main`:

```text
before: 8a0317173d76f4c09811b9365e25b380b38dc93d
after:  8a0317173d76f4c09811b9365e25b380b38dc93d
```

This record is repository verification, not host acceptance. No driver or host
preflight was executed against a host. No activation, installation, dispatch,
credential change, signing, remote fixture change, PR creation or merge occurred.
