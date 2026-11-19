import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresCatalogueListStore } from "@studenthub/db/reports";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresCatalogueListStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresCatalogueListStore({ pool });
});
after(async () => { await store.close(); await pool.end(); });

async function item(type: string, name: string, code: string | null = null, status: "active" | "deleted" = "active"): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at,deleted_at)
    VALUES($1,$2,$3,lower($3),$4,$5,$6,$6,now(),now(),CASE WHEN $5='deleted' THEN now() END)`, [id, type, name, code, status, "c".repeat(64)]);
  return id;
}
async function person(nationality: string | null, university: string | null): Promise<void> {
  const id = `cl-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  await pool.query(`INSERT INTO person_profiles(principal_id,nationality_id,nationality_id_written_at,university_id,university_id_written_at)
    VALUES($1,$2,CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END,$3,CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END)`, [id, nationality, university]);
}

test("REPORTS_CATALOGUE_LIST every active country with its nationality count, deleted ones left out, sorted by name", async () => {
  const tag = randomUUID().slice(0, 8);
  const b = await item("country", `zz ${tag} Beta`, "XB"), a = await item("country", `zz ${tag} Alpha`, null), gone = await item("country", `zz ${tag} Gone`, "XG", "deleted");
  const uni = await item("university", `zz ${tag} College`);
  await person(a, null); await person(a, uni); await person(gone, null); await person(null, uni);
  const countries = (await store.list("country")).filter(r => r.name.includes(tag));
  assert.deepEqual(countries, [{ id: a, name: `zz ${tag} Alpha`, code: null, people: 2 }, { id: b, name: `zz ${tag} Beta`, code: "XB", people: 0 }]);
  const universities = (await store.list("university")).filter(r => r.name.includes(tag));
  assert.deepEqual(universities, [{ id: uni, name: `zz ${tag} College`, code: null, people: 2 }], "counted by university, not nationality");
  assert.ok(!(await store.list("university")).some(r => r.id === a), "a country is never in the university list");
  await assert.rejects(store.list("bank" as never), /invalid catalogue list type/);
});
