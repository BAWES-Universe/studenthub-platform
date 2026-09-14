# Trusted dispatch scope

`config.json` may contain one operator-owned scope:

```json
"dispatch_scope": { "issue_ids": ["SHU-140", "SHU-254"] }
```

The committed scope admits exactly SHU-140 and SHU-254 for new reservations
and successor-directive backfill. If neither issue is eligible and available,
selection is empty; the coordinator never falls back outside the allowlist.
Legacy single canonical issue scopes remain supported. The only accepted
multi-issue scope is this exact pair (in either order); empty lists, duplicates,
other pairs, and larger lists fail closed.

Lifecycle reconciliation remains global. Every active receipt counts against
the global `max_dispatch` limit, so every active receipt must retain a path to a
terminal state even when it is outside the reservation scope. Ignoring an
out-of-scope active receipt would permanently consume capacity; excluding it
from the capacity count would permit more live workers than the configured cap.

When the key is absent, normal board-wide selection is unchanged. To clear the
fixture scope safely, first disable both dispatch gates, then remove the
`dispatch_scope` object. The committed configuration has `max_dispatch: 2` and
`enable_dispatch: false`. Two active receipts consume both slots; a third
reservation is refused by the global capacity guard. Each tick still makes at
most one reservation, so overlapping workers require successive ticks.

`fixture_lane` retains the original SHU-140 definition unchanged. The additional
`fixture_lanes` array contains SHU-254. Resolution uses the issue ID for
authorization, initial paths, and successor routing; duplicate lane IDs fail
closed. SHU-140 uses `tools/fixture/` and `tools/fixture-conformance/`; SHU-254
uses `tools/fixture-2/` and `tools/fixture-2-conformance/`. Exact manifests and
receipt checks prevent cross-lane path substitution. See
[SINGLE-RUN-ACTIVATION.md](SINGLE-RUN-ACTIVATION.md#shu-241-scoped-builder-source-and-base-preserving-publication).

This is configuration only, not approval or activation. For this exact pair,
arming is permitted only through the reviewed `two-fixture-v1` path documented
in [SINGLE-RUN-ACTIVATION.md](SINGLE-RUN-ACTIVATION.md#reviewed-two-fixture-extension-dispatch-remains-disabled).
It binds both complete lane definitions, both seed SHAs, coordinator/main SHA,
capacity two, expiry, stop-before-merge and both signed gate states. Both gates
must be set through the reviewed operation, never by hand. The committed flag
stays false; manually flipping it cannot bypass the pair's reviewed validation.
The legacy single-issue record still rejects this two-issue configuration.
No operational activation record, signing key, gate setter or live service is
introduced. See the activation document for the required API evidence, trust anchor and
strict seed-head checks before any separately reviewed live proof.
