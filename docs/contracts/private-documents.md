# Private documents — SHU-101

## Implemented boundary

`packages/private-documents/src/index.ts` provides a server-only storage and
expiring-delivery primitive, a durable private filesystem reference adapter, and
an opt-in Node HTTP download handler. No route is mounted in the running gateway;
no deployment configuration, legacy code, bucket, or production data is changed.
SHU-145 and SHU-160 own capability/UI integration and safe-write orchestration.
This PR does not implement their browser upload credentials or claim live acceptance.

The implementation accepts bytes, never a remote URL, caller-selected object key,
filename, bucket, or storage credential. Upload/copy ACL is exclusively `private`;
public ACL requests and public records returned by storage fail closed. Metadata
contains only `id`, `version`, `type`, `mime`, and `size`. Document IDs are opaque
random UUIDs; knowing one grants no access. No storage URL is returned.

| Type | Accepted media | Maximum |
| --- | --- | --- |
| Personal photo, civil-ID front/back, video thumbnail, company logo | PNG / JPEG | 10 MiB |
| Resume | PDF | 10 MiB |
| Commercial licence | PDF / PNG / JPEG | 10 MiB |
| Candidate video | MP4 | 100 MiB |

These are explicit new-platform admission limits, not a claim of legacy format
parity. File signatures and MIME must agree. Signature checks are admission
checks, not a malware scan or proof that a complete file decodes. Content is
served as an attachment, with `nosniff`, `no-store`, a sandbox CSP in the HTTP
handler, and no-referrer. No inline rendering/transcoding is provided here.

Production authority read for the type inventory:

- `BAWES-Universe/studenthub`, `common/models/Candidate.php`: personal photo,
  resume, civil-photo front/back, video and generated thumbnail; current source
  retrieved 2026-09-11. The card also references baseline `c2ce255`.
- `common/models/Company.php`, blob `0e1353cf7964347707d24726eb24d0654781b0a9`:
  company logo and commercial licence; consistent with SHU-160.
- `common/components/S3ResourceManager.php`, blob
  `608a407e9bff4317f591f547c64ec5e7f55553e9`: `save`, `saveContent`, `copy`,
  `delete`, and unsigned `getUrl` behavior. This is code evidence, not effective
  live-bucket exposure evidence.

## Authorization and delivery

The constructor requires a trusted `authenticate(opaqueCredential)` adapter and
an `AuthzStore`. An HTTP caller supplies an opaque bearer session/assertion; the
adapter must verify it and resolve its identity. Test fixtures map synthetic
strings to synthetic principals; that mapping is not a production authenticator.
There is no client-selected actor, role, or authorization callback on an operation.

Every operation resolves current grants through `resolveActiveContext` against
the stored resource organization. Personal documents require the `candidate`
role and exact owner principal. Organization documents require `org-owner` in
the target organization, including only inheritance explicitly granted by the
existing resolver. A generic staff/admin/recruiter role does not unlock personal
documents. Employer access to candidate documents remains denied pending SHU-200;
this primitive does not settle that decision. Copies authorize both source and
destination. Replacement cannot change owner, organization or document type.

Delivery URLs carry HMAC-SHA256 authenticated claims bound to document ID,
immutable version, a keyed principal reference, issuance time and expiry. TTL
is 60 seconds by default, restricted to integer 1–300 seconds. The signing key
must be at least 32 bytes and must be supplied securely by the integrator; rotating
it invalidates outstanding links. Exact origin/path/query shape and signature
are checked. Every redemption also re-authenticates and re-reads current grants.
The URL is therefore not a bearer authority on its own. Expiry is exclusive:
`now >= exp` denies. Replacement changes the version; logical deletion removes
the active record. Both revoke old links immediately on the next operation.

`handleDelivery(req, res)` supports authenticated GET only at
`/private-documents/delivery?t=...`. It constructs the canonical origin from
configuration, never Host/forwarded headers. It returns generic 403/503 errors,
404 for other paths and 405 for other methods. The embedding HTTP service must
use HTTPS and redact the full request URL and Authorization header in its access
logs, tracing, proxies and error reporting. The package itself emits only
`{operation, code}` operational events and never logs exception objects, keys,
contents, identity values or delivery URLs. Audit sink exceptions cannot turn a
committed operation into an apparent failure.

## Transactional storage and failures

`FileDocumentStore` is an actual durable adapter for **isolated synthetic storage**,
not an S3 stub and not a deployed production provider. A private 0700 directory
holds a 0600 snapshot containing private metadata and base64 bytes. Opening an
existing store never initializes missing state. Symlink/non-regular/multiply-linked
state files, unexpected owner/modes, malformed state, and public ACL records fail
closed. Server operators must own and protect the configured root and its parents;
this is not a boundary against a malicious process with the same OS identity.
Never place the root beneath a static server's document root.

