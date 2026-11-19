# Importer, release matrix and mobile exit lane

Lane in the full-migration plan agreed on the desk (PR #393, 2026-11-17): verified release candidate on 17 Dec, full migration live on 1 Jan, payroll workbook included. Owner Claude; reviewer GPT or Codex on the box, at the exact head. Outcome contracts: `contracts/ops-migration-cutover.md` (M-1 to M-7, K-1 to K-8) in the project files.

## Lease

| | |
|---|---|
| Paths | new `tools/release-matrix/**`; new `docs/lanes/cutover/**`; `tools/legacy-import/**` (additive; the pay lane reads it); new `packages/db/src/import/**` and `packages/db/test/import-*.test.ts`; one additive `./import` export in `packages/db/package.json` when the first store lands; the platform side of the mobile compatibility layer under new `apps/gateway/src/mobile-compat/**` (its one wiring seam is reserved separately, later) |
| Migrations | 0650 to 0699 |
| Excluded | gateway `index.ts`, `routes/`, `wiring/`, `web-ui.ts`, `login-runtime.ts`; workflows; `.github/coordinator/**`; every other lane's paths |

## What "done" means for this lane

1. **Release matrix** (this PR). `tools/release-matrix/matrix.json` has one row for each of the 77 target screens and 7 exclusions in the SHU-235 contract, each of the 120 mobile endpoints, the seven import domains and the release steps. A gate closes only with evidence the check can parse (PR at an exact head, a run, or a run report comment); a waiver cites its decision record. `cli.js check` runs in CI through the test suite; `cli.js release candidate` must pass for the 17 Dec candidate; `release cutover` (adds K-6, K-7, PAY-SHADOW, SWITCHES) on 1 Jan; `release retired` (adds K-8) when legacy is switched off. The test also enforces SHU-235 section 7: deleting or duplicating any of the 382 legacy ordinals fails.
2. **Importer.** Order: M-4 catalogues and organizations with id maps, M-1 people, M-3 link report, M-2 documents, M-5 work, recruit and finance history, M-7 incremental, then M-6 full rehearsal. Each step is idempotent, writes a reconciliation report with legacy ids only, is tested on synthetic fixtures shaped like legacy, and closes its `built` and `dryRun` gates. `rehearsal` and `reconciled` close on the staging copy.
3. **Mobile exit.** Inventory done (below). The compatibility layer serves every `serve` route with the legacy shape in the 17 Dec candidate; `retire` routes answer with the legacy error shape; the legacy API is retired on 1 Jan, tested against traffic captured from a store build.
4. **Rollback.** K-5 rehearses final sync, single-writer cutover and rollback on staging before 17 Dec.

## Dates

| Date | This lane |
|---|---|
| 1 Dec | matrix live with lanes recording evidence; daily refresh running; importer dry runs for M-4 and M-1; first importer rehearsal on staging; mobile inventory confirmed against a store build |
| 10 Dec | every import domain built and dry-run; compatibility layer for all `serve` routes on main |
| 17 Dec | `release candidate` passes: every candidate gate closed with evidence or a recorded waiver; rollback rehearsed |
| 31 Dec to 1 Jan | final sync (M-7), K-6 go/no-go with Khalid, K-7 switch; `release cutover` passes |

## Daily read-only legacy refresh on staging

Approved by Khalid on 2026-11-17 (decision record "Added 2026-11-17"): read-only against legacy, no emails, SMS, push or webhooks from staging, real personal data never leaves staging, no production credentials in card workers, off the card-run path. It feeds the importer rehearsal and the pay lane's December shadow month, so it must run daily by 1 Dec.

Job: `tools/legacy-import/src/refresh-cli.ts` (`node dist/tools/legacy-import/src/refresh-cli.js`), run nightly by cron on the staging host, installed through a Hermes card. It:

- copies the legacy MySQL database into a staging database that must be named `legacy_mirror`, on a different host from the source, with one consistent snapshot (`mysqldump --single-transaction`), then drops mirror tables legacy no longer has;
- refuses to run unless the source account is read-only: `SHOW GRANTS` may list only `USAGE`, `SELECT` and `SHOW VIEW` (an allowlist; any other privilege, grant option or unreadable role grant stops it before anything is copied);
- never copies bearer-token tables (`*_token`, `*_tokens`, `session`, `queue`, any case), and prunes any it copied before;
- starts every mysql and mysqldump child (the `mysqldump --help` capability probe included) through one helper, `spawnScoped`, which always starts it with `--no-defaults` first (no `/etc/mysql`, `/etc/my.cnf` or `~/.my.cnf` is read) and gives it a scrubbed environment with an empty private HOME (no `~/.mylogin.cnf`, never the parent's credential URLs or `MYSQL_*` settings), the run's lock descriptor and the run's deadline; a test fails if any other spawn appears;
- passes passwords only through each child's `MYSQL_PWD`, discards mysql's stderr, and reports a fixed code per step, so no value, host or credential reaches a log;
- writes `last-run.json` with table names, row counts, the row total and timings only, and prints one line in the same terms; every run that ends rewrites it (bad config, lock held and crashes included), and it says `running` while a copy is in progress;
- runs one at a time under a kernel `flock` on the lock file, held by the run and every mysql child it starts and released by the kernel when the last exits, so there is no stale lock and no takeover;
- refuses when source and target are the same server under different names (`@@server_uuid`), so staging and legacy must both be MySQL;
- reads `SHOW GRANTS` for the session and `@@mandatory_roles`, so a mandatory role cannot add a write privilege unseen;
- dumps with `--set-gtid-purged=OFF` (where mysqldump supports it), so no RELOAD is needed and no replication state reaches the mirror;
- bounds every wait: each mysql session has `lock_wait_timeout=600`, the whole run has a deadline (`LEGACY_REFRESH_TIMEOUT_MS`, default four hours) after which every child is killed and reaped, and a failing side of the copy stops the other;
- never writes a report that could replace the lock file: every report write (configuration errors included) first refuses a report path that is the lock path through a symlinked directory, a symlink or a hard link, and then reports on stderr only. Temp files are created exclusively and never replace an existing file. The only other files it touches are the lock file (opened for append, never truncated, replaced or deleted) and a private empty HOME for the mysql tools.

Configuration (root-only env file on the staging host): `LEGACY_REFRESH_SOURCE_URL` (read-only legacy account), `LEGACY_REFRESH_TARGET_URL` (mirror account, `legacy_mirror` database), optional `LEGACY_REFRESH_REPORT` and `LEGACY_REFRESH_LOCK`. Consumers read the mirror only after checking `last-run.json` says `ok`. The matrix row `REFRESH` closes with the first timer-triggered run's time and counts (the 2026-11-17 install run was manual, so it stays open until then).

## Mobile inventory

`tools/release-matrix/data/mobile-endpoints.json`: 120 method and path pairs read from `BAWES-Universe/studenthub-candidate` at `de3ac8c`, every call through the app's HTTP clients, each with its source line. 98 `serve`, 6 `retire` (discounts and wallet, pending SHU-213; one civil-ID lookup that points at `http://localhost` in the shipped source), 16 `open`. Which build users actually have installed is not established; the declared native versions are Android 1.4 and iOS 1.0.1. The legacy API has no version gate, so installed builds cannot be forced to update.

Two open questions, both technical, for agreement on the desk:

- **Sign-in on installed builds after 1 Jan (15 `/auth/*` routes).** The apps sign in with legacy email and password. After the legacy API is retired, something must check those passwords. Recommendation: import the legacy password hashes into a sealed table used only by the compatibility sign-in and the legacy link flow (Q14-L), delete each person's row once they have linked, and drop the table at K-8. This amends the M-3 line "no passwords, hashes or tokens imported", so it needs agreement. The alternative, keeping a legacy sign-in verifier running after 1 Jan, keeps a Yii2 dependency alive.
- **Uploads on installed builds (`GET /aws/config`).** The apps upload straight to cloud storage with credentials from this route; the platform never hands out cloud credentials. Recommendation: the compatibility route returns short-lived, single-object upload grants scoped to the person, and the follow-up `update-*` call admits the object through the normal document rules.
