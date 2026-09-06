# SHU-63 activation contract

`codex login` on the brick box plus a Claude subscription token is the **auth**
surface. It is not the **activation** surface. A Codex builder that authenticates
perfectly still cannot do the job unless five further things are true, and each
one fails later, less visibly, and more expensively than a refusal at dispatch.

The coordinator therefore refuses to start a `codex-cli` worker until all five
hold. The check runs at the dispatch decision in `main()`, not inside the
adapter, because activation is a coordinator-level property.

| # | Requirement | How it is established | What breaks without it |
|---|---|---|---|
| 1 | `codex_sandbox_network` | **Declared**: `CODEX_SANDBOX_NETWORK=enabled` | `codex exec` runs under `--sandbox workspace-write`; without network it cannot fetch or push, so the builder finishes with nothing to show |
| 2 | `github_head_credentials` | **Checked**: `GITHUB_TOKEN` is non-empty and can read the exact bound repository commit | the live branch head can never be resolved, so a completed worker cannot be checked against the branch it reports |
| 3 | `git_push_authentication` | **Declared** via `CODEX_GIT_PUSH_READY=true`; a configured push remote is also checked when available | finished work never leaves the box |
| 4 | `durable_state_persistence` | **Checked**: the state directory can be created, resolves to a private directory, is writable, and neither its configured nor real path is under `/tmp`, `/var/tmp`, `/dev/shm` or `/run` | the Codex thread id is lost on reboot and the session becomes unresumable — exactly when recovery is needed; shared write access also lets another local account forge recovery authority |
| 5 | `coordinator_on_brick_box` | **Checked**: `COORDINATOR_HOST` matches the running hostname | the sidecars are host-local; written on an ephemeral runner they describe a machine that no longer exists, and every ownership check silently degrades to "unknown" |

Requirement 1 cannot be probed from inside the coordinator process — the sandbox
network posture is a property of the CLI's configuration on the box — so it is
declared rather than observed. The declaration is recorded so the assumption is
visible instead of implied. A remote URL is not evidence of authentication, so
requirement 3 always needs the explicit post-verification declaration. Where a
real observation is possible it is an additional requirement: a worktree with no
push remote fails even when `CODEX_GIT_PUSH_READY=true`.

## Behaviour when unmet

Dispatch aborts before the adapter boundary, the lane is paused durably
(`coordinator-pause: codex-cli`), no worker starts, and the coordinator exits 2
naming every unmet requirement with the operator action that fixes it.
The check runs before a `RESERVED` receipt is written, so a refused activation
cannot strand a nonterminal receipt that launch recovery does not process.

Successful builder callbacks echo both `target_sha` (the checkout they started
from) and `result_sha` (the commit they pushed). Completion verifies the live
work branch against `result_sha`; comparing it to `target_sha` would reject the
branch movement the builder was launched to produce.

## Activating

```bash
# on the brick box
codex login                                   # requirement: auth, not activation
export COORDINATOR_HOST="$(hostname)"         # 5
export CODEX_HOME=/srv/codex                  # 4 — persistent, not /tmp
export GITHUB_TOKEN=<repo-scoped token>       # 2
export CODEX_GIT_PUSH_READY=true              # 3 — after wiring a deploy key
export CODEX_SANDBOX_NETWORK=enabled          # 1 — after confirming the sandbox
```

`ENABLE_DISPATCH` stays unset. Nothing here enables dispatch; the contract only
governs what happens once someone does.

## Test seam

`io.skipActivationPreflight` exists for tests whose subject is some other
dispatch property. It is never set by the workflow, so production always runs
the contract.
