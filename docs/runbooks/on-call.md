# On-call rota template

## Purpose

Provide accountable coverage for a production cutover window.

## When to use

Complete this template before every production go/no-go and review it at cutover.

## Who does it

The release coordinator assigns role-based coverage; the primary and backup acknowledge it.

## Before you start (checks)

1. Confirm the cutover start and end are agreed in the approved scheduling screen.
2. Confirm both roles can access the deployment, incident, and alert screens.

## Steps

1. Fill in **Cutover window:** ______
2. Fill in **Primary:** ______
3. Fill in **Backup:** ______
4. Record both acknowledgements in the approved scheduling screen.

Any blank cutover window, primary, or backup field blocks the production go/no-go.

## How to verify

The release coordinator reads all three nonblank fields and both acknowledgements aloud at go/no-go.

## If it goes wrong

Pause the cutover. Do not substitute an unacknowledged person or proceed with a blank field.

## Related

[Deploy](deploy.md), [incident](incident.md), and [alert routing](alerts.md).
