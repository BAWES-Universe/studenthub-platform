# StudentHub source-connection import contract

`@studenthub/source-connection-contract` is the executable SHU-77 contract for
importing Discord and Google **source connections** into the StudentHub person
registry.

It normalizes raw donor rows into *candidate* identity links and conflict
reports. It has no I/O of any kind: no export reader, no credential, no database
handle, no network call. Nothing in this package writes to the platform or the
legacy system, and nothing in it reads one. The pipeline that eventually calls
it (SHU-75/76) is not part of this card.

```ts
import { dryRun, normalizeSourceConnections } from "@studenthub/source-connection-contract";

const result = normalizeSourceConnections(rows);
// result.accepted   -> candidate links, safe to act on
// result.rejected   -> rows that did not meet the contract, with masked ids
// result.conflicts  -> ambiguity a human must resolve; nothing was decided
```

## Why this contract has to say what it says

SHU-29's login binds an identity on the exact `(issuer, subject)` pair and
creates a new person on first login. It deliberately does **not** match on
email, phone, display name, or date of birth: `external_identities` has its
primary key on `(issuer, subject)`, and mutable profile fields are attributes,
never lookup keys. A real-Postgres test pins that behaviour.

An importer that attaches an external identity to an *existing* person is doing,
by construction, the thing that binding refuses to do. So this contract states
what evidence justifies a link rather than inheriting a matching heuristic (most
likely email) by accident.

## Open operator dependency: the input field names are not yet pinned

The field names in `RawSourceRecord` are this contract's own. They were not
derived from a donor schema, because there is no donor schema to derive them
from: the StudentHub Next donor baseline (`donor/studenthub-codex`, 129 Prisma
models) has no Discord or Google source-connection table, and neither does this
repository or `workadventure-universe-admin`. Whatever actually produces these
rows is a live Discord or Google export, and reading one needs credentials and
data authorization that SHU-77 explicitly excludes.

So this card stops where its boundaries say to stop, with the contract and the
fixtures, and records the dependency: **an operator with export access has to
map the real export columns onto `source`, `externalId`, `personId`,
`provenance` and `observedAt`.** Every rule below holds whatever those columns
turn out to be called, and the mapping is a thin adapter, not a change to the
rules.

## The rules

Each rule is a named scenario in `src/conformance.ts`, and each is bound by a
deliberately broken variant in `test/faulty-implementations.ts`.

| Rule | What it means |
| -- | -- |
| Required fields | `source`, `externalId`, `personId`, `provenance` and `observedAt` are all mandatory. Rule order is fixed, so a row failing several rules always reports the same reason. |
| Provenance | A row with no stated origin is rejected, never imported with a guessed one. Provenance is carried verbatim onto the candidate. |
| Unambiguous time | `observedAt` must be ISO-8601 with an explicit offset, a real calendar instant, and no more precision than can be stored. `"2026-01-02T03:04:05"` is local time to `Date`; `"2026-02-30T00:00:00Z"` parses as 2 March; `"…05.0001Z"` would be truncated to `.000`. All three are rejected rather than guessed at. |
| Exact identity keys | `externalId` and `personId` are used verbatim. Edge whitespace is rejected, not trimmed — cleaning `" z "` into `"z"` would merge a padded row into a different account's identity. Inner whitespace is the donor's business and is carried through. |
| Unambiguous keys | The grouping keys use a structured encoding, not a delimiter join. `("a b", "c")` and `("a", "b c")` are distinct triples and stay two candidates; a separator-joined key would silently drop one. |
| No matching on mutable claims | The only keys are `source`, `externalId` and `personId`. Profile claims are dropped at the boundary and never key, match, or join anything. |
| Idempotency | Rows collapse on the `(source, externalId, personId)` triple, the later `observedAt` refreshing the survivor, and output is sorted. Re-running an export, or running it with its rows shuffled, gives exactly the same accepted set. Two observations at the same instant are ordered by provenance, so a tie is resolved by the records rather than by export order. |
| Conflict, fails closed | One external identity claimed by more than one person: **neither** side is accepted, and a conflict is reported. |
| Ambiguity, fails closed | One person claimed by one source under more than one external id: **neither** account is accepted, and a conflict is reported. |
| Sensitive output | Rejections and conflicts carry masked identifiers only. No profile claim survives normalization, and a dry run carries counts, reasons and masks, never a raw identifier. |

Both conflict rules withhold rather than choose. A withheld candidate can be
imported after a human resolves it; a wrong identity link is permanent, so the
asymmetry decides the default.

The second conflict rule is deliberately conservative and scoped to a single
source. A person legitimately holding one Discord account and one Google account
is not a conflict. A person appearing under two Discord accounts in one export
might be legitimate, or might be a mis-keyed row, and this contract cannot tell
the difference, so it asks. Relaxing that is an operator decision, not a
normalizer one.

## Running the contract against an implementation

```ts
const report = runSourceConnectionConformance({ normalize, dryRun });
assert.equal(report.ok, true, JSON.stringify(report.results, null, 2));
```

## What the test suite proves

`npm test` runs the fourteen scenarios against the real implementation, and then:

- **A no-fault control.** The fault wrapper with no fault set passes every
  scenario, so each fault's failures are attributable to the fault.
- **Eighteen faults, each with a declared failure set.** Every fault must fail
  exactly the scenarios it declares and pass all the others. A fault that fails
  more has stopped being surgical; one that fails fewer means a scenario is not
  reading the behaviour it names.
- **Every scenario is bound.** No scenario is absent from every fault's declared
  set. A scenario nothing can break is not a control.
- **Anti-circularity.** Two implementations break the contract with **no fault
  flag set at all**, and the suite must still reject them. A harness that read
  its own flags rather than behaviour would pass them.
- **The fixtures carry what the negative assertions look for.** The profile
  canary and the raw identifiers are asserted present in the *input*, so the
  "must not appear in output" checks cannot pass vacuously.

## Fixtures

Every fixture value is invented and lives in one reviewable file,
`src/fixtures.ts`. Identifiers are self-describing (`person-alpha`,
`discord-uid-...`, `example.invalid`) so a real identifier appearing in this
package, its reports, or a pull request quoting them is visible at a glance.

## Boundaries this package keeps

- No live export, credential, network call, or database access.
- No production or legacy write, and no identity merge or account relink: the
  output is a candidate list and a conflict list, and something else decides.
- No personal data in fixtures, tests, reports, or anything they print.
