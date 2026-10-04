# A12 Option A closure — narrowed scope, not green

Current decision: owner **OPTION A**, repository-only. This section supersedes
all outstanding-deliverable language in the historical records below and in
`userns-profile/`. The independent `/home/bawes/work/A12-WRAPPER-TRACE.md` was
read. No deployment, host window, push, PR action or external comment occurred.

## Refresh and preservation

Started at `1a1f012427404c3aedde61516749dd8174519981`; fetched main at
`2348c026e44240ebf1622781a8bd0d6b56394790`. Contrary to the prior audit, the merge
had six conflicts: this document, PHASE-A-DRIVER.md, disposable-suite.mjs,
host-suite-contract.mjs, suite-runner-spec.mjs and its test. Merge commit
`dc00ce5` preserves both sides: main's failure-first reporter, cyclic-import
CLI remedy, null-requirement refusal and validated skip-reason receipts; this
branch's closed spec schema, revision/tree/clean-tree binding, checkout realpath,
per-file revision-object digests, inventory byte digest and durable custody
binding. Quiescence and capability-requirements derivation are unchanged.
The reporter/CLI and binding mutation controls pass together.

`PERMITTED_SKIPS` is byte-identical to both parents: **eight entries**, no ninth
skip. The M3 probe remains exactly
`/usr/bin/unshare --user --map-root-user /bin/true` under the service identity.
No production guard, error code or allowance changed in Option A. The workflow
`.github/workflows/ci.yml` was not edited and is byte-identical to refreshed main
(the merge necessarily imports main's changes relative to the starting branch).

## Re-expressed startup proof

The removed `SHU261_NO_SETENV_NAMESPACE_STARTUP` used a user namespace only as
a substitute for sudo/root and stopped at the argv guard. Its property is now
carried by the three existing reviewed proofs, without a namespace:

| Proof | Assertions carrying the property |
| --- | --- |
| `SHU261_NO_SETENV_POLICY` | Real sudoers bytes parsed through `resolveCvtsudoers`; an explicit `setenv === false` option, no non-false SETENV option, and exact command-specific `env_keep === ['CLAUDE_CODE_OAUTH_TOKEN']`. This covers environment admission and OAuth preservation. |
| `SHU261 wrapper contract isolates both reviewer phases and every protected class` | Exact `^#!/bin/bash -p$`, no `#!/usr/bin/env`, `compgen -e` before `set -euo pipefail`, fixed PATH and exact command-specific OAuth/NOSETENV sudoers regexes. |
| `SHU261 root wrapper startup ignores PATH and BASH_ENV before parsing` | Directly executes the shipped shebang with hostile PATH and a real BASH_ENV file; requires exit 64, no startup marker and stderr matching `exact workspace binding`. This covers startup code suppression and the argv guard. |

Together these retain the old policy, startup and guard claims. They do not
prove installed sudo enforcement or host-root startup. Added mutation
`SHU-261 mutation: root privileged bash mode removed` changes
`#!/bin/bash -p` to `#!/bin/bash`, runs **only** the direct-exec test and requires
an AssertionError naming `SHU261_ROOT_STARTUP: neither a PATH interpreter nor
BASH_ENV code may execute`. It is killed. Existing `sudo SETENV restored` and
`root interpreter uses caller PATH` mutations also remain killed by the wrapper
contract. No mutation depends on the removed namespace test.

The only checked-in inventory-requirement reference for the removed test was
the synthetic `ns` row in `service/test/capability-requirements.test.mjs`:
`SHU261_NO_SETENV_NAMESPACE_STARTUP → [{name: 'user_namespaces'}]`.
That mapping is removed. A reviewed replacement mapping in the same test gives
policy → `cvtsudoers`, source contract → `[]`, direct-exec → `bash`, and asserts
that derivation yields `user_namespaces: []`. This is a test fixture, **not a
production inventory**. The old namespace refusal assertion and its mutation
remain intact using the explicitly synthetic `M3 namespace capability control`
name. Neither the M3 probe nor general capability admission was relaxed.

## Removed / out of scope

Production is `sudo -n /usr/local/libexec/shu-reviewer-sandbox` → wrapper →
`systemd-run` with `--property=RestrictNamespaces=yes`, which denies namespace
creation. No production launched path needs the proposed exception. Therefore:

- The proposed static ELF `/usr/local/libexec/shu251-a12-suite-runner` is removed
  from scope; no binary or native source was ever built.
- The inert `userns-profile/a12.apparmor` exception profile body is removed.
  It was never parsed/loaded on the target and could not execute the wrapper.
- The host installer/load/verify/teardown model is removed from scope; its
  JavaScript simulation is deleted. No production implementation was built.
- The authenticated evidence collector is removed from scope; never built.
- The six native production mutations (binary substitution, wrong binary
  digest, wrong owner/mode, stale/wrong loaded profile, interrupted installation,
  failed teardown) are removed from scope, never implemented or killed.
- Supporting profile-only machinery is deleted: `contract.mjs`, `controls.mjs`,
  `mutations.mjs`, synthetic `receipts.example.json` and
  `service/test/userns-profile.test.mjs` (17 design tests/eight model mutations).
  Their historical passes are not production evidence or current suite counts.

The attempt remains in Git history at `1a1f0124`; DESIGN.md, VERIFICATION.md,
AMEND2.md and both outcome JSON records remain with explicit historical status
in the directory README and document notices. These records do not imply that
removed work is still owed. Independently useful suite admission remains.

## M3 host-window acceptance item — OPEN

**Exercise the real `sudo -n /usr/local/libexec/shu-reviewer-sandbox` execution
at EUID 0 with a real `BASH_ENV` on the host, checking that caller-controlled
startup code does not execute through the installed sudo policy and wrapper.
This is host-only and unproven here.**

The local direct-exec test is non-root and exits at argument validation; it does
not run sudo, install a wrapper, exercise systemd confinement or prove live
Claude authentication. No M4 or M5 acceptance is claimed.

## Satisfied, narrowed, open

- **Satisfied here:** replacement repository proofs and named mutation kill;
  removal of the test-specific namespace requirement and dead design scope;
  unchanged eight skips and fixed M3 probe; retained admission hardening and
  main's reporter/CLI remedies, exercised by repository controls.
- **Narrowed:** namespace-root startup is no longer an A12 test technique or
  AppArmor/native-runner deliverable. Its actual EUID-0 residual is the M3 item
  above. This is not a new skip or an authorization to waive a capability.
- **Open:** `service/suite-inventory.json` remains absent and required.
  Production admission still refuses `SHU251_SUITE_INVENTORY`; the missing Git
  inventory object has an explicit refusal assertion. No inventory or successful
  production run was fabricated. Existing preflight still requires the M3
  namespace probe even with no test-specific namespace requirement, and refuses
  `SHU251_PREFLIGHT_USER_NAMESPACES` on absence. No host capability is proved.
  Full coordinator/service success is not established by the focused runs.
  Complete interruption recovery, the durable interlock, approval composition,
  and C4's CLI-preflight custody/quiescence gap remain open as recorded below.
  Bindings remain point-in-time checks, not protection against concurrent
  replacement. A fresh independent verdict is required; Option A is not A12 green.

## Option A executed verification

Node v22.22.3, non-root, local repository and temporary fixtures only. A12 and
Phase-A use the unchanged repository-refusal preload. SHU-261 runs use local
Bash, the locally installed identity-checked parser, temporary canaries and
injected production-command boundaries; no deployed host, sudo execution,
namespace creation, systemd action or network service access occurs.

| Suite | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Focused A12, including reporter/CLI, requirements, parser, binding and custody | 129 | 129 | 0 | 0 |
| Phase-A, including routing and mutations | 42 | 42 | 0 | 0 |
| SHU-261 reviewer isolation + full SHU-261 mutation battery | 54 | 54 | 0 | 0 |
| SHU-261 review findings, including real policy parse | 13 | 13 | 0 | 0 |

Total **238 pass, zero failures/skips/cancelled/todo** in these selections.
Mutation controls: **59 focused + 18 Phase-A + 41 SHU-261 = 118 passing**;
Phase-A additionally has a positive approval test with “mutation” in its name,
which is not counted as a kill. The 41-test SHU-261 battery includes the new
privileged-mode mutation; its separate 13-test isolation suite passes intact.
An additional isolated policy run passed 1/1 (not double-counted above).
Commands, exact names and log digests are in
`test/fixture/option-a-results.json`; raw logs are in `/tmp/a12-option-a/`.
No full-suite inventory count, unrestricted full-suite pass, deployed sudo or
AppArmor enforcement, host cleanup, M3/M4/M5 closure or independent PASS is
supported by these results.

---

# Historical correction record (superseded where Option A narrows scope)

The sections below preserve prior attempts and measurements. Their namespace
wrapper/profile requirements and earlier “current” labels are historical;
only the Option A section above describes this head's scope and evidence.

# L4 correction record — partial closure, not approval

Base: `00eb979800b5ef6dfb918b57002d167802238612`.
Branch: `fix/shu251-a12-host-suite-contract`.
Governing inputs: the Hermes final execution closure directive, the shared L4
brief, and C1–C4 of `reconciliation-135.md`. The commit containing this record
is the correction head; no live acceptance or permission to execute is implied.

| Finding | Disposition | Evidence / remaining requirement |
| --- | --- | --- |
| C1 | CLOSED_BY_NEW_HEAD (static) | The actual `shu261-review-findings.test.mjs` policy test calls `resolveCvtsudoers`, including its root-fixture validation, identity checks and inherited descriptor execution. Policy conversion uses that same open descriptor, with checks before/after conversion. A virtual filesystem exposes only `/usr/bin/cvtsudoers.ws`; the loaded real suite body passes. Restoring the hardcoded call dies at `SHU251_SUITE_PARSER_REQUIRED`. Real installed-parser execution was prohibited, not claimed. |
| C2 | CONTRACT_CORRECTED; HOST_PROOF_UNSUPPORTED | Owner ruling implemented below. Exact capability requirements are revision-bound; namespace proof remains mandatory. No host access or policy change. |
| C3 | CONFIRMED_BLOCKER (partially implemented) | The runner rejects caller-selected file/count fields, binds HEAD/tree/cleanliness/identity, derives both suite globs from the pinned Git tree, reads outcome names from a pinned inventory, and compares their multiset. Reviewed create/verify/record/remove operations preserve an external durable receipt. **The authoritative inventory has not been produced** because full verification is not green. Interruption coverage is incomplete; see limitations. |
| C4 | PARTIAL (run precondition only); approval-order input outstanding | A12 requires supervisor, coordinator and timer `ActiveState=inactive` before capability probes and suite execution in `run`. CLI `preflight` binds the inventory but does not enforce quiescence or disposable custody; C4 remains open for that action. Active, transitional, failed and malformed states refuse. No A12 capability requires these services running. The integrator must place render/identity → A12 create/run/remove → service start in the approval composition. The action does not stop services to manufacture this precondition. |

## R2 verifier amendments (current)

Read both `/home/bawes/work/verdict-137-r2.md` and `.json`, adjudicated at
`a2dfe80352bfc0f8dae7d069381a25d4fad7be88`. G1 is corrected by the verified
minimal remedy: the existing CLI try/catch runs inside `void (async () => { … })()`.
Module evaluation can finish before its dynamic imports await modules that
statically import this module. All existing guards, error codes and assertions
remain intact. This is not a new independent PASS or host acceptance.

`cli-amendments.test.mjs` spawns the shipped entrypoint for all five actions.
Each deliberately invalid-identity spec reaches the real imported identity
check and returns exactly one JSON error on stderr, no stdout, and exit **2**:
`{"ok":false,"code":"SHU251_SUITE_IDENTITY","reason":"SHU251_SUITE_IDENTITY: "}`.
The test explicitly loads the repository refusal boundary; no host command or
host metadata access is required. For each action, a syntax-valid mutant
restores top-level await while retaining both real back-imports. All five
mutants reproduce exit **13**, emit no receipt, and die at `CLI_TYPED_REFUSAL`.
Library controls continue to cover successful injected paths; these subprocess
refusals prove CLI dispatch/error behavior, not a successful host run.

The two added F1 shapes use exact permitted names/reasons: `t.skip()` followed
by a failing `t.after` hook, and `t.skip()` followed by a 50ms timeout during a
400ms await. Each still has Node exit **0**, emits a failure outcome, and refuses
`SHU251_SUITE_FAILURE`. Each has its own old-precedence mutant, killed at
`REPORTER_FAILURE_SHAPE`. The prior F1/F6/F7 controls and mutants still pass.

All runs below use Node v22.22.3, non-root, `umask 0002`, coordinator files
non-writable by group/other, and the same unchanged repository refusal preload.
Base and current source were run as real Git checkouts. No systemd skip override
was set. Both full globs include every test/mutation file in their scope.

| Run | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Focused A12, including all R1/R2 controls and mutants | 124 | 124 | 0 | 0 |
| Phase-A, including all its mutants | 35 | 35 | 0 | 0 |
| Base full coordinator + service | 1352 | 1236 | 114 | 2 |
| Current full coordinator + service | 1399 | 1283 | 114 | 2 |
| Base service | 247 | 224 | 23 | 0 |
| Current service | 294 | 271 | 23 | 0 |

Zero cancelled/todo in all six runs. Failure-name lists and skip name/reason
pairs match base exactly: zero new failures or skips, 47 passing additions
versus base, 14 versus the R2-adjudicated head. **Full suites remain FAIL.**
Broader mutation kills and unrestricted suite success remain unsupported.
The focused and Phase-A matrices contain **69 passing mutation-named tests**:
56 focused source mutants, 12 Phase-A source mutants, and one Phase-A approval
control. Thus **68/68 source mutants are killed**, including all seven added
here. G4's historical 62-versus-61 discrepancy is reconciled explicitly below
and in the historical fixture; no extra mutant is invented from a control name.

G5's C4 label is now `PARTIAL`, matching its run-only scope. F4 remains open
by design: no authoritative inventory is shipped; C3 is `CONFIRMED_BLOCKER`
and C2 is `HOST_PROOF_UNSUPPORTED`. No host capability, actual namespace
success, complete interruption recovery, durable interlock, or other Node
version is proved here. G2's corpus-only preservation scope is explicit below.

`PERMITTED_SKIPS` is byte-identical to base: 1093 bytes, eight entries, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
The reporter itself is unchanged from the R2-adjudicated head, preserving the
verified F1 remedy. Exact counts, failure names, skip pairs, mutation names,
CLI envelopes and log digests are in `test/fixture/r2-amendment-results.json`;
raw logs are retained in `/tmp/l4-r2-amend/`.

Reproduce focused verification with the same refusal preload used for full
runs below, adding `^SHU251 C2|` to the focused pattern and adding
`capability-requirements.test.mjs`, `reporter-amendments.test.mjs` and
`cli-amendments.test.mjs` to the focused file list. No assertion, guard, error
code, skip allowance or boundary was weakened. No host access, push, PR action,
merge, GitHub comment or Linear comment occurred.

## Independent-verifier amendments (R1 historical)

Applied the mandatory amendments from `/home/bawes/work/verdict-137.md` and
`.json`, adjudicated at `3bc169740573f95e68c33a0bcc971db00ae3bc65`.
This record does not claim a new independent PASS or A12 approval.

- **F1, code corrected in this lane:** the reporter now gives `test:fail`
  precedence over skip/todo flags with the verifier's exact one-line remedy:
  `status: event.type === 'test:fail' ? 'fail' : d.skip ? 'skip' : d.todo ? 'todo' : 'pass'`.
  The end-to-end regression runs temporary tests with exact permitted names and
  reasons: synchronous assertion and async throw after `t.skip()` both reach
  `SHU251_SUITE_FAILURE`, even though Node exits zero. The option-form skip stays
  accepted and a changed reason still refuses. Reverting the line kills the
  regression at `REPORTER_FAILURE_PRECEDENCE`.
- **F2, claim corrected and comparison remeasured:** historical archive versus
  checkout rows are explicitly labelled below. The apparent five-failure
  improvement was a harness artifact. Current base and amended-head runs both
  use real Git checkouts and have identical failure names and skip pairs.
- **F3, claim corrected:** C4 guarantees quiescence/custody for `run` only.
  CLI `preflight` does not enforce those preconditions. This describes the
  existing code accurately without claiming an additional execution guarantee.
- **F4 remains open:** C3 is `CONFIRMED_BLOCKER`; C2 is
  `HOST_PROOF_UNSUPPORTED`. No placeholder inventory was added. Full successful
  verification, a complete reviewed inventory with requirements, and mandatory
  host namespace proof remain necessary before acceptance can execute.
- **F5:** the structural inventory example includes `requirements`.
- **F6:** explicit null requirements refuse `SHU251_PREFLIGHT_REQUIREMENTS`
  before probing. Omitted requirements retain strict legacy behavior; null is
  not treated as authorization to omit the inventory. The removed-guard mutant
  dies at `NULL_REQUIREMENTS_TYPED`.
- **F7:** receipts record `PERMITTED_SKIPS[need.test]`, the validated reason,
  rather than rereading a getter-supplied value. The reverted mutant dies at
  `VALIDATED_RECEIPT_REASON`. F8's empty-requirement behavior is unchanged and
  does not establish host capability or authorize an outcome skip.

### Executed amendment verification

All runs used Node v22.22.3, UID 1000, `umask 0002`, coordinator files made
non-writable by group/other, and the unchanged repository refusal preload.
No `SHU251_NO_SYSTEMD` override was set. No test executed host commands.

| Run | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Focused A12 including amendment controls/mutations | 110 | 110 | 0 | 0 |
| Phase-A including every Phase-A mutation | 35 | 35 | 0 | 0 |
| Base full, real Git checkout | 1352 | 1236 | 114 | 2 |
| Amended full, real Git checkout | 1385 | 1269 | 114 | 2 |
| Base service | 247 | 224 | 23 | 0 |
| Amended service | 280 | 257 | 23 | 0 |

Cancelled/todo are zero throughout. No tests removed, 33 passing additions
versus base (six since the verified head), zero new or fixed failures, and
identical skip names/reasons. **Full suites remain FAIL.** All mutation files
were included in their full globs; broader mutation success is unsupported.
The focused matrices contain **62/62 passing mutation-named tests**: 49 focused
and 13 Phase-A. Of these, **61 are mutation kills** (29 parser, 12 Phase-A,
eight prior correction, nine C2, three amendments); the thirteenth Phase-A
name is `SHU251 driver approval is explicit for every mutation`, a positive
approval control rather than a source mutant. All source mutants have positive
controls and syntax checks. This includes the verifier's D1–D5 defect shapes through the existing
binding, cardinality, actual-parser, uncovered-requirement and inventory mutants.

**Behavior preservation:** independently ran the exact verified-head archive
at the same path twice with the same preload, changing only the external
reporter's one line. All **1379 outcomes** are byte-identical: **1258 pass,
119 fail, two skip** each time. Both JSONL files (including the completion
record) have SHA-256
`d23939c0ef57d71328cf0ae20ea7816ee49401c607e5b58c31dd932377b45b42`.
These are archive-harness figures, not checkout figures. Relative to the
verifier's archive run, 11 systemd-conditional cases fail instead of skipping;
no systemd-prohibition skip override was introduced here.

The 1093-byte, eight-entry `PERMITTED_SKIPS` source block is byte-identical to
the verified head and has SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
Exact counts, failure names, skip pairs, mutation names and log digests are in
`test/fixture/verifier-amendment-results.json`. Raw logs and reporter variants
are retained in `/tmp/l4-amend-137/`.

Reproduce the focused command below with `^SHU251 C2|` added to its name pattern
and both `capability-requirements.test.mjs` and `reporter-amendments.test.mjs`
added to its file list. Every invocation, including focused and Phase-A, must
use the `L4_REPOSITORY_ROOT` and `NODE_OPTIONS` preload shown in the full-run
commands. For the preservation comparison, extract the verified head with
`git archive`, prepare permissions identically, and run both full globs with
`--test-reporter` selecting separate shipped and one-line-fixed module copies;
compare the entire JSONL files with `cmp`, without filtering outcomes.

## Runner spec and production paths

`host-suite-contract.mjs` retains `preflight` and `run` and adds `measure`,
`create` and `remove`. The argument is an absolute JSON spec path. These are
production actions for a future authorized window. The R2 correction removes
the CLI top-level-await deadlock; subprocess tests execute all five actions
against a deliberately invalid identity and assert a structured
`SHU251_SUITE_IDENTITY` refusal (exit 2). No host action was executed. Library
controls separately exercise successful paths through injected boundaries.

The spec binds:

- `service_uid`, `service_gid`, and the exact numeric `service_groups` set;
- `revision` (full commit SHA), `tree` (full tree SHA);
- `source_checkout` (local absolute path), `disposable_parent` (existing,
  service-owned, non-writable by other identities, traversable ancestors);
- `activation_id` (bounded lowercase identifier);
- `checkout = disposable_parent/activation_id/checkout` and
  `temp_dir = disposable_parent/activation_id/tmp`.

The entire spec serialization is SHA-256 digested into the custody receipt.
Equivalent specs with different JSON key order are deliberately not interchangeable.
The runner identity must already be the service identity and must not be root.
There is no chown, sudo escalation, automatic namespace enablement or Git trust
exception in the clone actions. Clone transport is local only, without hardlinks.
The source revision's inventory is read with `git show`, not from caller fields.

The inventory path is `.github/coordinator/service/suite-inventory.json` in the
pinned revision. Its required shape is:

```json
{
  "version": "shu251-suite-inventory-v1",
  "files": ["complete sorted tracked file set matching the two package.json test globs"],
  "names": ["every reporter outcome name, including duplicate multiplicities"],
  "requirements": [{
    "name": "every reporter outcome name, including duplicate multiplicities",
    "capabilities": [{"name": "user_namespaces"}]
  }]
}
```

The example is structural only: repeat a requirements row for every name occurrence
and review its exact capabilities; it is not an authoritative inventory.

`expected_tests` is `names.length`. Missing/extra files, caller `files` or
`expected_tests`, changed identities, dirty checkout, revision/tree mismatch,
missing inventory, missing/extra/duplicate-replacement outcomes and unsupported
skip names/reasons refuse. Existing `SHU251_SUITE_*` result checks and all eight
`PERMITTED_SKIPS` entries remain intact. The inventory must be generated and
reviewed from a complete successful reporter run and committed before A12 is
executable. No placeholder inventory is shipped and no failed run was used to
invent a count. This is an outstanding capability blocker, not closure by refusal.

Create journals outside the clone at
`disposable_parent/activation_id.a12.json`, using exclusive creation and atomic
fsynced replacements. It records the disposable root inode before cloning.
Run verifies that receipt and records successful suite results there. Remove
checks spec digest, owner, mode and inode; it removes only the fixed disposable
root and leaves the receipt and recorded results. Repeated completed removal is
idempotent. A failed Git clone is recoverable from the `creating` receipt.

## C2 owner ruling (supersedes the prior options)

Owner-supplied measurements: shu-coordinator UID 999, GID 982, supplementary
workspace group 980; shu-reviewer UID 994, GID 979. The reviewer's only sudo grants
are `ALL=(shu-worker:shu-worker) NOPASSWD /usr/local/sbin/shu-worker-launch` and
`ALL=(root) NOPASSWD /usr/local/libexec/shu-reviewer-sandbox`. Neither authorizes
`/usr/bin/id` or `/usr/bin/setpriv`. These facts were supplied by the owner, not
measured in this repository-only run. Coordinator sudo authority is not inferred
from the reviewer grants.

The eight `PERMITTED_SKIPS` entries are preserved byte for byte. No added sudoers
rule is proposed or assumed. Namespace proof is mandatory, with no deferment or
skip authorization. The existing service-identity unshare probe remains required;
its absence fails `SHU251_PREFLIGHT_USER_NAMESPACES`, naming its requiring tests.

The revision-pinned inventory now includes `requirements`, one row for each exact
name occurrence in `names`: `{name, capabilities: [{name, reason?}]}`. Empty lists
are explicit reviewed declarations. An omitted, extra, duplicate or unknown
capability declaration fails `SHU251_PREFLIGHT_REQUIREMENTS`; duplicate test names
are checked as a multiset. Each optional reason must match that exact test's
existing authorized skip byte for byte or fail `SHU251_PREFLIGHT_SKIP_BINDING`.
Missing privilege/worker capability is permitted only when all requiring tests
have such coverage. Any uncovered test fails under the existing capability code,
with its name in the error. Infrastructure probes remain required independently
of test requirements. A probe exception still fails under the existing code.

Preflight records potential authorized skips; it does not generate outcomes.
The suite still executes and its existing failure, reason, name, count and exit
checks remain authoritative. A failure is never rewritten as a skip. Failure precedence also reports an
option-form skip inside a suite with a failing `before` hook as a failure;
byte preservation above applies to that measured corpus, not every possible
test program. Both `run`
and CLI `preflight` consume the revision-bound inventory. Direct injected tests
without an inventory retain conservative unconditional capability requirements.

The exact complete inventory is still absent from this branch (the prior C3
blocker); no guessed inventory is installed. Production binding therefore still
refuses until a complete reviewed inventory, including requirements, exists.
Actual namespace success cannot be established without host access, which is
prohibited here. This is an unproven mandatory acceptance condition, not a deferral.
Repository fixtures prove its refusal path and cannot prove host kernel behavior.

## C2 correction verification (historical, before verifier amendments)

All runs used UID 1000, the existing repository refusal preload, local temporary
fixtures and local Git only. No host access, sudo changes, root suite execution,
push, PR, merge, GitHub or Linear action occurred. The eight-entry skip constant
was compared with the parent revision and its complete source block is byte-identical.

| Run | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Focused contract/parser/inventory/disposable/C2 | 104 | 104 | 0 | 0 |
| Phase-A, including its mutation matrix | 35 | 35 | 0 | 0 |
| Full coordinator + service globs | 1379 | 1263 | 114 | 2 |
| Full service glob | 274 | 251 | 23 | 0 |

All runs have zero cancelled/todo tests. The two full-run skips are the unchanged
SHU-71 restricted capability and READER operator-owned checkout pairs. Exact
failure names, counts, skip text and SHA-256 log digests are in
`test/fixture/c2-correction-results.json`; raw logs are in
`/tmp/shu251-c2-evidence/{focused,phase-a,full,service}.tap`.

**58/58 mutations killed** in the focused L4 matrices: 29 parser, 12 Phase-A,
8 prior correction and 9 C2. All have positive controls and syntax checks.
The new codes and their killing mutations are:

| Code | Killing mutation | Named control |
| --- | --- | --- |
| `SHU251_PREFLIGHT_REQUIREMENTS` | `required set omitted` | `SHU251_PREFLIGHT_REQUIREMENTS` |
| `SHU251_PREFLIGHT_SKIP_BINDING` | `skip binding bypassed` | `SHU251_PREFLIGHT_SKIP_BINDING` |

The other seven new mutations kill: covered absence rejected (`COVERED_ABSENCE`),
uncovered requirement ignored (`UNCOVERED_BY_NAME`), malformed probe reclassified
(`MALFORMED_PROBE_NOT_SKIP`), probe failure reclassified (`PROBE_FAILURE_NOT_SKIP`),
namespace absence waived (`NAMESPACE_REQUIRED`), new outcome failure accepted and
different outcome reason accepted (both `OUTCOME_NOT_RECLASSIFIED`). Uncovered
privilege/worker tests retain `SHU251_PREFLIGHT_PRIVILEGE` and
`SHU251_PREFLIGHT_WORKER_UID`, respectively, and include the uncovered test name.

Both full globs include every test/mutation file in their scope. They **do not
pass** under the refusal boundary, and not every remaining failure or mutation
can be certified. Host-dependent modules can fail before registering all tests;
these observed counts do not establish a complete inventory. No assertion or
boundary was relaxed to improve the counts. Full host acceptance, every broader
mutation's kill, the complete reviewed inventory, and actual namespace success
remain unsupported. Namespace proof is still required, not deferred or waived.

Reproduce with the existing full-run commands below, adding
`service/test/capability-requirements.test.mjs` and `^SHU251 C2|` to the focused
file list and name pattern, respectively. Apply the same `L4_REPOSITORY_ROOT` and
`NODE_OPTIONS` refusal preload to focused and Phase-A runs as to full runs.

## New named assertions and killing mutations

Each listed mutation has a passing positive control and syntax-valid mutated
JavaScript, and is killed by `ERR_ASSERTION` naming the indicated code.

| Code | Killing mutation | Test |
| --- | --- | --- |
| `SHU251_SUITE_PARSER_REQUIRED` | hardcoded `/usr/bin/cvtsudoers` restored in the actual A12 suite body | `SHU251 A12 mutation hardcoded parser dies in real suite` |
| `SHU251_SUITE_IDENTITY` | root runner accepted | `SHU251 suite mutation root runner accepted` |
| `SHU251_SUITE_REVISION` | revision ignored | `SHU251 suite mutation revision ignored` |
| `SHU251_SUITE_INVENTORY` | caller count accepted | `SHU251 suite mutation caller count accepted` |
| `SHU251_SUITE_QUIESCENCE` | live timer accepted | `SHU251 suite mutation live timer accepted` |
| `SHU251_SUITE_NAMES` | duplicate name accepted | `SHU251 suite mutation duplicate name accepted` |
| `SHU251_SUITE_DISPOSABLE` | foreign checkout accepted | `SHU251 disposable mutation accepts foreign checkout` |
| `L4_REPOSITORY_BOUNDARY` (test-only) | host command admission check removed | `L4_REPOSITORY_BOUNDARY mutation refuses host command before fake execution` |

Existing parser failure codes also cover failure/invalid JSON on policy conversion;
no previous parser assertion, skip allowance, refusal code or Git ownership guard
was removed. Existing parser and Phase-A mutations are rerun below.

## Limits that remain blocking

- No full successful suite, authoritative inventory, or exact expected host count.
- Owner-supplied C2 identity/grant facts are recorded above; live namespace proof remains unsupported and mandatory. No host-policy change is authorized or proposed.
- Clone failure recovery is tested, but not process death at every boundary.
  In particular, death between root mkdir and inode journaling is ambiguous;
  removal refuses an unbound inode instead of guessing custody. Partial initial
  receipt writes and interrupted fsync/rename need more recovery tests. Failed
  suites currently leave the clone/custody for explicit removal and do not archive
  a complete failed-run outcome report.
- Inactive systemd state is checked by `run`, not CLI `preflight`; a durable interlock against an
  independent actor starting the plane during A12 and integration with the L1
  operation journal remain unproved.
- The repository test boundary is an injected refusal boundary, not a kernel
  sandbox or evidence of actual host capability. Full-suite failures under it
  cannot be represented as successful host acceptance.

No host login/contact, install, placement, unit operation, checkout pin, signing,
reseeding, activation, dispatch, fixture-card mutation, push, PR, merge or
GitHub/Linear comment occurred. No root suite, privilege widening, namespace
policy change, or added skip allowance occurred. Local temporary Git repositories
and test fixtures were used for controlled tests only.

## Executed verification

Before suites: `chmod -R go-w .github/coordinator`; `umask 0002`.
All runs were non-root. **Harness mismatch:** base used a local `git archive`
without `.git`; final used a real Git checkout. The apparent 119 → 114 failure
delta is five archive artifacts, not an improvement from this PR. The affected
tests are `EXEC_PACKAGE_CHECKOUT_DRIFT`, `EXEC_PACKAGE_MUTANT_CHECKOUT_DRIFT`,
`EXEC_RUNTIME_CHECKOUT_DRIFT`, `EXEC_RUNTIME_MUTANT_CHECKOUT_DRIFT`, and
`SHU-63 activation: the RUNNING revision is what bounds an activation, end to end`.
The verifier measured identical failure-name sets (103 each) using real checkouts
on both sides; its systemd-less environment also skipped 11 tests that failed here.
The base was a local `git archive` of the exact base SHA;
no remote clone, network checkout, or host account change was used.

| Run | Tests | Pass | Fail | Skipped | Cancelled | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Base focused, excluding installed-host-parser test | 77 | 77 | 0 | 0 | 0 | 0 |
| Final focused, including new controls/mutations, excluding installed-host-parser test | 93 | 93 | 0 | 0 | 0 | 0 |
| Final Phase-A driver, including every Phase-A mutation | 35 | 35 | 0 | 0 | 0 | 0 |
| Base full coordinator + service, archive (no `.git`), refusal boundary | 1352 | 1231 | 119 | 2 | 0 | 0 |
| Final full coordinator + service, Git checkout, refusal boundary | 1368 | 1252 | 114 | 2 | 0 | 0 |
| Base full service, refusal boundary | 247 | 224 | 23 | 0 | 0 | 0 |
| Final full service, refusal boundary | 263 | 240 | 23 | 0 | 0 | 0 |

**Full suites are FAIL.** File-level refusal can prevent additional tests from
registering: these observed counts are not a complete expected A12 inventory.
Failures include rejected system/parser/privilege/shell/filesystem probes and
assertions whose fixtures depend on those commands. Every remaining failure has
not been independently classified; no claim is made that every failure is solely
caused by the boundary or that unrestricted suites would pass.

Both full runs have exactly the same two skip names **and reasons**, in order:

1. `SHU-71 restricted capability refusal` —
   `production vocabulary has no undeclared runtime/role pair`
2. `READER operator-owned checkout read by non-root account` —
   `Not exercisable: non-root account, no passwordless elevation to create root-owned checkout`

Service runs and focused runs have no skips. No failure was converted to a skip.
The other six sanctioned skips were not fabricated when privilege probes were
refused: their modules failed instead. The installed-parser test was excluded
only from the explicitly focused invocation; it was included and refused in the
full invocation. Neither `SHU251_NO_SYSTEMD` nor new skip allowances were used.

Mutation evidence: **29/29 existing parser**, **12/12 existing Phase-A**, and
**8/8 new** mutations killed by their named assertions, with positive controls
and syntax checks (49 total, no survivor in these matrices). Other repository
mutation files were attempted by the full glob; their failures under the boundary
are not represented as successful mutation verification.

Reproduce focused tests:

```sh
chmod -R go-w .github/coordinator
umask 0002
node --test --test-name-pattern='^SHU251 A12|^SHU251 parser (?!real installed provider)|^SHU251 contract|^SHU251 suite|^SHU251 disposable|^L4_REPOSITORY_BOUNDARY' \
  .github/coordinator/service/test/host-suite-contract.test.mjs \
  .github/coordinator/service/test/suite-runner-spec.test.mjs
node --test .github/coordinator/service/test/phase-a-driver.test.mjs
```

Reproduce the full refusal-boundary attempts (expected to fail, not a host pass):

```sh
L4_REPOSITORY_ROOT="$PWD" \
NODE_OPTIONS="--import=$PWD/.github/coordinator/service/test/fixture/a12-repository-boundary.mjs" \
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
L4_REPOSITORY_ROOT="$PWD" \
NODE_OPTIONS="--import=$PWD/.github/coordinator/service/test/fixture/a12-repository-boundary.mjs" \
node --test .github/coordinator/service/test/*.test.mjs
```

The actual preload during these runs was
`/tmp/shu251-l4-evidence/repository-boundary.mjs`, byte-identical to the committed
fixture. It rejects host paths/commands with `L4_REPOSITORY_BOUNDARY`, injects
itself into spawned Node commands, and limits Git transport to local files with
hooks disabled. It does not fake command success. It is test orchestration,
not part of the production A12 runner and not a substitute for kernel isolation.

Raw TAP is retained in `/tmp/shu251-l4-evidence/{base-focused,focused,phase-a,base-full,final-full,base-service,final-service}.tap`.
`test/fixture/a12-correction-results.json` preserves exact counts, skip names and
reasons, and SHA-256 digests of those raw outputs. The preliminary diagnostic
attempts had a boundary environment-inheritance defect that reintroduced
`NODE_TEST_CONTEXT` into mutation children; the table above uses reruns after
that defect was fixed. No production assertion was changed to accommodate it.

## Files changed

All paths below are relative to `.github/coordinator/`.

- `service/host-suite-contract.mjs`: shared policy conversion, pinned runner binding,
  preserved outcome checks, named multiset check, durable result recording and CLI routes.
- `test/shu261-review-findings.test.mjs`: use the shared parser resolver.
- `service/suite-runner-spec.mjs`: identity, pinned inventory, quiescence and metadata.
- `service/disposable-suite.mjs`: create/verify/record/remove with retained custody.
- `service/test/host-suite-contract.test.mjs`: preserve existing controls and add the
  actual-suite hardcoded-path mutation and policy conversion failure controls.
- `service/test/suite-runner-spec.test.mjs`: pinned-spec, metadata, local clone,
  receipt-retention, failure and mutation controls.
- `service/test/fixture/a12-repository-boundary.mjs`: verification-only refusal boundary.
- `service/test/fixture/a12-correction-results.json`: counts, skips and raw-log digests.
- `service/PHASE-A-DRIVER.md`: replace the obsolete caller-selected runner spec.
- `service/A12-CLOSURE.md`: this disposition, evidence and remaining-blocker record.
