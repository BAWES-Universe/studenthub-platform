# SHU-71 suite flakiness — investigation record

**This document is NOT the approval path and is not authoritative for any approval claim.** The approval
path is `claim-manifest.json` in this directory, whose entries are generated from the committed test
registries and validated by `test/shu71-claim-manifest.test.mjs`. Nothing here should be cited as evidence
for a sealed term, a control, or a disposition. This file exists so the flakiness material stops living
inside the document that carries approval claims.

## What is measured

The suite is intermittently red in a full-scope concurrent run, in a family that is not connected to the
change under verification.

- **Members.** `SHU251 live worker restart adopts once and recovers durable completion`
  (`test/residual.test.mjs:116`, asserting at `residual.test.mjs:65`), its mutation sibling
  `SHU251 mutation: duplicate spawn evidence after restart`, and
  `SHU251 routine shutdown preserves workers and refuses further admission`
  (`test/supervisor-service.test.mjs`). One further member: `SHU-250`'s tick assertion
  (`assert.ok(elapsed < 1000)`) inside the focused selection.
- **Where it is seen.** In the full scope, a red arrives inside the A12 guard's inner concurrent run and
  reddens the A12 row with it. In the focused selection, the SHU-250 member is seen on its own.
- **One failing assertion is captured.** At tree `478ca4dc` the full plain scope went red once on the
  live-restart member, and its captured assertion is `false !== true` at `residual.test.mjs:65` — a state
  comparison on the launch, not a wall-clock comparison. For the other reds the failure was seen only
  through the A12 guard, whose record carries the test's name and status but not the failing assertion;
  what exactly failed is captured in no artifact at any head.
- **Isolation changes the outcome; idleness does not.** Re-running the offending file alone is green
  (6/6 clock, 3/3 plain across the repeats recorded in the historical record). A full-scope run on an idle
  box is still a concurrent run and has been red again on the same member.
- **Exit codes carry no information here.** The same commit returns exit 0 with no failures under uid 1000
  with `chmod -R go-w` applied, and exit 1 with six unrelated failures under root on another host. The
  measurement that means anything in this configuration is the **name diff against an unmutated baseline**,
  never the exit code or the failure count.

## What is not established

- The mechanism. No cause is claimed here: not load, not scheduler behaviour, not a specific race. There is
  no captured evidence for any of them.
- Two of the reds seen in the historical record have no captured failing assertion at all.

## What is not to be done about it

Do not tune a timeout, widen a tolerance, add a retry, or reclassify a test as flaky in order to make a run
green. A green run obtained that way would be a measurement the record could not stand on, and the owner has
explicitly ruled it out. If the mechanism is to be fixed it needs its own lane, its own captured failing
assertion, and its own control.

## Where the raw evidence lives

Outside the repository, under `round/`: the per-mode reports and TAP files, the parent-suite survival logs
(`parent-suite-survival.txt`, `parent-prepush-survival.txt`), and the verifiers' verdicts. The historical
record `SHU71-PREREQUISITES.md` narrates how each was obtained; it is history, not authority.
