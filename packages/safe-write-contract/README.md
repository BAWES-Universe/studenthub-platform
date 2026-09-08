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

The port is **asynchronous**. Every real store this contract must bind is async,
and a synchronous port could not run against one — worse, it would accept a
Promise from `commit` and read a rejected write as a successful one, so the
"receipt is part of the transaction" rule would silently not hold. Synchronous
implementations still satisfy `Awaitable`.

```ts
import { createSafeWrite, runSafeWriteConformance } from "@studenthub/safe-write-contract";

const report = await runSafeWriteConformance((input) => createSafeWrite(input));
assert.equal(report.ok, true, JSON.stringify(report.results, null, 2));
```

## Why a contract before a route

The first write is where a class of mistakes becomes possible for the first
time, and they are not mistakes a test finds by accident:

- a confirm that applies something other than what the preview showed
- a token that can be replayed, or reused for a different change
- a preview that reads a record its caller does not own
- a write that succeeds while its receipt fails, leaving an unaudited mutation
- a confirm that overwrites a change the person never saw, because the record
  moved between the preview and the confirm
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
| Single-use is the store's job | The token id goes into the commit, and the store refuses one it has already committed. A caller-side `spent` set is per-instance and in-memory: it cannot see another process and does not survive a restart, so an implementation relying on it does not have a single-use token — it has one that is usually used once. |
| Ownership is re-checked inside the commit | The confirm re-derives ownership, then awaits twice more before writing. A grant withdrawn in that window is invisible to every check a caller can make, so the authorization predicate is evaluated in the same atomic operation as the mutation. |
| A refusal reveals nothing to someone who lost access | Ownership is re-derived *before* the current value is read, so a principal whose grant is gone is told that and nothing else. Check it later and the same caller is told `state_changed` instead — which discloses that a record they no longer own has been modified. |
| Tokens bind the transition, not just the destination | The token also carries a digest of the value the preview showed as *current*. A person who approved "A becomes C" has not approved "B becomes C", so a record that changed since the preview is refused `state_changed` rather than overwritten. |
| The compare belongs inside the commit | The confirm's own read cannot close the race — a writer can land between that read and the write. `commit` receives `expectedBefore` and must apply the change only if the stored value still equals it, as one atomic unit. A refused compare is reported, not thrown, and a confirm that ignored it would report a completed write that never happened. |
| Receipt is part of the transaction | A mutation whose receipt cannot be written does not commit. Proven by a store that fails the commit and a record that is unchanged afterwards. |
| A failed write stays retryable | A receipt failure means nothing happened, so the token is *not* spent. Spending it would strand a person whose change never applied. |
| Values are exact | Edge whitespace is refused, never trimmed. Cleaning `" x "` into `"x"` stores something other than what the person was shown. |
| Receipts carry references, positionally | Every key is checked against what is valid *there*: references where references belong, permitted field names in `fields`, the contract version, an instant. An unexpected key is itself a defect. |
| Refusals are typed | Every refusal names a reason from a closed vocabulary, and no refusal carries record content. |

### On the receipt rule

Under `sub_mode = user_email`, Universe issues `sub` as the user's email address.
A receipt that echoed a subject would be publishing personal data into an audit
surface built to be shared. So the check is inverted rather than defensive:
chasing individual leaks only finds the field somebody thought to plant a canary
in; requiring an approved shape catches the field nobody predicted.

It also has to be **positional**, which took a second reviewer to notice. An
earlier version approved any string matching any approved shape, wherever it
appeared — so an implementation returning `fields: [receipt.personRef]` passed
the entire corpus while emitting audit metadata that names no field at all.
"Contains only approved strings" is a weaker claim than "each position holds the
kind of value that position is for", and only the second one is the rule.

## What the test suite proves

`npm test` runs the twenty-one scenarios against the real implementation, and then:

- **A no-fault control.** The fault wrapper with no fault set passes every
  scenario, so each fault's failures are attributable to the fault.
