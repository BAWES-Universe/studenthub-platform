# SHU71 differential source custody

These are byte-for-byte copies of `.github/coordinator/service/shu71-production.mjs`
and `shu71-journal.mjs`, extracted with `git show <revision>:<path>`:

- `5e25c651254a72adbb46fa8f950df95248b640e9`: R4/R5 parent.
- `e9a68c156a0b8631b314d8d14c626ba31014a882`: R4 blocked head.
- `0eeadd5f05abc8cd82968a855b2bff8cc137c65a`: R5 blocked head.

`sha256.json` records the SHA-256 of each unmodified source. The shared
`shu71-history.mjs` reader checks that digest on every load, before import-path
rewriting. Whenever the revision exists in the local Git object database, it
also checks `git show` bytes against both the manifest and the fixture. Missing
history in a shallow checkout does not prevent execution: the recorded fixture
is still mandatory and verified. Missing fixtures, unrecorded revisions,
digest mismatches, and failures reading an available revision produce named
`SHU71_HISTORY_*` errors with repair instructions; they never skip a test.

The loader does not fetch history. As before, historical production imports
use the historical journal and the candidate's other dependencies, and all
executions use disposable production boundaries. These fixtures provide
source-level differential evidence only: B1 remains BLOCKED; B2/B4 remain
source-level only.

To audit custody in a full-history checkout, run:

```
node --test .github/coordinator/service/test/shu71-history.test.mjs
```

To exercise both differential modules without history, clone this branch via
`git clone --depth 1 --branch chore/shu71-production-composition <repository>`
(use a `file://` URL for a local repository), then run the entire
`shu71-trust.test.mjs` file. No test-name filtering or skip allowance is needed.
