import assert from "node:assert/strict";
import test from "node:test";

import type { CandidateSearchDocument } from "@studenthub/contracts";

import { CandidateIndexPublishError, TypesenseCandidateIndexer } from "../src/index.js";

const DOCUMENTS = [candidate("2"), candidate("1")];

test("publishes a content-addressed collection before atomically switching the alias", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const indexer = new TypesenseCandidateIndexer({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    alias: "candidates",
    fetch: async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (init.method === "GET" && url.includes("/collections/candidates_v1_")) {
        const seenImport = requests.some((request) => request.url.includes("/documents/import"));
        return seenImport ? Response.json({ num_documents: 2 }) : new Response(null, { status: 404 });
      }
      if (url.endsWith("/collections") && init.method === "POST") return Response.json({}, { status: 201 });
      if (url.includes("/documents/import")) {
        assert.equal(String(init.body).split("\n")[0], JSON.stringify(candidate("1")));
        return new Response('{"success":true}\n{"success":true}');
      }
      if (url.endsWith("/aliases/candidates") && init.method === "PUT") return Response.json({});
      throw new Error(`unexpected request ${init.method} ${url}`);
    },
  });

  const publication = await indexer.publish(DOCUMENTS);
  assert.match(publication.collection, /^candidates_v1_[a-f0-9]{16}$/);
  assert.equal(publication.documents, 2);
  assert.equal(requests.at(-1)?.url, "https://search.example.invalid/aliases/candidates");
  assert.ok(requests.every((request) => request.init.redirect === "error"));
});

test("never switches the alias after a partial import failure", async () => {
  const requests: string[] = [];
  const indexer = new TypesenseCandidateIndexer({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    fetch: async (input, init = {}) => {
      const url = String(input);
      requests.push(url);
      if (init.method === "GET") return new Response(null, { status: 404 });
      if (url.endsWith("/collections")) return Response.json({}, { status: 201 });
      if (url.includes("/documents/import")) {
        return new Response('{"success":true}\n{"success":false,"error":"invalid"}');
      }
      if (init.method === "DELETE") return Response.json({});
      throw new Error(`unexpected request ${init.method} ${url}`);
    },
  });

  await assert.rejects(indexer.publish(DOCUMENTS), CandidateIndexPublishError);
  assert.equal(requests.some((url) => url.includes("/aliases/")), false);
  assert.equal(requests.some((url) => url.includes("/collections/") && !url.includes("/documents/")), true);
});

test("rejects duplicate ids and unsafe endpoints before sending credentials", async () => {
  assert.throws(
    () => new TypesenseCandidateIndexer({ url: "http://search.example.invalid", apiKey: "key" }),
    /must use HTTPS/,
  );
  const indexer = new TypesenseCandidateIndexer({ url: "https://search.example.invalid", apiKey: "key" });
  await assert.rejects(indexer.publish([candidate("1"), candidate("1")]), /duplicate candidate index id/);
});

function candidate(id: string): CandidateSearchDocument {
  return {
    id,
    name: `Synthetic Candidate ${id}`,
    email: `candidate-${id}@index.invalid`,
    phone: `synthetic-${id}`,
    country: "KW",
    university: "Gulf Tech",
    company: "Atlas Retail",
    skills: ["typescript"],
    gender: "not-set",
    profile: "complete",
    assignment: "assigned",
    documents: ["resume"],
    status: "active",
    approved: true,
    score: 80,
    updatedAtEpoch: 1_788_499_200 + Number(id),
  };
}