- **Twenty-one faults, each with a declared failure set.** Every fault must fail
  exactly the scenarios it declares. A fault that fails more has stopped being
  surgical; one that fails fewer means a scenario is not reading the behaviour
  it names. Every entry in that table is *measured*, never assumed: five faults
  legitimately break more than one scenario and are declared that way rather
  than narrowed to make the table look tidier.
- **Fifteen source mutations** (run out of tree) each break the source of the
  real implementation one rule at a time. Each is read back from disk **and
  recompiled** before its result is trusted, because a mutation that fails to
  compile produces silence indistinguishable from an unbound control. All
  fifteen fail a named *scenario*; none fails nothing.
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

The `spent` set in the reference implementation was in-memory, and this README
used to say "SHU-84 must make single-use durable, or a restart re-opens replay."
That was a note where a rule belonged. Single-use is now part of the commit
contract — the token id goes into `CommitInput` and the store refuses one it has
already committed — so SHU-84 inherits the guarantee instead of a TODO. The
in-memory set survives only as a local shortcut, and the comment on it says so.

## Two rules this contract only has because a second reviewer found them missing

The second published head was **async-unsound and state-blind**, and the two
faults compounded:

1. `commit` returned a Promise into a synchronous port, so a *rejected* write
   was read as a successful one. Reproduced: `commit rejected, but confirm
   returned ok: true`, with the rejection escaping as an unhandled rejection.
2. The token bound only the change set, never the state the preview observed.
   Reproduced: preview showed `before = canary-value-must-not-escape`, the
   record became `Concurrent Name`, and the confirm returned `ok: true` with
   `commits: 1` — a change the person never saw, silently overwritten.

The port is now async end-to-end, the token carries `expectedBeforeDigest`, and
the compare-and-write lives inside `commit` where the race actually is. Codex's
review found both; eighteen scenarios of my own did not. This is the second time
an independent reviewer has found a hole the author's own corpus could not, which
is the argument for cross-vendor verification stated as evidence rather than as
policy.

## Four more rules, and two corrections, from a third review round

Codex and CodeRabbit reviewed the async head independently and converged on the
same two P1s. All four findings below were **reproduced before being fixed**;
none was a near miss.

1. **One token, two writes.** Two concurrent confirms both passed the caller's
   `spent` check before either recorded the spend. For a permitted *no-op* change
   the compare-and-write succeeded twice as well — the value already equalled the
   stored one, so the first commit left nothing for the second to notice.
   Reproduced: two `ok: true` receipts, `commits: 2`.
2. **Ownership was time-of-check, not time-of-use.** The confirm re-derives
   ownership and then awaits twice more before writing. Reproduced: a grant
   revoked in that window, `ok: true`, one commit, and no owner left on the record.
3. **The receipt whitelist was position-blind** — see the receipt section above.
4. **Two faults were disabling the wrong rule.** `confirmIgnoresChangeSet` and
   `ignoreTokenPrincipal` rewrote a token field without re-signing it, so the MAC
   check refused them first. Their scenarios failed, the table stayed green, and
   the anti-substitution rule — the one this README calls *the reason a token
   exists* — was bound by nothing. A fault that fails the right scenario for the
   wrong reason is indistinguishable from one that works.

The first two are fixed in the same place, because they are the same shape of
bug: **a precondition checked outside the transaction is not a precondition.**
`commit` now receives the token id and re-checks all three — state, single-use,
ownership — inside the atomic unit, and reports which one failed rather than
flattening them into one refusal.

Both reviewers proposed an in-process reservation for the token instead. That
was implemented first, and then **deleted**: with the store enforcing single-use
atomically, a mutation removing the reservation broke nothing at all. It was
dead code that looked like a safety mechanism, which is worse than no code —
it invites the next reader to believe the guarantee lives there.

Moving ownership into the commit made the confirm's own ownership check look
redundant too. It is not, and the difference is a confidentiality one: because
ownership is re-derived *before* the record is read, a revoked principal is told
`not_own_record`. Check it later and they are told `state_changed` — learning
that a record they no longer own has changed. That is now its own scenario.

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
