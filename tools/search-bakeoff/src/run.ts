import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { datasetDigest, facetCounts, FACET_FIELDS, generateSearchCandidates, matchesFilters, SEARCH_WORKLOAD, type FacetCounts, type SearchCandidate } from "./dataset.js";
import { MeilisearchEngine, TypesenseEngine, type SearchEngine } from "./engines.js";
import { percentile, roundMilliseconds } from "./metrics.js";

interface EngineResult {
  readonly engine: string;
  readonly indexingMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly correctness: { readonly passed: number; readonly total: number; readonly facetCasesPassed: number; readonly facetCasesTotal: number };
}

function valueAfter(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function waitHealthy(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`search service did not become healthy: ${url}`);
}

async function benchmark(engine: SearchEngine, documents: readonly SearchCandidate[], iterations: number): Promise<EngineResult> {
  const documentsById = new Map(documents.map((candidate) => [candidate.id, candidate]));
  const expectedTotals = new Map(
    SEARCH_WORKLOAD.map((query) => [query.name, documents.filter((candidate) => matchesFilters(candidate, query.filters)).length]),
  );
  const expectedFacets = new Map(
    SEARCH_WORKLOAD.filter((query) => query.query === "").map((query) => [
      query.name,
      facetCounts(documents.filter((candidate) => matchesFilters(candidate, query.filters))),
    ]),
  );
  const started = performance.now();
  await engine.resetAndIndex(documents);
  const indexingMs = performance.now() - started;
  const samples: number[] = [];
  let passed = 0;
  let facetCasesPassed = 0;

  for (const query of SEARCH_WORKLOAD) {
    for (let warmup = 0; warmup < 3; warmup += 1) await engine.search(query);
    let queryCorrect = true;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const searchStarted = performance.now();
      const result = await engine.search(query);
      samples.push(performance.now() - searchStarted);
      const returned = result.ids.map((id) => documentsById.get(id)).filter((candidate): candidate is SearchCandidate => candidate !== undefined);
      if (returned.length !== result.ids.length) queryCorrect = false;
      if (returned.some((candidate) => !matchesFilters(candidate, query.filters))) queryCorrect = false;
      if (query.expectedId && !result.ids.includes(query.expectedId)) queryCorrect = false;
      if (query.query === "" && result.total !== expectedTotals.get(query.name)) queryCorrect = false;
      if (query.query === "" && !sameFacetCounts(result.facets, expectedFacets.get(query.name)!)) queryCorrect = false;
    }
    if (queryCorrect) {
      passed += 1;
      if (query.query === "") facetCasesPassed += 1;
    }
  }

  return {
    engine: engine.name,
    indexingMs: roundMilliseconds(indexingMs),
    p50Ms: roundMilliseconds(percentile(samples, 0.5)),
    p95Ms: roundMilliseconds(percentile(samples, 0.95)),
    correctness: { passed, total: SEARCH_WORKLOAD.length, facetCasesPassed, facetCasesTotal: expectedFacets.size },
  };
}

export function sameFacetCounts(actual: FacetCounts, expected: FacetCounts): boolean {
  return FACET_FIELDS.every((field) => {
    const actualEntries = Object.entries(actual[field]).sort(([left], [right]) => left.localeCompare(right));
    const expectedEntries = Object.entries(expected[field]).sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
  });
}

export function recommend(results: readonly EngineResult[]): string {
  const correct = results.filter((result) => result.correctness.passed === result.correctness.total);
  if (correct.length !== results.length) return "No selection: at least one engine failed the required correctness workload.";
  const [first, second] = [...correct].sort((left, right) => left.p95Ms - right.p95Ms);
  if (!first || !second) return "No selection: both engine results are required.";
  const margin = (second.p95Ms - first.p95Ms) / Math.max(first.p95Ms, 0.01);
  if (margin < 0.1) return "No performance winner: p95 latency is within 10%; decide from operational fit in the follow-up implementation card.";
  return `${first.engine}: lowest warm-query p95 while passing the full correctness workload.`;
}

function markdown(documents: number, digest: string, iterations: number, results: readonly EngineResult[], recommendation: string): string {
  const rows = results.map((result) => `| ${result.engine} | ${result.indexingMs} | ${result.p50Ms} | ${result.p95Ms} | ${result.correctness.passed}/${result.correctness.total} | ${result.correctness.facetCasesPassed}/${result.correctness.facetCasesTotal} |`).join("\n");
  return `# SHU-47 search bake-off\n\nSynthetic documents: ${documents}  \nDataset SHA-256: \`${digest}\`  \nMeasured queries per workload: ${iterations}\n\n| Engine | Index ms | Warm p50 ms | Warm p95 ms | Correctness | Live facet counts |\n|---|---:|---:|---:|---:|---:|\n${rows}\n\n**Recommendation:** ${recommendation}\n\nFacet parity covers country, university, company, skill, gender, profile, assignment and document buckets after each filter combination. Results are directional for this CI runner and must not be treated as production capacity figures.\n`;
}

export function markdownOutputPath(jsonOutput: string): string {
  if (!jsonOutput.endsWith(".json")) throw new Error("benchmark output path must end in .json");
  return jsonOutput.slice(0, -5) + ".md";
}

async function main(): Promise<void> {
  const count = Number(valueAfter("--documents", "10000"));
  const iterations = Number(valueAfter("--iterations", "30"));
  const output = resolve(valueAfter("--output", "benchmark-results/search-bakeoff.json"));
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("iterations must be a positive integer");
  const meiliUrl = process.env.MEILI_URL ?? "http://127.0.0.1:7700";
  const typesenseUrl = process.env.TYPESENSE_URL ?? "http://127.0.0.1:8108";
  const typesenseKey = process.env.TYPESENSE_API_KEY ?? "shu47-local-key";
  await Promise.all([waitHealthy(`${meiliUrl}/health`), waitHealthy(`${typesenseUrl}/health`)]);

  const documents = generateSearchCandidates(count);
  const results = [];
  for (const engine of [new MeilisearchEngine(meiliUrl), new TypesenseEngine(typesenseUrl, typesenseKey)]) {
    results.push(await benchmark(engine, documents, iterations));
  }
  const recommendation = recommend(results);
  const report = { benchmark: "SHU-47", generatedAt: new Date().toISOString(), documents: count, datasetSha256: datasetDigest(documents), iterations, workload: SEARCH_WORKLOAD.map((query) => query.name), results, recommendation };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownOutputPath(output), markdown(count, report.datasetSha256, iterations, results, recommendation), "utf8");
  process.stdout.write(`${markdown(count, report.datasetSha256, iterations, results, recommendation)}\n`);
  if (results.some((result) => result.correctness.passed !== result.correctness.total)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
