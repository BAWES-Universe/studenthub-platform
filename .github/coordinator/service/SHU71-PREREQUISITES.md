# SHU-71 / SHU-251 prerequisite provisioning

Repository-only implementation. No target host was contacted. Do not interpret
fixture reports as host measurements, independent review, permission to mint,
or an M3/M4 result.

The closed CLI is:

```
node .github/coordinator/service/provision-shu71-prerequisites.mjs install <settled-40-character-revision>
node .github/coordinator/service/provision-shu71-prerequisites.mjs verify <settled-40-character-revision>
node .github/coordinator/service/provision-shu71-prerequisites.mjs rollback <settled-40-character-revision>
node .github/coordinator/service/provision-shu71-prerequisites.mjs precondition <settled-40-character-revision>
```

Run from the canonical deployment checkout, as root, in a separately authorized
host window. Install/rollback serialize on the existing `/etc/shu` directory
with fixed `/usr/bin/flock` and re-execute the fixed canonical checkout module.
No executable, path, identity, credential, URL, or environment option is accepted.
The SHA is the settled revision, not the original base: the revision must contain
this entrypoint. Git runs with the measured uid / primary gid of `shu-coordinator` and a fixed environment with
optional index locks disabled. No remote command is used.

`precondition` is read-only and emits `{ok, revision, paths:[{path,ok,...}]}`;
any failed row gives exit status 2. It measures Git blobs, installed files,
metadata, ancestors through `/`, identities, the exact rendered unit, secrets'
custody (never their contents in the report), checkout cleanliness, state
directories and both local lane refs. It invokes the existing two-candidate
parser resolver with an stdin fixture, avoiding a temporary directory. The
accepted parser is inode-pinned and reported, not assumed to be `/usr/bin/cvtsudoers`.
Git/parser/database errors refuse. This is a prerequisite report, not a claim
that remote lane heads, credentials or live service behavior have been proved.

The installed coordinator tree must be complete, have exact Git file modes,
root:root files, one link, no symlinks and no writable ancestors. An existing
partial, extra or stale tree is refused before installation. Existing exact
files are adopted without rewriting. The wrapper and exactly
`/etc/sudoers.d/shu-reviewer` are captured before replacement, including bytes,
mode, uid and gid. `/etc/sudoers.d/shu-reviewer-sandbox` and unrelated `*.shu-*`
files are deliberately untouched: their deletion is outside this reviewed
entrypoint's effects. Consequently their separate sudo authorization remains
an external policy question; installing this file does not revoke other rules.

The broker user and group are both named `shu71-evidence`. Existing names must
be unique, dedicated, non-login identities. New uid/gid values are selected
independently from explicit SYS_UID/SYS_GID ranges in `/etc/login.defs`, after
measuring both databases with fixed `getent` commands. Occupied IDs are never
selected; uid 996 is forbidden even if otherwise available. An alias to
messagebus is refused. No unrelated account is modified or added to a group.
Actual uid/gid are in the durable receipt and stdout result. The renderer's
only changes are User and Group; the exact unit assertion is retained and named.

`/etc/shu/shu71-prerequisites.json` is the root:root 0600 write-ahead receipt.
Each effect and its exact prior state is persisted and fsynced before execution.
Atomic file replacements use the reserved suffix `.shu71-pending`. Re-entry
rolls back an unfinished receipt; a VERIFIED receipt is measured and adopted.
Explicit rollback replays in reverse, refuses unrelated file/database drift,
and removes only recorded new paths. Account database files, their backups,
and `.pwd.lock` have prior-state capture. User creation disables home, mail and
login-log creation. Deletion is refused if the uid/gid is still used by files
or process credentials; filesystem enumeration errors also refuse deletion.
Successful rollback checks restoration and removes the receipt and staging
files. Failed recovery retains evidence and returns a refusal; it must not be
reported as a successful rollback or mint precondition.

## Evidence and limits

The tests map all host paths into temporary roots and replace every executable
boundary. No new test invokes a real parser, systemd, identity utility or target
path. Existing `PERMITTED_SKIPS` is byte-for-byte unchanged. New inventory rows
have no external tool capabilities because all command boundaries are doubles.

The crash matrix covers before/after every observable forward and rollback
boundary, including journal writes, syncs, renames and account commands. It
models process replacement at command boundaries, not termination *inside*
useradd/groupadd/userdel/groupdel, torn kernel writes, disk corruption, hostile
concurrent root changes, NSS enumeration omissions, distribution-specific
account hooks, or real power-loss durability. Those remain unproven. The parser's
stdin behavior is exercised through its boundary double; live cvtsudoers.ws
acceptance remains to be measured in the authorized host window.

