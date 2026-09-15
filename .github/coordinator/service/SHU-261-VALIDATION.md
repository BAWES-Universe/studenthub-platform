# SHU-261 reviewer filesystem isolation

Status: repository implementation complete; separately gated host mutation **not
executed**. This document is not activation authority.

## Deployed contract

Both exact-head tests and the Claude review process cross the same root-owned
`reviewer-sandbox.sh` entry point and execute as the existing non-root
`shu-reviewer` identity. The coordinator remains `shu-coordinator`, writers
remain `shu-worker`, and attempt directories remain direct mode-0750 children of
`/srv/shu/worktrees` governed by `shu-workspace`.

The wrapper grants a temporary read/traverse ACL only to the assigned attempt,
then removes it on every exit. The checkout is read-only and non-executable.
Sibling attempts and the deployed authority paths are inaccessible mounts.
Tests use a networkless profile; the model profile retains ordinary provider
network address families and receives only its own subscription OAuth value.

Writer/broker separation is unchanged: reviewers receive no GitHub, Linear,
supervisor or SSH credential; their Claude tool surface is `Read,Glob,Grep`; and
the closed reviewer callback schema rejects `result_sha` or any other writer
authority field.

## Attack evidence

| Attack | Positive control | Confined result / named guard |
| --- | --- | --- |
| direct protected path | target opens before confinement | every `SHU261_CLASS_*` is `DENIED` |
| checkout symlink | symlink reaches the target before confinement | `SHU261_SYMLINK` |
| `..` traversal | resolved traversal reaches the target before confinement | `SHU261_TRAVERSAL` |
| hardlink | protected sentinel is linked into the attempt | wrapper refuses before execution; `SHU261_HARDLINK` |
| inherited descriptor | parent can read a unique open-FD canary | `SHU261_FD` |
| inherited environment | canary is detectable under an innocent key | `SHU261_ENVIRONMENT` |
| process inspection | coordinator-UID command-line canary is visible before confinement | `SHU261_PROCESS` |
| sibling worktree | sibling exact-head worktree sentinel opens before confinement | `SHU261_CLASS_SIBLING_ATTEMPTS` |
| assigned checkout | detached worktree HEAD equals the approved SHA | distinct reviewer UID, SHU-261 test executed, exit 0 |

The protected classes are activation records, workspace authority, supervisor
secrets (both the configured `/etc/shu` root and deployed
`/srv/shu/service.env`), `/srv/shu/coordinator.env`, SSH credentials, Codex sidecars, Claude
sidecars, coordinator-private logs, and sibling attempts. Probes open and close
protected paths without copying their contents. Retained evidence contains only
revision, uid/gid/mode and `DENIED`/test-result fields.

`shu261-mutations.test.mjs` independently weakens each protected class and each
attack detector, direct model confinement, hardlink refusal, sibling masking,
same-identity serialization, process hiding, and OAuth argv handling. Every
mutation must fail a named assertion.

## Prepared host window — do not run without separate approval

The future approval must name one exact clean revision. It may install only:

- `.github/coordinator/reviewer-sandbox.sh` as
  `/usr/local/libexec/shu-reviewer-sandbox`, `root:root`, mode `0755`;
- `.github/coordinator/service/shu-reviewer.sudoers` as
  `/etc/sudoers.d/shu-reviewer`, `root:root`, mode `0440`.

Before replacement, the operator must make a private byte-for-byte backup of
each existing destination or record that it was absent. Validate the staged
sudoers file with `/usr/sbin/visudo -cf` before replacement. On any failure,
restore both destinations to their exact prior bytes/modes/ownership and stop.
Do not create users, alter persistent attempt ACLs, start or enable services,
enable dispatch, load credentials, or run a real review.

Only after installation and a second exact-revision/clean-tree check may an
already-root approved shell run:

```sh
SHU261_HOST_MUTATION_APPROVED=true \
  /usr/bin/node .github/coordinator/service/reviewer-host-validation.mjs \
  --approved-host-mutation <exact-40-character-approved-revision>
```

The harness first proves installed wrapper/sudoers byte identity and sudoers
syntax. It then creates two temporary detached worktrees at the approved SHA,
performs the bounded sentinel/attack mutations, runs the SHU-261 test from the
assigned worktree, removes both worktrees, and requires the final worktree
inventory to equal the initial inventory byte-for-byte. It never calls
`systemctl`, starts the coordinator, enables dispatch, or prints protected
contents. Host evidence remains **PENDING** until that separately approved
command succeeds; repository tests do not claim otherwise.

## Safe repository verification

```sh
bash -n .github/coordinator/reviewer-sandbox.sh
/usr/sbin/visudo -cf .github/coordinator/service/shu-reviewer.sudoers
node --check .github/coordinator/service/reviewer-host-validation.mjs
node --test .github/coordinator/test/shu261-reviewer-isolation.test.mjs \
  .github/coordinator/test/shu261-mutations.test.mjs
```

The Work-mode container cannot bind Unix sockets or expose stable host PIDs, so
the repository-wide SHU-251/SHU-71 lifecycle batteries fail here. The same
failures reproduce on an untouched `main` checkout. All other coordinator tests
are run separately with `SHU251_NO_SYSTEMD=1`; the PR receipt must record their
exact count and any explicit skips.
