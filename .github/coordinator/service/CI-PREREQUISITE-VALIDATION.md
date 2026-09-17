# PR #135 CI prerequisite correction

Starting head: `f4695a0ab7b4815dd49db7ece79396baa6cc5ca9`.
Read `/home/bawes/work/verdict-135-r6.md`; its repository-code PASS stands.
This correction addresses the red CI environment, not the R6 code verdict.

## Evidence and choice

Read-only evidence command:

```sh
gh run view 35166307417 --repo BAWES-Universe/studenthub-platform --log-failed | grep -A 12 'not ok 256'
```

Both `fast-checks` and `coordinator-future-clock` fail the test
`SHU251 operational wrapper routes every reviewed lifecycle action without host effects`
at `host-window-bindings.test.mjs:153`. The shell reports line 25:
`exec: /usr/bin/node: not found`, status 127 instead of 0.
The complete run log shows setup-node finding Node v22.23.2 in
`/opt/hostedtoolcache/node/22.23.2/x64`, while the existing prerequisite step
successfully checks systemd-analyze and `/usr/bin/flock`. setup-node makes its
cache binary available through PATH; the wrapper's absolute exec bypasses PATH.
The log establishes that the absolute path was unavailable at execution time;
no separate runner filesystem inspection was possible in this completed run.
Each job ends with exactly one failed test and five skips.

Choose preferred option 1, providing the documented host prerequisite in CI.
`README.md`, rendered host units, and the production lifecycle command paths
establish the absolute-path convention. Changing the wrapper alone would change
that host contract while leaving other host-facing Node invocations absolute.
The only executable artifact edited is `.github/workflows/ci.yml`. In both
`fast-checks` and `coordinator-future-clock`, the existing
`Assert service verification prerequisites` step (after actions/setup-node)
resolves the runner Node, asserts it executable, links `/usr/bin/node` to it
when needed, asserts the absolute executable and equal `process.execPath`, then
retains the original systemd-analyze/flock assertion. No job or suite is removed,
no failure is ignored, and the wrapper and all test sources remain unchanged.
`coordinator-git243` runs a selected Git compatibility suite, not the service
wrapper or full coordinator suite, so its prerequisites are unchanged.

## Disposable reproduction

A minimal filesystem under `node_modules/.cache/shu251-ci-fix/missing-node-root`
contains copies of the shell, dirname, local tool-cache-style Node, their shared
libraries, and the service source. A private user namespace and chroot execute
this exact wrapper command with `/usr/bin/node` absent:

