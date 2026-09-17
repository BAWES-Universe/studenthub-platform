# SHU-71 mint lane report

Branch: `mint/shu71-settled-package`.
Base: `962908c9f7ca6926123b7718d5ce7b62f05c2ae2`, tree
`d5ad5ba215bbbf40dca73f005986759ee9dafa65`.
Code/test revision: `a37f48d8754c982afd51b40afc50d908008afa36`.
The final report/evidence commit follows that revision.

The new entrypoint generates unsigned package, driver spec, and window spec;
its validator regenerates from authority and rejects changed fields. No mint output was signed; no production key was accessed. Nothing was
pushed, deployed, posted, or edited in Linear. No host was contacted.
Read-only GitHub `git ls-remote` was used for repository ref authority.

**Not closed: a live package cannot be honestly emitted from the supplied ID
ledger alone.** The orchestrator supplied no current host identity/environment/
directory/capability/prior-Git observations or current Linear fixture states.
The live-input attempt returned `MINT_OBSERVATIONS_REQUIRED`. The real-ref
positive control uses explicitly synthetic host/Linear observations, and its
artifacts are **not live approval inputs**. No missing observation was invented
and labeled authoritative. Observation schema is in `SHU71-MINT.md`.

Exact successful CLI argv (synthetic observation control, real repository refs):

```sh
node .github/coordinator/service/mint-shu71-package.mjs mint /tmp/shu71-mint-settled-proof /srv/shu/repo /home/bawes/work/mint-inputs/activation-id-ledger.json /tmp/shu71-mint-synthetic-observations.json /tmp/shu71-mint-cli-proof 3600000 43200000
node .github/coordinator/service/mint-shu71-package.mjs validate /tmp/shu71-mint-settled-proof /srv/shu/repo /home/bawes/work/mint-inputs/activation-id-ledger.json /tmp/shu71-mint-synthetic-observations.json /tmp/shu71-mint-cli-proof 3600000 43200000
node .github/coordinator/service/compose-shu71-approval.mjs compose /tmp/shu71-mint-settled-proof 962908c9f7ca6926123b7718d5ce7b62f05c2ae2 shu71-mint-00000015 /tmp/shu71-mint-cli-proof/package.json /srv/shu/repo /tmp/shu71-mint-composed
```

All three exited zero. Composer canonical payload SHA-256:
`a5c38e253a3de9f33c99e0c94bea03ffc7b4edac0138aca2a0ce67209b353c8b`.
The existing composer needed no change or additional package field. Its existing
validation checked the fixture pair, reseed binding, trust anchor, episode paths,
and intentional empty signatures. Its acceptance is composition, not approval.

Sources and derivations (paths relative to `.github/coordinator/`):

| Class | Source and enforcement | Observed/derived value |
|---|---|---|
| Activation ID | supplied `activation-id-ledger.json`; `service/mint-shu71-package.mjs:34` and `:42` | 14 unique IDs; LF-delimited final-LF digest `53e9928e9dd7bd15a50c698bca1b46385fd2fcc6bd9d252f8e8ae9e1bdb200e3`; candidate `shu71-mint-00000015` is absent |
| Revision/tree | live GitHub refs, origin/main and actual checkout; mint `:77`, byte/mode checks `:89` | main `962908c9f7ca6926123b7718d5ce7b62f05c2ae2`; actual tree `d5ad5ba215bbbf40dca73f005986759ee9dafa65` |
| Fixtures/lanes | committed `config.json:29` and `:45`; mint `:101`, `:140`; validator branch rule `shu71-activation-package.mjs:146` | SHU-140 → coordinator/SHU-140; SHU-254 → coordinator/SHU-254; exact committed lane objects |
| Reseed | live refs matched to local/tracking refs and retained parent, mint `:105`; `reseed-append-contract.mjs:120` computes merge tree, canonical manifest bytes and commit; sealed ancestry checked at mint `:111` | retained SHU-140 head `6e5ad86cc0a993097d2e642132077b665ad49481`; SHU-254 `6c9c14907189fe3af733969c3d8f3a2c4e21f9b0`; new seed `9195f082f041102540d88e994c7126c9dfb3d8e6`; manifest SHA-256 `e0943e4f149fb23a078027315a25a2f7c877fae0f55b7a22add05110ecabd298` |
| Evidence | fixed policy root and minted ID; mint `:143`, `:151`, `:199`; existing package validator `:172` | `/srv/shu/state/shu71-evidence/shu71-mint-00000015/journal.jsonl` and `/srv/shu/state/shu71-evidence/shu71-mint-00000015/activation.json` |
| Time/expiry | observation capture time and positive integer caller bounds (both ledger ages bounded); mint `:126`, `:133`; existing twelve-hour cap `shu71-activation-package.mjs:133` | control lifetime 3,600,000 ms; max age 43,200,000 ms; neither policy accepts a bound over 43,200,000 ms; future/stale/expired captures refuse |
| Signatures | generated only as empty strings at mint `:153`; substitution refusal `:118`, `:192` | package and activation signatures empty; lifecycle approval digest empty |
| Driver | same package, observed metadata (`:50`), fixed service parameters (`units.mjs:213`), committed unit templates and lifecycle drop-ins (`host-lifecycle.mjs:161`); mint `:154`–`:179` | matching production payload, identity, directories, environment metadata, approved tree, five rendered hashes, evidence paths, clean prior tuple; lifecycle ID matches package |

