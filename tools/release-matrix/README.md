# Release matrix

One row for everything that has to be true before the full migration goes live: each target screen and exclusion in `docs/parity/target-screen-navigation-contract.md`, each endpoint the shipped mobile app calls (`data/mobile-endpoints.json`), each import domain and each release step. Plan: `docs/lanes/cutover/PLAN.md`.

```
npm run build
node dist/tools/release-matrix/src/cli.js check     # structure; also enforced by the test suite
node dist/tools/release-matrix/src/cli.js report    # open gates by lane
node dist/tools/release-matrix/src/cli.js release [candidate|cutover|retired]   # exits 1 while a gate due by then is open
node dist/tools/release-matrix/src/cli.js seed      # re-derive rows after the contract or inventory changes (refuses invalid sources)
```

## Closing a gate

Edit `matrix.json`. A gate is `{"state": "open"}`, `{"state": "done", "evidence": "..."}` or `{"state": "waived", "decision": "..."}`. The check refuses evidence that does not cite one of:

- `PR #512 at 1a2b3c4` (a pull request at an exact commit, 7 to 40 hex characters);
- `run https://github.com/<owner>/<repo>/actions/runs/<id>` (a CI or workflow run);
- `PR #504 comment 6954521676` (a run report posted as a pull request comment).

A waiver must cite `contracts/decisions-<date>.md` or the desk comment that agreed it (`PR #393 comment <id>`). A citation is a whole token: `PR #512 at 1a2b3c4-rc` or `contracts/decisions-2026-10-27.md.bak` cite nothing. Free text may surround the citation, and it may end a sentence. A lane closes its own gates in the PR that earns them; the reviewer checks the evidence with the code.

Gates: screens `built` (on main with tests) and `verified` (journey walked on staging against the refreshed copy); exclusions `decision` (SHU-213); mobile `built` (compatibility route or retirement on main) and `verified` (contract test against captured store-build traffic); imports `built`, `dryRun`, `rehearsal`, `reconciled`; release steps `done`.

## Checkpoints

`release candidate` (the default, 17 Dec) checks every row except the steps that can only happen later: K-6, K-7, PAY-SHADOW, SWITCHES and MOBILE-RETIRE belong to `cutover` (31 Dec to 1 Jan), and K-8 to `retired`. K-1 is a candidate gate: building the maintenance mode and rehearsing its rollback; switching it on in production is part of K-7. MOBILE-COMPAT is a candidate gate too: installed store builds proven against the platform's mobile API on staging; retiring the legacy API is MOBILE-RETIRE, at cutover. Each checkpoint also checks everything before it.

## Evidence follows its subject

Each screen and exclusion row records the route it was checked against, and each mobile row records its target and disposition (`subject`). Import domains and release steps record their requirement revision (`requirement r1`, from `REQUIREMENT_REVISION` in `src/matrix.ts`); bump it when what the row asks for changes, not when its title is reworded. If the contract, inventory or a revision changes a subject, `check` fails until `seed` runs, and `seed` reopens that row's gates: evidence for the old route, disposition or requirement does not prove the new one.

The checks also refuse a gate value that is not an object, an inventory method outside GET, POST, PATCH, PUT and DELETE, a source citation that is not `file:line`, a ledger row inside a fenced example block (it no longer counts), and an appendix total declared twice.

## Why the ledger check lives here

SHU-235 section 7 asks the delivery lane for a validator that fails when any legacy source ordinal is deleted or duplicated. `checkContract` is that validator; the tests apply both mutations to the real contract.
