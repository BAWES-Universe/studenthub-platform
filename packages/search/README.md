# Candidate search adapter

`TypesenseCandidateSearchAdapter` is the engine-neutral read boundary for candidate discovery.

- MySQL remains the source of truth.
- Callers provide structured filters; raw Typesense filter expressions are not accepted.
- All eight staff-search facets return live disjunctive counts: other active filters apply while a facet's own selections are excluded from its counts.
- Every request requires an explicit `all` or `candidate-ids` authorization scope; raw Typesense filter expressions are never accepted.
- Non-loopback endpoints must use HTTPS before an API-key header can be constructed.

This package does not index live records, deploy Typesense, change the legacy UI, cut over traffic, or remove Algolia.
