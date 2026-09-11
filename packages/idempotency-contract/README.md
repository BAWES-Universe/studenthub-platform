# StudentHub idempotency and retry contract

`@studenthub/idempotency-contract` is the executable SHU-233 contract for every
state-changing HTTP endpoint in the replacement platform. A lost response may
be retried, but one logical request produces one committed transaction and one
transactional-outbox notification.

## Wire contract

- Every application mutation (`POST`, `PUT`, `PATCH`, or `DELETE`) supplies
  `Idempotency-Key: v1.<issued-at-unix-ms>.<uuid-v4>`. The client creates it once
  before the first attempt and keeps the exact value for every retry.
- The server fingerprints the authenticated principal reference, method,
  canonical route template, and a canonical JSON payload containing **all**
  body, path, and query values that can change the operation. Object key order
  has no effect. Raw login subjects are not part of the record.
- The uniqueness boundary is `(principal_ref, idempotency_key)`. A database
  adapter must insert that unique record, apply business rows, enqueue durable
  outbox rows, and store the complete HTTP result in one transaction. The same
  transaction compares expiry to the database clock before lookup or insert,
  closing the race with cleanup. A preflight `SELECT`, process-local lock,
  cache, or best-effort notification is not a conforming implementation.
- A same-key, same-fingerprint replay returns the originally stored status,
  headers, and body without invoking the operation. Two concurrent arrivals
  serialize on the unique record; the loser returns that same result.
- A same-key request with a different principal-scoped method, route, or
  payload is refused with `409 key_payload_mismatch` and writes nothing.
- If the transaction fails, its key claim, domain rows, outbox rows, and result
  all roll back. The response is `503 operation_failed`; retry with the same key
  is allowed because nothing committed.

## Retention and expiry

Records are retained for seven days by default. Cleanup deletes records whose
`expires_at` has passed, so storage is bounded. The key carries its immutable
issuance time and the executor rejects it with `409 key_expired` **before any
store lookup** once the retention window ends. Therefore deleting an expired
record cannot turn a late replay into a fresh write. Keys more than five minutes
in the future are rejected; deployments may narrow, but not remove, this bound.

Changing retention is a coordinated server-and-client contract change. A
client must stop automatic retries before the server's retention window ends
and surface an indeterminate result for reconciliation instead of minting a new
key for the same action.

## Relationship to SHU-82 safe writes

The action token and idempotency key prevent different failures:

| Write class | Required mechanism | Reason |
| -- | -- | -- |
| Preview/confirm high-consequence write governed by SHU-82 | SHU-82 action token | The single-use, change-bound token is already the durable dedupe key and its atomic receipt is the original result. The confirm route must map that token to this store boundary; a second independent client key adds no guarantee. |
| Direct application mutation with no preview/confirm flow | SHU-233 idempotency key | Transport retry can occur after commit but before the response arrives. |
| Naturally idempotent session deletion (`POST /logout`) | Endpoint invariant, documented exception | Repeating deletion produces the same logged-out state and no duplicate business row or notification. |
| OIDC callback | Login contract state/nonce single-use rule | It is a protocol continuation, not an application mutation; replay is already refused atomically. |
| Read-only `POST /mcp/tools/call` at the current revision | No write mechanism while tools are read-only | Before any tool is allowed to mutate, its write path must declare SHU-82 or SHU-233 coverage. |

No future application write may be merged without selecting one of the first
two rows and running the corresponding executable contract. An endpoint cannot
claim the logout/OIDC/read-only exceptions merely because its handler happens
to use `POST`.

## Replacement-client retry rule

The replacement client never retries a write merely because it saw a timeout,
`502`, or `503`. It may retry only when the endpoint declares SHU-233 support,
the exact original key and semantic payload are available, and the key is still
inside the retention window. A changed payload is a new user action and needs a
new key. After expiry, the client reconciles by reading state; it does not submit
the action again automatically.

The legacy Angular `genericRetryStrategy` is a negative reference only. Its
blind retries of `POST`, `PATCH`, and `DELETE` without a key are not inherited.

## Executable evidence

`SHU-233/AC-01` through `AC-06` bind each acceptance clause. The required
`SHU-233/parity-contract` fixture seeds a transfer-generating period and a
decidable work session, then proves committed replay, simulated gateway timeout,
concurrency, payload conflict, rollback/retry, and one outbox notification per
write. `npm run test:idempotency:mutations` changes the compiled implementation
twice: it removes the payload check, then makes key records non-unique. The
named parity test must fail for both mutations.

## Boundaries

This package has no production route or database connection and performs no
legacy write. It changes no frontend. Each consuming slice remains responsible
for a PostgreSQL adapter whose transaction and unique constraint satisfy the
store port.
