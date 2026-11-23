# Observability

Local telemetry, request/job correlation, alert evaluation and job-run contracts.
[src/index.ts](src/index.ts) supplies the main entry point and re-exports
[schema.ts](src/schema.ts), [alerts.ts](src/alerts.ts) and [jobs.ts](src/jobs.ts).
This directory has no package manifest or published package-name import;
consumers use relative `.js` imports into its TypeScript source tree. The root
[build configuration](../../tsconfig.build.json) emits it under
`dist/packages/observability`.

Telemetry defaults to disabled. `telemetryMode` accepts only the exact `local`
value of `SHU_TELEMETRY_MODE`; other values remain disabled. In local mode,
`Telemetry` starts a worker with an empty environment and a bounded V8 heap.
[local-sentry.ts](src/local-sentry.ts) supplies an in-memory Sentry transport,
with no network sender. These are local diagnostics, not external ingestion or
proof of production acceptance. See the broader
[observability contract](../../docs/observability.md) and
[alert runbooks](../../docs/runbooks/alerts.md).

## Source files and exports

### [index.ts](src/index.ts): correlation and telemetry facade

- `Span` describes trace/span IDs and an optional parent span ID. `newSpan`
  creates frozen random IDs, inheriting a trace only from a span minted by this
  module. `inSpan` runs work in async-local context, replacing an untrusted span;
  `currentTraceId` reads the active trace. This is in-process correlation, not
  cross-process queue propagation.
- `LIMIT` is 64 pending event acknowledgments; `RETENTION_MS` is five minutes
  for aggregate metrics. `LATENCY_BUCKETS` contains cumulative upper bounds of
  10, 50, 100, 500, 1000, 5000, 30000 and 3600000 milliseconds.
- `telemetryMode` selects disabled/local behavior. `Telemetry.record` accepts
  minted spans, rebuilds events through `sanitizeEvent`, aggregates bounded
  component/journey/outcome metrics and posts events to the worker. Queue overflow
  counts drops; a two-second acknowledgment timeout or worker failure disables
  telemetry. Aggregates include observations dropped by the full event queue.
- `Telemetry.snapshot` returns cloned metrics, transport counters and captured
  events, with a bounded wait for the worker. `accepted` counts posted events,
  not durable delivery. `Telemetry.close` terminates the worker and clears
  metrics without counting a deliberate shutdown as an outage.
- `disabledTelemetry` is the default inert instance. `observedJob` wraps an
  async operation in a span, records worker success/failure and preserves its
  result or rethrows its error. Its default journey is `job`.
- All exports from `schema.ts`, `alerts.ts` and `jobs.ts` below are re-exported;
  the local Sentry factory is not.

### [schema.ts](src/schema.ts): closed event boundary

- `JOURNEYS`, `COMPONENTS`, `OUTCOMES` and `FAULTS` are the closed vocabularies;
  `Journey`, `Component`, `Outcome` and `Fault` are their corresponding types.
  `SafeEvent` defines version 1, correlation IDs, those vocabulary fields and
  numeric duration.
- `sanitizeEvent` reads own data-property values, validates ID formats and
  vocabulary membership, rejects non-finite/out-of-range durations, rounds
  valid durations and rebuilds only allowed fields. Invalid input returns
  `null`. Format validation alone does not establish that an ID was minted;
  `Telemetry.record` separately checks the span's provenance.
- `classifyJourney` maps fixed request paths to journey names and everything
  else to `unknown`; it does not retain URLs, query strings or dynamic paths.

### [alerts.ts](src/alerts.ts): local metric rules

- `Alert` defines the closed code union, `platform-on-call` owner and runbook
  path shape. Its union includes telemetry, job and email-volume alert codes.
- `evaluateAlerts` emits only the four metric/transport codes: journey failures
  (at least five failures/aborts and at least 5%), journey latency (at least
  20 observations and more than 5% over one second), dropped telemetry and
  unavailable telemetry. It returns records and sends no notifications.
  Job alerts are produced by `jobs.ts`; the worker's email-volume callback is
  wired in [apps/worker/src/index.ts](../../apps/worker/src/index.ts).

### [jobs.ts](src/jobs.ts): job execution and store contract

- `JOB_NAMES`/`JobName` restrict names to `heartbeat`, `missed_run_check` and
  `email_delivery`. `JOB_OUTCOMES`/`JobOutcome` restrict outcomes to `succeeded`,
  `failed` and `refused_overlap`. `JobRun` carries run ID, name, timestamps,
  duration and outcome; `Job` supplies an interval and abort-aware work callback.
- `JobRunsStore` defines acquire/renew/release, recording, latest runs and last
  successful runs. `RunnerOptions` injects telemetry, an alert callback, clock,
  lease duration and timers. `JobAlert` adds a closed job name to `Alert`.
- `runJob` acquires a lease before work, records refused overlap, renews during
  execution, signals abort on renewal loss, records the outcome and releases
  the lease. Work runs through `observedJob`; failures emit `job_failed` when an
  alert callback is supplied. Aborting is cooperative: the callback must honor
  its signal; this runner does not forcibly terminate business work.
