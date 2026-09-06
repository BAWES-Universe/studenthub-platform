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
| 2 | `github_head_credentials` | **Checked**: `GITHUB_TOKEN` non-empty | the live branch head can never be resolved, so the stale-head guard degrades to "the bound head is the reference" and a superseded tree can satisfy a receipt |
| 3 | `git_push_authentication` | **Checked** when `io.gitPushRemote` is available, otherwise **declared** via `CODEX_GIT_PUSH_READY=true` | finished work never leaves the box |
| 4 | `durable_state_persistence` | **Checked**: the state directory exists, is a directory, is writable, and is not under `/tmp`, `/var/tmp`, `/dev/shm` or `/run` | the Codex thread id is lost on reboot and the session becomes unresumable — exactly when recovery is needed |
| 5 | `coordinator_on_brick_box` | **Checked**: `COORDINATOR_HOST` matches the running hostname | the sidecars are host-local; written on an ephemeral runner they describe a machine that no longer exists, and every ownership check silently degrades to "unknown" |

Requirement 1 cannot be probed from inside the coordinator process — the sandbox
network posture is a property of the CLI's configuration on the box — so it is
declared rather than observed. The declaration is recorded so the assumption is
visible instead of implied. Where a real observation is possible it **outranks**
the declaration: a worktree with no push remote fails requirement 3 even when
`CODEX_GIT_PUSH_READY=true`.

## Behaviour when unmet

Dispatch aborts before the adapter boundary, the lane is paused durably
(`coordinator-pause: codex-cli`), no worker starts, and the coordinator exits 2
naming every unmet requirement with the operator action that fixes it.

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
