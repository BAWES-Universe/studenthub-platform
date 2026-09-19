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
[operative unit render](shu71-production.mjs#L663). Real kernel socket access
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
([start](shu71-production.mjs#L349), [stop](shu71-production.mjs#L607)).

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
finishes it. Without that receipt the pre-condition would refuse a pair this
teardown had itself half-removed. The reviewed teardown effects set and its
order are unchanged; `PERMITTED_SKIPS` is byte-identical.

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

The focused selection is unchanged from the previous lane; every file this
correction touches is already in it. The full selection is
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
