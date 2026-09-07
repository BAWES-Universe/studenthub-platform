# SHU-63 activation contract

`codex login` on the brick box plus a Claude subscription token is the **auth**
surface. It is not the **activation** surface. A Codex builder that authenticates
perfectly still cannot do the job unless seven further things are true, and each
one fails later, less visibly, and more expensively than a refusal at dispatch.

The coordinator therefore refuses to start a `codex-cli` worker until all seven
hold. The check runs at the dispatch decision in `main()`, not inside the
adapter, because activation is a coordinator-level property.

**Option A inverted two of these.** The worker now commits locally and never
pushes; a host-side broker running under the coordinator identity performs every
remote operation. So requirements 1 and 3 no longer ask the worker to prove it
can reach the network and push — they require that it *cannot*. Declaring either
capability is now itself an unmet requirement, because it contradicts the prompt
the adapter sends in the same run. A gate an operator can satisfy only by
declaring something the design forbids is worse than no gate.

| # | Requirement | How it is established | What breaks without it |
|---|---|---|---|
| 1 | `codex_sandbox_network` | **Declared**: `CODEX_SANDBOX_NETWORK=disabled` under the broker (`enabled` in legacy worker-push mode) | the worker is told "do NOT touch the network" and the broker owns every remote call; a networked worker contradicts its own instructions and reopens the egress path Option A closes |
| 2 | `github_head_credentials` | **Checked**: `GITHUB_TOKEN` is non-empty and can read the exact bound repository commit | the live branch head can never be resolved, so a completed worker cannot be checked against the branch it reports |
| 3 | `git_push_authentication` | **Inverted under the broker**: `CODEX_GIT_PUSH_READY` must be UNSET. In legacy worker-push mode it is declared `true` and an available push remote is also checked | the worker must hold no push credentials at all; if it does, the deploy key is no longer confined to the coordinator and Option A's whole boundary is gone |
| 3b | `host_push_broker` | **Checked**: `SHU_PUSH_BROKER_ENABLED=true` plus `SHU_WORKTREE_ROOT` and `SHU_PUSH_REMOTE_URL` | nothing pushes the worker's commit, so finished work never leaves the box |
| 3c | `worker_identity_split` | **Declared and checked**: `SHU_WORKER_UID` (numeric, non-root, and verified ≠ the coordinator's own uid) plus `SHU_WORKER_LAUNCH_WRAPPER`, the privilege-drop command the builder is launched through | the broker repository is mode 0700, which stops a *different* OS user and nothing else. A same-uid worker can write `url.*.insteadOf` into the broker's own repository after it is created and redirect the push — reproduced against this branch, `same_uid_config_write: true`, `redirected: true` |
| 4 | `durable_state_persistence` | **Checked**: the state directory can be created, resolves to a private directory, is writable, and neither its configured nor real path is under `/tmp`, `/var/tmp`, `/dev/shm` or `/run` | the Codex thread id is lost on reboot and the session becomes unresumable — exactly when recovery is needed; shared write access also lets another local account forge recovery authority |
| 5 | `coordinator_on_brick_box` | **Checked**: `COORDINATOR_HOST` matches the running hostname | the sidecars are host-local; written on an ephemeral runner they describe a machine that no longer exists, and every ownership check silently degrades to "unknown" |

Requirement 1 cannot be probed from inside the coordinator process — the sandbox
network posture is a property of the CLI's configuration on the box — so it is
declared rather than observed. The declaration is recorded so the assumption is
visible instead of implied.

Requirement 3's legacy branch is kept and guarded rather than deleted: 3b
refuses worker-push mode outright today, so that branch cannot be part of a
passing preflight, but keeping it means the requirement does not silently vanish
if 3b is ever relaxed. In that mode a remote URL is still not evidence of
authentication, and a worktree with no push remote fails even when
`CODEX_GIT_PUSH_READY=true`.

Requirement 3c is enforced **unconditionally**, not only under the broker. Scoping it to broker mode left a hole the contract's own meta-test caught: a requirement that can be skipped is not enforced, and this is the one least able to afford that.

Both halves are required together. `SHU_WORKER_UID` with no wrapper is a uid nothing applies; a wrapper with no distinct uid is a no-op. The adapter launches the builder **through** the wrapper, so the gate names a mechanism that actually runs. Which mechanism — `setpriv`, `sudo -u`, a systemd user unit — is a host decision this contract does not make.

**Not covered by 3b:** proof that the *broker's own* host-side credential works.
That needs a live `ls-remote` under the coordinator identity — a network probe in
preflight — and is tracked as a SHU-69 fixture-readiness gate, not here.

**Open deployment question:** whether the worker needs network for
*dependencies* (install, test fixtures) even though it needs none for git. If it
does, the builder prompt and requirement 1 must change together and on purpose.
Failing closed is what forces that, instead of letting the two quietly
disagree.

## Behaviour when unmet

Dispatch aborts before the adapter boundary, the lane is paused durably
(`coordinator-pause: codex-cli`), no worker starts, and the coordinator exits 2
naming every unmet requirement with the operator action that fixes it.
The check runs before a `RESERVED` receipt is written, so a refused activation
cannot strand a nonterminal receipt that launch recovery does not process.

Successful builder callbacks echo both `target_sha` (the checkout they started
from) and `result_sha` (the commit they created locally — under Option A the
broker pushes it, the worker does not). Completion verifies the live
work branch against `result_sha`; comparing it to `target_sha` would reject the
branch movement the builder was launched to produce.

## Activating

```bash
# on the brick box
codex login                                   # requirement: auth, not activation
export COORDINATOR_HOST="$(hostname)"         # 5
export CODEX_HOME=/srv/codex                  # 4 — persistent, not /tmp
export GITHUB_TOKEN=<repo-scoped token>       # 2
export CODEX_SANDBOX_NETWORK=disabled         # 1 — the worker performs no remote call
unset CODEX_GIT_PUSH_READY                    # 3 — the worker holds no push credentials

# 3b — the host broker is the only pusher; the deploy key lives HERE, not in the
# worker's worktree or environment.
export SHU_PUSH_BROKER_ENABLED=true
export SHU_WORKTREE_ROOT=/srv/shu/worktrees   # approved root; worktrees are confined to it
export SHU_PUSH_REMOTE_URL=git@github.com:BAWES-Universe/studenthub-platform.git
# export SHU_PUSH_SSH_COMMAND=...             # optional: only this selects the ssh program

# 3c — the builder must NOT share the coordinator's OS identity, or it can
# rewrite the broker's own repository and redirect the push.
export SHU_WORKER_UID="$(id -u shu-worker)"
export SHU_WORKER_LAUNCH_WRAPPER="setpriv --reuid=shu-worker --regid=shu-worker --clear-groups"
```

`ENABLE_DISPATCH` stays unset. Nothing here enables dispatch; the contract only
governs what happens once someone does.

## Test seam

`io.skipActivationPreflight` exists for tests whose subject is some other
dispatch property. It is never set by the workflow, so production always runs
the contract.
