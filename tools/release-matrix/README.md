# Release matrix

One row for everything that has to be true before the full migration goes live: each target screen and exclusion in `docs/parity/target-screen-navigation-contract.md`, each endpoint the shipped mobile app calls (`data/mobile-endpoints.json`), each import domain and each release step. Plan: `docs/lanes/cutover/PLAN.md`.

```
npm run build
node dist/tools/release-matrix/src/cli.js check     # structure; also enforced by the test suite
node dist/tools/release-matrix/src/cli.js report    # open gates by lane
node dist/tools/release-matrix/src/cli.js release   # exits 1 while any gate is open
node dist/tools/release-matrix/src/cli.js seed      # re-derive rows after the contract or inventory changes
```

## Closing a gate

Edit `matrix.json`. A gate is `{"state": "open"}`, `{"state": "done", "evidence": "..."}` or `{"state": "waived", "decision": "..."}`. The check refuses evidence that does not cite one of:

- `PR #512 at 1a2b3c4` (a pull request at an exact commit, 7 to 40 hex characters);
- `run https://github.com/<owner>/<repo>/actions/runs/<id>` (a CI or workflow run);
- `PR #504 comment 6954521676` (a run report posted as a pull request comment).

A waiver must cite `contracts/decisions-<date>.md` or the desk comment that agreed it (`PR #393 comment <id>`). Free text may follow the citation. A lane closes its own gates in the PR that earns them; the reviewer checks the evidence with the code.

Gates: screens `built` (on main with tests) and `verified` (journey walked on staging against the refreshed copy); exclusions `decision` (SHU-213); mobile `built` (compatibility route or retirement on main) and `verified` (contract test against captured store-build traffic); imports `built`, `dryRun`, `rehearsal`, `reconciled`; release steps `done`.

## Why the ledger check lives here

SHU-235 section 7 asks the delivery lane for a validator that fails when any legacy source ordinal is deleted or duplicated. `checkContract` is that validator; the tests apply both mutations to the real contract.
