# Independent-verdict closure

Repository-only response to `/home/bawes/work/verdict-prov.md`, following
31e7c69. No target-host access, GitHub action, push, PR, merge or Linear action.
Fixture observations establish repository behavior, not target-host readiness.

| Finding | Before / named mutant | Corrected behavior and named killing assertion |
| --- | --- | --- |
| V1 | An ambiguous DEFERRED branch and omitted `additionalProperties` survived 82 tests. | Both emitters call `validateRuntimeRow` against the committed JSON schema. `V1_EMITTED_ROWS_VALIDATE` covers active, deferred, refusal and window rows. `V1_SCHEMA_AMBIGUOUS_DEFERRED`, `V1_SCHEMA_FABRICATED_MEASUREMENT`, `V1_SCHEMA_MODE_WEAKENED`, `V1_SCHEMA_REFUSAL_WEAKENED` kill those schema mutations. `V1_SCHEMA_FORGERY_MATRIX` rejects eleven further forgeries. `V1_SCHEMA_LOAD_BEARING_provisioner` and `V1_SCHEMA_LOAD_BEARING_measureBrokerRuntime` prove emitter dependence on validation. |
| V2 | `ok:true` on an inactive gate could be mistaken for a measurement by an uninformed consumer. | Preserved by owner instruction: exactly three keys and `DEFERRED_UNTIL_SERVICE_START`, no measured values. `H1_NOT_STARTED`, `H1_EXPLICIT_RUNTIME_MARKER` and V1's schema controls distinguish it. No semantic change. |
| V3 | OR-acceptance of 0754/0664 survived behaviorally. | `V3_{PREMINT,WINDOW}_{DIRECTORY_{754,751},SOCKET_{664,661}}` kills each exact-mode OR-widening mutant, including world execute without write. Both predicate and schema defenses remain active. |
| V4 | A preplanted passing `broker-runtime.json` entered the archive after runtime refusal. | Archive derives only the latest attempt's actual journal measurement. `V4_STALE_ARCHIVE_REFUSAL` kills restoring the unconditional file read. `V4_RESUME_DISCARDS_PRIOR_MEASUREMENT` kills skipping the repeated measurement step after a genuine measured journal prefix. A failing resumed attempt archives null. |
| V5 | 0700, root-owned key with arbitrary GID passed. | Explicitly justified, not tightened: reviewed `privateRead(file, uid=0, exactMode=null, gid=0)` requires a single-link regular root-owned file, no group/world bits, size at most 4 MiB; GID/exact mode apply only when exactMode is supplied. The D1 signing call supplies only the fixed path. `V5_PRIVATE_READ_SEMANTICS` executes both precondition and actual signing with 0700/GID 4242. `V5_REVIEWED_PRIVATE_READ_KILL` kills imposing an inconsistent exact 0600/GID 0 rule and retains refusal of group-readable keys. Provisioning retains its additional nonempty and parent-custody requirements. Operational root:root 0600 remains recommended, not claimed as enforced. |
| V6 | Every lstat error became MISSING. | ENOENT alone maps to `ACT_RUNTIME_{DIRECTORY,SOCKET}_MISSING`; other failures map to `ACT_RUNTIME_{DIRECTORY,SOCKET}_MEASUREMENT`. Eight `V6_{DIRECTORY,SOCKET}_{ENOENT,EACCES,ELOOP,ENOTDIR}` controls kill misclassification in each direction. |
| V7 | Deleting only the numeric clause died solely on a source anchor. | `V7_NUMERIC_RENDER_CLAUSE` appends a duplicate numeric User while preserving the correct named User/Group pair. It directly exercises `identity()` and kills deletion of only the numeric clause by behavioral `ACT_BROKER_UNIT_BINDING` assertion. |
| V8 | Four groups of source deep links pointed to shifted code. | Updated all affected links in the three documents. `V8_DOCUMENTATION_LINK_TARGETS` checks their actual target lines and kills a one-line drift. |
| V9 | Listed static paths had no report rows. | Every listed static dependency below has an explicit row. Twenty `V9_TRAVERSE_<absolute-path>` controls kill deleting each visit and test bad custody. Five `V9_BINDING_*` controls kill accepting wrong identities, credential source, timer target and enabled dispatch. Each fixture snapshot proves read-only traversal. |
| V10 | Runtime measurement was outside `step()`, without its expiry check or startup wait. | `broker-runtime` is a repeated journalled step after `evidence-broker` DONE and before any readiness/activation/gate/ARMED. `V10_JOURNALLED_ORDER` kills removing its journal wrapper and moving it after readiness. `V10_WAIT_FOR_SOCKET` kills removal of bounded absence retries; `V10_WAIT_EXPIRY` kills removal of expiry checks during retry. V4's resume control kills skipping an already-DONE measurement on resume. |

The mutations are executed inside
[`shu71-verdict-closures.test.mjs`](test/shu71-verdict-closures.test.mjs), with
passing controls first and explicit `_KILL` assertions requiring a failure of
the named behavioral assertion. Import/anchor errors do not count as kills.
The three existing inventories only gain entries. The suite file lists remain
executable test files; schema resources are explicitly listed in
`suite-inventory.runtime_artifacts` and the new file-requirements row's
`resources`, and read by that test. The schema also ships in the revision-bound
production tree as before. The evaluator supports every keyword in this schema
and refuses unsupported assertion keywords; it is not a general JSON Schema API.

