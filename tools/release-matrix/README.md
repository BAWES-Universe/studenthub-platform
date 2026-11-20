# Release matrix

One row for everything that has to be true before the full migration goes live: each target screen and exclusion in `docs/parity/target-screen-navigation-contract.md`, each endpoint the shipped mobile app calls (`data/mobile-endpoints.json`), each import domain and each release step. Plan: `docs/lanes/cutover/PLAN.md`.

```
npm run build
node dist/tools/release-matrix/src/cli.js check     # structure; also enforced by the test suite
node dist/tools/release-matrix/src/cli.js report    # open gates by lane
node dist/tools/release-matrix/src/cli.js release [candidate|cutover|retired]   # exits 1 while a gate due by then is open
node dist/tools/release-matrix/src/cli.js seed      # re-derive rows after the contract or inventory changes (refuses invalid sources)
node dist/tools/release-matrix/src/cli.js burndown [YYYY-MM-DD]   # closed gates by section and the daily rate needed to each date
```

## Closing a gate

Edit `matrix.json`. A gate is `{"state": "open"}`, `{"state": "done", "evidence": "..."}` or `{"state": "waived", "decision": "..."}`. The check refuses evidence that does not cite one of:

- `PR #512 at 1a2b3c4` (a pull request at an exact commit, 7 to 40 hex characters);
- `run https://github.com/<owner>/<repo>/actions/runs/<id>` (a CI or workflow run);
- `PR #504 comment 6954521676` (a run report posted as a pull request comment).

A waiver must cite `contracts/decisions-<date>.md` or the desk comment that agreed it (`PR #393 comment <id>`). A citation is a whole token: `PR #512 at 1a2b3c4-rc` or `contracts/decisions-2026-10-27.md.bak` cite nothing. Free text may surround the citation, and it may end a sentence. A lane closes its own gates in the PR that earns them; the reviewer checks the evidence with the code.

Gates: screens `built` (on main with tests) and `verified` (journey walked on staging against the refreshed copy); exclusions `decision` (SHU-213); mobile `built` (compatibility route or retirement on main) and `verified` (contract test against captured store-build traffic); imports `built`, `dryRun`, `rehearsal`, `reconciled`; release steps `done`.

## Built screens prove themselves

A screen's `built` gate closes only with a `served` list: where the screen is served on main and the test that requests it.

```json
"C-11": {
  "lane": "work",
  "subject": "`/work/track` — clock/manual session",
  "served": [{ "route": "/work/track", "test": "apps/gateway/test/work-pages.test.ts" }],
  "gates": { "built": { "state": "done", "evidence": "PR #600 at 1a2b3c4" }, "verified": { "state": "open" } }
}
```

A route may name parameters (`/store/:storeId/time-approvals`). Every literal part of it must appear in `apps/gateway/src` (as a string or escaped in a regular expression) and in the cited test file, and the test file must exist under `apps`, `packages` or `tools`. The served route may differ from the contract's target route (staff pages live under `/workspace` and `/recruit/staff`); the row says where the screen really is instead of hiding the difference.

`check` (and the test suite) re-proves every entry on every PR. Deleting a page, renaming its route or dropping its test fails the check, so a closed gate cannot regress silently. Seeding keeps `served` while the row's subject holds and drops it with the gates when the subject changes.

An open gate may carry a `note` saying why it is open (`"backend only: ..."`, `"partly built: ..."`); notes are kept across seeds.

## Marking gates as you merge

Each lane closes its own gates in the PR that earns them, in the same diff as the code:

1. A PR that ships a screen's page adds the row's `served` entry and sets `built` to done, citing the PR at its head (`PR #N at <sha>`). Push the matrix change last, once the head is final, or cite the head in a follow-up commit.
2. A PR that ships part of a screen updates the open gate's `note` so the checklist says what is left.
3. A journey walked on staging closes `verified` with the run (`run https://github.com/.../actions/runs/<id>`) or the run report comment.
4. The reviewer checks the evidence with the code. `burndown` is the honest count; post it, do not restate it.

## Checkpoints

`release candidate` (the default, 17 Dec) checks every row except the steps that can only happen later: K-6, K-7, PAY-SHADOW, SWITCHES and MOBILE-RETIRE belong to `cutover` (31 Dec to 1 Jan), and K-8 to `retired`. K-1 is a candidate gate: building the maintenance mode and rehearsing its rollback; switching it on in production is part of K-7. MOBILE-COMPAT is a candidate gate too: installed store builds proven against the platform's mobile API on staging; retiring the legacy API is MOBILE-RETIRE, at cutover. Each checkpoint also checks everything before it.

## Evidence follows its subject

Each screen and exclusion row records the route it was checked against, and each mobile row records its target and disposition (`subject`). Import domains and release steps record their requirement revision (`requirement r1`, from `REQUIREMENT_REVISION` in `src/matrix.ts`); bump it when what the row asks for changes, not when its title is reworded. If the contract, inventory or a revision changes a subject, `check` fails until `seed` runs, and `seed` reopens that row's gates: evidence for the old route, disposition or requirement does not prove the new one.

The checks also refuse a gate value that is not an object, an inventory method outside GET, POST, PATCH, PUT and DELETE, a partition declared more than once (every "complete, gap-free partition:" sentence is read, wrapped or capitalised), an appendix total declared twice, and a key written twice in `matrix.json` or the mobile inventory (`json.duplicateKey`, since `JSON.parse` would keep only the last). `seed` refuses to write while the contract or the inventory fails a check, or while either JSON file has a duplicate key. It does not check the previous matrix's gate values, so stale rows still regenerate.

Inventory source citations point into the repository and revision the inventory pins in `source.repository` (an `owner/name`) and `source.revision` (a 7 to 40 hex commit); the check refuses an inventory without that pin. Each citation must be a normalized repository-relative `path:line` with a line from 1: no absolute path, backslash, empty, `.` or `..` segment. That is a check of form only. The pinned repository is not in this tree, so the check cannot tell whether a cited file or line exists at that revision; the reviewer of an inventory change confirms that.

The contract parser reads a strict subset of GitHub markdown, the one the contract uses, so what it counts is what a reader sees: ATX headings, GFM tables (after a blank line or heading, with a matching delimiter row and the same cell count on every row, ended by a blank line or heading), paragraph and list text, all starting in column 1, and blank lines. Every other construct is refused by line as `contract.markdown.unsupported` rather than modelled: indentation of any kind (code blocks, list continuations, tabs), fence-like lines whether or not CommonMark would open a fence, HTML blocks and inline HTML outside code spans (autolinks included), block quotes, setext underlines and thematic breaks, link reference definitions, HTML entities and backslash escapes outside code spans, links or images in table rows, escaped pipes in table rows (in code or not), table rows of the wrong width, pipe rows outside a table, and text inside a table. A refusal keeps the table context: a refused header row still opens its table and a refused body row is still a row, so only the refused line is reported (and its ordinals become gaps). A refused line that starts a new block (fence, HTML, block quote, thematic break) ends the table, as GFM does.

## Why the ledger check lives here

SHU-235 section 7 asks the delivery lane for a validator that fails when any legacy source ordinal is deleted or duplicated. `checkContract` is that validator; the tests apply both mutations to the real contract.
