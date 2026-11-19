# F-3 transfer lifecycle integration handoff

Restacked after F-1 squash `472e2983faab85793b5dff52a2b9e9859c544eef`.
Spec: desk #393 `a303d7efe568bd510d8df9b75fbbb74044504528`,
`docs/lanes/pay/F-3.md`, decisions-2026-10-27.md, finance-outcomes.md.
Main parity: `docs/parity/finance-contracts-and-payroll.md` FI-F9/F10/F15.

This slice includes the lifecycle domain, PostgreSQL adapter and its own migration.
It is not a deployed payroll journey: no shared exports, gateway routes, provider
calls or money movement.
No permission matrix is guessed. No default/no-op billing adapter is supplied.

## Interfaces

- F-1: use `draft | locked | payment_sent | distributing | complete | cancelled`.
  Domain includes explicit legacy numeric mapping. Line writes and lifecycle
  writes must lock the SAME parent transfer row; enforce draft-only line writes
  with version checks. Lifecycle adapter increments version on state change.
  Soft deleted transfers are not writable. F-1 schema remains F-1-owned.
- F-2: creates draft transfers/lines through F-1. Generation does not call a
  provider, mark paid or bypass lifecycle. Current-company membership is checked
  again at lock, matching legacy, even if assignment was valid during the period.
- F-4: exports read locked transfer/line snapshots; no implicit state transition
  on export. Repeated `payment_sent` commands refuse and never duplicate history.
- Billing: `ensureChildrenAndInvoices` invokes billing's existing proposed
  `issueForLockedTransfer(tx, transfer)` on the SAME SQL client. Stable child /
  invoice identities survive unlock/relock. Calculation, ownership and invoice
  issuance remain billing's responsibility. `markInvoicesPaid` invokes its
  corresponding parent/child payment-received port. No wallet dependency.
- F-5: after changing paid flags under parent row lock, call
  `transitionInTransaction` with that same transaction to complete, or reopen
  after a real unpaid change. Do not nest the outer `transition` transaction.
- Access: authorize every command in its transaction, company-scoped; map admin
  revert/unlock separately. Trusted actor must explicitly have `actingAs:false`.
  Session authentication, fresh grants and verified role mapping remain adapter
  obligations. Do not wire this to an unchecked public endpoint.
- Audit: appendHistory and all cascade/invoice/state writes commit together;
  exceptions escape and MUST roll back. No history for refused commands.

## Proven locally / not yet proven

68 synthetic tests: all 54 state/action pairs, permission and act-as denial,
current membership, paid guards, Kuwait date boundary, injected late rollback
and retry, serialized double lock, relock identity preservation, delete/receipt
rollback. The serial in-memory transactional double proves orchestration calls
and guards; it does NOT prove PostgreSQL locking, constraints, concurrent SQL
clients, real invoice issuance, authorization wiring or atomic F-5 paid changes.
Those require the F-1 adapter/schema and billing adapter, then disposable PG tests.

Reproduce (from repo root with existing TypeScript dev dependencies):

```sh
node_modules/.bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --strict --skipLibCheck --esModuleInterop --outDir .f3-build \
  packages/payroll/src/transfer-lifecycle.ts packages/payroll/test/transfer-lifecycle.test.ts
node --test .f3-build/test/transfer-lifecycle.test.js
```

Root package/wiring remains integrator-owned. Only the F-3 migration 0562 is used.

## PostgreSQL follow-up (local only)

F3 now adds `packages/db/src/payroll/postgres-transfer-lifecycle-store.ts` and
`0562_pay_transfer_lifecycle.sql`. The adapter locks the actual F1 parent row,
updates its optimistic version, stores Kuwait receipt date, and appends immutable
history in the same transaction. An authorized admin unlock records its witness
before changing state, binding the same transfer, source state/version and DB
transaction. The guard rejects company reassignment independently and limits
the unlock update to status and version; the witness is not a replacement for
Access policy or a boundary against a role allowed to forge history. No child/invoice schema is invented. Missing
billing effects explicitly throw `pay_lifecycle_billing_unavailable`; lock,
payment-received and deletion cannot report false success without that adapter.
Access/current-membership policy is mandatory and transaction-bound. Its eventual
production implementation must preserve current membership consistently (including
appropriate locks against concurrent assignment changes), not merely copy the
synthetic test policy. Administrative capability mapping remains unwired.

Disposable PostgreSQL 17.11: **8/8 passed**, no skips. Exact F1 0550 and production
F1 line writer used, all main migrations applied on a new empty local database.
Two separately named clients were observed BOTH waiting on database locks before
release: one transition, one refusal, one history/effect row. F1 append was also
observed blocked by F3's parent lock, then refused after lock committed. Late
invoice and audit failures rolled back effects/status/version/history, with retry.
Verified missing-port refusal, paid guard, Kuwait date, immutable audit, policy /
current-membership denial and F5 same-client paid-state rollback and commit.

The effect table in tests is explicitly synthetic: it proves transaction boundaries,
NOT real invoice or child-transfer creation/cascade. Production billing, Access,
route composition, grant wiring and generator activation remain outstanding.
F5 must treat any refused domain result after an earlier paid mutation as grounds
to roll back its overall operation; callers must not commit a partial result.

Run focused tsc over `packages/db/test/postgres-transfer-lifecycle.test.ts`, then
run emitted test from repo root with a newly created local PostgreSQL DATABASE_URL.
Local receipt runner `pay-f3-pg.sh` creates/stops its own PG cluster, no live host.
The db workspace's own `tsc -p packages/db/tsconfig.build.json` also passes.
