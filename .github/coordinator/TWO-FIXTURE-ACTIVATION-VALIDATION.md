# Two-fixture reviewed activation validation

Starting clone: `/home/bawes/work/act2`; branch:
`feat/two-fixture-lanes-extended`. Confirmed clean starting HEAD before edits:
`df0d4f048228e08c765c026ebe608eb99a65177f`.

The added versioned verifier binds the exact fixture pair, complete lane
objects, per-lane seed SHAs, executing coordinator/main revision, concurrency
two, expiry, stop-before-merge and signed reviewed/runtime gate states.
The existing single-fixture schema and assertions are retained.

Both full commands were run independently from the repository root with
`umask 0002`. Before coordinator runs, `chmod -R go-w .github/coordinator`
was applied. Results are reported separately; npm counts are not combined
with coordinator counts.

| Command | Before | After |
| --- | --- | --- |
| `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` | 873 tests; 866 pass; 0 fail; 7 skipped | 897 tests; 890 pass; 0 fail; 7 skipped |
| `npm test` | Exit 2 during build; 0 tests executed | Exit 2 during build; 0 tests executed |

Both root npm attempts stop at TypeScript TS2688: cannot find the `node` type
definition file, while building `@bawes/actor-assertion`. Dependencies were not
installed. Therefore no successful root npm test result is claimed.

## New test names (24)

- `ACT_MISSING_FIXTURE: positive control and named refusal`
- `ACT_EXTRA_FIXTURE: positive control and named refusal`
- `ACT_LANE_CROSS: positive control and named refusal`
- `ACT_DUPLICATE_LANE: positive control and named refusal`
- `ACT_CAPACITY_DRIFT: positive control and named refusal`
- `ACT_STALE_SEED_HEAD: positive control and named refusal`
- `ACT_MALFORMED: positive control and named refusal`
- `ACT_PARTIAL_ARMING: positive control and named refusal`
- `ACT_MANUAL_GATE_BYPASS: positive control and named refusal`
- `ACT_BOUND_FIELDS: every required field, SHA, expiry, lane and capacity is enforced`
- `ACT_REVIEW_SIGNATURE: unsigned, altered, wrong-key and manual committed gates refuse`
- `ACT_REVIEWED_PATH: in-memory record reaches existing status without creating a file or setting a gate`
- `ACT_GATES_OFF: actual tick has zero launches and writes; manual pair gates cannot bypass review`
- `ACT_REMOTE_EVIDENCE: real helper resolves both heads and identities through read-only API doubles`
- `ACT_REMOTE_FAILURE: absent credentials and failed API reads cannot supply evidence`
- `ACT_MUTATION ACT_MISSING_FIXTURE: removed guard dies by named AssertionError`
- `ACT_MUTATION ACT_EXTRA_FIXTURE: removed guard dies by named AssertionError`
- `ACT_MUTATION ACT_LANE_CROSS: removed guard dies by named AssertionError`
- `ACT_MUTATION ACT_DUPLICATE_LANE: removed guard dies by named AssertionError`
- `ACT_MUTATION ACT_CAPACITY_DRIFT: removed guard dies by named AssertionError`
- `ACT_MUTATION ACT_STALE_SEED_HEAD: removed guard dies by named AssertionError`
- `ACT_MUTATION ACT_MALFORMED: removed guard dies by named AssertionError`
- `ACT_MUTATION ACT_PARTIAL_ARMING: removed guard dies by named AssertionError`
- `ACT_MUTATION ACT_MANUAL_GATE_BYPASS: removed guard dies by named AssertionError`

## Mutation AssertionErrors

Every mutation removes the corresponding production guard and reruns the
named positive/refusal test in an isolated temporary copy. The harness requires
exit 1, `AssertionError`, and the exact assertion message below; SyntaxError,
TypeError and missing-module crashes are rejected as kills. Positive controls
pass before each invalid input is checked.

- `AssertionError [ERR_ASSERTION]: ACT_MISSING_FIXTURE: invalid binding must refuse`
- `AssertionError [ERR_ASSERTION]: ACT_EXTRA_FIXTURE: invalid binding must refuse`
- `AssertionError [ERR_ASSERTION]: ACT_LANE_CROSS: invalid binding must refuse`
- `AssertionError [ERR_ASSERTION]: ACT_DUPLICATE_LANE: invalid binding must refuse`
- `AssertionError [ERR_ASSERTION]: ACT_CAPACITY_DRIFT: invalid binding must refuse`
- `AssertionError [ERR_ASSERTION]: ACT_STALE_SEED_HEAD: invalid binding must refuse`
- `AssertionError [ERR_ASSERTION]: ACT_MALFORMED: invalid binding must refuse`
- `AssertionError [ERR_ASSERTION]: ACT_PARTIAL_ARMING: invalid binding must refuse`
- `AssertionError [ERR_ASSERTION]: ACT_MANUAL_GATE_BYPASS: invalid binding must refuse`

## Boundaries and limitations

- Committed `enable_dispatch` remains false; no operational runtime gate was changed.
- The verifier has no gate setter or activation-record writer. Test records and signing keys exist only in memory. The tick regression checks input immutability, zero adapter launches and zero writes.
- No host service, `/srv`, Linear card, fixture branch, SHU-140 seed or coordinator/SHU-140 was accessed or modified by this work. Tests use offline doubles and isolated temporary test resources.
- No push, PR interaction, deployment, installation, arming or live proof was performed.
- No operational review public key was provisioned. Without the separately reviewed trust anchor and valid signed envelope, the pair remains refused.
- Production revalidation requires both read-only API credentials and both resolvable fixture identities and heads. These reads were tested with API doubles, not live credentials.
- Strict seed equality is enforced on every revalidation. Advancing either fixture branch refuses the pair. This is narrower than legacy single-fixture same-branch continuation; no manual reseeding or ref repair is authorized.
- Existing receipt/routing modules and fixture configuration were not edited. The full coordinator run retains their writer-lock and author-exclusion regressions.
