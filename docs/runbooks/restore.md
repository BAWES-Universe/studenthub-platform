# Platform database restore runbook

## Purpose

Restore a verified PostgreSQL backup of the Compose-deployed `platform-postgres` service into an isolated scratch database and produce evidence that the copy is complete and internally consistent. This procedure does not restore private document storage.

## When to use

Use during a scheduled recovery exercise or after the incident commander authorizes database recovery. Never point the check at staging or production as its restored target.

## Who does it

The platform operator performs the restore; platform-on-call reviews the report and records the recovery time and data-loss window. The backup owner and current coverage are recorded in [the recovery inventory](../recovery-inventory.md).

## Before you start (checks)

1. Obtain the approved backup artifact from the restricted backup store. The artifact must have been exported directly from the Compose `platform-postgres` service with PostgreSQL 17 `pg_dump` (for example, `docker compose -f deploy/coolify/compose.yaml exec -T platform-postgres pg_dump -U "$PLATFORM_DB_USER" -d "$PLATFORM_DB_NAME" -Fc > platform-postgres.dump`) and transferred to that store under the separate backup process. Record its timestamp, immutable artifact identifier, format, and checksum in the incident or exercise record. Backup production, scheduling, retention, and storage are outside this runbook; if no verified artifact exists, stop.
2. Choose a new database name ending in `_restore_check`. Confirm it is not the source database and is disposable.
3. Obtain separate connection URLs for the source and restored scratch databases through the approved secret channel. The checker forces the source connection to `default_transaction_read_only=on` and never prints either URL.
4. Ensure PostgreSQL 17 client tools can reach the Compose `platform-postgres` service, then record the restore start time. The checker measures its own verification time; restore duration is measured from this time until the restore command completes.

## Steps

1. Create the new scratch database through the Compose PostgreSQL service, then restore the recorded artifact. Use exactly one command matching its recorded format; never use the source database name as `SCRATCH_DB`:

   ```sh
   docker compose -f deploy/coolify/compose.yaml exec -T platform-postgres \
     createdb -U "$PLATFORM_DB_USER" "${SCRATCH_DB:?must end in _restore_check}"
   # Custom-format archive:
   docker compose -f deploy/coolify/compose.yaml exec -T platform-postgres \
     pg_restore -U "$PLATFORM_DB_USER" -d "$SCRATCH_DB" --exit-on-error < "$BACKUP_ARTIFACT"
   # Plain-SQL dump (use instead of pg_restore):
   docker compose -f deploy/coolify/compose.yaml exec -T platform-postgres \
     psql -U "$PLATFORM_DB_USER" -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 < "$BACKUP_ARTIFACT"
   ```

   Before running these commands, verify `SCRATCH_DB` ends in `_restore_check`, differs from `PLATFORM_DB_NAME`, and does not already exist. Do not restore over the source database or delete `platform-postgres-data`.
2. Record the completion time and calculate restore duration. Construct the scratch URL through the approved secret channel; the database host remains `platform-postgres` for callers inside the Compose network.
3. Build the checked revision with `npm run build`, then run the machine-readable check:

   ```sh
   RESTORE_CHECK_SOURCE_URL='<from secret channel>' \
   RESTORE_CHECK_RESTORED_URL='<from secret channel>' \
   node dist/packages/db/src/restore-check-cli.js > restore-check-report.json
   ```

4. Run the same check with `--text` to paste its short outcome into the incident or exercise record. Store `restore-check-report.json` in the restricted operational evidence location; it contains names and counts, not credentials or row values.
5. Record the backup timestamp, recovery decision timestamp, restore start and ready times, checker start/end/elapsed seconds, check outcome, and data-loss window. Calculate the data-loss window from the last confirmed application write included in the selected recovery point to the recovery decision time; do not substitute restore duration for this value.
6. After review, delete the isolated scratch database through the managed PostgreSQL screen.

## How to verify

The command must exit zero and the report's `ok` value must be `true`. Review every public table's source/restored counts, identical migration-ledger counts, and all named foreign-key, sequence, and trigger checks. A count of `-1` means that table is absent on that side and is always a failure. The short summary must say `PASS`. Platform-on-call signs off the stored JSON report and the recorded restore duration and data-loss window.

## If it goes wrong

Keep the scratch database isolated and the incident open. A non-zero exit, missing table, count or migration mismatch, orphaned foreign key, sequence behind its column, or missing append-only trigger fails the exercise. Do not repair the scratch copy to manufacture a pass; investigate backup coverage or the restore process, then repeat from a fresh suffixed database. Never run migrations or application writes against the source as part of this procedure.

## Related

[Recovery inventory](../recovery-inventory.md), [deploy](deploy.md), [rollback](rollback.md), [incident](incident.md), and `deploy/coolify/README.md`.