The patch digest is over the existing reviewed **canonical tree-change manifest**,
not text produced by an ad hoc `git diff` invocation. Precomputation uses a
throwaway object store; no source refs are rewritten.

The retained-parent pin is deliberately conservative: another fixture head,
even a newer descendant, requires a reviewed policy update. Current-main proof
is the instant of the remote read; minting does not reserve an ID against
concurrent/future environment changes. The supplied capture is the unused-ID
proof boundary. A recorded digest establishes integrity, not capture authenticity.

Determinism: CLI `validate` regenerated the expected output, then a separate
`mint(options)` invocation compared the bytes of all three generated files to
the first run. All were equal. The stricter final entrypoint revalidated these same artifacts successfully.
The named `MINT_IDENTICAL_REPEATS` control also
advances the clock by 1 ms without changing the generated bytes. Hashes:

| Artifact | SHA-256 |
|---|---|
| package.json | `83bd7dd3f35b4ea5895d8d3e9905c074aa9376fb5498cc787607b941e63818f9` |
| spec.json | `cf44b9089e46b2d732b22dc07a2f43f04f2363e4edb1570c3c5fdd9030440ceb` |
| window.json | `382eccc1584f28bd0cc39b0ad66612340bb0fde8a0664dba6dcdf7a4cbe60f76` |

Positive assertions, `service/test/mint-shu71-controls.mjs:37`:
`MINT_POSITIVE`, `MINT_IDENTICAL_REPEATS`, `MINT_BOUND`, `MINT_UNSIGNED`,
`MINT_COMPOSER_CONSUMES`, `MINT_EXISTING_RENDERER`, `MINT_ACTUAL_CHECKOUT`,
`MINT_ACTUAL_PARENT`. Git tests verify actual committed checkout bytes in a
local disposable clone; their remote/history boundaries are doubles. The CLI
control above independently used actual remote heads, history, and patch bytes.

Every output mutant in `service/test/mint-shu71-controls.mjs:59` is killed by
an exact-code assertion named `<mutant>: <code>`:

| Mutant | Killing code |
|---|---|
| stale revision | MINT_REVISION |
| unknown activation | MINT_ID_UNKNOWN |
| fixture substitution; lane substitution | MINT_FIXTURES |
| branch substitution | MINT_BRANCH |
| rewritten parent; stale seed | MINT_LINEAGE |
| patch digest | MINT_PATCH |
| evidence escape | MINT_EVIDENCE |
| package signature; envelope signature | MINT_SIGNATURE |
| spec disagreement | MINT_DISAGREEMENT |
| driver commands | MINT_COMMANDS |
| nondeterministic timestamp; extra output field; premature approval | MINT_NONDETERMINISTIC |
| omitted required field | MINT_REQUIRED |

Input mutants, each asserted with the exact code, at control `:79`:

| Mutant | Killing code |
|---|---|
| caller revision / fixtures / branch | MINT_REVISION / MINT_FIXTURES / MINT_BRANCH |
| caller expected_parent / expected_seed_head | MINT_LINEAGE |
| caller patch_sha256 / evidence / signature / commands | MINT_PATCH / MINT_EVIDENCE / MINT_SIGNATURE / MINT_COMMANDS |
| caller activation_id / pkg / spec | MINT_ID_UNKNOWN / MINT_CALLER_PACKAGE / MINT_CALLER_SPEC |
| missing ledger; empty ledger; numeric ledger ID; numeric capture time; ambiguous capture time; rolled calendar date | MINT_ID_LEDGER |
| ledger digest | MINT_ID_LEDGER_DIGEST |
| reused activation | MINT_ID_REUSED |
| missing observations; ambiguous observation time | MINT_OBSERVATIONS_REQUIRED |
| observation digest | MINT_OBSERVATIONS_DIGEST |
| observed commands | MINT_OBSERVATIONS_SHAPE |
| identity / environment / directories | MINT_IDENTITY / MINT_ENVIRONMENT / MINT_DIRECTORIES |
| dirty prior git / capabilities / observed fixture | MINT_PRIOR_GIT / MINT_CAPABILITIES / MINT_ISSUES |
| expiry exceeds twelve hours | MINT_EXPIRY |
| stale ID capture; stale observation / expired output / missing option | MINT_OBSERVATION_STALE / MINT_EXPIRED / MINT_REQUIRED |
| non-current main / rewritten remote lineage | MINT_REVISION / MINT_LINEAGE |
| dirty checkout; wrong actual tree | MINT_TREE |
| wrong remote | MINT_REMOTE |

