# Publish, select, deploy (SHU-256)

This document describes the deployment contract. The focused diagnosis/fix lane
made no deployment, dispatch, or Coolify configuration change. The two operator
reported dispatches (34834697047 and 34835669797 at 43c6d923) both failed; they
are not evidence of a successful rollout.

**Separate tracked operator item: replace staging's mutable `latest` pin.** The
application is currently pinned to `latest` according to the supplied operational
evidence (not re-read in this lane). This code fix does not change that pin and
cannot make a dispatch succeed until the separately authorized operator completes
step 2 below. No external tracking issue was created by this lane.

A push to main runs the unchanged environment-manifest gate, then builds/pushes
`ghcr.io/bawes-universe/studenthub-gateway:main-<full-40-character-sha>` and
`latest`. It does **not** run the deploy job. The build job exposes `digest` and
`immutable-tag` outputs and uploads `published-artifact-<sha>-<attempt>` containing
`published-artifact.json` (revision, tag, digest, image, pin, run ID). The step
summary also records it. Preserve these records outside default Actions artifact
retention for long-term rollback. Older abbreviated tags are not guessed: a
revision without a full-SHA tag fails closed and requires publication first.
Tags can be overwritten by registry writers or rebuilds; the digest, not the
revision tag alone, is the deployment authority.

After the freeze is lifted and this change is separately approved for rollout:

1. Choose an already published main revision and its digest from its successful
   publication record. With Docker Buildx and registry read access, resolve it:
   `node deploy/coolify/select-artifact.mjs <full-sha>`.
   Missing tags, authentication errors and malformed digests fail without falling
   back to `latest`. This command reads the registry; it never calls Coolify.
