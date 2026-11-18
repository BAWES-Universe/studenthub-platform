import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresRecruitPeopleSearchStore, runMigrations, type RecruitPeopleSearchQuery } from "@studenthub/db";
import { peopleSearchDecision, searchTokens } from "../../recruit/src/index.js";

// Every test names its people with a fresh letters-only token and searches by it,
// so other suites' people never reach the results or the counts.
const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `rec3-ops-${randomUUID()}`;
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresRecruitPeopleSearchStore, staff: string;
const REF = "c".repeat(64);
const token = () => randomUUID().replaceAll("-", "").slice(0, 12).replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!);
const query = (q: string, o: Partial<RecruitPeopleSearchQuery> = {}): RecruitPeopleSearchQuery => ({ q, area: [], nationality: [], university: [], availability: [], drivingLicence: [], gender: [], includeIncomplete: false, page: 1, ...o });

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS_ORG, name: "Operator" }));
  store = new PostgresRecruitPeopleSearchStore({ pool, searchDecision: (r) => peopleSearchDecision(r, [OPS_ORG]), tokens: searchTokens, pageSize: 2 });
  staff = await principal([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
});
after(async () => pool.end());

async function principal(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = []) {
  const id = `rec3-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  if (grants.length) await authz.grantMany(id, grants);
  return id;
}
async function catalogue(type: "country" | "area" | "university", name: string, code: string | null = null) {
  const id = randomUUID();
  await pool.query("INSERT INTO catalogue_items(id, catalogue_type, name, normalized_name, code, status, created_by_ref, updated_by_ref, created_at, updated_at) VALUES($1, $2, $3, $3, $4, 'active', $5, $5, now(), now())", [id, type, name, code, REF]);
  return id;
}
interface Person { name: string; status?: string | null; gender?: string; licence?: boolean; nationality?: string | null; area?: string | null; universities?: string[]; complete?: boolean; mother?: boolean | null }
async function person(p: Person) {
  const id = await principal();
  const phone = `+965${String(Math.floor(Math.random() * 1e8)).padStart(8, "1")}`;
  await pool.query(`INSERT INTO person_profiles(principal_id, display_name, display_name_written_at, arabic_name, arabic_name_written_at, gender, gender_written_at, objective, objective_written_at, birth_date, birth_date_written_at,
    phone, phone_written_at, driving_licence, driving_licence_written_at, job_search_status, job_search_status_written_at, nationality_id, nationality_id_written_at, kuwaiti_mother, kuwaiti_mother_written_at)
    VALUES($1, $2, now(), 'نور صباح', now(), $3, now(), 'Retail work', now(), '2000-01-01', now(), $4, now(), $5, now(), $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END, $7, CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END, $8, CASE WHEN $8::boolean IS NULL THEN NULL ELSE now() END)`,
    [id, p.name, p.gender ?? "female", phone, p.licence ?? true, p.status === undefined ? "active" : p.status, p.nationality ?? null, p.mother ?? null]);
  if (p.area) await pool.query("INSERT INTO person_locations(principal_id, area_id, revision, written_at, updated_at) VALUES($1, $2, 1, now(), now())", [id, p.area]);
  if (p.complete !== false) {
    await pool.query("INSERT INTO person_civil_ids(principal_id, country, number_ciphertext, number_hash, key_version, expiry_date, revision) VALUES($1, 'KW', '\\xaa', $2, 1, '2030-01-01', 1)", [id, Buffer.from(randomUUID().replaceAll("-", "").repeat(2), "hex")]);
    await pool.query("INSERT INTO candidate_profile_records(id, owner_principal_id, kind, status, fields, created_at, updated_at) VALUES($1, $2, 'skill', 'active', '{}', now(), now())", [randomUUID(), id]);
  }
  for (const u of p.universities ?? (p.complete === false ? [] : [""])) {
    await pool.query("INSERT INTO candidate_profile_records(id, owner_principal_id, kind, status, fields, created_at, updated_at) VALUES($1, $2, 'education', 'active', $3, now(), now())", [randomUUID(), id, u ? { educationType: "standard", universityId: u } : { educationType: "not_studying" }]);
  }
  return id;
}

test("REC3_SCOPE only people looking for work with complete profiles are found, by any word of their names; companies cannot search", async () => {
  const t = token(), kw = await catalogue("country", `Kuwait ${t}`, "KW"), area = await catalogue("area", `Salmiya ${t}`);
  const base = { nationality: kw, area };
  const active = await person({ ...base, name: `Noor ${t}` });
  const open = await person({ ...base, name: `Sara ${t}`, status: "open_to_offers" });
  await person({ ...base, name: `Lina ${t}`, status: "not_looking" });
  await person({ ...base, name: `Huda ${t}`, status: null });
  const incomplete = await person({ ...base, name: `Maha ${t}`, complete: false });
  const noArea = await person({ ...base, area: null, name: `Rana ${t}` });
  const r = (await store.search(staff, query(t)))!;
  assert.equal(r.total, 2);
  assert.deepEqual(r.rows.map((x) => x.principal_id).sort(), [active, open].sort());
  const all = (await store.search(staff, query(t, { includeIncomplete: true })))!;
  assert.equal(all.total, 4);
  assert.deepEqual(all.rows.map((x) => [x.principal_id, x.complete]).slice(0, 2).every(([, c]) => c === true), true, "complete profiles come first");
  const pageTwo = (await store.search(staff, query(t, { includeIncomplete: true, page: 2 })))!;
  assert.deepEqual(pageTwo.rows.map((x) => x.principal_id).sort(), [incomplete, noArea].sort());
  assert.deepEqual((await store.search(staff, query(`noo ${t.slice(0, 6)}`)))!.rows.map((x) => x.principal_id), [active], "prefixes of every word match");
  const company = `rec3-co-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: company, name: "Company", parentOrgId: OPS_ORG }));
  assert.equal(await store.search(await principal([{ orgId: company, role: "org-owner", scope: "subtree" }]), query(t)), null);
  assert.equal(await store.search(await principal([{ orgId: OPS_ORG, role: "staff", scope: "self" }]), query(t)), null);
  const nonKuwaiti = await catalogue("country", `Jordan ${t}`, "JO");
  const noMother = await person({ name: `Dana ${t}`, nationality: nonKuwaiti, area, mother: null });
  assert.equal((await store.search(staff, query(t, { nationality: [nonKuwaiti], includeIncomplete: true })))!.rows[0]!.principal_id, noMother);
  assert.equal((await store.search(staff, query(t, { nationality: [nonKuwaiti] })))!.total, 0, "a non-Kuwaiti without the mother answer is incomplete, as in legacy");
});

