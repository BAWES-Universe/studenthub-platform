import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresLegacyLinkStore, runMigrations } from "@studenthub/db";
import { PostgresImportedPersonSnapshots, PostgresPersonSnapshotImportStore } from "@studenthub/db/import";
import { OwnProfileRepository, PROFILE_PARITY_REVISION } from "../../profile/src/index.js";
import { mapLegacyCandidates } from "../../../tools/legacy-import/src/m1-people.js";
import { fixtureIds } from "./legacy-fixture-ids.js";

// Synthetic candidate rows only; fresh legacy ids per run so the suite can share a database.

const URL = process.env.DATABASE_URL ?? "";
const TODAY = "2026-11-24";
let pool: pg.Pool, store: PostgresPersonSnapshotImportStore, snapshots: PostgresImportedPersonSnapshots, authz: PostgresAuthzStore;
const links: PostgresLegacyLinkStore[] = [];
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  store = new PostgresPersonSnapshotImportStore(pool, PROFILE_PARITY_REVISION);
  snapshots = new PostgresImportedPersonSnapshots(pool);
  authz = new PostgresAuthzStore(pool);
});
after(async () => { await Promise.all(links.map((l) => l.close())); await pool.end(); });

const candidate = (id: number, extra: Record<string, unknown> = {}) => ({
  candidate_id: id, deleted: 0, candidate_name: "Test Person", candidate_name_ar: null, candidate_gender: 1,
  candidate_birth_date: "2000-01-02", country_id: null, university_id: null, candidate_area_uuid: null,
  candidate_objective: "Retail work", candidate_intro: null, candidate_preferred_time: null, candidate_language_pref: "en",
  candidate_driving_license: 2, candidate_job_search_status: 1, candidate_committed: 0, is_incomplete_profile: 1,
  candidate_pending_profile: "skill", candidate_civil_expiry_date: null, ...extra,
});
const people = (rows: readonly Record<string, unknown>[]) =>
  mapLegacyCandidates({ candidate: rows, country: [], university: [], area: [] }, TODAY).people;

test("snapshots import once; a re-run is unchanged and a changed row is a conflict, never an overwrite", async () => {
  const a = await fixtureIds(pool), b = a + 1;
  const first = people([candidate(a), candidate(b)]);
  assert.deepEqual(await store.importPeople(first), { inserted: 2, unchanged: 0, conflicts: [], refused: [] });
  assert.deepEqual(await store.importPeople(first), { inserted: 0, unchanged: 2, conflicts: [], refused: [] });
  const changed = people([candidate(a, { candidate_objective: "Other work" })]);
  assert.deepEqual(await store.importPeople(changed), {
    inserted: 0, unchanged: 0, refused: [],
    conflicts: [{ legacyId: String(a), existingDigest: first[0]!.digest, incomingDigest: changed[0]!.digest }],
  });
  const read = await snapshots.readCandidate(String(a)) as Record<string, unknown>;
  assert.equal(read.candidate_objective, "Retail work");
  assert.deepEqual(await store.reconcile([String(a), String(b), String(b + 1), String(b + 2)], [String(b + 2)]), {
    legacyTable: "candidate", legacy: 4, imported: 2, skipped: [String(b + 2)], missing: [String(b + 1)],
    extra: (await store.reconcile([])).extra.filter((id) => id !== String(a) && id !== String(b)),
  });
});

test("a row whose snapshot names another candidate is refused, and the batch goes on", async () => {
  const a = await fixtureIds(pool), b = a + 1;
  const [good, other] = people([candidate(a), candidate(b)]);
  const forged = { ...other!, snapshot: { ...other!.snapshot, candidate_id: String(a) } };
  assert.deepEqual(await store.importPeople([forged, good!]), { inserted: 1, unchanged: 0, conflicts: [], refused: [{ legacyId: String(b), code: "invalid" }] });
  assert.equal(await snapshots.readCandidate(String(b)), undefined);
});

