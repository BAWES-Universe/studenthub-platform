# Candidate private-document lifecycle (SHU-145)

## Implemented application path

`apps/gateway/src/index.ts` mounts `handleCandidateDocuments` inside the actual
HTTP server. `CandidateDocuments` orchestrates the existing SHU-101
`PrivateDocuments` and SHU-236-hardened `DocumentStore`; it does not replace their
authorization, signed delivery, private ACL, filesystem safety or lock semantics.
The four slots are personal photo, resume, civil-ID front and civil-ID back.
No SHU-92 field projection or profile UI is changed.

`createCandidateDocuments` takes configured `store`, `authz`, and `sessions`
ports. It resolves each opaque browser session through the existing session store
and then requires a current `candidate` grant in the configured organization.
Personal ownership is always the resolved platform principal. Being an employer,
recruiter or org owner confers no candidate-document access. SHU-200 remains a
separate decision. Anonymous and cross-person operations fail closed.

The runtime supports explicit `DOCUMENT_STORAGE=synthetic-file` or `r2`. The
common organization, origin and signing-key variables are mandatory in either
mode. Partial, mixed or unsupported configuration fails startup with a fixed
generic error. Missing configuration exposes no functional operation (503).

| Variable | Meaning |
| --- | --- |
| `DOCUMENT_STORAGE` | `synthetic-file` for isolated storage, or `r2` for R2 objects plus PostgreSQL metadata |
| `DOCUMENT_ROOT` | Synthetic mode only: existing private 0700 store initialized through `FileDocumentStore.create`; no automatic create/reset; forbidden in R2 mode |
| `DOCUMENT_ORG_ID` | Server-selected organization; candidate grants are checked here |
| `DOCUMENT_ORIGIN` | Exact default-port HTTPS origin, matching `OIDC_CALLBACK_URL`'s origin |
| `DOCUMENT_SIGNING_KEY` | Canonical base64 of at least 32 cryptographically random bytes, supplied privately |
| `DOCUMENT_R2_ACCOUNT_ID`, `DOCUMENT_R2_BUCKET` | R2 mode only: fixed account/bucket; no caller-selected provider endpoint |
| `DOCUMENT_R2_ACCESS_KEY_ID`, `DOCUMENT_R2_SECRET_ACCESS_KEY` | R2 mode only: server credentials supplied privately, never static credentials returned to clients |

The existing login configuration and `DATABASE_URL` are also required by runtime
startup. `PostgresLoginStore.sessions` and `PostgresAuthzStore` provide the actual
session and grant checks. Tests inject synthetic sessions/grants through exactly
that construction seam, run `createGatewayServer`, and use real loopback HTTP and
`FileDocumentStore` transactions. No identity header or client-selected principal
is treated as authentication.

## HTTP sequence

All responses are `private, no-store`, `nosniff`, `no-referrer` and sandboxed.
Gateway requests use the existing `__Host-studenthub_session` cookie, or an opaque bearer
value interpreted by the same session store. Every POST/PUT requires an exact
configured `Origin`; Host/forwarded headers cannot establish authority. JSON
requests require `Content-Type: application/json`. Mutation keys use SHU-233's
`Idempotency-Key: v1.<13-digit-issued-ms>.<uuid-v4>` format.

| Route | Request | Result |
| --- | --- | --- |
| `GET /candidate-documents` | Authenticated session | Own active metadata only |
| `POST /candidate-documents/uploads` | `type`, `mime`, `size`, `expectedVersion` (null for an empty slot); R2 additionally requires SHA-256 hex `sha256` and base64 `contentMd5` | One server-chosen `uploadId` and `objectKey`, an upload credential and expiry; R2 adds `directUpload.url` and signed headers |
| `PUT /candidate-documents/uploads/{uploadId}/bytes` | Raw bytes; `X-Object-Key` and `X-Upload-Credential` from authorization | 204 after private staging and server validation |
| `POST /candidate-documents/finalize` | `uploadId` only | Atomically committed metadata |
| `POST /candidate-documents/remove` | `type`, `expectedVersion` | Logical removal with held cleanup work |
| `POST /candidate-documents/delivery` | `documentId` | Existing primitive's authorized 60-second delivery URL |
| `GET /private-documents/delivery?t=…` | URL plus authenticated session | Existing primitive's attachment response |