Changing the broker's group also changes the group owning its runtime directory
and socket. This patch does not grant the coordinator membership in the new
group or prove that the coordinator can connect to the broker socket. That
integration must be independently resolved/proved before M4; the static
precondition report alone does not establish socket access. No running unit,
remote ref, credential validity or live fixture launch is claimed here.

## Named mutation reproduction

Run:

```
node --test .github/coordinator/service/test/provision-prerequisites-mutations.test.mjs
```

Every case first passes its unmutated control, then imports a source-modified
module and requires its named assertion to fail. A syntax/import error does not
count as a kill.

| Name | Source mutant | Named killing assertion |
| --- | --- | --- |
| missing tree file | accept absent file | SHU71_KILL_MISSING_TREE_FILE |
| stale tree file | remove blob/content equality | SHU71_KILL_STALE_TREE_FILE |
| wrong tree ownership | remove owner equality | SHU71_KILL_WRONG_TREE_OWNERSHIP |
| wrong tree mode | remove mode equality | SHU71_KILL_WRONG_TREE_MODE |
| wrong sudoers path | accept absent exact sudoers path | SHU71_KILL_WRONG_SUDOERS_PATH |
| wrong sudoers mode | bypass sudoers mode equality | SHU71_KILL_WRONG_SUDOERS_MODE |
| wrong sudoers content | bypass sudoers content equality | SHU71_KILL_WRONG_SUDOERS_CONTENT |
| parser failure | convert accepted-candidate rejection to success | SHU71_KILL_PARSER_FAILURE |
| wrapper drift | bypass wrapper verification | SHU71_KILL_WRAPPER_DRIFT |
| UID collision | remove duplicate UID check | SHU71_KILL_UID_COLLISION |
| GID collision | remove duplicate GID check | SHU71_KILL_GID_COLLISION |
| messagebus substitution | remove explicit uid 996 prohibition | SHU71_KILL_MESSAGEBUS_SUBSTITUTION |
| hard-coded numeric identity | render User=996 and Group=999 | SHU71_KILL_NUMERIC_RENDER |
| partial installation | omit exception-path rollback | SHU71_KILL_PARTIAL_INSTALLATION |
| rollback residue | retain completed receipt | SHU71_KILL_ROLLBACK_RESIDUE |

## Repository validation results

Executed against implementation commit `f5b8f1d0a23b9b9d33906f0e54e9ccbb33b7e697`; the final amendment adds only this results section.

| Run | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Focused plain | 144 | 144 | 0 | 0 |
| Focused CI clock | 144 | 144 | 0 | 0 |
| Full plain (serialized rerun) | 2837 | 2829 | 0 | 8 |
| Full CI clock | 2837 | 2829 | 0 | 8 |

The 15 source-mutant controls and all 15 named kills pass. The new crash matrices pass 272 forward and 88 rollback interruption injections. `PERMITTED_SKIPS` was compared directly with the base declaration and is byte-identical.

Exact focused command (run plain, then with the clock environment below):

```sh
node --test .github/coordinator/service/test/provision-prerequisites-mutations.test.mjs .github/coordinator/service/test/provision-shu71-prerequisites.test.mjs .github/coordinator/service/test/host-suite-contract.test.mjs .github/coordinator/service/test/shu71-delivery.test.mjs .github/coordinator/service/test/shu71-production.test.mjs .github/coordinator/service/test/shu71-production-mutations.test.mjs
```

Exact full commands:

```sh
npm run test:coordinator
SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs" npm run test:coordinator
```

The clock environment is the exact expanded CI setting: 31,536,000,000 ms and its `shift-wall-clock.mjs` import. The npm script executes `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`.

A previous plain run overlapping the clock run had 2,837 tests / 2,827 pass / 2 fail / 8 skip. Its failures were `SHU-71 isolation: dead worker permits later unit` and the recursive inventory guard, whose child failed `SHU-71 responsiveness: reconcile returns during executing child`. Both unchanged tests passed the following isolated control (2/2, zero failures/skips), followed by the successful full plain rerun above. No assertion, timeout or skip was relaxed. Resource contention is a possible explanation, not an independently proved cause.

```sh
node --test --test-name-pattern='SHU-71 (isolation: dead worker permits later unit|responsiveness: reconcile returns during executing child)' .github/coordinator/test/shu71-battery.test.mjs
```

## Review corrections: X1, X2, F1–F6

