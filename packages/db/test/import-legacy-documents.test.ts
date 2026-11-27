import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { postgresCopyCheckpoints, postgresDocumentStaging } from "../../../tools/legacy-import/src/m2-staging.js";
import { CHECKPOINT_VERSION, stagingKey, type CopyCheckpoint, type StagedDocument } from "../../../tools/legacy-import/src/m2-copy.js";
import { fixtureIds } from "./legacy-fixture-ids.js";

// Synthetic rows only: fresh fixture ids and generations, so runs can share a database.

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
});
after(async () => { await pool.end(); });

const v4 = () => { const u = randomUUID(); return u; };
const row = (id: string, generation: string, over: Partial<StagedDocument> = {}): StagedDocument => {
  const base = { legacyId: id, kind: "personal-photo" as const, mime: "image/png" as const, size: 10, sha256: "a".repeat(64), generation, ...over };
  return { ...base, objectKey: over.objectKey ?? stagingKey(generation, base.legacyId, base.kind, base.sha256) };
};
const INV = { doccheck: randomUUID(), copy: randomUUID() };
const SIG = new AbortController().signal;

test("a staged document is recorded once per candidate, kind and generation, and never replaced", async () => {
  const store = postgresDocumentStaging(pool);
  const id = String(await fixtureIds(pool)), gen = v4(), other = v4();
  assert.equal(await store.get(id, "personal-photo", gen, SIG), null);
  assert.equal(await store.insert(row(id, gen), INV, SIG), "inserted");
  assert.equal(await store.insert(row(id, gen, { sha256: "b".repeat(64) }), INV, SIG), "exists", "a second row for the slot is refused, not merged");
  assert.deepEqual(await store.get(id, "personal-photo", gen, SIG), row(id, gen));
  // Another generation has its own row.
  assert.equal(await store.insert(row(id, other), INV, SIG), "inserted");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM legacy_candidate_documents WHERE legacy_candidate_id = $1", [id])).rows[0].n, 2);
});

test("the table refuses a row whose key does not derive from it, or whose type does not fit its kind", async () => {
  const store = postgresDocumentStaging(pool);
  const id = String(await fixtureIds(pool)), gen = v4();
  const bad = [
    row(id, gen, { objectKey: `legacy-import/${gen}/${id}/personal-photo/${"c".repeat(64)}` }),
    row(id, gen, { kind: "resume" }), // a CV that is not a PDF
    row(id, gen, { kind: "personal-photo", mime: "application/pdf" }),
    row(id, gen, { size: 0 }),
    row(id, gen, { size: 10 * 1024 * 1024 + 1 }),
    row(id, gen, { legacyId: "0", objectKey: `legacy-import/${gen}/0/personal-photo/${"a".repeat(64)}` }),
  ];
  for (const r of bad) await assert.rejects(store.insert(r, INV, SIG), (e: unknown) => e instanceof Error, JSON.stringify(r));
});

test("the staging marker can record a document bucket, checked for shape", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM legacy_import_target");
    await client.query("INSERT INTO legacy_import_target (environment, document_bucket) VALUES ('staging', 'sh-staging-legacy-docs')");
    assert.equal((await client.query("SELECT document_bucket FROM legacy_import_target")).rows[0].document_bucket, "sh-staging-legacy-docs");
    await assert.rejects(client.query("UPDATE legacy_import_target SET document_bucket = 'Bad_Bucket'"));
  } finally { await client.query("ROLLBACK"); client.release(); }
});

test("the copy checkpoint is loaded by its exact key and replaced only at the revision it was loaded at", async () => {
  const store = postgresCopyCheckpoints(pool);
  const key = { acceptedDoccheck: randomUUID(), targetId: randomUUID(), bucket: "sh-staging-legacy-docs", generation: v4(), build: "b".repeat(64), order: "c".repeat(64) };
  const cp = (n: number): CopyCheckpoint => ({ version: CHECKPOINT_VERSION, key, entries: Array.from({ length: n }, (_, i) =>
    ({ index: i, legacyId: String(i + 1), kind: "personal-photo" as const, rule: "document.missing" as const, invocation: INV.copy })) });
  assert.equal(await store.load(key, SIG), null);
  assert.equal(await store.save(cp(1), null, SIG), "saved");
  assert.equal(await store.save(cp(1), null, SIG), "stale", "a second first save loses");
  assert.deepEqual(await store.load(key, SIG), { revision: 1, checkpoint: cp(1) });
  assert.equal(await store.save(cp(2), 1, SIG), "saved");
  assert.equal(await store.save(cp(3), 1, SIG), "stale", "a save at an old revision never overwrites");
  assert.deepEqual(await store.load(key, SIG), { revision: 2, checkpoint: cp(2) });
  // Any other key field is another checkpoint.
  for (const other of [{ targetId: randomUUID() }, { bucket: "sh-other-bucket" }, { build: "d".repeat(64) }, { order: "e".repeat(64) }, { generation: v4() }])
    assert.equal(await store.load({ ...key, ...other }, SIG), null);
  await assert.rejects(store.save({ ...cp(1), key: { ...key, bucket: "Not A Bucket" } }, null, SIG));
});