```sh
SHU251_HOST_MUTATION_APPROVED=true /home/bawes/work/shu251-executor/.github/coordinator/service/shu251-operational-bindings.sh preflight /fixture/driver.json --approved-host-mutation aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

It returns 127 and the same line-25 error. Adding the symlink only in that
disposable filesystem makes all ten actions return 0, the matching step, and
`dry_run=true`. No host `/usr/bin` was modified and no lifecycle execution was
requested. An initial diagnostic attempt omitted the approval environment for
install and correctly refused `SHU251_HOST_MUTATION_APPROVAL`; the final run
uses the same approval environment as the shipped test. Neither attempt changes
an assertion. The retained `missing-node.log` records the final differential.

Local greenness cannot prove this class of defect: of the ordinary local and
CI environments here, only CI lacks `/usr/bin/node`. The local Debian binary
masked the mismatch. Even the disposable reproduction and shell syntax check
are not proof that the edited workflow succeeds on GitHub's runner. **Proof of
the fix is CI going green at the new head after the orchestrator pushes it.**
No new-head CI result is claimed here.

## Audit of other environment assumptions

Reviewed the lane diff against base `00eb979800b5ef6dfb918b57002d167802238612`,
including host-lifecycle, production-lifecycle, phase-a-driver, the wrapper,
the four changed test files and both lifecycle fixtures; followed their calls
into host-window-bindings, host-suite-contract and service verification.

- Both wrapper exec paths require `/usr/bin/node`; the CI link covers both.
  The wrapper test is the new real shell execution. Its ten action names are
  preflight, install, start, readiness, running-gate-off, restart, host-rollback,
  pin, pin-restore, pin-retain. For each it uses `spawnSync(wrapper, ...)`, asserts
  status 0, exact `step`, and `dry_run=true`. Nine execute attempts without
  approval still assert status 2 and `SHU251_HOST_MUTATION_APPROVAL`; unknown
  actions assert 64/`SHU251_WINDOW_ACTION`, and provider overrides assert
  2/`SHU251_DRIVER_USAGE`. All remain intact and execute in the unfiltered runs.
- Production paths include `/usr/bin/{flock,git,gh,id,systemctl,ss,node}`;
  capability probes also reference setpriv, sudo, unshare, systemd-analyze,
  systemd-notify, `/bin/sh`, `/bin/bash`, and `/bin/true`. Lifecycle tests inject
  command boundaries: production-fixture records/interprets commands rather than
  launching these programs, and translates filesystem paths to disposable
  storage. Other test subprocesses use `process.execPath` where applicable.
  No second newly executed missing absolute tool path was found in this lane.
- `/usr/bin/systemd-notify` remains a real host prerequisite in
  supervisor-service and host-suite-contract. It was not introduced by this
  lane. The completed CI run's service verification harness and syntax tests
  pass in both jobs; the full CI logs contain only the wrapper failure. Locally,
  the existing 11 SHU251_NO_SYSTEMD exclusions remain necessary under the
  no-host-interaction constraint. Their local skips do not verify runner
  systemd behavior or guarantee future image contents.
- Root/service uid 1001, group ownership, `/etc`, `/srv`, `/proc`, and `/tmp`
  assumptions in lifecycle tests are modeled/translated by the fixtures.
  The wrapper dry run exits before production host effects. Existing real
  filesystem tests retain ownership/mode guards, non-root exclusions and
  temporary-directory requirements. Local suites use the established umask,
  repository permissions and private repository-backed `/tmp`; these are not
  new runner fixes. Existing distinct-UID limitations remain explicit skips.
- No L3 (`shu71-*`) file or host contract was changed. This audit found no
  additional demonstrated CI prerequisite defect; it is not a claim of live
  host acceptance or exhaustive portability. R6 residuals and A2–A7 dispositions
  remain unchanged.

## Validation

Logs and the complete archived baseline are retained locally under
`node_modules/.cache/shu251-ci-fix` (gitignored). Node v22.22.3, non-root.
Preparation: `chmod -R go-w .github/coordinator`, `umask 0002`, and
`SHU251_NO_SYSTEMD=1`. Focused and mutation runs use the cache's `tmp` directory.

```sh
node --test .github/coordinator/service/test/{host-lifecycle,production-lifecycle,phase-a-driver,host-window-bindings}.test.mjs
node --test --test-name-pattern=mutation .github/coordinator/service/test/{host-lifecycle,production-lifecycle,phase-a-driver,host-window-bindings}.test.mjs
```

The explicit mutation subset supplements the unfiltered focused and full runs;
it does not replace or narrow wrapper coverage. Full service uses
`node --test .github/coordinator/service/test/*.test.mjs`; full coordinator uses
`node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
(the complete npm test:coordinator command). Each runs inside:

```sh
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/.cache/shu251-ci-fix/full-tmp"
```

The genuine baseline is a complete `git archive` of
`00eb979800b5ef6dfb918b57002d167802238612`, extracted into `base`, with its own
`baseline-tmp` mount and the identical full coordinator command from that copy.
No branch checkout, base modification, rebase or merge is involved.

| Run | Tests | Pass | Fail | Skip | Cancelled | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Focused four files | 274 | 274 | 0 | 0 | 0 | 0 |
| Explicit mutations, four files | 118 | 118 | 0 | 0 | 0 | 0 |
| Genuine base coordinator + service | 1388 | 1369 | 0 | 19 | 0 | 0 |
| Full service | 475 | 464 | 0 | 11 | 0 | 0 |
| Full coordinator + service | 1616 | 1597 | 0 | 19 | 0 | 0 |

All five commands exit 0. The full combined glob executes every shipped
coordinator/service mutation family, beyond the 118-test explicit subset.
Passing shipped mutations does not close historical mutation survivors or claim
exhaustive mutation coverage. The wrapper test passes in the unfiltered focused,
full service and full coordinator runs. No test was narrowed or skipped to make
that happen. Base and head have the identical 19 named skip lines after removing
TAP ordinal numbers: 11 pre-existing systemd prohibitions plus eight existing
non-root/distinct-UID exclusions. Sorted normalized skip SHA-256:
`da2dad94fbc8f6246141f5cdbf2a57525c19831f023e0aeb2b0ff64f82aa6cbe`.

Wrapper blob remains `ed905d66e188af5ee0bf50cc5a212c57bf51553f`.
`host-suite-contract.mjs`, including PERMITTED_SKIPS, remains SHA-256
`37e8824a22c5bf5c7313305dcb3ca551dd917212f8dff00503dd092e70a3971f`.
All test sources and production files are byte-identical to the starting head.

| Retained local log | SHA-256 |
| --- | --- |
| focused.tap | 3765d9c638789c2ebd32c63dc83824ca507033e4c29e1ba9be809f73b477e2c3 |
| mutations.tap | e12374b2924f93d99875588193dade93de0293872c5bdb047c35207947d1eb82 |
| baseline.tap | 1fcb44499aff6b679916280c98665361ba91f113f44143732e7961e8d0d06e95 |
| service.tap | b635c8352c46704127d6ed66e00add4684d0a083ce02cbf3927030a2b99ae54d |
| full.tap | 3e9dd10cf50ac7e09a43276aba92cd4060fab9d0b622be45a06759e76a056c77 |


The workflow YAML parses; both prerequisite steps follow setup-node and precede
the complete suite. Both shell blocks are identical and pass `bash -n`. No assertion,
guard, refusal code, skip allowance or production source was edited. No push,
PR change, GitHub/Linear comment, or real-host installation, service operation,
activation, signing, reseeding or dispatch was performed. Unrelated application
suites and new-head CI were not run. Final commit SHA is reported on delivery.
