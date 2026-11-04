# Alert routing runbook

## Purpose

Route every platform alert to an owner, severity, immediate action, and escalation.

## When to use

Use whenever an alert is emitted or the same condition is found during an incident.

## Who does it

platform-on-call owns every route. The on-call primary responds and the backup escalates when the primary is unavailable.

## Before you start (checks)

1. Match the emitted code exactly to one row below.
2. Open [the on-call rota](on-call.md) and confirm coverage.
3. Keep alert evidence to closed codes, revision, timestamps, and scrubbed outcomes.

## Steps

1. In the alert screen, acknowledge the code and open its linked section below.
2. Perform **What to do** without adding request data, credentials, or exception text.
3. If the condition persists or reaches the stated severity, follow **Escalation** and open [incident](incident.md).

| Code | Owner | Severity | What to do | Escalation |
| --- | --- | --- | --- | --- |
| [journey_failures](#journey_failures) | platform-on-call | SEV-2 | Compare the closed component, journey, fault, and trace with restricted audit evidence. | Escalate to SEV-1 for widespread outage, unsafe writes, or suspected exposure. |
| [journey_latency](#journey_latency) | platform-on-call | SEV-2 | Inspect the affected journey and dependency without widening capture. | Escalate if latency blocks a critical capability or continues across two windows. |
| [telemetry_dropped](#telemetry_dropped) | platform-on-call | SEV-3 | Check local transport pressure and event volume; do not block requests or retry indefinitely. | Escalate to SEV-2 when diagnosis of another active incident is impaired. |
| [telemetry_unavailable](#telemetry_unavailable) | platform-on-call | SEV-2 | Verify business health independently and inspect approved local resource indicators. | Escalate to SEV-1 when business health cannot be established. |
| [job_failed](#job_failed) | platform-on-call | SEV-2 | Inspect the closed job name and durable outcome; reproduce only with synthetic inputs. | Escalate when the job is critical or the next scheduled run also fails. |
| [job_overlap](#job_overlap) | platform-on-call | SEV-3 | Confirm the existing run progresses and renews its lease; do not start overlapping work. | Escalate to SEV-2 if the holder is stale or repeated work is refused. |
| [job_missed](#job_missed) | platform-on-call | SEV-2 | Check scheduling and the latest scrubbed outcome, then restore the operator-managed schedule. | Escalate when a critical job misses another interval. |

### journey_failures

Follow the `journey_failures` table row, correlate only minted trace identifiers, and use [incident](incident.md) for escalation.

### journey_latency

Follow the `journey_latency` table row and compare dependency health without recording inputs.

### telemetry_dropped

Follow the `telemetry_dropped` table row; transport loss is not business failure or recovery evidence.

### telemetry_unavailable

Follow the `telemetry_unavailable` table row and verify the affected capability independently.

### job_failed

Follow the `job_failed` table row; never add exception text to the run or alert.

### job_overlap

Follow the `job_overlap` table row and preserve the single-run lease contract.

### job_missed

Follow the `job_missed` table row and verify a later successful durable run.

## How to verify

Re-evaluate the rule after the next metric window or durable job run and verify the affected capability with synthetic input. Latched transport counters clear only on an approved restart.

## If it goes wrong

If the code has no exact row, treat routing as broken, open a SEV-2 incident, and do not guess an owner or response.

## Related

`packages/observability/src/alerts.ts`, `packages/observability/src/jobs.ts`, `docs/observability.md`, and [incident](incident.md).
