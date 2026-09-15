# SHU-71 two-fixture activation package

This package is preparation only. It does not arm dispatch, reseed a branch,
change a Linear card, install a service, touch a credential, or run a worker.
The committed dispatch gate remains off. SHU-140 and SHU-254 are synthetic
fixtures and no result from either lane has merge authority.

The reviewed state machine is `shu71-activation-package.mjs`. A package binds:

- one 8–64 character activation ID and a UTC window no longer than 12 hours;
- the exact coordinator/main revision;
- exactly two slots and exactly SHU-140 plus SHU-254;
- SHU-254 at `6c9c14907189fe3af733969c3d8f3a2c4e21f9b0`;
- an append-only, non-forcing SHU-140 reseed from the retained branch head to
  one exact resulting seed head and one exact patch digest;
- each fixture's immutable Linear UUID, branch and lane identity;
- the exact prior state and assignee, the unassigned Todo state used during the
  proof, and restoration to the captured prior values;
- identity-bound cleanup under `/srv/shu/worktrees` and append-only evidence
  retained under `/srv/shu/state/shu71-evidence`;
- the existing `two-fixture-v1` runtime envelope with both gates true,
  `stop_before_merge: true`, and no merge authority.

The whole package is signed. Both verification paths load the single committed
`.github/coordinator/shu71-activation-public-key.pem` through the exported
`SHU71_PUBLIC_KEY_PATH` in `shu71-public-key.mjs`. This is the absolute sibling
path in the running checkout, with plain-path, no-dot-segment, exact-path and
regular-file checks (`ACT_PUBLIC_KEY_PATH`). Supplied public keys are equality
checks against that source, never alternate authorities.

## Anchor provenance and execution authorization

ANCHOR PROVENANCE: `shu71-trust-anchor.json.provenance_revision` identifies
`bd13e3fcea6361c46acb0d94df4918603c6601c1` (#125), the reviewed revision that
established the committed public key. The public PEM and SPKI fingerprint stay
in the repository. Provenance supplies no execution authority.

EXECUTION AUTHORIZATION: the separate signed activation record's
`coordinator_revision` names the final approved execution SHA. Never copy the
provenance SHA into this field as a substitute for execution approval.

Final-revision binding step: first fix and approve the execution commit; then
have the authorized signing process produce the detached package and runtime
record with that existing SHA in both `coordinator_revision` fields and a
bounded `expires_at`. Keep those signed records outside the execution commit;
do not edit the anchor to bind an execution or embed a commit's own hash.
This correction produces no operational signature or activation record.

`executionBindingError()` requires a valid record binding, equality with the
approved main revision, and equality with the observed checkout revision.
`validateTwoFixtureActivation()` enforces it along with expiry and the signature
from the committed key. `validateShu71Package()` checks the outer binding and
exact inner projection; `validateAnchor()` checks provenance, the fingerprint,
and the separate inner binding. Anchor validation alone is not signature or
expiry validation: the package must still pass both signature checks and its
window check. Missing bindings, wrong approved revisions and checkout drift
refuse. A valid anchor with differing provenance cannot authorize execution.
The read-only runtime entry point obtains the checkout SHA through
`resolveCoordinatorRevision()`; package callers must supply observed checkout
and approved main evidence, not derive either from the anchor.

See [reconciliation](service/ACTIVATION-WINDOW-RECONCILIATION.md) for the public
fingerprint, mutation assertions and the remaining final-revision binding.

## Structured operations

`runShu71Command()` exposes only `reseed`, `activate`, and `revoke` operations.
There is no shell-command field and no merge callback.

1. `reseed` accepts only the signed SHU-140 append operation. It checks the
   retained parent before mutation and refuses unless the resulting commit,
   parent and patch digest exactly match the signed package. Evidence is
   append-only.
2. `activate` revalidates both exact seed heads, records the prior fixture state,
   clears both assignees into the bound Todo state, verifies both cards, installs
   the already-signed runtime envelope, and then sets the runtime gate through a
   typed adapter. Any partial failure disables/archives what was installed and
   restores every fixture already changed.
3. `revoke` disables first, archives rather than deletes the envelope, restores
   both exact prior states and assignees, removes only identity-bound fixture
   worktrees, and retains all evidence. Cleanup ambiguity HALTs with
   `ACT_CLEANUP_FAILED`; it never broadens deletion.

Tests use in-memory keys and adapters only. They do not generate an operational
key or perform host, GitHub, Linear, fixture, credential, dispatch, or activation
actions.
