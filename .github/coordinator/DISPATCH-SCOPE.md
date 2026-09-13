# Trusted dispatch scope

`config.json` may contain one operator-owned scope:

```json
"dispatch_scope": { "issue_ids": ["SHU-140"] }
```

When present, exactly one canonical Linear issue is allowed to receive new
reservations or successor-directive backfill. A missing, ineligible, terminal,
or unavailable target results in no selection; the coordinator never falls back
to another card. Invalid or ambiguous scope configuration prevents dispatch
entirely.

Lifecycle reconciliation remains global. Every active receipt counts against
the global `max_dispatch` limit, so every active receipt must retain a path to a
terminal state even when it is outside the reservation scope. Ignoring an
out-of-scope active receipt would permanently consume capacity; excluding it
from the capacity count would permit more live workers than the configured cap.

When the key is absent, normal board-wide selection is unchanged. To clear the
fixture scope safely, first disable both dispatch gates, then remove the
`dispatch_scope` object. The committed configuration keeps dispatch disabled and
SHU-140 remains Backlog until Khalid separately approves the live fixture.
