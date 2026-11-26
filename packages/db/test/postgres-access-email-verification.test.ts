import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresLoginStore, emailVerifiedSql, runMigrations } from "@studenthub/db";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, login: PostgresLoginStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  login = new PostgresLoginStore(pool);
});
after(async () => pool.end());

async function person(email: string | null = `ev-${randomUUID()}@example.com`) {
  const id = `ev-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}`, ...(email === null ? {} : { email }) }));
  return id;
}
const record = (id: string, email: string, verified: boolean) => login.identities.recordEmailVerification!(id, email, verified);
const rows = async (id: string) => (await pool.query(
  "SELECT email, verified, source FROM principal_email_verifications WHERE principal_id = $1 ORDER BY email", [id])).rows;
const verified = async (id: string) => (await pool.query(`SELECT ${emailVerifiedSql("$1::text")} AS v`, [id])).rows[0].v as boolean;
const legacy = (id: string, email: string) => pool.query(
  `INSERT INTO principal_email_verifications (principal_id, email, verified, source)
   VALUES ($1, $2, true, 'legacy_import') ON CONFLICT (principal_id, email) DO NOTHING`, [id, email]);

test("EV_RECORD the issuer's answer is kept for the current address, normalised, and replaces the last one", async () => {
  const id = await person("Mixed.Case@Example.com");
  assert.equal(await verified(id), false, "nothing recorded is not verified");
  await record(id, "  MIXED.case@example.COM ", true);
  assert.deepEqual(await rows(id), [{ email: "mixed.case@example.com", verified: true, source: "oidc" }]);
  assert.equal(await verified(id), true);
  await record(id, "mixed.case@example.com", false);
  assert.deepEqual(await rows(id), [{ email: "mixed.case@example.com", verified: false, source: "oidc" }], "an issuer's false is remembered");
  assert.equal(await verified(id), false);
});

test("EV_OTHER_ADDRESS nothing is recorded for an address that is not the person's, or a blank one", async () => {
  const id = await person();
  await assert.doesNotReject(record(id, "someone-else@example.com", true), "another address is skipped, not an error");
  await assert.doesNotReject(record(id, "   ", true));
  assert.deepEqual(await rows(id), []);
  const none = await person(null);
  assert.equal((await pool.query("SELECT email FROM principals WHERE id = $1", [none])).rows[0].email, null, "this person really has no address");
  await assert.doesNotReject(record(none, "any@example.com", true));
  assert.deepEqual(await rows(none), [], "a person without an address records nothing");
  assert.equal(await verified(none), false);
  assert.equal(await verified(`ev-missing-${randomUUID()}`), false, "an unknown person is not verified");
});

test("EV_ADDRESS_CHANGE changing the address drops the fact, and changing back does not revive it", async () => {
  const id = await person("first@example.com");
  await record(id, "first@example.com", true);
  assert.equal(await verified(id), true);
  await pool.query("UPDATE principals SET email = 'second@example.com' WHERE id = $1", [id]);
  assert.deepEqual(await rows(id), [], "the old address's fact is gone");
  assert.equal(await verified(id), false);
  await pool.query("UPDATE principals SET email = 'first@example.com' WHERE id = $1", [id]);
  assert.equal(await verified(id), false, "changing back needs a fresh answer");
  await record(id, "first@example.com", true);
  await pool.query("UPDATE principals SET email = ' FIRST@example.com' WHERE id = $1", [id]);
  assert.equal(await verified(id), true, "a change only in case or spaces keeps the fact");
  await pool.query("UPDATE principals SET email = NULL WHERE id = $1", [id]);
  assert.deepEqual(await rows(id), [], "clearing the address drops the fact");
});