Source mutants, `service/test/mint-shu71.test.mjs:20`: individually disable
revision, unused-ID, unknown-ID, fixture, lineage, patch, evidence, signature,
agreement, determinism, required-field, command, ledger-digest and expiry guards.
Each subprocess must fail with `AssertionError` and its named mutation/code
pair from the tables above; unrelated deaths do not count. Two additional source mutants restore numeric-ID and timestamp coercion; they
must die at `numeric ledger ID: MINT_ID_LEDGER` and
`numeric capture time: MINT_ID_LEDGER`. A seventeenth source
mutant changes creation time to ambient `now`; it must die at
`MINT_IDENTICAL_REPEATS`. The unchanged-source subprocess must pass first.

Additional entrypoint refusal codes: `MINT_USAGE`, `MINT_PATH`, `MINT_INPUT`,
`MINT_CHECKOUT`, `MINT_RENDER`, and `MINT_CALLER_FIELD`. Existing composer and
reseed contract codes propagate; filesystem operation errors retain their Node
error codes. No malformed supplied signature is stripped.

The driver spec has null PID/start token for a not-yet-launched attempt. Its
order/release/journal paths are declarations, not fabricated execution evidence.
The existing host lifecycle intentionally rejects its empty approval digest until
the owner stage. No host execution or lifecycle approval is claimed here.

Driver consumption was also checked with the existing command:

```sh
node .github/coordinator/service/phase-a-driver.mjs preflight /tmp/shu71-mint-cli-proof/spec.json
```

It returned the existing `shu251-phase-a-plan-v1` dry-run plan for the settled
revision, with `dry_run: true`. This performs no host preflight and does not
pretend the empty owner-approval field permits execution.

One preliminary full run failed (2,798 outcomes, 2,779 passes, 11 failures,
eight authorized skips). The existing review child had local mode `0664`, causing
its unchanged custody guard to reject execution. Repository-local
`chmod go-w .github/coordinator/review-execution-child.mjs` corrected it to
`0644`; contents and Git executable mode were unchanged. Ten targeted checks
then passed. The verification runs below were restarted after this correction.
An earlier in-progress run during test development was discarded rather than
reported as verification. No existing assertion or skip was changed to address
these failures.

Full-suite verification uses the unchanged reporter and both complete test globs:

```sh
node --test --test-reporter=./.github/coordinator/service/host-suite-contract.mjs .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS=--import=/home/bawes/work/settled/.github/coordinator/test/fixture/shift-wall-clock.mjs node --test --test-reporter=./.github/coordinator/service/host-suite-contract.mjs .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
```

| Run | Tests | Pass | Fail | Authorized skips | Terminal complete markers |
|---|---:|---:|---:|---:|---:|
| Plain | 2803 | 2795 | 0 | 8 | 1 |
| Exact CI clock | 2803 | 2795 | 0 | 8 | 1 |

Verification checks exit zero, exact inventory name multiplicities, exactly one
terminal completion marker, and exact equality of all eight skip names/reasons.
The final evidence includes summaries plus gzip-compressed raw reporter events
(`gzip -dc mint-evidence/plain-outcomes.jsonl.gz` and the clock equivalent).
Summary `raw_sha256` hashes cover uncompressed bytes. Both independent runs
have the identical outcome-stream digest
`f1463c42600ba132db45190d33f0f099f8c291eb433b2fb9c12b7833cf3000cc`.

`PERMITTED_SKIPS` and its entire source file are byte-identical to base. Its
entry count remains eight. `.github/workflows/ci.yml` is unchanged. Every old
test file, inventory name, requirement row, and file-requirement row is preserved.
Only the new test file and its three names/requirements were added.
`mint-evidence/preservation.json` records the checks and source hashes.

The synthetic package has `created_at: 2026-09-17T20:44:56.762Z` and
`expires_at: 2026-09-17T21:44:56.762Z`, exactly one hour apart. Its recorded
candidate ID should be included in the next orchestrator capture; do not treat
a historical unused-ID capture or these synthetic artifacts as a fresh live
window. A live invocation requires the missing truthful observation capture,
a fresh unused-ID ledger, and a clean checkout matching current remote main.

Final diff stat versus base is recorded alongside this report as
`mint-evidence/diff-stat.txt` (including the report/evidence additions).