## V9 path accounting

The precondition statically measures these dependencies before the two runtime
rows, retaining the owner's inactive deferral rule:

* `/usr/bin/{node,systemctl,flock,env,find}` and
  `/usr/sbin/{useradd,groupadd,userdel,groupdel,nologin}`: nonempty, single-link
  regular files, root:root 0755, root-owned non-writable ancestor chain, no
  symlinks (`ACT_PRODUCTION_EXECUTABLE`, or the named prerequisite custody/path/
  measurement code). This is intentionally a static custody check, not execution
  of potentially mutating commands. A host using executable symlinks fails closed
  until its layout is separately reviewed; no such host layout is assumed here.
* `/etc/systemd/system/{shu-supervisor.service,shu-coordinator.service,shu-coordinator.timer}`:
  regular single-link root:root 0644 files under reviewed custody. Services must
  each have exactly one named `User=shu-coordinator` and `Group=shu-coordinator`,
  their respective reviewed EnvironmentFile, and the coordinator's exact
  LoadCredential source. The timer must target `shu-coordinator.service`.
  Codes: `ACT_PRODUCTION_UNIT_CUSTODY`, `ACT_PRODUCTION_UNIT_BINDING`.
  These checks cover static custody/identity bindings; full lifecycle rendering
  remains governed by the existing reviewed lifecycle contract.
* The two service `.d` directories: root:root 0755. Both `90-shu71.conf` files:
  single-link root:root 0644 with exactly `[Service]` and
  `Environment=ENABLE_DISPATCH=false`. Codes: `ACT_PRODUCTION_GATE_DIRECTORY`,
  `ACT_PRODUCTION_GATE`, plus ancestor custody failures. A pre-mint gate refuses
  already enabled dispatch.
* `/run/lock/shu71-production.lock`: its root:root directory must be a real
  directory with no group/world writes unless sticky; an existing lock must be
  a single-link root:root regular file without group/world writes. The lock can
  be absent because the reviewed flock CLI creates it. `ACT_PRODUCTION_LOCK_CUSTODY`
  distinguishes refusal; `CREATED_BY_FLOCK` reports absence without claiming a
  measurement of the future lock. No lock is acquired by the read-only gate.
* `/srv/shu/state/shu71-activation.json`: parent custody is measured and the
  output path must be absent (`ACT_PRODUCTION_ACTIVATION_PRESENT` otherwise).
  Production atomically writes root:999 0640 only at the journalled activation
  step. An old activation is not a prerequisite; it is conflicting state.
* `/etc/shu/approvals/<activation-id>.shu71.json`: the pre-mint command has only a
  revision, before selecting/minting the activation ID. A future approval
  document therefore cannot be required at that stage. The gate traverses the
  approvals directory and every existing `*.shu71.json` document for private
  root custody (`ACT_PRODUCTION_APPROVAL_CUSTODY`); reports explicitly say
  `CUSTODY_ONLY_NOT_AUTHORIZATION`. Production `authority()` subsequently reads
  the exact ID's document via privateRead and validates its signed authorization
  before creating the journal/effects. No unrelated approval counts as this one.
* `/run/credentials/shu-coordinator.service/supervisor-transport`: systemd creates
  this per-service credential at service start from the validated root-private
  `/etc/shu/supervisor.env`. It is not a pre-mint input. The source custody and
  exact `LoadCredential=supervisor-transport:/etc/shu/supervisor.env` binding are
  traversed; kernel/systemd credential creation remains a host-window obligation.
* `/etc/sudoers.d/shu-reviewer-sandbox`: genuinely not an M4 dependency. Reviewed
  execution selects `/etc/sudoers.d/shu-reviewer` and the fixed libexec wrapper;
  this legacy differently named file stays outside the effect set, as required
  by the original brief and `SHU71_KILL_LITERAL_SUDOERS` controls. It is not used
  as a fallback and is not silently accepted as the reviewed policy.

`/usr/bin/git`, `/usr/bin/getent`, `/usr/bin/id` and `/usr/bin/setpriv` remain
exercised through the reviewed read-only commands; failures retain
`ACT_PREREQUISITE_COMMAND` or the more specific existing check code.

## Verification

Use `test/fixture/shu71-ci-like.sh` from the repository root. It establishes
umask 0022, non-root UID 1000 and absent target accounts in private namespaces.
Focused command: `node --test .github/coordinator/service/test/provision*.test.mjs
.github/coordinator/service/test/shu71-runtime-window.test.mjs
.github/coordinator/service/test/shu71-verdict-closures.test.mjs
.github/coordinator/service/test/shu71-owner-decisions.test.mjs
.github/coordinator/service/test/shu71-production.test.mjs` (on one shell line).
Full command: `npm run test:coordinator`. Clock condition adds
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs"`.
Completion output records exact counts, terminal markers, HEAD/tree and
PERMITTED_SKIPS identity. Live NSS, ACL/MAC, real socket connect, systemd startup
latency and target-host presence remain unproven in this repository-only lane.
