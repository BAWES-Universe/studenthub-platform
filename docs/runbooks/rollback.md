# Rollback runbook

## Purpose

Restore the previously verified gateway image without pretending that database migrations can be reversed.

## When to use

Use after an incident decision when the current application revision is unsafe and the previous image is known and verified.

## Who does it

The release operator performs the rollback after the incident commander decides; platform-on-call verifies service health.

## Before you start (checks)

1. Open the prior successful GitHub Actions run and identify its immutable full-revision tag and digest.
2. Read `deploy/coolify/ROLLBACK-CONTRACT.md` and confirm the previous image has a verified embedded revision, digest, health result, and image smoke result.
3. Review all migrations introduced after that revision. Migrations are forward-only: the previous image runs against the newer schema.
4. Declare this procedure unsafe if the previous image cannot operate on the newer schema. Use the separately verified database-backup recovery process instead; do not delete a volume or reverse migration files.

## Steps

1. In the deployment screen, select the previously verified image by immutable digest, never `latest`.
2. Trigger the existing deployment for that pinned image; do not run or edit `deploy/coolify/rollback-artifact.mjs` as though discovery itself deploys anything.
3. In the deployment screen, wait until the gateway is reported healthy.
4. Record the incident timeline, previous revision, selected digest, and verification outcome without credentials or private data.

## How to verify

Confirm `/health` reports the previous embedded revision, the image smoke criteria in `deploy/coolify/IMAGE-SMOKE.md` pass, and the affected feature succeeds with synthetic input.

## If it goes wrong

Keep the incident open. If schema compatibility is uncertain or health differs from the pinned revision, stop this rollback and escalate to database-backup recovery.

## Related

[Deploy](deploy.md), [incident](incident.md), `deploy/coolify/ROLLBACK-CONTRACT.md`, and `deploy/coolify/README.md`.
