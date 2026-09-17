# Reviewed production lifecycle provider — current L1 correction

The shipped CLI constructs the real provider; tests replace only filesystem,
command, time and wait boundaries. Production uses fixed absolute argv and no
operator command substitution. All test commands are interpreted by the fixture;
none are forwarded to systemd, Git remotes, GitHub or a host credential store.

The current amendment results are in [R3-AMEND-VALIDATION.md](R3-AMEND-VALIDATION.md).
The current behavioral contract and remaining blockers are in
[HOST-LIFECYCLE.md](HOST-LIFECYCLE.md). Do not use historical round-2 results below
to claim this correction closes every consolidated finding.

## Owner approval artifact

The owner must provision `/etc/shu/approvals/owner.pub` (root:root 0644, public PEM)
and `/etc/shu/approvals/<activation_id>.json` (root:root 0600). Both must be regular,
non-hardlinked files beneath canonical non-symlink, non-group/world-writable
ancestors. The driver consumes these files; it has no signing operation or CLI key
selection. Root/key provisioning remains an external authority prerequisite.

The JSON envelope has exactly `payload` and `signature`. Signature is base64 over
the canonical JSON payload and is verified with Node's `verify(null, ...)`; tests
use disposable Ed25519 owner keys. The payload has exactly:

- `version`: `shu251-owner-approval-v1`.
- `spec_sha256`: SHA-256 of canonical complete driver spec with only
  `lifecycle.approval_sha256` removed, avoiding a circular digest.
- `not_before`, `expires_at`: integer epoch milliseconds, an ordered interval.
- `operations`: exact ordered lifecycle action names, excluding `preflight`.
- `teardown`: `restore` or `retain`.

`lifecycle.approval_sha256` must equal SHA-256 of the exact envelope bytes. Thus
window revision, approved tree, activation ID, real checkout baseline, paths,
rendered digests and all other spec fields are authenticated together. Existing
window-spec consistency and CLI mutation-approval checks remain enforced.
Cleanup authority is allowed after expiry and out of forward order; it remains
restricted by authenticated spec, journal binding, rollback safety and teardown
policy. No implicit admission, signing, activation or expiry scheduler is added.

The evidence root must already exist, root-owned and safe. The provider creates
the activation directory (0700), `journal.lock`, `manifest.json`, `journal.json`
and `archive.json` (0600); preflight has its own durable `preflight.json`. Evidence creation and file/parent fsync failures cannot
acknowledge success. Journals and archives are digested, not signed. Approval
signatures must not be described as signed execution receipts.

## Checkout and service boundary

Git trust retains the existing exact-checkout `safe.directory` setting; no global
trust or additional safe directory is installed. Pin reads exact remote main and
API commit/tree, fetches the immutable object without updating refs or FETCH_HEAD,
checks the tree, and uses a transaction with expected old main/origin-main plus
HEAD verification. The approved HTTPS repository and API endpoint are fixed.
The API command receives only the narrow command environment plus GH_TOKEN from
the production boundary; its provisioning and least-privilege scope are not proved
by these local tests. Ref objects fetched into the object store are not removed
on restore. The activation ref remains separate from real checkout custody.

Journal custody spans all lifecycle effects. The writer descriptor is released
and reacquired when the coordinator must own it, including timer observation.
For the entire readiness/restart step the provider acquires only journal custody,
so network preflight and evidence finalization cannot conflict with scheduled ticks. Service-identity capability probes use the service-owned
workspace-state directory for disposable probes, not the root-only evidence
directory.
Tick success requires exit 0; systemd's accepted lock-conflict exit 2 is refused.
Service readiness checks UID/GID/groups, socket/listener PID, service status,
committed/runtime gates and invocation without an acceptance worker. Worker and
authenticated transport observations remain required by restart acceptance.

Directory descriptors, no-follow file operations, destination identity checks,
exact byte/mode/owner restoration, private staging and existing error vocabulary
remain. Rollback's modeled equality must not be described as full host equality.

## New named codes and killing mutations

Every row runs a successful control, perturbs one condition, syntax-checks the
mutant, and requires exactly one assertion failure containing `CODE_REQUIRED`.
The named mutation removes only that code's guard family. Existing mutation
families and their assertions remain in the suite.

