# Capacity scheduler contract

SHU-70 defines a launch-independent capacity policy and durable host-local
ledger. It is an interface slice: it does not wire reconcile, activate
dispatch, install a service, or claim live four-way execution.

Each task explicitly names its role, runtime, host, shared subscription
account, repository, branch, isolated worktree, overlap keys, estimated cost,
deadline, retry, and revision. Reservations are serialized under one exclusive
host-local transaction lock so the capacity snapshot and write cannot race.
The lock is not stolen by age; ambiguity HOLDs rather than oversubscribing.
Directory hardening opens the state directory with `O_NOFOLLOW`, applies mode
`0700` through that descriptor, and verifies the path still names the same
inode. The configured state root's parent remains part of the trusted host
boundary and must not be writable by worker identities.

The policy enforces:

- global, host, shared-account, and optional runtime limits;
- one active writer per repository branch and one owner per worktree;
- dependency and declared-overlap exclusion;
- eligibility Rule 6 (SHU-219): children of open or Done parents are
  dispatchable — only children of terminal-canceled parents
  (`Canceled`/`Duplicate`) are excluded; parent state never deadlocks a slice;
- a global reviewer reserve so builders cannot starve verification;
- resource-scoped pauses and expiring quota backoff;
- explicit spending, deadline, retry, and revision bounds;
- no unknown host/account quota, unknown cost, premium escalation, or provider
  fallback interpreted as authority (premium approval lives in trusted policy,
  never a self-asserted task field);
- malformed persisted costs, reservations, and pauses fail closed without
  overwriting the ledger needed for diagnosis;
- `LAUNCH_UNKNOWN` and ambiguous `HOLD` retain capacity indefinitely;
- an allowlisted status view containing role/runtime/status, hold reason, next
  automatic action, and the genuine human decision—never task prompts or
  credentials.

Before IPC, the caller must transition `reserved` to `dispatching` durably.
Only an untouched `reserved` acknowledgement has a TTL; `dispatching`,
`RUNNING`, `LAUNCH_UNKNOWN`, and ambiguous `HOLD` retain capacity by age. This
closes the crash window between supervisor contact and result reconciliation.

Production integration should submit an accepted reservation to the SHU-67
supervisor using the SHU-68 role-neutral work order. That shared-file wiring is
intentionally outside this slice and remains dispatch-disabled until its own
review and live-fixture gate.
