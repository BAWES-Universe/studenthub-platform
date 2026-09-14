# Typed own-profile projection (SHU-92)

This package turns one explicitly linked, approved StudentHub snapshot into the
closed `studenthub.own-profile.v1` response. It does not expose a principal
registry row and it never searches for a legacy person by email, name, phone or
another mutable attribute.

The parity authority is `BAWES-Universe/studenthub` at
`c2ce255695eabc7e3a0f23b162f5996274234c63`, pinned by the independently
reviewed SHU-123 inventory. The final inventory supersedes the early SHU-92
comment for completeness: the meaning includes the conditional Kuwaiti-mother
requirement plus at least one education and skill row. The projection carries
that state without recreating or changing the production policy.

Every field is `available` or explicitly `unavailable`. Each includes its
production source, pinned revision and imported-snapshot timestamp. A missing
source column is `not_imported`; an approved null is `not_recorded`. Empty text,
bad dates, unknown enum codes and unknown pending-field tokens reject the whole
snapshot at the adapter boundary. `asOfDate` binds the date used to derive age
and the civil-expiry boolean.

`ApprovedProfileAdapter` is deliberately only a seam. Its implementation must
return a previously approved immutable `principalId → candidateRef` mapping.
Missing and one-to-many/many-to-one mappings fail closed; the included in-memory
adapter is for synthetic tests and local previews only. The runtime default has
no data and returns no linkage. This package performs no production access,
import, reconciliation or write and makes no migration-readiness claim.

The response intentionally excludes email, phone, civil-ID number, document
keys and URLs, resume, bank details, video, coordinates and staff-only fields.
Age is a date-derived display value only; the historical 16–25 write validator
is not reproduced as a new eligibility decision.

Unpopulated until an approved snapshot contains them: every domain field. The
current live wiring has no approved-data adapter, so it fails closed instead of
falling back to OIDC/principal display name or email.
