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

The broker account and its private NSS primary group are named `shu71-evidence`.
The service runs with `Group=shu-workspace` for shared socket access. Existing names must
be unique, dedicated, non-login identities. New uid/gid values are selected
independently from resolved SYS_UID/SYS_GID ranges in `/etc/login.defs`, after
measuring both databases with fixed `getent` commands. Missing system minima
default to 100; missing system maxima default to the corresponding regular
minimum minus one (normally 999). Malformed, duplicate or inconsistent declarations
remain refusals. [Host-reality corrections and proofs](SHU71-HOST-REALITY.md)
cover executable symlinks, state ancestry and deferred arm-time artifacts. Occupied IDs are never
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

The broker service uses the existing `shu-workspace` primary group, which also
owns its runtime directory and socket. Provisioning does not modify the
coordinator's memberships; the gate requires its existing membership by name.
This expands the broker's read/traverse authority to group-accessible shared
files, including coordinator attempt worktrees. `ProtectSystem=strict` makes
that hierarchy read-only; `NoNewPrivileges`, `PrivateTmp` and the broker's two
fixed requests bound the expansion. It does not grant root identity, bypass
owner-only permissions, permit worktree writes through the service sandbox,
or expose arbitrary file reads, API requests, commands or credentials to clients.
See the [authority disclosure](SHU71-L3-CLOSURE.md#least-privilege-delivery),
[workspace layout](SHU-261-VALIDATION.md#L12) and
[operative unit render](shu71-production.mjs#L554). Real kernel socket access
must still be proved in the authorized window; the static report cannot prove it.
No running unit, remote ref, credential validity or live fixture launch is claimed here.

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
| SHU71 owner public key | `service/shu71-production.mjs:34–40,160`: root-owned private regular single-link file. provisioner@904fbed:286–289 retains the reviewed, stricter root:root 0600 and nonempty policy; production's privateRead alone does not mandate exact 0600 or GID 0. |
| `/etc/shu/keys/shu71-activation-ed25519.pem` | D1-a uses the **existing activation private key**. `service/shu71-production.mjs:34–40,255` reads a root-owned regular single-link file with `O_NOFOLLOW`, no group/other permission bits, at most 4 MiB; no exact owner-only mode or GID is required. `service/provision-shu71-prerequisites.mjs:312–316` checks this custody plus nonempty content and retained ancestor custody. No key material is created, copied, renamed, linked, relocated, or duplicated by provisioning. |
| Shared broker access | `service/SHU-261-VALIDATION.md:12` names `shu-workspace`; `service/shu71-production.mjs:480` renders `User=shu71-evidence`, `Group=shu-workspace`, `RuntimeDirectoryMode=0750`. `service/provision-shu71-prerequisites.mjs:138–146,338–355` resolves the shared group by name, measures coordinator membership with `id -Gn shu-coordinator`, and measures broker ownership/shared GID and separate exact directory/socket modes. `service/fixture-evidence-broker.mjs:31` creates the socket and chmods it to 0660. |
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


### Owner decisions D1-a and shared broker access

Production reads the already-provisioned activation key at
`/etc/shu/keys/shu71-activation-ed25519.pem`. The production change is a path
change; the provisioner never creates or duplicates key material. Its report
has exactly one key row, for that path. The owner public keys remain separate
approval authorities; neither is an activation signing authority.

The dedicated broker account remains `shu71-evidence`; its service primary
group is the existing named `shu-workspace`. No identity number is introduced
into the production render or new shared-access checks. The account's private
primary group in NSS and the existing allocation/collision policy are retained.
In particular, the previously reviewed reserved-996 refusal is unchanged;
removing it would violate the instruction to preserve F1. Other pre-existing
numeric assumptions outside these two decisions are not changed. Thus a literal
claim of “no hard-coded UID/GID anywhere in the tree” is not made.

The report measures NSS membership and on-disk unit/directory/socket metadata.
It refuses missing shared group (`ACT_BROKER_SHARED_GROUP`), missing membership
(`ACT_BROKER_COORDINATOR_ACCESS`), invalid dedicated/numeric unit identity
(`ACT_BROKER_UNIT_BINDING`), wrong socket custody
(`ACT_BROKER_SOCKET_CUSTODY`), widened socket mode (`ACT_BROKER_SOCKET_MODE`),
and widened runtime-directory mode (`ACT_BROKER_DIRECTORY_MODE`). Existing
`ACT_BROKER_MESSAGEBUS` and collision refusals remain intact. Unit content drift
continues to use `ACT_TREE_CONTENT`. Activation key failures use
`ACT_FILE_CUSTODY`, retained single-file custody and named measurement errors.

The first five new controls were run before changing production: 5 tests,
1 pass, 4 failures (activation path, key report/custody, coordinator connection,
shared-access measurements). Identical inputs then gave 5 passes. The SPKI
control already passed; owner-signature rejection and exact-unit rejection are
retained protections, not newly discovered production defects.

`service/test/shu71-owner-decisions.test.mjs` supplies named passing controls
and matching source-mutant kills:

| Claim / source mutation | Killing assertion |
| --- | --- |
| Runtime signer reads the activation path; restore the old path | `D1_ACTIVATION_PATH` |
| Both signed payloads verify using the ephemeral activation test key | `D1_ACTIVATION_SIGNATURE_POSITIVE` |
| Real committed public key and anchor fingerprint | `D1_COMMITTED_SPKI`, `D1_TRUST_ANCHOR` |
| C1-owner signed package / activation; delete final package validation | `D1_REJECT_C1_OWNER_PACKAGE`, `D1_REJECT_C1_OWNER_ACTIVATION` |
| Lifecycle-owner signed package / activation; delete final package validation | `D1_REJECT_LIFECYCLE_OWNER_PACKAGE`, `D1_REJECT_LIFECYCLE_OWNER_ACTIVATION` |
| Key report path mutation | `D1_KEY_ROW` |
| Delete key owner / permission / nonempty / single-link / no-follow guards | `D1_KEY_OWNER`, `D1_KEY_GROUP_OTHER_BITS`, `D1_KEY_NONEMPTY`, `D1_KEY_SINGLE_LINK`, `D1_KEY_NO_SYMLINK` |
| Render private broker group: coordinator connect changes to EACCES | `D1_COORDINATOR_ALLOWED` |
| Render unrelated user's group: its connect changes to CONNECTED | `D1_UNRELATED_DENIED` |
| Substitute messagebus / numeric User; remove named render guard | `D1_MESSAGEBUS_IDENTITY_REFUSED`, `D1_NUMERIC_IDENTITY_REFUSED` |
| Accept widened socket mode / runtime-directory mode independently | `D1_SOCKET_MODE`, `D1_RUNTIME_DIRECTORY_MODE` |
| Remove membership guard / resolve renamed group instead | `D1_SHARED_GROUP_MEMBERSHIP`, `D1_SHARED_GROUP_EXISTS_BY_NAME` |
| Ignore unit content mismatch | `D1_EXACT_UNIT` |
| Broker chmod source widened to 0666 | `D1_SOCKET_CREATED_0660` |
| Rendered directory mode widened to 0755 | `D1_RENDERED_DIRECTORY_MODE` |

The connection controls execute a Unix DAC model with directory search and
socket write checked independently using the fixture's named account database.
They show a behavioural result, not a render-string comparison, but are **not a
real kernel socket-access proof**. Directory/socket mode measurements use real
temporary-file modes; socket type, ownership, NSS, commands and APIs are doubled.
The production report performs real `lstat`, NSS and membership measurements when
run on a host; it has not been run there in this repository-only task.

The 27 new tests include 22 named source-mutant kills over passing controls.
Production still calls `validateShu71Package` after signing
(`service/shu71-production.mjs:264–270`); its signature checks load the fixed
committed public source (`shu71-activation-package.mjs:190–193`) and the
trust-anchor validation checks its fingerprint. These guards are retained.

The committed SPKI is independently measured as
`0cc5f24f46554bd25b713d78fca2f2bd48ab9b270d217a9dce613956d5786d5a`.
A fresh runtime signature against that committed public key remains **unproven**:
its private counterpart is not available to this repository-only run. The
positive signing control uses the existing ephemeral public-source test seam;
it must not be represented as a committed-key signature proof. Owner-role tests
use distinct generated test owner keys, not the host's owner private keys.
No on-host key, account, service, socket or API was accessed. Immutable historical
source fixtures retain their old path and hashes; the historical differential
harness derives its fixture key path from those bytes without altering them.


Owner-decision focused command (974 tests):

```sh
node --test .github/coordinator/service/test/provision*.test.mjs .github/coordinator/service/test/shu71-owner-decisions.test.mjs .github/coordinator/service/test/shu71-production.test.mjs .github/coordinator/service/test/shu71-trust*.test.mjs
```

Full coordinator + service command, with both TAP and the unchanged reviewed
reporter (set `run=plain` or `run=clock` for the output names):

```sh
run=plain
node --test --test-reporter=tap --test-reporter-destination="/tmp/shu71-d1-full-verified-$run.tap" --test-reporter=./.github/coordinator/service/host-suite-contract.mjs --test-reporter-destination="/tmp/shu71-d1-full-verified-$run.jsonl" .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
```

Both commands were run with `NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS` unset
for plain, and with the exact CI prefix
`SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs"`
for clock. Full-suite file selection is identical to `npm run test:coordinator`.
Earlier development runs exposed four historical fixture-input mismatches;
full development runs were stopped while those consumers were corrected.
The first completed full runs each reported 2,892 tests / 2,881 pass / 3 fail /
8 skip: two remaining historical fixture-input mismatches (subsequently fixed)
and the unchanged A12 guard reading the old committed inventory. Final counts
and commit/tree IDs are reported after validation against the new commit.

`PERMITTED_SKIPS` is byte-identical to
`24228e6e73f3ef08df60c2e0b38d570d70ec8e69`: 1,093 bytes including its final
newline; SHA-256 `03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
The entire `host-suite-contract.mjs` is also byte-identical, SHA-256
`2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`.
All existing file/name/requirement entries remain intact; 27 test names and one
test file are added. No historical fixtures, trust-anchor bytes, committed
public key, CI workflow or other source outside `.github/coordinator` changed.


### H1–H8 independent-verdict corrections

Before editing, a clean fixture with `/run` removed reproduced H1: `install()`
returned `VERIFIED`; the immediately following read-only `precondition()` failed
only `/run/shu71-evidence` and its `fixture.sock`, both with
`ACT_BROKER_SOCKET_CUSTODY`. Installation never creates those runtime artifacts.
Production starts the service during M4 and stops it at teardown
([start](shu71-production.mjs#L343), [stop](shu71-production.mjs#L505)).

The corrected gate evaluates runtime paths after **all** static checks. With
both absent and all static checks passing, both rows explicitly contain
`ok:true,runtime:"DEFERRED_UNTIL_SERVICE_START"`, with no measured UID/GID/mode. This is an
absence observation, not proof of systemd activity or a measured socket. With
both present, each must satisfy its existing type, ownership and exact mode
checks (0750 directory, 0660 socket), and passes as `runtime:"MEASURED"`.
A partial pair refuses with `ACT_BROKER_SOCKET_CUSTODY`. Static failures remain
named failures even when both runtime paths are absent; those runtime rows
also refuse, rather than claiming an eligible not-started state. The report is
a read-only snapshot, not protection against concurrent host state changes.

[`provision-runtime-state.test.mjs`](test/provision-runtime-state.test.mjs)
provides passing controls and 20 named assertion/mutant kills:

- `H1_NOT_STARTED`, `H1_EXPLICIT_RUNTIME_MARKER`, `H1_RUNNING_MEASURED`.
- `H2_{DIRECTORY,SOCKET}_{UID,GID}_CUSTODY`: stored fixture ownership changes
  really reach lstat, and deletion of the ownership predicate dies by name.
- `H1_{DIRECTORY,SOCKET}_WIDENED_MODE`, `H1_PARTIAL_RUNTIME`.
- `H1_ABSENT_STATIC_{UNIT,IDENTITY,GROUP,MEMBERSHIP,KEY,RECEIPT,TREE,CHECKOUT,REFS}`.
- `H1_ABSENT_RENDER`: invalid Group is refused and removing only the Group
  clause from the render guard dies behaviorally (H6), not by source anchoring.

The fixture stores runtime ownership in the same `owners` map as other paths;
it no longer synthesizes ownership from the expected account database (H2).
The socket type remains modeled. No real systemd or kernel socket proof is made.
H3/H4's stale key-path and numeric-identity statements are corrected in the
[reconciliation](ACTIVATION-WINDOW-RECONCILIATION.md) and
[closure](SHU71-L3-CLOSURE.md#least-privilege-delivery) documents. H5's primary-group
read expansion and mitigations are explicitly disclosed above.

Remaining limits: H7's `connect()` DAC model still hard-codes 0750/0660;
its connection result is not evidence about actual fixture modes. Separate
precondition tests measure modes and kill widened-mode mutants. H8's parent
`/etc/shu/keys` check allows 0755; documented 0700 is not enforced or proven.
The D1 signing path, signing authority and shared-group mechanism remain unchanged.
No target-host account, key, socket, service, API or committed-key runtime
signature was measured in this repository-only correction.

Correction validation before commit: focused plain and exact CI-clock commands
both passed 994 tests, zero failures/skips, one terminal `1..994` each. Initial
full worktree runs reached `A12_INVENTORY_AUDIT_FILES`: that guard compares the
committed HEAD's test-file set with the working audit, so adding a test requires
committing before its exact-head full run. This assertion remains unchanged;
final committed-head full counts and logs are reported separately.
`PERMITTED_SKIPS`, including its trailing newline, remains byte-identical to
18e346ce5ac255d32ad97bfecab0edaed1c86935: 1,093 bytes, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
All three inventories are additive only: one file and 20 names/requirements in
the suite inventory, one file in each file audit; zero removals or changed rows.

## Owner runtime ruling: pre-mint and window receipts

The pre-mint runtime-row schema is
[`shu71-runtime-row.schema.json`](shu71-runtime-row.schema.json). Only when both
runtime paths are absent and **every static row** succeeds, the two runtime rows
contain exactly `path`, `ok:true`, and
`runtime:"DEFERRED_UNTIL_SERVICE_START"`. This token is a deferral, not a passing
runtime measurement. No UID, GID or mode is attached. Any static failure produces
named refusal rows without that marker. Active paths require `runtime:"MEASURED"`
with exact directory 0750 and socket 0660, broker UID and shared-group GID;
partial presence, owner/group drift and widened or narrowed modes refuse.

Static checks retain the complete reviewed unit byte comparison and all prior
identity, membership, signing and custody checks. Additional named rows inspect
both the render and installed unit: `ACT_BROKER_UNIT_USER` (`shu71-evidence`),
`ACT_BROKER_UNIT_GROUP` (`shu-workspace`),
`ACT_BROKER_UNIT_RUNTIME_DIRECTORY` (`shu71-evidence`),
`ACT_BROKER_UNIT_DIRECTORY_MODE` (`0750`), `ACT_BROKER_UNIT_UMASK` (`0007`), and
`ACT_BROKER_UNIT_NUMERIC_IDENTITY`. `ACT_BROKER_SOCKET_CONTRACT` binds the installed,
revision-verified broker source to the reviewed 0660 chmod contract. The named
broker account and named shared group remain mandatory while inactive.
`OWNER_STATIC_*` assertions kill each named suppression over passing controls;
H1/H2 assertions continue to cover identity/group binding and all four gate states.

At M4, immediately after the reviewed `systemctl start shu71-evidence.service`
step, `measureBrokerRuntime` re-resolves the named broker/shared group and checks
the real directory/socket, their types, UID, GID and exact 0750/0660 modes. This
runs before every ready transition, activation write, gate enable and dispatch
start. There is no deferred window result. The journalled runtime step retries only
missing paths, up to 20 measurements separated by 50 ms, checking expiry each
time; every other refusal is immediate.
Failures use the following codes and the existing HALT/teardown path:

| Assertion / killing mutant | Refusal |
| --- | --- |
| `WINDOW_MISSING_DIRECTORY` | `ACT_RUNTIME_DIRECTORY_MISSING` |
| `WINDOW_MISSING_SOCKET` | `ACT_RUNTIME_SOCKET_MISSING` |
| `WINDOW_WRONG_OWNER` | `ACT_RUNTIME_OWNER` |
| `WINDOW_WRONG_GROUP` | `ACT_RUNTIME_GROUP` |
| `WINDOW_WIDENED_DIRECTORY` | `ACT_RUNTIME_DIRECTORY_MODE` |
| `WINDOW_WIDENED_SOCKET` | `ACT_RUNTIME_SOCKET_MODE` |
| `WINDOW_COORDINATOR_INACCESSIBLE` | `ACT_RUNTIME_COORDINATOR_ACCESS` |

The fixed `setpriv --reuid=shu-coordinator --regid=shu-coordinator --init-groups`
probe checks ancestor traversal (including `/` and `/run`), rejects ancestor
symlinks, and checks socket read/write permissions as the coordinator. Repository
fixtures execute the actual probe text against modeled DAC bits, owner identity,
and primary/supplementary group membership; the inaccessible case closes `/run`
while leaving both measured runtime artifacts correct. No real target-host
commands are invoked. ACL/MAC, live NSS, service startup timing and kernel socket
`connect()` acceptance remain host-only and unproven. Permission observations are
point-in-time checks, not immunity to a later host mutation.

On success the journal receives `BROKER_RUNTIME_MEASURED` with both exact rows,
`coordinator_access:"MEASURED_TRAVERSE_READ_WRITE"`, and
`kernel_connect:"HOST_ONLY_UNPROVEN"`. The private `broker-runtime.json` receipt is
also retained under the activation evidence directory. The cleanup archive derives
`broker_runtime` from the journal after the latest `RUN_ATTEMPT_STARTED` and
`BROKER_RUNTIME_CHECK_STARTED`; an attempt without a measurement archives null. `WINDOW_MEASURED_RECEIPT` checks the rows, ordering and
archive preservation and kills omission of the journal receipt. Existing crash
matrices cover the new receipt durability boundaries. D1 signing and H1–H8 guards
remain intact; the original eight permitted skips are unchanged.

Repository proof capture: run
`node .github/coordinator/service/test/fixtures/owner-runtime-evidence/capture.mjs`.
The committed [`proof.json`](test/fixtures/owner-runtime-evidence/proof.json)
contains actual fixture-produced reports for all four pre-mint states, seven
window HALT/REVOKED outcomes, and the passing journal/archive measurements.
The journal append-site/class inventories add `BROKER_RUNTIME_MEASURED`, including
both intact/recovered exhausted-invariant payload controls. The exact composition
count preserves the prior 116 operations and five identity reads, adding exactly
seven operations for three runtime probes and four journal/receipt writes and
renames, plus four journal writes for RUN_ATTEMPT_STARTED and the runtime step
INTENT, CHECK_STARTED and DONE. No earlier inventory entries or assertion IDs are removed.

Focused validation command:
`node --test .github/coordinator/service/test/provision*.test.mjs .github/coordinator/service/test/shu71-runtime-window.test.mjs .github/coordinator/service/test/shu71-production.test.mjs`.
Full validation command: `npm run test:coordinator`. CI clock validation prefixes
each with `SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS="--import=${GITHUB_WORKSPACE}/.github/coordinator/test/fixture/shift-wall-clock.mjs"`.
The committed-inventory audit requires the new files and inventory at `HEAD`;
therefore final full runs follow the new commit. Terminal TAP counts and the
final HEAD/tree are reported with the completion response.

## Independent-verdict closure

See [V1–V10 closure evidence](SHU71-VERDICT-CLOSURE.md) for the new controls,
static path traversal, explicit V5 justification and V9 generated-path exceptions.

### Target shadow and rollback compatibility

The first target install at `a3e40ca` exposed a rejected `-K CREATE_MAIL_SPOOL=no` override and unpruned `find /` process-fd races. Identity creation now requires effective `useradd -D` output `CREATE_MAIL_SPOOL=no` and uses `--system --no-create-home --no-log-init --uid <allocated> --gid <allocated> --home-dir /nonexistent --shell /usr/sbin/nologin shu71-evidence`, after creating its dedicated named private group. No home, mail spool or login-log initialization is permitted. Rollback prunes `/proc`, `/sys`, `/dev` from file enumeration while keeping the separate process guard and refusing all other enumeration errors. Failed install JSON preserves the original error and rollback outcome; failed recovery still exits 2 and retains evidence. [Exact measured commands, output and restored clean host state](SHU71-HOST-REALITY.md#first-real-target-installation-2026-09-19).