An interrupted `install` now returns `{ok:false,state:"ROLLED_BACK",
code:"ACT_PREREQUISITE_INSTALL_RECOVERED",revision}` and exits 2 after exact
restoration. Re-run `install` to provision; only VERIFIED or verified ADOPTED
installation is success. Explicit `rollback` still succeeds with ROLLED_BACK.
The outer CLI propagates the locked child's exit 2 without adding a second JSON
report. Its injectable runner is an import-only test seam, not a CLI option.

Each failed precondition row preserves an existing `ACT_*`/`SHU251_*` code.
Absent syscall paths become `ACT_PREREQUISITE_PATH_MISSING`; other unclassified
measurement failures become `ACT_PREREQUISITE_MEASUREMENT`; errors without a code
retain `ACT_PREREQUISITE_MISSING`. Missing named service
users or groups give `ACT_SERVICE_IDENTITY_MISSING`; inconsistent primary group
measurements give `ACT_SERVICE_IDENTITY`. No raw errno is reported as a row code.

### Precondition requirement audit

Sources below are relative to `.github/coordinator/`. `provisioner@904fbed`
means the independently reviewed original
`service/provision-shu71-prerequisites.mjs` at that revision; those citations
identify retained provisioning policy, not claims that production mandates a
stricter predicate. Root UID/GID 0 is explicit reviewed custody policy, not an
inferred service identity. All non-root service UID/GID values now come from
`getent passwd` and `getent group` by the name `shu-coordinator`; missing names
refuse. No numeric 999/982 service assumption remains in this entrypoint.

| Report row | Reviewed source and retained requirement |
| --- | --- |
| Deployment checkout | `service/host-suite-contract.mjs:35,152`: service UID owns checkout; child running as measured service UID/primary GID reads/traverses the entire checkout and rejects symlinks. No checkout GID or mode restriction. `service/host-lifecycle.mjs:58` and provisioner@904fbed:54–55 bind clean HEAD to the requested revision. Service user/group names: `service/README.md:28`, `service/SHU-261-VALIDATION.md:10`. |
| Every installed non-test tree file, and whole-tree inventory | `service/shu71-production.mjs:115–139`: Git blob, root custody, single regular file, no symlinks, non-writable ancestors. provisioner@904fbed:53–99 additionally pins exact Git modes, root GID, no extra files, and no pending residue. |
| `/etc/sudoers.d/shu-reviewer` | provisioner@904fbed:12,71,76–85: exact reviewed policy bytes, root:root 0440; existing named sudoers refusal codes retained. |
| Reviewer wrapper | provisioner@904fbed:12,72,76–85: exact reviewed wrapper blob, root:root 0755, custody and drift refusal. |
| Evidence unit | `service/shu71-production.mjs:480`: exact named-identity render; provisioner@904fbed:73,76–85 pins root:root 0644. |
| Sudoers parser | `service/host-suite-contract.mjs:52–115`: measured two-candidate, inode-pinned resolver and policy parse. provisioner@904fbed:132–135 maps rejection to `SHU251_SUDOERS_PARSER`. |
| Broker identity | provisioner@904fbed:101–131: measured named dedicated identity, collision and messagebus prohibitions, SYS-range allocation and named render binding. |
| Receipt | provisioner@904fbed:151–170,280–285: root:root 0600, VERIFIED, exact revision and measured broker, no pending replacement. |
| `/etc/shu/approvals/owner.pub` | `service/production-lifecycle.mjs:158–162`: root:root 0644 regular public key; provisioner@904fbed:44–52,286–291 retains ancestor custody and nonempty-file checks. |
| SHU71 owner public key and signing private key | `service/shu71-production.mjs:34–40,160,255`: root-owned private regular single-link files. provisioner@904fbed:286–289 retains the reviewed, stricter root:root 0600 and nonempty policy; production's privateRead alone does not mandate exact 0600 or GID 0. |
| Supervisor and coordinator environment files | `service/host-lifecycle.mjs:48–49` and `service/shu71-production.mjs:228–237`: root:root 0600 supervisor file, measured service UID/primary GID 0600 coordinator file; single regular file and custody checks retained. |
| Approvals, keys, evidence root directories | provisioner@904fbed:37–43,291: root:root, directory, no symlinks, no group/world writes, ancestor custody. Production custody primitives: `service/production-lifecycle.mjs:35–49`, `service/shu71-production.mjs:43–46`. Exact root GID remains provisioning policy. |
| Workspace state and supervisor state | `service/host-lifecycle.mjs:54–56`: service identity UID/GID, directory, 0700; provisioner@904fbed:292–296 retains parent custody and non-symlink checks. UID/GID now measured by name. |
| `/srv/shu/worktrees` | `service/shu71-production.mjs:328–330`: directory, non-symlink, exactly 03770; **no UID/GID requirement**. `service/SHU-261-VALIDATION.md:12` documents shu-workspace governance. Ownership is reported, not constrained. The fixture uses real host shape 999:980 / 03770. |
| Both local lane refs | `service/shu71-production.mjs:141–149` binds local commits; provisioner@904fbed:298–300 checks existence as commit refs for SHU-140 and SHU-254. This static report does not prove remote equality. |

