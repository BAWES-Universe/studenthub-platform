# StudentHub safe-write contract

`@studenthub/safe-write-contract` is the executable SHU-82 contract for the
platform's **first write**.

Everything shipped so far reads. The gateway's only write routes are `/logout`
and `/mcp/tools/call`, whose tools read. This package states what a safe write
must do — preview, confirm, action token, receipt — as rules that can be run
rather than rules that can be agreed with.

It has no I/O: no route, no database handle, no network call, no credential. The
store is a port the caller supplies, which is what lets a scenario *prove* "a
preview writes nothing" instead of asserting it.

```ts
import { createSafeWrite, runSafeWriteConformance } from "@studenthub/safe-write-contract";

const report = runSafeWriteConformance((input) => createSafeWrite(input));
assert.equal(report.ok, true, JSON.stringify(report.results, null, 2));
```

## Why a contract before a route

The first write is where a class of mistakes becomes possible for the first
time, and they are not mistakes a test finds by accident:

- a confirm that applies something other than what the preview showed
- a token that can be replayed, or reused for a different change
- a preview that reads a record its caller does not own
- a write that succeeds while its receipt fails, leaving an unaudited mutation
- a receipt that records the outcome and, with it, the person's data

## The rules

Each is a named scenario in `src/conformance.ts`, and each is bound by a
deliberately broken variant in `test/faulty-implementations.ts`.

| Rule | What it means |
| -- | -- |
| Preview is inert | A preview names the field with its before and after value, and writes nothing. The store snapshot is identical afterwards. |
| Confirm applies the preview | What lands is what was shown. A confirm that validates one change and commits another fails. |
| Tokens are unforgeable | A token carries an HMAC over its own fields. Without it every field is caller-suppliable, so a caller could mint one and confirm a change **no preview ever showed** — skipping the one step the token exists to make unskippable. Checked first, because a token this implementation never issued is unauthentic whatever else it claims. |
| Tokens bind the change set | The token commits to a digest over `(record, field, value)`. A confirm carrying a different change set is refused **before** anything is written. This is the reason a token exists. |
| Tokens are single-use, expiring, caller-bound | Replay is refused, an expired token is refused, and a token issued to one principal cannot be spent by another. |
| Own record only | Enforced at preview *and* re-derived at confirm. A grant revoked between the two is noticed: a token is not an authorization. |
| Receipt is part of the transaction | A mutation whose receipt cannot be written does not commit. Proven by a store that fails the commit and a record that is unchanged afterwards. |
| A failed write stays retryable | A receipt failure means nothing happened, so the token is *not* spent. Spending it would strand a person whose change never applied. |
| Values are exact | Edge whitespace is refused, never trimmed. Cleaning `" x "` into `"x"` stores something other than what the person was shown. |
| Receipts carry references | SHA-256 references, field names, closed-vocabulary values and timestamps — nothing else. |
| Refusals are typed | Every refusal names a reason from a closed vocabulary, and no refusal carries record content. |

### On the receipt rule

Under `sub_mode = user_email`, Universe issues `sub` as the user's email address.
A receipt that echoed a subject would be publishing personal data into an audit
surface built to be shared. So the check is inverted rather than defensive:
**every string a receipt contains must match an approved shape.** Chasing
individual leaks only finds the field somebody thought to plant a canary in;
requiring an approved shape catches the field nobody predicted.

## What the test suite proves

`npm test` runs the sixteen scenarios against the real implementation, and then:

- **A no-fault control.** The fault wrapper with no fault set passes every
  scenario, so each fault's failures are attributable to the fault.
- **Sixteen faults, each with a declared failure set.** Every fault must fail
  exactly the scenarios it declares. A fault that fails more has stopped being
  surgical; one that fails fewer means a scenario is not reading the behaviour
  it names. Three faults legitimately break several scenarios, and are declared
  that way rather than narrowed to make the table look tidier.
- **Every scenario is bound.** No scenario is absent from every fault's set. A
  scenario nothing can break is not a control.
- **Anti-circularity.** Two implementations break the contract with **no fault
  flag set at all**, and the suite must still reject them. A harness reading its
  own flags rather than behaviour would pass them.
- **The fixtures carry what the negative assertions look for**, so the "must not
  appear" checks cannot pass vacuously.

## A fourth rule this contract only has because a reviewer found it missing

The first published head of this package was **forgeable**. `confirm` checked
that a token was unspent, unexpired, caller-matching and change-set-matching —
but never that any `preview` had issued it. Every field was caller-suppliable
and `changeSetDigest` is exported, so a caller could mint a token and write
directly. Reproduced against the real implementation: a write completed, the
record changed, `commits: 1`.

That defeats the entire point of the contract. Sentry's review found it; fifteen
scenarios of my own did not. Tokens are now signed and verified, `token_not_issued`
joins the closed vocabulary, and the rule has a scenario and a fault of its own.

The `spent` set in the reference implementation is in-memory, which is fine for a
contract with no I/O. **SHU-84 must make single-use durable**, or a restart
re-opens replay.

## Three rules this contract only has because a mutation found them missing

The scenario set was mutation-tested against its own implementation. Three
source mutations initially failed *nothing*, or failed only a scenario that
happened to include the case among several others:

1. Removing the preview's own-record check surfaced only inside a general
   refusal scenario. Authorization deserves a scenario that names it.
2. Trimming edge whitespace instead of refusing it, likewise.
3. Spending the token before the commit could fail was caught by **no scenario
   at all** — an implementer could satisfy the whole contract and still lock a
   person out after a failed write.

All three are now named scenarios with their own faults. They are recorded here
because a contract that was never attacked is a contract whose gaps are unknown,
not absent.

## Fixtures

Every fixture value is invented and lives in `src/fixtures.ts`. Identifiers are
self-describing (`owner@example.invalid`, `canary-value-must-not-escape`) so a
real identifier appearing in this package, its reports, or a pull request
quoting them is visible at a glance.

## Boundaries

- No I/O: no route, no database, no network, no credential.
- No production or legacy write; this package decides nothing about which field
  a deployment may change. That is SHU-83's decision, and the policy is an input.
- No personal data in fixtures, tests, or anything they print.
