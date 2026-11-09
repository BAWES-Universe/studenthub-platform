# Candidate-search cutover and rollback gate (SHU-53)

This is a validation plan, not permission to touch production. The evidence in
this repository is synthetic and the selected adapter is not wired into the
legacy Yii2/Angular application. Algolia therefore remains the live engine
until a separately approved production change executes this gate.

## Evidence already executable

| Concern | Evidence | Gate |
| --- | --- | --- |
| Production-shaped volume | Deterministic SHU-47 generator, 20,000 synthetic candidate documents in CI | Dataset digest and document count are published as artifacts |
| Relevance | Exact, typo-tolerant and prefix sentinel queries | The sentinel must appear for all three workloads |
| Facets | Country, university, company, skill, gender, profile, assignment and document | Live disjunctive counts must equal deterministic truth |
| Authorization | `TypesenseCandidateSearchAdapter` requires an explicit all/ID scope | Empty scope returns no data without a request |
| Failed publication | Import receipt and collection count are checked before alias switch | A partial index is never published |
| Rollback | `CandidateIndexPublication.previousCollection` plus `rollback()` | Under the deployment lock, restore only if the alias still names that exact publication; stale rollback refuses |
| Dependency failure | Bounded HTTPS request with typed unavailable errors | Gateway remains fail-closed; no Algolia fallback is implicit |

The real-Typesense workflow publishes through the production indexer, queries
through the production adapter, rolls the alias back, and proves the candidate-
only sentinel disappears after restoration.

## Controlled migration

1. Record the live Algolia record count, monthly search operations, indexing
   operations, transfer, current bill and contract/discount terms. No estimate
   may replace those account facts.
2. Size a staging Typesense node from the same document count and measured
   concurrency. CI latency is correctness evidence, not capacity evidence.
3. Publish a content-addressed Typesense collection. Keep the returned
   publication receipt; do not delete its `previousCollection`. Every publish,
   rollback and alias change must hold the same single-writer deployment lock;
   Typesense aliases do not provide compare-and-swap.
4. Run the full relevance, facet, authorization, timeout and malformed-response
   corpus against the staging alias.
5. Shadow representative non-personal query shapes and compare result quality;
   do not mirror raw production queries or identifiers into logs.
6. Obtain the explicit production approval required by SHU-53. Without it,
   stop here.
7. Switch one reversible application configuration boundary to Typesense.
   Never add an automatic fallback to Algolia because that masks failures and
   doubles the data path.
8. Observe error rate, p95/p99 latency, zero-result rate and facet parity for
   the agreed window. Any threshold breach restores the old application
   configuration; an index-specific defect also calls `rollback(publication)`.
9. Retire Algolia only after the rollback window closes and a separate removal
   approval is recorded.

## Infrastructure and cost comparison

| Cost/operation | Algolia | Typesense on Coolify/Hetzner |
| --- | --- | --- |
| Billing shape | Usage/contract charge from the existing account | Fixed compute, storage, backups and transfer |
| Operations | Vendor-managed availability, upgrades and backups | StudentHub owns upgrades, snapshots, restore tests, monitoring and on-call response |
| Scaling | Vendor-managed and usage-priced | Node/replica capacity must be measured and provisioned |
| Exit/rollback | Existing live engine and configuration remain during validation | Content-addressed collections and guarded alias rollback |

The decision sheet must calculate both monthly totals from current account
facts: `Algolia bill + overages` versus `nodes + replicated storage + backups +
transfer + valued operator time`. This repository deliberately records no
invented price. A production decision without both totals is **HOLD**, not a
Typesense recommendation.

## Explicit holds

- No production data, credentials, deployment, traffic cutover or Algolia
  deletion is authorized by this document or its tests.
- A rollback receipt is not timeless. If another publication has moved the
  alias, rollback refuses instead of overwriting that newer release.
- The stale check is not a distributed lock. Never run publish and rollback
  concurrently; the deployment pipeline must serialize alias changes.
- Collection deletion is outside rollback. Retained collections are the
  recovery material until the rollback window closes.
