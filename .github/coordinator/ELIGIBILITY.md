# Coordinator eligibility contract

The coordinator may reserve a card only when every rule below is true at the
authoritative recheck immediately before the reservation comment is written.

- State is exactly `Todo`. `Backlog` is parked work, not a ready queue.
- No delegate, assignee, active receipt, or claiming open pull request exists.
- All `blockedBy` relations resolve to `Done`. Missing/inaccessible blocker
  state and canceled predecessors remain blocking until the relation is
  explicitly removed or dispositioned.
- `needs:decision` is absent.
- `risk:R2` and `risk:R3` cards name `verifier:<name>`. A `type:implementation`
  card may not name a verifier drawn from its own worker's family: same-family
  review is self-verification, not independent review. The families are

  | `worker:<family>` | excluded verifiers |
  | --- | --- |
  | `codex-builder` | `codex`, `gpt`, `gpt-6` |
  | `claude-verifier` | `claude`, `opus`, `sonnet`, `haiku`, `fable` |
  | `hermes-box` | `hermes` |

  A card with no `worker:<family>` label is routed to `codex-builder` and is held
  to that row. The rule is scoped to `type:implementation` cards; a
  `type:verification` card naming its own family is the normal case. Every
  recognized worker family must declare its excluded verifiers, so a new family
  cannot be added without an explicit independence decision rather than silently
  defaulting to "independent".
- Exactly one recognized repository ownership label exists:
  `repo:platform`, `repo:legacy`, or `repo:infrastructure`. A label is resolved
  to its real repository; the Linear query's repository never supplies or
  overwrites ownership. Missing, unknown, multiple, or out-of-pilot ownership
  HOLDs.
- GitHub open-PR claim evidence is available. A PR claims a card through its
  branch, title, or an explicit `Fixes`/`Closes`/`Resolves` body reference. A
  bare dependency or contextual body mention is not a claim.

The same checks run again after lifecycle/backfill processing and before the
coordinator writes `RESERVED`. A failed lookup, changed claim, changed blocker,
changed verifier, or changed repository aborts with no reservation or launch.

`enable_dispatch` remains the independent activation gate; satisfying this
contract does not enable dispatch.