| New code | Killing mutation test |
| --- | --- |
| `SHU251_APPROVAL_BINDING` | `PROVIDER named mutation SHU251_APPROVAL_BINDING` → `SHU251_APPROVAL_BINDING_REQUIRED` |
| `SHU251_APPROVAL_CUSTODY` | `PROVIDER named mutation SHU251_APPROVAL_CUSTODY` → `SHU251_APPROVAL_CUSTODY_REQUIRED` |
| `SHU251_APPROVAL_DIGEST` | `PROVIDER named mutation SHU251_APPROVAL_DIGEST` → `SHU251_APPROVAL_DIGEST_REQUIRED` |
| `SHU251_APPROVAL_ORDER` | `PROVIDER named mutation SHU251_APPROVAL_ORDER` → `SHU251_APPROVAL_ORDER_REQUIRED` |
| `SHU251_APPROVAL_SIGNATURE` | `PROVIDER named mutation SHU251_APPROVAL_SIGNATURE` → `SHU251_APPROVAL_SIGNATURE_REQUIRED` |
| `SHU251_APPROVAL_TEARDOWN` | `PROVIDER named mutation SHU251_APPROVAL_TEARDOWN` → `SHU251_APPROVAL_TEARDOWN_REQUIRED` |
| `SHU251_APPROVAL_TIME` | `PROVIDER named mutation SHU251_APPROVAL_TIME` → `SHU251_APPROVAL_TIME_REQUIRED` |
| `SHU251_CHECKOUT_BASELINE` | `LIFECYCLE named mutation SHU251_CHECKOUT_BASELINE` → `SHU251_CHECKOUT_BASELINE_REQUIRED` |
| `SHU251_CHECKOUT_CAS` | `PROVIDER named mutation SHU251_CHECKOUT_CAS` → `SHU251_CHECKOUT_CAS_REQUIRED` |
| `SHU251_CHECKOUT_EFFECT` | `LIFECYCLE named mutation SHU251_CHECKOUT_EFFECT` → `SHU251_CHECKOUT_EFFECT_REQUIRED` |
| `SHU251_CHECKOUT_REMOTE` | `PROVIDER named mutation SHU251_CHECKOUT_REMOTE` → `SHU251_CHECKOUT_REMOTE_REQUIRED` |
| `SHU251_CHECKOUT_RESTORE` | `LIFECYCLE named mutation SHU251_CHECKOUT_RESTORE` → `SHU251_CHECKOUT_RESTORE_REQUIRED` |
| `SHU251_CHECKOUT_TREE` | `PROVIDER named mutation SHU251_CHECKOUT_TREE` → `SHU251_CHECKOUT_TREE_REQUIRED` |
| `SHU251_CHECKOUT_TUPLE` | `LIFECYCLE named mutation SHU251_CHECKOUT_TUPLE` → `SHU251_CHECKOUT_TUPLE_REQUIRED` |
| `SHU251_EVIDENCE_ARCHIVE` | `LIFECYCLE named mutation SHU251_EVIDENCE_ARCHIVE` → `SHU251_EVIDENCE_ARCHIVE_REQUIRED` |
| `SHU251_PROVIDER_CHECKOUT` | `PROVIDER named mutation SHU251_PROVIDER_CHECKOUT` → `SHU251_PROVIDER_CHECKOUT_REQUIRED` |
| `SHU251_PROVIDER_GATE_OFF` | `PROVIDER named mutation SHU251_PROVIDER_GATE_OFF` → `SHU251_PROVIDER_GATE_OFF_REQUIRED` |
| `SHU251_PROVIDER_TICK` | `PROVIDER named mutation SHU251_PROVIDER_TICK` → `SHU251_PROVIDER_TICK_REQUIRED` |
| `SHU251_RUNNING_GATE_OFF` | `LIFECYCLE named mutation SHU251_RUNNING_GATE_OFF` → `SHU251_RUNNING_GATE_OFF_REQUIRED` |

## Historical L1 repository-only verification record (head `5a3c956`, 2026-09-17)

