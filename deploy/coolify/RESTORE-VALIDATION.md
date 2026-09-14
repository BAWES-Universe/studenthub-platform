# Restore automatic staging: review and validation

Work is confined to `/home/bawes/work/restore`, branch
`fix/restore-automatic-staging-deploy`, starting at current remote main
`c0aec80e3975de824bb6081efe703d60a4fbe55b`. No merge, dispatch, deployment,
Coolify API call/configuration change, infrastructure change, host or `/srv`
access was performed. GitHub API reads were limited to history and secret-name
metadata. Log inspection emitted classifications only, never raw remote responses
or secret values. The push uses the GitHub credential helper, never a credential
in the remote URL.

## History actually found

The supplied commit `6a09ecb36aa0ef136a375f69efe838674bf7f5c4` already has the
manual workflow. Git history and PR #104 metadata identify its merge commit as
`fae0d55f965b68db6e439b0900100c4df863c761` (2026-09-14 08:39:56 UTC).
The actual pre-#104 parent is `50db30ee3c48b9fe4a056a253cd13992cfaba772`.
See the [verbatim deploy jobs quoted side by side](RESTORE-JOB-COMPARISON.md).

| Run | Event and evidence |
| --- | --- |
| [34820576669](https://github.com/BAWES-Universe/studenthub-platform/actions/runs/34820576669) | Main push at `50db30ee`; env-manifest, build-push and deploy succeeded. Deploy job `103901325102` contains a deployment receipt, no curl error and no executed fallback. |
| [34799009839](https://github.com/BAWES-Universe/studenthub-platform/actions/runs/34799009839) | Main push at `40246c4b`; same successful job chain. Deploy job `103837942786` contains a deployment receipt, no curl error and no executed fallback. |
| [34836634198](https://github.com/BAWES-Universe/studenthub-platform/actions/runs/34836634198) | Push at the supplied `6a09ecb`; already the post-#104 publish-only mechanism. |

The pre-#104 `deploy` job ran on a main push after `build-push` and called
`POST ${COOLIFY_BASE}/api/v1/deploy?uuid=${COOLIFY_STUDENTHUB_GATEWAY_UUID}` with
`Authorization: Bearer ${COOLIFY_TOKEN}`. Those are secret **names**, not values.
The upstream env-manifest gate additionally used `COOLIFY_READ_TOKEN`.
The old curl fallback converted trigger errors to successful jobs. Neither
historical deploy job contained image smoke, health, feature, revision, rollback
or freeze steps. The inspected logs prove trigger acceptance, not successful
runtime deployment. They cannot justify claiming those missing guardrails existed.

## Correction and intentional deviations

Restored the automatic main-push dependency on publication, using the same endpoint
and secret names. Removed `workflow_dispatch`, revision/digest inputs, operator
artifact selection and the saved immutable Coolify pin prerequisite from the
automatic path. Removed the HTTPS-only restriction for the automatic caller;
HTTP and HTTPS are accepted with no URL credentials. `COOLIFY_BASE` is retained
because it was part of the working mechanism, not newly introduced by #108.

The correctness deviations are explicit: publish only a full-revision tag, smoke
the pushed digest, then promote it to the existing `latest` deployment tag;
retain and smoke the previous digest for rollback; serialize the run through
verification; create a persistent GitHub freeze issue before promotion and retain
it on failure. The reference had none of these protections. There is no Coolify
PATCH or configuration redesign. The detailed flow is in [DEPLOY-FLOW.md](DEPLOY-FLOW.md).

| Owner guardrail | Enforcement |
| --- | --- |
| Staging only | Main push and fixed repository checks; before every POST, app must have the staging domain, gateway image, Docker Image mode and existing latest tag. No production target or approval bypass exists. |
| No coordinator/docs-only deployment | Fast path exclusions and before/after built runtime fingerprint. Unchanged deployed closure skips env/build/deploy; a changed commit SHA alone is excluded from the fingerprint. |
| Exact image passed smoke before trigger | Build publishes a revision tag, runs image smoke and runtime-content assertions by pushed digest; dependent deploy re-resolves that digest, records it, and promotes it to latest only afterward. Rollback digest is smoke-tested too. |
| Post-deploy verification | Every returned deployment UUID must finish; app running:healthy, latest digest unchanged, uncached gateway health with exact running revision, public landing/CSS/profile-boundary smoke. |
| Rollback, freeze and notification | Freeze issue created before promotion. Any subsequent failure attempts promotion and verified deployment of previous digest; freeze stays open regardless of rollback outcome. Pre-trigger failures leave runtime unchanged and staging-stop records a freeze/notification. Runner interruption retains the existing latch. GitHub issue and workflow notifications provide the reporting channel. |
| Truthful outcomes | Preconditions never report DEPLOYMENT_FAILED. Rejection, recorded/feature failure, ambiguous state and success remain distinct. Unknown rollback is explicitly unverified. |
| Existing assertions | No existing test was deleted. `env-manifest.test.mjs` changes the deliberately obsolete MANUAL_DEPLOY_ONLY/NO_MERGE_DEPLOY expectations to main-push-only, successful smoke-tested publication, no manual inputs, digest binding and record-before-trigger expectations. Trusted-base/secret/env assertions remain. All immutable-pin and typed-outcome helper tests and mutation tests remain intact. |

## Secret names and current gaps

GitHub API secret metadata was read twice on 2026-09-14. Repository secrets:
`COOLIFY_READ_TOKEN`, `COOLIFY_STUDENTHUB_GATEWAY_UUID`, `COOLIFY_TOKEN` (3).
Accessible repository organization secrets: 0. Repository environments: 0.
**`COOLIFY_BASE` is currently MISSING from those sources.** No secret value was
read, guessed, printed or written. GitHub automatically supplies `GITHUB_TOKEN`,
used as `GH_TOKEN` for the freeze/notification API; it is not a missing manually
configured repository secret. No new user-managed secret name is introduced.

Live execution cannot be claimed restored while the historical endpoint secret is
missing. This lane neither fills that gap nor substitutes an endpoint. The current
Coolify mode/tag, token validity, registry access, deployment reachability and
issue-write policy are not verified through live deployment. The fixed `latest`
metadata check must match the existing app; no setting is changed to make it pass.

Authenticated end-to-end feature journeys and the actual running container digest
were not established. Health proves the baked revision, and registry checks prove
the selected tag digest at observed times; these are not a container inspection.
Independent registry writers and external Coolify actions are not locked by GitHub
concurrency. A lost response, unfinished external deployment, failed rollback or
killed runner may require owner recovery under the retained freeze. GitHub issue
creation/updates are implemented but no actual human notification delivery was
performed or proven. Docker/GHCR/Coolify integration was not run locally.

## Commands and counts

Root `npm test` was run before coordinator verification. Coordinator permissions
were set with `chmod -R go-w .github/coordinator`; both separate coordinator
commands ran under `umask 0002`.

| Command | Result, counted separately |
| --- | --- |
| `npm ci --ignore-scripts` | Exit 0; installed missing local dependencies. |
| `npm test` (first run) | Exit 0; 436 Node tests passed, 27 Vitest tests passed, 79 standalone mutation kills. |
| `npm test` (after fingerprint regression added) | Exit 0; 437 Node tests passed, 27 Vitest tests passed, 79 standalone mutation kills. |
| `npm test` (final precondition-typing revision) | Exit 0; **437 Node tests passed, 27 Vitest tests passed, 79 standalone mutation kills; 0 failed, 0 skipped**. |
| `node --test .github/coordinator/test/*.test.mjs` | Exit 0; **860 tests, 853 passed, 7 skipped, 0 failed**. |
| `node --test .github/coordinator/service/test/*.test.mjs` | Exit 0; **71 tests, 71 passed, 0 skipped, 0 failed**. |
| `node --test deploy/coolify/test/automatic-staging.test.mjs deploy/coolify/test/trigger-selected.test.mjs deploy/coolify/test/trigger-selected-mutations.test.mjs deploy/coolify/test/env-manifest.test.mjs` | Exit 0; **39 tests, 39 passed, 0 skipped, 0 failed** after the final typing change. |
| `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -shellcheck= .github/workflows/build.yml` | Three invocations, each exit 0: 1 workflow, 0 diagnostics. Cached local actionlint; ShellCheck not installed. |
| `git diff --check` | Exit 0; no whitespace errors. |

Root final suite breakdown: core 258; deployment 88; web 15; documents 19;
hardening 10; observability 15; lifecycle 25; R2 7 = 437 Node tests.
Vitest separately: 27. Standalone mutation scripts separately: 10 + 3 + 17 + 10 +
17 + 22 = 79 killed, no survivors. Mutation tests embedded in Node suites are
already included in the Node counts, not added twice. Observability synthetic
exercise also passed.

Coordinator skips: six distinct-UID/root capability fixtures cannot execute under
this local account; one vocabulary test has no undeclared runtime/role pair.
No skip was introduced or assertion weakened for this lane.

An initial direct deployment-glob attempt before dependencies/build were installed
reported 53 tests: 51 passed and 2 file-load failures. The failures were missing
local prerequisites, not hidden; the subsequent full npm runs built the project
and passed the complete deployment suite (88 tests on the final revision).

The final commit SHA and independent remote-head equality proof are reported in
the completion message; embedding a commit's own SHA in itself is not possible.
