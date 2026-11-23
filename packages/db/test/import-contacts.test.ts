import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresContactImportStore, PostgresOrganizationImportStore } from "@studenthub/db/import";
import { ORGANIZATION_PARITY_REVISION } from "../../organizations/src/index.js";
import { mapLegacyCompanies } from "../../../tools/legacy-import/src/m4-organizations.js";
import { mapLegacyContacts } from "../../../tools/legacy-import/src/m4-contacts.js";
import { fixtureIds } from "./legacy-fixture-ids.js";

// Synthetic company and contact rows only; fresh legacy ids per run so the suite can share a database.

const URL = process.env.DATABASE_URL ?? "";
const ACTOR = createHash("sha256").update("legacy-import:test").digest("hex");
const NOW = "2026-11-20T12:00:00.000Z";
let pool: pg.Pool, contacts: PostgresContactImportStore, organizations: PostgresOrganizationImportStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  const operator = `import-operator-${randomUUID()}`;
  await pool.query("INSERT INTO organizations (id, name, parent_org_id) VALUES ($1, 'Operator', NULL)", [operator]);
  organizations = new PostgresOrganizationImportStore(pool, ORGANIZATION_PARITY_REVISION, operator);
  contacts = new PostgresContactImportStore(pool, ACTOR);
});
after(async () => pool.end());

const companyId = () => fixtureIds(pool);
const run = () => randomUUID().slice(0, 8);
const link = (id: string, person: string, company: number, extra: Record<string, unknown> = {}) => ({
  company_contact_uuid: id, contact_uuid: person, company_id: company, contact_position: "Accountant", allow_access: 0,
  created_at: "2023-05-01 21:30:00", updated_at: "2023-05-02 09:00:00", ...extra,
});
const person = (id: string, extra: Record<string, unknown> = {}) => ({ contact_uuid: id, contact_name: `Person ${id}`, contact_email: `${id}@example.com`, deleted: 0, ...extra });

async function importCompanies(...ids: number[]) {
  const result = await organizations.importOrganizations(mapLegacyCompanies(ids.map((id) => ({ company_id: id, parent_company_id: null, company_name: `Company ${id}` }))).organizations);
  // Every seed company must be new: a fixture id another suite already mapped would hide behind "unchanged".
  assert.deepEqual(result, { inserted: ids.length, unchanged: 0, conflicts: [], refused: [] });
  return organizations.idMap();
}
async function contactFor(legacyId: string) {
  const { rows: [map] } = await pool.query("SELECT platform_id FROM legacy_id_maps WHERE legacy_table = 'company_contact' AND legacy_id = $1", [legacyId]);
  if (!map) return undefined;
  const { rows: [c] } = await pool.query("SELECT org_id, name, role_title, created_by, created_at, updated_at, removed_at, removed_by FROM company_contacts WHERE id = $1", [map.platform_id]);
  const { rows: channels } = await pool.query("SELECT kind, position, value, label FROM company_contact_channels WHERE contact_id = $1 ORDER BY kind, position", [map.platform_id]);
  return { ...c, channels };
}

test("contacts import once with their channels and times; a re-run is unchanged", async () => {
  const c = await companyId(), r = run();
  const orgs = await importCompanies(c);
  const { contacts: mapped } = mapLegacyContacts([link(`${r}-1`, `${r}-p`, c), link(`${r}-2`, `${r}-q`, c, { updated_at: null })],
    [person(`${r}-p`), person(`${r}-q`, { deleted: 1 })], [],
    [{ phone_uuid: `${r}-f`, contact_uuid: `${r}-p`, phone_number: "+965 5000 0001", phone_created_datetime: null }]);
  assert.deepEqual(await contacts.importContacts(mapped, NOW), { inserted: 2, unchanged: 0, conflicts: [], refused: [] });
  assert.deepEqual(await contacts.importContacts(mapped, NOW), { inserted: 0, unchanged: 2, conflicts: [], refused: [] });
  const live = await contactFor(`${r}-1`);
  assert.equal(live.org_id, orgs.get(String(c)));
  assert.equal(live.name, `Person ${r}-p`);
  assert.equal(live.role_title, "Accountant");
  assert.equal(live.created_by, ACTOR);
  assert.equal(live.created_at.toISOString(), "2023-05-01T18:30:00.000Z");
  assert.equal(live.updated_at.toISOString(), "2023-05-02T06:00:00.000Z");
  assert.equal(live.removed_at, null);
  assert.deepEqual(live.channels, [
    { kind: "email", position: 0, value: `${r}-p@example.com`, label: null },
    { kind: "phone", position: 0, value: "+96550000001", label: null },
  ]);
  const removed = await contactFor(`${r}-2`);
  // No legacy update time: the creation time stands in, for the update and the removal.
  assert.equal(removed.updated_at.toISOString(), "2023-05-01T18:30:00.000Z");
  assert.equal(removed.removed_at.toISOString(), "2023-05-01T18:30:00.000Z");
  assert.equal(removed.removed_by, ACTOR);
});

