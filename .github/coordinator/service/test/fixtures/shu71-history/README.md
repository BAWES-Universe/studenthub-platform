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

## R6 control-content and provenance boundary

The Git cross-check **cannot run in the shallow CI checkout**. Recorded digests check fixture consistency there; they do not establish
provenance. Only a full clone re-establishes provenance against Git. Each load prints
`SHU71_HISTORY_GIT_UNAVAILABLE` or `SHU71_HISTORY_GIT_VERIFIED`, with the exact
revision and module. Missing history is not a passing claim of Git provenance.
The synthetic-repository test checks only the Git comparison mechanism.

`controlContent` diagnoses the following cleanup text shapes before the Git comparison:

- Parent `5e25c65`: gate disarm is the first ordinary cleanup effect, before
  credential removal; there is no budget reservation or counter-fault fallback
  ahead of those effects. This is why the poisoned counter cannot veto cleanup.
- R4 blocked `e9a68c1`: reservation precedes ordinary disarm, and counter failure
  returns directly without a gate loop or credential removal. This is the
  zero-effect, armed-gate control on which the R4 differential depends.
- R5 blocked `0eeadd5`: reservation still precedes ordinary disarm; its fault
  fallback writes disabled gates but cannot remove the activation credential.
  Settlement trusts the counter boolean. These are the R5 differential's two
  distinguishing behaviors. None of these production controls has the later
  reservation-evidence binding or credential-removing fallback.
- All three journal controls validate sequence/hash links, repeat physical
  teardown effects, and veto retirement after failure. The production controls
  depend on those journal semantics. Their journal bytes are identical to the
  candidate's journal, so substitution of those identical bytes is harmless.

The guard is pure text matching over source with whole-line comments and whitespace
stripped. It is a diagnostic aid, **not a security control**: a semantics-preserving
rewrite can evade it completely. It does not uniquely pin `5e25c65`; the older real
revisions `eb29fc2` and `dae5948` satisfy its properties and behavioral premises.
The **load-bearing backstop** is the `historical control semantics` tests, which
execute the vendored production/journal pairs on disposable boundaries, together
with the downstream behavioral differentials. Those tests remain intact.

Each of the 18 retained diagnostic properties now has a separate negative text
case requiring its exact property error. Deleting any single check fails the
named `SHU71_CONTROL_PROPERTY_<property>` assertion. None was removed. A vendored
revision absent from `controlRevisions` fails with
`SHU71_HISTORY_CONTROL_UNREGISTERED`; the synthetic Git-mechanism test explicitly
registers its revision in its disposable helper, with no loader bypass.

A coordinated adversary who rewrites fixtures, digests and tests can defeat
repository-local checks. An unrelated substitution preserving the checked text
properties is not proven to be the historical source. Full-history byte comparison remains necessary for that
stronger claim. No workflow, skip allowance or historical fixture was changed.
