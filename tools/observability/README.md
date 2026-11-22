# Local synthetic observability exercise

[synthetic-exercise.mjs](synthetic-exercise.mjs) exercises a gateway request,
authorization audit correlation and an in-process worker job using synthetic
inputs. See the [observability contract and runbook](../../docs/observability.md)
for the telemetry privacy boundary, retention, alerts and operational limits.
This is local implementation evidence, not production or external-ingestion
acceptance.

## Run from the repository root

Use Node 22 or newer and install dependencies with `npm ci --ignore-scripts`.
The root [package.json](../../package.json) defines the engine requirement and
these commands:

```sh
npm run build
npm run exercise:observability
```

`exercise:observability` runs `node tools/observability/synthetic-exercise.mjs`.
Build first because the script imports compiled gateway, fixture and telemetry
modules from `dist` (script lines 2–4). On success it prints JSON to stdout
(line 45); it does not write [evidence.json](evidence.json). Assertion failures
fail the command. The server and telemetry worker are closed in `finally`
(lines 46–48). Do not redirect output over the checked-in receipt.

## What it checks

- **Failure and recovery:** the adapter runs through `observedJob`, initially
  throwing a private synthetic sentinel (lines 10–15). Six authenticated POST
  requests call the gateway's `/mcp/tools/call` route. The sixth restores success;
  assertions require five HTTP 502 responses followed by HTTP 200 (lines 21–28).
- **Audit correlation:** for each response, the audit entry's `requestId` must
  equal the returned `x-request-id` trace identifier (lines 28, 32–33).
- **Gateway/worker correlation:** the snapshot must contain 12 events. Each
  request trace must have exactly two events, with the worker's parent span
  equal to the gateway's span (lines 30–38). This checks an in-process job
  boundary, not cross-process queue propagation.
- **Local alert:** `evaluateAlerts(snapshot)` must include `journey_failures`
  (lines 40–41). Evaluation does not send notifications.
- **Private-sentinel absence:** the sentinel is injected into the thrown error,
  incoming request-ID header and request arguments (lines 11–25). The entire
  serialized evidence object, including snapshot events, must exclude it
  (lines 42–44). This assertion covers that sentinel in this exercise; the
  broader adversarial privacy tests are described in the observability guide.

The script explicitly constructs `Telemetry('local')`, uses freshly generated
fixture keys and binds an ephemeral loopback listener (lines 6–17). It needs no
database, real user data or environment credentials. The
[local Sentry transport](../../packages/observability/src/local-sentry.ts),
lines 18–46, captures rebuilt events in memory rather than sending them to an
external service. No external ingestion or live operations are enabled.

## Reading the checked-in receipt

The checked-in [evidence.json](evidence.json) is a summarized receipt, **not the
current script's verbatim output**. The table traces every field to its source
or explicitly identifies metadata the script does not emit. Line numbers refer
to [synthetic-exercise.mjs](synthetic-exercise.mjs) unless another file is named.
All emitted fields are serialized at line 45.

| Receipt field | Meaning and source |
| --- | --- |
| `mode` | Literal `local-only` at line 42; local telemetry is constructed at line 7. |
| `externalIngestion` | Literal `false` at line 42; supported by the in-memory transport above. |
| `failures` | Literal `5` at line 42, backed by the five asserted HTTP 502 responses at lines 21–27. |
| `recoveryStatus` | Literal `200` at line 42, backed by the sixth response assertion at line 27. |
| `auditCorrelation` | Literal `6/6` at line 43, backed by all six audit/response trace comparisons at lines 32–33. |
| `gatewayWorkerCorrelation` | Literal `6/6` at line 43, backed by the six two-event and parent-span comparisons at lines 34–38. |
| `privateSentinelAbsent` | Literal `true` at line 43; line 44 checks the serialized object before it can be printed. |
| `alerts` | Array returned at line 40 and included at line 43; line 41 requires a failure alert. |
| `alerts[].code` | Closed alert code from [alerts.ts](../../packages/observability/src/alerts.ts), lines 22–28. `journey_failures` requires at least five failures/aborts and a failure rate of at least 5% for a component/journey. |
| `alerts[].owner` | `platform-on-call`, assigned in `alerts.ts` line 28. |
| `alerts[].runbook` | The receipt retains the older `docs/observability.md` value. Current `alerts.ts` line 28 emits `docs/runbooks/alerts.md#<code>`; see [alert routing](../../docs/runbooks/alerts.md). The script includes this returned value at line 43. |
| `counters` | Snapshot counters read at line 30 and spread into evidence at line 43; returned by [index.ts](../../packages/observability/src/index.ts), lines 82–97. |
| `counters.accepted` | Number of events posted to the telemetry worker (`index.ts` line 79), not a durable-delivery count. The receipt records 12. |
| `counters.dropped` | Events dropped when the pending queue is full (`index.ts` line 74); the receipt records zero. |
| `counters.unavailable` | Telemetry outage count incremented by `disable` (`index.ts` lines 54–59); the receipt records zero. |
| `capturedSentryEvents` | Summary-only count, recorded as 12. No script line emits this field: line 31 asserts `snapshot.events.length === 12`, and line 43 emits the full `events` array instead. |
| `metrics` | Snapshot aggregates read at line 30 and spread at line 43; constructed in `index.ts` lines 67–73 and returned at line 97. |
| `metrics.worker:job:failure`, `metrics.gateway:mcp_call:failure` | Component/journey/outcome keys for five failed worker jobs and gateway calls. Key construction is `index.ts` line 68; the exercise drives them at lines 12–27. |
| `metrics.worker:job:success`, `metrics.gateway:mcp_call:success` | Corresponding keys for the sixth, successful request/job (lines 22–27). |
| `metrics.<key>.count` | Observation count, incremented in `index.ts` line 70; five for each failure key and one for each success key in the receipt. |
| `metrics.<key>.durationMs` | Sum of rounded event durations in milliseconds, not an average (`index.ts` line 71 and [schema.ts](../../packages/observability/src/schema.ts) line 33). Timings vary between runs. |
| `metrics.<key>.buckets` | Cumulative counts at upper bounds 10, 50, 100, 500, 1000, 5000, 30000 and 3600000 ms (`index.ts` lines 21 and 72). Each observation increments every bucket whose bound includes its duration. |
| `command` | Receipt metadata: `npm run build && npm run exercise:observability`. Both commands exist in the root manifest; no script line emits this field. |
| `scope` | Receipt metadata describing synthetic loopback-only scope. No script line emits this field; the scope is supported by lines 6–17 and the local transport. |

Fresh stdout therefore contains `events` rather than `capturedSentryEvents`,
omits `command` and `scope`, and uses the current alert runbook path. Random
trace/span/event identifiers and measured durations also vary. Do not expect a
byte-for-byte match with the stored summary, or infer current validation merely
from its presence.

## Verification of this guide

Checked against base `59739cfe315f42dbaea8e092aa020aa1e448e41a` on
2026-11-22 with Node 22.22.3. `npm ci --ignore-scripts`, `npm run typecheck`,
the `npm run build` step invoked by `npm test`, and the standalone
`npm run exercise:observability` all passed. `npm run test:observability`
passed all 15 tests. Relative link targets and receipt field coverage were
checked locally; the stored receipt remained unchanged. Full-suite and CI
results are recorded in the accompanying PR evidence.

`npm run test:db` was not run: no disposable PostgreSQL 17 database was
configured for this documentation-only change.