Base: `885914c22f26b279e6c29b088e4c46d44037759c`, branch
`fix/shu251-typed-host-lifecycle-executor`. Authorship: this Codex correction;
no independent exact-head verdict is claimed. FINAL_HEAD is reported after the
local commit. **The overall L1 verdict remains BLOCKED**, as detailed in
[HOST-LIFECYCLE.md](HOST-LIFECYCLE.md#finding-disposition-and-unsupported-claims).

All runs used `chmod -R go-w .github/coordinator` and `umask 0002`. No existing
skip allowance or assertion was removed. The final source adds 45 tests:
19 guard controls, 19 named killing mutations, and seven composition/recovery
cases. Existing named errors, worker-adoption guards and mutation assertions
remain. The explicit mutation-only run includes the existing binding/driver
mutations as well as every lifecycle/provider mutation. The full combined run
also executes the other coordinator and service mutation suites.

| Run | Tests | Pass | Fail | Skip | Cancelled | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Base service | 397 | 397 | 0 | 0 | 0 | 0 |
| Base combined coordinator + service | 1538 | 1530 | 0 | 8 | 0 | 0 |
| Final focused four test files | 241 | 241 | 0 | 0 | 0 | 0 |
| Final explicit mutation-only four test files | 105 | 105 | 0 | 0 | 0 | 0 |
| Final service | 442 | 442 | 0 | 0 | 0 | 0 |
| Final combined coordinator + service | 1583 | 1575 | 0 | 8 | 0 | 0 |

Exact commands (each redirected to the corresponding retained TAP log):

```sh
node --test .github/coordinator/service/test/host-lifecycle.test.mjs .github/coordinator/service/test/production-lifecycle.test.mjs .github/coordinator/service/test/phase-a-driver.test.mjs .github/coordinator/service/test/host-window-bindings.test.mjs
node --test --test-name-pattern=mutation .github/coordinator/service/test/host-lifecycle.test.mjs .github/coordinator/service/test/production-lifecycle.test.mjs .github/coordinator/service/test/phase-a-driver.test.mjs .github/coordinator/service/test/host-window-bindings.test.mjs
node --test .github/coordinator/service/test/*.test.mjs
npm run test:coordinator
```

The eight combined-suite skip **names and reasons match the base exactly**;
service/focused/mutation runs have no skips. No skip was added, renamed or relaxed:

- READER operator-owned checkout read by non-root account — Not exercisable: non-root account, no passwordless elevation to create root-owned checkout
- SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches — requires distinct-uid execution
- SHU-227: non-owner service account resolves revision with no global Git trust — requires distinct-uid execution
- SHU-227: worker owns its checkout and recovery preserves descendant commits — requires root or passwordless sudo for distinct-uid proof
- SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches — requires distinct-uid execution
- SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity — host cannot switch to the fixture worker uid
- SHU-244 A10: distinct-root scoped handoff production workspace — host cannot switch worker uid
- SHU-71 restricted capability refusal — production vocabulary has no undeclared runtime/role pair

Changed files (all within the L1 implementation, associated fixtures/tests and documentation):

- `.github/coordinator/service/HOST-LIFECYCLE.md`
- `.github/coordinator/service/PRODUCTION-LIFECYCLE.md`
- `.github/coordinator/service/host-lifecycle.mjs`
- `.github/coordinator/service/phase-a-driver.mjs`
- `.github/coordinator/service/production-lifecycle.mjs`
- `.github/coordinator/service/shu251-operational-bindings.sh`
- `.github/coordinator/service/test/host-lifecycle.test.mjs`
- `.github/coordinator/service/test/host-window-bindings.test.mjs`
- `.github/coordinator/service/test/lifecycle-fixture.mjs`
- `.github/coordinator/service/test/phase-a-driver.test.mjs`
- `.github/coordinator/service/test/production-fixture.mjs`
- `.github/coordinator/service/test/production-lifecycle.test.mjs`

Retained local logs under `node_modules/.cache/shu251-l1/` (untracked):

| Log | SHA-256 |
| --- | --- |
| `l1-base-service.tap` | `4a460ae23dee5649f67cc12fee1b7fa9cc1da5c1813969529ded86386dd397e4` |
| `l1-base-coordinator.tap` | `7c3badd75b9689a2613b8179a5796eb1758392ff53ad5d57f875b95c9cc9e926` |
| `focused.tap` | `424a551f9873c26cee9141cc37ac4cb8abeefcf6c1b1a768b085d805b7f5b564` |
| `mutations.tap` | `c56b1fbf2f3139a05f5cc682acf244c3be137644b490dceb0d0f1d11c7b9e0cd` |
| `service.tap` | `5d1284f5cc75d56d50302661d8061997261dfad90dc131703afea9c2d08259f5` |
| `coordinator.tap` | `c17df6411b08cb576059aedd00acda5bd07ad4f94d66c7e2e8d0fcaa5eddc24b` |

The seven new `CLOSURE` cases execute the production provider through recorded
boundaries where applicable: fresh worker-free readiness/split metadata; stale
and detached checkout restore/retain; before/after Git-command interruption with
provider reconstruction; dirty/drift/tree/fetch refusal; stopped/timer/write/child
rejection; evidence creation/expiry/absent-archive reconstruction; aggregate cleanup
with forward eligibility unavailable. Prior per-effect and per-journal-save matrices
continue to run. This does **not** establish failure recovery at every new evidence
creation/archive syscall or expiry enforcement at every individual effect boundary.
An approval is checked before the action, not continuously throughout it.

No real host, live service manager, credential store, remote repository or external
API was accessed by the new tests. No real owner key was used; only disposable test
approval envelopes were signed. No push, PR, merge, GitHub/Linear comment, reseed,
activation or dispatch occurred. No independent verifier, real-host acceptance,
complete A6 cleanup inventory, remote-authoritative write proof, or physical-expiry
teardown is claimed. Those gaps keep this commit out of any approval/activation
closure packet marked PASS.

## Round-2 verification record (2026-09-16)

Implementation/test commit: `2f911d2b99fb15e5f4a32e12c82519f0d02af98e`.
The subsequent evidence-only commit changes this document. The full coordinator
source tree was compared byte-for-byte with the tested depth-1 clone before
appending this record. Base was `ab6c634b` on the same branch.

| Run | Tests | Pass | Fail | Skip | Cancelled / Todo |
| --- | ---: | ---: | ---: | ---: | ---: |
| Base complete coordinator + service | 1489 | 1481 | 0 | 8 | 0 / 0 |
| Focused lifecycle + driver + production provider | 183 | 183 | 0 | 0 | 0 / 0 |
| Complete coordinator + service | 1536 | 1528 | 0 | 8 | 0 / 0 |
| Depth-1 clone, complete coordinator + service, clock +1 year | 1536 | 1528 | 0 | 8 | 0 / 0 |

Focused tests include **74 named mutation tests**: 37 existing lifecycle,
12 existing Phase-A, 20 provider (14 guard families including reused privilege,
three durability/lock mutations and three entrypoint mutations), and five routing.
All 74 permitted controls pass and all 74 syntax-clean mutants are killed by their
named assertions, with zero survivors. Every coordinator/service test file,
including all other mutation suites, ran in both complete runs. No new skip was
introduced and `PERMITTED_SKIPS` is unchanged.

An earlier focused iteration had 175 tests, 174 passes and one failure: the new
overlap mutation matched its own mutation string as well as the intended source.
The unique-match assertion detected this harness defect; it was corrected before
the final successful runs. No production or existing test assertion was relaxed.

Exact base/full/shallow skip profile (names and reasons compared, not just counts):

- SHU-227: worker owns its checkout and recovery preserves descendant commits — requires root or passwordless sudo for distinct-uid proof
- SHU-227: non-owner service account resolves revision with no global Git trust — requires distinct-uid execution
- SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches — requires distinct-uid execution
- SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches — requires distinct-uid execution
- SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity — host cannot switch to the fixture worker uid
- SHU-244 A10: distinct-root scoped handoff production workspace — host cannot switch worker uid
- SHU-71 restricted capability refusal — production vocabulary has no undeclared runtime/role pair
- READER operator-owned checkout read by non-root account — Not exercisable: non-root account, no passwordless elevation to create root-owned checkout

All temporary storage and clones are beneath this checkout. Suites use a private
user/mount namespace to bind repository storage over `/tmp` and then drop retained
capabilities, as in the original validation. Before suites:

```sh
chmod -R go-w .github/coordinator
umask 0002
```

Focused command:

```sh
TMPDIR="$PWD/node_modules/t" node --test \
  .github/coordinator/service/test/host-lifecycle.test.mjs \
  .github/coordinator/service/test/phase-a-driver.test.mjs \
  .github/coordinator/service/test/production-lifecycle.test.mjs
```

Complete command:

```sh
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/t"
```

Base ran the same complete command in a repository-local archive of `ab6c634b`.
The shallow clone was made with:

```sh
git clone --depth 1 --single-branch \
  --branch fix/shu251-typed-host-lifecycle-executor \
  "file://$PWD" node_modules/shu251-round2-shallow
```

It reported `--is-shallow-repository=true` and only this branch plus its origin
tracking ref/HEAD; no main ref existed. Its complete run used:

```sh
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && cd "$2" && TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$2/.github/coordinator/test/fixture/shift-wall-clock.mjs" setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/u" "$PWD/node_modules/shu251-round2-shallow"
```

Local TAP logs are retained in `node_modules/.cache/shu251-round2/` (untracked):

| Log | SHA-256 |
| --- | --- |
| `base.log` | `b2d85fd818fbd68b3d84bdf6afeac46a7b313ea429d18ad35db60ac83e938cf6` |
| `focused.log` | `f3ab6c795ca3e96bc8d0b2e8522a1ab44129398f0fe0a76e8d97734765fdc9bb` |
| `full.log` | `8515a63cac87a6dc117bb036ccf817b8ab48efa1dc8882e0ed8f513b71c8c5b4` |
| `shallow-future.log` | `c1835c0250836bf48196d9310eb4c62973555db53344fe646a5db8363b23ac15` |
