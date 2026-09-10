# Single-run host activation (SHU-63)

Dispatch has always required two gates in different layers:

1. the **committed** flag — `config.json` → `enable_dispatch` (false by default, and
   asserted false by this repo's own suite), and
2. the **runtime** switch — `ENABLE_DISPATCH=true` in the environment.

Neither alone arms anything. That contract is not weakened here: the committed flag
stays `false`, and the assertions that pin it stay exactly as they were
(`eligibility.test.mjs`: *"the fixture lane is a lane, never an activation"*;
`shu224-dispatch-scope.test.mjs`: *"committed scope is pinned … while dispatch stays
disabled"*).

What was missing is any way to authorize **one bounded run** without changing the
committed gate. That is what stopped the approved live fixture at launch:
`SUPERVISOR.md` already names the requirement — *"Live activation requires a
separately reviewed host service configuration and rollback plan"* — and no such
mechanism existed. This is that mechanism.

## What it is

An operator-owned, host-local, single-use **activation record**: a small JSON file
outside the repository, presented on the command line.

```bash
node .github/coordinator/reconcile.mjs --activation /srv/shu/state/single-run-activation.json
```

The record is a capability declaration, not a secret. It never travels through
Linear, GitHub, or any card.

## The record

Exactly these keys. A missing key **and** an unreviewed extra key are both refused —
a configuration surface nobody reviewed is how scope creep enters security code.

```json
{
  "activation_id": "shu63-fixture-run-0001",
  "target_issue_id": "SHU-<n>",
  "authorization_ref": "FIXTURE-<CONTRACT-REF>",
  "coordinator_revision": "<40-char git sha>",
  "slots": 1,
  "expires_at": "2026-09-10T13:00:00.000Z"
}
```

| Field | Binding | Refused when |
| --- | --- | --- |
| `activation_id` | audit identity of this one authorization | not 8–64 chars of `[A-Za-z0-9_-]` |
| `target_issue_id` | must be **the single issue the committed `dispatch_scope` already allows** | it names any other card, or the committed configuration is board-wide |
| `authorization_ref` | must equal the lane's approved contract reference when the committed configuration carries one | it names a different contract |
| `coordinator_revision` | must equal the revision of the checkout **being executed**, resolved from git (never self-declared) | mismatch, or the revision cannot be resolved |
| `slots` | must be exactly `1` **and** equal the committed `max_dispatch` | it declares more capacity than the committed configuration |
| `expires_at` | must be in the future and **within 24h** | expired, unparseable, or reaching further than a day |

File integrity is part of the binding: the path must be a regular file (not a
symlink, not a directory), and must not be group/world writable or world readable
(`0600` or `0640`; `0644`, `0660`, `0604` are all refused).

## What it can never do

* **It cannot substitute for the runtime switch.** `ENABLE_DISPATCH=true` is still
  required, so a forgotten activation file on disk arms nothing by itself.
* **It cannot widen the board.** The bound target must be the single card the
  committed `dispatch_scope` already permits; an activation can never select a card
  the committed configuration would not have selected.
* **It cannot raise capacity.** `slots` must be `1` and must match the committed
  `max_dispatch`.
* **It cannot be replayed.** It expires, and it is spent once the bound target's
  episode ends.

## One use is one *episode*, not one claim

The approved run contract is build → exact-head BLOCK → return to the writer →
same-branch revision → automatic re-review → PASS. A revision is a later dispatch on
the same target under the same authorization, so "one claim ever" would stall the
loop it exists to authorize. One use therefore means one **episode** for the bound
target: from the first claim until that target **parks** (a `COMPLETED` or `HOLD`
receipt). Attempts inside the episode stay bounded exactly as before
(`max_failed_attempts`, `max_dispatch`). Once the episode ends, the same activation
can never arm anything again — the next invocation refuses with
`activation is spent`.

## Fail-closed summary

A refused activation is **not** a quiet dry run. It prints the report, prints
`dispatch: PREVENTED — single-run activation REFUSED (<reason>); no fallback, no
writes`, and exits **2** with zero writes. Missing, malformed, stale, replayed,
wrong-target, wrong-revision, over-capacity, over-long, over-permissive: all refuse.

## Operator procedure

```bash
# 1. Write the record where the coordinator service account can read it.
#    Must not be group/world writable or world readable (0600 or 0640).
install -m 0640 -o root -g shu-coordinator \
  /tmp/single-run-activation.json /srv/shu/state/single-run-activation.json

# 2. Launch ONE reconcile with the runtime switch, naming the record.
sudo -u shu-coordinator -H env ... ENABLE_DISPATCH=true \
  node /srv/shu/studenthub-platform/.github/coordinator/reconcile.mjs \
  --activation /srv/shu/state/single-run-activation.json

# 3. Inspect the first lines: it must read activation=ARMED with the expected id,
#    target, contract ref, revision and expiry. Anything else is a refusal.

# 4. After the episode ends, or to stop early, remove the record and stop passing
#    the flag. Both gates then behave exactly as before.
rm -f /srv/shu/state/single-run-activation.json
```

## Rollback

Delete the activation file. Nothing else changed: the committed flag was never
touched, and the runtime switch was never persisted anywhere. With no `--activation`
argument the coordinator behaves exactly as it did before this change.

## Tests

`test/single-run-activation.test.mjs`:

* the 5-combination committed truth table, re-asserted with the activation absent —
  the default path cannot drift;
* an armed activation, and the same activation **unarmed without the runtime switch**;
* argv: absent, both accepted shapes, and every malformed shape refused;
* 29 fail-closed cases (missing file, directory, symlink, three over-permissive
  modes, non-JSON, JSON array, missing key, extra key, bad id, non-canonical target,
  bad and mismatched contract refs, bad and wrong and unresolvable revisions,
  wrong target, `slots` 2 and 0 and mismatched-cap, expired, over-long window,
  non-timestamp, board-wide config, two-issue scope, inconsistent lane, already
  spent by `COMPLETED` and by `HOLD`);
* one-use episode semantics: `FAILED`/`RUNNING`/`RESERVED` do not spend it,
  `COMPLETED`/`HOLD` do, other issues' receipts are irrelevant;
* three integration runs through `main()`: inert default, a refused activation
  exiting 2 with no network, and the **running revision** binding proved end to end
  against the real checkout;
* **12 mutations**, each one proving a guard is load-bearing by removing it and
  asserting the corresponding refusal stops happening — the runtime switch, the
  committed two-gate path, target, contract ref, revision, slots, expiry wall,
  expiry window, one-use, file permissions, unknown keys, and the board-wide guard.

The suite fails for the right reason when a guard is removed; a mutation that kills
the process instead of failing the named assertion is not counted as a kill.
