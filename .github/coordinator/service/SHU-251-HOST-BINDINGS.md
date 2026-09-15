# SHU-251 deterministic operational bindings

This package replaces the nine free-form command parameters named by the
`shu251-window-v2.sh` preparation report. It is reviewed tooling for a later
approved host window; adding it does not install a unit, access a credential,
change host permissions, start a worker, arm dispatch, or authorize SHU-71.

`shu251-operational-bindings.sh` accepts exactly one enumerated action and one
absolute JSON-spec path. The Node implementation uses fixed executable paths and
fixed argv. There is no `eval`, `sh -c`, command field, executable field, or
operator-provided argument array. Unknown fields fail the closed manifest before
an operation runs. Every failure is JSON with `ok:false`, a binding name and one
of the following typed codes.

| Missing binding from the report | Reviewed action/control | Typed failure |
| --- | --- | --- |
| remote inventory | `inventory`: clean checkout, local HEAD and `git ls-remote` main equal the approved SHA; read-only Linear comment inventory is digested and the fixture branch head must equal its target | `SHU251_REMOTE_INVENTORY` |
| transport observation | `transport`: require the Unix socket and perform an authenticated schema-checked status read | `SHU251_TRANSPORT_OBSERVATION` |
| driver quiescence | `quiescence`: all three units inactive and the canonical writer lock acquirable | `SHU251_DRIVER_QUIESCENCE` |
| fixture launch observation | `launch`: order, durable launch receipt, PID and process-start token must share one fixture identity | `SHU251_FIXTURE_LAUNCH` |
| replay/release | `replay-release`: authenticated replay of the same order, re-observe the same worker, then exclusively create its bound release marker | `SHU251_REPLAY_RELEASE` |
| worker observation | `worker`: `/proc/<pid>/stat` start token must remain identical | `SHU251_WORKER_OBSERVATION` |
| status credential delivery | internal to `transport` and `replay-release`: private root/service-owned regular file, one named key, never emitted | `SHU251_STATUS_CREDENTIAL` |
| identity-bound fixture cleanup | `cleanup`: exact launch identity, closed evidence directory, no symlinks, SIGTERM, bounded exit proof, then remove only release/journal | `SHU251_FIXTURE_CLEANUP` |
| prior-state rollback | `capture-prior` then `rollback`: exact unit bytes/modes/absence and active/enabled states, approved staged hashes, drift refusal before stop/restore | `SHU251_PRIOR_STATE_ROLLBACK` |

## Closed input contract

The spec version is `shu251-host-window-v2`. It contains only:

- the exact approved SHA, canonical checkout and the fixed StudentHub Platform
  GitHub URL/ref;
- canonical workspace/supervisor/socket paths;
- the status environment-file path and numeric non-root service UID;
- systemd unit, reviewed staged-unit and private prior-state paths; and
- one fixture object: issue ID, attempt UUID, target SHA, order JSON, release and
  journal paths, PID and Linux process-start token.

The fixture paths are data bindings, not commands. The approved work order must
match the issue, attempt and target SHA in the spec. The release file is created
with `O_EXCL`; an existing marker HALTs. Cleanup refuses to signal a PID until the
durable receipt and live process token both match, validates every deletion path
before signalling, and retains artifacts if the process does not exit.

Rollback captures the SHA-256 of each reviewed staged unit before installation.
It refuses changed/symlinked replacements before stopping anything. A target may
be byte-identical only to the captured prior file or to the reviewed staged file;
anything else HALTs instead of being overwritten.

## Composition and evidence order

The separately approved full window remains responsible for its existing signed
activation, expiry, final-main merge attestation and dispatch-off gates. It may
compose these typed actions in this order:

1. `inventory`, `quiescence`, `capture-prior` before installation;
2. `transport`, `launch`, `worker` at each required observation point;
3. `replay-release` only for the approved fixture attempt;
4. `cleanup` only for an identity-verified fixture that needs bounded teardown;
5. `quiescence`, then `rollback`, then `inventory` during final restoration.

Do not treat this order as approval to run it. The prepared host window still
requires the final exact main pin and Khalid's explicit window approval.

## Tests and mutations

`service/test/host-window-bindings.test.mjs` gives every binding a positive
control and independently corrupts the fact that authorizes it. The mutations
cover a changed remote head, public credential file, active timer, mismatched
launch receipt, reused PID token, failed authenticated transport, refused replay,
out-of-scope cleanup path and rollback record bound to another revision. Each
dies with its binding-specific `HostBindingHalt`; a free-form command field is
also rejected by the closed spec.

## One credential-owner decision remains

The tooling does not invent, copy or rotate `SHU_SUPERVISOR_SECRET`. Before a
window is approved, the credential owner must name and provision **one** approved
credential-only environment file whose parent and file satisfy the service
privacy contract, and bind that absolute path in the final window spec. The
tooling verifies ownership/mode/key name and uses the value only in memory; it
never prints it. No other free-form operational input remains in this package.