### Reproduction and named kills

Before changing implementation, the seven regression controls produced 7 tests,
2 passes and 5 failures, by `SHU71_WORKTREES_REAL_SHAPE`,
`SHU71_CHECKOUT_GROUP_INDEPENDENT`, `SHU71_ABSENT_ROW_CODE`,
`SHU71_INSTALL_RECOVERY_NOT_SUCCESS`, and `SHU71_PATH_NEUTRAL_COMMANDS`.
The identical inputs pass after the corrections. F1/F2/F3 are coverage defects:
seven independent old-source mutants (occupancy, free 996, pre-useradd collision,
three destination paths, and test exclusion) each survived the original 19-test
provisioning suite, 19 passes / 0 failures. No claim is made that this rerun
repeated the verifier's entire-suite mutant experiment.

The new `service/test/provision-review-regressions.test.mjs` runs every mutant
below over a passing unmodified control, requiring `ERR_ASSERTION` containing
the named label. Import errors, unexpected runtime exceptions and syntax errors
do not count as kills. Existing mutation tests and assertions remain intact.

| Item / mutant | Named killing assertion |
| --- | --- |
| X1 reintroduce service GID on worktrees | SHU71_WORKTREES_REAL_SHAPE |
| X1 bypass 03770 | SHU71_WORKTREES_MODE |
| X2 reintroduce checkout group equality | SHU71_CHECKOUT_GROUP_INDEPENDENT |
| X2 bypass service traversal/read check | SHU71_CHECKOUT_READABILITY |
| X2 swap measured service group name | SHU71_SERVICE_GROUP_REQUIRED |
| F1 ignore occupied IDs | SHU71_ALLOCATOR_OCCUPIED |
| F1 allow free 996 | SHU71_ALLOCATOR_FREE_996 |
| F1 delete immediate pre-useradd collision guard | SHU71_PRE_USERADD_COLLISION |
| F1 delete messagebus/996 identity prohibition | SHU71_MESSAGEBUS_PROHIBITION |
| F2 typo each of sudoers, wrapper, tree | SHU71_LITERAL_SUDOERS / SHU71_LITERAL_WRAPPER / SHU71_LITERAL_TREE |
| F3 install test files | SHU71_EXCLUDE_TEST_FILES |
| F4 leak ENOENT | SHU71_ABSENT_ROW_CODE |
| F5 return ok:true after recovery | SHU71_INSTALL_RECOVERY_NOT_SUCCESS |
| F5 return exit 0 after recovery | SHU71_INSTALL_RECOVERY_EXIT |
| F6 restore author's absolute path | SHU71_PATH_NEUTRAL_COMMANDS |

Allocator controls require the lowest free UID and GID, including occupation
through users' primary groups; receipt, result, measured identity and named unit
render must agree. A second control makes 996 free and first in both SYS ranges.
The immediate collision control inserts a conflicting measurement only after
the write-ahead identity effect is recorded, and requires refusal before any
account creation command. The messagebus control removes duplicate-UID overlap
so only the 996 prohibition can kill that mutant.

Additional named controls cover service IDs 1201:1202, missing service group,
checkout symlink/wrong owner, absent file/directory/identity row codes, planted
test-file refusal as ACT_TREE_EXTRA, literal installedModule agreement, and a
real repository-only Node child exiting 2 with the rollback-only JSON result.


Exact correction-focused command (172 tests; run plain and with the CI clock):

```sh
node --test .github/coordinator/service/test/provision-review-regressions.test.mjs .github/coordinator/service/test/provision-prerequisites-mutations.test.mjs .github/coordinator/service/test/provision-shu71-prerequisites.test.mjs .github/coordinator/service/test/host-suite-contract.test.mjs .github/coordinator/service/test/shu71-delivery.test.mjs .github/coordinator/service/test/shu71-production.test.mjs .github/coordinator/service/test/shu71-production-mutations.test.mjs
```

The full command remains `npm run test:coordinator`, which includes both
coordinator and service suites. For either command, the exact CI clock prefix is
`SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs"`.
Run from the repository root. The earlier 144/2837 results above describe the
original reviewed commit; correction-run counts and final commit/tree IDs are
reported separately after running against the committed correction.
