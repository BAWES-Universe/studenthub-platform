import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { resetPayAwareFixture } from "./helpers/pay-aware-fixture-reset.js";

test("REPORTS_ID_CARD_PUBLIC_VIEWS a fixture reset with TRUNCATE principals CASCADE still works and leaves every ID card guard on", async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await runMigrations(pool);
    const guards = ["id_card_events_no_truncate", "id_card_public_views_no_truncate", "id_cards_no_truncate"];
    const enabled = async () => (await pool.query<{ tgname: string; tgenabled: string }>("SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = ANY($1) ORDER BY tgname", [guards])).rows;
    const on = guards.map(tgname => ({ tgname, tgenabled: "O" }));
    assert.deepEqual(await enabled(), on);
    // A card with an event and a public photo view, all hanging off principals.
    const person = `idcreset-${randomUUID()}`, staff = `idcreset-staff-${randomUUID()}`, authz = new PostgresAuthzStore(pool);
    for (const id of [person, staff]) await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
    const card = (await pool.query<{ card_number: string }>("INSERT INTO id_cards(person_principal_id, expires_on, issued_by) VALUES ($1, '2099-01-01', $2) RETURNING card_number::text", [person, staff])).rows[0]!.card_number;
    await pool.query("INSERT INTO id_card_events(person_principal_id, kind, expires_on, actor_principal_id) VALUES ($1, 'issued', '2099-01-01', $2)", [person, staff]);
    await pool.query("INSERT INTO id_card_public_views(card_number, subject_principal_id, document_type, document_version, client_hash) VALUES ($1, $2, 'personal-photo', $3, $4)", [card, person, randomUUID(), "h".repeat(22)]);
    await assert.rejects(pool.query("TRUNCATE principals CASCADE"), /append-only|retained/, "outside the fixture reset the guards hold");
    await resetPayAwareFixture(pool, "TRUNCATE principals CASCADE");
    for (const table of ["principals", "id_cards", "id_card_events", "id_card_public_views"])
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
    assert.deepEqual(await enabled(), on, "every guard is back on after the reset");
    await assert.rejects(pool.query("TRUNCATE id_card_public_views"), /append-only/);
  } finally { await pool.end(); }
});
