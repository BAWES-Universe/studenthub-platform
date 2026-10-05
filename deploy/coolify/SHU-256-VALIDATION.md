# SHU-256 local validation

Clone: `/home/bawes/work/shu256`. Branch:
`feat/shu256-separate-deploy-from-merge`. Base local main:
`50db30ee3c48b9fe4a056a253cd13992cfaba772`.

All required commands ran under `umask 0002` after
`chmod -R go-w .github/coordinator`. That permission command succeeded; it changed
no tracked coordinator contents. No coordinator or dispatch code was edited.

## Separate command results

| Command / attempt | Result and counts |
| --- | --- |
| `node --test deploy/coolify/test/artifact-selection.test.mjs deploy/coolify/test/deployment-watch.test.mjs` | Exit 0; 10 tests, 10 pass, 0 fail, 0 skip (initial focused run; final versions also covered by final npm test) |
| `npm test`, attempt 1 | Exit 2 during build: missing installed `@types/node`; 0 tests executed |
| `npm ci --ignore-scripts` | Exit 0; installed lockfile dependencies, no manifest/lockfile change; no tests |
| `npm test`, attempt 2 | Exit 1; 335 tests executed: 334 pass, 1 fail, 0 skip; 13/13 mutation kills before stop. Existing workflow test still required push deployment; assertion updated for requested manual gate |
| `npm test`, final attempt | Exit 0; 426 tests: 426 pass, 0 fail, 0 skip; 79/79 mutation kills; local observability exercise passed |
| `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` | Exit 0; 862 tests: 855 pass, 0 fail, 7 skip |
| Python / PyYAML parse and invariant assertions | Exit 0; 1 workflow parsed, 6 assertions passed: unchanged env-manifest job, unchanged PR triggers, push-only build, main-dispatch-only deploy, deploy needs env-manifest, revision/digest inputs |
| `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 -shellcheck= .github/workflows/build.yml` | Exit 0; 1 workflow, 0 diagnostics; ShellCheck integration disabled |
| `node --check deploy/coolify/select-artifact.mjs` | Exit 0; 1 script parsed |
| `node --check deploy/coolify/trigger-selected.mjs` | Exit 0; 1 script parsed; final version subsequently covered by npm test |
| `node --check deploy/coolify/deployment-watch.mjs` | Exit 0; 1 script parsed |
| `git diff --check` | Exit 0; no whitespace errors |

Counts are separate; repeated tests are not added into a unique-test claim.
Final root command breakdown: compiled Node tests 258; actor assertion Vitest 27;
deployment 50; web 15; documents 19; document hardening 10; observability 15;
document lifecycle 25; R2 fixture tests 7. Mutation groups: profile 10,
idempotency 3, documents 17, hardening 10, observability 17, lifecycle 22.
Observability exercise: 5 injected failures, recovery HTTP 200, both correlation
checks 6/6, private sentinel absent; no external ingestion.

Local full logs: `/tmp/shu256-npm-test.log`,
`/tmp/shu256-npm-test-rerun.log`, `/tmp/shu256-npm-test-final.log`, and
`/tmp/shu256-coordinator-test.log`. Logs are not committed.

## Every new file

- `deploy/coolify/select-artifact.mjs`
- `deploy/coolify/trigger-selected.mjs`
- `deploy/coolify/deployment-watch.mjs`
- `deploy/coolify/test/artifact-selection.test.mjs`
- `deploy/coolify/test/deployment-watch.test.mjs`
- `deploy/coolify/DEPLOY-FLOW.md`
- `deploy/coolify/ENVIRONMENT-LABEL-REMEDIATION.md`
- `deploy/coolify/SHU-256-VALIDATION.md` (this file)

Modified existing files: `.github/workflows/build.yml`,
`deploy/coolify/README.md`, `deploy/coolify/test/env-manifest.test.mjs`.

## Every new test name and negative assertion text

In `test/artifact-selection.test.mjs`:

- **selects full revision tag and immutable digest**
- **absent immutable artifact fails closed**

  Named assertions: `ABSENT_ARTIFACT: missing immutable tag must fail without latest fallback`.

- **mutable revision and malformed digest fail closed**

  Named assertions: `INVALID_REVISION: mutable refs must be rejected before registry access`; `INVALID_DIGEST: malformed registry digest must not produce a pin`.

- **deploy refuses latest, wrong digest, wrong image and non-staging target without POST**

  Named assertions: `UNPINNED_TARGET: mismatched application must refuse deployment`; `NO_POST: refused application must never receive a deployment request`.

- **verified digest deployment records Coolify deployment ID**
- **deploy HTTP failure and absent deployment ID fail closed**

  Named assertions: `HTTP_FAILURE: API failure must propagate`; `MISSING_RECEIPT: trigger without deployment ID must fail`.


In `test/deployment-watch.test.mjs`:

- **FAILED event CLI creates and updates incident plus orchestration wake**
- **empty and successful events CLI stay silent and create no signal**

  Named assertions: `QUIET_STDOUT: non-failures must emit no incident`; `QUIET_STDERR: non-failures must emit no diagnostic`; `NO_WAKE: non-failures must create no signal directory`.

- **gateway polling normalizes a failed GitHub run**
- **watcher rejects unrelated workflow and malformed failure without wake**

  Named assertions: `WRONG_WORKFLOW: unrelated run must be refused`; `INVALID_EVENT: malformed failure must exit nonzero`; `INVALID_EVENT_NO_WAKE: malformed failure must not create a wake`.


Updated existing test `SHU-243 workflow gates image build and push on the env-store check`
retains its trusted-base and environment checks and adds these named assertions:

- `MANUAL_DEPLOY_ONLY: deployment must require main dispatch and the environment gate`
- `NO_MERGE_DEPLOY: push must never authorize deployment`
- `RECORD_BEFORE_TRIGGER: selection upload must precede deployment`

## Operator flow and limits

See [DEPLOY-FLOW.md](DEPLOY-FLOW.md): choose a published full main SHA and digest;
a separately authorized staging operator saves the exact digest pin; then dispatch
the workflow on main with revision and expected digest. The selection upload must
succeed, the environment check must pass, and Coolify must already match the
staging digest before a deployment request is allowed. Trigger errors fail the
run. Preserve publication, selection and receipt records for rollback.

No push, merge, PR interaction, Linear/GitHub write, deployment, Coolify API call,
production contact, secret access, host/service installation or `/srv` write was
performed. Public Docker/Coolify documentation was read; dependencies and local
validation tools were downloaded. No image was built or published locally and no
registry resolution was exercised live. API behavior is mocked in tests; installed
Coolify version compatibility and external auto-deploy hooks remain unverified.

The watcher test demonstrates only local incident creation/update and the
orchestration wake file contract, plus silence for non-failures. No scheduler or
wake consumer was activated, and no live monitoring claim is made. Concurrent
external Coolify configuration changes must be serialized by operators; the
read-before-trigger guard is not an atomic Coolify transaction. The environment
label remediation is documented and **NOT EXECUTED**. The merge freeze remains.
