# Automatic staging deployment

A runtime-changing push to main automatically publishes and smoke-tests the exact
image digest, then triggers the existing Coolify staging application. There is no
manual dispatch, operator digest input, saved digest-pin requirement, or HTTPS-only
requirement on the Coolify API base. The reference POST and secret names remain.
See [the exact jobs side by side](RESTORE-JOB-COMPARISON.md) and
[history, validation and limitations](RESTORE-VALIDATION.md).

The workflow first excludes documentation, tests and coordinator-only changes.
For other candidate changes it builds the before/after revisions and fingerprints
the actual gateway/migrator closure, migration assets and image packaging inputs.
Identical runtime fingerprints skip publication and deployment. Revision metadata
is excluded from this comparison so a new merge SHA alone never authorizes rollout.
The environment-manifest gate remains before image publication; pull-request
manifest validation still runs only trusted base code and treats PR JSON as data.

Publication writes only the full-revision tag. The pushed digest is run through
`image-smoke.sh` against disposable CI PostgreSQL, including the runtime-content
assertion. Only a successful build job exposes the digest to `deploy`; selection
must resolve to that same digest and is archived before any trigger. Thus a failing
image is never promoted to `latest`. Workflow concurrency serializes publication,
promotion, verification and rollback without cancelling a running deployment.

`automatic-staging.mjs` reads the existing app metadata and restricts it to the
gateway image, Docker Image mode, `latest`, and `https://staging.studenthub.co`.
It does not PATCH Coolify. Rollback discovery reads the selected running container
on the host, binds its image ID to its gateway repository digest, and reads its
`/image-source-revision`. It resolves the full immutable revision tag to that same
digest, checks the pulled image revision against the host and healthy staging,
and smoke-tests that rollback image before proceeding. It never discovers the
running artifact through `latest`. See [the rollback contract](ROLLBACK-CONTRACT.md). It creates a durable GitHub issue with title
`[staging-deploy] frozen: owner review required` before moving `latest`. An existing
open issue with that title blocks subsequent staging triggers. The new, already
smoke-tested digest is promoted to the existing tag and re-resolved before POST.

The POST remains `/api/v1/deploy?uuid=...`, authenticated in an Authorization header.
Each returned deployment UUID must finish, the application must be running:healthy,
the tag must still resolve to the selected digest, and uncached staging `/health`
must report `status: ok`, `component: gateway`, and the selected full running
revision. Public feature smoke checks the landing page, stylesheet and unauthenticated
profile boundary. No Coolify token is sent to staging health or feature endpoints.
Only successful verification closes the issue. Receipts omit application/deployment
UUIDs because those may contain secret values.

On failure after tag promotion, automation attempts to restore the saved digest,
re-resolves it, triggers staging and runs the same verification for the rollback.
It reports whether rollback was verified or unverified and retains the freeze in
both cases. An interrupted runner also leaves the previously created freeze open.
A separate `staging-stop` job records pre-trigger failures and failed notification
attempts through GitHub. Before-trigger failures leave the existing runtime alone;
there is no changed deployment to roll back. GitHub issues and workflow failure
notifications are the notification channels; actual human receipt is not proven.
The issue contains a run link and immutable selected/rollback references, never
Coolify credentials or remote response bodies.

Missing settings and target/rollback gaps are `PRECONDITION_NOT_MET`, explicit POST
refusal is `TRIGGER_REJECTED`, recorded failed deployments or failed feature smoke
are `DEPLOYMENT_FAILED`, and ambiguous responses or unverifiable running state are
`DEPLOYMENT_UNKNOWN`. None of these is silently converted to deployment success.
The older `triggerSelected` helper retains its default immutable-pin assertions
and tests; the automatic caller explicitly selects HTTP compatibility and the
staging tag assertion. It never permits credentials in a URL.

Required existing secret names: `COOLIFY_BASE`, `COOLIFY_READ_TOKEN`,
`COOLIFY_TOKEN`, `COOLIFY_STUDENTHUB_GATEWAY_UUID`. GitHub provides `GITHUB_TOKEN`
(mapped to `GH_TOKEN` for issue access). The deploy job needs packages:write for
promotion/rollback and issues:write for the durable freeze and notification.
No new user-managed secret is introduced. At investigation time `COOLIFY_BASE`
was absent from accessible repository and organization secret metadata; the
historical mechanism itself requires it. This branch cannot restore live execution
while it is missing, and no substitute endpoint is invented.

Production has no workflow path or target here. Its separate explicit owner approval
requirement remains. Closing a failed freeze issue is an owner recovery action:
review the recorded run, confirm no ambiguous/in-flight deployment remains, check
the running revision and rollback/migration compatibility, and resolve the failure
before clearing the freeze. This correction does not clear any live freeze, change
Coolify configuration, run a deployment, install monitoring, or change infrastructure.

Registry tag checks and revision health are point-in-time evidence. Independent
registry writers or external Coolify deployment paths are outside the GitHub
concurrency lock. A lost POST response or failed rollback cannot establish a safe
running state; the persistent freeze and unverified outcome are intentional.
There is no authenticated end-to-end feature account in this workflow, and no
container-level running digest endpoint was established without live Coolify access.
Do not claim those checks or automatic cancellation recovery were proven by mocks.

The separate read-only `deployment-watch.mjs` interface and its tests remain
available. It emits durable orchestration incident files for an external consumer;
this change does not install or claim that consumer is live.
