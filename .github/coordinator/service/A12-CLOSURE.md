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
| C4 | CLOSED_BY_NEW_HEAD (runner precondition); approval-order input outstanding | A12 requires supervisor, coordinator and timer `ActiveState=inactive` before preflight/suite execution. Active, transitional, failed and malformed states refuse. No A12 capability requires these services running. The integrator must place render/identity → A12 create/run/remove → service start in the approval composition. The action does not stop services to manufacture this precondition. |

## Runner spec and production paths

`host-suite-contract.mjs` retains `preflight` and `run` and adds `measure`,
`create` and `remove`. The argument is an absolute JSON spec path. These are
production actions for a future authorized window; none was executed on a host
in this correction. Tests call the production modules with controlled boundaries.

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
  "names": ["every reporter outcome name, including duplicate multiplicities"]
}
```

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
checks remain authoritative. A failure is never rewritten as a skip. Both `run`
and CLI `preflight` consume the revision-bound inventory. Direct injected tests
without an inventory retain conservative unconditional capability requirements.

The exact complete inventory is still absent from this branch (the prior C3
blocker); no guessed inventory is installed. Production binding therefore still
refuses until a complete reviewed inventory, including requirements, exists.
Actual namespace success cannot be established without host access, which is
prohibited here. This is an unproven mandatory acceptance condition, not a deferral.
Repository fixtures prove its refusal path and cannot prove host kernel behavior.

## C2 correction verification (current; earlier tables below are historical)

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
- Inactive systemd state is checked before A12; a durable interlock against an
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
All runs were non-root. The base was a local `git archive` of the exact base SHA;
no remote clone, network checkout, or host account change was used.

| Run | Tests | Pass | Fail | Skipped | Cancelled | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Base focused, excluding installed-host-parser test | 77 | 77 | 0 | 0 | 0 | 0 |
| Final focused, including new controls/mutations, excluding installed-host-parser test | 93 | 93 | 0 | 0 | 0 | 0 |
| Final Phase-A driver, including every Phase-A mutation | 35 | 35 | 0 | 0 | 0 | 0 |
| Base full coordinator + service, refusal boundary | 1352 | 1231 | 119 | 2 | 0 | 0 |
| Final full coordinator + service, refusal boundary | 1368 | 1252 | 114 | 2 | 0 | 0 |
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
