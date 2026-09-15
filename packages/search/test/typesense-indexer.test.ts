import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { CandidateSearchDocument } from "@studenthub/contracts";

import { CandidateIndexPublishError, TypesenseCandidateIndexer } from "../src/index.js";

const DOCUMENTS = [candidate("2"), candidate("1")];

test("publishes a content-addressed collection before atomically switching the alias", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let createdFields: unknown;
  const indexer = new TypesenseCandidateIndexer({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    alias: "candidates",
    fetch: async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/aliases/candidates") && (init.method ?? "GET") === "GET") {
        return new Response(null, { status: 404 });
      }
      if (init.method === "GET" && url.includes("/collections/candidates_v1_")) {
        const seenImport = requests.some((request) => request.url.includes("/documents/import"));
        return seenImport ? Response.json({ num_documents: 2 }) : new Response(null, { status: 404 });
      }
      if (url.endsWith("/collections") && init.method === "POST") {
        const body = JSON.parse(String(init.body)) as { fields: unknown };
        createdFields = body.fields;
        return Response.json({}, { status: 201 });
      }
      if (url.includes("/documents/import")) {
        assert.equal(String(init.body).split("\n")[0], JSON.stringify(candidate("1")));
        return new Response('{"success":true}\n{"success":true}');
      }
      if (url.endsWith("/aliases/candidates") && init.method === "PUT") return Response.json({});
      throw new Error(`unexpected request ${init.method} ${url}`);
    },
  });

  const publication = await indexer.publish(DOCUMENTS);
  const expectedDigest = createHash("sha256")
    .update(JSON.stringify({ fields: createdFields, documents: [candidate("1"), candidate("2")] }))
    .digest("hex");
  assert.equal(publication.digest, expectedDigest, "the collection digest must include the emitted schema");
  assert.match(publication.collection, /^candidates_v1_[a-f0-9]{16}$/);
  assert.equal(publication.collection, `candidates_v1_${expectedDigest.slice(0, 16)}`);
  assert.equal(publication.documents, 2);
  assert.equal(publication.previousCollection, null);
  assert.equal(requests.at(-1)?.url, "https://search.example.invalid/aliases/candidates");
  assert.ok(requests.every((request) => request.init.redirect === "error"));
  assert.deepEqual(
    (createdFields as Array<{ name: string }>).find((field) => field.name === "score"),
    { name: "score", type: "float", sort: true },
  );
});

test("canonicalizes document key order while preserving fractional scores", async () => {
  const original = { ...candidate("1"), score: 80.5 };
  const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as CandidateSearchDocument;
  const imports: string[] = [];
  const indexer = new TypesenseCandidateIndexer({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    alias: "candidates",
    fetch: async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/aliases/candidates") && method === "GET") {
        return Response.json({ collection_name: "candidates_v1_1111111111111111" });
      }
      if (method === "GET") return Response.json({ num_documents: 1 });
      if (url.includes("/documents/import")) {
        imports.push(String(init.body));
        return new Response('{"success":true}');
      }
      if (url.endsWith("/aliases/candidates") && method === "PUT") return Response.json({});
      throw new Error(`unexpected request ${method} ${url}`);
    },
  });

  const first = await indexer.publish([original]);
  const repeated = await indexer.publish([reordered]);

  assert.equal(first.collection, repeated.collection);
  assert.equal(first.digest, repeated.digest);
  assert.equal(imports[0], imports[1]);
  assert.equal((JSON.parse(imports[0] ?? "{}") as { score?: number }).score, 80.5);
});

test("rollback restores the prior alias only while the publication is still current", async () => {
  let alias = "candidates_v1_1111111111111111";
  let candidateCollectionGets = 0;
  const switches: Array<string | null> = [];
  const indexer = new TypesenseCandidateIndexer({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    alias: "candidates",
    fetch: async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/aliases/candidates") && method === "GET") {
        return Response.json({ collection_name: alias });
      }
      if (url.includes("/collections/candidates_v1_") && method === "GET") {
        candidateCollectionGets += 1;
        return candidateCollectionGets === 1
          ? new Response(null, { status: 404 })
          : Response.json({ num_documents: 2 });
      }
      if (url.endsWith("/collections") && method === "POST") return Response.json({}, { status: 201 });
      if (url.includes("/documents/import") && method === "POST") {
        return new Response('{"success":true}\n{"success":true}');
      }
      if (url.endsWith("/aliases/candidates") && method === "PUT") {
        alias = (JSON.parse(String(init.body)) as { collection_name: string }).collection_name;
        switches.push(alias);
        return Response.json({});
      }
      throw new Error(`unexpected request ${method} ${url}`);
    },
  });

  const publication = await indexer.publish(DOCUMENTS);
  assert.equal(publication.previousCollection, "candidates_v1_1111111111111111");
  assert.equal(alias, publication.collection);

  const rollback = await indexer.rollback(publication);
  assert.deepEqual(rollback, { alias: "candidates", restoredCollection: "candidates_v1_1111111111111111" });
  assert.equal(alias, "candidates_v1_1111111111111111");

  alias = "candidates_v1_2222222222222222";
  await assert.rejects(indexer.rollback(publication), /refusing stale rollback/);
  assert.equal(alias, "candidates_v1_2222222222222222");
  assert.deepEqual(switches, [publication.collection, "candidates_v1_1111111111111111"]);
});

