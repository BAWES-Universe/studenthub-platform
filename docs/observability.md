# PII-safe observability and failure diagnosis (SHU-90)

## Authority and activation

This implementation provides local Sentry-backed diagnosis, not a production rollout.
The default is **disabled**. Only `SHU_TELEMETRY_MODE=local` starts an isolated,
in-memory Sentry worker; every other value remains disabled. `SENTRY_DSN`,
`SENTRY_AUTH_TOKEN`, release, environment and other ambient SDK variables cannot
activate ingestion. The worker inherits an empty environment. Its only transport
is a bounded local ring; `telemetry.invalid` is an inert SDK parser placeholder,
not a destination. There is no HTTP transport, ingestion endpoint, replay,
browser JavaScript collector, session tracking integration, console capture,
automatic stack capture, tracing integration or external alert sender.

Enabling a future external transport requires a separately reviewed change and
explicit operator authorization of destination, access, retention and credentials.
Do not populate credentials or enable this on a live host as part of SHU-90.
Local tests generate their own synthetic assertion keys through the existing
fixture; they do not read production credentials or contact production services.

## Real paths and correlation

| Surface | Instrumentation | Diagnosis |
| --- | --- | --- |
| Gateway | One completion per HTTP request, finish/aborted-close boundary | Fixed route journey, duration, success/refusal/failure/abort, fault code |
| Server-rendered web | Child span for HTML requests; profile render catch and outer error boundary | Same gateway trace, web component, render/dependency/unhandled fault |
| Authorization audit | Existing audit behavior retained; requestId uses the active server trace | Join audit and local diagnosis without exporting principal/org/grants into Sentry |
| Worker | `observedJob` records success/failure and rethrows the original business error | Child span if invoked in an active operation, fresh trace for standalone work |
| Worker entrypoint | Heartbeat runs through `observedJob` | Heartbeat outcome and latency |

Each incoming HTTP request mints a fresh random 128-bit trace ID and 64-bit span
ID. `x-request-id` returns that trace ID for support diagnosis. Request headers,
`traceparent`, baggage, cookies, profile IDs and query values never supply it.
AsyncLocalStorage keeps concurrent operations separate. Only in-process minted
contexts may become parents. There is no long-lived visitor/session identity or
cross-navigation tracking; a login start and callback have separate request
traces. Web spans cover server rendering and request handling, not browser
paint or client-side JavaScript. The current worker has no queue consumer; the
job boundary is exercised through a real gateway adapter in the synthetic run.
Cross-process queue propagation belongs with a future queue implementation.

Closed journey vocabulary: landing, login_start, login_callback, profile_read,
logout, mcp_call, health, asset, unknown, heartbeat, job. Dynamic routes collapse
to `unknown`; tool names never become labels. Every request records one gateway
outcome, plus one web outcome when HTML was requested. Handled 5xx responses are
failures too. Aborted response streams record exactly once. Failed telemetry does
not suppress authorization audit or alter business authorization.

## PII boundary

The producer reconstructs a versioned record from minted IDs, closed component,
journey/outcome/fault vocabularies, and a bounded numeric duration. It never
passes a request, response, audit record or exception to Sentry. The worker
validates/rebuilds again. Both SDK `beforeSend` and the local transport rebuild
Sentry events from private, previously validated records keyed by fresh event ID.
Unknown envelope item types and SDK-added metadata are discarded.

Allowed Sentry fields: event ID, server timestamp, fixed platform/level/message/fingerprint, closed
tags, trace context and duration measurement. A fixed fault message replaces the
exception message and stack; operators diagnose the component/journey/fault and
trace rather than inspecting private stack locals. No names, user IDs, IPs,
URLs, headers, cookies, bodies, breadcrumbs, attachments, replay, transaction
names, environment variables, release strings or SDK server metadata are kept.

The adversarial matrix covers cookies; bearer, access, refresh and OIDC ID tokens;
OIDC state/code; client secrets, passwords, API/private keys and database DSNs;
resumes and signed document URLs; Civil ID photos and numbers; bank ID, IBAN,
account name and pay; profile email, phone, name, address, IP and coordinates.
Each is injected into top-level unknown fields and request/header/cookie/body,
profile/user, nested arrays, tags/contexts, breadcrumb, exception/stack, attachment,
log, transaction, environment, release, server, span and replay surfaces. Tests
inspect actual captured Sentry events and reject injected values in allowed
fields too. Getters, coercion hooks, cyclic data and throwing proxies are covered.
A closed schema rejects new fields by default; adding any field requires privacy
review and corresponding adversarial tests.

## Isolation, bounds and metrics

Sentry executes in a worker thread with a 64 MiB old-generation heap limit.
The business thread only prepares a small fixed record and posts it. No SDK,
transport callback, network/disk write or diagnostic await runs on that thread.
At most 64 records may await acknowledgment. Overflow drops telemetry and counts
the loss. Any record without acknowledgment after two seconds disables and
terminates the telemetry worker; worker startup/error/exit/post failures are
contained. No retries or unbounded queues are created. A stalled transport cannot
block the event loop handling HTTP. Node worker resource limits cover the V8
heap, not total process RSS; bounded payloads and the queue are additional controls.

