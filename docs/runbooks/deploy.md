# Deploy runbook

## Purpose

Deploy a reviewed, immutable gateway image through the repository's existing delivery path.

## When to use

Use for a planned staging change or as the production go/no-go checklist. This repository has no production deployment workflow.

## Who does it

The release operator performs the steps; platform-on-call observes health and owns any alert.

## Before you start (checks)

1. In the GitHub Actions screen, confirm **Build and push gateway** succeeded for the reviewed commit in `.github/workflows/build.yml`.
2. Open the run summary and record the `main-<full revision>` image tag and digest from **Record published artifact**; do not use `latest` as the pin.
3. Confirm the environment check succeeded against every name in `deploy/coolify/deployment-env-manifest.json`.
4. Confirm the [on-call rota](on-call.md) has a primary and backup for the cutover window.

## Steps

1. In the GitHub pull-request screen, add the `on-dev` label to the same-repository pull request; `.github/workflows/staging-on-dev.yml` reconciles the wanted revision.
2. In GitHub Actions, open **Staging on-dev** and wait for **Smoke-test the exact pushed digest** to pass; it runs `bash deploy/coolify/image-smoke.sh "<pinned-image-at-digest>"`.
3. Wait for **Switch staging and verify it serves this revision** to pass; it runs `node deploy/coolify/staging-switch.mjs` from main.
4. For the source-build Compose package only, choose `deploy/coolify/compose.yaml` in the Coolify screen, set `SOURCE_REVISION` to the reviewed full revision, and select **Deploy** as described in `deploy/coolify/README.md`.

## How to verify

Confirm the workflow's exact-digest image smoke passed, then confirm **Switch staging and verify it serves this revision** reports the expected revision and feature smoke. Locally, repository-only verification is `npm test`.

## If it goes wrong

Stop the go/no-go. Do not move `latest` manually. Follow [incident](incident.md), then [rollback](rollback.md) if the incident decision calls for it.

## Related

`deploy/coolify/DEPLOY-FLOW.md`, `deploy/coolify/IMAGE-SMOKE.md`, `deploy/coolify/preflight.mjs`, and [alert routing](alerts.md).
