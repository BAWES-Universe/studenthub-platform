# SHU-140 fixture — declared conformance oracle

Acceptance rows for the fixture helper `scanVacuousTests`
(`tools/fixture/scan-vacuous.mjs`, non-production lane `coordinator/SHU-140`).

* `scan-vacuous.expectations.mjs` — every row states the report the helper MUST
  produce for the given source, per the contract documented in the helper itself.
* The helper and the fixture's tests must satisfy every declared row.
* The fixture lane defines no package script over this directory, so these rows
  are not executed by `node --test`; they are read at review time. A row that
  disagrees with the contract therefore stays green in CI.
