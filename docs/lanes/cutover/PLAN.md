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
2. **Importer.** Order: M-4 catalogues and organizations with id maps, M-1 people, M-3 link report, M-2 documents, M-5 work, recruit and finance history (see the M-5 table map below), M-7 incremental, then M-6 full rehearsal. Each step is idempotent, writes a reconciliation report with legacy ids only, is tested on synthetic fixtures shaped like legacy, and closes its `built` and `dryRun` gates. `rehearsal` and `reconciled` close on the staging copy.
3. **Mobile exit.** Inventory done (below). The compatibility layer serves every `serve` route with the legacy shape in the 17 Dec candidate; `retire` routes answer with the legacy error shape; the legacy API is retired on 1 Jan, tested against traffic captured from a store build.
4. **Rollback.** K-5 rehearses final sync, single-writer cutover and rollback on staging before 17 Dec.

## Dates

| Date | This lane |
|---|---|
| 1 Dec | matrix live with lanes recording evidence; daily refresh running; importer dry runs for M-4 and M-1; first importer rehearsal on staging; mobile inventory confirmed against a store build |
| 10 Dec | every import domain built and dry-run; compatibility layer for all `serve` routes on main |
| 17 Dec | `release candidate` passes: every candidate gate closed with evidence or a recorded waiver; rollback rehearsed |
| 31 Dec to 1 Jan | final sync (M-7), K-6 go/no-go with Khalid, K-7 switch; `release cutover` passes |

## M-4 catalogue map

`tools/legacy-import/src/m4-catalogue.ts` maps each legacy catalogue table; `PostgresCatalogueImportStore` (`@studenthub/db/import`) writes the items and the id map (`legacy_id_maps`, migration 0650). Names use the catalogue's own normalization. Legacy wall times are read as Asia/Kuwait. A re-run with the same rows writes nothing; a changed row is a conflict with both digests and is never overwritten.

| Legacy table | Catalogue kind | Rules |
|---|---|---|
| `country` | `country` | name `country_name_en` |
| `currency` | `currency` | name `title`, code `code`; `status` 0 imports as deleted; symbol and decimal places go to the currency details when valid |
| `bank` | `bank` | name `bank_name`; `deleted` imports as deleted; swift, IBAN bank code, ABK code and transfer type (`LCL` local, `SWF` international, `TRF` within bank) go to the payment details when valid |
| `tag` | `tag` | name `tag` |
| `brand` | `brand` | name `brand_name_en`; the brand's company link comes with organizations |
| `mall` | `mall` | name `mall_name_en` |
| `university` | `university` | name `university_name_en`; `deleted` imports as deleted |
| `area` | `area` | name `area_name_en`; no area details, because they need a governorate that legacy does not hold (reported per row) |

Two active rows of one kind whose names normalize the same become one item: the lowest legacy id is imported and the others map to it (reported as merged). For currencies and banks, a same-name row whose code or typed details differ (including details on one side only) is not merged: it is reported as `catalogue.nameConflict` and left for hand reconciliation. A later same-name currency or bank alias is checked against the target's item as stored (which a digest conflict may keep at older content), not just mapped by id; and any later alias maps only when the target's stored item is still active and of the same kind and name, otherwise it is held as `name_conflict`. An active platform item with the same kind and name that no legacy row holds yet is adopted rather than duplicated; a currency or bank is adopted only when its code and details match, otherwise it is refused as `name_conflict`, nothing is written, and a re-run refuses it again. Reconciliation is per table: legacy ids against the id map, with reported skips listed apart from unexplained gaps.

## M-4 organizations map

`tools/legacy-import/src/m4-organizations.ts` maps legacy `company` rows; `PostgresOrganizationImportStore` (`@studenthub/db/import`) writes the organization, its approved snapshot (`legacy_company_snapshots`, migration 0651) and the id map. `PostgresImportedOrganizationSnapshots` is the `ApprovedOrganizationAdapter` the organizations package reads; wiring it into the gateway replaces the unconfigured adapter and is the organizations owner's step (gateway wiring is outside this lane).

