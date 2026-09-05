import assert from "node:assert/strict";
import test from "node:test";

import type { CandidateSearchDocument } from "@studenthub/contracts";

import { TypesenseCandidateIndexer, TypesenseCandidateSearchAdapter } from "../src/index.js";

const url = process.env.TYPESENSE_URL ?? "http://127.0.0.1:8108";
const apiKey = process.env.TYPESENSE_API_KEY ?? "shu52-ci-key";
const collection = "shu57_candidate_parity";

const documents: CandidateSearchDocument[] = [
  candidate("1", "KW", "Gulf Tech", "Atlas Retail", ["typescript"], "female", "complete", "assigned", ["resume"], 90),
  candidate("2", "KW", "Orbit University", undefined, ["design"], "male", "incomplete", "unassigned", ["no-resume"], 70),
  candidate("3", "AE", "Gulf Tech", "Beacon Hospitality", ["typescript", "operations"], "female", "complete", "assigned", ["resume", "civil-id"], 80),
  candidate("4", "SA", "Coast College", "Atlas Retail", ["finance"], "other", "complete", "assigned", ["no-resume"], 60),
];

test.before(async () => {
  await waitForTypesense();
  const headers = { "X-TYPESENSE-API-KEY": apiKey, "content-type": "application/json" };
  await fetch(`${url}/aliases/${collection}`, { method: "DELETE", headers });

  const indexer = new TypesenseCandidateIndexer({ url, apiKey, alias: collection });
  const first = await indexer.publish(documents);
  const repeated = await indexer.publish([...documents].reverse());

  assert.equal(first.collection, repeated.collection);
  assert.equal(first.documents, documents.length);
  assert.equal(repeated.documents, documents.length);
});

test("real Typesense preserves combined filters, multi-select and live alternative counts", async () => {
  const adapter = new TypesenseCandidateSearchAdapter({ url, apiKey, collection });
  const result = await adapter.search({
    scope: { kind: "candidate-ids", ids: ["1", "2", "3"] },
    filters: { country: ["KW", "AE"], skill: ["typescript"], profile: ["complete"] },
    constraints: { status: ["active"], approved: true },
    sort: "score-descending",
  });
  assert.deepEqual(result.hits.map((hit) => hit.id), ["1", "3"]);
  assert.equal(result.total, 2);
  assert.deepEqual(pickCounts(result.facets.country), { AE: 1, KW: 1 });
  assert.deepEqual(pickCounts(result.facets.university), { "Gulf Tech": 2 });
  assert.deepEqual(pickCounts(result.facets.assignment), { assigned: 2 });
  assert.deepEqual(pickCounts(result.facets.skill), { operations: 1, typescript: 2 });
});

test("empty results retain active filters and authorization scope cannot widen", async () => {
  const adapter = new TypesenseCandidateSearchAdapter({ url, apiKey, collection });
  const result = await adapter.search({
    scope: { kind: "candidate-ids", ids: ["1", "2", "3"] },
    filters: { country: ["SA"] },
  });
  assert.equal(result.total, 0);
  assert.deepEqual(result.facets.country.find((option) => option.value === "SA"), {
    value: "SA", count: 0, active: true,
  });
});

function candidate(
  id: string,
  country: string,
  university: string,
  company: string | undefined,
  skills: string[],
  gender: CandidateSearchDocument["gender"],
  profile: CandidateSearchDocument["profile"],
  assignment: CandidateSearchDocument["assignment"],
  candidateDocuments: CandidateSearchDocument["documents"],
  score: number,
): CandidateSearchDocument {
  return {
    id, name: `Synthetic Candidate ${id}`, email: `candidate-${id}@search.invalid`, phone: `synthetic-${id}`,
    country, university, ...(company ? { company } : {}), skills, gender, profile, assignment,
    documents: candidateDocuments, status: "active", approved: true, score, updatedAtEpoch: 1_788_499_200 + Number(id),
  };
}

function pickCounts(options: readonly { readonly value: string; readonly count: number }[]): Record<string, number> {
  return Object.fromEntries(options.map((option) => [option.value, option.count]));
}

async function waitForTypesense(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // The service container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Typesense did not become healthy within 30 seconds");
}
