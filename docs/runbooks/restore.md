# Platform database restore runbook

## Purpose

Restore the managed PostgreSQL platform database into an isolated scratch database and produce evidence that the copy is complete and internally consistent. This procedure does not restore private document storage.

## When to use

Use during a scheduled recovery exercise or after the incident commander authorizes database recovery. Never point the check at staging or production as its restored target.

## Who does it

The platform operator performs the restore; platform-on-call reviews the report and records the recovery time and data-loss window. The backup owner and current coverage are recorded in [the recovery inventory](../recovery-inventory.md).

## Before you start (checks)

1. In the managed PostgreSQL backup screen for the Coolify `platform-postgres` service, identify the approved full backup or point-in-time recovery point. Record its timestamp and immutable backup identifier in the incident or exercise record. Do not copy credentials into that record.
2. Choose a new database name ending in `_restore_check`. Confirm it is not the source database and is disposable.
3. Obtain separate connection URLs for the source and restored scratch databases through the approved secret channel. The checker forces the source connection to `default_transaction_read_only=on` and never prints either URL.
4. Record the restore start time. The checker measures its own verification time; the managed service's restore duration is measured from this restore start until the restore reports ready.

## Steps

1. In the managed PostgreSQL backup screen, select the recorded backup or recovery point and use **Restore to new database**. Name the new database with the approved `_restore_check` suffix. Do not restore over the source database or delete the persistent volume.
2. Wait for the managed service to report the new database ready. Record that time and calculate restore duration.
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

The command must exit zero and the report's `ok` value must be `true`. Review every public table's source/restored counts, identical migration-ledger counts, and all named foreign-key, sequence, and trigger checks. The short summary must say `PASS`. Platform-on-call signs off the stored JSON report and the recorded restore duration and data-loss window.

## If it goes wrong

Keep the scratch database isolated and the incident open. A non-zero exit, missing table, count or migration mismatch, orphaned foreign key, sequence behind its column, or missing append-only trigger fails the exercise. Do not repair the scratch copy to manufacture a pass; investigate backup coverage or the restore process, then repeat from a fresh suffixed database. Never run migrations or application writes against the source as part of this procedure.

## Related

[Recovery inventory](../recovery-inventory.md), [deploy](deploy.md), [rollback](rollback.md), [incident](incident.md), and `deploy/coolify/README.md`.
