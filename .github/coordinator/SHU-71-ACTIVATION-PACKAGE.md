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

The whole package is signed. The key is accepted only when its Ed25519 SPKI
fingerprint and coordinator revision equal a separately owner-approved,
host-local trust-anchor manifest. A key inside the package cannot appoint
itself. The repository deliberately contains only an unprovisioned schema
sentinel, so every
operational invocation currently HALTs with `ACT_KEY_AUTHORITY_REQUIRED`.

Private-key generation and custody are not implemented here. The owner must
approve one Ed25519 public trust anchor (public SPKI PEM plus SHA-256 fingerprint)
and authorize a host-local manifest that binds it to the final reviewed main
revision. The corresponding private key is provisioned outside the repository.
The private key must never be committed, printed, passed in a process argument,
or written to evidence. This avoids an impossible self-referential manifest in
which a committed file would need to contain the SHA of the commit containing it.

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