Current five-minute tumbling-window metrics are local counters keyed by
component/journey/outcome, with total duration and cumulative buckets at 10, 50,
100, 500, 1000, 5000, 30000 and 3600000 ms. Duration is capped at one hour;
counts/sums saturate at MAX_SAFE_INTEGER. Cardinality is bounded by the closed
vocabulary (3 × 11 × 4), never by trace ID, URL or person. These metrics include
records dropped from the Sentry queue. A disabled or failed worker does not
retain journey metrics; unavailability is separately counted.

`Telemetry.snapshot()` is an explicit local diagnostic API, not an HTTP route.
It waits at most two seconds and is never awaited by a business request. The
worker CLI alone uses a bounded diagnostic drain before shutdown. There is no
promise of durable delivery; loss and process restart are expected and visible.

## Retention and access

| Data | Retention / bound | Access / deletion |
| --- | --- | --- |
| Local Sentry events | Last 128 events, one-hour TTL; expired entries purged on read/write and every second | Process memory only; trusted local diagnostic caller; close/restart clears |
| Journey aggregates | Five-minute tumbling window, fixed dimensions; expiry checked on access and every second | Same process access; close/outage/restart clears |
| Queue | 64 fixed records, two-second acknowledgment limit | Internal worker messages; termination clears |
| Transport health counters | Process lifetime, fixed numeric fields | Same local diagnostic caller; restart clears |
| Existing decision/mutation audit | Existing audit/store policy; SHU-90 adds no audit destination or retention change | Existing authorization audit access boundaries remain authoritative |
| Checked-in synthetic exercise receipt | Repository history retention, synthetic-only | Repository collaborators/reviewers; no user data |

Expiry timers may run late under OS/event-loop suspension; reads always prune
expired events before returning them. No local telemetry is persisted to disk by
the runtime. A local process owner/debugger can inspect process memory: run under
the existing dedicated service account, restrict host/shell/debug access to the
platform operator and explicitly authorized incident responders. Do not expose
snapshot through a public route or copy snapshots into public chat/issues. No
external Sentry account permissions or retention have been provisioned or claimed.
Audit records can contain internal principal/org references and remain a separate
restricted stream; SHU-90 exports only their random request correlation ID.

## Alerts and runbook

All rules are implemented by `evaluateAlerts`. **Owner: platform-on-call**;
**accountable operator: Khalid** until a staffed rotation is established. Rule
outputs point to this runbook. Evaluation is local and sending is disabled.

| Rule | Trigger | Response |
| --- | --- | --- |
| journey_failures | At least 5 failures/aborts and at least 5% failure rate for a component/journey in the current metric window | Use trace ID, component, journey and fixed fault to locate the boundary; compare related gateway/web/worker events and restricted authorization audit |
| journey_latency | At least 20 observations, with more than 5% exceeding 1 second | Inspect the affected journey/dependency, without logging request bodies or widening Sentry capture |
| telemetry_dropped | Any queue drop during this process lifetime | Check local transport pressure and event volume; do not retry indefinitely or block requests |
| telemetry_unavailable | Worker creation, error, exit, post or acknowledgment deadline failure | Confirm business health independently; inspect local host resources; restart only under the operator's environment procedure |

For `dependency_unavailable`, inspect configured dependency health using approved
operator tooling. For `render_failure`, reproduce with synthetic profile data.
For `adapter_failure`/`job_failure`, locate the adapter/job via the linked spans.
For `unhandled_failure`, reproduce locally with the same journey and synthetic
inputs; do not enable raw error logging. For `response_aborted`, distinguish
client cancellation from service/network trouble. Never paste cookies, tokens,
profile bodies, bank fields or signed document URLs into an incident report.

Recovery: restore the failing synthetic dependency, issue a fresh request, check
its success event and HTTP outcome, then re-evaluate after the next metric
window. Transport counters latch until restart; they do not pretend that old loss
has been undone. Escalate missing correlated evidence to platform-on-call rather
than treating missing telemetry as proof of success.

## Reproducible evidence and verification

From a clean checkout with Node 22+, run:

```sh
npm ci --ignore-scripts
npm run build
npm run test:observability
npm run test:observability:mutations
npm run exercise:observability
npm test
```

The exercise binds only an ephemeral loopback listener, generates fresh test
assertions, causes five controlled worker failures reached through the gateway,
and then restores success. It asserts all six audit/trace joins, six parent-child
joins, 12 captured local Sentry events, a routed local failure alert, five HTTP
502 responses and a recovered HTTP 200. It also proves a private synthetic
sentinel never appears in telemetry. It performs no external ingestion, sends no
notifications and changes no production state. A successful exercise is local
implementation evidence, not live operational acceptance.

CI runs these tests, mutation checks and the exercise through `npm test`.
Mutation checks operate on throwaway compiled copies, require the named
behavioral test to fail, and reject import/syntax errors as evidence. Independent
Opus verification must bind PASS/BLOCK to the final exact head; the author does
not self-PASS. Merge authority is conditional on that PASS, green required checks
and zero unresolved findings. Merging does not authorize enabling live ingestion.

Sentry SDK is pinned in package-lock.json. The local implementation uses the
installed SDK's `NodeClient`, `beforeSend`, and custom transport contracts; no
ambient default client is initialized. Official reference:
[Sentry transport configuration](https://docs.sentry.io/platforms/javascript/guides/node/configuration/transports/).
