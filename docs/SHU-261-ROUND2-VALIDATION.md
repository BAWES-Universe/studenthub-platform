# SHU-261 PR 121: second-round validation

Starting HEAD: `a176aeab850072df8d27eb2320109c7ceac309b5`. Local branch:
`fix/shu-261-protected-class-and-error-preservation`.
The new commit SHA is reported separately after committing this document.
All implementation and commits are in the original clone. No push, PR write,
merge, activation, deployed checkout, production or database access was performed.

## Finding A: cleanup and exit logic

The actual shipped Bash functions and trap registrations are executed by the
new tests. Only `/usr/bin/setfacl` and `/usr/bin/flock` are command doubles.
The tests do not invoke host ACLs, host locks or systemd. Both cleanup steps run;
failures accumulate with step names and exit codes, while tool stderr remains
unredirected. A primary error retains its original stderr and exit status.
Cleanup failure alone exits 1. HUP/INT/TERM exit 129/130/143 and clean up once.
The EXIT trap is registered before the ACL grant, covering a failed grant too.

```bash
cleanup_step() {
  local step="$1" status
  shift
  if "$@"; then
    return 0
  else
    status=$?
    cleanup_failures+=("$step (exit $status)")
  fi
}

cleanup() {
  local primary_status=$? failure
  local -a cleanup_failures=()
  trap - EXIT HUP INT TERM
  cleanup_step "revoke reviewer workspace ACL" /usr/bin/setfacl -x "u:${reviewer_uid}" -- "$canonical_workspace"
  cleanup_step "release reviewer lock" /usr/bin/flock -u 9
  if (( ${#cleanup_failures[@]} > 0 )); then
    for failure in "${cleanup_failures[@]}"; do
      printf 'reviewer sandbox cleanup failed: %s\n' "$failure" >&2
    done
    if (( primary_status == 0 )); then
      printf 'reviewer sandbox failed: cleanup failed after an otherwise successful run\n' >&2
      exit 1
    fi
    printf 'reviewer sandbox primary failure retained (exit %s); cleanup also failed\n' "$primary_status" >&2
  fi
  exit "$primary_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
/usr/bin/setfacl -m "u:${reviewer_uid}:r-x" -- "$canonical_workspace"
```

## Finding B: every active wording correction

| File | Before | After |
| --- | --- | --- |
| `.github/coordinator/reviewer-sandbox.sh` | `provider-network-only` model profile | `address-family-restricted` model profile `(AF_UNIX, AF_INET, AF_INET6), with no destination allowlist` |
| `.github/coordinator/service/reviewer-isolation.mjs` | `model profile may use only ordinary provider network families` | `model profile permits AF_UNIX, AF_INET, AF_INET6; no destination allowlist` |
| `.github/coordinator/service/SHU-261-VALIDATION.md` | `the model profile retains ordinary provider network address families and receives only its own subscription OAuth value` | `the model profile permits AF_UNIX, AF_INET and AF_INET6 address families, with no destination allowlist, and receives only its own subscription OAuth value` |
| `docs/SHU-63-activation-contract.md` | `Claude's model profile keeps ordinary provider network families while the test profile remains networkless` | `Claude's model profile permits only the AF_UNIX, AF_INET and AF_INET6 address families, with no destination allowlist. The test profile remains networkless` |

The historical quotation in `.github/coordinator/service/SHU-261-REVIEW-FIXES.md:169`
remains unchanged because the task explicitly requires that file to remain
byte-identical to main. It is not a current enforcement claim. Before/after
quotations in this report likewise describe the removed wording.

Network behavior is unchanged. The exact test-profile properties remain
`PrivateNetwork=yes` and `RestrictAddressFamilies=AF_UNIX`; the model retains
`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`. The tests execute both shipped
profile branches and capture their actual systemd-run arguments. Contract checks
pin both property arrays and reject destination-filtering/proxy mechanisms in
the wrapper, plus the false provider-only wording. These checks cover the
reviewed wrapper, not arbitrary host firewall policy or mechanisms external to
it. No destination confinement or deployed-host proof is claimed.

