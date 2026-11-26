# Changed-test evidence pilot

This advisory GitHub Actions job records what happened when the PR's changed
`*.test.ts` and `*.test.mjs` files were run on its exact head. Existing full CI,
branch protection and independent exact-head review are unchanged. The normal
Node 22 job still controls baseline CI; the separate pilot uses Node 24's
structured `node:test` events.

- Select added/modified/renamed files from the base/head merge-base diff.
  Run compiled `dist` counterparts for TypeScript. Vitest, PostgreSQL and
  Typesense integration files are marked unavailable, not passed.
- Report PASS, FAIL, NO_RUN, TIMEOUT or UNAVAILABLE with reasons, elapsed
  time and child exit/signal. A successful file wrapper, printed "PASS",
  skipped-only tests or a missing changed literal test name cannot count
  as proof that the file completed real cases.
- Literal name checks are intentionally conservative: directly imported
  `node:test` bindings only, no general inference for dynamic names,
  aliased wrappers or runtime-generated tests. Matching is by name,
  not a source-location attestation.
- Allow up to 30 s per child and a 120 s analysis/test budget, with bounded
  output, process-group termination and a separate workflow timeout.
  A failed prerequisite is reported as unavailable.
- The digest identifies the serialized report; it does not authenticate it.
  The runner executes PR code using a disposable, read-only-token GitHub
  runner with no supplied secrets or persisted checkout credentials.
  This is not a malicious-code sandbox. The helper and report are not trusted
  inputs for privileged workflows, merges or orchestration.

Run the pilot fixtures after `npm ci --ignore-scripts` with Node 24:
`node --test tools/test-preflight/*.unit.mjs`.
