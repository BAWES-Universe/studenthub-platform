# StudentHub PostgreSQL data layer

`PostgresAuthzStore` implements the shared authorization store and persists an
append-only audit fact in the same transaction as every principal registration,
grant, revocation, and grant clear.

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

`listAuthorizationMutationAuditRecords({ requestId })` hashes the supplied raw
request id and returns matching immutable records. The application API exposes
no update or delete operation, and the database rejects row updates/deletes.

The bootstrap command accepts `BOOTSTRAP_AUDIT_REQUEST_ID`; if absent it creates
a new request id. Its principal and root-admin grant audit rows commit in the
same bootstrap transaction.

Issuer-key registration and retirement are not covered yet because this package
does not contain a PostgreSQL issuer-key registry or issuer-key tables. They
currently exist only in the in-memory contracts reference. Their audit records
must land with the persistent issuer-key registry so the key mutation and audit
fact can share one PostgreSQL transaction.