## Added tests: 18

File: `.github/coordinator/test/shu261-cleanup-network.test.mjs`.
Finding A has 13 tests; Finding B has 5 tests. The eight cleanup matrix cases
exercise every combination of primary success/failure, revocation success/failure
and lock-release success/failure.

- `SHU261 cleanup primary=0 revoke=0 unlock=0`
- `SHU261 cleanup primary=0 revoke=0 unlock=19`
- `SHU261 cleanup primary=0 revoke=17 unlock=0`
- `SHU261 cleanup primary=0 revoke=17 unlock=19`
- `SHU261 cleanup primary=42 revoke=0 unlock=0`
- `SHU261 cleanup primary=42 revoke=0 unlock=19`
- `SHU261 cleanup primary=42 revoke=17 unlock=0`
- `SHU261 cleanup primary=42 revoke=17 unlock=19`
- `SHU261 cleanup signal HUP preserves signal status and runs once`
- `SHU261 cleanup signal INT preserves signal status and runs once`
- `SHU261 cleanup signal TERM preserves signal status and runs once`
- `SHU261 shipped profile branches pass exact network properties to systemd-run`
- `SHU261 mutation suppressed revocation dies by cleanup-only exit assertion`
- `SHU261 mutation suppressed revocation dies by reporting assertion with primary failure`
- `SHU261 model network claim pins exact families and absence of destination filtering`
- `SHU261 mutation provider overclaim dies by SHU261_NETWORK_CLAIM`
- `SHU261 mutation widened model families dies by SHU261_NETWORK_ENFORCEMENT`
- `SHU261 mutation destination filter added dies by SHU261_NETWORK_NO_ALLOWLIST`

## Mutation outcomes: 5 killed, 0 survived

Suppression changes the shipped `if "$@"; then` to `if "$@" || true; then`.
It is exercised both with and without a primary failure. Network mutations
restore the provider-only wording, add AF_PACKET, and add IPAddressAllow.
Every mutation asserts an actual ERR_ASSERTION with the expected identifier.
Observed diagnostic output:

```text
Observed ERR_ASSERTION: SHU261_CLEANUP_EXIT: preserve primary status; cleanup-only failure must fail closed
Observed ERR_ASSERTION: SHU261_CLEANUP_REPORTED: every failed step and its status must be reported
Observed ERR_ASSERTION: SHU261_NETWORK_CLAIM: address families do not confine destinations
Observed ERR_ASSERTION: SHU261_NETWORK_ENFORCEMENT: exact test isolation and model address families must stay pinned
Observed ERR_ASSERTION: SHU261_NETWORK_NO_ALLOWLIST: wrapper has no destination filtering or proxy mechanism
```

The existing SHU-239 M15 mutation keeps its name and assertion; its anchor now
removes the new revocation call, maintaining the original mutation coverage.

## Validation environment and results

Node 22.22.3. Both full suites use these additional environment settings:

```bash
TMPDIR="$PWD/docs/.v/t"
SHU251_NO_SYSTEMD=1
```

Fixtures stayed inside the clone. A temporary CommonJS package boundary in that
fixture directory preserved the normal behavior of extensionless test scripts.
The existing evidence child
`.github/coordinator/review-execution-child.mjs` was locally made non-group-writable
for its trust check (0664 to 0644), then its original mode was restored after
validation. No tracked content or executable bit changed for that file.

| Run | Total | Pass | Fail | Skip | Exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Focused new file | 18 | 18 | 0 | 0 | 0 |
| Final ordinary full suite | 1098 | 1079 | 1 | 18 | 1 |
| Shifted-clock full suite | 1098 | 1079 | 1 | 18 | 1 |
| Main reproduction of the failing test | 1 | 0 | 1 | 0 | 1 |

Commands (in addition to the common environment above):

```bash
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs" npm run test:coordinator
```

