import assert from "node:assert/strict";
import test from "node:test";

import { datasetDigest, generateSearchCandidates, matchesFilters, SEARCH_WORKLOAD } from "../src/dataset.js";
import { percentile } from "../src/metrics.js";
import { TypesenseEngine } from "../src/engines.js";
import { markdownOutputPath, recommend } from "../src/run.js";

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
    "exact-name", "typo-tolerance", "name-prefix", "country-facet", "university-facet", "skill-facet", "combined-filter",
  ]);
  const candidate = generateSearchCandidates(100)[0]!;
  assert.equal(matchesFilters(candidate, { country: "KW", university: "Gulf Tech", skill: "typescript" }), true);
  assert.equal(matchesFilters(candidate, { country: "AE" }), false);
});

test("nearest-rank percentile is stable", () => {
  assert.equal(percentile([50, 10, 40, 20, 30], 0.5), 30);
  assert.equal(percentile([50, 10, 40, 20, 30], 0.95), 50);
});

test("recommendation requires correctness and a meaningful performance margin", () => {
  const base = { indexingMs: 100, correctness: { passed: 7, total: 7 } };
  assert.match(recommend([{ ...base, engine: "Meilisearch", p50Ms: 2, p95Ms: 4 }, { ...base, engine: "Typesense", p50Ms: 3, p95Ms: 8 }]), /^Meilisearch:/);
  assert.match(recommend([{ ...base, engine: "Meilisearch", p50Ms: 2, p95Ms: 4 }, { ...base, engine: "Typesense", p50Ms: 2, p95Ms: 4.2 }]), /^No performance winner/);
  assert.match(recommend([{ ...base, engine: "Meilisearch", p50Ms: 2, p95Ms: 4, correctness: { passed: 6, total: 7 } }, { ...base, engine: "Typesense", p50Ms: 3, p95Ms: 8 }]), /^No selection/);
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