- `JOB_MISSED_GRACE_FACTOR` is 1.5. `isJobMissed` checks for no prior success or
  elapsed time strictly greater than interval times that factor.
  `missedJobAlerts` reads successes once and emits/returns missed-job alerts,
  stopping iteration if its optional signal is aborted.
- `createJobRegistry` returns a frozen registry of the three jobs, each with a
  60-second interval. Email delivery is an injected callback, defaulting to a
  no-op. The registry declares intervals; it does not start a scheduler.
- `writeJobAlert` serializes an alert as one JSON line to an injected writer
  (stderr by default). `MemoryJobRunsStore` implements the contract in memory,
  with exposed runs/leases and a `failRenewal` test control; it is not durable.

### [local-sentry.ts](src/local-sentry.ts): bounded local SDK adapter

`EVENT_LIMIT` is 128 captured events and `EVENT_TTL_MS` is one hour.
`createLocalSentry` constructs a dedicated Sentry client and returns `capture`,
`snapshot`, `prune` and `close`. It sanitizes input and rebuilds events at both
the SDK and transport boundaries, dropping enrichment and unknown envelope
items. `capture` acknowledges only events accepted by the local transport;
snapshots are cloned and expired events are pruned. This module is imported
directly by the telemetry worker and package tests.

### [sentry-worker.ts](src/sentry-worker.ts): worker entry point

No named exports. It creates the local adapter, prunes every second and handles
`event`/`snapshot` parent-port messages. Replies are `ack`, `unavailable` or
`snapshot`; caught exceptions are not echoed. `Telemetry` loads the compiled
worker file by URL rather than importing it as an application API.

## Actual consumers

These are direct imports outside this package, checked against the source tree:

| Consumer | Imported API and use |
| --- | --- |
| [Gateway entry point](../../apps/gateway/src/index.ts) | `Telemetry`, `disabledTelemetry`, `telemetryMode`, `newSpan`, `inSpan`, `classifyJourney`, type `Fault`: request completion telemetry, server-rendered web child spans and runtime configuration. |
| [Gateway authorization middleware](../../apps/gateway/src/authz-middleware.ts) | `currentTraceId`: correlates authorization audit request IDs with the active trace. |
| [Gateway jobs page](../../apps/gateway/src/admin-jobs.ts) | `isJobMissed`, types `Job`, `JobName`, `JobOutcome`, `JobRunsStore` from `jobs.ts`: admin-scoped job status projection. |
| [Gateway ops wiring](../../apps/gateway/src/wiring/ops.ts) | `createJobRegistry`, `writeJobAlert` from `jobs.ts`: supplies the registry used by the jobs page. |
| [Worker entry point](../../apps/worker/src/index.ts) | `Telemetry`, `telemetryMode`, `observedJob`, `createJobRegistry`, `runJob`, `JOB_NAMES`, `writeJobAlert`, type `JobAlert`: selects and executes a registered job with a PostgreSQL store; re-exports `observedJob` and `writeJobAlert`. |
| [Gateway jobs tests](../../apps/gateway/test/admin-jobs.test.ts) | `MemoryJobRunsStore`, `createJobRegistry`, `runJob` from `jobs.ts`. |
| [Worker heartbeat tests](../../apps/worker/test/heartbeat.test.ts) | `JOB_NAMES` from `jobs.ts`. |
| [Database job-run tests](../db/test/postgres-job-runs.test.ts) | `runJob`, type `Job` from `jobs.ts`. |
| [Notifications outbox tests](../notifications/test/email-outbox.test.ts) | `MemoryJobRunsStore`, `runJob`, type `JobAlert` from `jobs.ts`. |
| [Synthetic exercise](../../tools/observability/synthetic-exercise.mjs) | `Telemetry`, `observedJob`, `evaluateAlerts` from the compiled main entry point. |

No other package's runtime source directly imports this package at the checked
base. In particular, [PostgresJobRunsStore](../db/src/postgres-job-runs-store.ts)
has structurally matching local job types, not an import of `JobRunsStore`;
the apps pass that implementation to the runner/page. The notifications import
above is test-only.

## Exercise and verification

The [tools/observability README](../../tools/observability/README.md) explains
the synthetic gateway/audit/job exercise, how to run it and how its stdout
differs from the stored receipt. It consumes this package; it is not a second
telemetry implementation. Its correlation checks cover an in-process job,
not a queue or a separately deployed worker.

The root [package.json](../../package.json) defines `npm run typecheck`,
`npm test` (build plus the discovery-based test runner),
`npm run test:observability` (the telemetry test file only),
`npm run test:observability:mutations` and `npm run exercise:observability`.
The latter three need compiled output first. Package coverage also includes
[job tests](test/jobs.test.ts), [job mutations](test/jobs-mutations.mjs) and
[runbook tests](test/runbooks.test.mjs), in addition to
[telemetry tests](test/observability.test.ts) and
[telemetry mutations](test/mutations.mjs).

Validation results and environment limits for this documentation change are
recorded in the accompanying PR evidence; source and relative links were
checked against its base commit.
