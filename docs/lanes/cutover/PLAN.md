# Importer, release matrix and mobile exit lane

Lane in the full-migration plan agreed on the desk (PR #393, 2026-11-17): verified release candidate on 17 Dec, full migration live on 1 Jan, payroll workbook included. Owner Claude; reviewer GPT or Codex on the box, at the exact head. Outcome contracts: `contracts/ops-migration-cutover.md` (M-1 to M-7, K-1 to K-8) in the project files.

## Lease

| | |
|---|---|
| Paths | new `tools/release-matrix/**`; new `docs/lanes/cutover/**`; `tools/legacy-import/**` (additive; the pay lane reads it); new `packages/db/src/import/**` and `packages/db/test/import-*.test.ts`; one additive `./import` export in `packages/db/package.json` when the first store lands; the platform side of the mobile compatibility layer under new `apps/gateway/src/mobile-compat/**` (its one wiring seam is reserved separately, later) |
| Migrations | 0650 to 0699 |
| Excluded | gateway `index.ts`, `routes/`, `wiring/`, `web-ui.ts`, `login-runtime.ts`; workflows; `.github/coordinator/**`; every other lane's paths |

## What "done" means for this lane

1. **Release matrix** (this PR). `tools/release-matrix/matrix.json` has one row for each of the 77 target screens and 7 exclusions in the SHU-235 contract, each of the 120 mobile endpoints, the seven import domains and the release steps. A gate closes only with evidence (PR and head, or a run). `cli.js check` runs in CI through the test suite; `cli.js release` must pass for the 17 Dec candidate. The test also enforces SHU-235 section 7: deleting or duplicating any of the 382 legacy ordinals fails.
2. **Importer.** Order: M-4 catalogues and organizations with id maps, M-1 people, M-3 link report, M-2 documents, M-5 work, recruit and finance history, M-7 incremental, then M-6 full rehearsal. Each step is idempotent, writes a reconciliation report with legacy ids only, is tested on synthetic fixtures shaped like legacy, and closes its `built` and `dryRun` gates. `rehearsal` and `reconciled` close on the staging copy.
3. **Mobile exit.** Inventory done (below). The compatibility layer serves every `serve` route with the legacy shape in the 17 Dec candidate; `retire` routes answer with the legacy error shape; the legacy API is retired on 1 Jan, tested against traffic captured from a store build.
4. **Rollback.** K-5 rehearses final sync, single-writer cutover and rollback on staging before 17 Dec.

## Dates

| Date | This lane |
|---|---|
| 1 Dec | matrix live with lanes recording evidence; importer dry runs for M-4 and M-1; first importer rehearsal on staging (needs the refresh below); mobile inventory confirmed against a store build |
| 10 Dec | every import domain built and dry-run; compatibility layer for all `serve` routes on main |
| 17 Dec | matrix `release` passes: every gate closed with evidence or a recorded waiver; rollback rehearsed |
| 31 Dec to 1 Jan | final sync (M-7), K-6 go/no-go with Khalid, K-7 switch |

## Daily read-only legacy refresh on staging (designed, not enabled)

Needed by the importer rehearsal and the pay shadow month. Not enabled until Khalid authorizes it; the matrix row `REFRESH` stays open until then.

- Source: a read-only database user on a legacy replica or nightly dump. No legacy write path, no legacy API calls.
- Target: a staging-only `legacy_mirror` schema, replaced whole each night. Production has no such schema.
- Consumers read the mirror only: the importer rehearsal (M-6, M-7) and the payroll replay and shadow. No worker that sends email, SMS or push runs against imported rows; the outbox stays disabled on that staging stack.
- No production credentials in staging workers; the read-only credential lives only in the refresh job.
- Each run records row counts per table and a duration (X-2 job runs), and a failed or missed run raises one alert.

## Mobile inventory

`tools/release-matrix/data/mobile-endpoints.json`: 120 method and path pairs read from `BAWES-Universe/studenthub-candidate` at `de3ac8c`, every call through the app's HTTP clients, each with its source line. 98 `serve`, 6 `retire` (discounts and wallet, pending SHU-213; one civil-ID lookup that points at `http://localhost` in the shipped source), 16 `open`. Which build users actually have installed is not established; the declared native versions are Android 1.4 and iOS 1.0.1. The legacy API has no version gate, so installed builds cannot be forced to update.

Two open questions, both technical, for agreement on the desk:

- **Sign-in on installed builds after 1 Jan (15 `/auth/*` routes).** The apps sign in with legacy email and password. After the legacy API is retired, something must check those passwords. Recommendation: import the legacy password hashes into a sealed table used only by the compatibility sign-in and the legacy link flow (Q14-L), delete each person's row once they have linked, and drop the table at K-8. This amends the M-3 line "no passwords, hashes or tokens imported", so it needs agreement. The alternative, keeping a legacy sign-in verifier running after 1 Jan, keeps a Yii2 dependency alive.
- **Uploads on installed builds (`GET /aws/config`).** The apps upload straight to cloud storage with credentials from this route; the platform never hands out cloud credentials. Recommendation: the compatibility route returns short-lived, single-object upload grants scoped to the person, and the follow-up `update-*` call admits the object through the normal document rules.
