import { createHash } from "node:crypto";

import type { CandidateSearchDocument } from "@studenthub/contracts";

export const CANDIDATE_SEARCH_SCHEMA_VERSION = "v1";

export interface TypesenseCandidateIndexerConfig {
  readonly url: string;
  readonly apiKey: string;
  readonly alias?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface CandidateIndexPublication {
  readonly alias: string;
  readonly collection: string;
  readonly digest: string;
  readonly documents: number;
}

export class CandidateIndexPublishError extends Error {
  readonly name = "CandidateIndexPublishError";
}

const SEARCH_FIELDS = [
  { name: "id", type: "string" },
  { name: "name", type: "string" },
  { name: "email", type: "string" },
  { name: "phone", type: "string" },
  { name: "country", type: "string", facet: true },
  { name: "university", type: "string", facet: true },
  { name: "company", type: "string", facet: true, optional: true },
  { name: "skills", type: "string[]", facet: true },
  { name: "gender", type: "string", facet: true },
  { name: "profile", type: "string", facet: true },
  { name: "assignment", type: "string", facet: true },
  { name: "documents", type: "string[]", facet: true },
  { name: "status", type: "string", facet: true },
  { name: "approved", type: "bool", facet: true },
  { name: "score", type: "int32", sort: true },
  { name: "updatedAtEpoch", type: "int64", sort: true },
] as const;

export class TypesenseCandidateIndexer {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #alias: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: TypesenseCandidateIndexerConfig) {
    const endpoint = new URL(config.url);
    const loopback = endpoint.hostname === "localhost"
      || endpoint.hostname === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
      throw new TypeError("Typesense endpoint must use HTTPS unless it is loopback");
    }
    if (!config.apiKey.trim()) throw new TypeError("Typesense API key is required");
    const alias = config.alias ?? "studenthub_candidates";
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(alias)) throw new TypeError("invalid Typesense alias");
    const timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new TypeError("Typesense timeout must be between 100 and 60000 milliseconds");
    }
    this.#baseUrl = endpoint.toString().replace(/\/$/, "");
    this.#apiKey = config.apiKey;
    this.#alias = alias;
    this.#timeoutMs = timeoutMs;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async publish(documents: readonly CandidateSearchDocument[]): Promise<CandidateIndexPublication> {
    const canonical = canonicalDocuments(documents);
    if (canonical.length === 0) throw new TypeError("candidate index requires at least one document");
    const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    const collection = `${this.#alias}_${CANDIDATE_SEARCH_SCHEMA_VERSION}_${digest.slice(0, 16)}`;
    const created = await this.#ensureCollection(collection);

    try {
      await this.#import(collection, canonical);
      await this.#verifyCount(collection, canonical.length);
      await this.#json(`/aliases/${encodeURIComponent(this.#alias)}`, {
        method: "PUT",
        body: JSON.stringify({ collection_name: collection }),
      });
    } catch (error) {
      if (created) await this.#bestEffortDelete(collection);
      throw error;
    }

    return { alias: this.#alias, collection, digest, documents: canonical.length };
  }

  async #ensureCollection(collection: string): Promise<boolean> {
    const existing = await this.#request(`/collections/${encodeURIComponent(collection)}`, { method: "GET" });
    if (existing.status === 200) return false;
    if (existing.status !== 404) throw unavailable(existing.status);

    const created = await this.#json("/collections", {
      method: "POST",
      body: JSON.stringify({ name: collection, fields: SEARCH_FIELDS }),
    });
    if (!created.ok && created.status !== 409) throw unavailable(created.status);
    return created.status !== 409;
  }

  async #import(collection: string, documents: readonly CandidateSearchDocument[]): Promise<void> {
    const response = await this.#request(
      `/collections/${encodeURIComponent(collection)}/documents/import?action=upsert`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: documents.map((document) => JSON.stringify(document)).join("\n"),
      },
    );
    if (!response.ok) throw unavailable(response.status);
    const lines = (await response.text()).split("\n").filter(Boolean);
    if (lines.length !== documents.length) throw new CandidateIndexPublishError("Typesense returned an incomplete import receipt");
    for (const line of lines) {
      let receipt: unknown;
      try {
        receipt = JSON.parse(line);
      } catch {
        throw new CandidateIndexPublishError("Typesense returned an invalid import receipt");
      }
      if (!isRecord(receipt) || receipt.success !== true) {
        throw new CandidateIndexPublishError("Typesense rejected one or more candidate documents");
      }
    }
  }

  async #verifyCount(collection: string, expected: number): Promise<void> {
    const response = await this.#json(`/collections/${encodeURIComponent(collection)}`, { method: "GET" });
    if (!response.ok) throw unavailable(response.status);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new CandidateIndexPublishError("Typesense returned invalid collection metadata");
    }
    if (!isRecord(value) || value.num_documents !== expected) {
      throw new CandidateIndexPublishError("Typesense candidate index count does not match the publication");
    }
  }

  async #bestEffortDelete(collection: string): Promise<void> {
    try {
      await this.#request(`/collections/${encodeURIComponent(collection)}`, { method: "DELETE" });
    } catch {
      // Publication still fails closed because the alias was not switched.
    }
  }

  async #json(path: string, init: RequestInit): Promise<Response> {
    return this.#request(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, "X-TYPESENSE-API-KEY": this.#apiKey },
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new CandidateIndexPublishError("Typesense indexing request failed", { cause: error });
    }
  }
}

function canonicalDocuments(documents: readonly CandidateSearchDocument[]): CandidateSearchDocument[] {
  const ids = new Set<string>();
  const result = documents.map((document) => {
    if (!document || typeof document.id !== "string" || document.id.trim() === "") {
      throw new TypeError("candidate index documents require a non-empty id");
    }
    if (ids.has(document.id)) throw new TypeError(`duplicate candidate index id '${document.id}'`);
    ids.add(document.id);
    return structuredClone(document);
  });
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function unavailable(status: number): CandidateIndexPublishError {
  return new CandidateIndexPublishError(`Typesense indexing request failed with status ${status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