test("REC3_FACETS filters combine across facets and within one facet; each facet's counts ignore its own choices", async () => {
  const t = token(), kw = await catalogue("country", `Kuwait ${t}`, "KW"), eg = await catalogue("country", `Egypt ${t}`, "EG");
  const salmiya = await catalogue("area", `Salmiya ${t}`), hawalli = await catalogue("area", `Hawalli ${t}`);
  const ku = await catalogue("university", `Kuwait University ${t}`), auk = await catalogue("university", `AUK ${t}`);
  const a = await person({ name: `Amal ${t}`, nationality: kw, area: salmiya, universities: [ku], gender: "female", licence: true });
  const b = await person({ name: `Bader ${t}`, nationality: kw, area: hawalli, universities: [ku, auk], gender: "male", licence: false, status: "open_to_offers" });
  const c = await person({ name: `Ceren ${t}`, nationality: eg, area: salmiya, universities: [auk], gender: "female", licence: true, mother: true });
  const counts = (r: { facets: { facet: string; value: string; count: number }[] }, facet: string) => Object.fromEntries(r.facets.filter((f) => f.facet === facet).map((f) => [f.value, f.count]));

  const none = (await store.search(staff, query(t)))!;
  assert.equal(none.total, 3);
  assert.deepEqual(counts(none, "area"), { [salmiya]: 2, [hawalli]: 1 });
  assert.deepEqual(counts(none, "university"), { [ku]: 2, [auk]: 2 });
  assert.deepEqual(counts(none, "availability"), { active: 2, open_to_offers: 1 });
  assert.deepEqual(counts(none, "drivingLicence"), { yes: 2, no: 1 });
  assert.deepEqual(counts(none, "gender"), { female: 2, male: 1 });
  assert.equal(none.facets.find((f) => f.facet === "university" && f.value === auk)?.label, `AUK ${t}`);

  const salmiyaOnly = (await store.search(staff, query(t, { area: [salmiya] })))!;
  assert.deepEqual(salmiyaOnly.rows.map((x) => x.principal_id).sort(), [a, c].sort());
  assert.deepEqual(counts(salmiyaOnly, "area"), { [salmiya]: 2, [hawalli]: 1 }, "the area facet still counts every area");
  assert.deepEqual(counts(salmiyaOnly, "nationality"), { [kw]: 1, [eg]: 1 });
  const either = (await store.search(staff, query(t, { area: [salmiya, hawalli], university: [auk] })))!;
  assert.deepEqual(either.rows.map((x) => x.principal_id).sort(), [b, c].sort(), "values within a facet are alternatives; facets combine");
  assert.deepEqual(counts(either, "university"), { [ku]: 2, [auk]: 2 });
  assert.deepEqual(counts(either, "gender"), { male: 1, female: 1 });
  const narrow = (await store.search(staff, query(t, { gender: ["female"], drivingLicence: ["yes"], availability: ["active"], nationality: [eg] })))!;
  assert.deepEqual(narrow.rows.map((x) => [x.principal_id, x.nationality_name, x.area_name, x.universities]), [[c, `Egypt ${t}`, `Salmiya ${t}`, [`AUK ${t}`]]]);
  assert.equal((await store.search(staff, query(t, { drivingLicence: ["no"], gender: ["female"] })))!.total, 0);
});
