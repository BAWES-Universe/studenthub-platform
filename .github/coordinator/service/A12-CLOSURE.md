# L4 correction record — partial closure, not approval

Base: `00eb979800b5ef6dfb918b57002d167802238612`.
Branch: `fix/shu251-a12-host-suite-contract`.
Governing inputs: the Hermes final execution closure directive, the shared L4
brief, and C1–C4 of `reconciliation-135.md`. The commit containing this record
is the correction head; no live acceptance or permission to execute is implied.

| Finding | Disposition | Evidence / remaining requirement |
| --- | --- | --- |
| C1 | CLOSED_BY_NEW_HEAD (static) | The actual `shu261-review-findings.test.mjs` policy test calls `resolveCvtsudoers`, including its root-fixture validation, identity checks and inherited descriptor execution. Policy conversion uses that same open descriptor, with checks before/after conversion. A virtual filesystem exposes only `/usr/bin/cvtsudoers.ws`; the loaded real suite body passes. Restoring the hardcoded call dies at `SHU251_SUITE_PARSER_REQUIRED`. Real installed-parser execution was prohibited, not claimed. |
| C2 | CONFIRMED_BLOCKER | A value-free metadata collector and non-root UID/GID/groups binding exist. No actual host facts were measured. Namespace capability and sudo authority remain unprobed. Exact options below; no policy selected or changed. |
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

## C2 measured facts and bounded options

**Actual host measurements: none.** In particular, there is no measured target
caller UID/GID/groups; no measured target checkout/temp owner, mode or traversal;
no service-identity namespace result; no target AppArmor profile/sysctl state;
and no measured target sudo grant. Test values such as UID/GID 1234, mode 0755
and sysctl text `1` are synthetic fixtures, not observations.

`measureSuite` records the caller's UID/GID/groups; each checkout/temp ancestor's
owner/group/mode, directory/symlink status and service/other-worker traversal;
and these value-free kernel metadata paths:

- `/proc/sys/kernel/unprivileged_userns_clone`
- `/proc/sys/user/max_user_namespaces`
- `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`
- `/sys/module/apparmor/parameters/enabled`
- `/proc/self/attr/current`

Read errors remain explicit unavailable values. The measurement action does not
create a namespace or test sudo. Its namespace and sudo results are explicitly
`NOT_PROBED`. Existing preflight performs the service-identity namespace probe
`/usr/bin/unshare --user --map-root-user /bin/true`; exceptions remain named
refusals, never skips.

Source establishes these distinct privilege requirements:

1. Legacy preflight asks for `/usr/bin/sudo -n /usr/bin/id -u` → `0` and
   `/usr/bin/sudo -n /usr/bin/setpriv --reuid=65534 --regid=65534 --clear-groups /usr/bin/id -u`
   → `65534` when not root. These exact two probes do not establish authority to
   execute arbitrary worker commands.
2. `attempt-workspace.test.mjs` uses
   `sudo -n --preserve-env=PATH setpriv --reuid=65534 --regid=65534 --groups=<caller-gid>`
   followed by `id`, Git, Node, and fixture-scoped chmod/removal commands. Its four
   distinct-identity tests already have exact sanctioned skips.
3. `shu241-scoped-build.test.mjs` directly attempts
   `setpriv --reuid=65534 --regid=65534 --groups=0`; its two distinct-identity tests
   already have exact sanctioned skips. A sudo-id grant cannot make this direct
   non-root setpriv call succeed.

The bounded owner choices are:

- Keep the existing eight-entry skip contract; in a separately authorized window
  measure the listed metadata and execute only the exact preflight probes. If
  those probes already work, no policy change is required. If a grant is absent,
  any request must name the exact two id-probe argv above, not arbitrary sudo or
  setpriv. Namespace failure still blocks A12.
- Require the six distinct-identity tests to execute as well: first review a
  dedicated fixture-scoped worker helper and its fixed UID/GID/groups/commands.
  The current source does **not** support satisfying that demand with merely the
  two id probes or running the whole suite as root. No broader grant is proposed.
- If namespace creation is denied, wait for authorized host measurements and a
  profile-specific policy proposal, or explicitly defer A12's namespace proof
  (`SHU261_NO_SETENV_NAMESPACE_STARTUP`, preflight
  `SHU251_PREFLIGHT_USER_NAMESPACES`) as a named acceptance gap. There is no
  authorized namespace skip. An exact AppArmor/sysctl edit cannot responsibly be
  selected without the prohibited measurements; none is invented here.

The existing eight sanctioned name/reason pairs remain authoritative in
`PERMITTED_SKIPS`; namespace, Unix-socket, and systemd-prohibition skips are not
newly authorized. A scope reduction requires an explicit owner disposition,
not an agent-created skip allowance.

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
- No measured C2 host facts, live namespace/sudo proof, or selected host-policy change.
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
