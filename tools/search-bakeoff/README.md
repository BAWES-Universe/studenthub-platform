# SHU-47 candidate search bake-off

This tool compares Meilisearch and Typesense against the same deterministic,
synthetic candidate-search workload. It measures clean indexing time and warm
query p50/p95, then gates any recommendation on search and filter correctness.

The workload mirrors the donor staff candidate-search boundary: candidate
name/contact/skill text plus country, university, company, skill, gender,
profile, assignment and document facets. For the initial view and every
filter-only workload, each engine's live result total and every returned facet
bucket count must exactly match the deterministic local truth. No donor or
production data is read. All email values use a reserved, non-deliverable TLD.

Run both engines locally on the default ports, then execute:

```sh
TYPESENSE_API_KEY=shu47-local-key npm run benchmark:search -- --documents 10000 --iterations 30
```

The dedicated GitHub workflow pins both engine versions and publishes JSON and
Markdown artifacts. Runner measurements are comparative evidence, not production
capacity guarantees. Implementation, cutover and Algolia retirement are tracked
separately and are deliberately out of scope here.
