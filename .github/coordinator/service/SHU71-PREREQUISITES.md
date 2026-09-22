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
[operative unit render](shu71-production.mjs#L1598). Real kernel socket access
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
| Deployment checkout | `service/host-suite-contract.mjs:35,152`: service UID owns checkout; child running as measured service UID/primary GID reads/traverses the entire checkout ~~and rejects symlinks~~. **Corrected 2026-09-19 (real prepared host):** the blanket symlink rejection was unsatisfiable for any prepared deployment, because the checkout *is* the live npm workspace: 19 in-tree symlinks under `node_modules` (`@studenthub/*`, `@bawes/actor-assertion`, nine `.bin` entries), **zero escapes**, **0 unreadable entries** measured as `shu-coordinator`, checkout `999:982 755`, every ancestor root-owned, non-symlink and non-writable. The retained capability is therefore escape prevention, not a symlink ban: the whole-tree read/traverse proof as the measured service identity is unchanged, every symlink must resolve as a complete chain (link text and real path) inside the checkout root, and the row reports the symlink census. Named refusals: `ACT_PREREQUISITE_CHECKOUT_SYMLINK_ESCAPE` (target outside the root), `ACT_PREREQUISITE_CHECKOUT_SYMLINK_UNRESOLVED` (dangling link or cycle), `ACT_PREREQUISITE_CHECKOUT_SYMLINK_WRITABLE` (group/world-writable target), `ACT_PREREQUISITE_CHECKOUT_ANCESTOR` (symlinked or writable checkout ancestor), `ACT_PREREQUISITE_CHECKOUT_ACCESS` (unreadable or untraversable entry). No checkout GID or mode restriction. `service/host-lifecycle.mjs:58` and provisioner@904fbed:54–55 bind clean HEAD to the requested revision. Service user/group names: `service/README.md:28`, `service/SHU-261-VALIDATION.md:10`. |
| Fixed production dependencies (`/usr/bin/{node,systemctl,flock,env,find}`, `/usr/sbin/{useradd,groupadd,userdel,groupdel,nologin}`) | Measured only; never installed, executed or modified by this entrypoint. Each must be a regular file (never a directory, fifo, socket or device) opened `O_NOFOLLOW`, `root:root`, exactly `0755`, non-empty, with no group/world write on it or on any component of its chain, plus the unchanged `/usr/bin/env` chain validation (permitted link destination `../lib/cargo/bin/coreutils/env`, exact resolved target `/usr/lib/cargo/bin/coreutils/env`, root-owned link, root-owned non-writable ancestors). **Corrected 2026-09-19 (real prepared host):** the single-link (`nlink === 1`) rule is custody for the files this provisioner *installs* and stays enforced for every one of them (tree files, `/etc/sudoers.d/shu-reviewer`, the wrapper, the evidence unit, the receipt); it was never a property of a pre-existing system binary. The measured target is cargo's multicall coreutils inode with **nlink = 115** (`/usr/lib/cargo/bin/coreutils/*` and `/usr/bin/coreutils` are the same inode), so applying the install-time rule here made `ACT_PREREQUISITE_CUSTODY` unsatisfiable on the real host. Nothing else in the row was relaxed. |
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
| Supervisor and coordinator environment files | `service/host-lifecycle.mjs:48–49` and `service/shu71-production.mjs:228–237`: root:root 0600 supervisor file, measured service UID/primary GID 0600 coordinator file; single regular file and custody checks retained. **Corrected 2026-09-19 (approved window `shu71-mint-00000017`):** custody alone was checked, so the gate passed while `/srv/shu/coordinator.env` was missing the documented reviewer wrapper key `SHU_REVIEW_MODEL_WRAPPER_JSON` (`docs/SHU-63-activation-contract.md:98`), and the refusal was only reached at arming. The row `/srv/shu/coordinator.env#adapter-keys` now applies the reviewed arm-time parser (`units.mjs` `adapterLaunchEnvironment` → `environmentEntries` / `requireSupervisorAdapterEntries`, the same rules `assertSupervisorLaunchEnvironment` applies) to the same file under the same custody, and reports `adapter_keys: 9`. Named refusals: `ACT_PREREQUISITE_ADAPTER_ENV_REQUIRED` (a documented key is absent; the row carries `key` and `parser_code: SHU71_SUPERVISOR_ENV_REQUIRED`), `ACT_PREREQUISITE_ADAPTER_ENV_CONTENT` (duplicate assignment or ambiguous/empty/dollar/continuation value; `parser_code: SHU251_ENV_CONTENT`), `ACT_PREREQUISITE_CUSTODY` (not the measured service UID/primary GID at exactly 0600). The host value form `SHU_REVIEW_MODEL_WRAPPER_JSON='["/usr/bin/sudo","-n","/usr/local/libexec/shu-reviewer-sandbox"]'` is **accepted**; the key has since been added to the host through a separate bounded receipted host-preparation step. No value is ever reported, only key names. |
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
([start](shu71-production.mjs#L885), [stop](shu71-production.mjs#L1529)).

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

### Real checkout shape and measured-executable custody

The first real `precondition` run after a successful install refused two rows:
`/srv/shu/studenthub-platform` (`ACT_PREREQUISITE_CHECKOUT_ACCESS`) and
`/usr/bin/env` (`ACT_PREREQUISITE_CUSTODY`). Both predicates could only hold in a
fixture. The checkout row now proves escape prevention over the live npm
workspace and reports its symlink census; the executable rows keep every
custody requirement except the installed-file single-link rule, which remains
enforced for every file this entrypoint writes. An absent runtime row that
mirrors another row's refusal now also carries `mirrored_code` and
`mirrored_from`; a direct refusal carries neither, and the refusal and exit 2
are unchanged. [Measured facts, named controls and killing
mutants](SHU71-HOST-REALITY.md#second-real-target-precondition-2026-09-19).

### Target shadow and rollback compatibility

The first target install at `a3e40ca` exposed a rejected `-K CREATE_MAIL_SPOOL=no` override and unpruned `find /` process-fd races. Identity creation now requires effective `useradd -D` output `CREATE_MAIL_SPOOL=no` and uses `--system --no-create-home --no-log-init --uid <allocated> --gid <allocated> --home-dir /nonexistent --shell /usr/sbin/nologin shu71-evidence`, after creating its dedicated named private group. No home, mail spool or login-log initialization is permitted. Rollback prunes `/proc`, `/sys`, `/dev` from file enumeration while keeping the separate process guard and refusing all other enumeration errors. Failed install JSON preserves the original error and rollback outcome; failed recovery still exits 2 and retains evidence. [Exact measured commands, output and restored clean host state](SHU71-HOST-REALITY.md#first-real-target-installation-2026-09-19).

### SHU-71 idempotent, receipt-aware teardown (approved window `shu71-mint-00000017`)

Measured on the real target host during the owner-approved window, at the
merged revision, before this correction. The arming attempt refused **by name**
before the supervisor was started, before the expiry timer was installed and
before arming:

```json
{"ok":false,"state":"HALT","code":"SHU71_SUPERVISOR_ENV_REQUIRED",
 "teardown":{"ok":false,"state":"HALT","code":"ACT_CLEANUP_FAILED",
   "failures":["ACT_TEARDOWN_WORKERS","ACT_TEARDOWN_FIXTURES","ACT_TEARDOWN_EXPIRY_TIMER"]}}
```

The refusal itself is correct: `/srv/shu/coordinator.env` carried no
`SHU_REVIEW_MODEL_WRAPPER_JSON`, the documented reviewer wrapper key whose value
is documented at `docs/SHU-63-activation-contract.md:98`. **That key is now
present on the host**, added through a separate bounded receipted
host-preparation step, with the value
`["/usr/bin/sudo","-n","/usr/local/libexec/shu-reviewer-sandbox"]`, quoted as
`'["/usr/bin/sudo","-n","/usr/local/libexec/shu-reviewer-sandbox"]'`.

The defect is what happened next. Measured on the host at that moment:

| Measured fact | Consequence |
| --- | --- |
| `systemctl kill --kill-whom=all --signal=SIGKILL shu-supervisor.service` → **rc=1** (the unit was never started; it is `inactive`) | `teardown:workers` failed, which fails the whole step |
| `systemctl disable --now shu71-expiry-shu71-mint-00000017.timer` → **rc=1** (the unit file was never created) | `teardown:expiry-timer` failed |
| `teardown:fixtures` requires `teardown:workers` DONE | failed as a consequence (`ACT_FIXTURE_CLEANUP`) |
| The journal recorded `TEARDOWN_INCOMPLETE` | any later `run`/`resume` at that revision routed straight back into cleanup and failed identically: the activation id could never be released |

The episode was retired by hand (owner decision) and **must never be reused**.

The corrected teardown derives non-creation from the durable journal only.
`lifecyclePhase(journal, step)` answers `never` **only** when the journal is not
a recovered log, records this episode's own forward attempt
(`RUN_ATTEMPT_STARTED`), holds no `ARMED`, and holds neither `INTENT` nor `DONE`
for the step that creates the resource (`gate` starts the supervisor unit;
`expiry-watch` installs the timer). Every other journal state, including a
destroyed or damaged log, is `inconclusive` and takes the fail-closed path.

* `teardown:workers` — where the journal proves the supervisor was never
  started, the kill is not issued and the unit must be measured idle; a unit
  that is present or running there is drift and halts by the existing named
  `ACT_TEARDOWN_DRIFT`. Otherwise the kill is issued exactly as before, and its
  refusal is accepted only when the command failed (`ACT_COMMAND_FAILED`) *and*
  the unit is measured `inactive`/`failed` — the obligation this step exists to
  establish. A stop this same teardown already ordered is measured before
  signalling again, so re-runs cost the same single operation.
* `teardown:expiry-timer` — where the journal proves the timer was never
  installed, `disable --now` is not issued and both `shu71-expiry-<id>.service`
  and `shu71-expiry-<id>.timer` must be absent, the timer inactive and its
  `UnitFileState` empty; anything present, enabled or active there halts by
  `ACT_TEARDOWN_DRIFT`. A durably installed timer is measured before and after
  the command, and the retirement removes both unit files; see
  [expiry retirement drift](#shu-71-expiry-retirement-drift) for the correction
  that made that true.
* `teardown:fixtures` is no longer blocked, because `teardown:workers` now
  reaches its `DONE` row. Every safety check it performs is unchanged: worktree
  root mode `03770`, episode-bound attempt ids only, inode receipts
  (`FIXTURE_REMOVE_INTENT`), no symlink following and no crossing mounts.
* The gate and activation-file disarm steps remain unconditional and
  idempotent. No path leaves dispatch enabled.
* Cleanup is re-runnable: the second run returns `REVOKED` and the whole
  disposable tree is byte-identical to the settled state.

The refusal now also names the key: the result and the durable `HALTED` row both
carry `missing_key`. Key names are public contract vocabulary; no value is
reported.

| Named control | Proves |
| --- | --- |
| `B4_PREARM_NAMED_REFUSAL`, `B4_PREARM_REFUSAL_NAMES_KEY`, `B4_PREARM_REFUSAL_DURABLE_KEY` | refusal by name, naming the missing key, durably |
| `B4_PREARM_TEARDOWN_COMPLETE`, `B4_PREARM_TEARDOWN_NO_FAILURES`, `B4_PREARM_TEARDOWN_REVOKED`, `B4_PREARM_TEARDOWN_RECEIPT_DURABLE` | the teardown completes and its receipt is durable |
| `B4_PREARM_TEARDOWN_STEP_WORKERS/FIXTURES/EXPIRY-TIMER` | each of the three measured failures now reaches `DONE` |
| `B4_PREARM_NO_UNIT_STARTED`, `B4_PREARM_NO_UNIT_ENABLED`, `B4_PREARM_NO_START_OR_KILL_COMMAND`, `B4_PREARM_NO_EXPIRY_TIMER`, `B4_PREARM_NO_ACTIVATION_FILE` | no unit started, no timer created, no activation file |
| `B4_PREARM_NO_WORKTREE`, `B4_PREARM_NO_WORKSPACE`, `B4_PREARM_NO_FIXTURE_MUTATION`, `B4_PREARM_FIXTURES_PRIOR_STATE` | no worker/worktree/workspace created; fixtures in their prior state |
| `B4_PREARM_DISPATCH_OFF`, `B4_PREARM_ACTIVATION_ID_RELEASED` | dispatch off at every layer; the activation id is released |
| `B4_PREARM_SECOND_CLEANUP_OK/REVOKED/INERT/NO_WRITES/NO_TIMER/NO_UNIT` | cleanup run twice succeeds and creates or deletes nothing new |
| `B4_PREARM_EVERY_KEY_<KEY>` | all nine documented adapter keys behave identically |
| `B4_PREARM_FIXTURE_STEP_NOT_BLOCKED`, `B4_PREARM_FIXTURE_INODE_RECEIPT`, `B4_PREARM_FIXTURE_REMOVED`, `B4_PREARM_FIXTURE_AUTHORITY_RETAINED`, `B4_PREARM_FIXTURE_UNRELATED_RETAINED` | fixtures still cleans its episode-bound attempt and preserves everything else |
| `B4_PREARM_DRIFT_REFUSED_*`, `B4_PREARM_DRIFT_FAILURE_*`, `B4_PREARM_DRIFT_NO_COMPLETION_*`, `B4_PREARM_DRIFT_NO_KILL_*`, `B4_PREARM_DRIFT_NO_RETIREMENT_*`, `B4_PREARM_DRIFT_DISPATCH_OFF_*` | a running unit, an existing timer file, an active timer and an enabled timer each halt by name |
| `B4_KILL_FAILURE_NOT_ACCEPTED`, `B4_KILL_FAILURE_NAMED`, `B4_KILL_FAILURE_NO_COMPLETION`, `B4_KILL_FAILURE_RECOVERED` | a kill refused for any other reason stays a failure |
| `B4_DESTROYED_JOURNAL_NOT_PROOF`, `B4_DESTROYED_JOURNAL_FAIL_CLOSED_KILL`, `B4_DESTROYED_JOURNAL_CREDENTIAL_REVOKED` | a journal that cannot prove non-creation takes the fail-closed path |
| `B4_PHASE_<phase>_INTERRUPTED/NAMED_OUTCOME/DISPATCH_OFF/CREDENTIAL_REVOKED/REVOKED/RECEIPT/RELEASED/IDEMPOTENT/IDEMPOTENT_INERT` | interruption before arming, after arming, before and after supervisor start, before and after expiry installation, and mid-teardown |

The seven phase-boundary interruptions reuse the existing process-replacement
fault injection and the recovery fixtures; all seven recoveries complete
cleanup (`REVOKED`), none wedges, and none leaves dispatch enabled.

| Named killing mutant | Control that kills it |
| --- | --- |
| `B1/B4 mutation: pre-arm worker drift silently accepted` | `B4_PREARM_DRIFT_*` (supervisor) |
| `B1/B4 mutation: refused worker kill blindly accepted` | `B4_KILL_FAILURE_*` |
| `B1/B4 mutation: pre-arm expiry drift silently accepted` | `B4_PREARM_DRIFT_*` (timer-file) |
| `B1/B4 mutation: expiry retirement ignores unit liveness` | `B4_PREARM_DRIFT_*` (timer-active) |
| `B1/B4 mutation: non-creation inferred from an empty journal` | `B4_DESTROYED_JOURNAL_NOT_PROOF` |
| `HOST_KILL_ADAPTER_ENV_PARSER` | `HOST_ADAPTER_ENV_MISSING` |
| `HOST_KILL_ADAPTER_ENV_CONTENT_CLASS` | `HOST_ADAPTER_ENV_DUPLICATE` |
| `HOST_KILL_ADAPTER_ENV_CUSTODY` | `HOST_ADAPTER_ENV_CUSTODY` |

The existing `worker kill omitted` and `P1 retirement re-observation removed`
mutants keep their names and assertions; only their source anchors moved with
the two extracted helpers. `PHASE_*_TEARDOWN_WORKERS` is corrected in place: the
same named assertion now requires the stronger pair — the step reaches its
durable `DONE` row and issues no kill for a unit this episode never started —
with the idle measurement asserted immediately below it, as it always was.

The disposable production fixture models the two measured `systemctl` refusals:
`kill` exits 1 for a unit this episode never started, and `enable`/`disable`
exit 1 for a unit whose file was never created. The stricter reading of the kill
refusal — any unit that currently holds no processes — was **not** measured
during the window; `systemd.killRequiresProcesses` opts into it explicitly, and
the production fix is correct under either reading. `stop` is deliberately not
modelled that way: every unit this teardown stops is installed on the host.

#### Validation of the idempotent-teardown correction

Tested implementation `62832ac2ed6603ca99046f5536dc0db43441516e`, tree
`f7bded590d288275963d69155dd490c4be190440`. All four commands ran from the
repository root under the CI-like harness: UID 1000, `umask 0022`, target
accounts absent (`shu-coordinator`, `shu-supervisor`, `shu71-evidence`,
`shu-workspace`, `shu-reviewer`), `/srv/shu` and `/etc/sudoers.d/shu-reviewer`
absent, `chmod -R go-w .github/coordinator`, `taskset -c 0-3 node --test
--test-concurrency=2`, with both the TAP reporter and the unchanged
`host-suite-contract.mjs` reporter writing separate outputs. Plain unsets
`NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers |
| --- | ---: | ---: | ---: | ---: | ---: |
| Focused plain | 1495 | 1494 | 0 | 1 | 1 / 1 |
| Focused clock | 1495 | 1494 | 0 | 1 | 1 / 1 |
| Full plain | 3238 | 3230 | 0 | 8 | 1 / 1 |
| Full clock | 3238 | 3230 | 0 | 8 | 1 / 1 |

Every command exited zero with zero cancelled and zero todo outcomes. Focused
TAP plans are `1..1495`; full plans are `1..3233`, with five nested outcomes.
Each full run's structured report has exactly one terminal `complete` event and
passes the unchanged `evaluateSuite` validator, and the committed-inventory
guard reruns the whole suite and matches all 3,238 names. Every skip in all four
runs is a `PERMITTED_SKIPS` entry with its exact documented reason; the single
focused skip is `SHU-71 restricted capability refusal`.

The focused selection is the prior lane selection extended with the files this
correction touches:

```sh
node --test \
  .github/coordinator/test/shu71-activation-package.test.mjs \
  .github/coordinator/test/shu71-battery.test.mjs \
  .github/coordinator/test/shu71-public-key.test.mjs \
  .github/coordinator/test/single-run-activation.test.mjs \
  .github/coordinator/test/supervisor.test.mjs \
  .github/coordinator/test/supervisor-dispatch.test.mjs \
  .github/coordinator/service/test/provision*.test.mjs \
  .github/coordinator/service/test/shu71-owner-decisions.test.mjs \
  .github/coordinator/service/test/shu71-phase-readback.test.mjs \
  .github/coordinator/service/test/shu71-production*.test.mjs \
  .github/coordinator/service/test/shu71-recovery-mutations.test.mjs \
  .github/coordinator/service/test/shu71-supervisor-environment.test.mjs \
  .github/coordinator/service/test/shu71-composition.test.mjs \
  .github/coordinator/service/test/shu71-trust*.test.mjs \
  .github/coordinator/service/test/shu71-verdict-closures.test.mjs
```

The full selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`.

`PERMITTED_SKIPS` is byte-identical to `873a36e`: **1,093 bytes** including its
final newline, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. The entire
`host-suite-contract.mjs` is unchanged, SHA-256
`2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`. Inventories
are strictly additive: 113 test files unchanged, 3,213 → 3,238 names and
requirement rows, zero removals and zero dropped requirement rows. No new test
file was added. The reviewed teardown effects set and its order are unchanged.
Only files under `.github/coordinator/**` changed; no push or PR was performed.

### SHU-71 expiry retirement drift

The idempotent-teardown correction above (`#153`, merged at
`9e1a2d0aea904c11ef2e4af7301346e7024e2d3e`) closed the never-installed branch.
It did not close the installed branch, and the window package built on that
revision claimed it had: that the expiry timer "keeps its equivalent refusal".
That claim was false at that revision, and the owner held the window on it.

Measured by reading `retireExpiryTimer()` at
`9e1a2d0aea904c11ef2e4af7301346e7024e2d3e`
(`.github/coordinator/service/shu71-production.mjs:438-451`):

| Measured defect | Consequence |
| --- | --- |
| Where the journal **proves** the mechanism was installed (`ARMED`, or `DONE` for `expiry-watch`) and `systemctl disable --now` **succeeds**, the function performed no check at all. `retired()` ran only in the `catch` branch, and only for the not-installed case. | An installed expiry mechanism whose `.timer` or companion `.service` file had been deleted or replaced underneath it was reported as successfully retired. Drift was silently absorbed. |
| `observeTeardown()` inspects the gate drop-ins, the activation file and the service `ActiveState`s, never the expiry unit files. | A later wake did not catch it either. |
| Nothing anywhere removed `/etc/systemd/system/shu71-expiry-<id>.timer` or `…service`. | Even a clean retirement left both durable unit files behind — the exact state the successor window's pre-mint gate and the not-installed branch's own `retired()` predicate both treat as wrong. |
| `need(retired(), 'ACT_TEARDOWN_DRIFT')` evaluates the predicate **as an argument** of the refusal it guards. | A throw inside `retired()` (for example a non-`ENOENT` `lstat` failure) skips the refusal entirely and reports the bare error in its place. |

Two pre-merge reviews named this line and neither was closed before the merge:
CodeRabbit raised it as a **functional correctness** finding on
`.github/coordinator/service/shu71-production.mjs:450`, and Sentry filed a
**MEDIUM** bug prediction on the same line — an exception thrown inside the
`retired()` call inside the `need(...)` argument bypasses the intended check and
misreports the failure. An independent reviewer's finding **F1** ("the clause
bounding absence-as-success for the expiry timer is enforced in code but pinned
by no control") is the same clause seen from the coverage side, and its **F3**
named two further unpinned clauses in this area: the teardown effect **order**
and the fixture cleanup's **durability precondition**.

The corrected retirement is a pre-condition, a command, and a post-condition:

1. **Pre-condition.** Where the journal proves this episode installed the
   mechanism, **both** `/etc/systemd/system/shu71-expiry-<id>.timer` and
   `…/shu71-expiry-<id>.service` must exist as root-owned, single-link, regular
   files without group or world write **before** `disable --now` is issued.
   Missing or substituted, either one halts by `ACT_TEARDOWN_DRIFT`. A
   `systemctl` answer is a cache of what systemd loaded and is never accepted in
   place of the durable files: systemd will disable a unit it still holds loaded
   whose file was deleted underneath it, and that success must not absorb drift.
   **The retry-path rule, and the only exception.** The durable
   `EXPIRY_RETIREMENT_STARTED` receipt narrows exactly one thing: a unit file
   that is **absent** is the completed half of this teardown's own interrupted
   removal rather than foreign drift, so on the retry path its absence — and
   only its absence — is accepted in place of the existence half above. A unit
   file that is still **present** is measured for root custody on the retry
   exactly as on the first pass; the receipt is never a custody waiver, because
   it says nothing about the bytes or the inode now at that path, and a second
   name for the inode, a foreign owner or a group-writable replacement would
   survive the unlink. Drifted custody on a present file halts by
   `ACT_TEARDOWN_DRIFT` instead of being disabled, removed and reported retired.
2. **The not-installed branch is unchanged and exactly as strict.** Absence is
   accepted only where `lifecyclePhase(journal, 'expiry-watch') === 'never'`
   proves non-creation; anything present, enabled or active there still halts.
   The `journal.recovered` conjunct of that proof stays fail-closed.
3. **Post-condition, on the success path too.** After `disable --now` returns —
   success or throw — the unit must be measured not active and not enabled, and
   the retirement itself removes both durable unit files. Where systemd still
   holds the removed view, a `daemon-reload` refreshes it and the end state is
   measured again. The end state satisfies the same predicate the
   never-installed branch asserts. **Invariant:** after a completed teardown the
   successor window's pre-mint gate must pass, and this episode leaves no expiry
   mechanism behind — machine-checked from the gate side since the correction
   round below, by the `/etc/systemd/system#shu71-expiry` precondition row. The
   retired episode's own receipt path now observes that
   too, so a mechanism re-created afterwards halts by `ACT_TEARDOWN_DRIFT`.
4. **No exception bypasses a check.** Every refusal in the retirement measures
   its predicate into a value first, through the exported `measuredPredicate()`:
   anything but a measured `true` — including a throw — is the refusal the
   caller named, never a bare error reported in its place.

The removal is crash-safe: a durable `EXPIRY_RETIREMENT_STARTED` journal row
precedes the two unlinks, so a process replacement between them is this
teardown's own interrupted work rather than foreign drift, and the retry
finishes it. Without that receipt the pre-condition would refuse the **absent**
half of a pair this teardown had itself half-removed, and the retry would be a
permanent wedge; with it, the still-present half is measured for custody as
strictly as on the first pass. That ordering is load-bearing in itself — the
receipt appended *after* the loop instead of before it leaves an interrupted
removal indistinguishable from foreign drift — and is pinned by name in the
clause table of the second correction round below. The reviewed teardown effects
set and its order are unchanged; `PERMITTED_SKIPS` is byte-identical.

| Named control | Proves |
| --- | --- |
| `B4_EXPIRY_FILE_DRIFT_REFUSED_timer/_service`, `_NAMED_*`, `_STEP_NAMED_*`, `_BEFORE_DISABLE_*`, `_PERSISTS_*`, `_REPEAT_BEFORE_DISABLE_*` | a journal-proven installed mechanism with either durable unit file missing halts by name, before the command, and keeps halting |
| `B4_EXPIRY_FILE_DRIFT_DISABLE_WOULD_SUCCEED_*`, `_PROBE_DISABLED_*`, `_REAL_*`, `_JOURNAL_PROVES_INSTALLED_*` | the modelled host would have answered `rc=0`: the refusal is the pre-condition's, not a lucky command failure |
| `B4_EXPIRY_FILE_DRIFT_RECOVERED_*`, `_RECOVERED_UNITS_REMOVED_*` | restoring the pair lets the same teardown complete and remove both |
| `B4_EXPIRY_RETIREMENT_COMPLETES`, `_DISABLED`, `_RECEIPT`, `B4_EXPIRY_UNITS_REMOVED`, `B4_EXPIRY_UNIT_NOT_ENABLED`, `B4_EXPIRY_UNIT_IDLE` | the happy path completes, and leaves no unit file, no enablement and no live unit |
| `B4_EXPIRY_REPEAT_TEARDOWN_OK/_REVOKED/_INERT/_NO_WRITES` | a repeat teardown is a no-op success that creates or deletes nothing |
| `B4_RETIRED_EPISODE_EXPIRY_DRIFT`, `_NAMED` | a mechanism re-created after a completed teardown halts by name on the receipt path |
| `B4_EXPIRY_DISABLE_FAILURE_NOT_SILENT`, `_NAMED`, `_STEP_NAMED`, `_UNITS_RETAINED`, `_NO_RAW_ERROR`, `_RECOVERED`, `_RETIRED_AFTER_RECOVERY` | a `disable` that throws is a refusal by name — never a silent success, never the bare error text — and stays recoverable |
| `B4_EXPIRY_POSTCONDITION_REFUSED`, `_NAMED`, `_UNITS_RETAINED`, `_RECOVERED`, `_RETIRED_AFTER_RECOVERY` | a `disable` that reports success while the unit stays active and enabled is drift, and the durable files of a live unit are not destroyed on that report |
| `B4_EXPIRY_RELOAD_REFRESHES_UNIT_VIEW`, `B4_EXPIRY_CACHED_VIEW_REMOVED/_RELOADED/_UNITS_REMOVED/_UNLOADED` | a stale loaded view is refreshed and re-measured before the retirement completes |
| `B4_EXPIRY_PREDICATE_THROW_REFUSES`, `_FALSE_REFUSES`, `_REQUIRES_MEASURED_TRUE`, `_MEASURED_TRUE_PASSES` | the Sentry case: a predicate that throws is the named refusal, not a bypass |
| `B4_RECOVERED_NOT_PROOF_OF_NON_CREATION`, `B4_RECOVERED_PREFIX_AUTHENTIC`, `_PREFIX_CLAIMS_NON_CREATION`, `B4_RECOVERED_TIMER_REALLY_INSTALLED`, `B4_RECOVERED_FAIL_CLOSED_RETIREMENT`, `B4_RECOVERED_UNITS_REMOVED` | the `journal.recovered` conjunct: an authentic retained prefix that records the forward attempt and no creating intent is still not proof of non-creation |
| `B4_TEARDOWN_EFFECT_ORDER`, `B4_TEARDOWN_EFFECT_ORDER_COMPLETED` | the reviewed effect order, as durable `INTENT` and `DONE` rows |
| `B4_FIXTURES_REQUIRE_WORKERS_DONE`, `B4_FIXTURES_DURABILITY_PRECONDITION`, `B4_FIXTURES_NO_DONE_WITHOUT_WORKERS`, `B4_FIXTURES_NO_RECEIPT_WITHOUT_WORKERS`, `B4_FIXTURES_WORKERS_FAILED/_NAMED`, `B4_FIXTURES_DEPENDENCY_RECOVERED`, `B4_FIXTURES_REMOVED_AFTER_WORKERS`, `B4_FIXTURES_AUTHORITY_RETAINED_AFTER_WORKERS` | the fixture cleanup refuses, and removes nothing, until the worker kill reaches its own durable `DONE` row |
| `B4_PHASE_<phase>_EXPIRY_UNITS_REMOVED` | every completed teardown in the seven-phase interruption matrix leaves no expiry mechanism behind |

| Named killing mutant | Control that kills it |
| --- | --- |
| `B1/B4 mutation: installed expiry pre-condition omitted` | `B4_EXPIRY_FILE_DRIFT_REFUSED_timer` |
| `B1/B4 mutation: expiry companion service file unchecked` | `B4_EXPIRY_FILE_DRIFT_REFUSED_service` |
| `B1/B4 mutation: retired expiry units left behind` | `B4_EXPIRY_RETIREMENT_COMPLETES` / `B4_EXPIRY_UNITS_REMOVED` |
| `B1/B4 mutation: expiry retirement receipt omitted` | `B4_EXPIRY_RETIREMENT_RECEIPT` |
| `B1/B4 mutation: retired episode expiry drift unobserved` | `B4_RETIRED_EPISODE_EXPIRY_DRIFT` |
| `B1/B4 mutation: expiry end state never measured` | `B4_EXPIRY_POSTCONDITION_UNITS_RETAINED` |
| `B1/B4 mutation: refused expiry disable blindly accepted` | `B4_EXPIRY_DISABLE_FAILURE_NOT_SILENT` |
| `B1/B4 mutation: stale unit view never refreshed` | `B4_EXPIRY_RELOAD_REFRESHES_UNIT_VIEW` |
| `B1/B4 mutation: refusal predicate evaluated inside need()` | `B4_EXPIRY_PREDICATE_THROW_REFUSES` |
| `B1/B4 mutation: recovered log accepted as non-creation proof` | `B4_RECOVERED_NOT_PROOF_OF_NON_CREATION` |
| `B1/B4 mutation: teardown effect order permuted` | `B4_TEARDOWN_EFFECT_ORDER` |
| `B1/B4 mutation: fixtures durability precondition removed` | `B4_FIXTURES_REQUIRE_WORKERS_DONE` |

The two existing expiry mutants keep their names and their killing assertions;
only their source anchors moved with the single `expiryRetired` predicate. The
disposable production fixture gains one opt-in model, `systemd.unitFileViewCached`,
which answers unit-file questions from the units systemd has loaded (refreshed
on `daemon-reload`, and not forgetting a unit that is still running) rather than
straight from disk. It is off by default, so every previous model answer is
unchanged; the drift controls turn it on to reproduce a `disable --now` that
succeeds against a durable file that is no longer there.

Three measured-effect oracles move by exactly the seven effects a completed
retirement now performs — the end-state measurement (`ActiveState`,
`UnitFileState`), the durable receipt row, the two unit-file unlinks and the
final retired measurement (`ActiveState`, `UnitFileState`): `B1_RESUME_EFFECT_COUNT`
68 → 75, `B1_EXPIRY_EFFECT_COUNT` 72 → 79, and the R8 `cleanupEffects` table with
its `settled` count. `B1_REVOKE_OBSERVATION_ONLY` moves 4 → 6 for the two
measurements the retired receipt path now also takes. Every assertion name,
skip, timeout and deadline is unchanged.

#### Validation of the expiry-retirement drift correction

Tested implementation `2e4fdd1f569a7e83b8344bd7c080553e19e4b7f7`, tree
`008b8231610ddc30aaf67e2f3891e52e6d578f1c`. All commands ran from the
repository root under the CI-like harness (`test/fixture/shu71-ci-like.sh`):
UID 1000, `umask 0022`, target accounts absent (`shu-coordinator`,
`shu-supervisor`, `shu71-evidence`, `shu-workspace`, `shu-reviewer`), `/run`
and `/etc/sudoers.d` tmpfs, `/srv/shu` and `/etc/sudoers.d/shu-reviewer`
absent, `chmod -R go-w .github/coordinator`, `taskset -c 0-3 node --test
--test-concurrency=2`, with both the TAP reporter and the unchanged
`host-suite-contract.mjs` reporter writing separate outputs. Plain unsets
`NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Focused plain | 1519 | 1518 | 0 | 1 | 1 / 1 | 0 |
| Focused clock | 1519 | 1518 | 0 | 1 | 1 / 1 | 0 |
| Full plain | 3262 | 3254 | 0 | 8 | 1 / 1 | 0 |
| Full clock | 3262 | 3254 | 0 | 8 | 1 / 1 | 0 |

Every command exited zero with zero cancelled and zero todo outcomes. Focused
TAP plans are `1..1519`; full plans are `1..3257`, with five nested outcomes
bringing each total to 3,262. Each run's structured report has exactly one
terminal `complete` event and passes the unchanged `evaluateSuite` validator,
and the committed-inventory guard reruns the whole suite and matches all 3,262
names. Every skip in all four runs is a `PERMITTED_SKIPS` entry with its exact
documented reason; the single focused skip is
`SHU-71 restricted capability refusal`.

The focused selection is the fifteen-entry list printed above under *Validation
of the idempotent-teardown correction*, unchanged: every file this correction
touches is covered by it, and the focused total moves with the inventory alone,
1,495 + 24 = 1,519. The full selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`.

`PERMITTED_SKIPS` is byte-identical to `9e1a2d0`: **1,093 bytes** including its
final newline, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. The entire
`host-suite-contract.mjs` is unchanged, SHA-256
`2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`. Inventories
are strictly additive: 113 test files unchanged, 3,238 → 3,262 names and
requirement rows, zero removals and zero dropped requirement rows; no test file
was added. The reviewed teardown effects set and its order are unchanged. Only
files under `.github/coordinator/**` changed; no push or PR was performed.

#### Correction round: the clauses the shipped tree did not pin

An independent verifier (a different model family) reproduced the behaviour
above from the shipped code and confirmed it, then returned **BLOCK** on
coverage: three custody clauses of the pre-condition and the refusal after the
`daemon-reload` were enforced by the shipped module but **pinned by no shipped
control**. Its own mutants — ownership clause removed, mode clause removed,
custody predicate made vacuous, and the post-reload `need(...)` deleted while
keeping the reload — each survived the entire shipped expiry surface (1,069
tests, 0 failures). Only the *existence* half of the pre-condition was pinned.
A future edit could therefore delete those clauses with the suite still green,
and an installed `shu71-expiry-<id>.timer`/`.service` **replaced** by a
non-root-owned or group/world-writable file would again be disabled, removed
and reported as successfully retired.

The clauses are unchanged. What follows is new coverage, plus one new
machine-checked precondition in the pre-mint gate.

**The custody terms, one control and one mutant each.** Each control plants
exactly one broken term on a **journal-proven installed** unit file, with both
files present and `disable --now` ready to succeed, and asserts by
`B4_EXPIRY_CUSTODY_EXACTLY_ONE_TERM_<variant>` that nothing else in the
predicate is false — so the control cannot survive on the mutant that removes
the term it claims to pin. `ACT_TEARDOWN_DRIFT` is raised by `need()` inside the
`expiry-timer` teardown effect, and `teardownActivation()` reports every effect
refusal under that step's own name, so `ACT_CLEANUP_FAILED` with
`ACT_TEARDOWN_EXPIRY_TIMER` in `failures` is the observable form of that refusal
at the module boundary; the literal code is observable on the retired-episode
receipt path, pinned by `B4_RETIRED_EPISODE_EXPIRY_DRIFT_NAMED`.

| Named control | Named killing mutant | Clause pinned |
| --- | --- | --- |
| `B4_EXPIRY_CUSTODY_REFUSED_non-root-owner` (+ `_NAMED_`, `_STEP_NAMED_`, `_BEFORE_DISABLE_`, `_UNITS_RETAINED_`, `_NO_RECEIPT_`, `_PERSISTS_`, `_RECOVERED_`) | `B1/B4 mutation: expiry unit owner unchecked` | `s.uid === 0` |
| `B4_EXPIRY_CUSTODY_REFUSED_non-root-group` (+ the same suffixes) | `B1/B4 mutation: expiry unit group unchecked` | `s.gid === 0` |
| `B4_EXPIRY_CUSTODY_REFUSED_group-writable` | `B1/B4 mutation: expiry unit group-writable mode accepted` (`0o022` → `0o002`) | the group-write bit of `!(s.mode & 0o022)` |
| `B4_EXPIRY_CUSTODY_REFUSED_world-writable` | `B1/B4 mutation: expiry unit world-writable mode accepted` (`0o022` → `0o020`) | the world-write bit of `!(s.mode & 0o022)` |
| `B4_EXPIRY_CUSTODY_REFUSED_non-regular-file` | `B1/B4 mutation: expiry unit file shape unchecked` | `s.isFile() && !s.isSymbolicLink()` |
| `B4_EXPIRY_CUSTODY_REFUSED_non-root-owner` | `B1/B4 mutation: expiry unit custody predicate vacuous` | the whole predicate |
| `B4_EXPIRY_POST_RELOAD_REFUSED` (+ `_NAMED`, `_STEP_NAMED`, `_STATE_CONSTRUCTED`, `_REMOVAL_ISSUED`, `_RELOADED`, `_NOT_RETIRED`, `_RECOVERED`, `_RETIRED_AFTER_RECOVERY`) | `B1/B4 mutation: post-reload expiry end state never measured` | `need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT')` after the reload |

Each mutant was re-verified individually: with the clause removed the teardown
returns `{"ok":true,"state":"REVOKED"}` — a live or lawless expiry mechanism
reported as a successful retirement — and the control dies by its own named
assertion, not by a textual anchor or a documentation line number. The
post-reload control constructs exactly the state the verifier named: both unit
files are removed, the mechanism comes back on disk before systemd re-reads the
unit directory, the `daemon-reload` is issued and observed in the event slice
(`B4_EXPIRY_POST_RELOAD_RELOADED`), and the end state is still not retired.

The non-regular-file control plants a **listening unix socket** with the unit
file's own custody (root:root, one link, `0644`): a genuine non-regular file for
which every other custody term still holds. A planted **symlink** could not
serve, because a symlink's own mode is `0777`, so the mode clause would refuse
it and the shape mutant would survive.

**`!s.isSymbolicLink()` is an equivalent mutant, and is documented as one
rather than given a faked control.** `s` is an `lstat` result, so a symlink is
already `isFile() === false`; removing that term alone cannot change any
outcome, and a mutant that removes it survives — by construction, not by a gap.
It is retained as a statement of the requirement at the point of measurement,
and the shape clause **as a whole** is pinned by the control above. The reasoning
is recorded in place at the predicate in `shu71-production.mjs`.

**The `expiry-timer` step's last-of-all precondition is deliberate defence in
depth.** `teardownActivation()` already refuses that step when any earlier
effect failed, throwing `ACT_CLEANUP_FAILED` independently. The precondition
states the same requirement against the **durable journal rows** rather than one
process's in-memory failure list, so a retry in a fresh process that re-reads
the log reaches it too. Noted in place; unchanged.

**The successor-gate claim is now machine-checked, not inferred.** The invariant
above says a completed teardown leaves the successor window's pre-mint gate
passing. Until this round nothing in `provision-shu71-prerequisites.mjs`
mentioned the expiry mechanism, so that sentence was an inference about an
out-of-repo host process. `precondition()` now carries the row
`/etc/systemd/system#shu71-expiry`, which refuses:

* `ACT_PRODUCTION_EXPIRY_UNIT_PRESENT` — any `shu71-expiry-*.timer` or
  `shu71-expiry-*.service` file in `/etc/systemd/system`. The activation ID is
  selected **after** this gate, so every such unit is a foreign episode's.
* `ACT_PRODUCTION_EXPIRY_UNIT_ENABLED` — any `shu71-expiry-*` enable symlink in
  `timers.target.wants`, `multi-user.target.wants` or `default.target.wants`,
  which is the durable record `systemctl enable` writes, and which survives even
  where the unit file itself is gone.

The row reports `{ state: 'NO_EXPIRY_MECHANISM' }` and **passes** where no expiry
mechanism is installed, which is the target host's measured state: it refuses
drift, it does not block arming (`HOST_EXPIRY_UNITS_ABSENT_GREEN`, which also
asserts the whole report stays green). Its limit is stated plainly: a unit that
is *active* with no unit file and no enable symlink of its own is not measurable
from disk, and no `systemctl` is executed by the pre-mint gate. That state is
the retiring episode's own post-condition (`unitIdle` plus `UnitFileState` in
`shu71-production.mjs`), not this gate's.

| Named control | Named killing mutant |
| --- | --- |
| `HOST_EXPIRY_UNIT_TIMER_PRESENT` | `HOST_KILL_EXPIRY_UNIT_PRESENT` (the presence `need(...)` removed) |
| `HOST_EXPIRY_UNIT_SERVICE_PRESENT` | `HOST_KILL_EXPIRY_UNIT_COMPANION` (the `.service` suffix dropped from the match) |
| `HOST_EXPIRY_UNIT_ENABLED` | `HOST_KILL_EXPIRY_UNIT_ENABLED` (the enablement `need(...)` removed) |
| `HOST_EXPIRY_UNITS_ABSENT_GREEN` | — (green control: the gate must stay passable on the real host) |

**`V8_DOCUMENTATION_LINK_TARGETS`.** The previous round widened the accepted-line
alternation with `|function sharedAccess\(` when `SHU71-L3-CLOSURE.md` split one
broker-identity link into `identity()#L182` and `sharedAccess()#L195`. The
justification is now recorded in the test itself: every accepted alternative is
the definition or call line of the exact symbol its link text names, and
`function sharedAccess(` is the same "definition line of the named function"
form already accepted for `identity()`, in the same file, for the adjacent half
of the same claim. No assertion was removed and the exact line is still
asserted, so a one-line drift in either target still fails.

Inventories remain strictly additive: 3,262 → 3,282 names and requirement rows,
no test file added or removed, no name changed. `PERMITTED_SKIPS` stays
byte-identical (1,093 bytes, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`). The
reviewed teardown effects set and its order are unchanged, and the only
production changes in this round are two comments and the new pre-mint gate row.

#### Validation of the correction round

Tested implementation `d9880fd4e395d5793195936f03d5810c7c69819f`, tree
`027b3ec2ee1f68b8cece8b1356657c6bc3bce27f`. All commands ran from the repository
root under the CI-like harness (`service/test/fixture/shu71-ci-like.sh`): UID
1000, `umask 0022`, target accounts absent, `/run` and `/etc/sudoers.d` tmpfs,
runtime and reviewer sudoers absent, `chmod -R go-w .github/coordinator`,
`taskset -c 0-3 node --test --test-concurrency=2`, with both the TAP reporter
and the unchanged `host-suite-contract.mjs` reporter writing separate outputs.
Plain unsets `NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit | Load at start → end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Focused plain | 1569 | 1568 | 0 | 1 | 1 / 1 | 0 | 1.46 → 2.52 |
| Focused clock | 1569 | 1568 | 0 | 1 | 1 / 1 | 0 | 2.32 → 3.20 |
| Full plain | 3282 | 3274 | 0 | 8 | 1 / 1 | 0 | 3.03 → 3.25 |
| Full clock | 3282 | 3274 | 0 | 8 | 1 / 1 | 0 | 2.53 → 2.87 |

Every command exited zero with zero cancelled and zero todo outcomes. Focused
TAP plans are `1..1569`; full plans are `1..3277`, with five nested outcomes
bringing each total to 3,282. Each run's structured report has exactly one
terminal `complete` event and passes the unchanged `evaluateSuite` validator.
The committed-inventory guard reruns the whole suite against the committed
inventory and matches all 3,282 names, their order and their capability rows.
Every skip in all four runs is a `PERMITTED_SKIPS` entry with its exact
documented reason; the single focused skip is
`SHU-71 restricted capability refusal`.

The focused selection is that same fifteen-entry list, extended with the one
further file this round's gate row affects. It is printed here in full so that
neither statement has to be reconstructed by chaining relative references:

```sh
node --test \
  .github/coordinator/test/shu71-activation-package.test.mjs \
  .github/coordinator/test/shu71-battery.test.mjs \
  .github/coordinator/test/shu71-public-key.test.mjs \
  .github/coordinator/test/single-run-activation.test.mjs \
  .github/coordinator/test/supervisor.test.mjs \
  .github/coordinator/test/supervisor-dispatch.test.mjs \
  .github/coordinator/service/test/provision*.test.mjs \
  .github/coordinator/service/test/shu71-owner-decisions.test.mjs \
  .github/coordinator/service/test/shu71-phase-readback.test.mjs \
  .github/coordinator/service/test/shu71-production*.test.mjs \
  .github/coordinator/service/test/shu71-recovery-mutations.test.mjs \
  .github/coordinator/service/test/shu71-supervisor-environment.test.mjs \
  .github/coordinator/service/test/shu71-composition.test.mjs \
  .github/coordinator/service/test/shu71-trust*.test.mjs \
  .github/coordinator/service/test/shu71-verdict-closures.test.mjs \
  .github/coordinator/service/test/shu71-host-contract.test.mjs
```

The focused total is the previous lane's 1,519, plus this round's 20 inventory
names, plus the 30 tests of the newly added `shu71-host-contract.test.mjs`:
1,569. The full selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`.

Each of this round's seven production mutants and three pre-mint gate mutants
was additionally re-verified on its own, outside the suite: with the clause
removed the teardown reports `{"ok":true,"state":"REVOKED"}` (or the gate row
reports `ok: true`), and the named control dies. The verifier's own mutant
shapes were replayed the same way — ownership clause removed, mode clause
removed, custody predicate vacuous, post-reload `need(...)` deleted — and all
four now die by name. The only surviving mutant is `!s.isSymbolicLink()`, which
survives by construction and is documented above as equivalent.

`PERMITTED_SKIPS` is byte-identical to `9e1a2d0`: **1,093 bytes** including its
final newline, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. The entire
`host-suite-contract.mjs` is unchanged, SHA-256
`2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`. Inventories
are strictly additive: 113 test files unchanged, 3,262 → 3,282 names and
requirement rows, zero removals and zero dropped requirement rows; no test file
was added. The reviewed teardown effects set and its order are unchanged. Only
files under `.github/coordinator/**` changed; no push or PR was performed.

#### Correction round: the last unpinned custody term, `s.nlink === 1`

The previous round pinned five of the six custody terms of the
`retireExpiryTimer()` pre-condition and reported the sixth, `s.nlink === 1`, as
still enforced by the shipped module and pinned by no shipped control. It is
not an equivalent mutant: a hardlinked unit file is a real drift shape for a
durable root-owned unit file. Another name in the filesystem refers to the same
inode, so the retirement's `unlink` of the unit path leaves the file — and
whoever holds the other name — behind, with the content systemd loaded still
writable through that name. Removing the clause was replayed on a copy of the
module: the teardown reports `{"ok":true,"state":"REVOKED"}`, unlinks
`/etc/systemd/system/shu71-expiry-<id>.timer`, and the retained second name
still resolves to the inode afterwards.

No clause changes. New coverage only; no production, `PERMITTED_SKIPS` or
`host-suite-contract.mjs` byte changed in this round.

| Named control | Proves |
| --- | --- |
| `B4_EXPIRY_CUSTODY_REFUSED_hardlinked-timer` (+ `_NAMED_`, `_STEP_NAMED_`, `_BEFORE_DISABLE_`, `_UNITS_RETAINED_`, `_NO_RECEIPT_`, `_PERSISTS_`, `_REPEAT_BEFORE_DISABLE_`, `_RECOVERED_`, `_RECOVERED_UNITS_REMOVED_`) | a journal-proven installed `.timer` unit file that gained a second hard link halts by name, before the command, keeps halting, and completes once the second name is removed |
| the same suffixes on `_hardlinked-service` | the same, planted on the companion `.service` unit file, which `EXPIRY_UNITS.every(...)` measures with the identical predicate |
| `B4_EXPIRY_CUSTODY_EXACTLY_ONE_TERM_hardlinked-timer/-service` | only `links` is false on the damaged file, so the control cannot survive the mutant that removes the term it pins |
| `B4_EXPIRY_CUSTODY_OTHER_UNIT_INTACT_<variant>` (all seven variants) | the companion unit file has every custody term intact, so the refusal is the damaged file's and not incidental damage next to it |

| Named killing mutant | Control that kills it |
| --- | --- |
| `B1/B4 mutation: expiry unit hardlink unchecked` (`s.nlink === 1 && ` removed) | `B4_EXPIRY_CUSTODY_REFUSED_hardlinked-timer` |

Both hardlink controls were re-verified individually against that mutant
outside the suite, and both die by their own named assertion with the shipped
teardown reporting `{"ok":true,"state":"REVOKED","failures":[]}`. The
service-side control is not a duplicate of the timer-side one: it additionally
kills the existing `B1/B4 mutation: expiry companion service file unchecked`
(`EXPIRY_UNITS.every(...)` → `[EXPIRY_UNITS[0]].every(...)`), which the
timer-side control survives by construction, because the timer half of the
`every` is still measured there. With this round, every non-equivalent term of
`expiryUnitCustody` — shape, links, user, group, group-write and world-write —
has its own control and its own killing mutant on each of the two durable unit
files the predicate is applied to. `!s.isSymbolicLink()` remains the one
equivalent mutant, documented at the predicate.

The control plants the second name at
`/var/tmp/shu71-expiry-retained-<id>.<unit>` inside the disposable fixture
tree, with a real `link(2)`; `lstat` in the fixture reports the real `nlink`,
so the measurement is the production predicate's own, not a modelled answer.
Nothing else about the file changes — same regular-file shape, same root
owner and group, same `0644` — and removing the second name restores custody,
after which the same teardown completes and removes both unit files.

Two statements of record about the focused selection were reconciled in this
round, above: the expiry-retirement lane's *unchanged from the previous lane*
sentence now names the fifteen-entry list it refers to, and the previous
correction round's sentence names the same list plus
`shu71-host-contract.test.mjs`, with the arithmetic that ties the three focused
totals together (1,495 → +24 → 1,519 → +20 inventory names → +30 tests from
the added file → 1,569). The two statements were not numerically in conflict;
the defect was that neither said which list had actually been run, so the
selection could only be reconstructed by chaining two relative references.

#### Validation of the hardlink-clause round

Tested implementation `5412819cb7c6028ec726afeba7c0f15782a1b306`, tree
`cd7ba2ab44537b5668d4fb716192e6a9539d0d9e`. All four commands ran from the
repository root under the CI-like harness (`test/fixture/shu71-ci-like.sh`):
UID 1000, `umask 0022`, target accounts absent (`shu-coordinator`,
`shu-supervisor`, `shu71-evidence`, `shu-workspace`, `messagebus`), `/run` and
`/etc/sudoers.d` tmpfs, `/run/shu71-evidence` and `/etc/sudoers.d/shu-reviewer`
absent, `chmod -R go-w .github/coordinator`, `taskset -c 0-3 node --test
--test-concurrency=2`, with both the TAP reporter and the unchanged
`host-suite-contract.mjs` reporter writing separate outputs. Plain unsets
`NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit | Load at start → end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Focused plain | 1572 | 1571 | 0 | 1 | 1 / 1 | 0 | 1.50 → 7.11 |
| Focused clock | 1572 | 1571 | 0 | 1 | 1 / 1 | 0 | 6.54 → 3.95 |
| Full plain | 3285 | 3277 | 0 | 8 | 1 / 1 | 0 | 3.95 → 2.20 |
| Full clock | 3285 | 3277 | 0 | 8 | 1 / 1 | 0 | 2.02 → 3.09 |

Every command exited zero with zero cancelled and zero todo outcomes, and no
`not ok` line. Focused TAP plans are `1..1572`; full plans are `1..3280`, with
five nested outcomes bringing each total to 3,285. Each run's structured report
has exactly one terminal `complete` event and passes the unchanged
`evaluateSuite` validator, and both full runs' outcome names match the
committed inventory's 3,285 names exactly. Every skip in all four runs is a
`PERMITTED_SKIPS` entry with its exact documented reason; the single focused
skip is `SHU-71 restricted capability refusal`.

The focused selection is the sixteen-entry list printed above for the previous
correction round, unchanged; every file this round touches is already in it.
The focused total is that round's 1,569 plus this round's three inventory
names: 1,572. The full selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`.

One earlier full plain run, executed against the working tree before this
round's commit existed, failed with `SHU251_SUITE_INCOMPLETE` in `A12 committed
inventory requirements match real outcomes`, and is recorded here rather than
discarded. That guard reads the inventory from the committed revision
(`git show <revision>:suite-inventory.json`) while executing the working-tree
test files, so three uncommitted names are necessarily an incomplete suite to
it — the same property earlier lanes handled with a detached committed
snapshot. All four runs in the table above are against the committed revision
with a clean working tree, and that guard passes in both full runs.

Each hardlink control was additionally re-verified on its own, outside the
suite: with `s.nlink === 1 && ` removed from `expiryUnitCustody`, the teardown
reports `{"ok":true,"state":"REVOKED","failures":[]}`, the unit path is
unlinked, the retained second name still resolves to the inode, and both
`B4_EXPIRY_CUSTODY_REFUSED_hardlinked-timer` and `…_hardlinked-service` die by
name. The service-side control also kills the existing `expiry companion
service file unchecked` mutant, which the timer-side control survives by
construction.

`PERMITTED_SKIPS` is byte-identical to `9e1a2d0`: **1,093 bytes** including its
final newline, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. The entire
`host-suite-contract.mjs` is unchanged, SHA-256
`2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`. No
production file changed in this round at all: the only changed bytes are three
test files, the inventory and this document. Inventories are strictly additive:
113 test files unchanged, 3,282 → 3,285 names and requirement rows, zero
removals and zero dropped requirement rows; no test file was added. The
reviewed teardown effects set and its order are unchanged. Only files under
`.github/coordinator/**` changed; no push or PR was performed.

#### Second correction round: the receipt is not a custody waiver

An independent verifier reviewed `eb23e258247a03ea678676a73ba3e2d0a13da175` and
returned **BLOCK**. Its finding **F-01** is not a missing control: the previous
round's own `removing` shortcut **reintroduced** the defect the owner required
closed. The pre-condition read

```js
if (installed && !removing) need(measuredPredicate(() => EXPIRY_UNITS.every(expiryUnitCustody)), 'ACT_TEARDOWN_DRIFT');
```

`removing` is true whenever the journal holds `EXPIRY_RETIREMENT_STARTED`, so on
an interrupted-retirement retry — receipt present, both unit files still on disk
— that condition is false and **no custody term was measured at all**. A
journal-proven installed unit file that had drifted out of root custody was
disabled, unlinked and reported as a clean retirement, while a second hard link
to the same inode survived the removal. The verifier demonstrated it with a
fixture probe: `execute('run')` → `ARMED`, a fault injected at the unlink of the
timer, `execute('revoke')` → `ACT_CLEANUP_FAILED` with the receipt written and
both unit files still present, and the second name for the inode never examined.

That round's correction removed the receipt from the condition but left the
whole pre-condition gated on the journal:

```js
if (installed) need(measuredPredicate(() => EXPIRY_UNITS.every(file =>
  removing && unitFileAbsent(file) || expiryUnitCustody(file))), 'ACT_TEARDOWN_DRIFT');
```

It closed the receipt door and **reopened the same property through the
`installed` door**: with `installed === false` the clause was skipped entirely
while the removal loop below still unlinked whatever was present. This document
described that clause as "unconditional again in the only sense that matters",
which the code did not say — the third correction round below records the
finding, the structural fix, and the rule the code now actually states. What the
receipt proves and what it does not is unchanged and still correct: it proves
this teardown already began unlinking, so an **absent** file is our own work
rather than foreign drift; it proves nothing about a **present** file, whose
bytes and inode are unmeasured.

The other blocking findings were coverage, not behaviour. **F-02**: the append
of the receipt must precede the removal loop, and the verifier's mutant that
swapped them survived every shipped control — including the one credited with
that row — because `expiryRetirementCheck` only ever sees the receipt at the
*end*, where both orders agree. **F-03**: the `ACT_COMMAND_FAILED` door of the
disable catch was unpinned, because `expiryDisableFailureCheck` injects a
generic `Error('SECRET_POISON')` that carries no code and therefore exercises
only the other door. **F-04**: `expiryPostConditionCheck` ends the unit both
active *and* enabled, so either post-condition conjunct alone still refuses and
neither could be attributed. **F-05** was this document stating the
pre-condition unconditionally against a code path that had an exception; code
and document now agree exactly, including the retry-path rule. The verifier's
**F-06** (the pre-mint gate's disclosed residue) and **F-07**
(`!s.isSymbolicLink()` as a genuine equivalent mutant) were confirmed in this
lane's favour and are unchanged.

##### Every load-bearing clause and ordering of `retireExpiryTimer`

Each row is a clause or an ordering of `retireExpiryTimer()` or of what it
calls, with the control that pins it, the mutant that the control kills, and
whether that kill was re-verified by hand this round. Attack this table rather
than rediscovering it. Control names are assertion names; mutant names are the
`B1/B4 mutation:` / `recovery mutation:` test names.

| Clause or ordering | Named control | Named killing mutant | Kill |
| --- | --- | --- | --- |
| `lifecyclePhase(journal, 'expiry-watch') === 'never'` early branch and its `need(expiryRetired)` | `B4_PREARM_DRIFT_REFUSED_timer-file` | `pre-arm expiry drift silently accepted` | verified |
| `lifecyclePhase`'s `journal.recovered` conjunct | `B4_RECOVERED_NOT_PROOF_OF_NON_CREATION` | `recovered log accepted as non-creation proof` | shipped |
| `lifecyclePhase`'s `RUN_ATTEMPT_STARTED` conjunct | `B4_DESTROYED_JOURNAL_NOT_PROOF` | `non-creation inferred from an empty journal` | shipped |
| `installed` derivation, as the gate on the whole pre-condition | `B4_EXPIRY_FILE_DRIFT_REFUSED_timer` | `installed expiry pre-condition omitted` | verified |
| `installed` — the `journalHas(journal, 'DONE', 'expiry-watch')` disjunct | `B4_EXPIRY_BEFORE_ARMED_REFUSED` | `expiry installation proven only by ARMED` | verified |
| `installed` — the `journalHas(journal, 'ARMED')` disjunct | *equivalent mutant, reasoning below* | — | n/a |
| `removing` — the receipt derivation | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `expiry removal receipt never re-read` | verified |
| existence of the `.timer` unit file before `disable --now` | `B4_EXPIRY_FILE_DRIFT_REFUSED_timer` | `installed expiry pre-condition omitted` | verified |
| existence of the companion `.service` file (the other half of `every`) | `B4_EXPIRY_FILE_DRIFT_REFUSED_service` | `expiry companion service file unchecked` | verified |
| **F-01** custody measured on every file still PRESENT on the retry path | `B4_EXPIRY_INTERRUPTED_CUSTODY_timer_REFUSED`, `…_service_REFUSED` | `interrupted removal bypasses expiry custody`, `… companion custody` | verified |
| custody `s.isFile()` | `B4_EXPIRY_CUSTODY_REFUSED_non-regular-file` | `expiry unit file shape unchecked` | verified |
| custody `s.nlink === 1` | `B4_EXPIRY_CUSTODY_REFUSED_hardlinked-timer`, `…-service` | `expiry unit hardlink unchecked` | verified |
| custody `s.uid === 0` | `B4_EXPIRY_CUSTODY_REFUSED_non-root-owner` | `expiry unit owner unchecked` | verified |
| custody `s.gid === 0` | `B4_EXPIRY_CUSTODY_REFUSED_non-root-group` | `expiry unit group unchecked` | verified |
| custody `!(s.mode & 0o020)` | `B4_EXPIRY_CUSTODY_REFUSED_group-writable` | `expiry unit group-writable mode accepted` | verified |
| custody `!(s.mode & 0o002)` | `B4_EXPIRY_CUSTODY_REFUSED_world-writable` | `expiry unit world-writable mode accepted` | verified |
| the custody predicate as a whole | `B4_EXPIRY_CUSTODY_REFUSED_non-root-owner` | `expiry unit custody predicate vacuous` | verified |
| custody `!s.isSymbolicLink()` | *equivalent mutant, documented at the predicate* | — | n/a |
| the `disable --now` command itself | `B4_EXPIRY_RETIREMENT_DISABLED`, `B4_EXPIRY_RETIREMENT_COMPLETES` | `expiry disable command never issued` | verified |
| catch door A — a throw carrying **no** `ACT_COMMAND_FAILED` code | `B4_EXPIRY_DISABLE_FAILURE_NOT_SILENT` | `refused expiry disable blindly accepted` | verified |
| **F-03** catch door B — `systemctl disable` **exiting non-zero** | `B4_EXPIRY_DISABLE_EXIT_REFUSED` | `expiry disable exit-status refusal conjuncts dropped` | verified |
| catch conjunct `removing ||` | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `interrupted expiry disable refusal rejected` | verified |
| catch conjunct `!installed && …` | `B4_EXPIRY_UNINSTALLED_RETIRED_COMPLETES` | `uninstalled expiry disable refusal rejected` | verified |
| catch conjunct `… && expiryRetired()` | `B4_EXPIRY_UNINSTALLED_PRESENT_REFUSED` | `uninstalled expiry disable accepted with the mechanism present` | verified |
| **F-04** post-condition conjunct `unitIdle(expiryTimerUnit)` | `B4_EXPIRY_POSTCONDITION_ACTIVE_UNITS_RETAINED` | `expiry post-condition unit liveness inert` | verified |
| **F-04** post-condition conjunct `UnitFileState ∉ {enabled, enabled-runtime}` | `B4_EXPIRY_POSTCONDITION_ENABLED_REFUSED` | `expiry post-condition enablement unchecked` | verified |
| the post-condition as a whole | `B4_EXPIRY_POSTCONDITION_UNITS_RETAINED` | `expiry end state never measured` | verified |
| the removal loop | `B4_EXPIRY_UNITS_REMOVED` | `retired expiry units left behind` | shipped |
| the removal loop's `!EXPIRY_UNITS.every(unitFileAbsent)` guard | `B4_EXPIRY_UNINSTALLED_RETIRED_NOTHING_TO_REMOVE` | `expiry removal issued with nothing to remove` | verified |
| the receipt append | `B4_EXPIRY_RETIREMENT_RECEIPT` | `expiry retirement receipt omitted` | shipped |
| **F-02** the receipt append's POSITION, before the loop | `B4_EXPIRY_INTERRUPTED_REMOVAL_RECEIPT_BEFORE_REMOVAL` | `expiry removal receipt appended after the unlinks` | verified |
| the `daemon-reload` on a stale loaded view | `B4_EXPIRY_RELOAD_REFRESHES_UNIT_VIEW` | `stale unit view never refreshed` | shipped |
| the post-reload re-measure | `B4_EXPIRY_POST_RELOAD_REFUSED` | `post-reload expiry end state never measured` | shipped |
| `expiryRetired()`'s liveness and enablement tail | `B4_PREARM_DRIFT_REFUSED_timer-active` | `expiry retirement ignores unit liveness` | shipped |
| `observeRetiredExpiry()` on the retired episode's receipt path | `B4_RETIRED_EPISODE_EXPIRY_DRIFT` | `retired episode expiry drift unobserved` | shipped |
| `observeTeardown()` re-run immediately before the retirement | `B4_RETIREMENT_REOBSERVATION` | `P1 retirement re-observation removed` | shipped |
| the effect's durable-`DONE` pre-condition (defence in depth) | *equivalent pair, reasoning below* | — | n/a |

`verified` means the mutant was additionally replayed on its own this round,
outside the suite, and observed to die by its named assertion; `shipped` means
it is an existing mutant whose kill this round did not re-measure by hand but
which runs in the suite on every invocation. Every row has both a control and a
mutant, or an equivalent-mutant entry with its reasoning. There are **no rows
with neither**.

Three equivalent mutants, with the measured reasoning:

1. `!s.isSymbolicLink()` in `expiryUnitCustody`. `s` is an `lstat` result, so a
   symlink already fails `isFile()`; removing the term alone cannot change any
   outcome. Unchanged this round, and confirmed as genuine by the verifier's
   **F-07**.
2. The `journalHas(journal, 'ARMED')` disjunct of `installed`. `ARMED` is
   appended at `shu71-production.mjs:385`, strictly after `step('expiry-watch',
   …)` at line 329 has reached its durable `DONE` row, and every journal this
   module can produce — including a recovered log, which is a retained *prefix*
   — is prefix-closed. So no journal that holds `ARMED` can lack the `DONE`
   row, and dropping the first disjunct changes no reachable outcome. It is
   retained as a statement of the requirement against a log whose `DONE` row is
   missing for some reason this module cannot produce. The second disjunct is
   **not** equivalent and is pinned in the table above.
3. The `expiry-timer` effect's durable-`DONE` pre-condition
   (`shu71-production.mjs:634`) and the in-memory guard it duplicates
   (`shu71-journal.mjs:75`, `if (step === 'expiry-timer' && failures.length)`)
   are a deliberately redundant **pair**: each alone produces the identical
   refusal, so each single-guard mutant survives. Measured, not assumed — with
   either one removed in isolation, a teardown whose worker kill fails still
   refuses the retirement, issues no `disable --now`, writes no receipt and
   leaves both unit files in place; with **both** removed the retirement runs
   against a failed teardown. The two-file mutant that expresses "drop both"
   cannot be written in the single-file mutation harness, which mutates either
   `shu71-journal.mjs` or `shu71-production.mjs` but never both, so the pair is
   recorded here as an equivalent pair rather than as a shipped mutant. The
   comment at the clause states the same thing from the code side: the
   production-side check is the journal-side requirement restated against
   durable rows, so a retry in a fresh process that re-reads the log reaches it
   too.

##### New controls and new mutants

| New control (test name) | Proves |
| --- | --- |
| `B4 a teardown interrupted inside the removal loop retries on its durable receipt` | the receipt is durable **before** the interrupted unlink, the pair is left exactly half-removed, and the retry finishes it rather than refusing its own work |
| `B4 the removal receipt never waives custody of a present expiry timer unit file` | **F-01** on the `.timer`: receipt present, both files present, a second name planted on the inode — the retry halts by name before the command and unlinks nothing |
| `B4 the removal receipt never waives custody of a present expiry service unit file` | the same on the companion `.service`, which is also the half `EXPIRY_UNITS.every(...)` would stop measuring |
| `B4 a disable that exits non-zero for an installed timer is a refusal, not a retirement` | **F-03**: an `ACT_COMMAND_FAILED` for a journal-proven installed timer whose end state is otherwise spotless is a refusal, not a reported retirement |
| `B4 a disable that leaves the expiry unit active but not enabled is drift` | **F-04**: the `unitIdle` conjunct alone, reached with the enablement conjunct satisfied — the durable files of a still-active unit are not destroyed |
| `B4 a disable that leaves the expiry unit enabled but not active is drift` | **F-04**: the enablement conjunct alone, reached with `unitIdle` satisfied |
| `B4 a disable refused where the journal cannot vouch for the installation, mechanism retired` | a non-zero `disable` for a mechanism that really is absent completes rather than wedging, and removes nothing |
| `B4 a disable refused where the journal cannot vouch for the installation, mechanism present` | the same non-zero exit with the mechanism right there is drift and halts |
| `B4 an expiry mechanism installed but not yet ARMED is still journal-proven installed` | the `DONE expiry-watch` disjunct: custody drift in the window between the installation and `ARMED` still halts |

| New killing mutant | Control that kills it |
| --- | --- |
| `B1/B4 mutation: interrupted removal bypasses expiry custody` (restores `installed && !removing`) | `B4_EXPIRY_INTERRUPTED_CUSTODY_timer_REFUSED` |
| `B1/B4 mutation: interrupted removal bypasses companion custody` | `B4_EXPIRY_INTERRUPTED_CUSTODY_service_REFUSED` |
| `B1/B4 mutation: expiry removal receipt appended after the unlinks` | `B4_EXPIRY_INTERRUPTED_REMOVAL_RECEIPT_BEFORE_REMOVAL` |
| `B1/B4 mutation: expiry removal receipt never re-read` (`const removing = false`) | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` |
| `B1/B4 mutation: expiry disable exit-status refusal conjuncts dropped` | `B4_EXPIRY_DISABLE_EXIT_REFUSED` |
| `B1/B4 mutation: interrupted expiry disable refusal rejected` (drops `removing ||`) | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` |
| `B1/B4 mutation: uninstalled expiry disable refusal rejected` (drops `!installed && expiryRetired()`) | `B4_EXPIRY_UNINSTALLED_RETIRED_COMPLETES` |
| `B1/B4 mutation: uninstalled expiry disable accepted with the mechanism present` (drops `expiryRetired()`) | `B4_EXPIRY_UNINSTALLED_PRESENT_REFUSED` |
| `B1/B4 mutation: expiry post-condition unit liveness inert` | `B4_EXPIRY_POSTCONDITION_ACTIVE_UNITS_RETAINED` |
| `B1/B4 mutation: expiry post-condition enablement unchecked` | `B4_EXPIRY_POSTCONDITION_ENABLED_REFUSED` |
| `B1/B4 mutation: expiry installation proven only by ARMED` | `B4_EXPIRY_BEFORE_ARMED_REFUSED` |
| `B1/B4 mutation: expiry disable command never issued` | `B4_EXPIRY_RETIREMENT_COMPLETES` |
| `B1/B4 mutation: expiry removal issued with nothing to remove` | `B4_EXPIRY_UNINSTALLED_RETIRED_NOTHING_TO_REMOVE` |

The two existing pre-condition mutants keep their names and their killing
assertions; only their source anchors moved with the clause
(`installed expiry pre-condition omitted`, `expiry companion service file
unchecked`). No assertion, name, code, skip, timeout or deadline was weakened,
renamed or deleted, and `expiryPostConditionCheck` is untouched — the two
conjunct controls are additional, not a replacement, so its combined refusal
stays pinned exactly as before.

##### Measured replays, outside the suite

Every one of the thirteen new mutants, plus the existing
`expiry companion service file unchecked` against the new service-side control,
was replayed on its own copy of the module outside the suite and observed to die
by the exact named assertion the table above credits — fourteen replays,
fourteen kills, no survivors.

The **F-01** mutant (the shipped `installed && !removing` restored) was replayed
against the verifier's own demonstrated state, and reproduces its report
exactly:

```
run     : ARMED
revoke#1: {"code":"ACT_CLEANUP_FAILED","failures":["ACT_TEARDOWN_EXPIRY_TIMER"]}
receipt : true   both files present: true
revoke#2: {"ok":true,"state":"REVOKED","failures":[]}
unit path removed: true | second name still resolves to the same inode: true
```

That is the whole defect in five lines: a clean retirement reported, the unit
path unlinked, and a second name still holding the inode systemd loaded. With
the correction, `revoke#2` is
`{"ok":false,"code":"ACT_CLEANUP_FAILED","failures":["ACT_TEARDOWN_EXPIRY_TIMER"]}`,
no `disable --now` is issued and neither unit file is unlinked.

The defence-in-depth pair (equivalent mutant 3 above) was measured the same way,
on a teardown whose worker kill fails:

| Variant | reported code | `disable --now` issued | receipt written | both unit files still present |
| --- | --- | --- | --- | --- |
| baseline | `ACT_CLEANUP_FAILED` | no | no | yes |
| production-side guard removed | `ACT_CLEANUP_FAILED` | no | no | yes |
| journal-side guard removed | `ACT_CLEANUP_FAILED` | no | no | yes |
| **both removed** | `ACT_CLEANUP_FAILED` | **yes** | **yes** | **no** |

Each guard alone is therefore an equivalent mutant, and the pair is load-bearing
exactly once: removing both retires the expiry mechanism against a teardown that
failed. No single-file mutant can express that, which is why the pair is
recorded as an equivalent pair with this measurement rather than as a shipped
mutant.

#### Validation of the second correction round

Tested implementation `0f6f04a1860a5e627a89c0daeb6b853245e20307`, tree
`0861e981c38dc458a86a6293842b3f5cc4be0e27`. All four commands ran from the
repository root under the CI-like harness
(`service/test/fixture/shu71-ci-like.sh`): UID 1000, `umask 0022`, target
accounts absent (`shu-coordinator`, `shu-supervisor`, `shu71-evidence`,
`shu-workspace`, `messagebus`), `/run` and `/etc/sudoers.d` tmpfs,
`/run/shu71-evidence` and `/etc/sudoers.d/shu-reviewer` absent,
`chmod -R go-w .github/coordinator`, `taskset -c 0-3 node --test
--test-concurrency=2`, with both the TAP reporter and the unchanged
`host-suite-contract.mjs` reporter writing separate outputs. Plain unsets
`NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit | Load at start → end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Focused plain | 1594 | 1593 | 0 | 1 | 1 / 1 | 0 | 0.68 → 2.84 |
| Focused clock | 1594 | 1593 | 0 | 1 | 1 / 1 | 0 | 1.42 → 2.12 |
| Full plain | 3307 | 3299 | 0 | 8 | 1 / 1 | 0 | 1.79 → 2.38 |
| Full clock | 3307 | 3299 | 0 | 8 | 1 / 1 | 0 | 2.51 → 3.03 |

Every command exited zero with zero cancelled and zero todo outcomes, and no
`not ok` line. Focused TAP plans are `1..1594`; full plans are `1..3302`, with
five nested outcomes bringing each full total to 3,307. Each run's structured
report has exactly one terminal `complete` event, is terminated by it, and
passes the unchanged `evaluateSuite` validator. Both full runs' 3,307 outcome
names are exactly the committed inventory's 3,307 names, with identical
multiplicities, and `A12 committed inventory requirements match real outcomes`
passes in both (`ok 2091`). Node's concurrent scheduler interleaves files, so
the *sequence* of outcome names differs between runs and from the inventory's
recorded order; the A12 guard compares the name set and its requirement rows,
which is what both full runs satisfy. Every skip in all four runs is a
`PERMITTED_SKIPS` entry carrying that entry's exact documented reason,
byte-for-byte; the single focused skip is
`SHU-71 restricted capability refusal`.

The focused selection is the sixteen-entry list printed above for the previous
correction round, unchanged; every file this round touches is already in it. The
focused total is the previous round's 1,572 plus this round's 22 inventory
names: 1,594. The full total is 3,285 plus the same 22: 3,307. The full
selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`.

`PERMITTED_SKIPS` is byte-identical to `9e1a2d0`: **1,093 bytes** including its
final newline, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. The entire
`host-suite-contract.mjs` is unchanged, SHA-256
`2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`. Inventories
are strictly additive: 113 test files unchanged, 3,285 → 3,307 names and
requirement rows, zero removals and zero dropped requirement rows; no test file
was added. The reviewed teardown effects set and its order are unchanged. The
production change is one clause and its comment in `retireExpiryTimer()`, ten
added lines, which moved three documentation line-number links
(`shu71-production.mjs#L663` → `#L673` in `SHU71-PREREQUISITES.md` and
`SHU71-L3-CLOSURE.md`, and `#L607` → `#L617`); `V8_DOCUMENTATION_LINK_TARGETS`
passes, including its own one-line-drift mutant. Only files under
`.github/coordinator/**` changed; no push or PR was performed.

Nothing was left inconsistent this round.

#### Third correction round: custody is a property of the removal

A fresh independent verifier reviewed
`f6d6711056f0356a010f28aeae3c6c70c20018cd` and returned **BLOCK** on the same
property, for the third time, through a third door. This is the history that
matters, because it is what the fix has to answer:

| Round | Shape of the pre-condition | Door it left open |
| --- | --- | --- |
| `9e1a2d0a` (original defect) | none at all | everything |
| first correction | `if (installed && !removing) …` | the durable receipt — the retry path |
| second correction | `if (installed) …` | `installed === false` — an interrupted install or a recovered log |

Each round patched the door it had been shown and left the shape — *a journal
condition in front of a custody measurement* — intact. **P154C-01** demonstrated
the third door: with an install interrupted before its durable `DONE` row, or
with a recovered log, `installed` is false, the whole clause is skipped, and the
removal loop below still disables, unlinks and reports a clean retirement for a
PRESENT durable unit file that has drifted out of root custody.

So this round changes the structure rather than the condition. The rule is now
stated once, at the top of the function, and the code has no journal-gated
removal left to reintroduce:

> **Custody is a property of the removal, not of the journal.** Every durable
> expiry unit file that is PRESENT is measured and must be held in root custody
> — regular file, not a symlink, `nlink === 1`, `uid === 0`, `gid === 0`, and
> neither group- nor world-writable — before this teardown disables anything,
> and measured again immediately before the unlink. A present file that fails
> custody refuses by name whatever `installed`, `removing`, the durable receipt
> or a recovered log say.
>
> **The journal's only role is ABSENCE.** A missing unit file must be accounted
> for — by the branch where the journal proves the mechanism was never created,
> by the durable removal receipt that proves THIS teardown already began the
> removal, or, where the journal vouches for nothing at all, by a MEASURED
> fully retired mechanism rather than by any journal claim — and in every one of
> those cases each PRESENT file still passes the custody measurement.

In code, the one clause of the previous rounds is now two requirements that
cannot be confused with each other:

```js
// journal-independent: takes no journal argument, gates on nothing, and runs
// before the never-created branch, so no path reaches an effect without it
const custodyOfPresentUnits = () => EXPIRY_UNITS.every(file => unitFileAbsent(file) || expiryUnitCustody(file));
const requireCustodyOfPresentUnits = () => need(measuredPredicate(custodyOfPresentUnits), 'ACT_TEARDOWN_DRIFT');
requireCustodyOfPresentUnits();
if (lifecyclePhase(journal, 'expiry-watch') === 'never') { need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT'); return; }
// absence, accounted for — the ONLY thing the journal decides here
need(measuredPredicate(() => removing || EXPIRY_UNITS.every(file => !unitFileAbsent(file))
  || !installed && expiryRetired()), 'ACT_TEARDOWN_DRIFT');
```

and, immediately before the unlink, the second measurement:

```js
if (measuredPredicate(() => !EXPIRY_UNITS.every(unitFileAbsent))) {
  requireCustodyOfPresentUnits();
  if (!removing) journal.append({ event: 'EXPIRY_RETIREMENT_STARTED' });
  for (const file of EXPIRY_UNITS) remove(file);
}
```

Why the presence requirement still reads the journal and the custody
requirement does not: `disable --now` needs a unit file that EXISTS, and systemd
will happily disable a unit it still holds loaded whose file was deleted or
replaced underneath it — that success must never absorb the drift. So where the
journal proves this episode installed the mechanism, BOTH durable unit files
must still be there before the command is issued, unless the receipt explains
the gap. That is a statement about presence, which is what the command
requires. The custody measurement is a statement about the file we are about to
destroy, which no journal row can vouch for, so it is conditioned on nothing.

The restructure is strictly stronger than the clause it replaces. For
`installed && !removing` it still demands both files present and both in
custody; for `installed && removing` it still accepts an absent file and still
measures a present one; and for `!installed` — the door P154C-01 opened — it now
measures every present file where the previous shape measured none.

##### The absence rule, and the one place it is narrower than "nothing else"

The rule says absence must be accounted for. Three accounts exist, and the third
is not a journal claim:

1. the never-created branch (`lifecyclePhase(...) === 'never'`), which does not
   merely tolerate absence but *requires* the whole mechanism to be retired;
2. the durable removal receipt (`removing`), which accounts for the completed
   half of this teardown's own interrupted removal;
3. where the journal accounts for nothing — a recovered log, or an install
   interrupted before its durable `DONE` row — a **measured** `expiryRetired()`:
   absent on disk, idle, and not enabled.

The third is the only tolerance not derived from a journal row, and it is
recorded deliberately rather than silently. Removing it would delete the shipped
`B4_EXPIRY_UNINSTALLED_RETIRED_COMPLETES` assertion, which requires a teardown
whose journal cannot vouch for the installation, and whose mechanism really is
gone, to complete rather than wedge for ever. It is not the journal excusing
absence — it is a measurement of the exact end state the retirement is trying to
reach. What the rule newly refuses, and the shipped code before this round
accepted, is the **half-present** mechanism: one durable unit file gone, the
other right there in perfect custody, with no receipt and no journal account of
the gap. That was previously disabled, unlinked and reported as a clean
retirement; it is now drift, refused before any command is issued.

##### Every load-bearing clause and ordering of the RESTRUCTURED `retireExpiryTimer`

Re-issued in full for the new shape. Each row is a clause or an ordering of
`retireExpiryTimer()` or of what it calls, with the control that pins it, the
mutant that control kills, and whether that kill was re-verified by hand this
round. Attack this table rather than rediscovering it. Control names are
assertion names; mutant names are the `B1/B4 mutation:` test names.

| Clause or ordering | Named control | Named killing mutant | Kill |
| --- | --- | --- | --- |
| `installed` — the `journalHas(journal, 'DONE', 'expiry-watch')` disjunct | `B4_EXPIRY_VANISHED_DONE_ROW_REFUSED` | `expiry installation proven only by ARMED` | verified |
| `installed` — the `journalHas(journal, 'ARMED')` disjunct | ~~*equivalent mutant, reasoning below*~~ **falsified by P154D-01; pinned in the fourth round's table below** | `expiry installation proven only by the DONE row` | verified |
| `removing` — the receipt derivation | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `expiry removal receipt never re-read` | verified |
| **P154C-01** custody NOT gated on journal-proven installation | `B4_EXPIRY_JOURNAL_BLIND_CUSTODY_interrupted-install_hardlinked-timer_REFUSED` | `expiry custody conditioned on journal-proven installation` | verified |
| **P154C-01** custody NOT gated on a recovered log | `B4_EXPIRY_JOURNAL_BLIND_CUSTODY_recovered_hardlinked-timer_REFUSED` | `expiry custody conditioned on a recovered log` | verified |
| custody NOT gated on the durable removal receipt (the F-01 door) | `B4_EXPIRY_INTERRUPTED_CUSTODY_timer_REFUSED`, `…_service_REFUSED` | `interrupted removal bypasses expiry custody`, `… companion custody` | verified |
| custody measured over BOTH durable unit files | `B4_EXPIRY_CUSTODY_REFUSED_hardlinked-service` | `expiry custody predicate ignores the companion unit file` | verified |
| custody's `unitFileAbsent(file) ||` tolerance of an absent file | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `expiry custody measured on absent unit files` | verified |
| custody measured BEFORE `disable --now` | `B4_EXPIRY_CUSTODY_BEFORE_DISABLE_non-root-owner` | `expiry custody measured only after the disable` | verified |
| custody measured AGAIN immediately before the unlink | `B4_EXPIRY_UNLINK_CUSTODY_REFUSED` | `expiry custody never re-measured before the unlink` | verified |
| custody `s.isFile()` | `B4_EXPIRY_CUSTODY_REFUSED_non-regular-file` | `expiry unit file shape unchecked` | verified |
| custody `s.nlink === 1` | `B4_EXPIRY_CUSTODY_REFUSED_hardlinked-timer`, `…-service` | `expiry unit hardlink unchecked` | verified |
| custody `s.uid === 0` | `B4_EXPIRY_CUSTODY_REFUSED_non-root-owner` | `expiry unit owner unchecked` | verified |
| custody `s.gid === 0` | `B4_EXPIRY_CUSTODY_REFUSED_non-root-group` | `expiry unit group unchecked` | verified |
| custody `!(s.mode & 0o020)` | `B4_EXPIRY_CUSTODY_REFUSED_group-writable` | `expiry unit group-writable mode accepted` | verified |
| custody `!(s.mode & 0o002)` | `B4_EXPIRY_CUSTODY_REFUSED_world-writable` | `expiry unit world-writable mode accepted` | verified |
| the custody term predicate as a whole | `B4_EXPIRY_CUSTODY_REFUSED_non-root-owner` | `expiry unit custody predicate vacuous` | verified |
| custody `!s.isSymbolicLink()` | *equivalent mutant, documented at the predicate* | — | n/a |
| the `never` early branch and its `need(expiryRetired)` | `B4_PREARM_DRIFT_REFUSED_both-files` | `pre-arm expiry drift silently accepted` | verified |
| `lifecyclePhase`'s `journal.recovered` conjunct | `B4_RECOVERED_NOT_PROOF_OF_NON_CREATION` | `recovered log accepted as non-creation proof` | verified |
| `lifecyclePhase`'s `RUN_ATTEMPT_STARTED` conjunct | `B4_DESTROYED_JOURNAL_NOT_PROOF` | `non-creation inferred from an empty journal` | verified |
| the absence clause as a whole | `B4_EXPIRY_FILE_DRIFT_REFUSED_timer` | `installed expiry pre-condition omitted` | verified |
| absence — presence of the companion `.service` file | `B4_EXPIRY_FILE_DRIFT_REFUSED_service` | `expiry companion service file unchecked` | verified |
| absence — the `removing ||` disjunct | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `expiry presence pre-condition ignores the removal receipt` | verified |
| absence — the `|| !installed && expiryRetired()` disjunct | `B4_EXPIRY_UNINSTALLED_RETIRED_COMMAND_ISSUED` | `unaccounted expiry absence accepted` | verified |
| absence — its `!installed &&` half | `B4_EXPIRY_VANISHED_ARMED_BEFORE_DISABLE` | `journal-proven installed expiry absence accepted` | verified |
| absence — its `expiryRetired()` half | `B4_EXPIRY_ABSENCE_interrupted-install_half_REFUSED` | `unretired expiry absence accepted` | verified |
| the `disable --now` command itself | `B4_EXPIRY_RETIREMENT_COMPLETES` | `expiry disable command never issued` | verified |
| catch door A — a throw carrying **no** `ACT_COMMAND_FAILED` code | `B4_EXPIRY_DISABLE_FAILURE_NOT_SILENT` | `refused expiry disable blindly accepted` | verified |
| catch door B — `systemctl disable` **exiting non-zero** | `B4_EXPIRY_DISABLE_EXIT_REFUSED` | `expiry disable exit-status refusal conjuncts dropped` | verified |
| catch conjunct `removing ||` | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `interrupted expiry disable refusal rejected` | verified |
| catch conjunct `!installed && …` | `B4_EXPIRY_UNINSTALLED_RETIRED_COMPLETES` | `uninstalled expiry disable refusal rejected` | verified |
| catch conjunct `… && expiryRetired()` | `B4_EXPIRY_UNINSTALLED_PRESENT_REFUSED` | `uninstalled expiry disable accepted with the mechanism present` | verified |
| post-condition conjunct `unitIdle(expiryTimerUnit)` | `B4_EXPIRY_POSTCONDITION_ACTIVE_UNITS_RETAINED` | `expiry post-condition unit liveness inert` | verified |
| post-condition conjunct `UnitFileState ∉ {enabled, enabled-runtime}` | `B4_EXPIRY_POSTCONDITION_ENABLED_REFUSED` | `expiry post-condition enablement unchecked` | verified |
| the post-condition as a whole | `B4_EXPIRY_POSTCONDITION_UNITS_RETAINED` | `expiry end state never measured` | verified |
| the removal loop | `B4_EXPIRY_RETIREMENT_COMPLETES` | `retired expiry units left behind` | verified |
| the removal loop's `!EXPIRY_UNITS.every(unitFileAbsent)` guard | `B4_EXPIRY_UNINSTALLED_RETIRED_NOTHING_TO_REMOVE` | `expiry removal issued with nothing to remove` | verified |
| the receipt append | `B4_EXPIRY_RETIREMENT_RECEIPT` | `expiry retirement receipt omitted` | verified |
| the receipt append's POSITION, before the loop | `B4_EXPIRY_INTERRUPTED_REMOVAL_RECEIPT_BEFORE_REMOVAL` | `expiry removal receipt appended after the unlinks` | verified |
| the `daemon-reload` on a stale loaded view | `B4_EXPIRY_RELOAD_REFRESHES_UNIT_VIEW` | `stale unit view never refreshed` | verified |
| the post-reload re-measure | `B4_EXPIRY_POST_RELOAD_REFUSED` | `post-reload expiry end state never measured` | verified |
| **P154C-03** `expiryRetired()`'s absence conjunct | `B4_PREARM_DRIFT_REFUSED_service-file` | `expiry retirement ignores the companion unit file` | verified |
| **P154C-03** `expiryRetired()`'s liveness conjunct `unitIdle(…)` | `B4_PREARM_DRIFT_REFUSED_timer-active` | `expiry retirement ignores unit liveness` | verified |
| **P154C-03** `expiryRetired()`'s enablement conjunct | `B4_EXPIRY_CACHED_VIEW_RELOADED` | `expiry retirement ignores unit enablement` | verified |
| `observeRetiredExpiry()` on the retired episode's receipt path | `B4_RETIRED_EPISODE_EXPIRY_DRIFT` | `retired episode expiry drift unobserved` | verified |
| `observeTeardown()` re-run immediately before the retirement | `B4_RETIREMENT_REOBSERVATION` | `P1 retirement re-observation removed` | shipped |
| the effect's durable-`DONE` pre-condition (defence in depth) | *equivalent pair, reasoning below* | — | n/a |

`verified` means the killing assertion named in the control column was CAPTURED
BY NAME this round, by an instrumented replay that recorded, for every mutant in
`shu71-production-mutations.test.mjs`, the exact assertion whose failure killed
it — not inferred from the mutation test passing. Every `verified` control name
above is a name that replay printed; fifty-nine mutants, fifty-nine kills, no
survivors. The single `shipped` row is the one whose mutant lives in another
file (`recovery mutation: P1 retirement re-observation removed`), which that
replay did not instrument and which runs in the suite on every invocation. Every
row has both a control and a mutant, or an equivalent-mutant entry with its
reasoning. There are **no rows with neither**, and no row is marked "covered by
another".

The three equivalent mutants are unchanged from the previous round and were
re-attacked this round rather than carried over on trust:

1. `!s.isSymbolicLink()` in `expiryUnitCustody`. `s` is an `lstat` result, so a
   symlink already fails `isFile()`; removing the term alone cannot change any
   outcome. Confirmed as genuine by the previous verifier's **F-07**.
2. ~~The `journalHas(journal, 'ARMED')` disjunct of `installed`.~~ **This entry
   was WRONG and P154D-01 falsified it.** The argument it made — "every journal
   this module can produce, including a recovered log, is prefix-closed, so no
   journal that holds `ARMED` can lack the `DONE` row" — is about the WRITER.
   The clause is evaluated against whatever the READER accepts, and
   `openActivationJournal` accepts `recovery.jsonl` on a keyless sha256 chain
   with no prefix check at all, so a chain-valid log holding `ARMED` with the
   `DONE`/`expiry-watch` row removed and the chain recomputed is inside the
   reader's input space. The disjunct is retained and is now pinned by
   `B4_EXPIRY_ARMED_WITHOUT_DONE_ROW_REFUSED` and its mutant `expiry
   installation proven only by the DONE row`, in the fourth round's table below.
   The second disjunct is **not** equivalent either and is pinned in the table
   above.
3. The `expiry-timer` effect's durable-`DONE` pre-condition and the in-memory
   guard it duplicates (`shu71-journal.mjs`, `if (step === 'expiry-timer' &&
   failures.length)`) are a deliberately redundant **pair**: each alone produces
   the identical refusal, so each single-guard mutant survives, and the
   two-file mutant that expresses "drop both" cannot be written in a harness
   that mutates one file at a time. The measurement is recorded in the previous
   round's table and is unchanged by this round's restructure, which touches
   neither guard.

##### New controls and new mutants

| New control (test name) | Proves |
| --- | --- |
| `B4 an install interrupted before its durable row still holds a present expiry unit file in custody, <variant>` (× 7) | **P154C-01** fixture (a): no ARMED, no `DONE` row, no receipt, both durable unit files present, one custody term broken — and one per term — halts by name before the command, unlinks nothing, writes no receipt; with custody restored in the SAME journal state the retirement completes and removes both (fixture (d)) |
| `B4 a recovered log never waives custody of a present expiry unit file, <variant>` (× 2) | fixture (b): the same on a recovered log, on each durable unit file in turn |
| `B4 the removal receipt never waives custody of a present expiry <unit> unit file` (× 2, shipped) | fixture (c): receipt present, both files present, custody broken on one — unchanged from the previous round and still the control for the receipt door |
| `B4 a journal that accounts for nothing excuses expiry absence only when measurably retired, <state> <shape>` (× 3) | fixture (e): `retired` — the mechanism really is gone, idle and not enabled, and the teardown completes rather than wedging; `half` — one unit file gone and the other in perfect custody is drift, refused before the command, in both journal-blind states |
| `B4 a journal-proven installed expiry mechanism that vanished entirely is drift, <proof>` (× 2) | the `!installed` half of the absence rule, with installation proven by `ARMED` and by the durable `DONE` row alone |
| `B4 expiry custody is measured again immediately before the unlink` | the SECOND measurement: a second name planted on the inode *by the disable itself* is refused before the unlink, so the retirement never destroys the unit path while the inode's other holder keeps the file |
| `B4 pre-arm teardown refuses both-files drift by name` | the drift only the never-created branch refuses: both unit files present and in perfect root custody for a mechanism the journal proves was never created |
| `B4 pre-arm teardown refuses service-file drift by name` | the absence conjunct of `expiryRetired()` on the COMPANION file: only the `.service` unit is left behind, so every other term of the predicate is satisfied and only `EXPIRY_UNITS.every(unitFileAbsent)` can refuse it |

| New killing mutant | Control that kills it |
| --- | --- |
| `B1/B4 mutation: expiry custody conditioned on journal-proven installation` | `B4_EXPIRY_JOURNAL_BLIND_CUSTODY_interrupted-install_hardlinked-timer_REFUSED` |
| `B1/B4 mutation: expiry custody conditioned on a recovered log` | `B4_EXPIRY_JOURNAL_BLIND_CUSTODY_recovered_hardlinked-timer_REFUSED` |
| `B1/B4 mutation: expiry custody predicate ignores the companion unit file` | `B4_EXPIRY_CUSTODY_REFUSED_hardlinked-service` |
| `B1/B4 mutation: expiry custody measured on absent unit files` | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` |
| `B1/B4 mutation: expiry custody measured only after the disable` | `B4_EXPIRY_CUSTODY_BEFORE_DISABLE_non-root-owner` |
| `B1/B4 mutation: expiry custody never re-measured before the unlink` | `B4_EXPIRY_UNLINK_CUSTODY_REFUSED` |
| `B1/B4 mutation: expiry presence pre-condition ignores the removal receipt` | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` |
| `B1/B4 mutation: unaccounted expiry absence accepted` | `B4_EXPIRY_UNINSTALLED_RETIRED_COMPLETES` |
| `B1/B4 mutation: journal-proven installed expiry absence accepted` | `B4_EXPIRY_VANISHED_ARMED_BEFORE_DISABLE` |
| `B1/B4 mutation: unretired expiry absence accepted` | `B4_EXPIRY_ABSENCE_interrupted-install_half_REFUSED` |
| `B1/B4 mutation: expiry retirement ignores unit enablement` | `B4_EXPIRY_CACHED_VIEW_RELOADED` |
| `B1/B4 mutation: expiry retirement ignores the companion unit file` | `B4_PREARM_DRIFT_REFUSED_service-file` |

Four existing mutants keep their names and their assertions and changed only
what they are anchored on or which control kills them, because the restructure
moved or subsumed what they used to express. Each is recorded here rather than
left to be rediscovered:

* `installed expiry pre-condition omitted` and `expiry companion service file
  unchecked` now anchor on the ABSENCE clause, which is the part of the old
  combined clause that survives as a journal-conditioned requirement. Their
  controls (`expiryFileDriftCheck`, timer and service) are unchanged.
* `interrupted removal bypasses expiry custody` and `… companion custody` now
  reintroduce the F-01 door by conditioning the custody PREDICATE on `removing`,
  which waives it at both measurement points at once — the faithful form of that
  defect under the new structure. Their controls are unchanged.
* `pre-arm expiry drift silently accepted` is now killed by the `both-files`
  drift instead of `timer-file`. This is a correction, not a weakening: the new
  absence clause also refuses a half-present mechanism, so `timer-file` no
  longer distinguishes the never-created branch, and only a pair that is fully
  present and in perfect custody does. The `timer-file` control itself still
  runs and still passes.
* `expiry installation proven only by ARMED` is now killed by
  `B4_EXPIRY_VANISHED_DONE_ROW_REFUSED`. `installed` no longer gates custody at
  all, so the disjunct is observable only where a unit file is ABSENT — which is
  exactly what the new control constructs. `expiryInstalledBeforeArmedCheck` is
  untouched and still runs.

**P154C-03** is fixed by splitting, not by re-attributing a claim: the mutant
`expiry retirement ignores unit liveness` now deletes ONLY the
`unitIdle(expiryTimerUnit)` conjunct, which is the half
`B4_PREARM_DRIFT_REFUSED_timer-active` actually reaches, and the new mutant
`expiry retirement ignores unit enablement` deletes only the `UnitFileState`
conjunct, killed by `B4_EXPIRY_CACHED_VIEW_RELOADED` — a state where the unit is
measurably idle and the removal has already happened, so only the enablement
half can still be false and force the `daemon-reload`. The old combined mutant
also deleted `expiryRetired()`'s FIRST conjunct, `EXPIRY_UNITS.every(
unitFileAbsent)`, which nothing named either; that conjunct now has its own
mutant (`expiry retirement ignores the companion unit file`) and its own control
(`B4_PREARM_DRIFT_REFUSED_service-file`). Finding that control took a measured
search rather than an assumption: deleting the conjunct survives every other
control in this area, because the timer's own `UnitFileState` already covers the
timer file, so only a leftover COMPANION `.service` file distinguishes the
mutant at all. Each of the three conjuncts is now killed independently by the
control the table names.

**P154C-04** is fixed by ADDING a rule, not by narrowing the alternation and not
by softening the comment. **P154D-05 corrects this paragraph**, which previously
said "fixed by narrowing the pattern": the alternation in
`shu71-verdict-closures.test.mjs` was WIDENED, not narrowed — an alternative
`function sharedAccess\(` was added to it when `SHU71-L3-CLOSURE.md` split one
broker-identity link in two, and it is still there. What removes the
swappability is the new text-to-definition rule, and nothing else:
`V8_DOCUMENTATION_LINK_TARGETS` now reads the link TEXT, and where the text
names a symbol as `` `name()` `` **and** the target is a function DEFINITION
line, that definition must be `name`'s own, so `identity()` and
`sharedAccess()` can no longer be exchanged. The control is not weakened by this
correction; only the sentence describing it is. Verified by hand: swapping the two targets in
`SHU71-L3-CLOSURE.md` fails the test, and swapping them back passes it. The
in-test comment now states exactly two claims and no more — the alternation with
the exact line number, and the text-to-definition rule — and explicitly records
what it does **not** claim about links whose text names no symbol, or whose
target is a call site rather than a definition (the `precondition()` link).

#### Validation of the third correction round

Tested implementation `4ecf4abd80ced7229a463df8cc3740ab77e31419`, tree
`9d9df4b2a32ee52d55fb5e60a6400b6c9f4021d3`. All four commands ran from the
repository root under the CI-like harness
(`service/test/fixture/shu71-ci-like.sh`), which printed
`CI_CONSTRAINTS uid=1000 umask=0022 target_accounts=absent runtime=absent
reviewer=absent` for each: UID 1000, `umask 0022`, target accounts absent
(`shu-coordinator`, `shu-supervisor`, `shu71-evidence`, `shu-workspace`,
`messagebus`), `/run` and `/etc/sudoers.d` tmpfs, `/run/shu71-evidence` and
`/etc/sudoers.d/shu-reviewer` absent, `chmod -R go-w .github/coordinator`,
`taskset -c 0-3 node --test --test-concurrency=2`, with both the TAP reporter
and the unchanged `host-suite-contract.mjs` reporter writing separate outputs.
Plain unsets `NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit | Load at start → end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Focused plain | 1623 | 1622 | 0 | 1 | 1 / 1 | 0 | 0.12 → 2.15 |
| Focused clock | 1623 | 1622 | 0 | 1 | 1 / 1 | 0 | 2.15 → 2.61 |
| Full plain | 3336 | 3328 | 0 | 8 | 1 / 1 | 0 | 2.61 → 2.49 |
| Full clock | 3336 | 3328 | 0 | 8 | 1 / 1 | 0 | 2.49 → 2.51 |

Every command exited zero with zero cancelled and zero todo outcomes, and no
`not ok` line in any of the four TAP outputs. Focused TAP plans are `1..1623`;
full plans are `1..3331`, with five nested outcomes bringing each full total to
3,336. Each run's structured report has exactly one terminal `complete` event,
is terminated by it, and passes the unchanged `evaluateSuite` validator
(1,623 / 1,623 / 3,336 / 3,336 expected outcomes). Both full runs' 3,336 outcome
names are exactly the committed inventory's 3,336 names, with identical
multiplicities — zero missing and zero extra — and `A12 committed inventory
requirements match real outcomes` passes in both (`ok 2120`). Node's concurrent
scheduler interleaves files, so the *sequence* of outcome names differs between
runs and from the inventory's recorded order; the A12 guard compares the name
set and its requirement rows, which is what both full runs satisfy. Every skip
in all four runs is a `PERMITTED_SKIPS` entry carrying that entry's exact
documented reason, byte-for-byte (checked against the exported object, not by
eye); the single focused skip is `SHU-71 restricted capability refusal`.

The focused selection is the sixteen-entry list printed for the previous
correction round, unchanged — every file this round touches is already in it —
which expands to 23 test files. The focused total is the previous round's 1,594
plus this round's 29 inventory names: 1,623. The full total is 3,307 plus the
same 29: 3,336. The full selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
(113 files, unchanged).

Every mutant in `shu71-production-mutations.test.mjs` was additionally replayed
this round under an instrumented harness that recorded the exact assertion whose
failure killed it: **59 mutants, 59 kills, no survivors**, and every control
name in the clause table above is a name that replay printed. Three corrections
to the table came out of that replay rather than out of reasoning — the removal
loop is killed by `B4_EXPIRY_RETIREMENT_COMPLETES` and not
`B4_EXPIRY_UNITS_REMOVED`, the stale-view reload by
`B4_EXPIRY_RELOAD_REFRESHES_UNIT_VIEW` and not `B4_EXPIRY_CACHED_VIEW_RELOADED`,
and `unaccounted expiry absence accepted` by
`B4_EXPIRY_UNINSTALLED_RETIRED_COMMAND_ISSUED` and not `…_COMPLETES` — which is
the reason the replay was run at all.

`PERMITTED_SKIPS` is byte-identical to `9e1a2d0`: **1,093 bytes** including its
final newline, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. The entire
`host-suite-contract.mjs` is unchanged, SHA-256
`2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`. Inventories
are strictly additive: 113 test files unchanged, 3,307 → 3,336 names and
requirement rows in a 145-insertion / 0-deletion diff, zero removals and zero
dropped requirement rows; no test file was added. The reviewed teardown effects
set and its order are unchanged. The production change moved three documentation
line-number links (`shu71-production.mjs#L673` → `#L702` in
`SHU71-PREREQUISITES.md` and `SHU71-L3-CLOSURE.md`, and `#L617` → `#L646`);
`V8_DOCUMENTATION_LINK_TARGETS` passes, including its own one-line-drift mutant
and its new text-to-definition rule. Only files under `.github/coordinator/**`
changed; no push or PR was performed.

##### What could not be made consistent

One thing, stated rather than smoothed over. The owner's rule says absence may
be excused only by the never-created branch or by the durable removal receipt,
and that "nothing else may excuse absence". The shipped assertion
`B4_EXPIRY_UNINSTALLED_RETIRED_COMPLETES` requires a third case to be accepted:
a teardown whose journal can vouch for nothing, whose expiry mechanism is
measurably and entirely gone — absent on disk, idle, not enabled — must complete
rather than wedge for ever. Making the rule literally exact would have deleted
that assertion, which this lane is not permitted to do and which is right on its
own terms. So the code carries the third tolerance explicitly
(`|| !installed && expiryRetired()`), it is pinned by its own control and mutant
in the table above, and it is a MEASUREMENT of the end state rather than a
journal claim: no journal row can satisfy it. The half-present mechanism — the
case where that tolerance would actually hide drift — is now refused, which it
was not before this round. Everything else in P154C-01 through P154C-04 is
consistent, and nothing else was left open.

#### Fourth correction round: the expiry mechanism is TWO units

A fourth independent verifier (family-separated) attacked
`56a1a33334e209ff4d90eb464342ddee22922f69` and could not reopen the custody
defect through any of five doors — installed, interrupted install, recovered
log, retry-with-receipt, half-present journal-blind. It could construct no state
in which a PRESENT, out-of-custody durable expiry unit file is unlinked, and no
state in which drift is reported as a clean retirement *on the custody
property*. Thirty of its thirty-one mutants died; the survivor is the one this
document also calls equivalent. **The custody restructure holds and nothing
about it is redesigned by this round.**

What it found instead is that the disclosed end-state tolerance measured the
WRONG SCOPE. `shu71-expiry-<id>.timer` exists for exactly one purpose: to start
`shu71-expiry-<id>.service`. `disable --now <timer>` stops the timer and does
not touch the service. Yet `expiryRetired()` measured `ActiveState` and
`UnitFileState` of **the timer only**, and `observeTeardown()` covers only
`SERVICES` + `shu71-evidence.service`, so nothing in the module ever measured
the companion's liveness at all. The verifier's `V154D_PROBE_service` state —
journal-blind on a recovered log, BOTH durable unit files deleted, no removal
receipt, timer `ActiveState=inactive` with an empty `UnitFileState`, and the
companion service measurably **active** — returned
`{"ok":true,"state":"REVOKED","code":null,"failures":[]}`, issued no
`stop shu71-expiry-` command, and left the companion running. The sentence "the
mechanism is measurably and entirely gone" overstated what was measured, and a
state that reports success while the mechanism was not actually retired is
blocking whatever its width.

##### P154D-02, and which of the two mechanisms this round implemented

**HALT by name. Not stop-then-verify.** Stated plainly because the owner's brief
allows either and requires the choice to be disclosed:

* A refusal needs no new reviewed effect, and this lane's rules hold the
  reviewed effects set unchanged. Stopping the companion would be a new,
  separately reviewed effect with its own custody discipline and its own
  re-measurement, which those rules forbid this lane from adding.
* Issuing `systemctl stop shu71-expiry-<id>.service` is not a safe default
  anywhere near this code path. In production the expiry timer's whole job is to
  START that service, and the service's `ExecStart` is
  `/usr/bin/node <installedModule> expire <id>` — so on the automatic expiry
  path the live companion may be the very process performing the teardown. A
  "stop" there is the teardown SIGTERMing itself, under `Restart=on-failure`.
* The state the verifier measured — a companion running with both durable unit
  files already deleted and no receipt — is not a legitimate teardown in
  progress under any reading. Refusing it is the correct outcome, not a
  convenience.

The refusal carries its own name, `ACT_TEARDOWN_EXPIRY_SERVICE`, raised by
`requireIdleExpiryCompanion()`:

```js
const requireIdleExpiryCompanion = () => need(measuredPredicate(() => unitIdle(expiryServiceUnit)), 'ACT_TEARDOWN_EXPIRY_SERVICE');
```

> **Superseded in place by P154D-06 below, and only in its companion-LIVENESS
> term.** The predicate as printed here refused the invocation performing the
> removal, which is the regression the fifth round fixes; the shipped form is
> `need(measuredPredicate(() => !expiryCompanionSurvivesRemoval()), 'ACT_TEARDOWN_EXPIRY_SERVICE')`.
> The name, the three statement sites, the ordering before `disable --now` and
> every file and enablement term are unchanged by that round.

and it is stated in three places, each pinned by its own control and mutant:

1. in `retireExpiryTimer()`, after the never-created branch and **before the
   absence clause and before `disable --now`**, so nothing is ever disabled
   around a live companion and no unit file is ever unlinked under one;
2. in `observeRetiredExpiry()`, so the retired episode's own receipt path
   refuses a companion that came back;
3. in `teardownActivation()` (`shu71-journal.mjs`), which now pushes the code
   into `failures[]` alongside the reviewed effect step's own name.

On the third point, exactly what is and is not observable, because the brief
asked for the name to appear in `failures[]`: `teardownActivation()` derives one
entry per refusing effect from the reviewed STEP name, and that vocabulary is
pinned — an expiry refusal is and stays `ACT_TEARDOWN_EXPIRY_TIMER`. The
additive line pushes `ACT_TEARDOWN_EXPIRY_SERVICE` **as well**, so the step name
still says WHICH effect refused and the code says WHY. No existing entry is
renamed, removed or reordered, and the literal code is also returned at the
module boundary on the retired episode's receipt path
(`code: 'ACT_TEARDOWN_EXPIRY_SERVICE'`), which is where a control asserts it
directly.

##### The end-state tolerance now measures both units, term by term

```js
const expiryRetired = () => EXPIRY_UNITS.every(unitFileAbsent)
  && unitIdle(expiryTimerUnit) && ['', 'not-found'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))
  && unitIdle(expiryServiceUnit) && ['', 'not-found'].includes(unitProperty(expiryServiceUnit, 'UnitFileState'));
```

> **P154D-06, same note:** the companion's liveness term is now
> `!expiryCompanionSurvivesRemoval()`. The durable-file term, both
> `UnitFileState` terms and the timer's own liveness term are byte-unchanged.

and the post-condition after the disable measures the same four unit/term pairs
rather than the timer's two. Because every site that consults the tolerance
consults `expiryRetired()` itself, applying it at EVERY site is not a matter of
remembering to: the never-created branch, `installed`'s third case, the
`disable`-failure catch branch, the post-reload re-measure and
`observeRetiredExpiry()` all read the same predicate, and the one place that
did not — the post-condition — is extended in place. There is no timer-only
form left in the module. The four pairs are written out rather than folded into
a loop over the unit names precisely so that each has its own mutant and its own
control; a loop would have collapsed the companion's two terms into one
mutation, which is the "covered by another" this round is not allowed.

The absence tolerances are unchanged and stay exactly as narrow as they were:
absence is excused by the never-created branch, by the durable removal receipt,
or by a measured `expiryRetired()` — which is now a measurement of the whole
mechanism rather than of half of it, making that third tolerance strictly
narrower than before.

##### P154D-04: the fixture can now represent the states, and says so falsifiably

The old model derived `UnitFileState` from the unit FILE alone, so it answered
`''` for any unit whose file was absent, and the host state "unit file gone,
`timers.target.wants/<unit>` symlink still there" was not representable at all.
Enablement on a real host is a durable INSTALL SYMLINK: `enable` creates it,
`disable` removes it, and deleting the unit file does not take it with it, so
systemd still answers for a unit whose own file is gone. The fixture now models
that link as a real symlink in a real directory, independently of the `enabled`
set:

* `enable`/`disable` create and remove `/etc/systemd/system/timers.target.wants/<unit>`;
* `UnitFileState` answers from the unit file where there is one and from the
  leftover link where there is not, and is empty only for a unit with neither;
* `daemon-reload` rebuilds the loaded view from the unit directory's FILES and
  does not touch the link (directory entries such as `<unit>.d` and
  `timers.target.wants` are no longer mistaken for units);
* `h.wants` (`has`/`add`/`delete`) is exposed so controls drive that state
  directly rather than answering a per-argv reply or editing a returned string.

`B4 the modelled host represents every expiry unit state these controls claim`
drives all of it against the same interface the module reads, and fails by its
own name (`B4_FIXTURE_REPRESENTS_*`) if the model cannot represent what the
controls claim: all four timer/companion file combinations including both
half-present directions; a companion measurably ACTIVE while its own file is
absent and the timer is inactive and not found; a unit whose file is absent
answering `enabled`, and the same leftover link answering `disabled`; a unit
file on disk but absent from a stale loaded view; and a `daemon-reload` that
rebuilds the loaded view while the install symlink survives and still answers.

Two consequences of that fidelity, recorded rather than smoothed over:

* Three shipped controls (`expiryUninstalledDisableCheck`,
  `expiryAbsenceAccountedCheck`, `expiryVanishedMechanismCheck`) removed the
  durable unit files by hand and cleared `enabled` while leaving the install
  symlink behind — a state that now correctly reads as residue of the
  mechanism. Each now deletes the link too, so the state it constructs is the
  one it claims ("the mechanism really is gone"). No assertion in them changed.
* `expiry retirement ignores unit enablement` is re-anchored onto a new control.
  With the COMPANION's enablement measured, the stale-loaded-view state forces
  the `daemon-reload` through the companion term as well, so it no longer
  distinguishes that mutant. The state that does is a TIMER whose durable file
  is gone while its leftover `.wants` link still answers `enabled` — which the
  fixture could not represent before this round. The mutant's name and the
  control `expiryCachedViewCheck` are both unchanged and both still run.

##### P154D-01: the ARMED disjunct is pinned, not declared equivalent

The previous round's equivalence entry argued from the WRITER: `ARMED` is
appended strictly after `step('expiry-watch', …)` reaches its durable `DONE`
row, and every journal this module produces is prefix-closed. The clause is
evaluated against whatever the READER accepts, and the reader's input space is
larger. `openActivationJournal` accepts `recovery.jsonl` on a keyless sha256
chain with **no prefix check**: each row must carry `seq === index`,
`previous === <previous row's sha256>` and `sha256 === digest(JSON.stringify(payload))`,
and nothing else. A test can write such a file by hand. So the control writes
one: this episode's own journal with the `DONE`/`expiry-watch` row removed and
the chain recomputed from scratch, holding `ARMED`, with both durable unit files
deleted, no removal receipt, the timer idle with an empty `UnitFileState` and no
leftover link. The control proves the reader really accepted that chain rather
than falling to the damaged-log path, by requiring this teardown's own rows to
have been appended to that same file.

In that state `installed` is true only because of the ARMED disjunct, the
mechanism has vanished with nothing accounting for it, and the teardown halts
before the disable. Delete the disjunct and `installed` is false, the
`!installed && expiryRetired()` tolerance is satisfied by a spotless end state,
the disable is issued and the episode reports `ok:true, state:REVOKED`. The
disjunct is kept, the equivalence entry is retracted in place above, and the row
is pinned below. The writer-side prefix-closure argument is not used anywhere in
this document to excuse a clause.

##### P154D-03: unchanged, and still a documented residual

Custody is shape, ownership, mode and links — not content. A foreign
`root:root` `0644` body at the unit path is removed and reported clean. The
verifier confirms that matches the requirement as stated. Custody is NOT widened
to content in this round.

##### RETAINED, unchanged and unweakened

The successor-window pre-mint gate (`/etc/systemd/system#shu71-expiry`, which
refuses to arm while ANY `shu71-expiry-*` unit file is present) and the
post-window end-state observation are unchanged by this round, byte for byte.
They are ADDITIONAL controls. Nothing above is closed by them, and nothing above
would be closed by them: the gate runs in the successor's window, not in this
one, and the observation runs after it. Every item above is closed by a code
change and a control in this window.

##### Every load-bearing clause and ordering, re-issued for the RESTRUCTURED function AND the new companion measurement

Each row is a clause or an ordering of `retireExpiryTimer()`, of
`observeRetiredExpiry()`, of `expiryRetired()` or of what they call, with the
control that pins it, the mutant that control kills, and whether that kill was
observed by name this round. `verified` means an instrumented replay recorded
the exact assertion whose failure killed the mutant: **eighty-nine mutants,
eighty-nine kills, no survivors**, and every control name below is a name that
replay printed. Attack this table rather than rediscovering it.

| Clause or ordering | Named control | Named killing mutant | Kill |
| --- | --- | --- | --- |
| `installed` — the `journalHas(journal, 'ARMED')` disjunct **(P154D-01, was declared equivalent)** | `B4_EXPIRY_ARMED_WITHOUT_DONE_ROW_REFUSED` | `expiry installation proven only by the DONE row` | verified |
| `installed` — the `journalHas(journal, 'DONE', 'expiry-watch')` disjunct | `B4_EXPIRY_VANISHED_DONE_ROW_REFUSED` | `expiry installation proven only by ARMED` | verified |
| `removing` — the receipt derivation | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `expiry removal receipt never re-read` | verified |
| custody NOT gated on journal-proven installation | `B4_EXPIRY_JOURNAL_BLIND_CUSTODY_interrupted-install_hardlinked-timer_REFUSED` | `expiry custody conditioned on journal-proven installation` | verified |
| custody NOT gated on a recovered log | `B4_EXPIRY_JOURNAL_BLIND_CUSTODY_recovered_hardlinked-timer_REFUSED` | `expiry custody conditioned on a recovered log` | verified |
| custody NOT gated on the durable removal receipt | `B4_EXPIRY_INTERRUPTED_CUSTODY_timer_REFUSED`, `…_service_REFUSED` | `interrupted removal bypasses expiry custody`, `… companion custody` | verified |
| custody measured over BOTH durable unit files | `B4_EXPIRY_CUSTODY_REFUSED_hardlinked-service` | `expiry custody predicate ignores the companion unit file` | verified |
| custody's `unitFileAbsent(file) ||` tolerance of an absent file | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `expiry custody measured on absent unit files` | verified |
| custody measured BEFORE `disable --now` | `B4_EXPIRY_CUSTODY_BEFORE_DISABLE_non-root-owner` | `expiry custody measured only after the disable` | verified |
| custody measured AGAIN immediately before the unlink | `B4_EXPIRY_UNLINK_CUSTODY_REFUSED` | `expiry custody never re-measured before the unlink` | verified |
| custody `s.isFile()` | `B4_EXPIRY_CUSTODY_REFUSED_non-regular-file` | `expiry unit file shape unchecked` | verified |
| custody `s.nlink === 1` | `B4_EXPIRY_CUSTODY_REFUSED_hardlinked-timer` | `expiry unit hardlink unchecked` | verified |
| custody `s.uid === 0` | `B4_EXPIRY_CUSTODY_REFUSED_non-root-owner` | `expiry unit owner unchecked` | verified |
| custody `s.gid === 0` | `B4_EXPIRY_CUSTODY_REFUSED_non-root-group` | `expiry unit group unchecked` | verified |
| custody `!(s.mode & 0o020)` | `B4_EXPIRY_CUSTODY_REFUSED_group-writable` | `expiry unit group-writable mode accepted` | verified |
| custody `!(s.mode & 0o002)` | `B4_EXPIRY_CUSTODY_REFUSED_world-writable` | `expiry unit world-writable mode accepted` | verified |
| the custody term predicate as a whole | `B4_EXPIRY_CUSTODY_REFUSED_non-root-owner` | `expiry unit custody predicate vacuous` | verified |
| custody `!s.isSymbolicLink()` | *equivalent mutant, reader-side reasoning below* | — | n/a |
| the `never` early branch and its `need(expiryRetired)` | `B4_PREARM_DRIFT_REFUSED_both-files` | `pre-arm expiry drift silently accepted` | verified |
| `lifecyclePhase`'s `journal.recovered` conjunct | `B4_RECOVERED_NOT_PROOF_OF_NON_CREATION` | `recovered log accepted as non-creation proof` | verified |
| `lifecyclePhase`'s `RUN_ATTEMPT_STARTED` conjunct | `B4_DESTROYED_JOURNAL_NOT_PROOF` | `non-creation inferred from an empty journal` | verified |
| **P154D-02** the live-companion refusal, stated in `retireExpiryTimer()` before the absence clause and the disable | `B4_EXPIRY_LIVE_COMPANION_INSTALLED_COMPANION_REFUSAL_NAMED` | `expiry running companion accepted before the disable` | verified |
| **P154D-02** that refusal's predicate (`unitIdle(expiryServiceUnit)`) and its `ACT_TEARDOWN_EXPIRY_SERVICE` name | `B4_EXPIRY_LIVE_COMPANION_INSTALLED_COMPANION_REFUSAL_NAMED` | `expiry companion refusal predicate vacuous` | verified |
| **P154D-02** the same refusal in `observeRetiredExpiry()` | `B4_EXPIRY_LIVE_COMPANION_RETIRED_EPISODE_NAMED` | `retired episode expiry companion liveness unobserved` | verified |
| **P154D-02** the receipt path reporting the companion's own code, not generic drift | `B4_EXPIRY_LIVE_COMPANION_RETIRED_EPISODE_NAMED` | `live expiry companion reported as generic drift` | verified |
| **P154D-02** `teardownActivation()` surfacing that code in `failures[]` | `B4_EXPIRY_LIVE_COMPANION_INSTALLED_COMPANION_REFUSAL_NAMED` | `P154D live expiry companion code never surfaced` | verified |
| the absence clause as a whole | `B4_EXPIRY_FILE_DRIFT_REFUSED_timer` | `installed expiry pre-condition omitted` | verified |
| absence — presence of the companion `.service` file | `B4_EXPIRY_FILE_DRIFT_REFUSED_service` | `expiry companion service file unchecked` | verified |
| absence — the `removing ||` disjunct | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `expiry presence pre-condition ignores the removal receipt` | verified |
| absence — the `|| !installed && expiryRetired()` disjunct | `B4_EXPIRY_UNINSTALLED_RETIRED_COMMAND_ISSUED` | `unaccounted expiry absence accepted` | verified |
| absence — its `!installed &&` half | `B4_EXPIRY_VANISHED_ARMED_BEFORE_DISABLE` | `journal-proven installed expiry absence accepted` | verified |
| absence — its `expiryRetired()` half | `B4_EXPIRY_ABSENCE_interrupted-install_half_REFUSED` | `unretired expiry absence accepted` | verified |
| the `disable --now` command itself | `B4_EXPIRY_RETIREMENT_COMPLETES` | `expiry disable command never issued` | verified |
| catch door A — a throw carrying **no** `ACT_COMMAND_FAILED` code | `B4_EXPIRY_DISABLE_FAILURE_UNITS_RETAINED` | `refused expiry disable blindly accepted` | verified |
| catch door B — `systemctl disable` **exiting non-zero** | `B4_EXPIRY_DISABLE_EXIT_REFUSED` | `expiry disable exit-status refusal conjuncts dropped` | verified |
| catch conjunct `removing ||` | `B4_EXPIRY_INTERRUPTED_REMOVAL_RETRY_COMPLETES` | `interrupted expiry disable refusal rejected` | verified |
| catch conjunct `!installed && …` | `B4_EXPIRY_UNINSTALLED_RETIRED_COMPLETES` | `uninstalled expiry disable refusal rejected` | verified |
| catch conjunct `… && expiryRetired()` | `B4_EXPIRY_UNINSTALLED_PRESENT_REFUSED` | `uninstalled expiry disable accepted with the mechanism present` | verified |
| post-condition conjunct — TIMER liveness | `B4_EXPIRY_POSTCONDITION_ACTIVE_UNITS_RETAINED` | `expiry post-condition unit liveness inert` | verified |
| post-condition conjunct — TIMER enablement | `B4_EXPIRY_POSTCONDITION_ENABLED_REFUSED` | `expiry post-condition enablement unchecked` | verified |
| **P154D-02** post-condition conjunct — COMPANION liveness | `B4_EXPIRY_POSTCONDITION_SERVICE_ACTIVE_UNITS_RETAINED` | `expiry post-condition companion liveness inert` | verified |
| **P154D-02** post-condition conjunct — COMPANION enablement | `B4_EXPIRY_POSTCONDITION_SERVICE_ENABLED_REFUSED` | `expiry post-condition companion enablement unchecked` | verified |
| the post-condition as a whole | `B4_EXPIRY_POSTCONDITION_UNITS_RETAINED` | `expiry end state never measured` | verified |
| the removal loop | `B4_EXPIRY_RETIREMENT_COMPLETES` | `retired expiry units left behind` | verified |
| the removal loop's `!EXPIRY_UNITS.every(unitFileAbsent)` guard | `B4_EXPIRY_UNINSTALLED_RETIRED_NOTHING_TO_REMOVE` | `expiry removal issued with nothing to remove` | verified |
| the receipt append | `B4_EXPIRY_RETIREMENT_RECEIPT` | `expiry retirement receipt omitted` | verified |
| the receipt append's POSITION, before the loop | `B4_EXPIRY_INTERRUPTED_REMOVAL_RECEIPT_BEFORE_REMOVAL` | `expiry removal receipt appended after the unlinks` | verified |
| the `daemon-reload` on a stale loaded view | `B4_EXPIRY_RELOAD_REFRESHES_UNIT_VIEW` | `stale unit view never refreshed` | verified |
| the post-reload re-measure | `B4_EXPIRY_POST_RELOAD_REFUSED` | `post-reload expiry end state never measured` | verified |
| `expiryRetired()` — the durable-file absence conjunct, over BOTH files | `B4_PREARM_DRIFT_REFUSED_service-file-stale-view` | `expiry retirement ignores the companion unit file` | verified |
| `expiryRetired()` — TIMER liveness `unitIdle(expiryTimerUnit)` | `B4_PREARM_DRIFT_REFUSED_timer-active` | `expiry retirement ignores unit liveness` | verified |
| `expiryRetired()` — TIMER enablement | `B4_PREARM_DRIFT_REFUSED_timer-enabled-link` | `expiry retirement ignores unit enablement` | verified |
| **P154D-02** `expiryRetired()` — COMPANION liveness `unitIdle(expiryServiceUnit)` | `B4_PREARM_DRIFT_REFUSED_service-active` | `expiry retirement ignores companion liveness` | verified |
| **P154D-02** `expiryRetired()` — COMPANION enablement | `B4_PREARM_DRIFT_REFUSED_service-enabled-link` | `expiry retirement ignores companion enablement` | verified |
| `observeRetiredExpiry()` on the retired episode's receipt path | `B4_RETIRED_EPISODE_EXPIRY_DRIFT` | `retired episode expiry drift unobserved` | verified |
| `observeTeardown()` re-run immediately before the retirement | `B4_RETIREMENT_REOBSERVATION` | `P1 retirement re-observation removed` | verified |
| the effect's durable-`DONE` pre-condition (defence in depth) | *equivalent pair, reasoning below* | — | n/a |

Every row has both a control and a mutant, or an equivalent-mutant entry with
its reasoning. There are **no rows with neither**, and **no row is marked
"covered by another"**. Three rows would have been, and were not, because the
attempt to falsify them succeeded and produced a new control instead:

* the COMPANION file-absence conjunct. Each unit's own `UnitFileState` answers
  for its own file wherever systemd's loaded view is fresh, so a present
  companion file refuses through the enablement conjunct anyway and
  `B4_PREARM_DRIFT_REFUSED_service-file` does not distinguish the mutant. The
  state that does is a companion file on disk and absent from the loaded view,
  planted after systemd's last reload — `…_service-file-stale-view`. (The
  `service-file` control still runs and still passes.)
* the TIMER enablement conjunct, for the mirror-image reason, now pinned by the
  leftover-`.wants` state `…_timer-enabled-link`.
* the COMPANION enablement conjunct, which needs both files absent and only the
  leftover install symlink present — `…_service-enabled-link`. The `disabled`
  form of the same leftover link is `…_service-disabled-link`, which runs as an
  additional control: a leftover link is residue of the mechanism under either
  answer, and neither answer is empty.

##### The two equivalent mutants, re-attacked this round, reasoned about the READER

1. `!s.isSymbolicLink()` in `expiryUnitCustody`. `s` is an `lstat` result, so a
   symlink already fails `isFile()`; removing the term alone cannot change any
   outcome for ANY input the predicate can be handed, whatever wrote it — the
   argument is about `lstat`'s answer, not about who created the file.
   Confirmed independently by two verifiers (**F-07**, and again this round).
2. The `expiry-timer` effect's durable-`DONE` pre-condition and the in-memory
   guard it duplicates (`shu71-journal.mjs`, `if (step === 'expiry-timer' &&
   failures.length)`) are a deliberately redundant **pair**: each alone produces
   the identical refusal for every input either can see, so each single-guard
   mutant survives, and the two-file mutant expressing "drop both" cannot be
   written in a harness that mutates one file at a time. Unchanged by this
   round, which touches neither guard.

The third equivalence this document used to claim — the `ARMED` disjunct of
`installed` — is **retracted**: it reasoned about the writer, the reader accepts
more than the writer produces, and the clause is pinned in the table above.

##### New controls and new mutants

| New control (test name) | Proves |
| --- | --- |
| `B4 a measurably running expiry companion service is never a clean retirement, installed` | journal-proven installed, both durable files present and in perfect root custody, companion ACTIVE: halts with `ACT_TEARDOWN_EXPIRY_SERVICE` in `failures[]` beside `ACT_TEARDOWN_EXPIRY_TIMER`, issues no `stop`, no `disable --now`, unlinks nothing, writes no receipt; with the companion measurably gone the same teardown completes and removes both |
| `B4 … , journal-blind` | the verifier's `V154D_PROBE_service` rebuilt term for term — recovered log, BOTH files deleted, no receipt, timer `inactive` with empty `UnitFileState`, companion ACTIVE — measured through the same interface the module reads, and refused |
| `B4 … , retired-episode` | the same drift on the retired episode's receipt path, where the refusal code is observable literally: `code === 'ACT_TEARDOWN_EXPIRY_SERVICE'` |
| `B4 a disable that leaves the expiry companion service active is drift` | the companion liveness half of the post-condition, with the timer's own end state spotless |
| `B4 a disable that leaves the expiry companion service enabled is drift` | the companion enablement half of the same |
| `B4 a chain-valid recovered log holding ARMED proves the expiry mechanism was installed` | **P154D-01**: the reader accepts a keyless-chain `recovery.jsonl` holding ARMED with the `DONE`/`expiry-watch` row removed and the chain recomputed; the control proves the reader accepted it by requiring this teardown's own rows appended to that file |
| `B4 the modelled host represents every expiry unit state these controls claim` | **P154D-04**: the fixture's own fidelity, falsifiable by name |
| `B4 pre-arm teardown refuses service-active drift by name` | the companion liveness conjunct of `expiryRetired()`, reached through the never-created branch so nothing shadows it |
| `B4 pre-arm teardown refuses service-enabled-link drift by name` | the companion enablement conjunct, on a leftover install symlink with both unit files absent |
| `B4 pre-arm teardown refuses service-disabled-link drift by name` | the same leftover link answering `disabled`: residue either way |
| `B4 pre-arm teardown refuses timer-enabled-link drift by name` | the timer enablement conjunct, on the same shape |
| `B4 pre-arm teardown refuses service-file-stale-view drift by name` | the durable-file absence conjunct, in the only state that distinguishes it from the enablement conjuncts |

| New killing mutant | Control that kills it |
| --- | --- |
| `B1/B4 mutation: expiry retirement ignores companion liveness` | `B4_PREARM_DRIFT_REFUSED_service-active` |
| `B1/B4 mutation: expiry retirement ignores companion enablement` | `B4_PREARM_DRIFT_REFUSED_service-enabled-link` |
| `B1/B4 mutation: expiry running companion accepted before the disable` | `B4_EXPIRY_LIVE_COMPANION_INSTALLED_COMPANION_REFUSAL_NAMED` |
| `B1/B4 mutation: expiry companion refusal predicate vacuous` | `B4_EXPIRY_LIVE_COMPANION_INSTALLED_COMPANION_REFUSAL_NAMED` |
| `B1/B4 mutation: retired episode expiry companion liveness unobserved` | `B4_EXPIRY_LIVE_COMPANION_RETIRED_EPISODE_NAMED` |
| `B1/B4 mutation: live expiry companion reported as generic drift` | `B4_EXPIRY_LIVE_COMPANION_RETIRED_EPISODE_NAMED` |
| `B1/B4 mutation: expiry post-condition companion liveness inert` | `B4_EXPIRY_POSTCONDITION_SERVICE_ACTIVE_UNITS_RETAINED` |
| `B1/B4 mutation: expiry post-condition companion enablement unchecked` | `B4_EXPIRY_POSTCONDITION_SERVICE_ENABLED_REFUSED` |
| `B1/B4 mutation: expiry installation proven only by the DONE row` | `B4_EXPIRY_ARMED_WITHOUT_DONE_ROW_REFUSED` |
| `recovery mutation: P154D live expiry companion code never surfaced` | `B4_EXPIRY_LIVE_COMPANION_INSTALLED_COMPANION_REFUSAL_NAMED` |

Two existing mutants keep their names and their assertions and changed only
which control kills them, for the measured reasons given above:
`expiry retirement ignores the companion unit file` (now
`…_service-file-stale-view`) and `expiry retirement ignores unit enablement`
(now `…_timer-enabled-link`). Several anchors moved in place with the two-unit
end state and post-condition; no mutant name, control name or assertion changed.

#### Validation of the fourth correction round

Tested implementation `82b6463fe881fe558c90baae82af3a16c21af666`, tree
`b520b20ea8f5e93186556f05ff66a6dbf882dfa0`. All four commands ran from the
repository root under the CI-like harness
(`service/test/fixture/shu71-ci-like.sh`), which printed
`CI_CONSTRAINTS uid=1000 umask=0022 target_accounts=absent runtime=absent
reviewer=absent` for each: UID 1000, `umask 0022`, target accounts absent
(`shu-coordinator`, `shu-supervisor`, `shu71-evidence`, `shu-workspace`,
`messagebus`), `/run` and `/etc/sudoers.d` tmpfs, `/run/shu71-evidence` and
`/etc/sudoers.d/shu-reviewer` absent, `chmod -R go-w .github/coordinator`,
`taskset -c 0-3 node --test --test-concurrency=2`, with both the TAP reporter
and the unchanged `host-suite-contract.mjs` reporter writing separate outputs.
Plain unsets `NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.
Every run executed the COMMITTED revision, which the A12 guard requires because
it reads the inventory from `git show <revision>:suite-inventory.json`.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit | Load at start → end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Focused plain | 1645 | 1644 | 0 | 1 | 1 / 1 | 0 | 2.15 → 2.72 |
| Focused clock | 1645 | 1644 | 0 | 1 | 1 / 1 | 0 | 2.30 → 4.01 |
| Full plain | 3358 | 3350 | 0 | 8 | 1 / 1 | 0 | 3.39 → 3.10 |
| Full clock | 3358 | 3350 | 0 | 8 | 1 / 1 | 0 | 2.22 → 2.21 |

Every command exited zero with zero cancelled and zero todo outcomes, and no
`not ok` line in any of the four TAP outputs. Focused TAP plans are `1..1645`;
full plans are `1..3353`, with five nested outcomes bringing each full total to
3,358. Each run's structured report has exactly one terminal `complete` event,
is terminated by it, and passes the unchanged `evaluateSuite` validator
(1,645 / 1,645 / 3,358 / 3,358 expected outcomes). Both full runs' 3,358 outcome
names are exactly the committed inventory's 3,358 names, with identical
multiplicities — zero missing and zero extra — and `A12 committed inventory
requirements match real outcomes` passes in both (`ok 2142`). Every skip in all
four runs is a `PERMITTED_SKIPS` entry carrying that entry's exact documented
reason, byte-for-byte (checked against the exported object, not by eye); the
single focused skip is `SHU-71 restricted capability refusal`.

The focused selection is the sixteen-entry list printed for the previous
correction round, unchanged — every file this round touches is already in it —
which expands to 23 test files. The focused total is the previous round's 1,623
plus this round's 22 inventory names: 1,645. The full total is 3,336 plus the
same 22: 3,358. The full selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
(113 files, unchanged).

Every mutant in `shu71-production-mutations.test.mjs` and
`shu71-recovery-mutations.test.mjs` was additionally replayed under an
instrumented harness that recorded the exact assertion whose failure killed it:
**89 mutants, 89 kills, no survivors** (88 recorded by the instrumented
predicate; the 89th, `refusal predicate evaluated inside need()`, uses
`assert.throws` and was re-verified separately). Every `verified` control name
in the clause table above is a name that replay printed, including every row
this round added. Two rows were re-attributed as a result of that replay rather
than of reasoning — `expiry retirement ignores the companion unit file` and
`expiry retirement ignores unit enablement`, both of which stopped being
distinguished by their previous controls once the companion's own terms were
measured, and both of which now name the control that actually kills them.

`PERMITTED_SKIPS` is byte-identical to `9e1a2d0`: **1,093 bytes** including its
final newline, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. The entire
`host-suite-contract.mjs` is unchanged, SHA-256
`2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`. Inventories
are strictly additive: 113 test files unchanged, 3,336 → 3,358 names and
requirement rows in a 110-insertion / 0-deletion diff, zero removals and zero
dropped requirement rows; no test file was added. The reviewed teardown effects
set and its order are unchanged — this round adds a refusal, not an effect. The
production change moved two documentation line-number links
(`shu71-production.mjs#L702` → `#L734` in `SHU71-PREREQUISITES.md` and
`SHU71-L3-CLOSURE.md`, and `#L646` → `#L678`);
`V8_DOCUMENTATION_LINK_TARGETS` passes, including its own one-line-drift mutant.
Only files under `.github/coordinator/**` changed; no push or PR was performed.

##### Measured effect counts, and why three pinned numbers moved

Three suites pin exact measured effect counts, and each moved by the same
amount for the same reason. Measuring the companion adds exactly five commands
to every completing retirement: the live-companion refusal reads the companion's
`ActiveState` once, and both the post-condition and the final retired
measurement now read the companion's `ActiveState` and `UnitFileState` as well
as the timer's.

* `shu71-r8-state-model.mjs`: `cleanupEffects` and the settled count are each
  +5, uniformly, across every one of the 720 reachable R8 states that reaches a
  retirement — measured, not assumed: the replay produced exactly eight distinct
  (expected, observed) pairs and every one of them differs by five.
* `shu71-composition.test.mjs`: `B1_RESUME_EFFECT_COUNT` 75 → 80 and
  `B1_EXPIRY_EFFECT_COUNT` 79 → 84, for the same five.
* `B1_REVOKE_OBSERVATION_ONLY` 6 → 9: the retired episode's receipt path gains
  the companion's liveness refusal plus the companion's two terms in
  `expiryRetired()`.

No assertion was removed or relaxed to make a count fit; the counts are the
measurement, and they went up because more is measured.

##### What could not be made consistent

Two things, stated rather than smoothed over.

1. **The third absence tolerance is still there, and is still the one place the
   owner's rule is literally wider than "nothing else excuses absence".** Where
   the journal vouches for nothing, a MEASURED `expiryRetired()` excuses an
   absent unit file, because `B4_EXPIRY_UNINSTALLED_RETIRED_COMPLETES` requires
   a teardown whose mechanism really is gone to complete rather than wedge for
   ever, and this lane may not delete that assertion. It is unchanged from the
   previous round except that it is now strictly narrower: `expiryRetired()`
   measures the whole mechanism rather than the timer half of it, so the state
   this round found — a live companion behind an absent timer — no longer
   satisfies it.
2. **HALT-by-name had a production consequence on the automatic expiry path,
   and it was not hypothetical. The owner ruled on it and it is FIXED by
   P154D-06 below; the paragraph is retained unedited as the record of what the
   fourth round shipped and disclosed, not as a description of current
   behaviour.** `installExpiry()` writes
   `ExecStart=/usr/bin/node <installedModule> expire <id>` into
   `shu71-expiry-<id>.service`, and the timer's only job is to start it. So when
   an expiry teardown is triggered BY THE TIMER, the companion service is the
   process performing that teardown, and systemd reports a running `Type=oneshot`
   unit as `activating` — which `unitIdle()` does not accept. That teardown will
   now disarm both gates, remove the credential, stop the services, restore both
   fixtures, clean the workspaces, archive and write its manifest, and then halt
   at the expiry-timer step with `ACT_CLEANUP_FAILED` and
   `ACT_TEARDOWN_EXPIRY_SERVICE`, leaving the expiry mechanism installed and the
   episode requiring an operator `resume` or `revoke` — which succeeds, because
   an operator-invoked teardown is not running inside the companion. The
   direction of the failure is closed, not open: dispatch is off and the
   credential is gone before the refusal. This is a REAL degradation of
   unattended expiry and the owner should see it as one. It was not introduced
   to satisfy the brief carelessly: the brief requires the companion's liveness
   to be measured and forbids a silent success, the alternative it offers
   (stop-then-verify) would have the teardown SIGTERM itself under
   `Restart=on-failure`, and adding a self-identification measurement (comparing
   `INVOCATION_ID` or `MainPID` against this process) would be a new boundary
   read with its own attack surface, which is more than this round is scoped to
   introduce. The state the verifier measured is refused either way. **If the
   owner wants unattended expiry to self-complete, the correct next step is an
   explicitly reviewed self-identification measurement, not a weakening of the
   companion terms.** No modelled state in the suite exercises the self-run
   shape, because the fixture invokes `execute('expire')` directly rather than
   through a modelled companion service, and this round did not add that shape
   to the model — that is a gap in the model, recorded here.

Nothing else in P154D-01 through P154D-05 was left open.

### Fifth correction round: the teardown proves gone the mechanism MINUS the invocation performing the removal

#### P154D-06, the regression, and that it was ours

The fourth round's DISCLOSURE raised a consequence and asked for a ruling. The
ruling is not "accept it". Measured in the shipped tree, `installExpiry()` writes

```
ExecStart=/usr/bin/node <installedModule> expire <id>
```

into `shu71-expiry-<id>.service`, and the timer written beside it carries
`Unit=shu71-expiry-<id>.service`. **The companion service IS the process that
performs the teardown.** `unitIdle()` is `ActiveState ∈ {inactive, failed}`, and
a running `Type=oneshot` unit reports `activating`. So with the fourth round's
terms the timer-triggered path — the ONLY unattended path this mechanism exists
for — did its teardown work, then refused `ACT_TEARDOWN_EXPIRY_SERVICE` on
itself, died non-zero, and was restarted by `Restart=on-failure` under
`OnUnitActiveSec=1s` until the start limit tripped. Net effect: the window left
torn-down-but-not-retired, needing an operator `resume`/`revoke`, with the
expiry mechanism still installed. That is the "its teardown could not complete"
class that already cost one activation ID in this workstream, and it contradicts
the pinned requirement that expiry triggers PHYSICAL gate removal, worker and
service cleanup with no operator. A refusal that fires on the very invocation
doing the removal is not defence in depth; it is a self-defeating guard.

The pre-existing requirement that expiry must self-complete is retained and is
now also REQUIRED to be controlled.

#### The rule

The mechanism this teardown must prove gone is the expiry mechanism **minus the
invocation performing the removal**. Stated at the point of measurement:

```js
const expiryCompanionIsThisInvocation = () => {
  const unit = unitProperty(expiryServiceUnit, 'InvocationID'), self = b.invocationId();
  return typeof self === 'string' && self !== '' && unit !== '' && unit === self;
};
const expiryCompanionSurvivesRemoval = () => !unitIdle(expiryServiceUnit) && !expiryCompanionIsThisInvocation();
```

* **A companion survives this removal** when it is measurably NOT idle **and**
  it is NOT the invocation running this removal. `ACT_TEARDOWN_EXPIRY_SERVICE`
  is refused exactly when that predicate is true; otherwise the teardown
  proceeds.
* **Only the companion's own LIVENESS term gained the exclusion.** The durable
  unit-file terms and the `UnitFileState` enablement terms of BOTH units are
  byte-unchanged and exactly as strict as the fourth round left them. Custody is
  untouched. `retireExpiryTimer()`'s ordering and every other clause are
  untouched.
* **Liveness is measured FIRST**, so an idle companion never consults the
  identity at all, and an `InvocationID` left behind by a start that has already
  exited cannot excuse anything. This is also why every completing retirement
  issues exactly the same commands it issued before: the identity read only
  happens where the companion is live.
* **The exclusion is bounded by exact invocation identity and by nothing else.**
  No live companion attributable to anything else is ever tolerated, and no
  journal row, durable receipt or absence tolerance reaches this term — the
  refusal still sits after the never-created branch and BEFORE the absence
  clause and before `disable --now`, where the fourth round put it.
* Required in its **negated** form through `measuredPredicate()` at every site,
  so an unreadable id, a `show` that exits non-zero, a boundary without the port
  or any other throw is the named refusal, not a bare error and never a pass.

#### The exact measurement, and every direction it can fail in

The exclusion is measured from a durable systemd fact, not from a flag, an
environment-presence test, or anything the removal path sets about itself:

| Side | Measurement |
| --- | --- |
| the unit's current start | `systemctl show --property=InvocationID --value shu71-expiry-<id>.service`, through the same `unitProperty()` helper every other unit measurement uses |
| this process's own start | `INVOCATION_ID`, read through the new `shu71Boundary.invocationId()` measurement port (`() => process.env.INVOCATION_ID`) |
| the comparison | exact string equality of two NON-EMPTY values, and nothing else |

systemd mints a fresh 128-bit InvocationID every time a unit starts and exports
that start's own id to that start's own processes as `INVOCATION_ID`. Equality
of the two is therefore a statement about ONE start, which is what makes it
usable as an identity rather than as a capability. Failure directions, each
closed:

* **`INVOCATION_ID` absent** — this process is not running under systemd, i.e.
  an operator CLI run. `typeof self === 'string'` is false, nothing is excluded,
  and any live companion refuses by name. This is the fourth round's behaviour,
  preserved exactly, and it is what `B4_EXPIRY_LIVE_COMPANION_INSTALLED`,
  `…_JOURNAL_BLIND` and `…_RETIRED_EPISODE` continue to measure.
* **Either value empty** — a unit that never ran in this boot answers with the
  empty string, and an empty `INVOCATION_ID` is not an identity. Both
  non-emptiness terms are required, so `'' === ''` can never exclude.
* **Unreadable** — `unitProperty()` goes through `command()`, which refuses
  `ACT_COMMAND_FAILED` on a non-zero exit; inside `measuredPredicate()` that is
  a measured `false`, so the negated requirement refuses by name. Fail-closed.
* **Equal but stale** — a companion whose start has EXITED is idle, and liveness
  is measured first, so the stale id is never compared. A leftover process from
  invocation X facing a unit that has since restarted into invocation Y compares
  X against Y, which differs, and refuses. The only tolerated state is a live
  companion whose CURRENT start is this process's own.
* **Foreign, with an id on both sides** — this process is under systemd and the
  live companion belongs to a different start. Presence on either side excludes
  nothing; only equality does. Pinned by `B4_EXPIRY_LIVE_COMPANION_FOREIGN_INVOCATION`.

#### `env -i` and why one variable is now carried across the re-exec

Disclosed because it is the one place this round touched outside the three
measurement sites. The CLI re-execs itself under
`flock … /usr/bin/env -i PATH=/usr/bin:/bin SHU71_LOCKED=1 /usr/bin/node …`, so
**`INVOCATION_ID` was being wiped before `execute('expire')` ever ran**. Without
carrying it, the inner process cannot know that it IS the expiry companion and
the timer-triggered teardown refuses itself exactly as before — the measurement
would be correct and dead. The value is now appended as a single argv element,
and only when present, so `INVOCATION_ID=` is never invented and no value can
inject a second assignment:

```js
const invocation = process.env.INVOCATION_ID;
spawnSync('/usr/bin/flock', ['--nonblock', '/run/lock/shu71-production.lock', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1',
  ...(invocation ? [`INVOCATION_ID=${invocation}`] : []), '/usr/bin/node', installedModule, ...argv], { stdio: 'inherit' });
```

`env -i` stays, and nothing else crosses. Carrying this one value grants nothing
on its own: the teardown only ever compares it for EXACT EQUALITY against the
unit's own reported `InvocationID`, so a value that is not that durable systemd
fact excludes nothing and a live companion still refuses by name. A root
operator who reads the live companion's actual `InvocationID` and exports it can
make this process claim that start — but that operator already holds root on the
host this module runs as root on, and can invoke `revoke` directly; the
exclusion widens no boundary they were outside of.

`invocationId` is a **measurement port, not a reviewed effect.** It reads one
environment variable and changes nothing on the host, the reviewed teardown
effects set and its order are unchanged, and this round adds no command. Had a
new effect been required, the rules say stop and disclose; none was.

#### New clause-table rows

| Clause or ordering | Named control | Named killing mutant | Kill |
| --- | --- | --- | --- |
| **P154D-06** the invocation exclusion itself — `&& !expiryCompanionIsThisInvocation()` | `B4_EXPIRY_SELF_RUN_COMPLETES_COMPLETED` | `expiry teardown refuses the invocation performing it` | verified |
| **P154D-06** the exclusion's EQUALITY term and its two non-emptiness terms (`self !== ''`, `unit !== ''`, `unit === self`) | `B4_EXPIRY_LIVE_COMPANION_FOREIGN_INVOCATION_REFUSED` | `expiry invocation exclusion widened to any live companion` | verified |
| **P154D-06** `expiryCompanionSurvivesRemoval()` — the companion-liveness term, now `!unitIdle(expiryServiceUnit)` with the exclusion, at `requireIdleExpiryCompanion()` and inside `expiryRetired()` | `B4_EXPIRY_SELF_RUN_COMPLETES_COMPLETED` | `expiry teardown refuses the invocation performing it` | verified |
| **P154D-06** the same exclusion's PARITY at the post-condition after `disable --now` | `B4_EXPIRY_SELF_RUN_POST_CONDITION_PARITY_COMPLETED` | `expiry post-condition refuses the invocation performing the removal` | verified |
| **P154D-06** the exclusion hides no surviving mechanism (same episode, non-companion vantage) | `B4_EXPIRY_SELF_RUN_HIDES_NOTHING_COMPLETED` | `retired expiry units left behind`, `expiry disable command never issued` | verified |

The four rows the fourth round wrote for the companion keep their controls,
their mutants and their `verified` status; only the printed predicate text moved
with the term:

| Row | Then | Now |
| --- | --- | --- |
| **P154D-02** the live-companion refusal's predicate and its `ACT_TEARDOWN_EXPIRY_SERVICE` name | `unitIdle(expiryServiceUnit)` | `!expiryCompanionSurvivesRemoval()` |
| **P154D-02** `expiryRetired()` — COMPANION liveness | `unitIdle(expiryServiceUnit)` | `!expiryCompanionSurvivesRemoval()` |
| **P154D-02** post-condition conjunct — COMPANION liveness | `unitIdle(expiryServiceUnit)` | `!expiryCompanionSurvivesRemoval()` |
| **P154D-02** `expiryRetired()` — COMPANION enablement | unchanged | unchanged |

#### New controls and new mutants

| New control (test name) | Proves |
| --- | --- |
| `B4 a timer-triggered expiry teardown running inside its own companion service completes` | **control 1**, the shape the fourth round recorded as an unmodelled gap: `execute('expire')` from inside a modelled `shu71-expiry-<id>.service` whose reported `InvocationID` equals this process's `INVOCATION_ID` and whose `ActiveState` is `activating`. The teardown COMPLETES — `ok:true`, `state:REVOKED`, `code:null`, `failures:[]`, a durable `TEARDOWN_COMPLETE` and removal receipt, no `ACT_TEARDOWN_EXPIRY_SERVICE` and no `ACT_TEARDOWN_DRIFT` — the `disable --now` is issued, the timer ends stopped, not enabled and with no leftover install symlink, and both durable unit files are gone. Nothing was stopped or killed to achieve it and the companion is still exactly as live, under exactly the same invocation, afterwards |
| `B4 a completed self-run still measures fully retired from a non-companion vantage` | **control 4**: the SAME episode measured again with no `INVOCATION_ID` at all, so no term is excluded from anything. The retired episode's receipt path returns `physical_teardown_observed: true`, which is `observeTeardown()` plus `observeRetiredExpiry()` executed, and the end state is independently re-measured through the interface the module reads. This is what proves the exclusion does not paper over a surviving mechanism |
| `B4 a disable that leaves this invocation's own companion activating is not drift` | the post-condition half of the exclusion, ISOLATED: the companion is idle at the refusal before `disable --now`, so that refusal cannot be what this control observes, and becomes this invocation only afterwards. The timer's own two end-state terms are spotless, so only the companion's post-condition term can refuse |
| `B4 a measurably running expiry companion service is never a clean retirement, foreign-invocation` | **control 3's sharp form**: this process really is under systemd with its own `INVOCATION_ID` and the live companion belongs to a DIFFERENT start. Both ids are asserted present, asserted to differ, and the refusal is still `ACT_TEARDOWN_EXPIRY_SERVICE` with no `stop`, no `disable --now`, nothing unlinked and no receipt |

| New killing mutant | Control that kills it |
| --- | --- |
| `B1/B4 mutation: expiry teardown refuses the invocation performing it` | `B4_EXPIRY_SELF_RUN_COMPLETES_COMPLETED` |
| `B1/B4 mutation: expiry invocation exclusion widened to any live companion` | `B4_EXPIRY_LIVE_COMPANION_FOREIGN_INVOCATION_REFUSED` |
| `B1/B4 mutation: expiry post-condition refuses the invocation performing the removal` | `B4_EXPIRY_SELF_RUN_POST_CONDITION_PARITY_COMPLETED` |

Each of the three is killed by a different named control, which is the
requirement. The full cross-kill matrix was replayed rather than reasoned about,
and it is printed here rather than reduced to the three designations, because
one cell of it is a limitation:

| Mutant | `…_SELF_RUN_COMPLETES` | `…_SELF_RUN_HIDES_NOTHING` | `…_SELF_RUN_POST_CONDITION_PARITY` | `…_LIVE_COMPANION_FOREIGN_INVOCATION` | `…_LIVE_COMPANION_INSTALLED` | `…_LIVE_COMPANION_JOURNAL_BLIND` | `…_LIVE_COMPANION_RETIRED_EPISODE` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A** drop the exclusion | `_COMPLETED` | `_COMPLETED` | `_COMPLETED` | survives | survives | survives | survives |
| **B** widen it to any live companion | survives | survives | survives | `_REFUSED` | `_REFUSED` | `_REFUSED` | `_REFUSED` |
| **C** drop the post-condition parity | `_COMPLETED` | `_COMPLETED` | `_COMPLETED` | survives | survives | survives | survives |
| **D** `retired expiry units left behind` | `_COMPLETED` | `_COMPLETED` | `_COMPLETED` | `_RECOVERED` | `_RECOVERED` | `_RECOVERED` | `_TEARDOWN_COMPLETED` |
| **E** `expiry disable command never issued` | `_COMPLETED` | `_COMPLETED` | `_INVOCATION_PLANTED_BY_DISABLE` | `_RECOVERED` | `_RECOVERED` | survives | `_TEARDOWN_COMPLETED` |

* **B is exactly the right shape**: it survives every self-run control — widening
  the exclusion makes a self-run complete just as it should — and dies on every
  live-companion control, which is why the foreign case is what pins the
  equality term, and why "the exclusion must be exactly as wide as the
  invocation and no wider" is a two-sided claim with a control on each side.
* **A and C are not distinguished from each other by any control, and that is a
  real limitation, stated rather than papered over.** The exclusion is deliberately
  stated ONCE and shared by all three sites, so dropping it (A) removes the
  post-condition's parity as well; and a self-run's own `activating` state
  reaches the post-condition by construction, so dropping the parity alone (C)
  also refuses the self-run. Each has its own designated killing control, each
  dies by that control's own named assertion, and neither can survive — but no
  state in this module separates "the refusal before the disable lost the
  exclusion" from "the post-condition lost it". Stating the term once is worth
  more than the extra attributability would be: a second, independent copy is
  exactly how the two sites would drift apart.
* D and E are pre-existing mutants attributed to `B4_EXPIRY_RETIREMENT_COMPLETES`
  and unchanged. They are replayed here only because the brief requires control
  4 to die when a mechanism really does survive; they were not re-attributed.

#### P154D-04 extended, not reopened

The fixture's fidelity control gains a fifth section and keeps every assertion
it had. Invocation identity is **first-class modelled state on both sides**, not
a per-argv reply: an `invocations` map per unit, minted on the start transitions
and on first measurement of a unit that is live however it became live, retained
after the unit exits (so an idle unit's id is STALE, not empty), fresh on a
restart, and empty only for a unit that never ran; plus a `selfInvocation`
holder that `b.invocationId()` reads, representable both as absent (operator CLI
run) and as exactly a named unit's current id (a unit's own `ExecStart`).
`B4_FIXTURE_REPRESENTS_*` drives all of that against the same interface the
module reads and fails by its own name if the model cannot represent it.

#### What this round did NOT change

P154D-01's pinned ARMED disjunct and retracted equivalence claim, P154D-04's
fixture-fidelity controls, P154D-05's corrected widened-vs-narrowed prose, and
P154D-03 as a documented residual all stand as the fourth round built them.
Custody is still shape, ownership, mode and links — **not** content. The
successor-window pre-mint gate and the post-window end-state observation are
byte-unchanged additional controls. The two mutants the fourth round
re-attributed stay re-attributed. No assertion, name, code, skip, timeout or
deadline was weakened, renamed or deleted.

#### Validation of the fifth correction round

Tested implementation `c96b08bc0e520ac553f59ebb49bf0f43be74933b`, tree
`5118187d6a2257eaf1a5eabc8cf88c75e0795914`. All four commands ran from the
repository root under the CI-like harness
(`service/test/fixture/shu71-ci-like.sh`), which printed
`CI_CONSTRAINTS uid=1000 umask=0022 target_accounts=absent runtime=absent
reviewer=absent` for each: UID 1000, `umask 0022`, target accounts absent
(`shu-coordinator`, `shu-supervisor`, `shu71-evidence`, `shu-workspace`,
`messagebus`), `/run` and `/etc/sudoers.d` tmpfs, `/run/shu71-evidence` and
`/etc/sudoers.d/shu-reviewer` absent, `chmod -R go-w .github/coordinator`,
`taskset -c 0-3 node --test --test-concurrency=2`, with both the TAP reporter
and the unchanged `host-suite-contract.mjs` reporter writing separate outputs.
Plain unsets `NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.
Every run executed the COMMITTED revision, which the A12 guard requires because
it reads the inventory from `git show <revision>:suite-inventory.json`; the
working tree was clean (`--untracked-files=all`) for all four.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit | Load at start → end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Focused plain | 1652 | 1651 | 0 | 1 | 1 / 1 | 0 | 1.76 → 3.58 |
| Focused clock | 1652 | 1651 | 0 | 1 | 1 / 1 | 0 | 2.92 → 4.15 |
| Full plain | 3365 | 3357 | 0 | 8 | 1 / 1 | 0 | 3.82 → 2.81 |
| Full clock | 3365 | 3357 | 0 | 8 | 1 / 1 | 0 | 2.75 → 2.43 |

Every command exited zero with zero cancelled and zero todo outcomes, and no
`not ok` line in any of the four TAP outputs. Focused TAP plans are `1..1652`;
full plans are `1..3360`, with five nested outcomes bringing each full total to
3,365. Each run's structured report has exactly one terminal `complete` event,
is terminated by it, and passes the unchanged `evaluateSuite` validator
(1,652 / 1,652 / 3,365 / 3,365 expected outcomes). Both full runs' 3,365 outcome
names are exactly the committed inventory's 3,365 names with identical
multiplicities — zero missing and zero extra, checked with the unchanged
`suiteNames` against `git show HEAD:…suite-inventory.json` — and
`A12 committed inventory requirements match real outcomes` passes in both. Every
skip in all four runs is a `PERMITTED_SKIPS` entry carrying that entry's exact
documented reason, byte-for-byte (compared against the exported object, not by
eye); the single focused skip is `SHU-71 restricted capability refusal`.

The focused selection is the sixteen-entry list printed for the previous
correction round, unchanged — every file this round touches is already in it —
which expands to 23 test files. The focused total is the previous round's 1,645
plus this round's 7 inventory names: 1,652. The full total is 3,358 plus the
same 7: 3,365. The full selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
(113 files, unchanged).

##### Mutant replay

Every mutant in `shu71-production-mutations.test.mjs` and
`shu71-recovery-mutations.test.mjs` was replayed on the committed revision under
an instrumented harness that recorded, per mutant, whether its anchor is unique,
whether the control passes on the UNMUTATED module, and the exact assertion whose
failure killed it: **92 mutants, 92 kills, no survivors** — 72 + 19 = 91 recorded
by the instrumented driver with zero baseline failures and zero non-unique
anchors, and the 92nd, `refusal predicate evaluated inside need()`, uses
`assert.throws` and is verified in-suite. Every `verified` control name in the
clause table is a name that replay printed, including every row this round added.

Named specifically because the brief required it: the fourth round's mutant
`expiry running companion accepted before the disable` still dies, and still
dies by the companion's own refusal name —
`B4_EXPIRY_LIVE_COMPANION_INSTALLED_COMPANION_REFUSAL_NAMED`, whose assertion is
`result.failures.includes('ACT_TEARDOWN_EXPIRY_SERVICE')`. The exclusion did not
soften it.

##### The timer-triggered path, replayed end to end

The regression this round fixes, replayed against the committed module rather
than argued about. The companion is `activating`, its reported `InvocationID`
equals this process's `INVOCATION_ID`, and the automatic expiry teardown runs:

```
companion ActiveState  = activating
companion InvocationID = 00000000000000000000000000000005
process INVOCATION_ID  = 00000000000000000000000000000005
expire: {"ok":true,"state":"REVOKED","code":null,"failures":[]}
ACT_TEARDOWN_EXPIRY_SERVICE anywhere in journal or result: false
ACT_TEARDOWN_DRIFT anywhere in journal or result: false
… INTENT:teardown:expiry-timer EXPIRY_RETIREMENT_STARTED DONE:teardown:expiry-timer TEARDOWN_COMPLETE
unit files remaining: .timer=false .service=false
timer ActiveState/UnitFileState/wants: inactive / "" / false
stop or kill issued to the companion: false
```

The teardown reaches `DONE:teardown:expiry-timer` and `TEARDOWN_COMPLETE`,
neither refusal code appears anywhere in the durable journal or in the returned
object, both durable unit files are gone, the timer is stopped with no install
symlink and systemd knows nothing about it, and **no `stop` or `kill` was issued
to the companion** — the exclusion is a measurement, not an effect.

##### Measured effect counts: unchanged, and why

No pinned effect count moved this round, and that is a consequence of the term
order rather than luck. `expiryCompanionSurvivesRemoval()` measures liveness
FIRST, so `show --property=InvocationID` is only ever issued where the companion
is measurably live — which no completing retirement is. The three suites that
pin exact measured effect counts (`shu71-r8-state-model.mjs` across all 720
reachable R8 states, `B1_RESUME_EFFECT_COUNT` 80, `B1_EXPIRY_EFFECT_COUNT` 84,
and `B1_REVOKE_OBSERVATION_ONLY` 9) are byte-unchanged and all pass.

##### Preservation

`PERMITTED_SKIPS` is byte-identical: **1,093 bytes** including its final newline,
SHA-256 `03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. The
entire `host-suite-contract.mjs` is unchanged, SHA-256
`2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`. Inventories
are strictly additive: 113 test files unchanged, 3,358 → 3,365 names and
requirement rows in a 35-insertion / 0-deletion diff, zero removals, zero dropped
requirement rows, and every retained requirement row byte-identical and in its
original order; no test file was added. Mutant names went 69 → 72 in the
production table with zero removals and zero renames. The reviewed teardown
effects set and its order are unchanged — this round adds a measurement, not an
effect. The production change moved four documentation line-number links
(`shu71-production.mjs#L313` → `#L317` in `ACTIVATION-WINDOW-RECONCILIATION.md`,
`#L349` → `#L353` and `#L678` → `#L721` and `#L734` → `#L777` in
`SHU71-PREREQUISITES.md`, and `#L734` → `#L777` in `SHU71-L3-CLOSURE.md`);
`V8_DOCUMENTATION_LINK_TARGETS` passes, including its own one-line-drift mutant.
Only files under `.github/coordinator/**` changed; no push or PR was performed.

##### What could not be made consistent, or pinned

1. **`INVOCATION_ID` has to cross the `env -i` re-exec, and that is a real
   widening of what the inner process inherits — one variable.** It is disclosed
   above with the reason it is narrow: equality against the unit's own reported
   `InvocationID` is the only use, so a planted value excludes nothing, and the
   only actor who could plant a matching one is root on the host this module
   already runs as root on. No control can pin the propagation itself, because
   the fixture calls `execute()` directly and never goes through the CLI
   re-exec; what the controls pin is the measurement on either side of it. This
   is the one place in this round where the model cannot represent real state,
   and it is the same gap shape the fourth round recorded — moved, not closed.
2. **Mutants A and C are not distinguished from each other by any control.** The
   exclusion is deliberately stated once and shared by its three sites, so
   dropping it also drops the post-condition's parity, and a self-run's own
   `activating` state reaches the post-condition by construction. Each has its
   own designated killing control and neither survives; no state separates them.
   The full matrix is printed above rather than reduced to the designations.
3. **`B4_EXPIRY_SELF_RUN_HIDES_NOTHING` has no mutant that only it
   distinguishes.** Control 1 already asserts every term of the end state
   independently of the module's own answer, so any mutant leaving residue
   behind is caught there too; the residue mutants `retired expiry units left
   behind` and `expiry disable command never issued` kill control 4 under its
   own name, but at its self-run SETUP phase. Its distinct value is that the
   module's success under the exclusion is confirmed a second time by a
   measurement with nothing excluded — which is a property no mutant in this
   module can separate from control 1, because the two measure the same
   predicate from two vantages.
4. **The third absence tolerance is unchanged and is still the one place the
   owner's rule is literally wider than "nothing else excuses absence"**, for
   the reason the fourth round gave: `B4_EXPIRY_UNINSTALLED_RETIRED_COMPLETES`
   requires a teardown whose mechanism really is gone to complete rather than
   wedge for ever, and this lane may not delete that assertion.
5. P154D-03 is unchanged and still a documented residual: custody is shape,
   ownership, mode and links — **not content**. A foreign `root:root` `0644`
   body at the unit path is removed and reported clean. Not widened here.

### Sixth correction round: the propagation across the `env -i` re-exec, named and pinned

#### P154D-07, and why it was the last blocking item

The fifth round disclosed it in its own words: `INVOCATION_ID` had to cross the
CLI's `env -i` re-exec or the exclusion would be **"correct and dead"**, and
**no control pinned the propagation itself**. That left the one clause the whole
fifth round depends on load-bearing and untested at the same time. Delete
``...(invocation ? [`INVOCATION_ID=${invocation}`] : [])`` and every control the
fifth round wrote still passes, while on the real host the companion's identity
is wiped before `execute('expire')` ever runs, the exclusion never applies, and
the timer-triggered teardown refuses itself — the exact regression P154D-06
exists to prevent, restored silently.

It is also the ONE place this correction **widens** what crosses a boundary that
was deliberately built to carry no operator environment, and nothing pinned that
widening either. This round closes exactly that, and nothing else.

#### The construction is now a named, exported, pure function

```js
export function lockedReexecCommand(invocation, argv = []) {
  return Object.freeze(['/usr/bin/flock', '--nonblock', '/run/lock/shu71-production.lock', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1',
    ...(invocation ? [`INVOCATION_ID=${invocation}`] : []), '/usr/bin/node', installedModule, ...argv]);
}
```

and the CLI is the same command, executed:

```js
const [exe, ...args] = lockedReexecCommand(process.env.INVOCATION_ID, argv);
const r = spawnSync(exe, args, { stdio: 'inherit' });
```

The runtime behaviour is **byte-identical** to the fifth round's inline form —
same executable, same argv order, same `env -i`, same `PATH=/usr/bin:/bin`, same
`SHU71_LOCKED=1`, same absolute binaries, the invocation element immediately
after `SHU71_LOCKED=1` and immediately before `/usr/bin/node`, `stdio: 'inherit'`
unchanged. The exact argv, measured by running the REAL CLI entry point in its
own process for each of the three cases:

| Parent `INVOCATION_ID` | Constructed argv, for `expire shu71reexec00001` |
| --- | --- |
| `deadbeefcafef00d0123456789abcdef` | `/usr/bin/flock --nonblock /run/lock/shu71-production.lock /usr/bin/env -i PATH=/usr/bin:/bin SHU71_LOCKED=1 INVOCATION_ID=deadbeefcafef00d0123456789abcdef /usr/bin/node /usr/local/lib/shu71/coordinator/service/shu71-production.mjs expire shu71reexec00001` |
| absent (`env -u INVOCATION_ID`) | `/usr/bin/flock --nonblock /run/lock/shu71-production.lock /usr/bin/env -i PATH=/usr/bin:/bin SHU71_LOCKED=1 /usr/bin/node /usr/local/lib/shu71/coordinator/service/shu71-production.mjs expire shu71reexec00001` |
| empty (`INVOCATION_ID=`) | `/usr/bin/flock --nonblock /run/lock/shu71-production.lock /usr/bin/env -i PATH=/usr/bin:/bin SHU71_LOCKED=1 /usr/bin/node /usr/local/lib/shu71/coordinator/service/shu71-production.mjs expire shu71reexec00001` |

Empty is **absent**, not a value: `INVOCATION_ID=` is never invented, so the
inner process reads absence as absence and excludes nothing, rather than reading
an empty string that a loosened comparison could one day treat as a match.

#### New clause-table rows

| Clause or ordering | Named control | Named killing mutant | Kill |
| --- | --- | --- | --- |
| **P154D-07** the propagation itself — ``...(invocation ? [`INVOCATION_ID=${invocation}`] : [])``, one element, byte-exact, immediately after `SHU71_LOCKED=1` and before `/usr/bin/node` | `B4_REEXEC_PRESENT_BYTE_EXACT` | `expiry invocation never crosses the kernel lock` | verified |
| **P154D-07** the propagation, END TO END: the value really crosses `env -i` into the process that measures it, and the timer-triggered teardown there COMPLETES | `B4_REEXEC_END_TO_END_INNER_ENVIRONMENT_IS_EXACTLY_THREE`, `B4_REEXEC_END_TO_END_INNER_OBSERVED_THE_PROPAGATED_ID`, `B4_REEXEC_END_TO_END_COMPLETED` | `B4 mutation: the locked re-exec drops the invocation element` | verified |
| **P154D-07** absent parent invocation carries NO element — never an invented `INVOCATION_ID=` | `B4_REEXEC_ABSENT_NO_INVENTED_EMPTY_ASSIGNMENT` | `expiry invocation element invented when the parent has none` | verified |
| **P154D-07** an EMPTY parent invocation behaves exactly as absent | `B4_REEXEC_EMPTY_NO_INVENTED_EMPTY_ASSIGNMENT` | `empty parent invocation treated as a value` | verified |
| **P154D-07** the value is built from the single invocation ARGUMENT and from nothing else | `B4_REEXEC_BOUNDARY_ELEMENT_IS_THE_ARGUMENT` | `expiry invocation element read from the environment, not the argument` | verified |
| **P154D-07** ONE argv element, so no value can inject a second assignment | `B4_REEXEC_SINGLE_ELEMENT_BYTE_EXACT`, `B4_REEXEC_ONE_VARIABLE_ONE_ARGV_ELEMENT`, `B4_REEXEC_ONE_VARIABLE_INNER_ENVIRONMENT_IS_EXACTLY_THREE` (runtime) | `expiry invocation value split across argv elements`, `B4 mutation: the invocation value is split across argv elements` | verified |
| **THE BOUNDARY** `env -i` is present, so the lock carries no operator environment | `B4_REEXEC_BOUNDARY_ENVIRONMENT_IS_WIPED`, `B4_REEXEC_END_TO_END_INNER_ENVIRONMENT_IS_EXACTLY_THREE` (runtime) | `kernel lock no longer wipes the environment`, `B4 mutation: the kernel lock no longer wipes the environment` | verified |
| **THE BOUNDARY** exactly three assignments cross it — `PATH`, `SHU71_LOCKED`, and the invocation element | `B4_REEXEC_BOUNDARY_EXACTLY_THREE_ASSIGNMENTS`, `B4_REEXEC_END_TO_END_INNER_ENVIRONMENT_IS_EXACTLY_THREE` (runtime) | `parent environment carried through the kernel lock`, `B4 mutation: the parent environment is carried through the kernel lock` | verified |
| **P154D-06/07** alignment is EXACT string equality of two non-empty values — no trim, no case folding, no prefix match | `B4_EXPIRY_INVOCATION_EXACT_EQUALITY_<miss>_REFUSED` | `expiry invocation comparison loosened below exact equality` | verified |

The fifth round's five P154D-06 rows keep their controls, their mutants and their
`verified` status; nothing in them is restated, re-attributed or moved.

#### New controls

| New control (test name) | Proves |
| --- | --- |
| `B4 the locked re-exec command carries exactly one INVOCATION_ID element, in place` | **control 1**. With a non-empty parent value the constructed command carries exactly one `INVOCATION_ID=<value>` element, byte-exact against the whole 11-element command, immediately after `SHU71_LOCKED=1` and immediately before `/usr/bin/node`. Built with this process's own `INVOCATION_ID` REMOVED, so a mutant that reads the environment instead of its argument cannot accidentally agree |
| `B4 the locked re-exec command carries no INVOCATION_ID element when the parent has none` | **control 2**. The parent variable is really deleted and really reads `undefined`, and the command carries NO `INVOCATION_ID` element at all — in particular never an invented `INVOCATION_ID=` — with nothing at all between the lock flag and `/usr/bin/node` |
| `B4 the locked re-exec command treats an empty parent INVOCATION_ID exactly as absent` | **control 3**, constructed half. `INVOCATION_ID=''` in the parent produces the byte-identical command to the absent case |
| `B4 the locked re-exec command wipes the environment and carries exactly three assignments` | **control 4**, constructed half. `-i` immediately follows `/usr/bin/env`; exactly `PATH=/usr/bin:/bin`, `SHU71_LOCKED=1` and the invocation element lie between it and `/usr/bin/node`; a planted operator variable appears nowhere by name or by value; and the invocation element's value is the ARGUMENT |
| `B4 the locked re-exec command passes the invocation value as one argv element` | **control 5**, constructed half. A value containing spaces and `=` (`… PATH=/evil SHU71_LOCKED=0`) stays ONE element: three assignments, not five, one `PATH=`, one `SHU71_LOCKED=`, and neither injected pair present |
| `B4 a near miss of the expiry companion's invocation is never this invocation` | **control 6**. Six near misses of the companion's own reported `InvocationID` — one leading space, one trailing space, upper case, a 31-character prefix, a 31-character suffix, and the empty string — each measured as this process's claim against a live companion, each refused `ACT_CLEANUP_FAILED` with `ACT_TEARDOWN_EXPIRY_SERVICE` named, before the disable, with nothing unlinked and both unit files surviving. The SAME episode then completes on the exact value, so the six refusals were the identity term and not the state around it |
| `B4 the locked re-exec carries this invocation across `env -i` and the inner teardown completes` | **control 7**, end to end. The REAL CLI entry runs in its own process with a real parent `INVOCATION_ID`; the command it really constructs is asserted byte-exact including the kernel-lock prefix; that command's environment-carrying portion is then EXECUTED through the real `/usr/bin/env -i`; and the inner process reports an environment of exactly `INVOCATION_ID`, `PATH`, `SHU71_LOCKED`, `PATH=/usr/bin:/bin`, `SHU71_LOCKED=1`, the propagated id read back through the module's OWN measurement port, and a timer-triggered teardown that COMPLETES — `ok:true`, `REVOKED`, `code:null`, `failures:[]`, both receipts durable, both unit files gone, no stop and no kill issued, the companion still live under the same invocation |
| `B4 a hostile invocation value crosses `env -i` as one variable and cannot inject a second` | **control 5**, runtime half. `deadbeef… PATH=/evil SHU71_LOCKED=0` crosses as ONE argv element and the inner process's real environment is still exactly three variables, with `PATH=/usr/bin:/bin` and `SHU71_LOCKED=1` un-overridden and the whole hostile string readable as one value. It remains only an equality candidate: it excludes exactly the companion start that really reports it |

#### New killing mutants

| New killing mutant | Control that kills it | Killing assertion |
| --- | --- | --- |
| `B1/B4 mutation: expiry invocation never crosses the kernel lock` | `reexecInvocationPresentCheck` | `B4_REEXEC_PRESENT_BYTE_EXACT` |
| `B1/B4 mutation: expiry invocation element invented when the parent has none` | `reexecInvocationAbsentCheck` | `B4_REEXEC_ABSENT_BYTE_EXACT` |
| `B1/B4 mutation: empty parent invocation treated as a value` | `reexecInvocationEmptyCheck` | `B4_REEXEC_EMPTY_BYTE_EXACT_AS_ABSENT` |
| `B1/B4 mutation: parent environment carried through the kernel lock` | `reexecBoundaryCheck` | `B4_REEXEC_BOUNDARY_EXACTLY_THREE_ASSIGNMENTS` |
| `B1/B4 mutation: kernel lock no longer wipes the environment` | `reexecBoundaryCheck` | `B4_REEXEC_BOUNDARY_ENVIRONMENT_IS_WIPED` |
| `B1/B4 mutation: expiry invocation element read from the environment, not the argument` | `reexecBoundaryCheck` | `B4_REEXEC_BOUNDARY_EXACTLY_THREE_ASSIGNMENTS` |
| `B1/B4 mutation: expiry invocation value split across argv elements` | `reexecSingleElementCheck` | `B4_REEXEC_SINGLE_ELEMENT_BYTE_EXACT` |
| `B1/B4 mutation: expiry invocation comparison loosened below exact equality` | `expiryInvocationExactEqualityCheck` | `B4_EXPIRY_INVOCATION_EXACT_EQUALITY_leading-space_REFUSED` |
| `B4 mutation: the locked re-exec drops the invocation element` | `reexecEndToEnd` | `B4_REEXEC_END_TO_END_INNER_ENVIRONMENT_IS_EXACTLY_THREE` |
| `B4 mutation: the invocation element is read from the environment, not the argument` | `reexecEndToEnd` | `B4_REEXEC_END_TO_END_INNER_OBSERVED_THE_PROPAGATED_ID` |
| `B4 mutation: the invocation value is split across argv elements` | `reexecOneVariable` | `B4_REEXEC_ONE_VARIABLE_ONE_ARGV_ELEMENT` |
| `B4 mutation: the parent environment is carried through the kernel lock` | `reexecEndToEnd` | `B4_REEXEC_END_TO_END_NO_OPERATOR_VALUE_IN_THE_COMMAND` |
| `B4 mutation: the kernel lock no longer wipes the environment` | `reexecEndToEnd` | `B4_REEXEC_END_TO_END_INNER_ENVIRONMENT_IS_EXACTLY_THREE` |

#### How far the REAL path is driven, and exactly where it stops

Stated here rather than claimed away, because the brief requires the limit to be
measured rather than asserted.

**What is real.** The module's real top-level CLI branch executes in its own
process, with a real `INVOCATION_ID` in its parent environment and an
operator environment around it — this suite's own environment, with
`NODE_TEST_CONTEXT` and `SHU71_LOCKED` removed so the CLI takes the outer branch,
and two planted poison variables added. It reads `process.env.INVOCATION_ID` itself,
calls the real `lockedReexecCommand`, and hands the result to `spawnSync`. The
command it produced is then really executed, by `/usr/bin/env`, with the real
`-i` and the real assignments the module built; the inner process really
inherits whatever that produces, and its own report of its environment is what
the controls assert on.

**The two doubles, both in a preload and neither touching the module's source.**
The identity guard is answered as root — `productionFixture` answers
`uid: () => 0` for every other control in this suite — and `node:child_process`
resolves to a recording module FOR THE MODULE UNDER TEST ONLY, so the single
`spawnSync` is captured instead of executed.

**The two substitutions in the executed command, both measured.** The
`/usr/bin/flock --nonblock /run/lock/shu71-production.lock` prefix is not
executed; it is asserted byte-exact on the constructed command instead. And the
WHOLE TAIL from `/usr/bin/node` onwards is replaced by this harness's inner
driver: not only the `/usr/bin/node <installedModule>` pair but also the
`expire <id>` argv behind it, which is dropped with them. So what is executed is
`/usr/bin/env -i <the three assignments the module built> <this node> <inner
driver> <report path> <planted companion id>`, and the action and id that crossed
the lock drive nothing — the inner driver runs `execute('expire')` against the
fixture's OWN activation id. What the substitution preserves, and what these
controls are about, is the environment-carrying portion: `/usr/bin/env`, `-i`,
and the three assignments, byte-for-byte as the module built them.

**Why.** `installedModule` is `/usr/local/lib/shu71/coordinator/service/shu71-production.mjs`;
`/usr/local/lib` is `drwxr-xr-x root root` and the suite runs as the service
identity (UID 1000 under the CI-like conditions), so the reviewed installation
path cannot be created, and the inner `SHU71_LOCKED=1` branch then requires real
UID 0 and a real `/srv/shu` tree besides. The inner driver therefore stands in
for the installed module — but it imports the REAL module, reads the REAL
measurement port `shu71Boundary.invocationId()`, and drives the real
`execute('expire')` against the same modelled host every other control uses. Its
ONLY source of self-identity is the value that crossed `env -i`; the companion's
reported `InvocationID` is planted from argv, which is the durable systemd fact
`systemctl show -p InvocationID` answers with. "Timer-triggered" throughout this
section means the `expire` action the expiry unit's
`ExecStart=/usr/bin/node <installedModule> expire <id>` runs, driven after the
fixture's modelled clock is advanced to `expires_at`; no real systemd timer fires
in this suite, and none of these controls claims one does.

#### What this round did NOT change

No new effect: this round is construction-of-command plus controls. The reviewed
teardown effects set and its order are unchanged, `invocationId` is still a
measurement port rather than an effect, and no command was added. P154D-01's
pinned ARMED disjunct, P154D-04's fixture-fidelity controls, P154D-05's corrected
prose and P154D-03 as a documented residual all stand. Custody is still shape,
ownership, mode and links — **not** content. The successor-window pre-mint gate
and the post-window end-state observation are byte-unchanged additional
controls. No assertion, name, code, skip, timeout or deadline was weakened,
renamed or deleted; `PERMITTED_SKIPS` and `host-suite-contract.mjs` are
byte-identical.

#### Validation of the sixth correction round

Tested implementation `f5b2d6689ba64d59965e7012208858588031513c`, tree
`5c92ec8c5169f3a9f81f507e2e1d18a67af1a58e` — the round's fix commit
`1ea29b46076fdf1eaeaa6f09d96b33009079e0c2` plus the record corrections above,
which change documentation and two source COMMENTS only and leave every test
name, and therefore all three inventories, unchanged. All four commands ran from
the repository root under the CI-like harness
(`service/test/fixture/shu71-ci-like.sh`), which printed
`CI_CONSTRAINTS uid=1000 umask=0022 target_accounts=absent runtime=absent
reviewer=absent` for each: UID 1000, `umask 0022`, target accounts absent
(`shu-coordinator`, `shu-supervisor`, `shu71-evidence`, `shu-workspace`,
`messagebus`), `/run` and `/etc/sudoers.d` tmpfs, `/run/shu71-evidence` and
`/etc/sudoers.d/shu-reviewer` absent, `chmod -R go-w .github/coordinator`, with
both the TAP reporter and the unchanged `host-suite-contract.mjs` reporter
writing separate outputs. Plain unsets `NODE_OPTIONS` and
`SHU_TEST_CLOCK_OFFSET_MS`; clock sets `SHU_TEST_CLOCK_OFFSET_MS=31536000000`
and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.
Every run executed the COMMITTED revision, which the A12 guard requires because
it reads the inventory from `git show <revision>:suite-inventory.json`; the
working tree was clean for all four.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit | Load at start → end |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Focused plain | 1673 | 1672 | 0 | 1 | 1 / 1 | 0 | 0.18 → 3.02 |
| Focused clock | 1673 | 1672 | 0 | 1 | 1 / 1 | 0 | 2.16 → 2.33 |
| Full plain | 3386 | 3378 | 0 | 8 | 1 / 1 | 0 | 2.05 → 3.46 |
| Full clock | 3386 | 3378 | 0 | 8 | 1 / 1 | 0 | 2.48 → 3.65 |

Every command exited zero with zero cancelled and zero todo outcomes, and no
`not ok` line in any of the four TAP outputs. Focused TAP plans are `1..1673`;
full plans are `1..3381`, with five nested outcomes under one nested `1..5`
bringing each full total to 3,386. Each run's structured report has exactly one
terminal `complete` event, is terminated by it, and passes the unchanged
`evaluateSuite` validator (1,673 / 1,673 / 3,386 / 3,386 expected outcomes).
Both full runs' 3,386 outcome names are exactly the committed inventory's 3,386
names with identical multiplicities — zero missing and zero extra, checked
against `git show HEAD:…suite-inventory.json` — and `A12 committed inventory
requirements match real outcomes` passes in both. Every skip in all four runs is
a `PERMITTED_SKIPS` entry carrying that entry's exact documented reason,
byte-for-byte (compared against the exported object, not by eye); the single
focused skip is `SHU-71 restricted capability refusal`.

##### The focused selection, and the gap this round closes in it

The previous correction round's focused selection did **not** contain
`shu71-reexec-boundary.test.mjs`. Its service-side production entry is the glob
`shu71-production*.test.mjs`, which expands to `shu71-production.test.mjs` and
`shu71-production-mutations.test.mjs` and matches nothing else — so this round's
ONLY end-to-end control sat outside the selection that is run first on every
change to this lane. That is a gap, and it is closed here by naming the file:

```sh
node --test \
  .github/coordinator/test/shu71-activation-package.test.mjs \
  .github/coordinator/test/shu71-battery.test.mjs \
  .github/coordinator/test/shu71-public-key.test.mjs \
  .github/coordinator/test/single-run-activation.test.mjs \
  .github/coordinator/test/supervisor.test.mjs \
  .github/coordinator/test/supervisor-dispatch.test.mjs \
  .github/coordinator/service/test/provision*.test.mjs \
  .github/coordinator/service/test/shu71-owner-decisions.test.mjs \
  .github/coordinator/service/test/shu71-phase-readback.test.mjs \
  .github/coordinator/service/test/shu71-production*.test.mjs \
  .github/coordinator/service/test/shu71-reexec-boundary.test.mjs \
  .github/coordinator/service/test/shu71-recovery-mutations.test.mjs \
  .github/coordinator/service/test/shu71-supervisor-environment.test.mjs \
  .github/coordinator/service/test/shu71-composition.test.mjs \
  .github/coordinator/service/test/shu71-trust*.test.mjs \
  .github/coordinator/service/test/shu71-verdict-closures.test.mjs \
  .github/coordinator/service/test/shu71-host-contract.test.mjs
```

Seventeen entries, expanding to 24 test files — the previous round's 23 plus
`shu71-reexec-boundary.test.mjs`. The focused total is the previous round's
1,652 plus this round's 21 inventory names: 1,673; all 21 fall inside the
selection. The full total is 3,365 plus the same 21: 3,386. The full selection
is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
(114 files, one more than the previous round's 113). All seven of
`shu71-reexec-boundary.test.mjs`'s tests were present in the outcome stream of
all four runs above, focused and full alike.

##### Harness throughput, and the one contention failure

The two FULL runs used `taskset -c 0-9 node --test --test-concurrency=4` rather
than the previous rounds' `taskset -c 0-3 node --test --test-concurrency=2`.
This is disclosed because it differs from the earlier rounds: at `-c 0-3` with
concurrency 2 the full selection did not finish inside this session's wall-clock
ceiling (it reached 2,152 of 3,386 outcomes in 590 s and was terminated), so the
pinning was widened to fit. Nothing the suite measures was changed — same
constraints, same reporters, same committed revision, same files; only the CPU
mask and the runner's concurrency. The two FOCUSED runs kept `-c 0-3` with
concurrency 2 and finished in 63 s each.

An intermediate full plain attempt at `taskset -c 0-7 --test-concurrency=4`
produced one failure: `SHU251 live worker restart adopts once and recovers
durable completion`, at `service/test/residual.test.mjs:65`, the unnamed
`assert.equal(response.ok, true)` inside the harness's `launchBuilder` — a live
supervisor daemon, a real Unix socket and a detached worker, on a host already
carrying a five-minute load average near 5. That whole file then passed in
isolation under the same CI-like conditions, unchanged, 11 tests / 11 pass /
0 fail / 0 skip / `1..11` / exit 0, and the full plain run reported in the table
above — at `-c 0-9`, which gives each runner more headroom — passed all 3,386.
No assertion, timeout or deadline was relaxed. Resource contention is a possible
explanation, not an independently proved cause; it is recorded here rather than
dropped.

##### Mutant replay

Every mutant this round introduced was replayed on the committed revision and
the assertion that killed it was READ OFF the failure, not inferred from the
table. **Thirteen mutants, thirteen kills, no survivors.**

The eight in-process mutants of `shu71-production-mutations.test.mjs` were
driven through their own controls, each first verified to PASS on the unmutated
module:

| Replayed mutant | Killing assertion observed |
| --- | --- |
| `expiry invocation never crosses the kernel lock` | `B4_REEXEC_PRESENT_BYTE_EXACT` |
| `expiry invocation element invented when the parent has none` | `B4_REEXEC_ABSENT_BYTE_EXACT` |
| `empty parent invocation treated as a value` | `B4_REEXEC_EMPTY_BYTE_EXACT_AS_ABSENT` |
| `parent environment carried through the kernel lock` | `B4_REEXEC_BOUNDARY_EXACTLY_THREE_ASSIGNMENTS` |
| `kernel lock no longer wipes the environment` | `B4_REEXEC_BOUNDARY_ENVIRONMENT_IS_WIPED` |
| `expiry invocation element read from the environment, not the argument` | `B4_REEXEC_BOUNDARY_EXACTLY_THREE_ASSIGNMENTS` |
| `expiry invocation value split across argv elements` | `B4_REEXEC_SINGLE_ELEMENT_BYTE_EXACT` |
| `expiry invocation comparison loosened below exact equality` | `B4_EXPIRY_INVOCATION_EXACT_EQUALITY_leading-space_REFUSED` |

The five end-to-end mutants of `shu71-reexec-boundary.test.mjs` were replayed in
place, with each `assert.throws` instrumented to record the assertion the
control really died on:

| Replayed mutant | Killing assertion observed |
| --- | --- |
| `B4 mutation: the locked re-exec drops the invocation element` | `B4_REEXEC_END_TO_END_INNER_ENVIRONMENT_IS_EXACTLY_THREE` |
| `B4 mutation: the invocation element is read from the environment, not the argument` | `B4_REEXEC_END_TO_END_INNER_OBSERVED_THE_PROPAGATED_ID` |
| `B4 mutation: the invocation value is split across argv elements` | `B4_REEXEC_ONE_VARIABLE_ONE_ARGV_ELEMENT` |
| `B4 mutation: the parent environment is carried through the kernel lock` | `B4_REEXEC_END_TO_END_NO_OPERATOR_VALUE_IN_THE_COMMAND` |
| `B4 mutation: the kernel lock no longer wipes the environment` | `B4_REEXEC_END_TO_END_INNER_ENVIRONMENT_IS_EXACTLY_THREE` |

**Where the poisoned-environment mutant dies, precisely.** It does NOT reach the
inner process. Under that mutant the constructed command grows from 12 elements
to 162 and carries `SHU71_REEXEC_POISON=operator-value-that-must-not-cross`;
`B4_REEXEC_END_TO_END_NO_OPERATOR_VALUE_IN_THE_COMMAND` is the first assertion
`reexecEndToEnd` makes after construction, so the control dies there and
`lockedChild` is never called. Executed separately, purely to characterise the
mutant, that command's inner process inherits 151 variables including both
poison names, and its teardown still reports `{"ok":true,"state":"REVOKED"}` —
so the widened boundary is invisible to the teardown's own result and is caught
only by the measurement of what crosses. On the UNMUTATED module both poison
names and both poison values are absent from all 12 elements of the constructed
command, and the inner process's environment is exactly `INVOCATION_ID`, `PATH`,
`SHU71_LOCKED` with values `deadbeefcafef00d0123456789abcdef`,
`/usr/bin:/bin` and `1` — no poison name and no poison value on either side.

**The three argv rows above were re-measured.** The real CLI entry was run in
its own process for the present, absent (`delete env.INVOCATION_ID`) and empty
(`INVOCATION_ID=''`) cases, and the recorded commands are byte-identical to the
three rows printed earlier in this section.

##### Every control name in this section resolves to an assertion the tree emits

Each `B4_*` name in the round's tables was resolved against the names the
committed tree really produces — literal or composed from a `name` binding plus
a template suffix — and the emitted names were captured from a probed run of
`shu71-reexec-boundary.test.mjs`. Two did not resolve, and both are corrected
above: `B4_REEXEC_ONE_VARIABLE_NO_SECOND_VARIABLE`, which no assertion emits,
and the mis-attribution of the poisoned-environment mutant. Every remaining name
in this section resolves, and every mutant/control pair in the two tables above
is one this round observed by replay.

### Seventh correction round: the arming comparison is over the FIELDS, not the rendering

#### P276-01, and why a fully green suite never saw it

The production arming entrypoint refused `ACT_PRIOR_STATE_DRIFT` on the target
host for `shu71-mint-00000019` while both fixture cards were exactly where the
signed artifact required them. `issue()` MEASURES a card off Linear and
constructs it as `{ state_id, assignee_id }`. The owner approval is sealed by
`compose-shu71-approval.mjs` `seal`, which writes `canonicalBytes(doc, false)` -
and `canonicalBytes` SORTS every key - so the identical card is stored, and
therefore deserialized on the host, as `{ assignee_id, state_id }`. The four
comparisons were `JSON.stringify` equality, which compares the RENDERING rather
than the card, so on a real host they can never match and the window cannot arm
at all.

The suite was green because `productionFixture` sealed its approval envelope
with `JSON.stringify(approval)` - the mint's own in-memory construction order -
which is the one serialization the broken comparison can satisfy. The fixture
happened to agree with the code instead of with the sealer.

#### The fix, and exactly what it newly accepts

`shu71-production.mjs` exports `FIXTURE_CARD_FIELDS` and `sameFixtureCard(a, b)`,
which compares the two named fields and holds BOTH sides closed to exactly those
two keys. All four sites use it:

| Site | Expression |
| --- | --- |
| `shu71-production.mjs:167` | `if (sameFixtureCard(current, target)) return;` |
| `shu71-production.mjs:168` | `need(restoring \|\| sameFixtureCard(current, t.before), 'ACT_PRIOR_STATE_DRIFT')` |
| `shu71-production.mjs:171` | `need(... && sameFixtureCard(await issue(t), target), 'ACT_PARTIAL_ARMING')` |
| `shu71-production.mjs:319` | `need(sameFixtureCard(await issue(t), t.before), 'ACT_PRIOR_STATE_DRIFT')` |

The only newly accepted input is a different key ORDER. Refusal codes, their
names and their conditions are unchanged: a card genuinely in the wrong state
still refuses `ACT_PRIOR_STATE_DRIFT`, and a partial arming still refuses
`ACT_PARTIAL_ARMING`. `productionFixture` now seals with `canonicalBytes`, the
real target-host shape, by default.

#### The RED, measured on the unmodified revision

`6bf87512` is the last revision before the fix. Its `shu71-production.mjs` was
copied out of Git and loaded from a disposable path with its relative imports
rebound to the checked-out siblings - the same loading the in-process mutant
harness uses - and the round's target-host-shape control
(`canonicalArmsCheck`, byte-for-byte) was run against it:

```
pre-fix module: 6bf87512:.github/coordinator/service/shu71-production.mjs
  exports sameFixtureCard: false
  JSON.stringify comparison sites: 4

RESULT: control FAILED on the pre-fix revision -- RED observed.
  error.code            : ERR_ASSERTION
  failed assertion name : B1_BINDING_PRIOR_STATE_FIELD_EQUAL
  operator              : strictEqual
  actual                : "ACT_PRIOR_STATE_DRIFT"
  expected              : null
```

The same control against the committed head passes, with
`exports sameFixtureCard: true` and zero `JSON.stringify` comparison sites.

The reach of the defect was measured the same way, by writing the `6bf87512`
module bytes into the worktree and running the existing production proofs
against the corrected (canonical) fixture default:

| File | Tests | Pre-fix pass | Pre-fix fail | Head pass | Head fail |
| --- | ---: | ---: | ---: | ---: | ---: |
| `shu71-production.test.mjs` | 85 | 21 | 64 | 85 | 0 |
| `shu71-production-mutations.test.mjs` | 81 | 15 | 66 | 81 | 0 |

`shu71-arming-order.test.mjs` cannot even load against `6bf87512`: it imports
`sameFixtureCard`, which that revision does not export, so the file fails as a
whole rather than test by test. That is recorded rather than counted as 18 kills.

#### New controls, the gap they left, and the gap this round closes

`shu71-arming-order.test.mjs` carries nine controls and nine mutants.

Eight controls drive the real entrypoint: the canonical (mint) key order arming,
the mirror construction order, the ready pair, the post-update read-back
(`ACT_PARTIAL_ARMING`), the restore read-back, the already-at-target early
return, and two genuine-drift refusals - one at each `ACT_PRIOR_STATE_DRIFT`
site.

Those eight were not enough. The two-key closure inside `sameFixtureCard()` is
NOT reachable through the entrypoint: `issue()` constructs exactly two keys and
`validateShu71Package`'s `exactObject` holds the artifact card to exactly two, so
no window can present a third key or a missing one. Both doors of the closure
were therefore SURVIVORS - dropping the key-count guard, and dropping the
`Object.hasOwn` guard, each left all fifteen then-committed arming-order tests
passing. This round adds the ninth control, directly on the exported comparison:
it accepts the same card in both key orders, refuses a field-equal card carrying
a third key, refuses a two-key card missing a reviewed field, and still refuses
a genuinely different assignee. Both mutants die on it.

#### The mutant x control matrix

Every mutant was run against EVERY control on the committed head. A cell is a
KILL only when the control threw an `ERR_ASSERTION` carrying a `B1_`/`B4_` name,
and that name was READ OFF the thrown error. All nine controls pass on the
unmutated module. **Nine mutants, nine killed, zero survivors.**

| Mutant | Paired control | Killing assertion observed | Controls that kill it |
| --- | --- | --- | ---: |
| binding prior-state -> `JSON.stringify` equality | canonical mint key order arms the window | `B1_BINDING_PRIOR_STATE_FIELD_EQUAL` | 5 / 9 |
| transition prior-state -> `JSON.stringify` equality | both fixtures reach the reviewed ready state | `B1_READY_PRIOR_STATE_FIELD_EQUAL` | 5 / 9 |
| post-update `target` -> `JSON.stringify` equality | post-update ready read-back | `B1_READY_READBACK_FIELD_EQUAL` | 5 / 9 |
| already-at-target early return -> `JSON.stringify` equality | a card already at its target is not rewritten | `B4_RESTORE_IDEMPOTENT_NO_WRITE` | 1 / 9 |
| field comparison accepts any pair of cards | a genuinely drifted assignee still refuses | `B1_GENUINE_DRIFT_REFUSED` | 4 / 9 |
| field comparison stops reading `assignee_id` | a genuinely drifted assignee still refuses | `B1_GENUINE_DRIFT_REFUSED` | 2 / 9 |
| field comparison stops reading `state_id` | a card that drifts in state still refuses | `B1_READY_GENUINE_DRIFT_REFUSED` | 2 / 9 |
| field comparison accepts a differently-shaped card | the field comparison stays closed | `B1_SHAPE_EXTRA_KEY_REFUSED` | 1 / 9 |
| field comparison stops requiring both reviewed keys | the field comparison stays closed | `B1_SHAPE_MISSING_FIELD_REFUSED` | 1 / 9 |

Two facts in that matrix are disclosed rather than smoothed over.

**The mirror-order control kills nothing.** `construction key order still arms
the window` is the only control that kills no mutant in this set, and that is
expected: every mutant here either reverts a site to serialization equality -
which the construction order satisfies, since that is precisely why the broken
code passed the old suite - or widens the comparison, which an arming control
cannot see. It is a non-regression guard for the opposite serialization, not a
killer, and it is reported as such.

**The restore path is covered by two controls, one of which is a killer.**
`restore read-back accepts a field-equal card` kills the three site-reverting
mutants that pass through `transition(t, t.restore, true)`; `a card already at
its target is not rewritten` is the sole killer of the early-return mutant.

#### Audit: every constructed-vs-artifact comparison under `service/`

The comparison mechanisms in `.github/coordinator/service/*.mjs` are exactly
four, and only one of them is sensitive to key order.

| Mechanism | Order-sensitive? |
| --- | --- |
| `canonical()` (`phase-a-driver.mjs:53`) - sorts keys recursively | no |
| `canonicalBytes()` (`shu71-activation-package.mjs:31`) - sorts keys recursively | no |
| `assert.deepEqual` / `isDeepStrictEqual` | no |
| raw `JSON.stringify(a) === JSON.stringify(b)` | **yes** |

Per-site verdicts for every order-sensitive site, plus the sites named in the
brief:

| Site | Verdict | Reasoning |
| --- | --- | --- |
| `shu71-production.mjs:167,168,171,319` | **fixed** | The defect. Constructed card vs a CANONICALLY SEALED artifact: two different producers, one of which sorts. Now `sameFixtureCard()`. |
| `provision-shu71-prerequisites.mjs:275` | already order-safe | Both sides are `{ bytes, mode, uid, gid }` in one literal order: `current` from `read()`, `e.before` from `read()` through the receipt, `e.after` from a literal with the same order. The receipt is written by `save()` as `JSON.stringify(j)` and read by `JSON.parse` - no canonicalizer anywhere on the path, and `JSON.parse` preserves key order. |
| `provision-shu71-prerequisites.mjs:277,311` | already order-safe | Same two producers as `:275`: `read()` against a journal `before` that `read()` produced. |
| `provision-shu71-prerequisites.mjs:306,315` | already order-safe | Same, for `ACCOUNT_FILES` entries: `account.before` is `read()` output round-tripped through the same `JSON.stringify` receipt. |
| `provision-shu71-prerequisites.mjs:414` | already order-safe | `j.broker` is the receipt's copy of `identity()`/`allocate()` output, both `{ name, uid, gid }`; the right side is a fresh `identity()`. Same module, same literal order, `JSON.stringify`/`JSON.parse` receipt. |
| `provision-shu71-prerequisites.mjs:264` | not this class | Compares ARRAYS of paths (`e.accounts.map(a => a.path)` against `ACCOUNT_FILES`); array order is the reviewed contract, not an object key order. |
| `host-window-bindings.mjs:48` (`exactKeys`) | already order-safe | Both operands are `Object.keys(...).sort()` - explicitly sorted before comparison. |
| `host-window-bindings.mjs:266` | not this class | Compares content DIGESTS and `Buffer.equals` of unit bytes. |
| `suite-runner-spec.mjs:10` (`equal`) | not this class | Used only on arrays: the sorted supplementary-group list (`:22`) and the tracked test-file list (`:52`). |
| `host-lifecycle.mjs` - all `equal()` / `keys()` guards | already order-safe | `equal` is `canonical(a) === canonical(b)`, and `canonical()` sorts every object's keys recursively before rendering. |
| `production-lifecycle.mjs` - all `equal()` guards, including `approval()` | already order-safe | Same `canonical()`. `approval()` additionally compares `a.spec_sha256` against `hash(canonical(bound))` - canonicalized on BOTH sides, which is the pattern the arming sites now match in spirit. |
| `compose-shu71-approval.mjs:11,47` (`same`) | already order-safe | `canonicalBytes(a).equals(canonicalBytes(b))`: both sides sorted. |
| `mint-shu71-package.mjs:22` (`same`) | already order-safe | Same `canonicalBytes` on both sides. |
| `shu71-production.mjs:336-337` | already order-safe | `digest(canonicalBytes(...))` on both the adopted signed package and the approved package. |
| `shu71-production.mjs:231` | already order-safe | Signature verification over `canonicalBytes(doc.payload, false)`. |
| `shu71-production.mjs:389-390` (`installedReadback`) | already order-safe | Compares BYTES (`Buffer.equals`). The expected bytes are `JSON.stringify(pkg.activation)`; the file was written by the same expression from the same object, and on the repeat path `pkg` is re-parsed from the same durable `signed-package.json`. `ACTIVATION_FILE` has exactly one producer. |
| `shu71-journal.mjs:32,42` | already order-safe | A `JSON.stringify` hash chain written and verified by the same module, round-tripped through `JSON.parse`. Byte-exactness is the point of the chain. |
| `install.mjs:43,56` | already order-safe | `assert.deepEqual` against a `JSON.parse`d backup: key-order-insensitive. `:37` compares sorted key arrays. |
| `residual-validation.mjs:49,54` | already order-safe | `assert.deepEqual`, and a sorted key-set comparison. |
| `reviewer-host-validation.mjs:50`, `units.mjs:197,200`, `reviewer-isolation.mjs:71,108`, `phase-a-driver.mjs:281,345` | not this class | Buffers, byte comparisons, or arrays of strings. |

One residual is recorded, not changed. `disposable-suite.mjs:21` binds a
disposable run to `sha256(JSON.stringify(spec))`, recomputed in each later
invocation (`create`, `run`, `remove`) from the same operator spec FILE, which
every entrypoint loads with `JSON.parse` (`host-suite-contract.mjs:312`). It is
order-safe as deployed, because nothing between the phases re-serializes the
spec. It is the same class in principle: a spec file regenerated with sorted
keys between `create` and `run` would refuse `SHU251_SUITE_DISPOSABLE` rather
than run. It is disclosed here and left alone - changing it would be a new
reviewed behaviour, which this round does not introduce.

#### The two collateral commits, and the `approvalBytes` affordance

`a18647d` rebinds two kinds of existing proof to the corrected fixture default.

*Historical differentials.* `counterDifferential`
(`shu71-r4-differential.mjs`), `r5Differential` (`shu71-r5-checks.mjs`) and the
`historical control semantics` proofs (`shu71-history.test.mjs`) execute
VENDORED PRIOR revisions of `shu71-production.mjs`. Those revisions compare the
prior state by `JSON.stringify` and cannot consume a canonically sealed approval
at all, and a differential must feed its `parent`, `blocked` and `candidate`
arms the SAME bytes. Four call sites - one in `counterDifferential`, one in
`r5Differential`, two in `shu71-history.test.mjs` - therefore pin
`approvalBytes: 'construction'` explicitly. (The commit message says "three call
sites"; it is three helpers and four call sites. The correction is recorded
here; the commit is not rewritten.)

*Documentation links.* `V8_DOCUMENTATION_LINK_TARGETS` pins markdown links to
EXACT line numbers in `shu71-production.mjs` and
`provision-shu71-prerequisites.mjs`, and fails on a one-line drift.
`sameFixtureCard()` added thirteen lines above every `shu71-production.mjs`
target, so each moved by exactly thirteen:

| Document | Link text | Before | After |
| --- | --- | ---: | ---: |
| `ACTIVATION-WINDOW-RECONCILIATION.md` | `signing step in shu71-production.mjs` | `#L317` | `#L330` |
| `SHU71-L3-CLOSURE.md` | `` `renderEvidenceBroker()` `` | `#L777` | `#L790` |
| `SHU71-PREREQUISITES.md` | `operative unit render` | `#L777` | `#L790` |
| `SHU71-PREREQUISITES.md` | `start` | `#L353` | `#L366` |
| `SHU71-PREREQUISITES.md` | `stop` | `#L721` | `#L734` |

That is FIVE link targets across three documents, not the four the commit
message claims. No link TEXT, target symbol, document or assertion changed; the
three `provision-shu71-prerequisites.mjs` links are untouched because that file
did not change.

`da488cc` rebinds three more proofs. NV2's mutation anchor in
`shu71-trust-mutations.test.mjs` is updated IN PLACE to the expression it now
attacks - `result.issueUpdate?.success === true && sameFixtureCard(await issue(t), target)`
- with its case name (`NV2 transition readback omitted`), its mutation
(`result.issueUpdate?.success === true`) and its killing assertion unchanged.
`CONTRACT_PRE_FIX_ACTIVATION_UNREADABLE` (`shu71-host-contract.test.mjs`) and the
six `PHASE_PRE_FIX_*` controls (`shu71-phase-readback.test.mjs`) execute vendored
PRIOR revisions to demonstrate the defects those revisions had, so only those
controls pin `approvalBytes: 'construction'`, through a new optional argument on
their own local fixture helpers (`prepared`, `scenario`). Every current-module
control in both files keeps the real target-host shape.

*The affordance itself.* `productionFixture(t, keys, signingPath, host, options)`
takes `options.approvalBytes`. It changes ONE thing: how the owner-approval
envelope is SERIALIZED on disk at
`/etc/shu/approvals/<id>.shu71.json`. `'canonical'` - the DEFAULT - writes
`canonicalBytes(approval, false)`, byte-for-byte what `compose-shu71-approval.mjs`
`seal` writes on the real host. `'construction'` writes `JSON.stringify(approval)`,
the mint's in-memory key order. The payload, the signature and every field value
are identical either way; only the byte order of the keys differs. The
historical differentials stay meaningful with it because a differential's claim
is about the DIFFERENCE between the arms under identical input - and all three
arms are fed the identical construction-order bytes - not about which
serialization the host uses. The default for every current-module control,
including every arming-order control that drives the entrypoint except the
deliberate mirror control, remains the real canonical target-host shape.

#### What this round did NOT change

No new reviewed effect. No production module was touched by the evidence
commit; the only production change in this round is the four comparison sites
and the exported helper above it. No refusal code, condition or name was added,
renamed or removed. The mutant harness keeps its existing assertion names,
`B1_MUTATION_ANCHOR_UNIQUE` and `B1_MUTATION_NAMED_ASSERTION`, moved verbatim
into the shared `loadMutant()` / `killedBy()` helpers. No assertion, name, code,
skip, timeout or deadline was weakened, renamed or deleted anywhere in the
round: measured against `6bf87512`, the inventory gained 18 names and one file
with ZERO removals, and `names` and `requirements` are strict prefix extensions.
`PERMITTED_SKIPS` (1,093 bytes, sha256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`) and
`host-suite-contract.mjs` (sha256 `2a19d72c…58e9`) are byte-identical.

#### Validation of the seventh correction round

Tested implementation `af89f75519b62f735d157b0e53424070a3b833fa`, tree
`a648e7f762876d9aec57c2b73310eeb1be79107a` — the round's three fix commits plus
the shape-closure control commit. This record section follows it and changes
documentation only: it adds no test name, so all three inventories are
unchanged by it. The worktree was clean for all four runs.

All four commands ran from the repository root under the CI-like harness
(`service/test/fixture/shu71-ci-like.sh`), which printed
`CI_CONSTRAINTS uid=1000 umask=0022 target_accounts=absent runtime=absent
reviewer=absent` for each: UID 1000, `umask 0022`, target accounts absent
(`shu71-evidence`, `shu-coordinator`, `shu-workspace`, `messagebus` — filtered
out of `/etc/passwd` and `/etc/group` and re-checked with `getent` inside the
namespace), `/run` and `/etc/sudoers.d` tmpfs, `/run/shu71-evidence` and
`/etc/sudoers.d/shu-reviewer` absent, `chmod -R go-w .github/coordinator`, with
both the TAP reporter and the unchanged `host-suite-contract.mjs` reporter
writing separate outputs. Plain unsets `NODE_OPTIONS` and
`SHU_TEST_CLOCK_OFFSET_MS`; clock sets `SHU_TEST_CLOCK_OFFSET_MS=31536000000`
and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.
Focused used `taskset -c 0-3 node --test --test-concurrency=2`; full used
`taskset -c 0-9 node --test --test-concurrency=4`, the same pinning the sixth
round disclosed. The four runs were executed strictly one at a time.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit | Load at start → end | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Focused plain | 1691 | 1690 | 0 | 1 | 1 / 1 | 0 | 1.19 → 2.65 | 66.9 s |
| Focused clock | 1691 | 1690 | 0 | 1 | 1 / 1 | 0 | 1.75 → 2.48 | 73.6 s |
| Full plain | 3404 | 3396 | 0 | 8 | 1 / 1 | 0 | 2.44 → 2.02 | 583.4 s |
| Full clock | 3404 | 3396 | 0 | 8 | 1 / 1 | 0 | 1.79 → 2.97 | 521.1 s |

Every command exited zero with zero cancelled and zero todo outcomes, and no
`not ok` line in any of the four TAP outputs. Focused TAP plans are `1..1691`;
full plans are `1..3399`, with five nested outcomes under one nested `1..5`
bringing each full total to 3,404. Each run's structured report has exactly one
terminal `complete` event, is terminated by it, and passes the unchanged
`evaluateSuite` validator (1,691 / 1,691 / 3,404 / 3,404 expected outcomes).
Both full runs' 3,404 outcome names are exactly the committed inventory's 3,404
names with identical multiplicities — zero missing and zero extra — and `A12
committed inventory requirements match real outcomes` passes in both. Every
skip in all four runs is a `PERMITTED_SKIPS` entry carrying that entry's exact
documented reason, byte-for-byte, compared against the exported object rather
than by eye; the single focused skip is `SHU-71 restricted capability refusal`.

##### The focused selection missed the round's own control file

The focused selection's service-side globs are `provision*.test.mjs`,
`shu71-production*.test.mjs` and `shu71-trust*.test.mjs`. NONE of them matches
`shu71-arming-order.test.mjs`, so this round's only dedicated control file sat
outside the selection that is run first on every change to this lane — the same
kind of gap the sixth round closed for `shu71-reexec-boundary.test.mjs`. It is
closed the same way, by NAMING the file:

```sh
node --test \
  .github/coordinator/test/shu71-activation-package.test.mjs \
  .github/coordinator/test/shu71-battery.test.mjs \
  .github/coordinator/test/shu71-public-key.test.mjs \
  .github/coordinator/test/single-run-activation.test.mjs \
  .github/coordinator/test/supervisor.test.mjs \
  .github/coordinator/test/supervisor-dispatch.test.mjs \
  .github/coordinator/service/test/provision*.test.mjs \
  .github/coordinator/service/test/shu71-owner-decisions.test.mjs \
  .github/coordinator/service/test/shu71-phase-readback.test.mjs \
  .github/coordinator/service/test/shu71-production*.test.mjs \
  .github/coordinator/service/test/shu71-reexec-boundary.test.mjs \
  .github/coordinator/service/test/shu71-recovery-mutations.test.mjs \
  .github/coordinator/service/test/shu71-supervisor-environment.test.mjs \
  .github/coordinator/service/test/shu71-composition.test.mjs \
  .github/coordinator/service/test/shu71-trust*.test.mjs \
  .github/coordinator/service/test/shu71-verdict-closures.test.mjs \
  .github/coordinator/service/test/shu71-host-contract.test.mjs \
  .github/coordinator/service/test/shu71-arming-order.test.mjs
```

Eighteen entries expanding to 25 test files — the sixth round's 17 entries and
24 files plus this one. The focused total is the sixth round's 1,673 plus this
round's 18 inventory names: 1,691; all 18 fall inside the selection. The full
total is 3,386 plus the same 18: 3,404. The full selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
(115 files, one more than the sixth round's 114). All eighteen of
`shu71-arming-order.test.mjs`'s tests — the nine controls and the nine mutants —
were present in the outcome stream of all four runs above, focused and full
alike, and each mutation test emitted its `killed by B1_…`/`B4_…` diagnostic.

### Eighth correction round: the post-push read-back is retried, and a failed call names itself

#### P277-01 and P277-02, measured on the target host

An approved window was armed through the documented entrypoint
`shu71-production.mjs run <id>`. The previous round's defect is gone: `binding`
PASSED on the real host and the run continued through `sign`, `expiry-watch`,
`local-reseed` and `remote-push`, where it halted:

```json
{"ok":false,"state":"HALT","code":"ACT_API_FAILED","teardown":{"ok":true,"state":"REVOKED","code":null,"failures":[]}}
```

**The push had already landed.** Measured read-only afterwards:
`refs/heads/coordinator/SHU-140` on the remote is the reseed commit
`21e41fef6966604039cd9cbea4ad7151c80ed68a`; the ancestry call the step requires
answers `status: 'ahead'` with `merge_base_commit.sha` =
`6e5ad86cc0a993097d2e642132077b665ad49481` — exactly the values the code demands;
and the coordinator's own token answers 200 on the compare route and on both ref
routes, with 4,949 requests of headroom. So the call that failed was a transient
answer to a READ whose condition already held.

**P277-01.** `remote-push` pushes a fresh seed commit and then IMMEDIATELY reads
the result back — `git/ref/heads/<branch>` and `git/ref/heads/main` inside
`heads(spec, true)`, then `compare/<old>...<next>`. GitHub answers those routes
from replicas and does not compute a comparison for a just-written SHA
instantly, so a landed push can be answered 404 or 5xx for a moment. A single
transient non-2xx failed the entire arming even though the push had succeeded
and every required condition held.

**P277-02.** `ACT_API_FAILED` is raised only by `need(result.ok, …)` and its two
siblings, and the halt record carried neither the route nor the status. **The
failing call cannot be identified from the episode evidence at all** — not from
the returned record, not from the `HALTED` journal row, not from anything else
this module writes. That is stated plainly rather than guessed at: this round
did not determine which of the seven reads answered non-2xx, only that one of
them did and that every one of them answers correctly now.

#### The fix: one retried door, and it opens onto reads only

| Site | Clause before | Clause after |
| --- | --- | --- |
| `api()` fetch | `const result = await b.fetch(url, …)` | unchanged call, wrapped: a transport throw is re-thrown **unchanged** with `{ operation, reason: 'transport', fault }` attached |
| `api()` status | `need(result.ok, 'ACT_API_FAILED')` | same refusal, same name, carrying `{ operation, reason: 'response_not_ok', status }` |
| `api()` size | `need(Buffer.byteLength(text) <= 1024*1024, 'ACT_API_FAILED')` | same refusal, carrying `{ operation, reason: 'response_too_large', status }` |
| `github()` | `api(url, { headers })` | `api(url, { headers }, \`github:${route}\`)` |
| `githubRead()` | — | **new**: bounded retry around `github()`; the only retried call in the module |
| `heads()` ref read-back | `const readback = await github(\`git/ref/heads/…\`)` | `await githubRead(…)`; the `need(…, 'ACT_REF_BINDING')` is unchanged and stays OUTSIDE the retry |
| `heads()` main ref | `(await github('git/ref/heads/main')).object?.sha === revision` | `(await githubRead('git/ref/heads/main')).object?.sha === revision`; `ACT_REVISION_BINDING` unchanged |
| `remote-push` compare | `const comparison = await github(\`compare/${old}...${next}\`)` | `await githubRead(…)`; `need(comparison.status === 'ahead' && comparison.merge_base_commit?.sha === old, 'ACT_REMOTE_ANCESTRY')` unchanged and outside |
| `linear()` | `need(!result.errors && result.data, 'ACT_API_FAILED')` | same refusal, carrying `{ operation: 'linear:<query\|mutation>:<name>', reason: 'graphql_errors', codes }` |
| `execute()` after the spec | — | `authorizationEnds = Date.parse(spec.pkg.expires_at)` |
| `execute()` halt | `journal.append({ event: 'HALTED', code, ...named })` | `journal.append({ event: 'HALTED', code, ...named, ...detail })` |
| `execute()` halt return | `{ ok: false, state: 'HALT', code, ...named, teardown }` | `{ ok: false, state: 'HALT', code, ...named, ...detail, teardown }` |
| `execute()` ARMED return | `{ ok: true, state: 'ARMED', activation_id: id }` | `{ ok: true, state: 'ARMED', activation_id: id, ...readRetryRecord() }` — absent unless a read actually raced |

`githubRead()` **retries the CALL, never a COMPARISON.** Any 2xx answer is
returned to the caller unchanged, including one carrying the WRONG sha or a
compare status that is not `ahead`, so a genuine state mismatch still refuses on
the first answer under `ACT_REF_BINDING` / `ACT_REVISION_BINDING` /
`ACT_REMOTE_ANCESTRY`. `github()` sets no method, so every call reaching the
retried door is a GET; no mutation is reachable from it.

#### The retry policy, and why its bound is safe

```js
export const READ_RETRY = Object.freeze({ attempts: 5, delaysMs: Object.freeze([1000, 2000, 4000, 8000]), budgetMs: 60000 });
export const RETRYABLE_READ_STATUS = Object.freeze([404, 408, 409, 425, 429, 500, 502, 503, 504]);
```

Four bounds, each with its own control and its own killing mutant:

1. **Attempts.** Five per read, backing off 1s, 2s, 4s, 8s — at most 15s of sleep
   and five 10s request timeouts for one read.
2. **An overall budget.** `budgetMs` is the TOTAL sleep this mechanism may add to
   ONE invocation, decremented across calls, so seven racing reads cannot
   multiply the per-call bound. Once it is spent the next failure refuses on its
   first attempt.
3. **The authorization expiry.** A retry is never waited out past
   `spec.pkg.expires_at`, so no retry can carry work into a window it was not
   approved for. While `authorizationEnds` is unset nothing retries at all.
4. **The outcome.** Only a transport/timeout fault or a transient status
   qualifies. `400`, `401`, `403`, `410` and `422` are the ANSWER rather than a
   race and are never retried, so a revoked token or a forbidden route still
   refuses immediately.

When any bound ends the loop the ORIGINAL error is rethrown, so a persistent
failure still refuses under exactly the name it refuses under today.

#### Every call this module makes, and which ones retry

| Call | Method | Retried | Why |
| --- | --- | --- | --- |
| `githubRead('git/ref/heads/<branch>')` | GET | **yes** | reads back a ref this episode may have just written |
| `githubRead('git/ref/heads/main')` | GET | **yes** | same route family, same replica lag |
| `githubRead('compare/<old>...<next>')` | GET | **yes** | the exact call the target host halted on |
| `linear('query Shu71Fixture …')` | POST | no | GraphQL over POST, not a GET; `linear()` is shared with the mutation below, so a retry there could repeat a write |
| `linear('mutation Shu71Fixture …')` | POST | no | a mutation |
| `git push --force-with-lease` | — | no | a mutation |
| signing, the activation write, the gate drop-ins, every `systemctl`, every teardown step | — | no | mutations, or safety effects that must fail loudly |

#### What a failed call is allowed to say about itself

`apiFailureDetail()` re-derives every reported field through a closed pattern or
a numeric range, so no token, header, URL, query, variable, response body or
response text can reach a record:

* `operation` — a route label or a reviewed GraphQL operation name, matched
  against `/^[A-Za-z0-9:/%._-]{1,120}$/`. `%` is admitted because a branch
  segment is percent-encoded into its route
  (`git/ref/heads/coordinator%2FSHU-140`); no separator, space, quote, `@`, `?`
  or `#` is, so a URL carrying credentials, a query string or a fragment is
  reported as `unknown` rather than echoed.
* `reason` — one of `transport`, `response_not_ok`, `response_too_large`,
  `graphql_errors`.
* `status` — a safe integer in `[100, 599]`.
* `fault` — a transport error NAME (`TimeoutError`, `TypeError`), matched against
  `/^[A-Za-z0-9_.-]{1,64}$/`.
* `codes` — GraphQL error codes under the same pattern, de-duplicated and capped
  at eight.
* `attempts` — a positive safe integer.

It is idempotent on its own output, and `error.code` is never touched by any of
it, so every refusal keeps its existing name and conditions.

#### The RED, measured on the unmodified revision

`b4aedf2a` is the last revision before this round. Its `shu71-production.mjs`
was copied out of Git and loaded from a disposable path with its relative
imports rebound to the checked-out siblings — the same loading the in-process
mutant harness uses — and the round's committed check functions were run against
it unchanged:

```
pre-fix module: b4aedf2a96fb1aa3487a31be307462640711ddb2:.github/coordinator/service/shu71-production.mjs
  exports READ_RETRY           : false
  exports apiFailureDetail     : false
  githubRead call sites        : 0
  bare github(...) read sites  : 3

RED   a transient ref read-back is retried and the window arms
        B5_REF_READ_RACE_RETRIED  strictEqual  actual "HALT"  expected "ARMED"
RED   a landed push whose comparison is not answerable yet still arms
        B5_COMPARE_RACE_RETRIED   strictEqual  actual "HALT"  expected "ARMED"
RED   a persistently failing read still refuses under the same name
        B5_PERSISTENT_FAILURE_REFUSED  strictEqual  actual 1  expected 5
green a genuinely wrong ref sha refuses instead of being retried
green a genuinely wrong ancestry refuses instead of being retried
green a failing push is never retried
RED   a failing Linear issueUpdate is never retried            (B5_LINEAR_MUTATION_NOT_RETRIED)
RED   the retry sleep budget is bounded across the whole invocation (B5_RETRY_BUDGET_BOUNDED)
RED   retrying stops at the authorization expiry               (B5_RETRY_STOPS_AT_EXPIRY)
RED   the halt names the failing route and status              (B5_HALT_NAMES_THE_CALL)
RED   a GraphQL refusal is named by its codes                  (B5_GRAPHQL_CODES_NAMED)

pre-fix: 8 of 11 end-to-end controls FAIL, 3 pass.
```

The three that PASS are exactly the ones asserting that a genuine mismatch, or a
mutation, is NOT retried — which a revision with no retry at all satisfies
trivially. They are recorded as passing rather than presented as kills: they
pin the fix against its own failure mode, not against the pre-fix revision. The
two closure controls cannot run against `b4aedf2a` at all, because it exports
neither `apiFailureDetail` nor `retryableApiFailure`; that is recorded rather
than counted.

#### New controls and new mutants

`shu71-postpush-readback-checks.mjs` holds eleven end-to-end controls and two
closure controls; `shu71-postpush-readback.test.mjs` drives them and the
twenty-one mutants. The checks module follows the existing
`shu71-r5-checks.mjs` / `shu71-trust-checks.mjs` pattern so that the SAME check
functions serve the suite, the matrix below and the RED above.

Controls:

1. a transient ref read-back is retried and the window arms
2. a landed push whose comparison is not answerable yet still arms
3. a persistently failing read still refuses under the same name
4. a genuinely wrong ref sha refuses instead of being retried
5. a genuinely wrong ancestry refuses instead of being retried
6. a failing push is never retried
7. a failing Linear issueUpdate is never retried
8. the retry sleep budget is bounded across the whole invocation
9. retrying stops at the authorization expiry
10. the halt names the failing route and status and carries no secret
11. a GraphQL refusal is named by its codes
12. the reported detail is closed to the reviewed fields
13. only a measured transient outcome is retryable

Controls 4 and 5 are the ones that matter most: the ref (resp. the comparison)
answers 200 with a WRONG value on its first answer and the right value on every
answer afterwards. A correct retry never sees the difference, refuses on that
first answer and never reads the route again — so the budget cannot convert a
real mismatch into a pass. Controls 10 and 11 assert, against the returned
record AND the durable `HALTED` row, that none of `GITHUB_POISON`,
`LINEAR_POISON`, the supervisor secret, `Authorization`, `Bearer` or
`x-access-token` appears anywhere in the evidence.

#### The mutant x control matrix

Every mutant was run against EVERY control on the committed head, out of band,
driving the committed check functions unchanged. A cell is a KILL only when the
control threw an `ERR_ASSERTION` carrying a `B5_` name, and that name was READ
OFF the thrown error. All thirteen controls pass on the unmutated module.
**Twenty-one mutants, twenty-one killed, zero survivors.**

| Mutant | Paired control's killing assertion | Controls that kill it |
| --- | --- | ---: |
| the retry policy allows a single attempt | `B5_REF_READ_RACE_RETRIED` | 5 / 13 |
| the backoff schedule is emptied | `B5_COMPARE_RACE_RETRIED` | 5 / 13 |
| the ref read-back goes back to the unretried door | `B5_REF_READ_RACE_RETRIED` | 3 / 13 |
| the post-push comparison goes back to the unretried door | `B5_COMPARE_RACE_RETRIED` | 3 / 13 |
| an exhausted retry returns an empty answer instead of refusing | `B5_PERSISTENT_FAILURE_REFUSED` | 4 / 13 |
| the overall sleep budget is not enforced | `B5_RETRY_BUDGET_BOUNDED` | 1 / 13 |
| the authorization expiry does not stop the retry | `B5_RETRY_STOPS_AT_EXPIRY` | 1 / 13 |
| a definitive status is treated as transient | `B5_HALT_NAMES_THE_CALL` | 2 / 13 |
| the ref comparison itself is retried until it agrees | `B5_REF_MISMATCH_NOT_RETRIED` | 1 / 13 |
| the ancestry comparison itself is retried until it agrees | `B5_ANCESTRY_MISMATCH_NOT_RETRIED` | 1 / 13 |
| the push is retried like a read | `B5_PUSH_NOT_RETRIED` | 1 / 13 |
| the halt record drops the measured API detail | `B5_HALT_NAMES_THE_CALL` | 6 / 13 |
| a failed call is no longer described at all | `B5_HALT_NAMES_THE_CALL` | 8 / 13 |
| the GraphQL error codes are not collected | `B5_GRAPHQL_CODES_NAMED` | 1 / 13 |
| the operation label is echoed unsanitized | `B5_DETAIL_OPERATION_CLOSED` | 1 / 13 |
| the status is echoed unchecked | `B5_DETAIL_STATUS_CLOSED` | 4 / 13 |
| the GraphQL codes are echoed unfiltered | `B5_DETAIL_CODES_CLOSED` | 1 / 13 |
| the transport fault is echoed unfiltered | `B5_DETAIL_FAULT_CLOSED` | 1 / 13 |
| the reason vocabulary is opened | `B5_DETAIL_REASON_CLOSED` | 3 / 13 |
| a refusal with no measured detail is retryable | `B5_RETRYABLE_REQUIRES_MEASURED_DETAIL` | 1 / 13 |
| every reason is retryable once a status matches | `B5_RETRYABLE_REASON_CLOSED` | 1 / 13 |

Seven of the twenty-one are killed by exactly ONE control. Each of those seven
attacks a clause that no other control reaches: the overall budget, the expiry
stop, either of the two comparison-widenings, the push retry, and four of the
sanitizer's own doors. They are the reason those controls exist at all.

#### Where the retry could in principle mask a genuine refusal

Stated rather than smoothed over.

* **A 404 that is real.** A branch or a comparison that genuinely does not exist
  answers 404, and 404 is on the retryable list because it is also the post-push
  race. Such a read is retried five times and then refuses `ACT_API_FAILED` —
  the same code, roughly fifteen seconds later. Nothing is accepted that was not
  accepted before; only the refusal is slower.
* **A 5xx that is really a broken remote.** Same shape, same code, same outcome.
* **A read that recovers between a wrong answer and a right one.** This is the
  one case the retry deliberately does NOT cover: any 2xx answer, right or
  wrong, ends the retry and is handed to the binding comparison. Controls 4 and
  5 pin exactly that, and two mutants that widen the retry from the call to the
  comparison die on them.
* **The post-update Linear read-back** inside `transition()` races a write we
  just made, and is NOT retried. That is a KNOWN residual: it is a GraphQL POST
  through the same `linear()` function as the `issueUpdate` mutation, and a
  retry at that layer could repeat a write. Narrowing it safely would need a
  separate read-only door on the Linear side, which this lane does not add. It
  has not been observed to fail on the target host.
* **The `git ls-remote` reads** inside `heads()` and `remote-push` are not
  retried either: they are local `git` invocations through `command()`, which
  refuses `ACT_COMMAND_FAILED` on a non-zero exit, and no reviewed effect in this
  lane may start retrying a command.

#### What this round did NOT change

No new reviewed effect, no new command, no widened acceptance. No refusal code,
condition or name was added, renamed or removed: `ACT_API_FAILED`,
`ACT_REMOTE_ANCESTRY`, `ACT_REF_BINDING`, `ACT_REVISION_BINDING`,
`ACT_PARTIAL_ARMING` and `ACT_PRIOR_STATE_DRIFT` all keep their exact conditions,
and a persistent failure and a genuine state mismatch both still refuse. The
retry adds no request that was not already made and repeats no write. Success
paths are byte-identical unless a read actually raced: `api_read_retries` is
absent when nothing retried. `PERMITTED_SKIPS` (1,093 bytes, sha256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`) and
`host-suite-contract.mjs` (sha256 `2a19d72c…58e9`) are byte-identical. Measured
against `b4aedf2a`, the inventory gained 34 names and one file with ZERO
removals, and `names` and `requirements` are strict prefix extensions.

#### Validation of the eighth correction round

Tested implementation `f2a018e0cfe578c60345fa5f5ec18559f02225fd`, tree
`dddfbf6d5c263ff14d6e64fe4c564506668698ef` — the round's fix commit plus the
checks-module commit. This record section follows it and changes documentation
only: it adds no test name, so all three inventories are unchanged by it. The
worktree was clean for all four runs, before and after.

All four commands ran from the repository root under the CI-like harness
(`service/test/fixture/shu71-ci-like.sh`), which printed
`CI_CONSTRAINTS uid=1000 umask=0022 target_accounts=absent runtime=absent
reviewer=absent` for each: UID 1000, `umask 0022`, target accounts absent
(`shu71-evidence`, `shu-coordinator`, `shu-workspace`, `messagebus`), `/run` and
`/etc/sudoers.d` tmpfs, `/run/shu71-evidence` and `/etc/sudoers.d/shu-reviewer`
absent, `chmod -R go-w .github/coordinator`, with both the TAP reporter and the
unchanged `host-suite-contract.mjs` reporter writing separate outputs. Plain
unsets `NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.
Focused used `taskset -c 0-3 node --test --test-concurrency=2`; full used
`taskset -c 0-9 node --test --test-concurrency=4`. The four runs were executed
strictly one at a time.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers | Exit | Load at start → end | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Focused plain | 1725 | 1724 | 0 | 1 | 1 / 1 | 0 | 1.98 → 4.56 | 78.0 s |
| Focused clock | 1725 | 1724 | 0 | 1 | 1 / 1 | 0 | 4.56 → 4.31 | 78.9 s |
| Full plain | 3438 | 3430 | 0 | 8 | 1 / 1 | 0 | 4.31 → 3.38 | 539.0 s |
| Full clock | 3438 | 3430 | 0 | 8 | 1 / 1 | 0 | 3.38 → 3.15 | 515.3 s |

Every command exited zero with zero cancelled and zero todo outcomes, and no
`not ok` line in any of the four TAP outputs. Focused TAP plans are `1..1725`;
full plans are `1..3433`, with five nested outcomes under one nested `1..5`
bringing each full total to 3,438. Each run's structured report has exactly one
terminal `complete` event, is terminated by it, and passes the unchanged
`evaluateSuite` validator (1,725 / 1,725 / 3,438 / 3,438 expected outcomes).
Both full runs' 3,438 outcome names are exactly the committed inventory's 3,438
names with identical multiplicities — zero missing and zero extra — and `A12
committed inventory requirements match real outcomes` passes in both, reporting
`f2a018e0…; 116 files; 3437 child outcomes plus this guard`. Every skip in all
four runs is a `PERMITTED_SKIPS` entry carrying that entry's exact documented
reason, byte-for-byte, compared against the exported object rather than by eye;
the single focused skip is `SHU-71 restricted capability refusal`.

##### The focused selection missed the round's own control file again

The focused selection's service-side globs are `provision*.test.mjs`,
`shu71-production*.test.mjs` and `shu71-trust*.test.mjs`. NONE of them matches
`shu71-postpush-readback.test.mjs` — the same gap the sixth and seventh rounds
closed for their own control files. It is closed the same way, by NAMING it:

```sh
node --test \
  .github/coordinator/test/shu71-activation-package.test.mjs \
  .github/coordinator/test/shu71-battery.test.mjs \
  .github/coordinator/test/shu71-public-key.test.mjs \
  .github/coordinator/test/single-run-activation.test.mjs \
  .github/coordinator/test/supervisor.test.mjs \
  .github/coordinator/test/supervisor-dispatch.test.mjs \
  .github/coordinator/service/test/provision*.test.mjs \
  .github/coordinator/service/test/shu71-owner-decisions.test.mjs \
  .github/coordinator/service/test/shu71-phase-readback.test.mjs \
  .github/coordinator/service/test/shu71-production*.test.mjs \
  .github/coordinator/service/test/shu71-reexec-boundary.test.mjs \
  .github/coordinator/service/test/shu71-recovery-mutations.test.mjs \
  .github/coordinator/service/test/shu71-supervisor-environment.test.mjs \
  .github/coordinator/service/test/shu71-composition.test.mjs \
  .github/coordinator/service/test/shu71-trust*.test.mjs \
  .github/coordinator/service/test/shu71-verdict-closures.test.mjs \
  .github/coordinator/service/test/shu71-host-contract.test.mjs \
  .github/coordinator/service/test/shu71-arming-order.test.mjs \
  .github/coordinator/service/test/shu71-postpush-readback.test.mjs
```

Nineteen entries expanding to 26 test files — the seventh round's 18 entries and
25 files plus this one. The focused total is the seventh round's 1,691 plus this
round's 34 inventory names: 1,725; all 34 fall inside the selection. The full
total is 3,404 plus the same 34: 3,438. The full selection is
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
(116 files, one more than the seventh round's 115), which is exactly what
`npm run test:coordinator` runs — its globs already cover the new file. All
thirty-four of `shu71-postpush-readback.test.mjs`'s tests — the thirteen
controls and the twenty-one mutants — were present in the outcome stream of all
four runs above, focused and full alike, and each mutation test emitted its
`killed by B5_…` diagnostic.

### Ninth correction round: the rest of the class the post-push read-back belonged to

Repository-only. No target host was contacted, no network call was made, and no
`git push` or `gh` command was run. Written against the revision it was measured
on: `a3030ad6`, tree `98bf16f6`.

#### The input, and what it was not allowed to do

An independent read-only audit of the arming and lifecycle path ranked 42
findings, 22 of them BLOCKING, and froze every citation at `b4aedf2a` — the
revision this branch is based on. Every site was re-read against the CURRENT
file before it was changed, because the previous round had already moved lines
and already closed some of the records.

**Already closed by the previous round, and not re-opened here.** `A-03` (the
shared API choke point resolving every status class identically) is closed by
`githubRead`, `RETRYABLE_READ_STATUS` and `retryableApiFailure`: 400, 401, 403,
410 and 422 are excluded by construction and the policy is applied per route and
per verb. `B-02` (`ACT_API_FAILED` carrying no route, status, reason or
operation, and `linear()` discarding `result.errors`) is closed by
`apiFailureDetail`, `describeApiFailure`, `graphqlErrorCodes` and
`linearOperation` — the audit's note that "the Linear route at `:158` is
unrepaired" was written against the frozen revision and is not true of the
current one, which reports `linear:query:Shu71Fixture` / `linear:mutation:Shu71Fixture`
with `reason: 'graphql_errors'` and the error CODES. The known example at
`:217`/`:225`/`:363` is closed. **`A-08` is NOT closed by the previous round**,
and the audit's own table marks it NON-BLOCKING: its three gaps are about the
BROKER-RUNTIME loop, which that round did not touch. It is deferred again below,
with its reason.

#### What this round closed, record by record

| Record | Outcome | Control (and mutant) |
| --- | --- | --- |
| **B-11** a transient `systemctl show` reported as a live-companion state claim | CLOSED | `a failed measurement is not a state claim about the host` + `a transient unit read is retried and the teardown completes`; still-refuses: `a genuinely live expiry companion still refuses by its own name`. Mutant `a failed measurement is reported as the state the caller named` → `B6_MEASUREMENT_NOT_A_STATE_CLAIM`; `the host-command read retry is removed` → `B6_TRANSIENT_MEASUREMENT_RETRIED` |
| **A-11** a transient read reported as "inventory incomplete or moved" | **PARTLY CLOSED by this round — three of the four enumerated conditions. Closed in full by the tenth round below; this row overstated it and is corrected here rather than left standing** | `SHU251_REMOTE_INVENTORY distinguishes a failed read from a moved inventory` + `… measures the branch read without changing fetchBranchHead`. Mutants → `SHU251_INVENTORY_READ_FAILURE_NAMED`, `SHU251_INVENTORY_TRANSIENT_RETRIED`, `SHU251_INVENTORY_DEFINITIVE_TERMINAL`, `SHU251_BRANCH_READ_MEASURED`. The fourth condition — **a 2xx whose body will not yield the measured field** — was NOT closed: this round's dispatch tested `ok !== true`, the HTTP status class, so `{ ok: true, status: 200, sha: null }` still halted `remote fixture inventory is incomplete or moved` after a single read, exactly as before the round. No control and no mutant covered that dispatch |
| **C-01** `ARMED` claimed from an exit status, and a resume that skipped the restart | CLOSED | `a supervisor that did not come up refuses instead of arming` × 3 (`inactive`, `substate`, `timer`) + `the gate step stops repeating on a resume`. Mutants → `B6_GATE_LIVENESS_MEASURED_*` × 3, `B6_GATE_RESUME_REMEASURES` |
| **C-02** the expiry mechanism installed with no read-back | CLOSED | `the expiry installation is measured, not assumed` × 3 (`inactive`, `disabled`, `unitfile`). Mutants → `B6_EXPIRY_INSTALLATION_MEASURED_*` × 3 |
| **A-01** the Linear `issue()` READ never retried | CLOSED | `a transient Linear fixture-card read is retried and the window arms` + `a persistently failing Linear read still refuses under the same name`; still-refuses: `a genuinely drifted fixture card…`, `a genuinely wrong fixture…`. Mutants → `B6_WINDOW_ARMS`, `B6_LINEAR_MUTATION_STILL_UNRETRIED` |
| **A-02** `git ls-remote` at three sites, never retried, naming nothing | CLOSED | `a transient ls-remote failure is retried and the window arms` + `a persistently failing ls-remote names the command it ran`; still-refuses: `a genuinely wrong remote sha refuses and names the leg`. Mutants → `B6_WINDOW_ARMS` × 2, `B6_COMMAND_RETRY_BUDGET_BOUNDED` |
| **A-04** the post-update Linear read-back racing a write we just made | CLOSED | `a stale read-back of a landed card transition is re-read, not refused`; still-refuses: `a card read-back that never reaches the target still refuses` × 2 (`never`, `elsewhere`). Mutants → `B6_WINDOW_ARMS`, `B6_CARD_READBACK_REFUSES_*` × 2 |
| **A-05** every host process final on its first failure | CLOSED | the ls-remote and measurement controls above, plus `the host-read sleep budget is bounded across the whole invocation`, `a boundary that throws is never retried and echoes no text`, `a systemctl mutation is attempted exactly once` × 3, `only an enumerated host read may be repeated`. Mutants → `B6_COMMAND_RETRY_BUDGET_BOUNDED`, `B6_BOUNDARY_THROW_NOT_RETRIED`, `B6_WINDOW_ARMS` × 2 |
| **A-10** Phase-A `remoteMain()`'s two reads under one guard, unretried | CLOSED | `PROVIDER remote main tolerates one transient read on either leg` + `PROVIDER remote main still refuses a persistent read failure and a moved main`. Mutants → `PROVIDER_REMOTE_READ_RETRIED_*`, `PROVIDER_REMOTE_READ_BOUNDED`, `PROVIDER_REMOTE_MISMATCH_NAMED_*` |
| **A-06 / C-04** an ambiguous push with no re-read-and-accept recovery | CLOSED | `a landed push that reported failure is re-read, not re-pushed`; still-refuses: `a push that did not land still refuses` × 2 (`old`, `third`). Mutants → `B6_PUSH_FAILURE_REFUSED_*` × 2 |
| **A-07** the credential store re-read on every call | CLOSED | `the credential store is opened at most once per invocation` + `an absent coordinator credential refuses under its own name`. Mutant → `B6_CREDENTIAL_RESOLVED_ONCE` |
| **B-01** pre-arm refusals outside the try/catch, printed as one fixed string | CLOSED | `a pre-arm refusal names itself and orders no effect` × 3 (`approval`, `custody`, `action`) + `the CLI names the refusal it caught`. Mutant → `B6_PRE_ARM_RETURNS_A_HALT_*` |
| **B-03** `ACT_COMMAND_FAILED` naming no executable, argv, status or stderr | CLOSED | `a persistently failing ls-remote names the command it ran` + `the reported command detail is closed to the reviewed fields`. Mutants → `B6_COMMAND_FAILURE_NAMED` × 2 |
| **B-04** the catch allow-list flattening real refusal names | CLOSED | `an absent coordinator credential refuses under its own name`, `a short supervisor transport secret refuses under its own name`, `only a reviewed refusal name reaches a halt record`. Mutants → `B6_ENV_REFUSAL_NAMED`, `B6_HALT_CODE_REJECTS_EVERYTHING_ELSE` |
| **B-05** `ACT_PACKAGE_VALIDATION` discarding the validator's own code | CLOSED | `the package validator own refusal is carried into the halt`. Mutant → `B6_PACKAGE_VALIDATION_NAMED` |
| **B-06** multi-leg conjunctions collapsed into one code | CLOSED | `the disagreeing binding leg is named` × 3 (`readback`, `local`, `clean`) + `the failing binding leg is short-circuited and named`. Mutants → `B6_BINDING_LEG_NAMED_*`, `B6_BINDING_LEG_SHORT_CIRCUIT` |
| **B-07** `units.mjs` bare-string asserts that never throw the named refusal | CLOSED | `a short supervisor transport secret refuses under its own name` + `an absent coordinator credential refuses under its own name`. Mutants → `B6_SUPERVISOR_SECRET_REFUSAL_NAMED`, `B6_ENV_REFUSAL_NAMED` |
| **B-08** teardown failures recording step codes only | CLOSED | `a failed teardown step names its cause as well as its step`. Mutant → `B6_TEARDOWN_CAUSE_NAMED` |
| **B-15** the Phase-A provider's least informative refusal | CLOSED | `PROVIDER a failed provider command names its executable, argv and status`. Mutants → `PROVIDER_COMMAND_NAMED`, `PROVIDER_COMMAND_ARGV_CLOSED` |
| **A-03** shared API choke point | ALREADY CLOSED | previous round |
| **B-02** `ACT_API_FAILED` naming nothing | ALREADY CLOSED | previous round |
| **B-09** (NON-BLOCKING) `budget_error` conflating every cause | CLOSED as a one-line same-class fix while in the file | both existing outcomes preserved by the same two conditions in the same order; a third reviewed cause is named |
| **B-12 / B-13** (NON-BLOCKING) teardown post-condition flattening | PARTLY CLOSED | a read fault inside either now refuses `ACT_TEARDOWN_MEASUREMENT` rather than `ACT_TEARDOWN_DRIFT`, and a failed `kill`/`disable` contributes its own refusal NAME to the teardown's `failures` list (`ACT_TEARDOWN_DRIFT`, `ACT_SERVICE_CLEANUP`, `ACT_COMMAND_FAILED`, …) alongside the step code, in both the returned result and the `TEARDOWN_INCOMPLETE` row. **It does NOT carry `command_failure`, and the first version of this row said it did.** `command_failure` is produced by `commandFailureRecord()` at exactly two sites, both on the FORWARD path — the journal-open handler and `execute()`'s covering handler — where the failing error reaches a halt. A teardown step's error is caught inside `teardownActivation()`, which records NAMES only: `failures` is a list of reviewed codes and the teardown result has no field for command detail, so `command_failure` is absent (`null`) at the module boundary for a failed `kill` and a failed `disable` alike, both before and after this round. Measured, not asserted: see the tenth round below. The four-term conjunction at the post-condition is untouched; no term was added or removed |

That is all 22 BLOCKING records: 20 closed by this round, 2 closed by the
previous one.

#### The clause-level change at each site

**`shu71-production.mjs`**

* `measuredPredicate` — a throw is `measurementFailure(error)`, a named
  `ACT_TEARDOWN_MEASUREMENT` carrying the failing command, instead of `false`.
  One edit; all twelve call sites inherit it with no text change, which is why
  every existing mutation anchored on them still anchors.
* `haltCode` / `reviewedCode` / `REFUSAL_CODE_PATTERN` (the last two in
  `shu71-journal.mjs`) — the halt's allow-list becomes
  `/^(?:ACT|SHU251|SHU71)_[A-Z0-9_]{2,44}$/`. That shape cannot spell a token, a
  header, a URL or message text, so admitting a name by shape closes the door
  rather than opening it.
* `requireLegs(legs, code)` — each leg is a NAME and a term, evaluated in order
  and stopping at the first that is not a measured `true`. Terms may be thunks,
  so the short-circuit of the conjunction each one replaces is preserved: a
  disagreeing `HEAD` still means `status --porcelain` is never run.
* `COMMAND_RETRY` / `readOnlyCommand` / `commandFailureDetail` /
  `commandFailureRecord` — the host-read policy, its ENUMERATED membership, and
  the closed vocabulary a failed command may report.
* `command()` splits into `runCommand` (one measured attempt, raising the same
  `ACT_COMMAND_FAILED` under the same condition, now carrying `{exe, argv,
  status, signal, fault}`) and the bounded loop around it. A boundary that
  THROWS propagates unretried and undescribed, exactly as today.
* `credentials()` memoised per invocation, still lazy.
* `retriedRead(operation, call)` — the single retried API loop, reached through
  `githubRead` and `linearRead`; `linearRead` refuses unless the reviewed
  operation name begins `query:`.
* `transition()` — `need(success)` then a bounded re-READ accepting only the
  target card, then the same terminal `ACT_PARTIAL_ARMING`.
* `heads()` — three named legs for `ACT_REF_BINDING`; four thunked legs and then
  two statements for `ACT_REVISION_BINDING`.
* `remote-push` — the push in a `try`, and on failure one re-read of
  `ls-remote` accepting only `${next}\t${ref}`, otherwise rethrowing the
  ORIGINAL error.
* the package validation — `package_code` carried through.
* `installExpiry()` — a measured post-condition, `ACT_EXPIRY_NOT_INSTALLED`.
* the `gate` step — two measured post-conditions, `ACT_GATE_NOT_LIVE`, and
  `repeat = true`.
* `execute()` — the pre-arm region gets its own handler returning a named halt
  and ordering no effect; the covering handler's `code` becomes `haltCode(...)`
  and its detail gains `command_failure`, `binding_leg`, `package_code` and
  `command_read_retries`.
* `cleanup()` — `budget_error` names a reviewed cause.
* the CLI's outer catch — reports `haltCode(error?.code)`.

**`shu71-journal.mjs`** — `REFUSAL_CODE_PATTERN`/`reviewedCode`; and
`teardownActivation` pushes the cause code for ANY reviewed name, never
duplicating the step's own.

**`units.mjs`** — two `assert.ok(cond, '<CODE>: text')` become
`assert.ok(cond, Object.assign(new Error('<CODE>: text'), { code: '<CODE>' }))`.
Conditions, operands, ordering and message text byte-unchanged.

**`production-lifecycle.mjs`** — `guard(code, condition, detail)`;
`providerArguments` (closed argv, `env` never read); `REMOTE_READ` and
`retriedRead` for `SHU251_PROVIDER_COMMAND` only; `remoteMain`'s guard split
into two statements under the SAME code with the leg named.

**`reconcile.mjs`** — `measureBranchHead` added; `fetchBranchHead` delegates to
it and is behaviourally identical (same throw on transport, same null on
`!ok`, same null on missing arguments, same sha).

**`host-window-bindings.mjs`** — `INVENTORY_READ`, `measureBranchHeadBounded`,
`readRemoteWork(spec, env, io)`; and a halt for a read that never answered,
placed BEFORE the line that would otherwise call it a moved inventory.

#### The three new refusal codes, and why each is an addition rather than a change

`ACT_TEARDOWN_MEASUREMENT`, `ACT_GATE_NOT_LIVE` and `ACT_EXPIRY_NOT_INSTALLED`.
The first replaces a FALSE ACCUSATION — the module used to report a read it
never got as the state the caller named, and it is exactly as fail-closed now.
The other two refuse where the module previously returned `ok: true, state:
'ARMED'` over an unmeasured supervisor and an unmeasured expiry mechanism. No
existing code was renamed, no existing condition was weakened, and no existing
skip, timeout or deadline was touched.

#### RED: the committed controls against the pre-fix revision

The round's committed check functions were run against `ec44ba8`'s modules, with
only the test files and fixtures taken from this revision. Four exports the
control file names at link time do not exist on that revision, so inert
stand-ins were appended for them; every control whose SUBJECT is one of those is
recorded below rather than counted as a kill.

**36 of the 44 end-to-end and closure controls FAIL on the pre-fix revision.**
The eight that pass are recorded as passing, not presented as kills:

| Passes pre-fix | Why that is correct |
| --- | --- |
| `a genuinely live expiry companion still refuses by its own name` | a still-refuses control: it must pass on both revisions |
| `a genuinely drifted fixture card refuses instead of being retried` | same |
| `a genuinely wrong fixture refuses instead of being retried` | same |
| `a push that did not land still refuses` (`old`, `third`) | same |
| `the Linear issueUpdate mutation is still final on its first error` | same |
| `a boundary that throws is never retried and echoes no text` | same — pre-fix nothing is retried at all |
| `only an enumerated host read may be repeated` | NOT APPLICABLE: it exercises the inert stand-in, because `readOnlyCommand` does not exist pre-fix |

`the reported command detail is closed to the reviewed fields` and `only a
reviewed refusal name reaches a halt record` are counted among the 36 failures;
what they measure is that the pre-fix revision has no such sanitizer and no such
mapping at all.

For the sibling modules the mutants ARE the RED: each restores the pre-fix
expression exactly — `guard(code, condition)` without a detail, the single
collapsed `SHU251_CHECKOUT_REMOTE` guard, `if (!res.ok) return null`'s measured
form, the removed inventory halt — and each dies by a named assertion.

#### Mutants: 41 introduced, 41 kills, every one observed

Thirty-six emitted a `killed by …` diagnostic that was read off the thrown
error and captured from a run of the committed revision; the remaining five are
the Phase-A provider mutants, whose harness spawns a child and itself asserts
that the child's failure output contains the named assertion.

| Mutant | Killing assertion observed |
| --- | --- |
| a failed measurement is reported as the state the caller named | `B6_MEASUREMENT_NOT_A_STATE_CLAIM` |
| the host-command read retry is removed | `B6_TRANSIENT_MEASUREMENT_RETRIED` |
| the supervisor liveness read-back is removed | `B6_GATE_LIVENESS_MEASURED_inactive` |
| the supervisor SubState term is dropped | `B6_GATE_LIVENESS_MEASURED_substate` |
| the dispatch timer liveness read-back is removed | `B6_GATE_LIVENESS_MEASURED_timer` |
| the gate step stops repeating on a resume | `B6_GATE_RESUME_REMEASURES` |
| the expiry installation read-back is removed | `B6_EXPIRY_INSTALLATION_MEASURED_inactive` |
| the expiry enablement term is dropped | `B6_EXPIRY_INSTALLATION_MEASURED_disabled` |
| the expiry durable-file term is dropped | `B6_EXPIRY_INSTALLATION_MEASURED_unitfile` |
| the Linear fixture-card read goes back to the unretried door | `B6_WINDOW_ARMS` |
| the Linear issueUpdate is routed through the retried read door | `B6_LINEAR_MUTATION_STILL_UNRETRIED` |
| the card read-back is never re-read | `B6_WINDOW_ARMS` |
| the card read-back re-issues the write it is reading back | `B6_CARD_READBACK_REFUSES_never` |
| the card read-back accepts a card that is not the target | `B6_CARD_READBACK_REFUSES_elsewhere` |
| the host-command read policy allows a single attempt | `B6_WINDOW_ARMS` |
| the host-command backoff schedule is emptied | `B6_WINDOW_ARMS` |
| the host-command sleep budget is not enforced | `B6_COMMAND_RETRY_BUDGET_BOUNDED` |
| the host-command retry repeats a boundary fault as well as a command failure | `B6_BOUNDARY_THROW_NOT_RETRIED` |
| the push recovery accepts any remote answer | `B6_PUSH_FAILURE_REFUSED_old` |
| the push recovery accepts a third sha | `B6_PUSH_FAILURE_REFUSED_third` |
| the credential is resolved on every call again | `B6_CREDENTIAL_RESOLVED_ONCE` |
| the failing command is no longer described | `B6_COMMAND_FAILURE_NAMED` |
| the halt record drops the measured command detail | `B6_COMMAND_FAILURE_NAMED` |
| the halt code goes back to an allow-list | `B6_ENV_REFUSAL_NAMED` |
| the pre-arm region loses its handler again | `B6_PRE_ARM_RETURNS_A_HALT_approval` |
| the binding leg is no longer named | `B6_BINDING_LEG_NAMED_readback` |
| the binding legs are evaluated eagerly instead of in order | `B6_BINDING_LEG_SHORT_CIRCUIT` |
| the package validator code is dropped again | `B6_PACKAGE_VALIDATION_NAMED` |
| the teardown records step codes without causes | `B6_TEARDOWN_CAUSE_NAMED` |
| the supervisor secret refusal goes back to a bare string | `B6_SUPERVISOR_SECRET_REFUSAL_NAMED` |
| the coordinator credential refusal goes back to a bare string | `B6_ENV_REFUSAL_NAMED` |
| the reviewed refusal shape admits arbitrary text | `B6_HALT_CODE_REJECTS_EVERYTHING_ELSE` |
| `SHU251_REMOTE_INVENTORY`: a failed read is reported as a moved inventory again | `SHU251_INVENTORY_READ_FAILURE_NAMED` |
| `SHU251_REMOTE_INVENTORY`: the transient read is never retried | `SHU251_INVENTORY_TRANSIENT_RETRIED` |
| `SHU251_REMOTE_INVENTORY`: a definitive absence is treated as a race | `SHU251_INVENTORY_DEFINITIVE_TERMINAL` |
| `SHU251_REMOTE_INVENTORY`: a non-2xx answer is measured as though it answered | `SHU251_BRANCH_READ_MEASURED` |
| `PROVIDER`: remote main read retry removed | `PROVIDER_REMOTE_READ_RETRIED_` |
| `PROVIDER`: remote main read retry unbounded | `PROVIDER_REMOTE_READ_BOUNDED` |
| `PROVIDER`: remote main legs collapsed into one guard | `PROVIDER_REMOTE_MISMATCH_NAMED_` |
| `PROVIDER`: provider command names nothing again | `PROVIDER_COMMAND_NAMED` |
| `PROVIDER`: provider argv echoed unsanitized | `PROVIDER_COMMAND_ARGV_CLOSED` |

`B6_WINDOW_ARMS` is the shared assertion of `armed()`: "this window did not
arm". Four mutants die on it, and each is named above so that no kill is
reported as more specific than it is.

#### What could NOT be closed, and why

| Record | Status | Reason, and what closing it would need |
| --- | --- | --- |
| **B-10** lock contention is silent | DEFERRED | `flock --nonblock` exits 1 on contention, and the locked child ALSO exits 1 for an ordinary refusal it has already reported on stdout. The parent cannot tell them apart from the exit status alone, so emitting `{"ok":false,"code":"ACT_LOCK_HELD"}` on `status === 1` would double-report every ordinary halt. Closing it needs a distinguishable signal — `flock --conflict-exit-code`, or a child marker the parent reads — which is a new reviewed effect on the re-exec boundary this lane may not widen |
| **B-14** a missing supervisor unit reported as `ACT_FILE_CUSTODY` | DEFERRED | `systemctl show` for a unit with no unit file exits **0 with empty output**, so no command failure is raised and `command_failure` does not reach the halt. Distinguishing it needs a NEW refusal code for an existing condition that currently refuses `ACT_FILE_CUSTODY`, which is a reviewed code change rather than a diagnosability one |
| **A-08** the broker-runtime loop's three gaps | DEFERRED | (i) widening its retryable-code list is exactly the "keep the code allow-list" entry in the audit's own inverse-risk register; (ii) reporting exhaustion under a different name changes an existing refusal's code; (iii) recording the attempt count is safe but is evidence for a loop no record in the blocking set names. NON-BLOCKING in the audit's own ranking |
| **C-03** the broker loop has no wall-clock deadline | DEFERRED | adding a deadline adds a BOUND that did not exist, and the brief holds every existing timeout and deadline fixed. NON-BLOCKING |
| **C-04's second half** `merge-base --is-ancestor` exit 1 reported as `ACT_COMMAND_FAILED` | DEFERRED DELIBERATELY | giving it `ACT_REMOTE_ANCESTRY` would change an existing refusal's code. The diagnosability need is met instead: the halt now carries `{exe: '/usr/bin/setpriv', argv: [… 'merge-base', '--is-ancestor', old, next], status: 1}`, which identifies the site exactly |
| **B-19** an unreachable branch that would mislabel the halt code | NOT REACHABLE | the pre-arm region got its OWN handler rather than widening the existing `try`, so `spec` is still truthy on every path reaching `:414` and the branch is unreachable exactly as before. It is left alone because an unreachable line cannot be pinned by a control |
| **C-05 to C-09, A-09, A-12 to A-14, B-16 to B-18** | DEFERRED | all NON-BLOCKING, all outside the class this round was asked to close, and none is a one-line same-class fix in a file this round opens |

#### Disclosure

**Where a retry could still mask a genuine refusal.** Five places, stated as
risks rather than as claims that they cannot happen.

1. **The post-update card re-read (`A-04`) is the closest thing to a retried
   comparison in the module.** It re-MAKES the comparison rather than softening
   it, and it accepts only the target, so a card that is `before`, a card a
   concurrent transition moved elsewhere, and a mutation that never landed all
   run the loop out and refuse `ACT_PARTIAL_ARMING`. What it CAN mask is a
   genuine `ACT_PARTIAL_ARMING` that would have fired sooner — up to four extra
   reads and 15 s of sleep — if a concurrent writer happened to set the card to
   the target during the loop. That outcome is indistinguishable from the
   arming's own write having landed late, and no read can tell them apart.
2. **The push recovery (`A-06`) accepts a step whose mutation reported
   failure.** It accepts only on `${next}\t${ref}`, and `heads(spec, true)` on
   the very next line re-reads that same ref from the remote AND from the GitHub
   API and requires it to equal `next`, and the ancestry comparison follows — so
   every condition the recovery passes over is re-measured before the step can
   complete. The residual risk is a remote that answers `next` to `ls-remote`
   and to the API while the push genuinely failed, which is a lying remote
   rather than a race.
3. **The host-command read retry is NOT gated on the authorization expiry.** It
   is bounded absolutely instead — at most 300 ms per read and 2 s per
   invocation — because the teardown these reads serve runs precisely BECAUSE
   the window expired, and an expiry gate would switch the mechanism off exactly
   where it is needed. A window can therefore be extended by at most 2 s of
   sleep past `expires_at` by this mechanism. This differs from the API policy's
   four bounds and is disclosed rather than hidden.
4. **`id -u <account>` for a genuinely missing account is now attempted three
   times** before refusing. The refusal, its code and its condition are
   unchanged; only 300 ms of latency is added to a definitive answer.
5. **`ACT_TEARDOWN_MEASUREMENT` is a new name for an outcome that previously
   refused under a state-claim name.** Any consumer matching on
   `ACT_TEARDOWN_EXPIRY_SERVICE` or `ACT_TEARDOWN_DRIFT` to detect a read fault
   will stop matching. The step code in `failures[]` is unchanged, and the new
   code is ADDED alongside it.

**What could not be pinned.** `B-19`'s branch is unreachable and has no control.
`B-12`/`B-13`'s four-term post-condition keeps every term and gains no new
mutant of its own this round; the terms' existing mutants and controls are
unchanged and still run.

**Changed beyond the records themselves.**

* The push recovery does NOT append a durable journal row. A
  `REMOTE_PUSH_READ_BACK` class was written and then withdrawn: the reviewed
  journal APPEND INVENTORY is a closed contract, and the evidence a re-read adds
  belongs with the other read-retry evidence. It is recorded through
  `api_read_retries` as `git:ls-remote:<branch>` instead.
* `RUNTIME_CODES` is no longer imported by `shu71-production.mjs` — the
  allow-list that used it is gone — so the import was removed.
* Five `shu71-production.mjs#L<n>` documentation links are repointed at the
  lines their targets occupy now. `V8_DOCUMENTATION_LINK_TARGETS` requires the
  exact line and still dies on a one-line drift.
* `B1_ARM_EFFECT_COUNT` gains exactly five, and those five are now asserted
  individually by name in `B1_ADDITIVE_MEASURED_READBACKS`. All five are
  `systemctl show`.
* Two pre-arm controls in `shu71-trust*.test.mjs` and two mutation anchors
  (`NV2`, and the arming-order post-update mutant) are reconciled in place; the
  mutation names, their controls and their killing assertions are unchanged.
* `readRemoteWork`, `measureBranchHeadBounded` and `INVENTORY_READ` are exported
  from `host-window-bindings.mjs` so the A-11 controls can drive the real read
  with an injected measurement instead of replacing the whole `readRemote`.
* `productionFixture` models `SubState` independently of `ActiveState`, because
  a model that derives one from the other cannot represent the state `C-01`
  exists for — `restart` exited 0 and the supervisor is not live. The default
  derives from `ActiveState`, so no existing control is affected.
* `Atomics.wait` is used for the two SYNCHRONOUS backoffs (the host-command
  retry and Phase-A's `remoteMain`). It parks the thread rather than spinning,
  it is inside this process only, and both call sites accept a boundary
  override, which every control uses.

#### Validation

All four runs are CI-like — `shu71-ci-like.sh`: uid 1000, umask 0022, the four
target accounts absent, `/run` and `/etc/sudoers.d` fresh tmpfs — on the
committed revision `a3030ad6`, with `chmod -R go-w .github/coordinator` applied
first, one at a time, in the foreground.

| Run | Tests | Pass | Fail | Skip | TAP plan | complete markers | Exit | Elapsed | Load before → after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Focused plain | 2,137 | 2,136 | 0 | 1 | `1..2137` | 1 / terminal | 0 | 210 s | 1.31 → 2.35 |
| Focused clock | 2,137 | 2,136 | 0 | 1 | `1..2137` | 1 / terminal | 0 | 211 s | 1.58 → 2.65 |
| Full plain | 3,528 | 3,520 | 0 | 8 | `1..3523` + 5 nested | 1 / terminal | 0 | 584 s | 1.81 → 2.36 |
| Full clock | 3,528 | 3,520 | 0 | 8 | `1..3523` + 5 nested | 1 / terminal | 0 | 560 s | 1.29 → 2.57 |

Zero `not ok` lines in all four TAP outputs; zero cancelled and zero todo
outcomes. Each run's structured report has exactly one terminal `complete`
event and is terminated by it. Both full runs' 3,528 outcome names are exactly
the committed inventory's 3,528 names with identical multiplicities — zero
missing and zero extra, checked programmatically against
`suite-inventory.json` — and `A12 committed inventory requirements match real
outcomes` passes in both. Every skip in all four runs is a `PERMITTED_SKIPS`
entry carrying that entry's exact documented reason, compared byte-for-byte
against the exported object rather than by eye; the single focused skip is
`SHU-71 restricted capability refusal`.

`PERMITTED_SKIPS` is byte-identical: 1,093 bytes,
sha256 `03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
`host-suite-contract.mjs` is byte-identical: 23,885 bytes,
sha256 `2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`.
All three inventories are strictly additive with zero removals and the existing
order preserved: `suite-inventory.json` gains one file (117), 90 names (3,528)
and the 90 matching requirement rows in the same order; `file-requirements.json`
and `required-files.json` gain the one new file in sorted position.

##### The focused selection, and the entry it must not contain

```sh
node --test \
  .github/coordinator/test/shu71-activation-package.test.mjs \
  .github/coordinator/test/shu71-battery.test.mjs \
  .github/coordinator/test/shu71-public-key.test.mjs \
  .github/coordinator/test/single-run-activation.test.mjs \
  .github/coordinator/test/supervisor.test.mjs \
  .github/coordinator/test/supervisor-dispatch.test.mjs \
  .github/coordinator/service/test/provision*.test.mjs \
  .github/coordinator/service/test/shu71-owner-decisions.test.mjs \
  .github/coordinator/service/test/shu71-phase-readback.test.mjs \
  .github/coordinator/service/test/shu71-production*.test.mjs \
  .github/coordinator/service/test/shu71-postpush-readback.test.mjs \
  .github/coordinator/service/test/shu71-arming-robustness.test.mjs \
  .github/coordinator/service/test/shu71-arming-order.test.mjs \
  .github/coordinator/service/test/shu71-reexec-boundary.test.mjs \
  .github/coordinator/service/test/shu71-recovery-mutations.test.mjs \
  .github/coordinator/service/test/shu71-supervisor-environment.test.mjs \
  .github/coordinator/service/test/shu71-composition.test.mjs \
  .github/coordinator/service/test/shu71-trust*.test.mjs \
  .github/coordinator/service/test/shu71-delta-mutations.test.mjs \
  .github/coordinator/service/test/shu71-verdict-closures.test.mjs \
  .github/coordinator/service/test/shu71-host-contract.test.mjs \
  .github/coordinator/service/test/shu71-history.test.mjs \
  .github/coordinator/service/test/production-lifecycle.test.mjs \
  .github/coordinator/service/test/host-lifecycle.test.mjs \
  .github/coordinator/service/test/host-window-bindings.test.mjs \
  .github/coordinator/service/test/service-plane.test.mjs \
  .github/coordinator/service/test/environment-content.test.mjs \
  .github/coordinator/service/test/environment-content-mutations.test.mjs
```

Twenty-eight entries expanding to 35 test files — the previous round's
seventeen, plus `shu71-arming-robustness.test.mjs` (this round's own control
file), `shu71-arming-order.test.mjs`, `shu71-delta-mutations.test.mjs`,
`shu71-history.test.mjs`, `production-lifecycle.test.mjs`,
`host-lifecycle.test.mjs`, `host-window-bindings.test.mjs`,
`service-plane.test.mjs` and the two `environment-content` files, so that every
file this round touches or whose reviewed contract it moves is inside it.

**`suite-runner-spec.test.mjs` is deliberately NOT in it, and that is recorded
rather than left to be rediscovered.** Its `A12 committed inventory requirements
match real outcomes` guard SPAWNS a complete nested 3,527-outcome run with a
600 s cap of its own. Adding it to the focused selection made the focused run a
full run plus 2,137 tests: the first attempt failed `A12_INVENTORY_REAL_RUN` at
3,478 of 3,527 outcomes — the nested run hit its own timeout under contention —
and, with the pin widened, failed `SHU250_RESPONSIVE: tick must return within
1000ms without awaiting worker` twice in a row at 2,679 ms. Both files pass in
isolation under the same CI-like conditions: `supervisor-dispatch.test.mjs`
27/27, and the nested command reproduced standalone gives 3,527 outcomes, 8
skips, zero failures, exit 0 in 452 s. That guard belongs in the FULL runs,
where it passes in both, and it ran in both.

##### Harness throughput

All four runs used `taskset -c 0-9 node --test --test-concurrency=4`. This is
disclosed because the previous round used `-c 0-3 --test-concurrency=2` for its
focused runs: at that pinning the focused selection did not finish inside this
session's budget once `suite-runner-spec.test.mjs` was in it. Nothing the suite
measures was changed — same constraints, same reporters, same committed
revision, same files; only the CPU mask and the runner's concurrency.

### Tenth correction round: the condition a status class cannot see

Repository-only. No target host was contacted, no network call was made, and no
`git push` or `gh` command was run. Two items only — the one blocking record an
independent verifier found still open at `592232c0`, and the one sentence in the
ninth round's record that the code does not support. Written against the
revision it was measured on: `4dd45f04`, tree `d6e11374`. The fix landed as
`85117f8f`; `4dd45f04` adds the one control assertion described under *Control*
below and changes no behaviour.

#### F1 — `A-11`: a failed MEASUREMENT was still reported as a claim about the world

The ninth round split the inventory read into a transient failure and a moved
inventory, and it split them on `ok` — the HTTP status class. That closes three
of the four conditions the audit enumerated and leaves the fourth exactly as it
was: **a 2xx whose body will not yield the field being measured.** GitHub's
branch read answers `{ ok: true, status: 200, sha: null }` when the body did not
parse, parsed without `commit.sha`, or carried something that is not a branch
head — and `ok` was true, so the caller fell through to

    SHU251_REMOTE_INVENTORY: remote fixture inventory is incomplete or moved

after ONE read. That is a state claim about the remote built out of an answer
that said nothing about the remote, it is the defect the record claims to have
closed, and it is unchanged from the pre-fix revision. It was also not retried,
though nothing in it is an answer that a second read could not improve on.

`ok` is the server's verdict on the REQUEST. It was never evidence that the
answer carried the value. **The code now knows whether it HAS a measurement
before it may describe the world**, and that is measured from the answer rather
than asserted from its status:

```js
export const INVENTORY_MEASUREMENT = Object.freeze({ held: 'held', unanswered: 'unanswered', without_value: 'without_value' });
export const inventoryMeasurement = read => read?.ok !== true ? INVENTORY_MEASUREMENT.unanswered
  : SHA.test(read.sha ?? '') ? INVENTORY_MEASUREMENT.held : INVENTORY_MEASUREMENT.without_value;
export const inventoryReadRetryable = read => inventoryMeasurement(read) === INVENTORY_MEASUREMENT.without_value
  || (read?.ok !== true && INVENTORY_READ.statuses.includes(read?.status));
```

Three outcomes, one of which may speak for the remote. `held` is the only one,
and it requires the value to be there AND to have the only shape a branch head
has. The two dispatch sites consume that single predicate: the bounded read
stops on `held` and re-reads anything `inventoryReadRetryable` admits, and
`observeRemoteInventory` halts `remote fixture inventory could not be read` for
anything that is not `held`, BEFORE the line that would report it as moved. The
refusal carries the closed token — `held` / `unanswered` / `without_value` —
and the status, so nothing a remote can put in a body can ride in through it.

The four conditions, each measured on the committed revision:

| Answer | Reads | Waits | Refusal |
| --- | --- | --- | --- |
| transient non-2xx (503, 429) | 3 | `[200, 400]` | `… could not be read`, `measurement: unanswered` |
| **2xx, field null / absent / unparseable / wrong shape** | **3** | **`[200, 400]`** | **`… could not be read`, `measurement: without_value`** |
| 2xx carrying a branch head that DISAGREES (moved, or a well-formed nonsense sha) | 1 | `[]` | `… is incomplete or moved`, unchanged |
| definitive (400, 401, 403, 410, 422) and definitive absence (404) | 1 | `[]` | `… could not be read`, terminal |

A 2xx that carried no value is retryable for the same reason a 502 is: the
remote stated nothing about the branch, and a truncated or shape-shifted body is
the read failing rather than the inventory speaking. It is the same read-only
GitHub route the ninth round already admitted to the read policy, under the same
3-attempt / `[200, 400]` bound — **no new route, no new budget, and no mutation
is retried anywhere.** No VALUE is ever retried either: a held measurement is
compared against `target_sha` exactly once, however badly it reads.

**RED.** The new control, driven against the committed defective revision
`592232c0` with the predicate vocabulary appended as a documented stand-in so it
can link — the two dispatch sites left exactly as committed — fails on the first
assertion it makes:

```
not ok 1 - SHU251_REMOTE_INVENTORY refuses a 2xx that carried no branch head as a failed measurement
  error: 'SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM null'
  actual: 'SHU251_REMOTE_INVENTORY: remote fixture inventory is incomplete or moved'
  operator: 'match'
```

**Control.** `SHU251_REMOTE_INVENTORY refuses a 2xx that carried no branch head
as a failed measurement` asserts all four conditions in one test, so the
dispatch cannot be right for one and wrong for another: four valueless shapes
(`sha: null`, the field absent, `'not-a-sha'`, and an object) each retried to
`INVENTORY_READ.attempts` with waits `[200, 400]` and named `could not be read`
with `measurement: 'without_value'` and never `moved`; one valueless answer
followed by a good one still arming on the second read; a disagreeing head and a
well-formed nonsense head each still refusing `incomplete or moved` on ONE read
with no wait; the five definitive statuses each terminal on one read; the
predicate itself over eight answer shapes; and no token in any of it.

One of those four conditions was, at `85117f8f`, weaker in the suite than in the
table above, and it is recorded rather than quietly repaired. The transient
non-2xx was asserted at the DISPATCH only by its read COUNT (the ninth round's
`SHU251_INVENTORY_READ_BOUNDED`) and otherwise only through the predicate table;
neither the enumerated waits nor the `measurement` token on its refusal was
pinned, and 429 never reached the dispatch at all — so the transient row claimed
more than was measured. `4dd45f04` adds it to the same control: 503 and 429 each
read to `INVENTORY_READ.attempts` on waits `[200, 400]`, refusing `could not be
read`, never `moved`, carrying `measurement: 'unanswered'` and their own status.
No behaviour changed, no test name was added — the assertions reuse
`SHU251_INVENTORY_READ_FAILURE_NAMED` and `SHU251_INVENTORY_TRANSIENT_RETRIED`,
both already mutant-killing names whose mutants are unchanged — so
`suite-inventory.json` is unaffected and every row of the table above is now
backed at the dispatch by an assertion that names it.

**Mutants** — three, each reverting one clause to what this correction replaced,
each observed killed by its own named assertion:

| Mutant | Dies by |
| --- | --- |
| `a 2xx that carried no branch head is reported as a moved inventory` (`if (measurement !== INVENTORY_MEASUREMENT.held)` → `if (work.branch_head_read.ok !== true)`) | `SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM` — the halt reads `incomplete or moved` |
| `a 2xx that carried no branch head is never re-read` (the break predicate → `measured.ok`) | `SHU251_INVENTORY_VALUELESS_RETRIED` — 1 read where the policy requires 3 |
| `any 2xx is treated as a held measurement` (the `SHA.test` term → `held`) | `SHU251_INVENTORY_MEASUREMENT_CLOSED` — both the naming and the re-read collapse |

The ninth round's four A-11 mutants are unchanged in name, control and killing
assertion; two of their anchors moved onto the text this correction rewrote and
were re-pointed in place.

#### F2 — `B-13`'s description overstated what the code does

The ninth round's record said a failed `kill`/`disable` "carries
`command_failure`". It does not, and the record is corrected rather than the
code: threading command detail into the teardown result would change the shape
of a reviewed result and a reviewed journal row for a NON-BLOCKING
diagnosability record, which is not what this round is for.

Measured at the module boundary on the committed revision, forcing `kill` and
then `disable` to exit non-zero in a real teardown:

```
kill:    code=ACT_CLEANUP_FAILED  result keys = ["ok","state","code","failures"]
  failures = ["ACT_TEARDOWN_WORKERS","ACT_TEARDOWN_DRIFT","ACT_TEARDOWN_FIXTURES",
              "ACT_FIXTURE_CLEANUP","ACT_TEARDOWN_EXPIRY_TIMER","ACT_CLEANUP_FAILED"]
  command_failure = null        TEARDOWN_INCOMPLETE row carries `failures` and no command detail
disable: code=ACT_CLEANUP_FAILED
  failures = ["ACT_TEARDOWN_EXPIRY_TIMER","ACT_TEARDOWN_DRIFT"]
  command_failure = null
```

`commandFailureRecord()` is called at exactly two sites, both on the FORWARD
path — the journal-open handler and `execute()`'s covering handler — where the
failing error reaches a halt and its detail is sanitized into the result and the
`HALTED` row. A teardown step's error never reaches either: it is caught inside
`teardownActivation()`, which records NAMES. What IS carried for a failed
`kill`/`disable`, and what the ninth round really added, is the step's own
refusal NAME next to the step code (`ACT_TEARDOWN_DRIFT` beside
`ACT_TEARDOWN_WORKERS` above, where the pre-fix tree recorded the step code
alone). The `B-12 / B-13` row now says exactly that, and says explicitly that
`command_failure` is absent at the boundary for both verbs, before and after.

No code changed for F2. The row above is the change.

#### What did NOT change

No other record was touched. The retry invariant is unchanged — only the
enumerated read-only host reads and the read-only API routes are retried, and
every mutation is still attempted exactly once. No refusal code, name,
condition, skip, timeout or deadline was deleted, renamed or weakened; the only
message that moves is the one this correction exists to move. `reconcile.mjs` is
untouched: `measureBranchHead` and `fetchBranchHead` keep the exact contracts the
ninth round gave them, and the new knowledge is derived in the module that
consumes them. `PERMITTED_SKIPS` and `host-suite-contract.mjs` are byte-identical.
`suite-inventory.json` gains four names and their four requirement rows, appended,
with every existing entry and its order byte-preserved; no file was added, so
`file-requirements.json` and `required-files.json` are unchanged.

#### Disclosure

* **`S-1`, deliberately not fixed, and named here instead.** A definitive 404
  refuses `remote fixture inventory could not be read`. The remote DID answer —
  it said the branch is absent — so that message names a measurement failure
  where a state claim would be defensible. It errs in the safe direction (it
  never claims a state it did not measure), the answer count, the code and the
  terminality are all correct, and changing it would move an existing refusal
  message that a committed control pins. Out of this round's scope; recorded so
  it is not rediscovered as new.
* The `without_value` retry treats an unparseable 2xx as transient. If a remote
  answers 2xx with a body it will never fill in, this costs three reads and 600 ms
  before the same refusal. That is a deliberate trade and it is bounded by the
  same policy as every other read here.
* `measurement` is the only new field on a refusal. It is closed to three
  literals from a frozen object, so it cannot carry remote text; `status` was
  already reported and is unchanged.
* The other four `fetchBranchHead` callers — `reconcile.mjs:1093/1697/2352` and
  `durable-handoff.mjs:63` — were re-read and deliberately left alone. Each
  already maps a null sha to a NOT-VERIFIED outcome (`verified: false`,
  `branchHeadUnverified`, `headVerified = false`, a `HOLD` reading "stale or
  **unverifiable**"), so none of them turns a failed measurement into a state
  claim; what they do not do is distinguish WHICH failure it was, and none of
  them retries. That is a diagnosability gap, not this defect, and it is outside
  this round's two items.
* Nothing about a live host is measured here either. Every statement above is
  about the committed code exercised through the committed fixtures and through
  direct calls to the exported predicates. The real-host halt that began this
  correction is still not reproduced end to end.
* I did not re-audit the whole tree for other instances of this class this
  round. The scope was the two items the verifier named.
* `A-08` and the other deferrals of the ninth round remain deferred, with the
  reasons that round gave.

#### Validation

All four runs are CI-like — `shu71-ci-like.sh`: uid 1000, umask 0022, the four
target accounts absent, `/run` and `/etc/sudoers.d` fresh tmpfs — on the
committed revision `4dd45f04`, with `chmod -R go-w .github/coordinator` applied
first, one at a time, in the foreground, under `taskset -c 0-9 node --test
--test-concurrency=4` with both a TAP reporter and the unchanged
`host-suite-contract.mjs` reporter writing to separate files. The focused
selection and the full selection are the ninth round's, unchanged.

| Run | Tests | Pass | Fail | Skip | Terminal TAP plan | `complete` | Exit | Elapsed | Load before → after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Focused plain | 2,141 | 2,140 | 0 | 1 | `1..2141` | 1 / terminal | 0 | 224 s | 0.47 → 2.32 |
| Focused clock | 2,141 | 2,140 | 0 | 1 | `1..2141` | 1 / terminal | 0 | 230 s | 2.32 → 2.66 |
| Full plain | 3,532 | 3,524 | 0 | 8 | `1..3527` + one nested `1..5` | 1 / terminal | 0 | 587 s | 2.66 → 1.92 |
| Full clock | 3,532 | 3,524 | 0 | 8 | `1..3527` + one nested `1..5` | 1 / terminal | 0 | 591 s | 1.92 → 1.64 |

Zero `not ok` lines in all four TAP outputs — counted over the whole file, not
only the top level, so the nested plan is included — and zero cancelled and zero
todo outcomes in all four. Each run's structured report has exactly one
`complete` event and is terminated by it. Both full runs' 3,532 outcome names
are exactly the committed inventory's 3,532 `names` with identical
multiplicities — zero missing and zero extra, compared programmatically as
multisets against `suite-inventory.json` rather than by count — and `A12
committed inventory requirements match real outcomes` passes in both. Every skip
in all four runs is a `PERMITTED_SKIPS` key whose reason byte-matches that
entry's documented reason, checked both on the TAP `# SKIP` directive text and
on the reporter's `reason` field against the exported object: zero mismatches.
The single focused skip is `SHU-71 restricted capability refusal`; the eight
full skips are the eight `PERMITTED_SKIPS` entries.

The counts are the ninth round's plus exactly this round's four names: focused
2,137 → 2,141, full 3,528 → 3,532, with the skip counts (1 and 8) unchanged.

`PERMITTED_SKIPS` is byte-identical: 1,093 bytes,
sha256 `03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
`host-suite-contract.mjs` is byte-identical: 23,885 bytes,
sha256 `2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9` —
unchanged not merely in content but by `git diff` against the pre-round base.
`suite-inventory.json` is strictly additive: 3,528 → 3,532 names and 3,528 →
3,532 requirement rows, zero removals, every pre-existing entry retained in its
original relative order, and `files` unchanged at 117.
`file-requirements.json` and `required-files.json` are untouched.

**Measured on the code revision, not on this record.** The runs were executed
with the worktree pristine at `4dd45f04` — this section's own text was held
aside and restored afterwards — so no uncommitted byte was in the tree under
test. The documentation commit that follows changes only this file, which the
suite reads under exactly two guards: `V8_DOCUMENTATION_LINK_TARGETS`, which
resolves `file#Lnnn` links (this round's text adds none), and
`SHU71_PATH_NEUTRAL_COMMANDS`, which forbids the one provisioning worktree path
this document must never hard-code (this round's text contains none — and the
guard is named here rather than quoted, because quoting it is itself the
violation, as one draft of this paragraph discovered). Both were re-checked
after that commit.

The four names this round adds are in both selections: they are tests in
`host-window-bindings.test.mjs`, which is entry 25 of the focused selection and
matches the full run's `service/test/*.test.mjs` glob.

### Eleventh correction round: the one thing the run changes outside itself

The M3/M4 window's signed package promises `teardown = restore`. On the target
host an approved window armed, ran through `sign`, `expiry-watch`,
`local-reseed` and `remote-push` — and the push LANDED:
`refs/heads/coordinator/SHU-140` carried the reseed commit
`21e41fef6966604039cd9cbea4ad7151c80ed68a`, whose parent is the retained parent
`6e5ad86cc0a993097d2e642132077b665ad49481` — and the run then halted on a later
read. Its teardown completed with `ok:true`, `TEARDOWN_COMPLETE`,
`failures:[]`: it restored the fixture cards, stopped the units and retained the
evidence. It did **not** restore the branch it had published. The next mint
refused `MINT_LINEAGE`, a hand repair was performed, and the owner declined the
approval block for exactly that reason — the reviewed teardown still did not do
it, so the promise was unbacked by code.

Everything else a window touches is already put back by a reviewed effect: the
gate drop-ins, the activation credential, the units, the fixture cards, the
attempt directories. The fixture lane's BRANCH was the only thing the run
changes outside itself that nothing restored.

#### What the teardown now does, and on what condition

A new reviewed teardown effect, `restore-branch`, sits between the fixture-card
restores and the workspace cleanup — after the timer, the coordinator and the
supervisor have been stopped, so nothing on this host can be pushing to that
lane while its refs are moved, and before the archive and the observation that
close the receipt. It restores the three refs the next mint reads
(`mint-shu71-package.mjs`, `repositoryFacts`): the branch on the remote, the
branch in the checkout, and the checkout's remote-tracking ref.

Each ref is MEASURED first — one `ls-remote` and two `for-each-ref` — and the
measurement is durable: `BRANCH_RESTORE_MEASURED` carries the branch and all
three observed values, so a refusal says which value it found. A ref is then
moved only when it holds EXACTLY `expected_seed_head`, the value this run
published, back to EXACTLY `expected_parent`, the retained parent:

* a ref already at the retained parent is a no-op — nothing was published, or
  the restoration already happened — and claims nothing;
* any other value is someone else's write and REFUSES under
  `ACT_TEARDOWN_BRANCH_FOREIGN`, which the step reports as
  `ACT_TEARDOWN_RESTORE_BRANCH` plus that cause, never as a clean receipt;
* the remote update carries `--force-with-lease=<ref>:<published>` and the
  local updates are `update-ref <ref> <parent> <published>`, so even a foreign
  write that lands between the measurement and the command is refused by git
  itself rather than clobbered;
* the remote-tracking ref is the one ref here this run never creates: where the
  checkout has no such ref at all there is nothing of ours to move and nothing
  is invented, while a tracking ref holding a third value refuses like the
  other two.

`local-reseed` is the first step that can move any of these refs, so its durable
INTENT row is what proves this episode may have published something. Without it
— a pre-arm refusal, a revoke of a window that never ran — nothing is measured,
no remote is contacted and no credential is read, exactly as the fixture-card
restores are gated on their own `ready-<id>` intent. A recovered log proves
nothing about non-creation and always measures, fail-closed.

#### What did NOT change

The mint's `MINT_LINEAGE` refusal on an unexplained branch advance is CORRECT
behaviour and is untouched: a branch this teardown refuses to restore still
stops the next window, which is the point. No mutation's acceptance is widened
and no mutation is retried: each restoration is issued at most once per
invocation (`ACT_TEARDOWN_BRANCH_REATTEMPT` if anything asks twice, including
the independent safety re-attempt `teardownActivation` makes for every failed
step), a refused restore stays refused, and a push that reports failure is
recovered by a RE-READ that accepts only the one value meaning the mutation
already happened — the same discipline `remote-push` already uses. The existing
teardown step codes, the closed refusal vocabulary and the reviewed append
inventory are unchanged except by addition.

#### The five new refusal codes, each an addition rather than a change

| Code | Condition |
| --- | --- |
| `ACT_TEARDOWN_RESTORE_BRANCH` | derived by `teardownActivation` from the new step's name, like every other step code |
| `ACT_TEARDOWN_BRANCH_FOREIGN` | a measured ref holds neither this run's published head nor the retained parent |
| `ACT_TEARDOWN_BRANCH_REATTEMPT` | a restoration mutation was already issued in this invocation |
| `ACT_TEARDOWN_BRANCH_REMOTE` / `_LOCAL` / `_TRACKING` | the post-condition: the ref did not end at the retained parent |

#### The successor model this correction corrects with it

`B1_CROSS_TEARDOWN` built each successor package with
`expected_parent = <predecessor's expected_seed_head>`, which only made sense
while the reseed was left behind on the branch. The mint binds `expected_parent`
to the fixed retained parent and refuses `MINT_LINEAGE` for anything else, so
the successor now differs from its predecessor only in `expected_seed_head` —
which is what the fixture models, and what the restored branch makes possible.

#### Fixture fidelity this round required

`shu71-production-fixture.mjs` modelled the lane as two values and hard-coded
the push's result. It now models the three refs independently — branch, local
branch, remote-tracking ref — and applies git's own rules rather than a fixed
string match: `--force-with-lease` lands only while the remote still holds the
leased value and EXITS NON-ZERO otherwise, an unleased push lands when it is
forced or when it fast-forwards, `update-ref` with an expected old value is a
compare-and-set that exits non-zero on anything else and without one is an
unconditional write, and a push moves the ref to the sha its REFSPEC names. A
model that derives one ref from another, or that accepts any push that carries
a lease-shaped argument, cannot represent either the published state or a
foreign write — and cannot tell a leased restoration from an unleased one, so
three of this round's mutants would have survived it.

#### RED: the committed controls against the pre-fix revision

The thirteen controls, unchanged and loaded from
`shu71-branch-restore-checks.mjs`, were run against the PRE-FIX module
(`813f845f`'s `shu71-production.mjs`, imported from a disposable path with its
relative imports rewritten) on the corrected fixture. Every one fails, and the
failing assertion is named:

| Control | Fails on the pre-fix revision at |
| --- | --- |
| a halt after the remote push restores the branch it published | `B7_REMOTE_RESTORED_TO_PARENT` |
| a completed run restores the branch on the ordinary revoke path | `B7_MINT_LINEAGE_SATISFIED` |
| a fetched remote-tracking ref is restored too | `B7_TRACKING_RESTORED_TO_PARENT` |
| a teardown that runs twice is a clean no-op | `B7_MINT_LINEAGE_SATISFIED` |
| a window that never reached the reseed measures and claims nothing | `B7_NEVER_PUSHED_CLEAN_NOOP` |
| a local reseed that was never pushed restores the local ref only | `B7_LOCAL_ONLY_MEASURED` |
| a landed push that reported failure is re-read, never pushed again | `B7_PUSH_ATTEMPTED_ONCE` |
| a restoration that cannot complete is a named teardown failure | `B7_FAILED_RESTORE_IS_NOT_A_COMPLETION` |
| a remote moved between the measurement and the push is never clobbered | `B7_FOREIGN_NOT_OVERWRITTEN` |
| a local branch moved between the measurement and the update is never clobbered | `B7_FOREIGN_NOT_OVERWRITTEN` |
| a foreign remote head is refused by name and never overwritten | `B7_FOREIGN_REMOTE` |
| a foreign local head is refused by name and never overwritten | `B7_FOREIGN_LOCAL` |
| a foreign tracking head is refused by name and never overwritten | `B7_FOREIGN_TRACKING` |

#### Mutants: 15 introduced, 15 kills, every one observed

Each mutant is one or two anchored substitutions in the committed source,
loaded from a disposable path, and each is driven by a control that passes
against the reviewed module in the same test. The killing assertion is reported
by `killedBy()` as a diagnostic, not merely counted.

| Mutant | Killed by |
| --- | --- |
| the restoration is removed entirely | `B7_REMOTE_RESTORED_TO_PARENT` |
| the restoration returns before measuring anything | `B7_REMOTE_RESTORED_TO_PARENT` |
| the remote is never restored | `B7_REMOTE_RESTORED_TO_PARENT` |
| the local branch is never restored | `B7_LOCAL_RESTORED_TO_PARENT` |
| the remote-tracking ref is never restored | `B7_TRACKING_RESTORED_TO_PARENT` |
| the current-head check is dropped | `B7_FOREIGN_REFUSED_BY_NAME` |
| a descendant is accepted as licence to restore | `B7_FOREIGN_REFUSED_BY_NAME` |
| a foreign head is restored anyway, leased to whatever it holds | `B7_FOREIGN_NOT_OVERWRITTEN` |
| a foreign local head is restored anyway | `B7_FOREIGN_NOT_OVERWRITTEN` |
| the local update drops its expected old value | `B7_FOREIGN_NOT_OVERWRITTEN` |
| the remote update uses an unleased force | `B7_FOREIGN_NOT_OVERWRITTEN` |
| a failed restoration is swallowed | `B7_FAILED_RESTORE_IS_NOT_A_COMPLETION` |
| the once-only rule is dropped and the mutation is re-attempted | `B7_PUSH_ATTEMPTED_ONCE` |
| a push that reported failure is pushed again | `B7_PUSH_ATTEMPTED_ONCE` |
| the intent gate is removed and a never-published window is measured | `B7_NEVER_PUSHED_NO_MEASUREMENT` |

#### What could NOT be closed, and why

* **The remote-tracking ref's absence is a no-op, not a refusal.** `git push
  <url>` does not move `refs/remotes/origin/<branch>`, so that ref is the one of
  the three this run never writes. A checkout that has no such ref at all is
  left alone rather than refused, and nothing is invented there. The mint still
  reads it and still refuses `MINT_LINEAGE` when it is absent or wrong, so the
  successor is not exposed; but this teardown will report a clean receipt over
  a checkout whose tracking ref does not exist. It is the one place the
  restoration is deliberately silent.
* **A foreign write that lands after the post-condition read** is outside what
  any compare-and-set can see. The restoration proves the ref was at the
  retained parent when it last measured it, not that it stayed there.
* **The step is gated on `local-reseed`'s INTENT row**, so a window that
  somehow published without that durable row — which no path here produces —
  would not be measured. The gate is what keeps a pre-arm teardown from reading
  a credential it does not need; the alternative is measuring on every teardown,
  including on hosts where `/srv/shu/coordinator.env` has already been removed,
  which would turn today's clean pre-arm receipts into failures.
* **Only the reseed branch is restored.** `coordinator/SHU-254` is bound at its
  fixed seed head and no reviewed step writes it; if some future window
  published to a second lane, this step would not know about it.

#### Validation

All four runs are CI-like — `shu71-ci-like.sh`: uid 1000, umask 0022, the four
target accounts absent, `/run` and `/etc/sudoers.d` fresh tmpfs — on the
committed revision `8a7e3563`, with `chmod -R go-w .github/coordinator` applied
first, one at a time, in the foreground, under `taskset -c 0-9 node --test
--test-concurrency=4` with both a TAP reporter and the unchanged
`host-suite-contract.mjs` reporter writing to separate files. The focused
selection is the tenth round's twenty-eight entries plus
`shu71-branch-restore.test.mjs`; the full selection is unchanged.

| Run | Tests | Pass | Fail | Skip | Terminal TAP plan | `complete` | Exit | Elapsed | Load before → after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Focused plain | 2,171 | 2,170 | 0 | 1 | `1..2171` | 1 / terminal | 0 | 211 s | 0.50 → 2.42 |
| Focused clock | 2,171 | 2,170 | 0 | 1 | `1..2171` | 1 / terminal | 0 | 238 s | 2.22 → 2.43 |
| Full plain | 3,562 | 3,554 | 0 | 8 | `1..3557` + one nested `1..5` | 1 / terminal | 0 | 495 s | 2.23 → 3.63 |
| Full clock | 3,562 | 3,554 | 0 | 8 | `1..3557` + one nested `1..5` | 1 / terminal | 0 | 492 s | 3.34 → 3.22 |

Zero `not ok` lines in all four TAP outputs — counted over the whole file, not
only the top level, so the nested plan is included — and zero cancelled and zero
todo outcomes in all four. Each run's structured report has exactly one
`complete` event and is terminated by it. Both full runs' 3,562 outcome names
are exactly the committed inventory's 3,562 `names` with identical
multiplicities — zero missing and zero extra, compared programmatically as
multisets against `suite-inventory.json` — and `A12 committed inventory
requirements match real outcomes` passes in both. Every skip in all four runs is
a `PERMITTED_SKIPS` key whose reason byte-matches that entry's documented
reason: zero mismatches. The single focused skip is `SHU-71 restricted
capability refusal`; the eight full skips are the eight `PERMITTED_SKIPS`
entries.

The counts are the tenth round's plus exactly this round's thirty names:
focused 2,141 → 2,171, full 3,532 → 3,562, with the skip counts (1 and 8)
unchanged. Twenty-eight are the new test file's; two are the
`BRANCH_RESTORE_MEASURED` real-payload rows the exhausted-invariance sweep
generates for every journal class, intact and recovered.

`PERMITTED_SKIPS` is byte-identical: 1,093 bytes,
sha256 `03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
`host-suite-contract.mjs` is byte-identical: 23,885 bytes,
sha256 `2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`.
`suite-inventory.json` is strictly additive: 3,532 → 3,562 names and
requirement rows, `files` 117 → 118, zero removals, every pre-existing entry
retained in its original relative order — `git diff --numstat` reports 159
insertions and 0 deletions. `file-requirements.json` (+1 row) and
`required-files.json` (+1 entry) are additive in the same way.

**Measured on the code revision, not on this record.** The four runs were
executed with the worktree pristine at `8a7e3563`. The documentation commit that
follows changes only this file, which the suite reads under exactly two guards:
`V8_DOCUMENTATION_LINK_TARGETS`, which resolves `file#Lnnn` links (this round
repoints two existing links and adds none), and `SHU71_PATH_NEUTRAL_COMMANDS`.
Both were re-checked after that commit, together with a re-run of the focused
selection.

The thirty names this round adds are in both selections:
`shu71-branch-restore.test.mjs` is an explicit entry of the focused selection
and matches the full run's `service/test/*.test.mjs` glob, and the two
exhausted-invariance names come from `shu71-trust.test.mjs`, which the focused
selection already carries as `shu71-trust*.test.mjs`.

### Twelfth correction round: the measurement a completion row may not skip

Repository-only. No target host was contacted, no network call was made, and no
`git push` or `gh` command was run.

The eleventh round moved the restoration of the published fixture refs into the
reviewed teardown as `restore-branch`, and proved it. `restore-branch` is a
JOURNALLED effect, so a durable `DONE` row makes every later invocation skip it
— and for the EFFECT that is right: a mutation already performed must not be
performed again. The same row skipped its MEASUREMENT with it, and the
measurement is the only thing in that teardown that observes state the host does
not own.

The independent verifier measured the consequence and the owner ruled it
blocking. `restore-branch` SUCCEEDS; a LATER teardown effect fails, so the
invocation ends `TEARDOWN_INCOMPLETE` and the episode stays open; a third party
then advances the lane branch; and the SECOND invocation — finding the `DONE`
row, skipping the step, and asking nothing about the ref — ends
`TEARDOWN_COMPLETE, failures: []` while the ref is advanced. A clean receipt
sitting on top of externally changed state.

The owner's ruling, verbatim:

> A completion row may avoid repeating an effect, but it may not avoid final
> measurement of externally mutable state. If a branch changes after an earlier
> restore and before a later teardown invocation, the result must HALT by name
> and leave the third-party value untouched. It must not emit a clean teardown
> receipt.

#### The RED, reproduced on the pre-fix revision

Measured by loading `004d27b6`'s `shu71-production.mjs` into the unchanged
`productionFixture` and running this round's controls against it. The owner's
scenario, verbatim output:

```
second invocation result : {"ok":true,"state":"REVOKED","code":null,"failures":[]}
last journal row         : {"seq":76,...,"event":"TEARDOWN_COMPLETE","failures":[]}
refs after               : {"remote":"ffffffffffffffffffffffffffffffffffffffff",
                            "local":"0d3b65a4...","tracking":"0d3b65a4..."}
BRANCH_FINAL_MEASURED    : 0 rows
```

`ok:true`, `REVOKED`, `failures: []`, `TEARDOWN_COMPLETE` — over a remote ref a
third party moved to `ffffffff…`, with the refs never read. Eight of this
round's nine controls fail on that revision. The ninth —
*a window that never published measures nothing and still completes* — passes
there and here: it pins the gate this round does **not** change.

#### What the final observation now does

`observeTeardown()` already ran on every invocation, DONE rows or not; that is
what the `observation` step is for. It now also measures the three refs the next
mint reads (`mint-shu71-package.mjs`, `repositoryFacts`): the branch on the
remote, the branch in the checkout, and the checkout's remote-tracking ref. One
`ls-remote` and two `for-each-ref`, on EVERY invocation, unconditionally,
whatever `restore-branch` or anything else recorded. What it finds is durable as
`BRANCH_FINAL_MEASURED` — branch and all three observed values — appended
BEFORE any conclusion is drawn from it, so the refusal says which value it
found.

The retained parent is the only value that closes the receipt:

* a THIRD value is someone else's write. It HALTS under
  `ACT_TEARDOWN_BRANCH_MOVED` and is left EXACTLY as the third party left it.
  This function issues no command at all — not a push, not an `update-ref` —
  so there is no path here by which a foreign value is overwritten, adopted or
  fast-forwarded;
* this run's own published head still standing at the end means the restoration
  did not hold. It HALTS under `ACT_TEARDOWN_BRANCH_UNRESTORED` rather than
  being quietly completed over. The two are named separately because they mean
  different things to an operator;
* an absent remote-tracking ref is the one tolerated absence, exactly as in the
  restoration: this run never creates that ref, and a checkout that has none is
  not carrying anything of ours;
* a read that FAILS is a failure. Nothing is wrapped: the refusal propagates,
  the step fails as `ACT_TEARDOWN_OBSERVATION` carrying `ACT_COMMAND_FAILED`,
  and `expiry-timer` refuses behind it.

Because the `observation` step is never journal-skipped and `expiry-timer`
refuses whenever any earlier step failed, `TEARDOWN_COMPLETE, failures: []` is
unreachable while any measured ref disagrees.

#### The four outcomes, each pinned by a control

| State on the second invocation | Outcome | Control |
| --- | --- | --- |
| ref still at the retained parent | clean receipt, measured again | `an unchanged ref on a second invocation is measured again and completes` |
| ref advanced by a third party | HALT `ACT_TEARDOWN_BRANCH_MOVED`, untouched | `a third-party advance after a completed restore halts by name and is left untouched` (and one per ref) |
| ref at this run's published head, restore already DONE | HALT `ACT_TEARDOWN_BRANCH_UNRESTORED`, untouched | `this run's published head standing at the end is never closed over` |
| ref at this run's published head, restore NOT done | named in the failing invocation, restored by the next one | `an unrestored ref is named, then restored by the invocation that may re-run the step` |
| the measurement itself fails | `ACT_TEARDOWN_OBSERVATION` + `ACT_COMMAND_FAILED` | `a final measurement that cannot be taken is a named failure with its cause` |

#### What did NOT change

The restoration's semantics are untouched: the same `local-reseed` intent gate,
the same tolerated absence of a remote-tracking ref, the same lease/refuse, the
same at-most-once mutation per invocation, the same cause-carrying failures. The
mint's `MINT_LINEAGE` refusal is untouched. No mutation's acceptance is widened
— the measurement mutates nothing at all, and issues no command beyond the three
reads.

Two existing B7 items are reconciled in place, additively:
`B7_FOREIGN_REFUSED_BY_NAME`'s expected failure list gains
`ACT_TEARDOWN_OBSERVATION` and `ACT_TEARDOWN_BRANCH_MOVED` behind the two
entries it already carried — a foreign value is now named twice, once by the
step that refused to restore it and once by the measurement that refused to
close over it — and the B7 gate mutation is re-anchored on
`restorePublishedRefs`'s own signature, because its gate line is no longer
unique in the module. No mutation name, control or killing assertion is
removed, renamed or reordered.

#### The mutants, and the named assertion that kills each

Recorded as observed at THIS round's committed and validated head, `25d46cc0`
(see the Validation section below). **Superseded for five of these nine rows as
of the fourteenth round's head, `acbf9d1` onward** — see the correction
immediately below the table; the earlier column is kept because it is what this
round's own run actually printed, and none of these nine kills is lost, only
renamed.

| Mutation | Killed by (twelfth round's head, `25d46cc0`) |
| --- | --- |
| the final measurement is removed entirely | `B8_FINAL_MEASURED_AGAIN` |
| the final measurement runs only when the restore has no DONE row | `B8_FINAL_MEASURED_AGAIN` |
| the final measurement is a no-op once it has run in an earlier invocation | `B8_FINAL_MEASURED_AGAIN` |
| the measurement is recorded but never judged | `B8_THIRD_VALUE_NOT_A_CLEAN_RECEIPT` |
| a third value is treated as restorable | `B8_THIRD_VALUE_UNTOUCHED` |
| the third value is overwritten by an unleased force | `B8_THIRD_VALUE_UNTOUCHED` |
| a third local head is overwritten by an unconditional update-ref | `B8_THIRD_VALUE_UNTOUCHED` |
| this run's published head is accepted at the end | `B8_UNRESTORED_HALTS_BY_NAME` |
| a measurement failure is swallowed | `B8_MEASUREMENT_FAILURE` |

The eleventh round's fifteen mutants are re-killed unchanged in the same runs.

**Correction, made in the SHU-280 lane's fourteenth round (`acbf9d1`), recorded
here rather than in a new section because it corrects THIS table.** The fourteenth
round removed `observePublishedRefs()`'s `local-reseed` intent gate (see the
twelfth round's own committed head above for what that predicate was) and
re-anchored the `GATE` mutation string in
`shu71-final-measurement-checks.mjs` onto the bare function signature. That file's
nine `mutations2` entries, their edits and their check functions are otherwise
byte-for-byte the same ones this table names — no mutation was added, removed or
reworded — but changing what the mutated function does upstream of a shared
multi-assertion check function moves which assertion inside that function throws
FIRST for five of the nine. All nine still die; zero survive. Measured two ways,
both against the exact revisions this table already cites: (1) the committed
revision `acbf9d1`, worktree pristine, by running `node --test
--test-reporter=tap
.github/coordinator/service/test/shu71-final-measurement.test.mjs` and reading
the `# killed by …` diagnostic each mutation subtest prints — the literal
`t.diagnostic` output of `killedBy()` in `shu71-final-measurement-checks.mjs`;
(2) the same command re-run against `25d46cc0` checked out standalone in an
adjacent worktree (`git worktree add --detach … 25d46cc0`), which reproduces the
left-hand column exactly, confirming the five-row move is a consequence of the
fourteenth round's own change and not of anything the thirteenth round did in
between:

| Mutation | Killed by, `25d46cc0` (as recorded above) | Killed by, `acbf9d1` onward (measured) |
| --- | --- | --- |
| the final measurement is removed entirely | `B8_FINAL_MEASURED_AGAIN` | `B8_THIRD_VALUE_HALTS_BY_NAME` |
| the final measurement runs only when the restore has no DONE row | `B8_FINAL_MEASURED_AGAIN` | unchanged — `B8_FINAL_MEASURED_AGAIN` |
| the final measurement is a no-op once it has run in an earlier invocation | `B8_FINAL_MEASURED_AGAIN` | unchanged — `B8_FINAL_MEASURED_AGAIN` |
| the measurement is recorded but never judged | `B8_THIRD_VALUE_NOT_A_CLEAN_RECEIPT` | unchanged — `B8_THIRD_VALUE_NOT_A_CLEAN_RECEIPT` |
| a third value is treated as restorable | `B8_THIRD_VALUE_UNTOUCHED` | `B8_FINAL_MEASUREMENT_RECORDS_WHAT_IT_FOUND` |
| the third value is overwritten by an unleased force | `B8_THIRD_VALUE_UNTOUCHED` | `B8_FINAL_MEASUREMENT_RECORDS_WHAT_IT_FOUND` |
| a third local head is overwritten by an unconditional update-ref | `B8_THIRD_VALUE_UNTOUCHED` | `B8_FINAL_MEASUREMENT_RECORDS_WHAT_IT_FOUND` |
| this run's published head is accepted at the end | `B8_UNRESTORED_HALTS_BY_NAME` | unchanged — `B8_UNRESTORED_HALTS_BY_NAME` |
| a measurement failure is swallowed | `B8_MEASUREMENT_FAILURE` | `B8_MEASUREMENT_FAILURE_NAMES_THE_STEP` |

The ninth row moves too, and is recorded as moving rather than folded into the
"unchanged" set: at `25d46cc0` the mutant leaves `measurementFailureCheck`'s
`second.ok === false` assertion (message `` `${label}: …` ``, literally
`B8_MEASUREMENT_FAILURE: …`) to fire first; at `acbf9d1` that assertion passes
and the next one — `second.failures.includes('ACT_TEARDOWN_OBSERVATION')`,
named `B8_MEASUREMENT_FAILURE_NAMES_THE_STEP` — fires instead, because the
gate's removal changes what the mutated, exception-swallowing observation call
leaves in `second.failures` on this path.

#### What could NOT be closed, and why

* **The receipt is written after the last read.** The final measurement proves
  the refs were at the retained parent when it read them, not that they stayed
  there. A third-party write that lands between that read and
  `journal.append({ event, failures })` — including during `expiry-timer`, which
  re-runs `observeTeardown()` but does NOT re-measure the refs — produces a
  clean receipt over changed state. This is the remaining route, it is narrowed
  from "any time after the earlier invocation's restore" to "inside one
  invocation's closing window", and no read can close it.
* **A ref left at this run's published head with `restore-branch` already DONE
  is halted, not restored.** Re-running a completed mutation would widen its
  acceptance, which this round is forbidden to do, so the teardown names the
  state and refuses the receipt and an operator repairs it.
* **The intent gate is unchanged**, so a window that somehow published without
  `local-reseed`'s durable INTENT row would not be measured. The gate is what
  keeps a pre-arm teardown from reading a credential it does not need.
* **Only the reseed branch is measured.** `coordinator/SHU-254` is bound at its
  fixed seed head and no reviewed step writes it.
* **The settlement allowance is consumed before the measurement runs.** On the
  exhausted-settlement path the allowance is reserved, then the filtered
  `observation` + `expiry-timer` effects run; a third-party movement discovered
  there costs that one allowance.
* **This is proved against `productionFixture`,** which models the three refs
  and git's own push/`update-ref` refusal rules. No live host, remote or
  credential was touched.
* **The post-completion re-observation does not measure the branch, and it was
  measured saying so.** Once an episode's journal carries `TEARDOWN_COMPLETE`,
  a later invocation takes the historical-receipt path in `execute()`, which
  runs `observeTeardown()` and `observeRetiredExpiry()` and returns. Probed on
  the modelled host: invocation two closes clean
  (`{"ok":true,"state":"REVOKED","failures":[]}`) with the refs at the retained
  parent; a third party then advances the remote to `ffffffff…`; invocation
  three returns
  `{"ok":true,"state":"REVOKED","activation_id":"…","physical_teardown_observed":true}`
  and takes no `BRANCH_FINAL_MEASURED` row. No NEW receipt is emitted — the
  durable `TEARDOWN_COMPLETE` is the one written while the refs WERE at the
  parent, and it was honest when written — but that path REPORTS `ok:true` over
  a ref a third party has since moved. It is outside this round's scope, which
  is the teardown's own final observation, and giving it the measurement would
  read a remote on every wake of every retired episode; it is recorded here
  rather than left to be rediscovered. **Closed in the thirteenth round below,
  together with the `expiry-timer` half of the first bullet. The owner ruled
  that the cost does not excuse the class; the inertness of a repeat wake is
  preserved by recording only a DISAGREEING reading on that path.**

#### The focused selection

The eleventh round's twenty-nine entries plus
`.github/coordinator/service/test/shu71-final-measurement.test.mjs`, this
round's own control file — thirty entries expanding to 37 test files.
`suite-runner-spec.test.mjs` is still deliberately NOT in it, for the reason
recorded under the eleventh round: its `A12 committed inventory requirements
match real outcomes` guard spawns a complete nested run with a 600 s cap of its
own. It belongs to the FULL runs, where it ran and passed in both.

#### Validation

All four runs are CI-like — uid 1000, umask 0022, the four target accounts
(`shu-coordinator`, `shu-supervisor`, `shu-workspace`, `shu71-evidence`) absent
as both users and groups, `chmod -R go-w .github/coordinator` applied first — on
the committed revision `25d46cc0`, tree `365bde34`, one at a time, in the
foreground, under `taskset -c 0-9 node --test --test-concurrency=4` with both a
TAP reporter and the unchanged `host-suite-contract.mjs` reporter writing to
separate files. Plain unsets `NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`;
clock sets `SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.

| Run | Tests | Pass | Fail | Skip | TAP plan | `complete` | Exit | Elapsed | Load before → after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Focused plain | 2,191 | 2,190 | 0 | 1 | `1..2191` | 1 / terminal | 0 | 244 s | 1.00 → 3.01 |
| Focused clock | 2,191 | 2,190 | 0 | 1 | `1..2191` | 1 / terminal | 0 | 228 s | 2.16 → 2.19 |
| Full plain | 3,582 | 3,574 | 0 | 8 | `1..3577` + one nested `1..5` | 1 / terminal | 0 | 497 s | 2.01 → 4.27 |
| Full clock | 3,582 | 3,574 | 0 | 8 | `1..3577` + one nested `1..5` | 1 / terminal | 0 | 500 s | 3.33 → 3.37 |

Zero `not ok` lines in all four TAP outputs — counted over the whole file, not
only the top level, so the nested plan is included — and zero cancelled and zero
todo outcomes in all four. Each run's structured report has exactly one
`complete` event and is terminated by it. Both full runs' 3,582 outcome names
are exactly the committed inventory's 3,582 `names` with identical
multiplicities — zero missing and zero extra, compared programmatically as
multisets against `suite-inventory.json` — and `A12 committed inventory
requirements match real outcomes` passes in both. Every skip in all four runs is
a `PERMITTED_SKIPS` key whose reason byte-matches that entry's value, compared
against the exported object rather than by eye: zero mismatches. The single
focused skip is `SHU-71 restricted capability refusal`; the eight full skips are
the eight `PERMITTED_SKIPS` entries.

The counts are the eleventh round's plus exactly this round's twenty names:
focused 2,171 → 2,191, full 3,562 → 3,582, with the skip counts (1 and 8)
unchanged. Eighteen are the new test file's; two are the
`BRANCH_FINAL_MEASURED` real-payload rows the exhausted-invariance sweep
generates for every journal class, intact and recovered.

`PERMITTED_SKIPS` is byte-identical: 1,093 bytes,
sha256 `03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
`host-suite-contract.mjs` is byte-identical: 23,885 bytes,
sha256 `2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`.
All three inventories are strictly additive with zero removals and the existing
order preserved: `git diff --numstat` reports 109/0, 8/0 and 1/0 insertions and
deletions for `suite-inventory.json`, `file-requirements.json` and
`required-files.json`. `suite-inventory.json` gains one file (118 → 119), 20
names (3,562 → 3,582) and the 20 matching requirement rows in the same order.

**Deviation from the eleventh round's harness, disclosed.** That round's
CI-like script also gave `/run` and `/etc/sudoers.d` fresh tmpfs mounts; this
round could not, having no elevation in this session. Everything else — uid,
umask, absent accounts, `go-w`, CPU mask, concurrency, reporters, foreground,
one at a time — is the same. The eight full skips and their reasons are
unchanged from that round, which is the observable those mounts bear on.

**Measured on the code revision, not on this record.** The four runs were
executed with the worktree pristine at `25d46cc0`. The documentation commit that
follows changes only this file, which the suite reads under exactly two guards:
`V8_DOCUMENTATION_LINK_TARGETS`, which resolves `file#Lnnn` links (this round
repoints two existing links, in the code commit that moved them, and adds none),
and `SHU71_PATH_NEUTRAL_COMMANDS`. Both were re-checked after that commit,
together with a re-run of the focused selection.

### Thirteenth correction round: the `ok:true` a written receipt may not stand on

Repository-only. No target host was contacted, no network call was made, and no
`git push` or `gh` command was run.

The twelfth round gave the teardown's own final observation an unconditional
re-measurement of the three refs the next mint reads, and proved it. Its own
disclosure named two paths that measurement did not reach, and the owner had
already ruled that class blocking:

> A completion row may avoid repeating an effect, but it may not avoid final
> measurement of externally mutable state… the result must HALT by name and
> leave the third-party value untouched. It must not emit a clean teardown
> receipt.

An invocation that returns `ok:true` over a ref a third party has advanced is
exactly that, whether or not it writes a new receipt. Both paths are closed
here.

**(1) The post-completion path.** Once an episode's journal carries
`TEARDOWN_COMPLETE`, a repeat `run`/`resume`/`revoke`/`expire` takes the
historical-receipt branch of `execute()`. It re-measured the units, the
activation credential and the gate drop-ins — because those drift — and asked
nothing about the refs, then answered
`{ ok: true, state: "REVOKED", physical_teardown_observed: true }`.

**(2) The `expiry-timer` re-observation.** The last step of a teardown re-runs
`observeTeardown()` as defence in depth against drift between the `observation`
step and the retirement, and re-read everything EXCEPT the refs. A write landing
in that interval was seen by nothing and the invocation closed
`TEARDOWN_COMPLETE, failures: []` over a moved ref.

#### The RED, reproduced on the pre-fix revision

Measured by loading `08ee0897`'s `shu71-production.mjs` — the committed head of
the twelfth round — into the unchanged `productionFixture`. Verbatim output of
the disclosed scenario: arm, revoke to a CLEAN completion, then a third party
advances the remote to `ffffffff…` and the episode is invoked again.

```
INVOCATION_ONE   {"state":"ARMED"}
INVOCATION_TWO   {"ok":true,"state":"REVOKED","code":null,"failures":[]}
REFS_AFTER_TWO   {"remote":"0d3b65a4…","local":"0d3b65a4…","tracking":"0d3b65a4…"}
JOURNAL_TAIL     TEARDOWN_COMPLETE
INVOCATION_THREE {"ok":true,"state":"REVOKED","activation_id":"shu71-proof-20260915",
                  "physical_teardown_observed":true}
BRANCH_FINAL_MEASURED rows: before 1, after 1
REMOTE_AFTER_THREE  ffffffffffffffffffffffffffffffffffffffff
TEARDOWN_COMPLETE rows: 1
```

`ok:true`, `REVOKED`, `physical_teardown_observed: true` — over a remote ref a
third party moved, with the refs never read and no `BRANCH_FINAL_MEASURED` row
taken. At this round's head the same invocation answers
`{"ok":false,"state":"HALT","code":"ACT_TEARDOWN_BRANCH_MOVED"}` and the remote
is still `ffffffff…`.

Five of this round's seven controls fail on `08ee0897`, each under its own named
assertion; the three per-ref third-party controls fail there too. The two that
pass on both revisions pin behaviour this round does **not** change — the
successor scope and the `local-reseed` intent gate — and are listed as such.

| Control | On `08ee0897` | Killing assertion there |
| --- | --- | --- |
| third-party advance after a COMPLETED teardown | FAILS | `B9_POST_COMPLETION_NOT_A_CLEAN_ANSWER` |
| unchanged ref, measured again, still clean | FAILS | `B9_POST_COMPLETION_UNCHANGED_MEASURED_ANYWAY` |
| this run's published head back on the remote | FAILS | `B9_POST_COMPLETION_UNRESTORED` |
| the measurement read failing | FAILS | `B9_POST_COMPLETION_READ_FAILURE_READ_ATTEMPTED` |
| a write inside the `expiry-timer` window | FAILS | `B9_EXPIRY_TIMER_WINDOW_NOT_A_CLEAN_RECEIPT` |
| third party on the remote / local / tracking ref | FAILS ×3 | `B9_POST_COMPLETION_NOT_A_CLEAN_ANSWER` |
| a live successor's scope reads nothing | passes | pins unchanged behaviour |
| a retired episode that never published | passes | pins unchanged behaviour |

#### What each path now does

Both call the twelfth round's `observePublishedRefs()` — the same function, the
same gate, the same judgement, no second implementation. One `ls-remote` and two
`for-each-ref`; the retained parent is the only value that answers clean; a
THIRD value HALTS as `ACT_TEARDOWN_BRANCH_MOVED`; this run's own published head
HALTS as `ACT_TEARDOWN_BRANCH_UNRESTORED`; an absent remote-tracking ref is the
one tolerated absence; a read that fails is a failure carrying its cause.

On the post-completion path the named refusal is now REPORTED by name rather
than flattened: `ACT_TEARDOWN_BRANCH_MOVED` and `ACT_TEARDOWN_BRANCH_UNRESTORED`
join `ACT_TEARDOWN_EXPIRY_SERVICE` as codes that survive to the caller, and
every other cause keeps `ACT_TEARDOWN_DRIFT` exactly as before — now with
`observation_error` and `command_failure` attached so an unanswered read says
what failed.

#### Which durable rows each path writes, and which it does not

Measured, not asserted. `observePublishedRefs()` takes a third argument,
`settled`, and it withholds exactly one thing: the recording of a reading that
AGREES with the retained parent, on the one path that writes no receipt at all.

* **In a teardown** — the `observation` step and the `expiry-timer`
  re-observation — the reading is recorded ALWAYS and BEFORE any conclusion is
  drawn from it, unchanged from the twelfth round: the receipt about to be
  written rests on it.
* **On the post-completion path** a DISAGREEING reading is recorded, because it
  is the only thing that says which value stopped the answer; an AGREEING one is
  not. A wake that merely confirms its own receipt must leave the host exactly as
  it found it — recording there would append another row on every later wake of
  every retired episode, forever, and would break the existing
  `B4_EXPIRY_REPEAT_TEARDOWN_INERT` property that a repeat teardown changes
  nothing on disk.

Between the completing invocation's last row and the refusing invocation's
answer the journal gains exactly ONE row, and on the clean re-invocation none:

```
ROWS_APPENDED       [ { "seq":70, "event":"BRANCH_FINAL_MEASURED", "branch":"coordinator/SHU-140",
                        "remote":"ffffffff…", "local":"0d3b65a4…", "tracking":"0d3b65a4…" } ]
CLEAN_ROWS_APPENDED []
```

* **Written on the post-completion path:** `BRANCH_FINAL_MEASURED`, and only on
  disagreement.
* **NOT written:** no second `TEARDOWN_COMPLETE` (the count stays at 1), no
  `TEARDOWN_INCOMPLETE`, no `REVOKE_REQUESTED`/`AUTHORIZATION_EXPIRED`, no
  `INTENT`/`DONE` teardown rows, no `HALTED` row. The durable
  `TEARDOWN_COMPLETE` was honest when it was written — every ref was at the
  retained parent then — and it is left exactly as it stands. The point is not a
  new receipt; it is that the RETURNED result must not be a clean success over
  state that disagrees.
* **No mutation is issued.** This path runs three reads and nothing else. A
  disagreement is never repaired here: re-running a completed mutation to put a
  third party's ref back would widen acceptance, which is still forbidden.

#### What did NOT change

* `observePublishedRefs()`'s gate, judgement, refusal names and tolerated
  absence; and its unconditional recording on every path that writes a receipt.
* `restorePublishedRefs()` and every `restore-branch` semantic: the lease, the
  refuse-don't-overwrite rule, at-most-once mutation, the read-only push
  recovery. A durable `DONE` row still stops the EFFECT from repeating, proved
  by the re-killed `B8_EFFECT_NOT_REPEATED` assertions.
* `MINT_LINEAGE`. A branch this teardown refused to restore still stops the next
  window.
* The successor-scope answer, deliberately: see the disclosure below.
* `PERMITTED_SKIPS` (1,093 bytes, sha256 `03cf773e…e11e`) and
  `host-suite-contract.mjs` (23,885 bytes, sha256 `2a19d72c…58e9`), byte-identical.

#### The mutants, and the named assertion that kills each

Ten mutations, each a single anchored substitution in a disposable copy of the
committed module, each run first against the real module (must pass) and then
against the mutant (must fail under a `B9_` assertion that is printed, not
merely counted).

| Mutant | Killed by |
| --- | --- |
| the post-completion measurement is removed entirely | `B9_POST_COMPLETION_NOT_A_CLEAN_ANSWER` |
| the same removal, seen from the clean re-invocation | `B9_POST_COMPLETION_UNCHANGED_MEASURED_ANYWAY` |
| the `expiry-timer` re-observation skips the refs | `B9_EXPIRY_TIMER_WINDOW_NOT_A_CLEAN_RECEIPT` |
| a measured disagreement is answered `ok:true` | `B9_POST_COMPLETION_NOT_A_CLEAN_ANSWER` |
| the named branch refusal is flattened into drift | `B9_POST_COMPLETION_HALTS_BY_NAME` |
| the refused reading is never recorded | `B9_POST_COMPLETION_REFUSAL_IS_DURABLE` |
| the reading is recorded even when it agrees | `B9_POST_COMPLETION_UNCHANGED_STAYS_INERT` |
| the third remote value is overwritten by a force push before the named refusal | `B9_THIRD_VALUE_UNTOUCHED` |
| a third local head is overwritten by an unconditional `update-ref` before the named refusal | `B9_THIRD_VALUE_UNTOUCHED` |
| a post-completion read failure is swallowed | `B9_POST_COMPLETION_READ_FAILURE_NEVER_A_SILENT_PASS` |

The two overwrite mutants still refuse by name and still halt — they put the
ref back first. The kill therefore comes from the REF, not from the answer,
which is the property the ruling actually states.

#### What could NOT be closed, and why

* **The closing window is still open, and no read can close it.** The receipt is
  written after the last read. `observePublishedRefs()` proves the refs were at
  the retained parent when it read them, never that they stayed there. This
  round moves the last reading of the refs from the `observation` step to the
  `expiry-timer` step that immediately precedes
  `journal.append({ event, failures })`, so the unobservable interval shrinks
  from the whole tail of the teardown to that one step — and it does not vanish.
  A third-party write that lands inside it produces a clean receipt over changed
  state. **This is stated as unexplained, not solved:** closing it would require
  the ref to be held against writers for the length of the receipt, which this
  lane has no mechanism for and this round does not invent.
* **The live-successor scope still measures nothing, on purpose.** When
  `active.json` names a DIFFERENT activation, a retired episode answers
  `{ ok: true, receipt_scope: "retired_episode",
  physical_teardown_observed: false }`. That answer makes NO physical claim, and
  the lane's refs belong to the live successor, which may legitimately be
  holding its own published head on them: measuring there would refuse a
  successor's ordinary arming. It is the one remaining `ok:true` that takes no
  reading, it is pinned by a control so no later edit can make it claim more
  without measuring more, and it is named here rather than left implicit.
* **Two other `ok:true` answers take no reading, and neither claims a
  teardown.** `{ ok: true, state: "NOT_EXPIRED" }` answers an expiry wake of a
  window that has not expired and whose teardown has not started, and
  `{ ok: true, state: "ARMED" }` is the arming result. Both belong to a LIVE
  episode whose published head is legitimately on the remote — measuring the
  refs against the retained parent there would refuse the run's own arming.
  They are enumerated here so the claim "every closing observation measures" is
  read as what it is: every answer that asserts a teardown was observed.
* **A clean post-completion wake leaves no trace that it measured.** Preserving
  inertness means the agreeing reading is not recorded, so the journal alone
  cannot prove a given wake took it. What proves it is the code and the control
  that counts the three reads across the invocation
  (`B9_POST_COMPLETION_UNCHANGED_MEASURED_ANYWAY`), not a durable row. The
  alternative — recording every wake — was rejected because it makes a repeat
  wake of a settled episode non-inert and grows the journal without bound.
* **The intent gate is unchanged**, so an episode with no `local-reseed` INTENT
  row is never measured on either path. That is what keeps a periodic wake of a
  retired, never-armed episode from reading a remote or a credential — pinned by
  a control that counts read commands across the whole re-invocation.
* **The cost is real and is not hidden.** A retired episode that DID publish now
  performs one `ls-remote` and two `for-each-ref` on every later invocation, and
  a completing teardown performs them twice. The twelfth round named that cost
  as a reason to defer; the owner's ruling on the class settles it against the
  cost.
* **The settlement allowance is still consumed before the measurement runs** on
  the exhausted path, unchanged from the twelfth round. That path's own
  `observeTeardown()` precondition, taken before `SETTLEMENT_STARTED`, is
  deliberately NOT given the ref reading: the filtered effect list it then runs
  is `observation` plus `expiry-timer`, both of which measure.
* **Only the reseed branch is measured.** `coordinator/SHU-254` is bound at its
  fixed seed head and no reviewed step writes it.
* **Proved against `productionFixture`,** which models the three refs
  independently and git's own push/`update-ref` refusal rules. No live host,
  remote or credential was touched.

#### The accounting the two new readings moved, and the anchors they moved

Every change below is a count or an anchor that this round's code displaced. No
property, refusal or guard was weakened; each is listed so none of it is
discovered later as an unexplained edit.

* `shu71-composition.test.mjs`: `B1_RESUME_EFFECT_COUNT` 94 → 98 and
  `B1_EXPIRY_EFFECT_COUNT` 98 → 102 (+4 each: the `expiry-timer` reading's three
  reads and its durable row), and `B1_REVOKE_OBSERVATION_ONLY` 9 → 12 (+3: the
  post-completion path's three reads — THREE, not four, because the reading
  agreed and was therefore not recorded).
* `shu71-r8-state-model.mjs`: +4 uniformly in every state whose teardown reaches
  the retirement step and whose intent gate lets it read — `armed` intact
  98 → 102, truncated 99 → 103, recovered 98 → 102; `settlement-ready` intact
  57 → 61, truncated 91 → 95, recovered 90 → 94; the settled transition 37 → 41.
  The gate-skipped states (81, 80) and the refused transitions (7, 8) are
  unchanged.
* `shu71-final-measurement-checks.mjs`: `B8_FINAL_MEASURED_AGAIN` in the
  unchanged-ref control now expects `measured + 2` rather than `measured + 1`,
  because a completing invocation reads the refs in the `observation` step and
  again in the retirement step. No mutant kill depended on that number — every
  `B8_FINAL_MEASURED_AGAIN` kill comes from the third-party control, which
  asserts `>` and is untouched. Its `GATE` anchor is re-pointed at the function's
  new signature; both mutations on it are unchanged.
* Four existing mutants are re-anchored onto lines this round moved, with their
  mutations unchanged: `retired episode expiry drift unobserved` and
  `live expiry companion reported as generic drift`
  (`shu71-production-mutations.test.mjs`), `P1 retirement re-observation removed`
  (`shu71-recovery-mutations.test.mjs`) and `F1 receipt observation omitted`
  (`shu71-trust-mutations.test.mjs`). All four still kill.
* The `journal.append` call-site inventory
  (`SHU71_CONTROL_PROPERTY_JOURNAL_APPEND_INVENTORY`) is unchanged: this round
  adds no append site and no event class. The single `BRANCH_FINAL_MEASURED`
  append is the same site, now guarded by a condition.

#### The focused selection

The twelfth round's thirty entries plus
`.github/coordinator/service/test/shu71-post-completion.test.mjs`, this round's
own control file — thirty-one entries expanding to 38 test files.
`suite-runner-spec.test.mjs` is still deliberately NOT in it, for the reason
recorded under the eleventh round: its `A12 committed inventory requirements
match real outcomes` guard spawns a complete nested run with a 600 s cap of its
own. It belongs to the FULL runs, where it ran and passed in both.

#### Validation

All four runs are CI-like — uid 1000, umask 0022, the four target accounts
(`shu-coordinator`, `shu-supervisor`, `shu-workspace`, `shu71-evidence`) absent
as both users and groups, `chmod -R go-w .github/coordinator` applied first — on
the committed revision `7b86dcbf`, tree `aa5c1e95`, with the worktree measured
clean at the start of each run, one at a time, in the foreground, under
`taskset -c 0-9 node --test --test-concurrency=4` with both a TAP reporter and
the unchanged `host-suite-contract.mjs` reporter writing to separate files.
Plain unsets `NODE_OPTIONS` and `SHU_TEST_CLOCK_OFFSET_MS`; clock sets
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.

| Run | Tests | Pass | Fail | Skip | TAP plan | `complete` | Exit | Elapsed | Load before → after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Focused plain | 2,211 | 2,210 | 0 | 1 | `1..2211` | 1 / terminal | 0 | 221 s | 11.22 → 3.08 |
| Focused clock | 2,211 | 2,210 | 0 | 1 | `1..2211` | 1 / terminal | 0 | 221 s | 3.08 → 2.65 |
| Full plain | 3,602 | 3,594 | 0 | 8 | `1..3597` + one nested `1..5` | 1 / terminal | 0 | 503 s | 2.51 → 3.31 |
| Full clock | 3,602 | 3,594 | 0 | 8 | `1..3597` + one nested `1..5` | 1 / terminal | 0 | 491 s | 3.31 → 3.52 |

Zero `not ok` lines in all four TAP outputs — counted over the whole file, not
only the top level, so the nested plan is included — and zero cancelled and zero
todo outcomes in all four. Each run's structured report has exactly one
`complete` event and is terminated by it. Both full runs' 3,602 outcome names
are exactly the committed inventory's 3,602 `names` with identical
multiplicities — zero missing and zero extra, compared programmatically as
multisets against `suite-inventory.json` — and `A12 committed inventory
requirements match real outcomes` passes in both. Every skip in all four runs is
a `PERMITTED_SKIPS` key whose reason byte-matches that entry's value, compared
against the exported object rather than by eye: zero mismatches. The single
focused skip is `SHU-71 restricted capability refusal`; the eight full skips are
the eight `PERMITTED_SKIPS` entries.

The counts are the twelfth round's plus exactly this round's twenty names:
focused 2,191 → 2,211, full 3,582 → 3,602, with the skip counts (1 and 8)
unchanged. All twenty are the new control file's.

`PERMITTED_SKIPS` is byte-identical: 1,093 bytes,
sha256 `03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
`host-suite-contract.mjs` is byte-identical: 23,885 bytes,
sha256 `2a19d72c4fc3f9559c9abe7edaaa7f0c29471bd829dd6e59f6ba809eb0ca58e9`.
All three inventories are strictly additive with zero removals and the existing
order preserved: measured against `08ee0897`, `git diff --numstat` reports
101/0, 8/0 and 1/0 insertions and deletions for `suite-inventory.json`,
`file-requirements.json` and `required-files.json`. `suite-inventory.json` gains
one file (119 → 120), 20 names (3,582 → 3,602) and the 20 matching requirement
rows in the same order.

#### The previous rounds' mutants, re-killed in the same run

`shu71-branch-restore.test.mjs`, `shu71-final-measurement.test.mjs` and
`shu71-post-completion.test.mjs` run together: 66 tests, 66 passing, and 34
mutants each dying under a printed named assertion — the eleventh round's 15
`B7_*`, the twelfth's 9 `B8_*` and this round's 10 `B9_*`. `restore-branch`'s
durable `DONE` row still prevents the EFFECT from repeating: both
`B8_EFFECT_NOT_REPEATED` controls pass, asserting that a re-invocation takes no
new `BRANCH_RESTORE_MEASURED` row and issues no push or `update-ref`, while the
final measurement runs anyway.

**Deviation from the eleventh round's harness, disclosed.** That round's CI-like
script also gave `/run` and `/etc/sudoers.d` fresh tmpfs mounts; this round could
not, having no elevation in this session — the same deviation the twelfth round
recorded. Everything else — uid, umask, absent accounts, `go-w`, CPU mask,
concurrency, reporters, foreground, one at a time — is the same. The eight full
skips and their reasons are unchanged, which is the observable those mounts bear
on.

**Measured on the code revision, not on this record.** The four runs were
executed with the worktree pristine at `7b86dcbf`. The documentation commit that
follows changes only this file, which the suite reads under exactly two guards:
`V8_DOCUMENTATION_LINK_TARGETS`, which resolves `file#Lnnn` links (this round
repoints three existing links, in the code commits that moved them, and adds
none), and `SHU71_PATH_NEUTRAL_COMMANDS`. Both were re-checked after that
commit, together with a re-run of the focused selection.

### Fifteenth correction round: the post-push ancestry read is bounded by the commit, not by the diff

**The refusal this round closes, measured.** An owner-approved window armed
through the documented entrypoint took `binding`, `sign`, `expiry-watch`,
`local-reseed` and the push, and then HALTED:

```
{"ok":false,"state":"HALT","code":"ACT_API_FAILED",
 "api_failure":{"operation":"github:compare/<parent>...<reseed>","reason":"response_too_large","status":200,"attempts":1},
 "teardown":{"ok":true,"state":"REVOKED","code":null,"failures":[]}}
```

The push had LANDED. The reviewed teardown measured the lane branch back — the
remote, the checkout and the remote-tracking ref all at the retained parent
again — and left both dispatch gates at `ENABLE_DISPATCH=false`, with no
activation file and no unit running. What refused was the READ that is supposed
to confirm the push. Measured read-only afterwards against the live repository,
for the bound pair that window carried:

| read | http | bytes |
| --- | --- | --- |
| `compare/<parent>...<reseed>` — what the code asked for | 200 | 1,667,573 |
| the same route with `?per_page=1` | 200 | 1,289,506 |

`status: ahead`, `ahead_by: 27`, `behind_by: 0`, and the `files` array
truncated by GitHub at 300 **with patches**: the body IS the patch array,
`per_page` bounds the commit list and not it, and the body grows with the diff
the reseed merge brings — so the route refuses a landed push more certainly as
`main` advances, against this module's unchanged 1 MiB read cap.

**What the round changes: the READ, and nothing else. The claim and its refusal
name are unchanged.**

was (this round's parent, `182c5db`):

```js
const comparison = await githubRead(`compare/${old}...${next}`);
need(comparison.status === 'ahead' && comparison.merge_base_commit?.sha === old, 'ACT_REMOTE_ANCESTRY');
```

is now:

```js
const reseedCommit = await githubRead(`git/commits/${next}`);
const reseedRef = await githubRead(`git/ref/heads/${encodeURIComponent(pkg.reseed.branch)}`);
const reseedParents = Array.isArray(reseedCommit.parents) ? reseedCommit.parents.map(parent => parent?.sha) : [];
need(reseedCommit.sha === next && reseedParents.length === 2
  && reseedParents[0] === spec.binding.expected_parent && reseedParents[1] === spec.binding.approvedExecutionRevision
  && reseedRef.object?.sha === next, 'ACT_REMOTE_ANCESTRY');
```

The Git Data route answers the COMMIT OBJECT alone — parents and tree pointers,
kilobytes, no patch array. Five terms are now asserted, not one:

1. `next` is the SIGNED reseed sha the package binds;
2. the parent list is exactly two long;
3. its first parent is the parent this package retained;
4. its second parent is the approved execution revision — the same pair in the
   same order `verifyReseedCommit()` binds locally above, so the remote read and
   the local verification cannot drift apart;
5. the branch is still AT `next` when it is read a second time, after
   `heads(spec, true)` has already required it once.

A foreign sha, a missing or malformed object, reversed parents, a third parent,
or a ref that moved between the two reads each refuse `ACT_REMOTE_ANCESTRY` on
the FIRST answer. Both reads reach the retried read door, so only their RACES
retry — the rule the eighth round established is unchanged and is now measured
on the commit object and the ref rather than on a comparison.

**The 1 MiB cap is unchanged**, and the route that caused the refusal cannot
come back silently: one control asserts that a window which arms never requests
`compare/` at all, and one mutant puts the comparison read back to prove the
control sees it.

**Controls and mutants added**, all in
`test/shu71-postpush-readback-checks.mjs`, driven by
`test/shu71-postpush-readback.test.mjs`:

| control | what it measures |
| --- | --- |
| a landed push whose reseed commit read is not answerable yet still arms | the read's RACES retry, and the retry is recorded |
| arming never asks for the patch-bearing comparison | the route that refused a landed push is not requested by a successful run |
| a genuinely wrong ancestry refuses instead of being retried | a foreign sha on every answer refuses on the first |
| parents in the other order refuse instead of being retried | the order term, alone |
| a third parent refuses instead of being retried | the count term, alone — a superset merge the order terms cannot see |
| a ref that moved after the push refuses instead of being retried | the second ref read, alone, with the commit object still agreeing |

and one mutant per term of the claim — the signed sha not compared, the order
not required, the count not required, the ref not required — each killed by the
control that measures that term alone, plus the read going back to the
unretried door, the read retried until it agrees, and the patch-bearing
comparison coming back.

**The committed suite inventory moves with the tests.** `suite-inventory.json` — which the A12
guard reads out of the COMMITTED revision, so it cannot be updated after the fact — gains exactly
the nine tests this round adds and the four it renames, and nothing else. The guard's own internal
run at this round's head reports `121 files; 3625 child outcomes plus this guard`, 18/18.

**Superseded text in this file.** The eighth round's table row
`remote-push compare` and the sentence below that table which cites "a compare
status that is not `ahead`" describe the read as it stood then. The RULE they
state is unchanged — any 2xx answer is returned to the caller unchanged, so a
genuine state mismatch still refuses on the first answer — and it is now
measured on the commit object and the ref instead of on a comparison.

**Validation of the fifteenth correction round.** The four runs were executed with the worktree PRISTINE at the code revision
`cfd128af` (tree `4ca2e2d8`) — `dirty=0` at start and at finish, `TMPDIR` pinned to a plain
directory, one mode at a time, `taskset -c 0-9`, `--test-concurrency=4`, the same
`host-suite-contract` reporter and per-mode `timeout` the earlier rounds used:

| mode | exit | seconds | TAP ok | TAP not ok |
| --- | --- | --- | --- | --- |
| focused, plain | 0 | 238 | 2,235 | 0 |
| focused, clock-shifted | 0 | 237 | 2,235 | 0 |
| full, plain | 0 | 518 | 3,621 | 0 |
| full, clock-shifted | 0 | 487 | 3,621 | 0 |

The focused selection is unchanged (32 files) and its count rises by exactly the nine tests this
round adds — 2,226 to 2,235 — and the full selection by the same nine, 3,612 to 3,621. The A12
guard re-ran the whole suite inside both full runs and reported `121 files; 3625 child outcomes
plus this guard` at this revision, 18/18.

**Focused selection after the documentation commit.** The re-check below was run against the
exact bytes this commit lands.

**Focused selection after the documentation commit.** The focused selection was re-run against these exact bytes, unchanged (32 files): 2,235 tests,
2,234 passing, 0 failing, one permitted skip — the same zero-failure result as at the code
revision — and `V8_DOCUMENTATION_LINK_TARGETS`, which resolves the three links this round
repointed at the exact line number it pins, passes over this file.

## Sixteenth correction: each parent position is its own term (F3)

The fifteenth round stated the ancestry claim term by term in prose and pinned the
two parent *positions* with a single clause and a single control that reversed
BOTH parents at once. An independent verifier found the consequence: a mutant that
removes `reseedParents[0]` alone - or `reseedParents[1]` alone - survived the
entire committed control set, because with one position dropped the other still
disagrees with the reversed pair, so the reversal control kept passing. The
behaviour was never in doubt, and the verifier said so: the shipped read refuses
both single-position shapes. The *proof* was the gap, and this correction closes
it with one named control and one killing mutant per position.

* `B5 post-push read-back: the first parent position alone is wrong and refuses
  under its own name` corrupts only position 0, and asserts the shape it served
  BEFORE reading the refusal - the signed reseed sha is still the commit's own
  sha, the count is still two, position 1 is still the approved execution
  revision, exactly one entry differs from the genuine pair, and the ref still
  carries the commit - so "every other term remained true" is measured, not
  claimed. It then asserts `ACT_REMOTE_ANCESTRY`, exactly one read of the route,
  no retry delay, and no activation file.
* the mirror control for position 1, with its own assertion name.
* `the first parent position is not required` removes the anchor
  `reseedParents[0] === spec.binding.expected_parent && ` and is killed by
  `B5_ANCESTRY_PARENT_0_REQUIRED`.
* `the second parent position is not required` removes the anchor
  ` && reseedParents[1] === spec.binding.approvedExecutionRevision` and is killed
  by `B5_ANCESTRY_PARENT_1_REQUIRED`.

Neither single-position survivor is killed by the reversal control that previously
stood in for both, which is what the killing names above record. The shipped read
is untouched: this correction changes tests, the committed inventory, and this
record only - no production behaviour.

**The four modes at the code revision.** The worktree was pristine at `6152c34` (tree
`45a36880`, `dirty=0`) for every mode, `TMPDIR` pinned to `/tmp`:

* focused, plain: exit 0, 241s, 2,239 ok / 0 not ok
* focused, shifted clock: exit 0, 247s, 2,239 ok / 0 not ok
* full, plain: exit 0, 525s, 3,625 ok / 0 not ok
* full, shifted clock: **exit 1 on the first observation** - 508s, 3,624 ok / **1 not ok**. The
  failure was the A12 guard itself (test 2414), whose internal re-run of the whole suite caught a
  single intermittent failure in `residual.test.mjs` - `SHU251 mutation: terminal receipt lost
  after restart` - in a file this correction does not touch and outside the focused selection.
  An identical re-run of the same mode, with nothing else running on the box, returned exit 0,
  3,630 tests, 3,622 pass, 8 skipped, 0 fail, with the guard reporting
  `121 files; 3629 child outcomes plus this guard`.

That intermittent is the one already recorded as a known flake in an earlier round; it is a
property of the suite, not of this change, and the first observation ran while the cold-review
gate and the pre-arm probe were executing on the same box, which is the likely trigger for a
timing-sensitive test. It is stated here at the same weight as the green runs rather than
summarised away: a mode that came back red once, for a reason, and green on an identical repeat
is not the same claim as an unbroken green, and the difference belongs in the record.

**Focused selection after the documentation commit.** Re-run against the exact bytes this
commit lands, unchanged, with the committed inventory in place: green, and the guards that read
this file (`V8_DOCUMENTATION_LINK_TARGETS` among them) pass over it. No production file is
touched by this correction, which a diff of `256e5ee..6152c34` shows: two paths, the test module
and the committed suite inventory.

**The ref term is measured by these controls, not left true by construction.** The first
submission of this section said the position controls assert "the ref still carries the commit"
while the code asserted only properties of the served commit object; an independent verifier
caught the difference and was right. The controls now observe the reseed-ref answers the fixture
actually serves and assert that the last one still carries the signed reseed commit, so the
sentence is true because the code measures it. Falsifiability was checked rather than assumed:
serving a foreign sha on that route makes both controls fire with their own tokens
(`B5_ANCESTRY_PARENT_0_REQUIRED`, `B5_ANCESTRY_PARENT_1_REQUIRED`).

**Also corrected here:** this section carried one paragraph duplicated verbatim (reported by the
verifier as F2); the duplicate is removed. The older orphan stub in the fifteenth section
(`**Focused selection after the documentation commit.**` followed immediately by the real
paragraph) is left as merged and is recorded here as a known cosmetic leftover, not fixed in
this correction.

### Seventeenth correction round: the second fixture's ref is a sealed term, and it now has its own control

A reviewer with no lane history and no stake read the `shu71-mint-00000025` block, both verifier
verdicts, the package record, the pre-arm probe and the digest witnesses, and returned **DO NOT
APPROVE** with five objections. Four were record or coverage gaps, closed here and in the package;
one was a hole in the enforcement of a term the block seals, and it is closed with a control.

**The hole, as measured - this paragraph replaces a wider claim a first draft made and the round's
independent verifier falsified.** `heads()` binds **every** fixture the package pins, not only the one
being reseeded: per fixture it measures the local `rev-parse --verify`, the remote `ls-remote --refs`
and the GitHub `git/ref` read-back, and it refuses under `ACT_REF_BINDING`, naming the leg that
disagreed. What the committed baseline at `a51c8490` actually pinned for the second fixture, taken file
by file rather than asserted:

- its **readback** leg had one committed assertion, and a weak one - `shu71-production-mutations.test.mjs`
  ("post-push readback omitted") serves a foreign sha on the SHU-254 ref **after** the push and asserts
  `state === 'HALT'` (`B1_REMOTE_READBACK_REFUSED`): post-push only, no refusal code, and no leg named;
- its **local** and **remote** legs had none: a mutant that neuters either one for fixture_2 alone
  leaves the parent's **whole** committed suite green (measured below).

So the gap was narrower than the first draft's "no committed assertion would have noticed", which was
false. What remains true, and is what makes this blocking: the **local** and **remote** legs of a
fixture whose head the block seals had no committed assertion at all, which is the same class of
unpinned sealed term the owner refused `shu71-mint-00000024` for.

`secondFixtureRefBindingCheck` mutates exactly one leg of the second fixture at a time - readback,
remote, local - and each refusal is asserted by its own name with the other two legs agreeing, in the
result, in the leg field and in the journal:
`B6_SECOND_FIXTURE_REF_BINDING readback|remote|local`. Five mutants are killed by it, and what each of
them does and does not prove - two pin the loop's shape, three neuter one leg each while keeping every
read it already made - is stated with its measurement below, because the first version of this
paragraph claimed more for the pair than the parent's committed suite bears out.

**RED at the parent, with the scope measured instead of assumed.** Two mutants were added first - the
fixture loop truncated to the first fixture, and the second fixture skipping its legs. At the parent
they survive all 39 controls committed in B6 (`red-at-parent-280h.tap`), but they do **not** pin a
hole: five committed tests **outside** B6 kill them at the parent (the B1/B4 post-push read-back,
`B1_SINGLE_LANE`, `B1_TWO_LANES`, and two B5 sleep-budget checks). The first draft's claim that they
"pin a hole rather than restating a kill" was false - the scope measured was B6, the sentence claimed
the committed suite - and the round's verifier caught it. They are kept, and described for what they
are: they pin the loop's shape, not the per-leg semantics.

What pins the term is the per-leg enforcement set added in response: each neuters exactly one of
fixture_2's legs while keeping every read it already made. At this head each is killed by exactly one
variant of the control - `local` by `local`, `remote` by `remote`, `readback` by `readback` - where the
two earlier mutants are killed by all three variants, which is the discrimination the reviewer measured
as missing. Against the parent's whole committed suite, name-diffed against an unmutated baseline run
of the same export:

    parent a51c8490, whole committed suite, unmutated baseline run of the same export:
      baseline                     exit 0    0 failures
      fixture_2 LOCAL leg neutered     exit 0    0 failures   <- the parent never noticed this leg
      fixture_2 REMOTE leg neutered    exit 0    0 failures   <- nor this one
      fixture_2 READBACK leg neutered  exit 1    2 failures   <- `B1/B4 mutation: post-push readback
                                                               omitted` (a real kill: that leg had
                                                               committed cover) plus the A12 guard,
                                                               which red-fails whenever any row fails
                                                               inside its own run
    (`parent-suite-survival.txt`, `parent-suite-survival-run.log`; the parent worktree is restored from
    git after every run and ended clean.)

**The reseed terms are enforced twice, and that is now stated precisely.** The local acceptance
`verifyReseedCommit` runs inside the `remote-push` step **before** the push; the post-push read-back
then re-measures the same terms against the remote under `ACT_REMOTE_ANCESTRY` - the commit's parents
in the bound order and the lane ref still at the bound reseed sha - and the activation file is written
only after that read-back succeeds. So a wrong local reseed is refused before the push and again after
it, and nothing arms in either case. The read-back is the enforcing check and is pinned by the two
per-position controls and their mutants (this round and the previous one). The local acceptance has no
dedicated control of its own; that is recorded here rather than left implied.

**What the next package record must carry - stated as requirements, not as accomplished facts.** Two
things the cold-approval gate checks before any block reaches the owner, and which are therefore
requirements on the package that follows this correction rather than claims about a document that
exists at this head: the item the owner refused must be named as such - the per-position ancestry
clause, with the two per-position controls and the mutants that close it cited by name - and the
verifier's own baseline findings must be labelled separately from it, so that the two cannot be
confused again as they were in the `shu71-mint-00000025` package. Second, each of the block's three
sealed digests must be shown with the inputs it was derived from, their paths and hashes, the revision
and instant of derivation, a raw file-byte witness where one exists, and an explicit statement of what
the seal covers - the machine package and the signed artifacts, not the narrative prose, which is not
signed and is not what the owner's approval binds. The witnesses for the superseded block are in
`digest-witnesses.txt`; the same script produces the next block's at mint time, and the gate reads
them before the owner does.

**Focused selection after this correction.** The committed focused selection is run at this head, and
the four modes follow in the same lane:

Four modes at this head (`94aa6622`, tree `d2d3ece6`), one mode at a time:

    focused plain   exit 0   2247 ok / 0 not ok   (244s)
    focused clock   exit 0   2247 ok / 0 not ok   (253s)
    full plain      exit 0   3633 ok / 0 not ok   (541s)
    full clock      exit 1   3632 ok / 1 not ok   (513s)   - the recorded family again, below

The A12 committed-inventory guard runs inside the full scope and is green in full plain, so the eight
rows this lane added across its two commits - three control legs and five mutants - move with the tests
they describe.

**The reds in the four modes, characterised further rather than summarised away.** Two heads, two reds,
both full clock, both the same family:

- at `d09b1dd7`, the positive control `SHU251 live worker restart adopts once and recovers durable
  completion` failed at the assertion inside the signed launch path - `residual.test.mjs:65`,
  `assert.equal(response.ok, true)`: the supervisor did not accept the launch request - after 5.4s,
  which is not a timeout. Its two mutation siblings passed in the same run;
- at `94aa6622`, the `loseReceipt` mutation sibling failed, observed through the A12 guard, whose inner
  run reported `tests=3637 / pass=3628 / fail=1 / skipped=8`.

Three things are now known that were not known when this family was last reported:

- `residual.test.mjs` is **not in the committed focused selection**, so only the full scope ever
  exercises this family; that is why every sighting has been in a full run.
- It does not reproduce in isolation or under plain load: 6/6 green with the shifted clock and 3/3
  green plain, each run alone; 10/10 green plain earlier, four idle and six under 8-way CPU load; and a
  per-leg mutant sweep of the parent's whole committed suite ran four times without a single failure.
  The trigger is therefore the full concurrent run - a configuration in which the live-restart family
  shares the box with every other test - not the clock shift, and not CPU load on its own.
- All three sightings in this lane are this family and differ in member: the `loseReceipt` mutation at
  `6152c34`, the positive control at `d09b1dd7`, and the `loseReceipt` mutation again at `94aa6622`
  (inside the A12 guard's concurrent inner run, whose own report was `tests=3637 / pass=3628 / fail=1 /
  skipped=8`). Different members failing at different heads is the shape of a timing or resource
  interaction, not of a wrong assertion.

The clean re-run the lane's precedent asks for was done for both heads, on an idle box with nothing else
running: at `d09b1dd7` **exit 0, `3630 ok / 0 not ok`** (`full-clock-rerun-280h.tap`) and at `94aa6622`
**exit 0, `3633 ok / 0 not ok`** (`full-clock-rerun-280h-r18.tap`) - so every red is recorded with the
green that follows it, never the green alone.

The concrete next step, for a lane of its own, is to record what the refusal carried: `ok:false` from
`submitToSupervisor` is currently discarded by the assertion, so the reason the supervisor declined is
not captured anywhere. Until then this stays an explicit owner-facing acceptance item: the guard
red-fails on any non-pass, so it can refuse or delay a run and can never let an escape through
silently, and the affected family is unrelated to the ancestry claim this window arms - it is a
pre-existing test in a file neither this round nor the previous one touches.

**The first verification of this head returned FAIL, and this is what changed.** An independent
verifier (a different model family, no lane history) confirmed the control itself as sound,
non-vacuous and leg-discriminating, and failed the round on its own record: two load-bearing RED
statements were false against the machine - both corrected above, with the sentences that were wrong
left visible rather than quietly rewritten - and both of the first two mutants restated kills the
committed suite already made, which is the reason the three per-leg enforcement mutants exist. Its
third finding, that neither mutant separated one leg from another, is addressed by those three and
measured here as one variant each. Its remaining two findings were not blocking: it could not
reproduce the single full-clock red (and confirmed every citation around it, including that
`residual.test.mjs:65` is the discarded `response.ok` assertion and that the file is absent from the
focused selection), and it disclosed an instability in one of its own four parent-export runs.

**What this round does not do.** It does not touch a production line: `shu71-production.mjs` is
byte-identical to `a51c8490`, and the whole change is one control with three legs, five mutants, the
eight committed inventory rows that move with them, and this record. It does not close that
intermittent.
