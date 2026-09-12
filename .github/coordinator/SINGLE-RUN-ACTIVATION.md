# Single-run host activation (SHU-63)

Dispatch has always required two gates in different layers:

1. the **committed** flag — `config.json` → `enable_dispatch` (false by default, and
   asserted false by this repo's own suite), and
2. the **runtime** switch — `ENABLE_DISPATCH=true` in the environment.

Neither alone arms anything. That contract is not weakened here: the committed flag
stays `false`, and the assertions that pin it stay exactly as they were
(`eligibility.test.mjs`: *"the fixture lane is a lane, never an activation"*;
`shu224-dispatch-scope.test.mjs`: *"committed scope is pinned … while dispatch stays
disabled"*).

What was missing is any way to authorize **one bounded run** without changing the
committed gate. That is what stopped the approved live fixture at launch:
`SUPERVISOR.md` already names the requirement — *"Live activation requires a
separately reviewed host service configuration and rollback plan"* — and no such
mechanism existed. This is that mechanism.

## What it is

An operator-owned, host-local, single-use **activation record**: a small JSON file
outside the repository, presented on the command line.

```bash
node .github/coordinator/reconcile.mjs --activation /srv/shu/state/single-run-activation.json
```

The record is a capability declaration, not a secret. It never travels through
Linear, GitHub, or any card.

## The record

The required keys below, plus the reviewed optional `reviewer_lane` and
`initial_target_sha` keys. A missing required key **and** an unreviewed extra key are both refused —
a configuration surface nobody reviewed is how scope creep enters security code.

```json
{
  "activation_id": "shu63-fixture-run-0001",
  "target_issue_id": "SHU-<n>",
  "authorization_ref": "FIXTURE-<CONTRACT-REF>",
  "coordinator_revision": "<40-char git sha>",
  "slots": 1,
  "expires_at": "2026-09-10T13:00:00.000Z"
}
```

| Field | Binding | Refused when |
| --- | --- | --- |
| `activation_id` | audit identity of this one authorization | not 8–64 chars of `[A-Za-z0-9_-]` |
| `target_issue_id` | must be **the single issue the committed `dispatch_scope` already allows** | it names any other card, or the committed configuration is board-wide |
| `authorization_ref` | must equal the lane's approved contract reference when the committed configuration carries one | it names a different contract |
| `coordinator_revision` | must equal the revision of the checkout **being executed**, resolved from git (never self-declared) | mismatch, or the revision cannot be resolved |
| `slots` | must be exactly `1` **and** equal the committed `max_dispatch` | it declares more capacity than the committed configuration |
| `expires_at` | must be in the future and **within 24h** | expired, unparseable, or reaching further than a day |
| `initial_target_sha` (optional schema key; required for the next watched fixture's approval) | approved original worker input; must equal `DISPATCH_TARGET_SHA` on every tick | malformed, omitted operator input, or mismatch |

Set `initial_target_sha` to the approved seeded-defect commit when preparing the
next fixture's activation record. The same original value remains the second
argument to `host-tick.sh` on every tick; never replace it with a builder's output.
Successor heads come from verified receipts and may advance independently. Records
without this optional field retain their previous semantics; they do **not** prove
input approval. A first-dispatch candidate cannot override a supplied binding.

File integrity is part of the binding: the path must be a regular file (not a
symlink, not a directory), and must not be group/world writable or world readable
(`0600` or `0640`; `0644`, `0660`, `0604` are all refused).

## What it can never do

* **It cannot substitute for the runtime switch.** `ENABLE_DISPATCH=true` is still
  required, so a forgotten activation file on disk arms nothing by itself.
* **It cannot widen the board.** The bound target must be the single card the
  committed `dispatch_scope` already permits; an activation can never select a card
  the committed configuration would not have selected.
* **It cannot raise capacity.** `slots` must be `1` and must match the committed
  `max_dispatch`.
* **It cannot be replayed.** It expires, and it is spent once the bound target's
  episode ends.

## One use is one *episode*, and the episode's end is derived, not assumed

The approved run contract is build → exact-head BLOCK → return to the writer →
same-branch revision → automatic re-review → PASS. So "one claim ever" would stall
the loop this exists to authorize — and so would spending the activation on **any**
terminal receipt, because the loop's own steps produce them
(`terminalVerdictCoherent` in `reconcile.mjs`):

| verdict | durable stage |
| --- | --- |
| `BUILD_READY` | `COMPLETED` |
| `REVISION_READY` | `COMPLETED` |
| `BLOCKED` | `HOLD` |
| `PASS` | `COMPLETED` |

One use therefore means one **episode**, and the episode's **end** is decided from
the existing routing semantics (`routeSuccessorFromReceipts`, `outcomeForEvidenceStage`),
never from a receipt stage:

**The episode ENDS when**

* a review **PASS** verdict lands — the loop is complete; or
* **revision rounds are exhausted** (`review_round > max_revise`); or
* **retryable failures reach `max_failed_attempts`** — the same cap the selector
  uses to park an issue; or
* the routing refuses on a **contradiction in the durable facts** that needs a
  human: a verdict from the wrong lane, an unexpected outcome, a forged/stale head,
  a role that cannot be routed.

**The episode CONTINUES while**

* a successor is routable: a review order after `BUILD_READY`/`REVISION_READY`, a
  revise order after a routable `BLOCKED`; or
* the routing cannot yet *name* the next actor — no eligible reviewer, no active
  writer, a lineage without provenance, an unknown worker lane. **These do not spend
  the authorization.** They are availability or lineage gaps, not endings, and
  spending here would kill a loop that is still in flight. The activation is bounded
  instead by its expiry, its target, its revision, one slot, and the runtime switch.

Attempts inside the episode stay bounded exactly as before (`max_failed_attempts`,
`max_dispatch`). Once the episode ends, the same activation can never arm anything
again — the next invocation refuses with `activation is spent: the episode … ended`.

*Why this is spelled out so precisely:* the first revision of this mechanism spent
the authorization on any `COMPLETED`/`HOLD` receipt, which is the builder's own
success — so the review step could never be dispatched and every later tick
hard-refused. It was caught in independent review, not by the suite, and the
multi-tick regression below now pins the whole sequence.

## Fail-closed summary

A refused activation is **not** a quiet dry run. It prints the report, prints
`dispatch: PREVENTED — single-run activation REFUSED (<reason>); no fallback, no
writes`, and exits **2** with zero writes. Missing, malformed, stale, replayed,
wrong-target, wrong-revision, over-capacity, over-long, over-permissive: all refuse.

## Operator procedure

```bash
# 1. Write the record where the coordinator service account can read it.
#    Must not be group/world writable or world readable (0600 or 0640).
install -m 0640 -o root -g shu-coordinator \
  /tmp/single-run-activation.json /srv/shu/state/single-run-activation.json

# 2. Launch ONE tick with the runtime switch, naming the record AND the initial
#    lane head (40 hexadecimal characters, verified against the seeded branch).
#    This is the worker INPUT head, not coordinator_revision.
sudo -u shu-coordinator -H env ... ENABLE_DISPATCH=true \
  bash /srv/shu/studenthub-platform/.github/coordinator/host-tick.sh \
  /srv/shu/state/single-run-activation.json "$DISPATCH_TARGET_SHA"

# 3. Inspect the first lines: it must read activation=ARMED with the expected id,
#    target, contract ref, revision and expiry. Anything else is a refusal.

# 4. After the episode ends, or to stop early, remove the record and stop passing
#    the flag. Both gates then behave exactly as before.
rm -f /srv/shu/state/single-run-activation.json
```

### Attempt workspace preparation (SHU-227)

Provision the **directories and permissions** during reviewed host setup; leave
the workspaces empty. Do not hand-create a worker checkout. Set:

* `SHU_WORKTREE_ROOT`: real absolute directory, traversable/writable by the
  coordinator and the configured writer identity. Use a dedicated shared group
  and sticky/setgid directory mode (for example 3770); do not expose the root to
  unrelated users. The worker launcher must retain that shared supplementary
  group. Every generated attempt directory is mode 0750, never world-readable.
* `SHU_WORKSPACE_STATE_DIR`: separate real absolute directory owned by the
  coordinator, mode 0700, outside the workspace root. Keep it across ticks.
* `SHU_PUSH_REMOTE_URL`: the approved repository URL, also used by the host to
  fetch the input commit. Only host-side Git receives fetch/push credentials.
* `SHU_WORKER_UID` and `SHU_WORKER_LAUNCH_WRAPPER`: the existing distinct writer
  identity. The wrapper must support the noninteractive Git commands used for
  preparation as well as Codex launch. Test its effective uid and directory access
  during host setup; naming an arbitrary wrapper is not proof it works.
* `SHU_REVIEW_EVIDENCE_DIR`: a durable coordinator-owned directory outside all
  attempt checkouts, mode 0700. Raw Claude stdout and confined test reports are
  append-only 0600 artifacts here; terminal receipts carry their `file:`
  references. A failed write is logged but never destroys a valid verdict or
  falsely claims retention.
* `SHU_REVIEW_EXEC_UID`: the numeric uid of a distinct, unprivileged
  `shu-reviewer` account. Under selected option **B-ii**, the Claude process and
  its read-only checkout stay control-plane-owned (root or the coordinator uid,
  never the reviewer uid), while every execution of builder-authored test code
  crosses this uid boundary.
* `SHU_REVIEW_EXEC_WRAPPER_JSON`: a JSON argv array for the root-owned confinement
  wrapper, for example
  `["/usr/bin/sudo","-n","/usr/local/libexec/shu-reviewer-sandbox"]`.
  Install the reviewed `reviewer-sandbox.sh` at that path, root-owned and not
  group/world writable, with a command-specific sudo rule. Symlinked system
  entrypoints are resolved once; their root-owned, non-writable executable target
  and directory chain are validated, and the canonical target is what executes.
  Install the host `acl` package: the wrapper grants `shu-reviewer` `r-x` on only
  the bound attempt for the lifetime of the sandbox and removes that ACL in its
  exit trap. A pre-existing reviewer ACL is refused rather than silently reused.
* `SHU_REVIEW_TEST_FILES_JSON`: a JSON array of 1–32 safe relative test paths.
  For SHU-140 this is
  `["tools/fixture/test/scan-vacuous.test.mjs"]`; no shell or glob expansion is
  used.

The confinement wrapper is not accepted on configuration alone. In the same
sandbox invocation that runs `node --test`, a root/coordinator-owned,
non-writable child checks the effective uid, tries and must fail to read a fresh
0600 coordinator sentinel,
tries and must fail to read a fresh readable canary in a sibling workspace,
tries and must fail to reach a live loopback listener, and rejects any
credential-bearing environment key. The test process starts only after all five
checks pass. The wrapper binds systemd's working directory to the canonical
attempt and masks every sibling in the transient mount namespace. A missing or ineffective wrapper produces
`REVIEW_EXECUTION_UNAVAILABLE` and HOLD; it can never produce PASS. The report
records the effective execution uid, workspace-owner uid, exact bound head and
test output. Claude itself runs with only `Read`, `Glob`, and `Grep` tools in
restricted evaluation mode; subscription OAuth remains available, ambient
settings, CLAUDE.md, hooks, skills, commands, plugins and subagents are disabled,
and file tools are confined to the exact working directory. Strict MCP
configuration plus an explicit `mcp__*` denial removes MCP tools. The private
evidence URI remains machine provenance only; the coordinator includes the
credential-scanned confined report inline so restricted mode is never asked to
read outside the exact checkout. Reviewer callbacks may cite HTTPS evidence or
canonical existing files only inside that checkout or the private evidence root;
symlinks, traversal and every other local path fail binding. Claude cannot
execute the target.

After the existing durable reservation and launch intent, the coordinator fetches
the bound commit in a fresh host-owned bare repository, creates a self-contained
Git bundle and lets the worker clone that data file. This avoids the foreign-owned
`upload-pack` child whose inherited trust Git 2.43 rejects. No source ownership
change or protected/global trust configuration is needed. It copies objects locally
into `<SHU_WORKTREE_ROOT>/<attempt_uuid>` and checks out the exact detached head.
These are **independent repositories**, not linked worktrees: a builder must not
be able to edit the coordinator's shared Git metadata. Writer preparation runs
through the existing privilege-drop wrapper. Under SHU-232 B-ii, verifier
preparation stays coordinator-owned, but the verifier is read-only and
builder-authored tests run only through the actively probed `shu-reviewer`
sandbox above. No worker receives a push remote. This closes the watched-fixture
execution coupling identified after PR #70; SHU-86 still governs broad activation
and any future expansion of reviewer capabilities.
The temporary source contains repository objects (no credentials), is made
readable for the local copy, and is removed after preparation.

### SHU-241: scoped builder source and base-preserving publication

The watched SHU-140 builder never receives the review trap's blob. Trusted
`fixture_lane` configuration pins two exact literal path arrays: the initial
build paths and a predeclared revision superset. The seeded defect path is
required to be outside the initial set and inside the revision set; otherwise
dispatch refuses before reservation. Globs, directories, traversal, `.git`,
duplicates and non-normalized paths are not scope authority.

For a scoped build, the coordinator first saves the complete exact target as a
private 0600 base bundle. It then deterministically writes a parentless scoped
base commit whose tree contains only the authorized ordinary files. The commit
message binds the authoritative full `target_sha` and the exact ordered path
manifest, and fixed coordinator identity and timestamps make its
`scoped_base_sha` independently recomputable. The worker receives only that
commit through the existing local bundle transport. The bundle origin and
temporary source are removed before launch, so neither hidden blobs, the full
target commit, nor hidden path names reach the worker object store.

Publication starts the host-owned index at the complete bound base tree, imports
that base only from the private bundle, and overlays or deletes only authorized
paths. Thus hidden paths remain byte-identical base entries instead of
becoming deletions. Before result binding, pre-push recording or any remote
operation, the broker recursively inspects the real worktree and refuses any
materialized path outside the exact allowance with `RESULT_SCOPE_REFUSED`.

The revision superset is unlocked only by an independently validated `BLOCK`
against the exact builder result on the same branch and routes back to the same
Codex writer. Failure, stale or wrong-head review, another writer, or another
branch cannot widen it. The authoritative `target_sha`, derived
`scoped_base_sha`, scope phase and exact paths are immutable receipt and
attempt-authority fields; directives carry the full target and exact manifest,
then the coordinator derives the scoped SHA before reservation. The scoped SHA
never replaces the full target in routing, review or broker authority. Reviewers
always receive a complete reconstructed exact-head repository, and scoped
reviewer launch is refused.

Each successor gets its own checkout at the routed output head. Both adapters
receive the actual prepared `cwd`; legacy `CODEX_WORKTREE_PATH` and
`CLAUDE_WORKTREE_PATH` do not select production launch directories anymore.
Recovery validates the existing attempt binding and never resets or recreates a
running checkout. A valid writer descendant is preserved; a mismatched manifest,
symlink, unexpected owner, interrupted preparation or missing recovery workspace
HOLDs for inspection. Retain workspace/receipt evidence on failure. Do not delete
receipts to reset retry budgets as part of this implementation.

`host-tick.sh` requires the bound initial head and a runtime gate that is already
on, then locks the private state directory for the entire tick. Repeat only this
single driver command; it does not grant activation. Stop the driver on HOLD or
refusal. Scope, capacity and activation checks remain in `main()`; the script is
not a second dispatcher. It never changes the host's Git trust configuration.
Preparation failures record fixed diagnostic codes (ownership refusal, access
denied, unavailable revision/source, storage full, timeout or generic failure).
Raw Git/SSH stderr and credential-bearing URLs are never copied into receipts.

The Codex callback schema is static public data in its own coordinator-owned
temporary directory (0755/file 0644). Session receipts stay private. This allows
the distinct worker uid to read the schema without gaining access to session
authority. The directory is cleaned up after the CLI returns.

### SHU-228: host-created worker results

The Codex launch explicitly selects `gpt-5.6-sol` and sets
`sandbox_workspace_write.network_access=false`; Claude explicitly selects `opus`.
These arguments also apply on resume. Confirm the installed CLIs accept these
options and report the expected model on the host; contract tests inspect the
arguments but do not spend subscription usage or establish account availability.
Model aliases/worker labels are not evidence of the model actually used.

The builder edits and tests files, then returns `result_sha: null` with
`BUILD_READY` or `REVISION_READY`. It must stop writing before returning. The
host validates the attempt/head callback before invoking the existing broker.
The broker reads ordinary tracked and non-ignored untracked files without
following symlinks, stages raw bytes in its own index, and creates a commit with
one parent: the bound target SHA. It never writes the worker HEAD, index or object
store. Valid legacy callbacks naming a worker-created commit remain supported.

Commit identity is deterministic: a fixed coordinator author/committer,
`2000-01-01T00:00:00Z` author/committer dates, an attempt-specific message and the
exact tree/parent. Use receipt timestamps for run timing, not this synthetic
commit date. The host fsyncs an immutable `workspace-result-<attempt>.json` binding
before publication. Retry reconstructs the same SHA; different files, target,
branch or repository refuse rather than replace the binding. A second snapshot
detects changes observed between passes. This is bounded consistency checking,
not a claim that two reads can detect every malicious concurrent writer; the
published commit always contains only the captured bytes, never later edits.

Current limits: Linux `/proc/self/fd`; 20,000 files; 64 MiB per file and 256 MiB
total. Symlinks, hardlinks, submodules and alternate/shallow metadata refuse.
Those repository shapes need an explicitly reviewed extension. Worker Git
filters, hooks and index are never used to produce the result tree.

The broker rechecks the activation before snapshotting and before push, keeps
the existing exact-SHA push and remote confirmation, and only then fills the
callback's result SHA for review routing. Expiry/revocation or broker refusal
HOLDs. Preserve the result binding, session sidecar, receipts and workspace on
failure; never delete them to obtain a fresh retry budget. The existing broker
still HOLDs an ambiguous pre-push record until remote confirmation resolves it.

The distinct-UID integration includes a builder with non-writable Git metadata,
both real adapters, real Git and the real broker, and must drive all four steps.
The CLIs are deterministic process doubles. They prove the host integration;
Hermes still must verify the installed Codex sandbox and worker network policy
on the actual host for the watched fixture. Do not call this synthetic run a
live SHU-63 PASS.

Before the next live fixture, run `node --test
.github/coordinator/test/attempt-workspace.test.mjs
.github/coordinator/test/workspace-result.test.mjs
.github/coordinator/test/workspace-result-mutations.test.mjs
.github/coordinator/test/shu241-scoped-build.test.mjs
.github/coordinator/test/shu241-mutations.test.mjs` on the reviewed host. The
distinct-uid tests must execute there (not skip). The full-loop test uses real Git,
real adapters and the real broker with local bare repositories and CLI doubles;
it makes no paid model calls. It is an integration regression, not the live SHU-63
PASS. The actual host's launcher, credentials and CLI installations still require
Hermes's live acceptance at the newly approved coordinator revision.

## Rollback

Delete the activation file. Nothing else changed: the committed flag was never
touched, and the runtime switch was never persisted anywhere. With no `--activation`
argument the coordinator behaves exactly as it did before this change.

## Tests

`test/single-run-activation.test.mjs` (17 tests). CI runs this file: the
`fast-checks` job in `.github/workflows/ci.yml` invokes `npm run test:coordinator`.

* the 5-combination committed truth table, re-asserted with the activation absent —
  the default path cannot drift;
* an armed activation, and the same activation **unarmed without the runtime switch**;
* argv: absent, both accepted shapes, and every malformed shape refused;
* 29 fail-closed cases (missing file, directory, symlink, three over-permissive
  modes, non-JSON, JSON array, missing key, extra key, bad id, non-canonical target,
  bad and mismatched contract refs, bad and wrong and unresolvable revisions,
  wrong target, `slots` 2 and 0 and mismatched-cap, expired, over-long window,
  non-timestamp, board-wide config, two-issue scope, inconsistent lane, and two
  genuine episode endings — a `PASS` verdict and exhausted retryable failures);
* **episode semantics** both ways: the loop's own verdict stages
  (`COMPLETED`/`BUILD_READY`, `HOLD`/`BLOCKED`, `COMPLETED`/`REVISION_READY`) never
  spend it, a routable successor is never spent early, and the episode does end on
  `PASS`, on exhausted attempts, and on a verdict-level contradiction;
* the duplicated coherence predicate is **pinned to `reconcile.mjs`'s** across the
  whole verdict × stage matrix, so the copy cannot silently drift from the original;
* four integration runs through `main()`: inert default, a refused activation
  exiting 2 with no network, the **running revision** binding proved end to end
  against the real checkout, and the **multi-tick episode regression**;
* **the multi-tick episode regression** — six real `main()` ticks over a persistent
  Linear store and the real durable-read branch, with a fixture configuration whose
  committed flag is **false** (so the activation is the only thing authorizing
  dispatch): the builder launches, reports `BUILD_READY`; the reviewer `BLOCKED`s;
  the writer revises; the re-review `PASS`es — and the authorization is ARMED at
  every step and refuses only after `PASS`, launching nothing further and refusing
  a plain re-run identically;
* **13 mutations**, each removing one guard and asserting the corresponding refusal
  stops happening: the runtime switch, the committed two-gate path, target, contract
  ref, revision, slots, expiry wall, expiry window, **premature spending on a
  routable successor**, **premature spending on retryable failures**, the **symlink
  guard**, file permissions, unknown keys, and the board-wide guard.

Two notes on mutation honesty:

* a mutation that crashes the probe instead of failing the *named* assertion is not
  accepted as a kill. One candidate mutation was rejected and rewritten during
  development for exactly that reason (it replaced the mandatory-regex check with
  `false`, which made the probe iterate `undefined` and die with a `TypeError`
  before reaching the assertion).
* the symlink guard is *doubly* covered: `lstat` does not follow links, so a symlink
  also fails the regular-file check. The guard therefore binds the **operator-visible
  reason** (`activation file is a symlink`) rather than the refusal, and the SYM
  mutation asserts the reason, not merely the outcome.