2. A separately authorized staging operator saves the selected digest on the
   existing gateway Docker Image application, retaining its UUID, runtime config,
   domain and storage. In Configuration > General > Docker Registry, image is
   `ghcr.io/bawes-universe/studenthub-gateway`; Docker Image Tag or Hash is the
   emitted `coolifyTag` (`sha256-<64-hex>`). Do not select Redeploy in the UI.
   This representation is documented in the
   [Coolify Docker Image guide](https://coolify.io/docs/applications/deployments/docker-image).
   Verify with a separately authorized read of
   `GET /api/v1/applications/<gateway-application-uuid>`: `build_pack` must be
   `dockerimage`, `docker_registry_image_name` must be the repository above,
   `docker_registry_image_tag` must exactly equal the emitted `coolifyTag`, and
   `fqdn` must be `https://staging.studenthub.co`. Inspect only these fields;
   do not print tokens, environment values or the complete application response.
   For the measured selection, revision is
   `43c6d923f2f66b303f4851c2f01fa43a86566c75`, digest is
   `sha256:80851c284177581f2d4c9bbed5f24cab5665c54a3efec5f39463081203b1ae72`,
   and the exact Docker Image Tag or Hash must be
   `sha256-80851c284177581f2d4c9bbed5f24cab5665c54a3efec5f39463081203b1ae72`.
   Neither `latest` nor `main-43c6d923f2f66b303f4851c2f01fa43a86566c75`
   meets this digest-pin precondition. Confirm the installed version exposes this value through the application API;
   an unsupported representation fails closed. Configuration is never PATCHed by
   this workflow. Serialize operator configuration changes through completion of
   deployment: the GET-to-trigger check is not a transactional lock on Coolify.
3. Run **Build, push and deploy gateway** via `workflow_dispatch` on **main**,
   supplying `revision` and `digest`. This is the recorded deployment action;
   it does not rebuild. The existing environment-manifest gate still applies.
   The selected revision must be an ancestor of the workflow's main SHA. The
   resolved digest must equal the operator input. Selection (including actor,
   run ID and attempt) is uploaded before triggering is possible.
4. The deploy job reads the application's metadata, requiring Docker Image mode,
   the expected repository, exact digest and `https://staging.studenthub.co`.
   `latest`, another digest, or another target fails before POST. The job then
   requests deployment once and reads each returned UUID using
   `GET /api/v1/deployments/<deployment-uuid>` (not the global deployment list).
   The [deploy response](https://coolify.io/docs/api/endpoints/deployments/deploy-by-tag-or-uuid)
   supplies UUIDs, not completion status; the
   [deployment lookup](https://coolify.io/docs/api/endpoints/deployments/get-deployment-by-uuid)
   supplies status. All returned deployments must reach `finished`; the app must
   retain its pin and report `running:healthy`; the unauthenticated staging
   `/health` must return `status: ok`, `component: gateway`, and the selected
   `revision`. Only then is `DEPLOYMENT_SUCCEEDED` recorded and the receipt
   uploaded. The Coolify credential is never sent to the health endpoint.
   Ensure the runner can read these endpoints and the gateway's Docker readiness
   check is enabled; serialize all other deployment/configuration paths through
   verification. The total script deadline is five minutes, with five-second
   polling and requests bounded to fifteen seconds or the remaining deadline.
5. Treat the following nonzero outcomes distinctly:
   - `PRECONDITION_NOT_MET`: local configuration or the saved app pin/target is
     wrong; no POST was sent for a failed pin check. Complete the precondition.
   - `TRIGGER_REJECTED`: POST explicitly refused with HTTP 400, 401, 403, 404,
     405, 422 or 429. This is not a failed deployment.
   - `DEPLOYMENT_FAILED`: a returned, matching deployment UUID has status
     `failed`, `cancelled` or `cancelled-by-user`.
   - `DEPLOYMENT_UNKNOWN`: missing/empty/malformed receipt, lost response,
     ambiguous server error, unavailable lookup, wrong UUID, unfamiliar status,
     changed pin or deadline without verified health. Inspect history before
     retrying; POST is never automatically retried. No deployment created is
     not evidence of deployment failure.
   Known UUIDs are retained in a local receipt on verification failure. With the
   unchanged workflow gates, the following upload step runs only on success;
   failure diagnostics remain in the job log. Runner/job cancellation can prevent
   script diagnostics or receipt writes and does not prove deployment failure.
6. Preserve the receipt and publication record. Roll back by selecting a previous
   recorded digest and repeating this explicit flow, subject to migration
   compatibility; never restore `latest` as rollback authority. Successful
   verification is a point-in-time observation, not a guarantee of future uptime.

PR `pull_request_target` types, trusted-base checkout, proposed-manifest-as-data,
secret handling and environment checks are unchanged. No PR code is run by a new
job. Push and dispatch use separate concurrency groups so new merges cannot
cancel an in-flight deployment. Dispatches serialize without cancelling a running
one (GitHub may replace a pending run). Any independent Coolify auto-deploy hook
must be audited/disabled by a separately authorized operator before claiming all
external deployment paths are decoupled. None was inspected or changed here.

## Failure monitor and zero-model wake contract

One read-only poll of the gateway workflow run, suitable for an external scheduler:

```sh
node deploy/coolify/deployment-watch.mjs --repo <owner/repo> --run <run-id> --signal-dir <private-local-inbox>
```

Use the actual repository slug. `gh` must already
have read access. The script calls `gh api` once and verifies the run's workflow
path; it makes no Coolify calls. Schedule polls while that run is active. A failed
build/env gate is also a gateway workflow failure. A successfully verified run cannot
detect a subsequent runtime failure; for those, a separately provisioned read-only
collector must supply normalized Coolify events:

```sh
node deploy/coolify/deployment-watch.mjs --events events.json --signal-dir <private-local-inbox>
```

`events.json` is an array, e.g.
`[{"source":"coolify","id":"deployment-uuid","status":"FAILED"}]`.
Failures produce one JSON incident line on stdout, an atomically replaced
`incident-<sha256-of-source-and-id>.json`, then atomically replaced `wake.json` with
`route: "orchestration"` and the incident filename. **This file drop is the wake
interface.** A future orchestration-route consumer must observe replacement of
`wake.json`, scan incident files, and acknowledge/deduplicate by source and ID;
repeated failures refresh the signal. Use a private directory owned by the
watcher, not an untrusted shared or symlink-controlled path. Empty, successful and
in-progress event sets produce no output or files. Read/delivery errors exit
nonzero on stderr; they are not falsely classified as deployment incidents.

There is no model invocation, messaging API, coordinator modification or dispatch
activation. The CLI tests prove incident creation/update, the wake file, and
non-failure silence in temporary directories. GitHub polling is tested with an
injected command response. No scheduler, Coolify collector, host inbox watcher or
orchestration consumer is installed or proven live by these tests. A future
operator must wire this documented file-drop interface before claiming active
monitoring or actual orchestration wake delivery.