In R2 mode the client PUTs directly to `directUpload.url` with the supplied
headers. The provider capability is bearer authority for that one PUT; the
principal binding remains in the server ticket and every finalization rechecks
the authenticated owner. The SDK signature binds the exact key, Content-Type,
Content-Length, Content-MD5, `If-None-Match: *` and a 60-second TTL. Only the first
write succeeds; a repeated PUT may return 412, after which the same owner can
finalize/retry finalization. No R2 download URL is exposed. Finalization reads
bounded bytes from the server-selected staging key, checks the ticket's SHA-256
and all admission rules, and copies accepted bytes to an immutable version key.
A mutable staging key can never become an arbitrary active-object reference.

[Cloudflare's presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
describes object/operation/expiry scoping. R2 does not support object ACL headers;
the adapter omits them and exposes no public-domain or delete API, following the
[compatibility table](https://developers.cloudflare.com/r2/api/s3/api/). Private
bucket posture and browser CORS must be independently established before use.

Local/gateway upload authorization is HMAC-bound to principal, organization, upload id, exactly
one object key, issuance time and expiry. TTL is 60 seconds. A sibling key, foreign
upload id, forged credential, clock rewind, or `now >= expiry` is refused. Expiry
is checked even on a repeated PUT with the same idempotency key. A successful
finalization receipt can still be retrieved after upload expiry: that recovers a
completed operation, and does not authorize uploading or finalizing new bytes.

The server does not accept filenames, URLs, ACLs, person ids, organizations or
existing-object references in authorization/finalization bodies. Exactly one
active version per principal/organization/slot is allowed. Both authorization
and finalization compare the expected version, so two uploads authorized from
one version cannot overwrite each other. Staged bytes become immutable after
first acceptance; different bytes require a new authorization. A fresh validation
and SHA-256 comparison precede finalization, including storage readback.

## Admission and content limits

Maximum encoded size is 10 MiB for every slot, enforced before/while reading HTTP
bodies and again in the service, independently of declared size/browser checks.
The number of bytes must equal the ticket's declared size. The existing primitive
still performs its own type/MIME/signature admission and persisted-record checks.
Additional S4 validation is deliberately conservative:

- PNG: signature, chunk boundaries/CRCs, image dimensions (maximum 16 million
  pixels), mandatory IHDR/IDAT/IEND, complete bounded zlib stream, exact scanline
  length and filter values. Accepted subset: non-interlaced 8-bit grayscale,
  RGB, grayscale-alpha or RGBA; only sRGB/gAMA/pHYs ancillary chunks. Palette,
  interlaced, animated and other metadata-bearing variants are refused.
- JPEG: SOI/EOI and segment/scan framing, frame dimensions and supported 8-bit
  grayscale/RGB frame shape. This is structural admission, not a complete
  entropy/pixel decode or a malware verdict.
- Resume PDF: conservative PDF 1.0–1.7 classic cross-reference-table subset,
  object-offset consistency, catalog/page presence and terminal EOF. Incremental,
  encrypted, embedded-file and explicitly active-action documents are rejected.
  Modern object-stream/xref-stream PDFs need a future approved validation adapter.

These limits are new-platform admission rules, not assertions that every legacy
upload or every valid PDF/JPEG variant is accepted. No OCR, antivirus, generated
thumbnail, inline preview or product UI is introduced. Downloaded documents are
attachments. Production acceptance needs approved full parser/scanner evidence;
these checks must not be described as malware clearance.

## Atomicity, retries and retention

The existing document state gains an optional, validated `lifecycle` journal;
old SHU-101 filesystem snapshots open without a migration. R2 mode uses the
new isolated `0145_candidate_private_documents.sql` migration. All existing document tests and
mutations remain unchanged. A snapshot transaction includes staged upload tickets,
active/retired metadata and bytes, idempotency receipt, cleanup queue and durable
successful-write audit. Public metadata contains none of the journal.

The existing `createIdempotency` contract supplies key format/time validation,
canonical payload fingerprints, principal/key uniqueness and mismatch refusal.
Its adapter executes the business callback inside `DocumentStore.transaction`;
there is no detached map, preflight-only claim or second metadata commit. It checks
transaction time and current grants before looking up a receipt. Snapshot rename or SQL COMMIT
can still have an uncertain outcome (SHU-101): replaying the same key returns the
persisted response if committed and executes once if not. The default seven-day
key age limit remains enforced even though this initial journal retains receipts.

Replacement/remove retire prior bytes through the primitive and add one cleanup
entry keyed by document id + immutable version. Both occur in the same transaction.
Callback/commit failure leaves the old reference, bytes, audit and cleanup queue
unchanged. Busy writers return unavailable; retry the same key. Concurrent writes
that lose the version comparison return conflict and must reload metadata.

**Physical deletion is deliberately unavailable.** SHU-202/D6 is still undecided;
no grace period, legal-hold release or deletion authority is inferred. Every
cleanup entry is `held`, and repeated operator-only `cleanup()` inspections return
counts without deleting bytes. `held` counts each retired-version cleanup entry
plus each staged `uploads[].data` body, even expired/abandoned uploads and legacy
committed duplicates; empty tickets do not count. Finalization atomically releases
only the superseded staged journal copy after creating the committed copy. A failed
commit retains the staged body. No R2 object is deleted, and existing held object
reservations remain; these separately account for cloud staging/rollback orphans.
This preserves unresolved retention and every legal hold. Staged/abandoned uploads and receipts are retained too; no expiry-driven
physical purge, automatic lock stealing or background cleanup loop is introduced.
Approval of retention/hold rules and an independently verified purge worker are
required before that posture can change. The reference snapshot's 256 MiB cap
remains a hard capacity boundary, not a production sizing recommendation.

**Reachable capacity/availability limit:** one authenticated candidate can reach
the 256 MiB journal boundary in roughly 16–21 ordinary uploads. Independent R3
verification measured **254 MiB after 21 abandoned cycles**, with a list call
slowing from **~3 ms to 1672 ms**. In R2 mode the **192 MiB hydration cap is crossed
at about 16 cycles**, after which **EVERY route, including read-only delivery,
fails unavailable for EVERY candidate** sharing the aggregate. These are measured
workload-dependent limits, not a per-candidate quota or an isolation guarantee.
Releasing finalized duplicates does not address abandoned uploads or the shared
aggregate limit; read-audit rows also consume journal capacity. **No remediation
path exists until SHU-202/D6 decides** retention and deletion authority. This slice
adds no purge, expiry sweep, or operator bypass to recover exhausted capacity.

`PostgresDocumentSnapshot` locks one private metadata row with `FOR UPDATE` and
commits references, receipts and audit together. `R2DocumentStore` hydrates bytes
only inside the server transaction, invokes the unchanged primitive validators,
and stores bodies exclusively in immutable R2 objects. Packed PostgreSQL state
contains `r2:` references and SHA-256/size descriptors, not document bodies.
A separate connection pool commits a held reservation before every new R2 key
can be written, so SQL rollback does not lose the record of possible orphan bytes.
Reservations include direct-upload staging keys and survive unknown PUT outcomes.
Provider errors are generic and no delete/list/bucket/IAM operations are issued.

This correctness-first adapter serializes one bounded aggregate and hydrates
retained objects; it is not a claim of production-scale throughput. It limits
hydration to 192 MiB, hydrated snapshots to 256 MiB, packed metadata to 16 MiB,
provider requests to 10 seconds and SQL lock waits to 5 seconds. Capacity/latency,
backup/restore, retention and scanner evidence remain operational acceptance
work before real user data or broad use.

**Read-audit decision:** successful list (including empty lists), delivery issuance,
and delivery redemption now commit durable `list`, `issueDelivery`, and `deliver`
rows in the same transaction as authorization and access. A commit failure returns
unavailable without returning a link or bytes. This explicitly closes the prior
R3 observation that one civil-ID-class issuance plus redemption produced zero
events and zero durable rows. Denied/failed reads do not produce success rows;
this is a successful-access ledger, not a complete denied-attempt audit trail.
The primitive's `audit: undefined` suppresses its operational callback because
the lifecycle owns durable auditing; it no longer silently suppresses read records.
No raw document identifiers or URLs are added to the audit payload.

**Read-audit operational cost:** private reads were previously pure reads; now
every `list` / `issueDelivery` / `deliver` performs a full-journal durable write.
In `PostgresDocumentSnapshot`, every candidate GET therefore issues a
whole-snapshot `jsonb` UPDATE under the singleton `FOR UPDATE` lock. Independent
R3-PERF measurements at `641d4ed694556608bad854c23ab4e613e3d79d2d`, using the same
store with audit enabled versus runtime-disabled, measured list latency of
**5.68 ms vs 1.49 ms (3.8x)** for a **5 KiB** journal and **404.7 ms vs 301.7 ms
(1.3x)** for a **50.8 MiB** journal. Writing is inherent to durable read auditing;
the dominant cost at scale remains the pre-existing full-journal hydration.
This is an operational cost, with capacity/latency acceptance still required
before real user data or broad use.

Durable mutation and read-audit rows contain only server-generated id, operation,
SHA-256 principal reference and time. Operational callbacks contain exactly
`{operation, code}`; thrown, rejecting or hanging callbacks cannot alter a
committed result. Errors use a closed generic vocabulary and never serialize
exception objects, object keys, upload credentials or signed URLs. The existing
gateway telemetry excludes raw request paths/headers/bodies. External access logs,
proxies and tracing must also redact full URLs and credential headers before use.

## Parity authority and parallel integration

Authority: `BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63`,
through the merged SHU-123 inventory (`profile-and-private-documents.md`). The
reviewed inventory supersedes early card wording: legacy AWS config is anonymous,
not authenticated. Personal-photo removal (`AccountController.php:356–366`) and
resume replacement/removal (`:1286–1345`) delete storage before save; corrected
civil-photo removal (`:382–507`) saves first. S4 uses metadata-first retirement for
all four slots and never inherits arbitrary legacy key prefixes (F7).

The target for new cloud uploads is **R2 only**. Both configured runtime paths
are implemented: local gateway PUT into the synthetic store, and R2 direct PUT
with PostgreSQL metadata. R2 tests use the real SDK signer and transport
serialization with fabricated credentials and an in-memory object endpoint;
an independent SigV4 verifier challenges path, size, type, checksum and expiry.
They never contact Cloudflare. Provider privacy, browser CORS, upload-header
behavior, credentials, migration application and throughput still need approved
configured-environment evidence. No AWS bucket or legacy access is introduced.

Fable owns SHU-92. Its field contract, repository and rendered page are untouched.
Shared integration edits are limited to `apps/gateway/src/index.ts` (one optional
service argument, route dispatch and runtime startup) and root dependency/test scripts. The document SQL migration uses the unique
`0145_` name and isolated tables to avoid Fable’s profile schema. The
new runtime module owns its session/authz connections, avoiding edits to
`login-runtime.ts`. If Fable changes the server signature/startup, preserve both
integrations explicitly when reconciling branches; no conflict has been hidden
by modifying the profile projection.

## Verification

Run `npm ci --ignore-scripts`, `npm run typecheck`, and `npm test`.
The normal test/CI path includes:

```
npm run test:documents:lifecycle
npm run test:documents:lifecycle:mutations
npm run test:documents:r2
```

The real-handler suite covers four slots; anonymous, employer and cross-person
refusal; sibling keys; expiration; malformed/type/size/digest failures; receipt
replays and mismatches; revoked grants; concurrent replacements; injected failed
replacement/removal and uncertain commits; CSRF; redaction; held cleanup and
unconfigured startup. The mutation harness copies the compiled gateway dependency
graph, applies one source defect and requires the designated TAP test plus
`AssertionError`/`ERR_ASSERTION`. Syntax, module, signal and timeout failures do
not count as kills. M1–M4 implement the card's required mutations; M5–M16 pin
additional expiry, ownership, validation, concurrency, cleanup, redaction and
readback, R2 signed-size and orphan-reservation boundaries. M12 additionally destroys the prior payload before an
injected failed replacement commit and must fail the old-bytes assertion. M2 reaches SHU-101's private-ACL check through the mounted
handler, so its generic refusal becomes an explicit failed success assertion.

`npm run test:db` also runs three real-PostgreSQL document tests: rollback with
surviving reservations, concurrent adapter instances and uncertain-commit retry.
They require an explicitly configured scratch database; absent configuration is
reported as a skip in the focused command, never as observed SQL behavior.

Local evidence is not an independent PASS or cloud acceptance. PostgreSQL, Docker,
Compose, provider access-control behavior, approved retention/scanning policy and
live storage remain separate configured-environment gates. No deployment,
provider/IAM edits, production data/credentials, orchestrator work or dispatch
activation is part of this change.
