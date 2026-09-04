import assert from "node:assert/strict";
import test from "node:test";

import { CANDIDATE_SEARCH_FACETS, type CandidateSearchDocument } from "@studenthub/contracts";

import { CandidateSearchUnavailableError, TypesenseCandidateSearchAdapter } from "../src/index.js";

const DOCUMENT: CandidateSearchDocument = {
  id: "candidate-1",
  name: "Synthetic Candidate",
  email: "candidate@search.invalid",
  phone: "synthetic-1",
  country: "KW",
  university: "Gulf Tech",
  company: "Atlas Retail",
  skills: ["typescript"],
  gender: "female",
  profile: "complete",
  assignment: "assigned",
  documents: ["resume"],
  status: "active",
  approved: true,
  score: 90,
  updatedAtEpoch: 1_788_499_200,
};

function successfulResponse(): Response {
  const facets = CANDIDATE_SEARCH_FACETS.map((facet) => ({
    found: 1,
    hits: [],
    facet_counts: [{
      field_name: facet === "skill" ? "skills" : facet === "document" ? "documents" : facet,
      counts: [{ value: facet === "country" ? "KW" : `${facet}-value`, count: 1 }],
    }],
  }));
  return Response.json({ results: [{ found: 1, hits: [{ document: DOCUMENT }] }, ...facets] });
}

test("builds one result query plus disjunctive live-facet queries", async () => {
  let payload: { searches: Array<Record<string, unknown>> } | undefined;
  const adapter = new TypesenseCandidateSearchAdapter({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as { searches: Array<Record<string, unknown>> };
      return successfulResponse();
    },
  });

  const result = await adapter.search({
    scope: { kind: "candidate-ids", ids: ["candidate-1", "candidate-2"] },
    query: "synthetic",
    filters: { country: ["KW", "AE"], skill: ["typescript"], assignment: ["assigned"] },
    constraints: { status: ["active"], approved: true },
    page: 2,
    pageSize: 20,
    sort: "updated-descending",
  });

  assert.equal(payload?.searches.length, 9);
  assert.equal(payload?.searches[0]?.page, 2);
  assert.equal(payload?.searches[0]?.per_page, 20);
  assert.equal(payload?.searches[0]?.sort_by, "updatedAtEpoch:desc");
  assert.match(String(payload?.searches[0]?.filter_by), /country:=\[`KW`,`AE`\]/);
  assert.match(String(payload?.searches[0]?.filter_by), /skills:=\[`typescript`\]/);
  assert.match(String(payload?.searches[0]?.filter_by), /id:=\[`candidate-1`,`candidate-2`\]/);
  assert.match(String(payload?.searches[0]?.filter_by), /status:=\[`active`\]/);
  assert.match(String(payload?.searches[0]?.filter_by), /approved:=true/);

  const countryFacetQuery = payload?.searches[1];
  assert.equal(countryFacetQuery?.facet_by, "country");
  assert.doesNotMatch(String(countryFacetQuery?.filter_by), /country:=/);
  assert.match(String(countryFacetQuery?.filter_by), /skills:=\[`typescript`\]/);
  assert.deepEqual(result.hits, [DOCUMENT]);
  assert.equal(result.total, 1);
  assert.deepEqual(result.facets.country, [
    { value: "KW", count: 1, active: true },
    { value: "AE", count: 0, active: true },
  ]);
});

test("an explicitly empty visibility scope fails closed without a request", async () => {
  let calls = 0;
  const adapter = new TypesenseCandidateSearchAdapter({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    fetch: async () => { calls += 1; return successfulResponse(); },
  });
  const result = await adapter.search({
    scope: { kind: "candidate-ids", ids: [] },
    filters: { country: ["KW"] },
  });
  assert.equal(calls, 0);
  assert.equal(result.total, 0);
  assert.deepEqual(result.facets.country, [{ value: "KW", count: 0, active: true }]);
});

test("returns empty facet options when Typesense omits a zero-result facet", async () => {
  const adapter = new TypesenseCandidateSearchAdapter({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    fetch: async () => {
      const payload = await successfulResponse().json() as { results: Array<Record<string, unknown>> };
      payload.results[1] = { found: 0, hits: [], facet_counts: [] };
      return Response.json(payload);
    },
  });

  const result = await adapter.search({
    scope: { kind: "all" },
    filters: { country: ["KW"] },
  });

  assert.deepEqual(result.facets.country, [{ value: "KW", count: 0, active: true }]);
});

test("rejects unsafe configuration and unbounded requests", async () => {
  assert.throws(
    () => new TypesenseCandidateSearchAdapter({ url: "http://search.example.invalid", apiKey: "key" }),
    /must use HTTPS/,
  );
  assert.doesNotThrow(
    () => new TypesenseCandidateSearchAdapter({ url: "http://127.0.0.1:8108", apiKey: "key" }),
  );
  const adapter = new TypesenseCandidateSearchAdapter({ url: "https://search.example.invalid", apiKey: "key" });
  await assert.rejects(adapter.search({ scope: { kind: "all" }, pageSize: 251 }), /pageSize/);
  await assert.rejects(
    adapter.search({ scope: { kind: "missing" } as never }),
    /explicit authorization scope/,
  );
  await assert.rejects(
    adapter.search({ scope: { kind: "all" }, filters: { company: ["Atlas` || approved:=true"] } }),
    /unsupported syntax characters/,
  );
});

test("maps transport, status and malformed payload failures to unavailable", async () => {
  const transport = new TypesenseCandidateSearchAdapter({
    url: "https://search.example.invalid",
    apiKey: "key",
    fetch: async () => { throw new Error("secret transport detail"); },
  });
  await assert.rejects(transport.search({ scope: { kind: "all" } }), CandidateSearchUnavailableError);

  const status = new TypesenseCandidateSearchAdapter({
    url: "https://search.example.invalid",
    apiKey: "key",
    fetch: async () => new Response("sensitive body", { status: 503 }),
  });
  await assert.rejects(status.search({ scope: { kind: "all" } }), (error: unknown) => {
    assert.ok(error instanceof CandidateSearchUnavailableError);
    assert.doesNotMatch(error.message, /sensitive body/);
    return true;
  });

  const malformed = new TypesenseCandidateSearchAdapter({
    url: "https://search.example.invalid",
    apiKey: "key",
    fetch: async () => Response.json({ results: [] }),
  });
  await assert.rejects(malformed.search({ scope: { kind: "all" } }), /invalid multi-search response/);
});