test("EV_LEGACY a legacy import never overrides the issuer, and fills in when nothing is known", async () => {
  const known = await person("known@example.com");
  await record(known, "known@example.com", false);
  await legacy(known, "known@example.com");
  assert.deepEqual(await rows(known), [{ email: "known@example.com", verified: false, source: "oidc" }]);
  const fresh = await person("fresh@example.com");
  await legacy(fresh, "fresh@example.com");
  assert.equal(await verified(fresh), true);
  await record(fresh, "fresh@example.com", false);
  assert.deepEqual(await rows(fresh), [{ email: "fresh@example.com", verified: false, source: "oidc" }], "the issuer replaces a legacy answer");
});

const insertFor = (client: pg.PoolClient | pg.Pool, id: string, email: string, verified = true) => client.query(
  "INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, $2, $3, 'oidc')", [id, email, verified]);

test("EV_SERIAL_CHANGE_FIRST a write racing an address change waits for it and is refused, so changing back revives nothing", async () => {
  const id = await person("race-a@example.com");
  const change = await pool.connect();
  try {
    await change.query("BEGIN");
    await change.query("UPDATE principals SET email = 'race-b@example.com' WHERE id = $1", [id]);
    const write = record(id, "race-a@example.com", true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await change.query("COMMIT");
    await assert.doesNotReject(write, "the write waited for the change, saw the new address and skipped");
  } finally {
    change.release();
  }
  assert.deepEqual(await rows(id), []);
  await pool.query("UPDATE principals SET email = 'race-a@example.com' WHERE id = $1", [id]);
  assert.equal(await verified(id), false, "changing back revives nothing");
});

test("EV_SERIAL_WRITE_FIRST an address change waits for a write in flight and then drops it", async () => {
  const id = await person("first-a@example.com");
  const write = await pool.connect();
  try {
    await write.query("BEGIN");
    await insertFor(write, id, "first-a@example.com");
    const change = pool.query("UPDATE principals SET email = 'first-b@example.com' WHERE id = $1", [id]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await write.query("COMMIT");
    await change;
  } finally {
    write.release();
  }
  assert.deepEqual(await rows(id), [], "the committed fact for the old address is dropped by the change");
  await pool.query("UPDATE principals SET email = 'first-a@example.com' WHERE id = $1", [id]);
  assert.equal(await verified(id), false, "changing back revives nothing");
});

test("EV_CURRENT_ONLY any writer, the legacy import included, is refused for an address that is not current", async () => {
  const id = await person("current@example.com");
  await assert.rejects(insertFor(pool, id, "other@example.com"), /current address/);
  await assert.rejects(pool.query(
    `INSERT INTO principal_email_verifications (principal_id, email, verified, source)
     VALUES ($1, 'other@example.com', true, 'legacy_import') ON CONFLICT (principal_id, email) DO NOTHING`, [id]), /current address/);
  await record(id, "current@example.com", true);
  await assert.rejects(pool.query("UPDATE principal_email_verifications SET email = 'other@example.com' WHERE principal_id = $1", [id]), /current address/);
  assert.deepEqual(await rows(id), [{ email: "current@example.com", verified: true, source: "oidc" }]);
});

test("EV_VETO the recovery veto replaces any answer for the current address with a kept issuer negative", async () => {
  const id = await person("Veto@Example.com");
  await record(id, "veto@example.com", true);
  assert.equal(await verified(id), true);
  await login.identities.vetoEmailVerification!(id);
  assert.deepEqual(await rows(id), [{ email: "veto@example.com", verified: false, source: "oidc" }]);
  assert.equal(await verified(id), false);
  const fresh = await person("veto-fresh@example.com");
  await login.identities.vetoEmailVerification!(fresh);
  assert.deepEqual(await rows(fresh), [{ email: "veto-fresh@example.com", verified: false, source: "oidc" }], "a veto is recorded even with no earlier answer");
  const none = await person(null);
  await assert.doesNotReject(login.identities.vetoEmailVerification!(none), "no address, nothing to veto");
  assert.deepEqual(await rows(none), []);
});

test("EV_VETO_LEGACY a negative, then recovery, then a legacy promotion attempt stays not verified", async () => {
  for (const before of ["negative", "nothing"] as const) {
    const id = await person(`veto-legacy-${before}@example.com`);
    if (before === "negative") await record(id, `veto-legacy-${before}@example.com`, false);
    // Recovery after a failed write of the issuer's answer.
    await login.identities.vetoEmailVerification!(id);
    await legacy(id, `veto-legacy-${before}@example.com`);
    assert.equal(await verified(id), false, `${before}: legacy cannot promote a vetoed address`);
    assert.deepEqual(await rows(id), [{ email: `veto-legacy-${before}@example.com`, verified: false, source: "oidc" }]);
  }
});

test("EV_STALE_TRUE_FAILED_FALSE a true answer followed by a failed false write reads as not verified once sign-in vetoes", async () => {
  const id = await person("stale@example.com");
  await record(id, "stale@example.com", true);
  assert.equal(await verified(id), true);
  // Sign-in's failure path: the false write fails, then the person's answers are vetoed.
  await assert.rejects(pool.query("INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, 'stale@example.com', false, 'nope')", [id]), /check constraint/);
  assert.equal(await verified(id), true, "the failed write alone leaves the stale true");
  await login.identities.vetoEmailVerification!(id);
  assert.equal(await verified(id), false, "the veto makes the address read as not verified");
  await legacy(id, "stale@example.com");
  assert.equal(await verified(id), false, "and a later legacy import cannot promote it");
});

test("EV_SHAPE the table refuses unnormalised addresses and unknown sources, and needs a real principal", async () => {
  const id = await person("shape@example.com");
  await assert.rejects(pool.query("INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, 'Shape@example.com', true, 'oidc')", [id]), /check constraint/);
  await assert.rejects(pool.query("INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, '', true, 'oidc')", [id]), /check constraint|current address/);
  await assert.rejects(pool.query("INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, 'shape@example.com', true, 'guess')", [id]), /check constraint/);
  await assert.rejects(pool.query("INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, 'shape@example.com', true, 'oidc')", [`ev-missing-${randomUUID()}`]), /foreign key|current address/);
});

test("EV_ASCII_KEY an address outside the plain-ASCII form records nothing, from the issuer or a veto, and reads as not verified", async () => {
  for (const email of ["Kelvin@example.com", "dİana@example.com", "nbsp@example.com ", "straße@example.com"]) {
    const id = await person(email);
    await assert.doesNotReject(record(id, email, true), "no key is a skip, not an error");
    await assert.doesNotReject(login.identities.vetoEmailVerification!(id));
    assert.deepEqual(await rows(id), [], `nothing recorded for ${JSON.stringify(email)}`);
    assert.equal(await verified(id), false);
  }
  const id = await person("kelvin@example.com");
  await record(id, "kelvin@example.com", true);
  await pool.query("UPDATE principals SET email = $2 WHERE id = $1", [id, "Kelvin@example.com"]);
  assert.deepEqual(await rows(id), [], "a change to a spelling a locale might fold drops the fact");
  assert.equal(await verified(id), false);
});

test("EV_REKEY_NEGATIVE moving to the ASCII key carries an issuer negative made under a locale's old key, and the negative wins", async () => {
  // Re-creates what migration 0658 met: rows keyed by the old lower(btrim()) under a locale that
  // lowers I to a dotless i (Turkish). All in one transaction, rolled back.
  const client = await pool.connect();
  const tag = randomUUID().slice(0, 8);
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE principal_email_verifications DROP CONSTRAINT principal_email_verifications_email_key");
    // Column-scoped triggers block a collation change; the rollback restores them.
    for (const { tgname } of (await client.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE tgrelid = 'principals'::regclass AND NOT tgisinternal AND tgattr::text <> ''")).rows) {
      await client.query(`DROP TRIGGER "${tgname}" ON principals`);
    }
    await client.query("ALTER TABLE principals ALTER COLUMN email TYPE text COLLATE \"tr-x-icu\"");
    const add = async (email: string) => {
      const id = `ev-rekey-${randomUUID()}`;
      await client.query("INSERT INTO principals (id, display_name, email) VALUES ($1, 'Rekey Person', $2)", [id, email]);
      return id;
    };
    const old = async (id: string) => (await client.query<{ e: string }>("SELECT lower(btrim(email)) AS e FROM principals WHERE id = $1", [id])).rows[0]!.e;
    const put = (id: string, email: string, verified: boolean, source: string) => client.query(
      "INSERT INTO principal_email_verifications (principal_id, email, verified, source) VALUES ($1, $2, $3, $4)", [id, email, verified, source]);
    await client.query("ALTER TABLE principal_email_verifications DISABLE TRIGGER principal_email_verifications_current_address");
    // A vetoed address, plus a legacy true already recorded under the new key: the negative wins.
    const vetoed = await add(`Ilker-${tag}@example.com`);
    assert.equal(await old(vetoed), `ılker-${tag}@example.com`, "the locale's old key differs from the ASCII key");
    await put(vetoed, await old(vetoed), false, "oidc");
    await put(vetoed, `ilker-${tag}@example.com`, true, "legacy_import");
    // A vetoed address with nothing under the new key.
    const alone = await add(`IVY-${tag}@example.com`);
    await put(alone, await old(alone), false, "oidc");
    // A positive under the old key fails closed; a stale negative for another address goes.
    const positive = await add(`Iris-${tag}@example.com`);
    await put(positive, await old(positive), true, "oidc");
    const stale = await add(`now-${tag}@example.com`);
    await put(stale, `ıvan-${tag}@example.com`, false, "oidc");
    await client.query("ALTER TABLE principal_email_verifications ENABLE TRIGGER principal_email_verifications_current_address");

    // Migration 0659 drops the one-off re-key; re-create it from 0658's own text, in this transaction.
    const sql = await readFile(new globalThis.URL("../../../../packages/db/migrations/0658_principal_email_ascii_key.sql", import.meta.url), "utf8");
    const start = sql.indexOf("CREATE FUNCTION principal_email_verifications_rekey()");
    assert.ok(start >= 0, "0658 defines the re-key");
    const body = sql.slice(start, sql.indexOf("$$;", sql.indexOf("$$", sql.indexOf("AS $$", start) + 5)) + 3);
    await client.query(body);
    const carried = (await client.query<{ n: number }>("SELECT principal_email_verifications_rekey() AS n")).rows[0]!.n;
    assert.equal(carried, 2);
    await client.query(`ALTER TABLE principal_email_verifications ADD CONSTRAINT principal_email_verifications_email_key
      CHECK (principal_email_key(email) IS NOT NULL AND email = principal_email_key(email))`);
    const rowsOf = async (id: string) => (await client.query(
      "SELECT email, verified, source FROM principal_email_verifications WHERE principal_id = $1 ORDER BY email", [id])).rows;
    const verifiedOf = async (id: string) => (await client.query(`SELECT ${emailVerifiedSql("$1::text")} AS v`, [id])).rows[0].v as boolean;
    assert.deepEqual(await rowsOf(vetoed), [{ email: `ilker-${tag}@example.com`, verified: false, source: "oidc" }], "the negative wins the collision");
    assert.deepEqual(await rowsOf(alone), [{ email: `ivy-${tag}@example.com`, verified: false, source: "oidc" }]);
    assert.deepEqual(await rowsOf(positive), [], "an old-key positive is dropped, not carried");
    assert.deepEqual(await rowsOf(stale), []);
    for (const id of [vetoed, alone, positive, stale]) assert.equal(await verifiedOf(id), false);
    // A later legacy promotion cannot turn a carried veto into verified.
    await client.query(`INSERT INTO principal_email_verifications (principal_id, email, verified, source)
      VALUES ($1, $2, true, 'legacy_import') ON CONFLICT (principal_id, email) DO NOTHING`, [alone, `ivy-${tag}@example.com`]);
    assert.equal(await verifiedOf(alone), false);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