An exclusive create lock serializes **all** reads and writes across instances and
processes. Busy or stale locks yield `unavailable`; there is no automatic lock
stealing. A failed transaction callback leaves the prior snapshot unchanged.
Changes commit by private temporary-file write, fsync, atomic rename and directory
fsync. Readers observe the old or new complete record, never an intermediate
replacement or partial deletion. Failure after rename can produce an uncertain
commit; callers must inspect state before retrying a write. Exactly-once writes
and user-facing action receipts belong to the consuming safe-write path.

The adapter reads/re-writes the snapshot and caps it at 256 MiB. It favors an
executable isolated reference over production scale. A production object-store
adapter must provide equivalent authorization, privacy, atomic metadata/version
and revocation behavior and run this conformance suite before activation. This PR
makes no S3 policy, IAM, throughput or production-readiness claim.

Replace/delete atomically retire old records and bytes into an inaccessible
retention queue in the same snapshot. No delivery or metadata operation reads
retired records. A failed commit neither removes the old reference nor schedules
its cleanup. There is deliberately no physical purge API before retention/legal
hold policy is approved. Stale locks and interrupted private temporary files
require operator inspection after proving no writer remains; they never justify
serving an object publicly or resetting the store.

## Test and negative-control map

Run `npm test` (builds first), or after `npm run build`:

```
npm run test:documents
npm run test:documents:mutations
```

The tests were written before implementation (initial missing-module failure);
the HTTP adapter test separately failed on its missing method before it was
implemented. All fixtures are fabricated byte markers, never identity documents.
The named mutation runner operates on disposable compiled module copies, checks
that each edit binds exactly once, and requires its named test to fail. Syntax,
missing-module and process failures do not count as mutation kills.

| Contract | Named controls |
| --- | --- |
| Private uploads/copies and all required types | AC01, NC-PUBLIC, NC-STORE |
| Unauthorized/cross-person/forged identity | NC-AUTH |
| Org-owner boundary and cross-org denial | NC-ORG, NC-CROSSORG |
| Unsigned/key-guessing/tampered delivery | NC-UNSIGNED, NC-SIGNATURE |
| Expiry, fresh authorization, recipient binding | NC-EXPIRY, NC-REVOKE, NC-SUBJECT |
| Replace/delete invalidate active references and versions | AC-REPLACE |
| Rejected uploads have zero persistence | NC-UPLOAD |
| Storage/auth failures and logging containment | NC-FAILURE, NC-LOGS |
| Durable restart, private permissions and exclusive writer | AC-DURABLE, NC-FS |
| Commit rollback and retention separation | NC-COMMIT |
| Real HTTP delivery and response boundaries | AC-HTTP |

The 17 mutations remove unsigned-delivery refusal, organization binding, deletion,
ACL admission, private upload/copy defaults, authorization, person binding, expiry,
signature, recipient/version binding, content admission, exception redaction,
metadata minimization, retired-record preservation, and filesystem mode checks.
A mutation kill is author evidence, not an independent PASS.

## Separate migration and retention plan — not execution authority

1. Follow SHU-54 first: obtain the read-only public-access-block configuration
   and effective ACL evidence without document contents, object keys or URLs in
   tickets or PRs. The code requests public-read; actual public exposure is
   **not established** by that alone. Any live remediation follows SHU-54's
   decision path and a separate implementation authorization.
2. Under SHU-97/SHU-103, design a synthetic manifest mapping legacy references
   (including all historical civil-ID prefixes) to one new owner, organization,
   document type and immutable version. Quarantine unknown/ambiguous ownership;
   do not infer permission from an old public link. Use protected manifests;
   only aggregate reconciliation counts belong in review evidence.
3. Before copying real data, approve target provider/privacy controls, isolated
   credentials, encryption/backup policy, malware validation, explicit retention
   periods, legal holds, deletion authority and rollback. Do not reuse legacy
   public ACLs or static client AWS credentials.
4. Copy to private staging; verify checksum, size/type, owner mapping, deny tests
   and expiring delivery. Commit new metadata only after successful verification.
   Failed copies/commits preserve the prior reference. Keep migration separate
   from application cutover and independently verify the exact code head.
5. Resolve hold/retention for retired objects and failed-copy orphans before
   enabling a separate idempotent cleanup worker. It must recheck that an object
   is unreferenced, its retention elapsed and no hold exists before deletion;
   unknown policy holds the object. Test duplicates, crashes and policy changes.
6. Legacy deletion, rollback-window closure and production cutover require their
   own authorized decisions. No legacy ACL edits, copies, reads of real contents,
   deletion or live migration happened in SHU-101.