The full suites are **not green**. Their remaining failure is:
`an apparently durable path resolving onto ephemeral storage fails closed`.
Observed assertion: `a symlink must not disguise /tmp as persistent state`
(`true !== false`). This existing test assumes os.tmpdir() is under a hard-coded
ephemeral prefix. In-repo TMPDIR is not one of those prefixes. The identical
failure reproduced from origin/main's source. The unrelated assertion and
production prefix checks were not weakened, and the test was not skipped.

Before correcting local fixture setup, the first ordinary full run was
1097 total / 1068 pass / 11 fail / 18 skip. Its additional failures were the
CommonJS fixture issue and group-writable evidence-child refusals. A subsequent
run before the final network-argv test was added was
1097 total / 1078 pass / 1 fail / 18 skip. The final ordinary run below covers
all 18 added tests.

## Exact full-suite skip list: 18 in each run

- `SHU251 local kill-switch, syntax and rollback harness` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 parameterised argv and unit syntax` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 staging is idempotent and preserves original backup` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 drift requires rollback and symlinks are refused` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 invalid executable fails syntax before staging changes` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 mutation: rollback restore omitted` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 partial staging failure restores prior state` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 deployed workspace state directory accepted by installer` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 explicit workspace override stages a visible two-writer hazard` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 configured identity and external secret file survive staging` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU251 concrete merged service argv renders valid units` — SHU251_NO_SYSTEMD: systemd interaction prohibited in this window
- `SHU-227: worker owns its checkout and recovery preserves descendant commits` — requires root or passwordless sudo for distinct-uid proof
- `SHU-227: non-owner service account resolves revision with no global Git trust` — requires distinct-uid execution
- `SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches` — requires distinct-uid execution
- `SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches` — requires distinct-uid execution
- `SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity` — host cannot switch to the fixture worker uid
- `SHU-244 A10: distinct-root scoped handoff production workspace` — host cannot switch worker uid
- `SHU-71 restricted capability refusal` — production vocabulary has no undeclared runtime/role pair

Skips are not passes. Eleven use the repository's systemd-prohibition switch;
six lack distinct-uid execution; one is an inapplicable restricted-vocabulary case.

## Preservation and non-vacuity audit

- Main baseline is the available `origin/main` ref:
  `514169b7a32608bcce8603aa32304a5c165b82c8`. No local `main` ref exists;
  no fetch or update of main was performed.
- Test-name multiset: main **1062**, starting HEAD **1080**, final **1098**.
  Final minus main: **36 added, 0 lost**. This round: **18 added, 0 lost**.
  Names were collected by importing every test module with node:test registration
  intercepted, preserving dynamically generated names and multiplicities without
  running test bodies. Final registered count agrees with full-suite totals.
- Removed lines matching `assert|expect|throw` in this round: **0**.
  Therefore there are **0** replacement exceptions to adjudicate. The broader
  diff from main has **8 inherited matching removed lines** already present at
  the required starting HEAD; this round does not change them or claim that
  every historical replacement is stronger.
- The existing service_home_claude_sidecars protected class, preflight path and
  host class-directory map remain present. finalizeHostValidation remains
  byte-identical to the starting HEAD and retains primaryError as cause.
- All tracked config.json files, all workflows,
  docs/parity/organizations-stores-and-contacts.md, and
  .github/coordinator/service/SHU-261-REVIEW-FIXES.md retain their main bytes.
- Only .github/coordinator/** and docs/** are changed. SHU-140 and dispatch
  configuration are untouched.
- Shell files touched: **1**; `bash -n .github/coordinator/reviewer-sandbox.sh`
  exits **0**. POSIX shell files touched: **0**; `sh -n` is inapplicable to the
  Bash wrapper (arrays and process substitution are intentional).
- `git diff --check`: clean. Conflict markers in added content: **0**.
  Added lines were reviewed and scanned for secret patterns: **0 secret values**.

No real ACL failure or deployed network isolation was exercised. The tests prove
the shipped Bash control flow and argv at external-tool boundaries, and the
source contract; host validation remains outside this task's authorization.
