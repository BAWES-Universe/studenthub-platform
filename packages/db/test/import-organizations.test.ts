import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresImportedOrganizationSnapshots, PostgresOrganizationImportStore } from "@studenthub/db/import";
import { ORGANIZATION_PARITY_REVISION, OrganizationRepository } from "../../organizations/src/index.js";
import { mapLegacyCompanies } from "../../../tools/legacy-import/src/m4-organizations.js";

// Synthetic company rows only; fresh legacy ids per run so the suite can share a database.

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, store: PostgresOrganizationImportStore, snapshots: PostgresImportedOrganizationSnapshots, authz: PostgresAuthzStore;
let operator: string;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  operator = `import-operator-${randomUUID()}`;
  await pool.query("INSERT INTO organizations (id, name, parent_org_id) VALUES ($1, 'Operator', NULL)", [operator]);
  store = new PostgresOrganizationImportStore(pool, ORGANIZATION_PARITY_REVISION, operator);
  snapshots = new PostgresImportedOrganizationSnapshots(pool);
  authz = new PostgresAuthzStore(pool);
});
after(async () => pool.end());

let next = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
const ids = () => { next += 10; return next; };
const company = (id: number, extra: Record<string, unknown> = {}) => ({
  company_id: id, parent_company_id: null, company_name: `Company ${id}`, company_common_name_en: `Common ${id}`,
  company_common_name_ar: null, company_description_en: null, company_description_ar: null, company_website: null,
  company_email: null, currency_code: "KWD", company_approved_to_hire: 1, company_hourly_rate: "1.500",
  company_bonus_commission: null, company_status_override: 0, total_candidate: 0,
  is_request_updates_in_30_days: 0, no_of_active_requests: 0, ...extra,
});

test("companies import under the operator org with their parent, once; a re-run is unchanged", async () => {
  const top = ids(), sub = top + 1;
  const { organizations } = mapLegacyCompanies([company(sub, { parent_company_id: top }), company(top)]);
  assert.deepEqual(await store.importOrganizations(organizations), { inserted: 2, unchanged: 0, conflicts: [], refused: [] });
  assert.deepEqual(await store.importOrganizations(organizations), { inserted: 0, unchanged: 2, conflicts: [], refused: [] });
  const map = await store.idMap();
  const { rows } = await pool.query("SELECT id, name, parent_org_id FROM organizations WHERE id = ANY($1::text[]) ORDER BY name",
    [[map.get(String(top)), map.get(String(sub))]]);
  assert.deepEqual(rows.map((r) => [r.name, r.parent_org_id]), [[`Company ${top}`, operator], [`Company ${sub}`, map.get(String(top))]]);
});

test("the snapshot adapter gives the organizations package a row it accepts, with the company parent", async () => {
  const top = ids(), sub = top + 1;
  await store.importOrganizations(mapLegacyCompanies([company(top, { total_candidate: 4 }), company(sub, { parent_company_id: top })]).organizations);
  const map = await store.idMap();
  const topId = map.get(String(top))!, subId = map.get(String(sub))!;
  const read = await snapshots.readSnapshots([topId, subId, "not-imported"]);
  const topRow = (read.get(topId) as { kind: "found"; row: Record<string, unknown> }).row;
  assert.equal(topRow.org_id, topId);
  assert.equal(topRow.parent_org_id, null);
  assert.equal(topRow.source_revision, ORGANIZATION_PARITY_REVISION);
  assert.match(String(topRow.imported_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal((read.get(subId) as { row: Record<string, unknown> }).row.parent_org_id, topId);
  assert.deepEqual(read.get("not-imported"), { kind: "missing" });

  // Read through the real repository as a staff member of the operator org.
  const staff = `import-staff-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id: staff, pbuuids: [], email: `${staff}@example.invalid` }));
  await authz.grantMany(staff, [{ orgId: operator, role: "staff", scope: "subtree" }] as never);
  const repository = new OrganizationRepository({ store: authz, source: snapshots, operatorOrgIds: [operator] });
  const result = await repository.read({ principalId: staff, orgId: topId, role: "staff" });
  assert.equal(result.kind, "found");
  const fields = (result as { organization: { fields: Record<string, { state: string; value?: unknown }> } }).organization.fields;
  assert.equal(fields.legalName?.value, `Company ${top}`);
  assert.equal(fields.status?.value, "active");
});

test("a changed company is a conflict and is never overwritten", async () => {
  const id = ids();
  const first = mapLegacyCompanies([company(id)]).organizations;
  await store.importOrganizations(first);
  const changed = mapLegacyCompanies([company(id, { company_name: "Renamed" })]).organizations;
  const result = await store.importOrganizations(changed);
  assert.deepEqual(result.conflicts, [{ legacyId: String(id), existingDigest: first[0]!.digest, incomingDigest: changed[0]!.digest }]);
  const { rows } = await pool.query("SELECT name FROM organizations WHERE id = $1", [(await store.idMap()).get(String(id))]);
  assert.equal(rows[0].name, `Company ${id}`);
});

test("a sub-company whose parent is not imported is refused, and the batch goes on", async () => {
  const top = ids(), sub = top + 1, other = top + 2;
  const { organizations } = mapLegacyCompanies([company(top), company(sub, { parent_company_id: top }), company(other)]);
  const result = await store.importOrganizations(organizations.filter((o) => o.legacyId !== String(top)));
  assert.deepEqual(result.refused, [{ legacyId: String(sub), code: "no_parent" }]);
  assert.equal(result.inserted, 1);
});

test("reconciliation lists reported skips apart from unexplained gaps", async () => {
  const a = ids();
  await store.importOrganizations(mapLegacyCompanies([company(a)]).organizations);
  const report = await store.reconcile([String(a), String(a + 1), String(a + 2)], [String(a + 1)]);
  assert.equal(report.legacy, 3);
  assert.equal(report.imported, 1);
  assert.deepEqual(report.skipped, [String(a + 1)]);
  assert.deepEqual(report.missing, [String(a + 2)]);
});

test("two import runs at once are serialized: one inserts, the other finds the companies unchanged", async () => {
  const base = ids(); next += 200;
  const { organizations } = mapLegacyCompanies(Array.from({ length: 20 }, (_, i) => company(base + i)));
  const other = new PostgresOrganizationImportStore({ connectionString: URL }, ORGANIZATION_PARITY_REVISION, operator);
  try {
    const [a, b] = await Promise.all([store.importOrganizations(organizations), other.importOrganizations(organizations)]);
    assert.deepEqual([a.refused, b.refused, a.conflicts, b.conflicts], [[], [], [], []]);
    assert.deepEqual([a.inserted + b.inserted, a.unchanged + b.unchanged], [20, 20]);
  } finally {
    await other.close();
  }
});
