# SHU-244: scoped base bundle handoff

`baseBundlePath(env, attempt_id)` is the common writer/reader contract.
`SHU_WORKSPACE_STATE_DIR` is the sole authoritative root for the private full-base
bundle. Adapter session/result state may live in a different directory; it must
never be used as a bundle fallback. No new receipt fields or migration are needed.
Existing bundles in the workspace state root remain usable.

The resolver requires an absolute, canonical, private coordinator-owned root and
an ordinary, private coordinator-owned bundle when reading. Missing configuration,
missing files, symlinks, and unsafe permissions produce
`BaseBundleUnavailableError` / `BASE_BUNDLE_UNAVAILABLE`, including the configured
root and attempted path. The broker fails closed without publishing, and the
Codex adapter records this code through the existing HOLD/receipt mechanism.
The full target SHA remains verified after importing the bundle.

## Reproduction and tests

Before the fix, `SHU-244 A10: distinct-root scoped handoff bundle regression`
failed with an AssertionError containing ENOENT for
`coordinator-runs/<attempt>.base.bundle`. After the fix it publishes to a local
synthetic bare remote, verifies the result's full-target parent, preserves the
hidden trap, and binds result state in the separate adapter directory.

The `production workspace` variant calls the real `prepareAttemptWorkspace`
before the same snapshot/reconstruction/publication path. It requires distinct
worker UID support and is included in the existing Git 2.43 CI job. No path-level
mocks or live model/provider calls are used. The builder edit is deterministic.

Hermes must run this at the deployed revision before requesting another fixture
activation, in an environment supporting the fixture worker UID:

```sh
node --test --test-name-pattern='SHU-244' .github/coordinator/test/shu241-scoped-build.test.mjs
```

Require all three selected tests to pass with **zero skips**, including the
production-workspace case. All repositories and state roots created by these
tests are temporary synthetic fixtures; SHU-140's real lane is never touched.

Mutation M25 restores the adapter-root lookup (A10 must fail); M26 drops the
broker's typed refusal (A11 must fail); M27 drops adapter propagation (A4's
receipt assertion must fail). All require an AssertionError, not a syntax or
module-loading failure. The original 24 scope mutations remain in the suite.

General dispatch, activation, seeding, merging, and production operations are
outside this change. Hermes's deployed preflight and Opus's exact-head review
remain required; passing these tests is not SHU-63 acceptance.
