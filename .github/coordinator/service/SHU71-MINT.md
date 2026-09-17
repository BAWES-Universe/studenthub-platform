# Repository-only unsigned package mint

`mint-shu71-package.mjs` is the sole new entrypoint. It accepts paths, two captured
ledgers, and policy bounds. No caller package, signature, revision, fixture, reseed
field, evidence path, or command is accepted. `validate` regenerates the expected
result from the same authorities and compares every field.

```
node .github/coordinator/service/mint-shu71-package.mjs mint \
  /absolute/clean/current-main-checkout /srv/shu/repo \
  /absolute/activation-id-ledger.json /absolute/observations.json \
  /absolute/new-output-directory 3600000 60000
node .github/coordinator/service/mint-shu71-package.mjs validate \
  /absolute/clean/current-main-checkout /srv/shu/repo \
  /absolute/activation-id-ledger.json /absolute/observations.json \
  /absolute/new-output-directory 3600000 60000
```

The output directory must not exist for `mint`. It receives `package.json`,
`spec.json`, `window.json`, and a last-written `complete.json` hash manifest.
`window_spec_path` binds the supplied output location; place the reviewed files
there for the driver. Both signatures and lifecycle approval digest are empty.
The signing/owner stages remain necessary. No host action is performed.

ID ledger schema: `version: shu71-activation-id-ledger-v1`, `captured_at`,
`source`, nonempty unique `ids`, exact `count`, and `sha256` over the IDs in
listed order separated by LF, including the final LF. Candidate ID is
`shu71-mint-` plus the eight-digit minimum-width decimal `count + 1`.
Membership is explicitly checked; collisions refuse, never search or coerce.
This proves absence only from the supplied capture, not from future activity.

Observation ledger schema: `version: shu71-mint-observations-v1`, `captured_at`,
`source`, `observations`, and `sha256`. Digest covers canonical JSON of all
fields except `sha256` (recursive sorted keys, no whitespace or final newline).
Capture timestamps must be valid UTC ISO instants; numeric IDs and loose dates
are rejected without coercion. It is capture integrity, not a signature or independent host attestation.
The orchestrator must supply a truthful capture; a self-computed digest cannot
establish its provenance. `observations` has exactly:

- `identity`: user, group, uid, gid, supplementary groups;
- `environment`: supervisor/coordinator file metadata only (path, uid, gid,
  mode, kind); no secret contents;
- `directories`: workspace and supervisor directory metadata;
- `checkout_before`: sha, head_ref (null or refs/heads/main), main, origin_main,
  tree, clean; dirty baselines refuse;
- `systemd_version` and the exact existing lifecycle `capabilities` list;
- `issues`: the two current issue identifiers, Linear UUIDs, state UUIDs and
  assignee UUIDs/null; `ready_state_id` is the observed ready state UUID;
- `worker_uid` and `reviewer_uid`.

Creation time derives from observation capture time, not ambient wall time.
Lifetime and maximum observation age must each be positive integer milliseconds
no greater than 43,200,000 (the existing twelve-hour policy). Future/stale
observations, stale ID captures, observations older than the ID ledger, and
expired output refuse. The maximum age bound applies to both ledgers.
For identical valid inputs, advancing time changes admissibility but never bytes.

The local checkout must equal live remote main and local origin/main, be clean,
and match every tracked Git blob and executable mode, including files hidden by
index flags. Git remote access is read-only `ls-remote` to the fixed repository.
Both lane refs must agree locally, in origin tracking, and remotely. SHU-140 is
pinned to the reviewed retained parent `6e5ad86cc0a993097d2e642132077b665ad49481`;
SHU-254 uses the existing fixed seed constant. A future lane advance requires
review of that pin. The existing append contract computes the merge tree,
canonical patch manifest and deterministic seed commit in a temporary object
store. It verifies the sealed blobs and retained ancestry.

Fixtures and lane policy come from committed config. Package constants come
from the existing activation validator. Driver commands come only from
`serviceParameters` with `/usr/bin/node`; unit hashes use committed templates,
its quoting function and the existing lifecycle dispatch-off drop-ins. This
repository-only rendering reads no host environment files. The normal host
renderer and lifecycle still validate actual environment contents at execution.
The synthetic control's launch UUID is deterministically derived for a future
attempt; process identity is null. No order, launch, or running-worker evidence
is claimed by minting a spec.

Refusal vocabulary is recorded in source as `MINT_*`: usage/path/input errors,
ID ledger shape/digest/reuse/unknown, observation shape/digest/age, identity,
environment, directories, prior Git, capabilities, issues, remote, revision,
tree, fixtures, lineage, branch, patch, evidence, signatures, commands,
package/spec disagreement, required fields, expiry, rendering and deterministic
full-output equality. Existing `SHU71_RESEED_*` and composer `ACT_*` /
`CLOSURE_APPROVAL_*` validation codes are preserved when those contracts refuse.

Tests add three names to the existing inventory without changing any existing
name, assertion, capability row, or permitted skip. They exercise named input
and output mutations, actual Git object derivation with a doubled remote read,
and source mutants which must fail at their named assertions. The controls use
synthetic host observations explicitly; they cannot authorize a live window.
