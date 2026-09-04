import assert from "node:assert/strict";
import test from "node:test";

import { datasetDigest, facetCounts, generateSearchCandidates, matchesFilters, SEARCH_WORKLOAD } from "../src/dataset.js";
import { percentile } from "../src/metrics.js";
import { TypesenseEngine } from "../src/engines.js";
import { markdownOutputPath, recommend, sameFacetCounts } from "../src/run.js";

test("dataset is deterministic, synthetic and includes the relevance sentinel", () => {
  const first = generateSearchCandidates(500);
  const second = generateSearchCandidates(500);
  assert.equal(datasetDigest(first), datasetDigest(second));
  assert.equal(first[0]?.id, "candidate-000001");
  assert.equal(first[0]?.name, "Quasar Benchmark");
  assert.ok(first.every((candidate) => candidate.email.endsWith("@search-benchmark.invalid")));
});

test("workload covers relevance and the donor search facets", () => {
  assert.deepEqual(SEARCH_WORKLOAD.map((query) => query.name), [
    "exact-name", "typo-tolerance", "name-prefix", "all-facet-counts", "country-facet", "university-facet", "skill-facet",
    "company-facet", "gender-facet", "profile-facet", "assignment-facet", "document-facet", "combined-filter",
  ]);
  const candidate = generateSearchCandidates(100)[0]!;
  assert.equal(matchesFilters(candidate, { country: "KW", university: "Gulf Tech", skill: "typescript" }), true);
  assert.equal(matchesFilters(candidate, { country: "AE" }), false);
});

test("facet truth covers all live staff-search buckets and changes with filters", () => {
  const candidates = generateSearchCandidates(500);
  const all = facetCounts(candidates);
  const filteredCandidates = candidates.filter((candidate) => matchesFilters(candidate, { country: "KW", assignment: "assigned" }));
  const filtered = facetCounts(filteredCandidates);
  assert.deepEqual(Object.keys(all), ["country", "university", "company", "skills", "gender", "profile", "assignment", "documents"]);
  assert.equal(Object.values(all.country).reduce((sum, count) => sum + count, 0), candidates.length);
  assert.equal(Object.values(filtered.country).reduce((sum, count) => sum + count, 0), filteredCandidates.length);
  assert.equal(sameFacetCounts(all, structuredClone(all)), true);
  assert.equal(sameFacetCounts(all, { ...all, country: { ...all.country, KW: (all.country.KW ?? 0) + 1 } }), false);
});

test("nearest-rank percentile is stable", () => {
  assert.equal(percentile([50, 10, 40, 20, 30], 0.5), 30);
  assert.equal(percentile([50, 10, 40, 20, 30], 0.95), 50);
});

test("recommendation requires correctness and a meaningful performance margin", () => {
  const base = { indexingMs: 100, correctness: { passed: 13, total: 13, facetCasesPassed: 10, facetCasesTotal: 10 } };
  assert.match(recommend([{ ...base, engine: "Meilisearch", p50Ms: 2, p95Ms: 4 }, { ...base, engine: "Typesense", p50Ms: 3, p95Ms: 8 }]), /^Meilisearch:/);
  assert.match(recommend([{ ...base, engine: "Meilisearch", p50Ms: 2, p95Ms: 4 }, { ...base, engine: "Typesense", p50Ms: 2, p95Ms: 4.2 }]), /^No performance winner/);
  assert.match(recommend([{ ...base, engine: "Meilisearch", p50Ms: 2, p95Ms: 4, correctness: { passed: 12, total: 13, facetCasesPassed: 9, facetCasesTotal: 10 } }, { ...base, engine: "Typesense", p50Ms: 3, p95Ms: 8 }]), /^No selection/);
});

test("Typesense credentials are only allowed over HTTPS or loopback HTTP", () => {
  assert.doesNotThrow(() => new TypesenseEngine("https://search.example.invalid", "key"));
  assert.doesNotThrow(() => new TypesenseEngine("http://127.0.0.1:8108", "key"));
  assert.doesNotThrow(() => new TypesenseEngine("http://[::1]:8108", "key"));
  assert.throws(() => new TypesenseEngine("http://search.example.invalid", "key"), /must use HTTPS/);
});

test("report paths cannot overwrite the JSON artifact", () => {
  assert.equal(markdownOutputPath("results/search.json"), "results/search.md");
  assert.throws(() => markdownOutputPath("results/search"), /must end in \.json/);
});