test("a changed contact is a conflict and is never overwritten", async () => {
  const c = await companyId(), r = run();
  await importCompanies(c);
  const first = mapLegacyContacts([link(`${r}-1`, `${r}-p`, c)], [person(`${r}-p`)], [], []).contacts;
  await contacts.importContacts(first, NOW);
  const renamed = mapLegacyContacts([link(`${r}-1`, `${r}-p`, c)], [person(`${r}-p`, { contact_name: "Renamed" })], [], []).contacts;
  assert.deepEqual((await contacts.importContacts(renamed, NOW)).conflicts,
    [{ legacyId: `${r}-1`, existingDigest: first[0]!.digest, incomingDigest: renamed[0]!.digest }]);
  assert.equal((await contactFor(`${r}-1`)).name, `Person ${r}-p`);
});

test("a contact whose company is not imported is refused, and the batch goes on", async () => {
  const c = await companyId(), missing = await companyId(), r = run();
  await importCompanies(c);
  const result = await contacts.importContacts(mapLegacyContacts([link(`${r}-1`, `${r}-p`, missing), link(`${r}-2`, `${r}-p`, c)], [person(`${r}-p`)], [], []).contacts, NOW);
  assert.deepEqual([result.inserted, result.refused], [1, [{ legacyId: `${r}-1`, code: "no_organization" }]]);
  assert.equal(await contactFor(`${r}-1`), undefined);
});

test("reconciliation lists reported skips apart from unexplained gaps", async () => {
  const c = await companyId(), r = run();
  await importCompanies(c);
  await contacts.importContacts(mapLegacyContacts([link(`${r}-1`, `${r}-p`, c)], [person(`${r}-p`)], [], []).contacts, NOW);
  const report = await contacts.reconcile([`${r}-1`, `${r}-2`, `${r}-3`], [`${r}-2`]);
  assert.deepEqual([report.legacy, report.imported, report.skipped, report.missing], [3, 1, [`${r}-2`], [`${r}-3`]]);
});

test("two import runs at once are serialized: one inserts, the other finds the contacts unchanged", async () => {
  const c = await companyId(), r = run();
  await importCompanies(c);
  const mapped = mapLegacyContacts(Array.from({ length: 20 }, (_, i) => link(`${r}-${i}`, `${r}-p`, c)), [person(`${r}-p`)], [], []).contacts;
  const other = new PostgresContactImportStore({ connectionString: URL }, ACTOR);
  try {
    const [x, y] = await Promise.all([contacts.importContacts(mapped, NOW), other.importContacts(mapped, NOW)]);
    assert.deepEqual([x.inserted + y.inserted, x.unchanged + y.unchanged, x.refused, y.refused], [20, 20, [], []]);
  } finally {
    await other.close();
  }
});

test("a row the database refuses rolls back alone: its savepoint undoes it and the next row imports", async () => {
  const c = await companyId(), r = run();
  await importCompanies(c);
  const [good] = mapLegacyContacts([link(`${r}-2`, `${r}-p`, c)], [person(`${r}-p`)], [], []).contacts;
  // Six phones pass no mapper, but a hand-built row can carry them: position 5 breaks the channel check.
  const bad = { ...good!, legacyId: `${r}-1`, phones: ["50000001", "50000002", "50000003", "50000004", "50000005", "50000006"] };
  const result = await contacts.importContacts([bad, good!], NOW);
  assert.deepEqual([result.inserted, result.refused], [1, [{ legacyId: `${r}-1`, code: "invalid" }]]);
  assert.equal(await contactFor(`${r}-1`), undefined);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM company_contacts WHERE org_id = (SELECT platform_id FROM legacy_id_maps WHERE legacy_table = 'company' AND legacy_id = $1)", [String(c)]);
  assert.equal(rows[0].n, 1, "the refused row's contact insert was rolled back with its savepoint");
});

test("an import waits for the contacts screen's company lock", async () => {
  const c = await companyId(), r = run();
  const orgs = await importCompanies(c);
  const holder = await pool.connect();
  let finished = false;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 5960))", [`access:org:${orgs.get(String(c))}`]);
    const running = contacts.importContacts(mapLegacyContacts([link(`${r}-1`, `${r}-p`, c)], [person(`${r}-p`)], [], []).contacts, NOW)
      .then((result) => { finished = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(finished, false, "the import must wait while the screen holds the company");
    await holder.query("COMMIT");
    assert.equal((await running).inserted, 1);
  } finally {
    holder.release();
  }
});
