# Incident runbook

## Purpose

Coordinate a service incident with explicit severity, decision authority, and safe communication.

## When to use

Use for any platform alert or report of degraded availability, integrity, privacy, or deployment safety.

## Who does it

The on-call primary begins response. The on-call backup becomes incident commander if assigned, coordinates responders, and alone decides whether to request a rollback from the release operator.

## Before you start (checks)

1. Open [the on-call rota](on-call.md) and confirm primary, backup, and cutover window.
2. Classify severity: SEV-1 is widespread outage, confirmed data exposure, or unsafe writes; SEV-2 is material degradation with a workaround; SEV-3 is limited degradation with no immediate safety impact.
3. Open the matching entry in [alert routing](alerts.md) and collect only its closed code, timestamps, revision, and safe health evidence.

## Steps

1. In the approved incident coordination screen, create an incident with severity, start time, affected capability, and incident commander role; include no credentials or private data.
2. In the approved team status screen, announce SEV-1 immediately, SEV-2 at the next response checkpoint, or SEV-3 in the operating log.
3. In the GitHub Actions screen, inspect the relevant deployment and smoke checks; do not rerun until the failure is understood.
4. The incident commander records **continue**, **mitigate**, or **rollback**. For rollback, send the selected previous immutable image to the release operator and follow [rollback](rollback.md).
5. At each checkpoint, update severity, impact, action owner role, next checkpoint, and verification state in the incident screen.

## How to verify

Require service health plus a synthetic check of the affected capability. Close only after alerts clear or are explicitly understood and the final update states the verified revision.

## If it goes wrong

Raise severity when impact expands, evidence becomes unreliable, or the primary and backup cannot cover the response. Stop changes when no incident commander is active.

## Related

[Alert routing](alerts.md), [deploy](deploy.md), [rollback](rollback.md), and [on-call rota](on-call.md).
