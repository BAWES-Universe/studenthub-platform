import type pg from "pg";

// Legacy integer ids for synthetic import fixtures. Each call returns the first id of a block of
// 1000 that no other call, test file or run on the same database has had, from one shared
// sequence: id ranges built from the clock and a random offset collided across suites running in
// parallel, so a seed import found its rows already mapped ("unchanged") and failed at random.
const SEQUENCE = "legacy_import_fixture_ids";
export const FIXTURE_ID_BLOCK = 1000;

export async function fixtureIds(pool: pg.Pool): Promise<number> {
  try {
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${SEQUENCE} AS bigint START WITH 900000000000 INCREMENT BY ${FIXTURE_ID_BLOCK}`);
  } catch (error) {
    // Two suites creating it at once: the loser sees a unique violation; the sequence exists.
    if (!["23505", "42P07"].includes((error as { code?: string }).code ?? "")) throw error;
  }
  const { rows: [row] } = await pool.query<{ id: string }>(`SELECT nextval('${SEQUENCE}')::text AS id`);
  return Number(row!.id);
}