test("rows off the contract are refused before any lookup, new or replayed, redacted, and the batch goes on", async () => {
  const a = await fixtureIds(pool), b = a + 1, c = a + 2;
  const [held] = people([candidate(a)]);
  await store.importPeople([held!]);
  const [later] = people([candidate(c)]);
  const secret = "Zz Secretvalue";
  const replayedTampered = { ...held!, snapshot: { ...held!.snapshot, candidate_objective: secret } }; // same id and digest
  const extraKey = { ...held!, snapshot: { ...held!.snapshot, candidate_email: secret } };
  const [fresh] = people([candidate(b)]);
  const wrongDigest = { ...fresh!, digest: "0".repeat(64) };
  const paddedId = { ...fresh!, legacyId: `0${b}` };
  const nested = { ...fresh!, snapshot: { ...fresh!.snapshot, candidate_intro: { secret } } };
  const result = await store.importPeople([replayedTampered, extraKey, wrongDigest, paddedId, nested, later!] as never);
  assert.deepEqual(result, {
    inserted: 1, unchanged: 0, conflicts: [],
    refused: [
      { legacyId: String(a), code: "invalid" }, { legacyId: String(a), code: "invalid" }, { legacyId: String(b), code: "invalid" },
      { legacyId: "?", code: "invalid" }, { legacyId: String(b), code: "invalid" },
    ],
  });
  assert.ok(!JSON.stringify(result).includes("Secretvalue"));
  assert.equal(await snapshots.readCandidate(String(b)), undefined);
  assert.equal((await snapshots.readCandidate(String(a)) as Record<string, unknown>).candidate_objective, "Retail work");
  assert.equal((await snapshots.readCandidate(String(c)) as Record<string, unknown>).candidate_id, String(c));
});

test("a linked person's My profile shows the imported values; an unimported candidate reads as not imported", async () => {
  const a = await fixtureIds(pool);
  await store.importPeople(people([candidate(a)]));
  const principalId = `m1-${randomUUID()}`, other = `m1-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id: principalId, pbuuids: [], email: "m1-person@example.invalid" }));
  await authz.registerPrincipal(createPrincipal({ id: other, pbuuids: [], email: "m1-other@example.invalid" }));
  const link = new PostgresLegacyLinkStore(pool, snapshots);
  links.push(link);
  await link.link({ principalId, legacyCandidateId: String(a), actor: principalId, method: "staff" });
  await link.link({ principalId: other, legacyCandidateId: String(a + 1), actor: other, method: "staff" });
  const repository = new OwnProfileRepository({ principals: authz, source: link, today: () => TODAY });

  const found = await repository.readOwn({ requesterPrincipalId: principalId, targetPersonId: principalId });
  assert.equal(found.kind, "found");
  const fields = (found as { profile: { fields: Record<string, { state: string; value?: unknown; freshness: { kind: string } }> } }).profile.fields;
  assert.equal(fields.displayName!.value, "Test Person");
  assert.equal(fields.displayName!.freshness.kind, "imported_snapshot");
  assert.equal(fields.gender!.value, "male");
  assert.equal(fields.employeeIdentifier!.value, `C${a}`);

  const pending = await repository.readOwn({ requesterPrincipalId: other, targetPersonId: other });
  assert.equal(pending.kind, "found");
  const otherFields = (pending as { profile: { fields: Record<string, { state: string; reason?: string }> } }).profile.fields;
  assert.equal(otherFields.displayName!.state, "unavailable");
  assert.equal(otherFields.displayName!.reason, "not_imported");
});

test("the snapshot table refuses a malformed id or revision", async () => {
  await assert.rejects(pool.query("INSERT INTO legacy_candidate_snapshots (legacy_candidate_id, snapshot, source_revision) VALUES ('0', '{}', $1)", [PROFILE_PARITY_REVISION]), { code: "23514" });
  await assert.rejects(pool.query("INSERT INTO legacy_candidate_snapshots (legacy_candidate_id, snapshot, source_revision) VALUES ('5', '{}', 'nope')"), { code: "23514" });
  await assert.rejects(pool.query("INSERT INTO legacy_candidate_snapshots (legacy_candidate_id, snapshot, source_revision) VALUES ('5', '[]', $1)", [PROFILE_PARITY_REVISION]), { code: "23514" });
  await assert.rejects(pool.query(`INSERT INTO legacy_candidate_snapshots (legacy_candidate_id, snapshot, source_revision) VALUES ('5', '{"candidate_id":"6"}', $1)`, [PROFILE_PARITY_REVISION]), { code: "23514" });
  await assert.rejects(pool.query("INSERT INTO legacy_candidate_snapshots (legacy_candidate_id, snapshot, source_revision) VALUES ('5', '{}', $1)", [PROFILE_PARITY_REVISION]));
  assert.equal(await snapshots.readCandidate("not-digits"), undefined);
});