test("rejects a failed import receipt even when count verification would pass", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  let collectionGets = 0;
  const indexer = new TypesenseCandidateIndexer({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    fetch: async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/aliases/studenthub_candidates") && method === "GET") {
        return new Response(null, { status: 404 });
      }
      if (method === "GET") {
        collectionGets += 1;
        return collectionGets === 1
          ? new Response(null, { status: 404 })
          : Response.json({ num_documents: DOCUMENTS.length });
      }
      if (url.endsWith("/collections")) return Response.json({}, { status: 201 });
      if (url.includes("/documents/import")) {
        return new Response('{"success":true}\n{"success":false,"error":"invalid"}');
      }
      if (method === "DELETE") return Response.json({});
      if (url.includes("/aliases/") && method === "PUT") return Response.json({});
      throw new Error(`unexpected request ${init.method} ${url}`);
    },
  });

  await assert.rejects(indexer.publish(DOCUMENTS), CandidateIndexPublishError);
  assert.equal(requests.some((request) => request.url.includes("/aliases/") && request.method === "PUT"), false);
  assert.equal(
    requests.some((request) => request.method === "DELETE" && request.url.includes("/collections/")),
    true,
    "a newly created collection must be deleted after publication fails",
  );
});

test("rejects a document-count mismatch before switching the alias", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  let collectionGets = 0;
  const indexer = new TypesenseCandidateIndexer({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    fetch: async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/aliases/studenthub_candidates") && method === "GET") {
        return new Response(null, { status: 404 });
      }
      if (method === "GET") {
        collectionGets += 1;
        return collectionGets === 1
          ? new Response(null, { status: 404 })
          : Response.json({ num_documents: DOCUMENTS.length - 1 });
      }
      if (url.endsWith("/collections") && method === "POST") return Response.json({}, { status: 201 });
      if (url.includes("/documents/import")) {
        return new Response('{"success":true}\n{"success":true}');
      }
      if (method === "DELETE") return Response.json({});
      if (url.includes("/aliases/") && method === "PUT") return Response.json({});
      throw new Error(`unexpected request ${method} ${url}`);
    },
  });

  await assert.rejects(indexer.publish(DOCUMENTS), /count does not match/);
  assert.equal(requests.some((request) => request.url.includes("/aliases/") && request.method === "PUT"), false);
});

test("does not delete a pre-existing collection after a later import failure", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const indexer = new TypesenseCandidateIndexer({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    fetch: async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/aliases/studenthub_candidates") && method === "GET") {
        return Response.json({ collection_name: "studenthub_candidates_v1_1111111111111111" });
      }
      if (method === "GET") return Response.json({ num_documents: DOCUMENTS.length });
      if (url.includes("/documents/import")) {
        return new Response('{"success":true}\n{"success":false,"error":"invalid"}');
      }
      if (method === "DELETE") return Response.json({});
      throw new Error(`unexpected request ${method} ${url}`);
    },
  });

  await assert.rejects(indexer.publish(DOCUMENTS), CandidateIndexPublishError);
  assert.equal(requests.some((request) => request.method === "DELETE"), false);
});

test("releases unused response bodies when publishing to a pre-existing collection", async () => {
  const responses: Response[] = [];
  let collectionGets = 0;
  const reply = (response: Response): Response => {
    responses.push(response);
    return response;
  };
  const indexer = new TypesenseCandidateIndexer({
    url: "https://search.example.invalid",
    apiKey: "test-key",
    fetch: async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/aliases/studenthub_candidates") && method === "GET") {
        return reply(Response.json({ collection_name: "studenthub_candidates_v1_1111111111111111" }));
      }
      if (method === "GET") {
        collectionGets += 1;
        return reply(Response.json({ num_documents: DOCUMENTS.length }));
      }
      if (url.includes("/documents/import")) {
        return reply(new Response('{"success":true}\n{"success":true}'));
      }
      if (url.includes("/aliases/") && method === "PUT") return reply(Response.json({}));
      throw new Error(`unexpected request ${method} ${url}`);
    },
  });

  await indexer.publish(DOCUMENTS);
  assert.equal(collectionGets, 2);
  assert.ok(responses.every((response) => response.bodyUsed), "every response body must be consumed or cancelled");
});

test("releases response bodies before propagating every HTTP-stage failure", async () => {
  for (const failingStage of ["ensure", "create", "import", "verify", "alias"] as const) {
    const responses: Response[] = [];
    let collectionGets = 0;
    const reply = (response: Response): Response => {
      responses.push(response);
      return response;
    };
    const indexer = new TypesenseCandidateIndexer({
      url: "https://search.example.invalid",
      apiKey: "test-key",
      fetch: async (input, init = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        if (url.endsWith("/aliases/studenthub_candidates") && method === "GET") {
          return reply(new Response("missing", { status: 404 }));
        }
        if (method === "GET") {
          collectionGets += 1;
          if (failingStage === "ensure" || (failingStage === "verify" && collectionGets === 2)) {
            return reply(new Response("unavailable", { status: 503 }));
          }
          return collectionGets === 1
            ? reply(new Response("missing", { status: 404 }))
            : reply(Response.json({ num_documents: DOCUMENTS.length }));
        }
        if (url.endsWith("/collections") && method === "POST") {
          return failingStage === "create"
            ? reply(new Response("unavailable", { status: 503 }))
            : reply(new Response("{}", { status: 201 }));
        }
        if (url.includes("/documents/import")) {
          return failingStage === "import"
            ? reply(new Response("unavailable", { status: 503 }))
            : reply(new Response('{"success":true}\n{"success":true}'));
        }
        if (url.includes("/aliases/") && method === "PUT") {
          return failingStage === "alias"
            ? reply(new Response("unavailable", { status: 503 }))
            : reply(Response.json({}));
        }
        if (method === "DELETE") return reply(Response.json({}));
        throw new Error(`unexpected request ${method} ${url}`);
      },
    });

    await assert.rejects(indexer.publish(DOCUMENTS), /status 503/, failingStage);
    assert.ok(
      responses.every((response) => response.bodyUsed),
      `${failingStage} left an HTTP response body open`,
    );
  }
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