- A top-level company hangs under the operator organization in the registry, as an approved registration does; its snapshot parent is null. A sub-company's parent is its legacy parent through the id map, so parents import first.
- The platform allows one level of sub-company. A deeper company, one whose parent is missing, and one in a parent loop are reported and left out with their descendants.
- A company deleted in legacy (`deleted = 1`, which legacy's CompanyQuery hides) is an exclusion, reported as `company.archived`; its children are held as `company.archivedParent`. A company archived after it was imported keeps its organization and is reported, never deleted by the importer.
- At write time a child maps only under a parent whose stored organization is still top level, in the registry and in its snapshot; otherwise it is held as `parent_not_top_level` (a digest conflict can keep a parent legacy has since moved).
- The snapshot holds the columns the organization projections read (`company_name`, common names, descriptions, website, email, `currency_code`, approved to hire, hourly rate, bonus commission, status override) and the three activity counters, each normalized to what the package parses: blank text is null, decimals lose padding zeros, the currency code is upper case, and the status override is 0, 9 or 10. An unusable value becomes null and is reported by column; the company still imports.
- Stamped with the organizations package's parity revision, as `snapshotRow` requires.

## M-4 stores and brand links map

`tools/legacy-import/src/m4-stores.ts` maps legacy `brand` company links and `store` rows; `PostgresStoreImportStore` (`@studenthub/db/import`) writes `organization_brands` (migration 0200), `organization_stores` (migration 0202) and the id map (legacy tables `brand_company` and `store`). Companies, brands and malls import first; this step resolves them through the id map.

- Each legacy brand belongs to one company (`brand.company_id`), and the platform links each brand item to one organization. Two same-name legacy brands share one catalogue item: the first company's link is kept, and the other is refused as `brand_taken`, never moved. A link that is already in place for the same organization is adopted.
- A store keeps its legacy name and location trimmed. A blank name, or one longer than the platform's 120 characters, is reported as `store.badName` and left out, never cut to fit. A location longer than 500 characters is reported and imported as none.
- A store's brand must be its own company's, as in legacy's store form and the platform's stores screen. Another company's brand, an unknown brand and an unusable reference are reported and dropped from the store. At write time a brand that is not linked to the store's organization is refused as `brand_not_linked`.
- A store deleted in legacy (`deleted = 1`) imports as removed, with its last update time as the removal time, so later work and assignment history can still name it. `store_status` is not read: legacy sets it to 10 on every store and never reads it. The store manager comes with contacts.
- Legacy times are Asia/Kuwait wall time. A row whose company, brand or mall has no id map row is refused by code (`no_organization`, `no_brand`, `no_mall`), and the batch goes on.

## M-5 table map (work)

Legacy staff ids resolve to the platform principal the same way for every row below; a staff id with no principal is reported by legacy id, not imported. Each table gets its own reconciliation count: legacy rows against imported rows by `legacy_ref`, by legacy id only. Legacy times are Asia/Kuwait wall time: a `work_date` is the Kuwait date read straight from that wall time, with no UTC conversion, so an answer or session at 21:00 to 23:59 keeps its own day.

| Legacy table | Platform table | Rules |
|---|---|---|
| `staff_work_session` | `work_staff_sessions` (migration 0505) | one row per legacy session |
| `daily_standup_question` | `work_standup_questions` (migration 0506) | `legacy_ref` = `question_uuid`; `retired_at` null |
| `daily_standup_answer` | `work_standup_answers` (migration 0506) | `source` = `import`; `legacy_ref` = `answer_uuid`; `work_date` = the Kuwait date of `created_at` as stored; the question text is copied as it read; repeated answers on a day are kept (the once-per-day index covers app answers only) |

## Daily read-only legacy refresh on staging

Approved by Khalid on 2026-11-17 (decision record "Added 2026-11-17"): read-only against legacy, no emails, SMS, push or webhooks from staging, real personal data never leaves staging, no production credentials in card workers, off the card-run path. It feeds the importer rehearsal and the pay lane's December shadow month, so it must run daily by 1 Dec.

Job: `tools/legacy-import/src/refresh-cli.ts` (`node dist/tools/legacy-import/src/refresh-cli.js`), run nightly by cron on the staging host, installed through a Hermes card. It:

- copies the legacy MySQL database into a staging database that must be named `legacy_mirror`, on a different host from the source, with one consistent snapshot (`mysqldump --single-transaction`), then drops mirror tables legacy no longer has;
- refuses to run unless the source account is read-only: `SHOW GRANTS` may list only `USAGE`, `SELECT` and `SHOW VIEW` (an allowlist; any other privilege, grant option or unreadable role grant stops it before anything is copied; a column list such as `SELECT (a, b)` counts as one privilege);
- refuses to run unless `SELECT` covers the whole source database (`` `db`.* `` or `*.*`, no column list and no partial revoke): with table-level grants the account would see only some tables, and the prune would silently drop the rest from the mirror;
- reads table names hex-encoded, so a name with a tab or newline cannot be split and pass as a different table, and refuses any name outside `[A-Za-z0-9_]` before it reaches a dump or a drop;
- names every copied table whose engine is not InnoDB in the report's `nonTransactional` list: `--single-transaction` gives those tables no snapshot, so their rows may be slightly later than the rest;
- on a target that folds table names to lower case (`lower_case_table_names` other than 0), refuses source names that fold together and compares names the same way when it prunes;
- never copies bearer-token, session or queue tables (names ending `_token` or `_tokens`, and `session`, `sessions`, `queue` or `queues`, any case), and prunes stale tables (an earlier copy of a now-excluded table included) before it copies and again after, with foreign key checks off for the drop;
- always connects over TCP (`--protocol=TCP`), so `localhost` in a URL cannot fall back to a Unix socket and reach another server;
- starts every mysql and mysqldump child (the `mysqldump --help` capability probe included) through one helper, `spawnScoped`, which always starts it with `--no-defaults` first (no `/etc/mysql`, `/etc/my.cnf` or `~/.my.cnf` is read) and gives it a scrubbed environment with an empty private HOME (no `~/.mylogin.cnf`, never the parent's credential URLs or `MYSQL_*` settings), the run's lock descriptor and the run's deadline; a test fails if any other spawn appears;
- passes passwords only through each child's `MYSQL_PWD`, discards mysql's stderr, and reports a fixed code per step, so no value, host or credential reaches a log;
- writes `last-run.json` with table names, row counts, the row total and timings only, and prints one line in the same terms; every run that holds the lock rewrites it however it ends (crashes and the deadline included), a configuration error writes it too where the path is safe (see below), and it says `running` while a copy is in progress; when a write cannot happen, the output line says so instead. A run refused because another holds the lock writes `last-refused.json` beside it instead, so it can never overwrite the owner's `running` or `ok` (a report path named `last-refused.json` is refused as `config.reportIsRefused`);
- runs one at a time under a kernel `flock` on the lock file, held by the run and every mysql child it starts and released by the kernel when the last exits, so there is no stale lock and no takeover;
- refuses when source and target are the same server under different names (`@@server_uuid`), so staging and legacy must both be MySQL;
- reads `SHOW GRANTS` for the session and `@@mandatory_roles`, so a mandatory role cannot add a write privilege unseen;
- dumps with `--set-gtid-purged=OFF` (where mysqldump supports it), so no RELOAD is needed and no replication state reaches the mirror;
- bounds every wait: each mysql session has `lock_wait_timeout=600`, the whole run has a deadline (`LEGACY_REFRESH_TIMEOUT_MS`, default four hours) after which every child is killed and reaped, and a failing side of the copy stops the other;
- never writes a report that could replace the lock file or the refusal record: every report write (configuration errors included) first refuses a report path that is the lock path through a symlinked directory, a symlink or a hard link, and a configuration error never writes to a report path named `last-refused.json`; either way it reports on stderr only. Temp files are created exclusively and never replace an existing file. The output line says `(report not written)` whenever the write did not happen. The only other files it touches are `last-refused.json`, the lock file (opened for append, never truncated, replaced or deleted) and a private empty HOME for the mysql tools.

Configuration (root-only env file on the staging host): `LEGACY_REFRESH_SOURCE_URL` (read-only legacy account), `LEGACY_REFRESH_TARGET_URL` (mirror account, `legacy_mirror` database), optional `LEGACY_REFRESH_REPORT` and `LEGACY_REFRESH_LOCK`. `LEGACY_REFRESH_TIMEOUT_MS` may be at most 2147483647 (Node's largest timer).

Reading the mirror: a consumer takes a shared lock on the same lock file (`flock --shared` on `LEGACY_REFRESH_LOCK`, the same path the job uses), then reads `last-run.json`, proceeds only if it says `ok`, and holds the shared lock until its read is finished. A refresh cannot start while any reader holds it (it exits `locked` and records that in `last-refused.json`), and a reader cannot start mid-copy, so no reader ever sees tables being replaced. Checking `ok` without the lock is not enough: the next refresh could start between the check and the read. The matrix row `REFRESH` is done: the first timer-triggered run on the #550 code (b8cd999), at 2026-11-20 00:30Z, ended `ok` with 123 tables and 865,915 rows, excluded the 7 bearer-token tables, listed no non-transactional tables and wrote no refusal record (PR #393 comment 7032910903). Before it, the 2026-11-19 repin ran once by hand with the same result (865,911 rows), over TCP with a database-wide `SELECT, SHOW VIEW` grant, and the mirror held no previously copied token, queue or session tables.

## Mobile inventory

`tools/release-matrix/data/mobile-endpoints.json`: 120 method and path pairs read from `BAWES-Universe/studenthub-candidate` at `de3ac8c`, every call through the app's HTTP clients, each with its source line (a `path:line` in that repository at that revision; `check` verifies the form and the pin, not that the line exists, so an inventory change needs its citations confirmed in review). 98 `serve`, 6 `retire` (discounts and wallet, pending SHU-213; one civil-ID lookup that points at `http://localhost` in the shipped source), 16 `open`. Which build users actually have installed is not established; the declared native versions are Android 1.4 and iOS 1.0.1. The legacy API has no version gate, so installed builds cannot be forced to update.

Two open questions, both technical, for agreement on the desk:

- **Sign-in on installed builds after 1 Jan (15 `/auth/*` routes).** The apps sign in with legacy email and password. After the legacy API is retired, something must check those passwords. Recommendation: import the legacy password hashes into a sealed table used only by the compatibility sign-in and the legacy link flow (Q14-L), delete each person's row once they have linked, and drop the table at K-8. This amends the M-3 line "no passwords, hashes or tokens imported", so it needs agreement. The alternative, keeping a legacy sign-in verifier running after 1 Jan, keeps a Yii2 dependency alive.
- **Uploads on installed builds (`GET /aws/config`).** The apps upload straight to cloud storage with credentials from this route; the platform never hands out cloud credentials. Recommendation: the compatibility route returns short-lived, single-object upload grants scoped to the person, and the follow-up `update-*` call admits the object through the normal document rules.

## Legacy-twin walker (verified gates)

`tools/legacy-import/src/twin` closes the release matrix's `verified` gates. For each journey it picks people from the refreshed legacy copy, reads what legacy showed them (read-only queries that follow the legacy controller, cited in each journey file), opens the same pages on staging in a real browser signed in as the same person, and compares the two fact sheets.

- A fact sheet maps paths built from fixed words, ISO dates and ids to values. Values never leave the staging host. The report (`last-walk.json`, mode 600) carries journeys, legacy person ids, counts, paths, difference kinds, decision citations and fixed codes, and `assertPrivate` re-checks every field before it is written.
- A difference is explained only by an entry in `tools/legacy-import/twin-explanations.json` citing `contracts/decisions-<date>.md` or `PR #393 comment <id>`. Anything else is a regression and keeps the gate open.
- A journey is verified when at least `TWIN_MINIMUM_PEOPLE` (default 5) people were walked, none regressed and no walk failed. A person not yet linked on the platform is a failure (`persona_unlinked`), not a skip, so verified gates move as the people and hours imports land on staging.
- `cli.js walk` runs on the staging host from a Hermes card, under `flock --shared` on the refresh lock, and refuses unless the last refresh is `ok`. It signs each person in with one session row and deletes it after their pages are read; it reaches only `https://staging.studenthub.co`.
- `cli.js walk` prints a receipt (walked revision, Kuwait month, the refresh run it read under the shared lock, and per journey its verdict, walked and distinct people, and match, explained, regression and error counts) and exits 0 only when every journey is verified (3 when one is open). The per-person report stays on the staging host, mode 600, and is never attached to a pull request.
- `cli.js close <report> "PR #n comment <id>"` runs where the report is, in a checkout of the walked revision plus evidence only. It is bound to the walked candidate: anything but `tools/release-matrix/matrix.json`, `docs/` or a `.md` file that differs from the walked revision, committed or not, refuses the close, so a new renderer, route, config or walker change means a new walk. It does not trust the report to describe itself: every journey must be one the code defines with exactly its screens, every journey the code says verifies a screen must be in the report and verified, and the minimum may not be below 5. It closes `verified` only where `built` is done, prints the receipt, each screen's outcome and the written matrix's sha256, and exits 3 unless every screen ended verified. The pull request carries the matrix change and that receipt.
- In the browser, every request and every redirect hop stays on the staging origin: the guard follows redirects itself, checks each hop before it is sent, and refuses any hop to another host or port.

Journeys: `work-history` (C-12) walks every route the screen covers: the month page `/work/history?month=` and the day page `/work/history/:date` for each day legacy shows (totals, then each session's start, end, minutes, status and manual mark). A journey must walk every route of each screen it claims, since closing the screen's gate verifies all of them. Next: profile (C-01), store time approvals (M-03), staff work logs (A-12), sign-in (U-02). Clock in and out (C-11) changes data, so it needs a write walk on a disposable person rather than a read comparison.
