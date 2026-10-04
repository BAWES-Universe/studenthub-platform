# StudentHub PostgreSQL data layer

`PostgresAuthzStore` implements the shared authorization store and persists an
append-only audit fact in the same transaction as every principal registration,
grant, revocation, and grant clear.

Logical no-ops do not create audit facts: unchanged principal registration,
idempotent grants, unmatched revocations, empty clears, and identical bootstrap
runs return without rewriting authorization state.

Mutation methods accept an optional final audit context:

```ts
await store.grantMany(principalId, entries, {
  requestId: request.correlationId,
  actorPrincipalId: authenticatedPrincipal.id,
});
```

Callers handling a request should pass both values. Compatibility calls that do
not yet have a request context receive a generated request reference and a null
actor. The database never receives the raw request id, actor principal id,
target principal id, or organization id; domain-separated SHA-256 references
make records correlatable without copying identity or request material into the
ledger. Before/after summaries contain counts and presence flags only.

`listAuthorizationMutationAuditRecords({ requestId, limit })` hashes the supplied
raw request id and returns matching immutable records. Reads default to the 100
most recent rows and are capped at 1,000. The application API exposes no update
or delete operation, and the database rejects row updates/deletes.

The bootstrap command accepts `BOOTSTRAP_AUDIT_REQUEST_ID`; if absent it creates
a new request id. Its principal and root-admin grant audit rows commit in the
same bootstrap transaction.

Issuer-key registration and retirement are not covered yet because this package
does not contain a PostgreSQL issuer-key registry or issuer-key tables. They
currently exist only in the in-memory contracts reference. Their audit records
must land with the persistent issuer-key registry so the key mutation and audit
fact can share one PostgreSQL transaction.

## First safe write (SHU-84)

`PostgresSafeWriteStore` binds SHU-82's `SafeWriteStore` port to the one field
SHU-83 permits: a person's language preference (`en` or `ar`), stored in
`person_preferences` (migration 0147). The platform owns this field. It is not
imported from, mirrored to, or read by legacy, and a missing row is the
contract's absent value.

`forPrincipal(principalId)` returns the port for one signed-in person. Every
reference the contract passes back is compared with that binding, so the port
cannot read or write another person's record. One transaction does all of
this:

- It takes the same per-principal advisory lock `PostgresAuthzStore` takes for
  every grant change. A revocation therefore lands before the ownership check
  or after the commit, never in between.
- It refuses a token whose reference already sits on a receipt row. A unique
  index on that reference backs the check, so single use holds across
  processes and restarts.
- It re-derives write authority from current grants: the principal must still
  exist and still hold at least one grant.
- It compare-and-writes the field against the value the preview showed. An
  insert never overwrites an existing value.
- It inserts the receipt into `authorization_mutation_audit` as operation
  `profile.safe_write`. This is not a second audit surface: the receipt shares
  SHU-59's append-only ledger and its transaction, so a receipt failure undoes
  the field.

Receipt rows hold references and closed vocabulary only. The before half is a
presence flag. The after half holds the contract version, person reference,
change-set digest, `["language"]`, the commit instant and a hashed token
reference. The database's summary check rejects any other key or shape.
`readReceipt(principalId, receiptRef)` returns only the caller's own receipt.
Another person's reference reads exactly like a missing one.

The gateway mounts the path only when `SAFE_WRITE_SIGNING_KEY` (base64, at
least 32 bytes) is set. The deployment does not pass that variable, so no
deployed gateway accepts a write until a separate deployment change enables it.
