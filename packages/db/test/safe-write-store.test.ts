/**
 * SHU-84 acceptance against a REAL PostgreSQL (DATABASE_URL, as the SHU-55
 * suite). Every persistence claim is checked against rows, never against a
 * mock: the gateway runs on the real runtime wiring, sessions come from the
 * real login store, and grants change through the real authz store.
 *
 * Each test uses fresh principal ids, so no test depends on another's rows.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import pg from "pg";

import { createOrganization, createPrincipal } from "@studenthub/contracts";
import {
  PostgresAuthzStore,
  PostgresLoginStore,
  PostgresSafeWriteStore,
  personRecordRef,
  runMigrations,
  safeWritePrincipalRef,
} from "@studenthub/db";
import { REJECTION_REASONS, SAFE_WRITE_CONTRACT_VERSION } from "@studenthub/safe-write-contract";
import { createGatewayServer } from "../../../apps/gateway/src/index.js";
import { createRuntimeLoginFromEnv } from "../../../apps/gateway/src/login-runtime.js";

const DB_URL = process.env.DATABASE_URL ?? "";
const ORIGIN = "https://studenthub.example.invalid";
const KEY = randomBytes(32).toString("base64");
const ORG = "shu84-org";

let admin: pg.Pool;
let authz: PostgresAuthzStore;
let logins: PostgresLoginStore;

before(async () => {
  if (DB_URL.length === 0) throw new Error("DATABASE_URL is required to run the db suite");
  admin = new pg.Pool({ connectionString: DB_URL });
  await runMigrations(admin);
  authz = new PostgresAuthzStore({ connectionString: DB_URL });
  logins = new PostgresLoginStore({ connectionString: DB_URL });
  await authz.upsertOrganization(createOrganization({ id: ORG, name: "SHU-84 synthetic org" }));
});

after(async () => {
  await Promise.all([authz.close(), logins.close(), admin.end()]);
});

interface Person {
  readonly id: string;
  readonly email: string;
  readonly session: string;
}

/** A synthetic person with one grant and a persisted session. */
async function person(): Promise<Person> {
  const id = `shu84-${randomUUID()}`;
  const email = `${id}@example.invalid`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email }));
  await authz.grantMany(id, [{ orgId: ORG, role: "candidate" }]);
  const session = randomBytes(32).toString("base64url");
  await logins.sessions.put({ id: session, personId: id });
  return { id, email, session };
}

/** Everything the write path could touch for one person, as one comparable string. */
async function snapshot(id: string): Promise<string> {
  const preference = await admin.query("SELECT * FROM person_preferences WHERE principal_id = $1", [id]);
  const audit = await admin.query(
    "SELECT * FROM authorization_mutation_audit WHERE target_principal_ref = $1 ORDER BY id",
    [safeWritePrincipalRef(id)],
  );
  const receipts = await admin.query(
    "SELECT count(*)::int AS n FROM authorization_mutation_audit WHERE operation = 'profile.safe_write'",
  );
  return JSON.stringify({ preference: preference.rows, audit: audit.rows, receipts: receipts.rows });
}

async function language(id: string): Promise<string | null> {
  const { rows } = await admin.query("SELECT language FROM person_preferences WHERE principal_id = $1", [id]);
  return rows[0]?.language ?? null;
}

/** Every receipt and every error body the gateway emitted, for AC-09. */
const emitted: unknown[] = [];

async function gateway(t: TestContext, env: Record<string, string> = { SAFE_WRITE_SIGNING_KEY: KEY }) {
  const runtime = createRuntimeLoginFromEnv({
    DATABASE_URL: DB_URL, OIDC_ISSUER: "https://auth.example.invalid/",
    OIDC_CLIENT_ID: "synthetic-shu84", OIDC_CLIENT_SECRET: "synthetic-unused",
    OIDC_CALLBACK_URL: `${ORIGIN}/login/callback`,
    OIDC_AUTHORIZATION_URL: "https://auth.example.invalid/authorize",
    OIDC_TOKEN_URL: "https://auth.example.invalid/token", OIDC_JWKS_URL: "https://auth.example.invalid/jwks",
    LOGIN_ALLOWED_RETURN_URLS: `${ORIGIN}/profile`, ...env,
  });
  assert.ok(runtime);
  t.after(() => runtime.close());
  const server = createGatewayServer(undefined, undefined, undefined, runtime.application);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  async function call(path: string, who: Person | undefined, init: RequestInit = {}) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(who ? { cookie: `__Host-studenthub_session=${who.session}` } : {}), ...init.headers as Record<string, string> },
    });
    const body = await response.json() as Record<string, unknown>;
    if (body.receipt || body.error) emitted.push(body);
    return { status: response.status, body };
  }
  const post = (path: string, who: Person | undefined, body: unknown, headers: Record<string, string> = {}) =>
    call(path, who, {
      method: "POST", body: JSON.stringify(body),
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    });
  return {
    preview: (who: Person | undefined, value: unknown, headers?: Record<string, string>) =>
      post("/profile/language/preview", who, { language: value }, headers),
    confirm: (who: Person | undefined, value: unknown, token: unknown) =>
      post("/profile/language/confirm", who, { language: value, token }),
    receipt: (who: Person | undefined, ref: string) => call(`/profile/receipts/${ref}`, who),
    post,
  };
}

test("SHU-84/AC-02 PREVIEW a preview writes nothing", async (t) => {
  const api = await gateway(t);
  const alice = await person();
  const before = await snapshot(alice.id);
  const preview = await api.preview(alice, "ar");
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.changes, [{ field: "language", before: null, after: "ar" }]);
  assert.equal(await snapshot(alice.id), before, "preference row and audit table are byte-identical");
});

test("SHU-84/AC-03 APPLY a confirm applies exactly what the preview showed and leaves a receipt", async (t) => {
  const api = await gateway(t);
  const alice = await person();
  const first = await api.preview(alice, "en");
  const done = await api.confirm(alice, "en", first.body.token);
  assert.equal(done.status, 200);
  assert.equal(await language(alice.id), "en");
  const receipt = done.body.receipt as Record<string, unknown>;
  assert.equal(receipt.personRef, personRecordRef(alice.id));
  assert.equal(receipt.principalRef, safeWritePrincipalRef(alice.id));
  assert.deepEqual(receipt.fields, ["language"]);
  const row = await admin.query(
    "SELECT before_summary, after_summary FROM authorization_mutation_audit WHERE request_ref = $1",
    [receipt.receiptRef],
  );
  assert.equal(row.rows.length, 1);
  assert.deepEqual(row.rows[0].before_summary, { valuePresent: false });
  // A second change shows the stored value as `before`, then replaces it.
  const second = await api.preview(alice, "ar");
  assert.deepEqual(second.body.changes, [{ field: "language", before: "en", after: "ar" }]);
  assert.equal((await api.confirm(alice, "ar", second.body.token)).status, 200);
  assert.equal(await language(alice.id), "ar");
});

test("SHU-84/AC-04 SUBSTITUTION a token for one change cannot confirm another", async (t) => {
  const api = await gateway(t);
  const alice = await person();
  const preview = await api.preview(alice, "en");
  const before = await snapshot(alice.id);
  const swapped = await api.confirm(alice, "ar", preview.body.token);
  assert.deepEqual([swapped.status, swapped.body], [409, { error: "token_change_set_mismatch" }]);
  const forged = await api.confirm(alice, "en", { ...preview.body.token as object, expiresAt: "2999-01-01T00:00:00.000Z" });
  assert.deepEqual([forged.status, forged.body], [409, { error: "token_not_issued" }]);
  assert.equal(await snapshot(alice.id), before, "refused before any write");
});

test("SHU-84/AC-05 SINGLE USE replay is refused, across instances and under concurrency", async (t) => {
  const api = await gateway(t);
  const other = await gateway(t);
  const [alice, bob] = [await person(), await person()];
  const preview = await api.preview(alice, "en");
  const stolen = await api.confirm(bob, "en", preview.body.token);
  assert.deepEqual([stolen.status, stolen.body], [409, { error: "token_principal_mismatch" }]);
  assert.equal((await api.confirm(alice, "en", preview.body.token)).status, 200);
  // The contract's own pre-read notices the value moved, so this replay never reaches the store.
  const replay = await other.confirm(alice, "en", preview.body.token);
  assert.deepEqual([replay.status, replay.body], [409, { error: "state_changed" }]);
  // A no-op change leaves the state as the preview saw it, so only the store's
  // single-use record can refuse its replay from a second process.
  const noop = await api.preview(alice, "en");
  assert.deepEqual(noop.body.changes, [{ field: "language", before: "en", after: "en" }]);
  assert.equal((await api.confirm(alice, "en", noop.body.token)).status, 200);
  const spent = await other.confirm(alice, "en", noop.body.token);
  assert.deepEqual([spent.status, spent.body], [409, { error: "token_already_used" }],
    "a second process with its own in-memory state still refuses the spent token");

  const racing = await api.preview(bob, "ar");
  const results = await Promise.all([api, other, api, other].map((g) => g.confirm(bob, "ar", racing.body.token)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409]);
  const receipts = await admin.query(
    "SELECT count(*)::int AS n FROM authorization_mutation_audit WHERE target_principal_ref = $1 AND operation = 'profile.safe_write'",
    [safeWritePrincipalRef(bob.id)],
  );
  assert.equal(receipts.rows[0].n, 1, "one token, one receipt");
});

test("SHU-84/AC-06 AUTHORITY write authority is re-derived from current grants", async (t) => {
  const api = await gateway(t);
  const alice = await person();
  const preview = await api.preview(alice, "en");
  await authz.revokeMany(alice.id, [{ orgId: ORG, role: "candidate" }]);
  const before = await snapshot(alice.id);
  const revoked = await api.confirm(alice, "en", preview.body.token);
  assert.deepEqual([revoked.status, revoked.body], [403, { error: "not_own_record" }]);
  assert.equal(await snapshot(alice.id), before);
  const noGrant = await api.preview(alice, "ar");
  assert.deepEqual([noGrant.status, noGrant.body], [403, { error: "not_own_record" }]);

  // Inside the commit: a revocation after every caller-side check still stops the write.
  const bob = await person();
  const store = new PostgresSafeWriteStore({ connectionString: DB_URL });
  t.after(() => store.close());
  const port = store.forPrincipal(bob.id);
  assert.equal(await port.ownedRecord(safeWritePrincipalRef(bob.id)), personRecordRef(bob.id));
  await authz.revokeMany(bob.id, [{ orgId: ORG, role: "candidate" }]);
  const outcome = await port.commit(commitInput(bob.id, null, "en"));
  assert.deepEqual(outcome, { ok: false, reason: "not_own_record" });
  assert.equal(await language(bob.id), null);
  // Another principal's references are never this port's to read or write.
  const carol = await person();
  assert.equal(await store.forPrincipal(carol.id).ownedRecord(safeWritePrincipalRef(bob.id)), null);
  assert.deepEqual(await store.forPrincipal(carol.id).commit(commitInput(bob.id, null, "en")),
    { ok: false, reason: "not_own_record" }, "a port bound to one person refuses another's references");
  assert.equal(await language(carol.id), null);
});

function commitInput(id: string, expectedBefore: string | null, value: string) {
  const committedAt = new Date().toISOString();
  const tokenId = randomBytes(16).toString("hex");
  const digest = randomBytes(32).toString("hex");
  return {
    personRef: personRecordRef(id), principalRef: safeWritePrincipalRef(id), tokenId,
    field: "language", expectedBefore, value, changeSetDigest: digest,
    receipt: {
      contractVersion: SAFE_WRITE_CONTRACT_VERSION, receiptRef: randomBytes(32).toString("hex"),
      personRef: personRecordRef(id), principalRef: safeWritePrincipalRef(id),
      changeSetDigest: digest, fields: ["language"], committedAt,
    },
  };
}

test("SHU-84/AC-07 ATOMIC a receipt failure leaves the record unchanged and the token spendable", async (t) => {
  const api = await gateway(t);
  const alice = await person();
  const preview = await api.preview(alice, "ar");
  const before = await snapshot(alice.id);
  const target = safeWritePrincipalRef(alice.id);
  await admin.query(`
    CREATE OR REPLACE FUNCTION fail_shu84_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.target_principal_ref = '${target}' THEN RAISE EXCEPTION 'injected receipt failure'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER fail_shu84_receipt BEFORE INSERT ON authorization_mutation_audit
      FOR EACH ROW EXECUTE FUNCTION fail_shu84_receipt();
  `);
  try {
    const failed = await api.confirm(alice, "ar", preview.body.token);
    assert.deepEqual([failed.status, failed.body], [503, { error: "receipt_failed" }]);
    assert.equal(await snapshot(alice.id), before, "the field rolled back with its receipt");
  } finally {
    await admin.query("DROP TRIGGER IF EXISTS fail_shu84_receipt ON authorization_mutation_audit");
    await admin.query("DROP FUNCTION IF EXISTS fail_shu84_receipt()");
  }
  assert.equal((await api.confirm(alice, "ar", preview.body.token)).status, 200, "nothing happened, so the token still works");
  assert.equal(await language(alice.id), "ar");
});

test("SHU-84/AC-08 RECEIPT a person retrieves their own receipt and only their own", async (t) => {
  const api = await gateway(t);
  const [alice, bob] = [await person(), await person()];
  const preview = await api.preview(alice, "en");
  const receipt = (await api.confirm(alice, "en", preview.body.token)).body.receipt as { receiptRef: string };
  const own = await api.receipt(alice, receipt.receiptRef);
  assert.deepEqual([own.status, own.body], [200, { receipt }]);
  const theirs = await api.receipt(bob, receipt.receiptRef);
  const nothing = await api.receipt(bob, randomBytes(32).toString("hex"));
  assert.deepEqual([theirs.status, theirs.body], [404, { error: "receipt_not_found" }]);
  assert.deepEqual(theirs, nothing, "another person's receipt is indistinguishable from none");
  assert.deepEqual(await api.receipt(undefined, receipt.receiptRef), { status: 401, body: { error: "unauthorized" } });
});

test("SHU-84/AC-10 STATE a record changed since the preview is not overwritten", async (t) => {
  const api = await gateway(t);
  const alice = await person();
  const stale = await api.preview(alice, "en");
  const fresh = await api.preview(alice, "ar");
  assert.equal((await api.confirm(alice, "ar", fresh.body.token)).status, 200);
  const refused = await api.confirm(alice, "en", stale.body.token);
  assert.deepEqual([refused.status, refused.body], [409, { error: "state_changed" }]);
  assert.equal(await language(alice.id), "ar");
  // The compare lives in the commit: a stale expected value is refused there too.
  const store = new PostgresSafeWriteStore({ connectionString: DB_URL });
  t.after(() => store.close());
  assert.deepEqual(await store.forPrincipal(alice.id).commit(commitInput(alice.id, "en", "en")),
    { ok: false, reason: "state_changed" });
  assert.deepEqual(await store.forPrincipal(alice.id).commit(commitInput(alice.id, null, "en")),
    { ok: false, reason: "state_changed" }, "an insert never overwrites an existing value");
  assert.equal(await language(alice.id), "ar");
});

test("SHU-84/AC-11 BOUNDARY only same-origin JSON from a signed-in person reaches the write", async (t) => {
  const api = await gateway(t);
  const alice = await person();
  const before = await snapshot(alice.id);
  const cases: [Promise<{ status: number; body: unknown }>, number, string][] = [
    [api.preview(undefined, "en"), 401, "unauthorized"],
    [api.preview(alice, "en", { origin: "https://evil.example.invalid" }), 403, "origin_rejected"],
    [api.post("/profile/language/preview", alice, { language: "en" }, { "sec-fetch-site": "cross-site" }), 403, "origin_rejected"],
    [api.post("/profile/language/preview", alice, { language: "en" }, { "content-type": "text/plain" }), 400, "invalid_request"],
    [api.post("/profile/language/preview", alice, { language: "en", personRef: "x" }), 400, "invalid_request"],
    [api.preview(alice, "fr"), 400, "invalid_value"],
    [api.preview(alice, " en"), 400, "invalid_value"],
    [api.confirm(alice, "en", { tokenId: "made-up" }), 409, "token_not_issued"],
  ];
  for (const [response, status, error] of cases) {
    assert.deepEqual(await response, { status, body: { error } });
  }
  assert.equal(await snapshot(alice.id), before);
  const off = await gateway(t, {});
  assert.deepEqual(await off.preview(alice, "en"), { status: 503, body: { error: "safe_write_unavailable" } },
    "no signing key, no write path");
});

// Runs last: the whitelist covers every receipt and error body the suite emitted.
test("SHU-84/AC-09 WHITELIST receipts, errors and audit rows carry only approved shapes", async () => {
  const hex = /^[0-9a-f]{64}$/;
  const errors = new Set<string>([...REJECTION_REASONS, "unauthorized", "invalid_request", "origin_rejected",
    "receipt_not_found", "safe_write_unavailable"]);
  const receiptShape: Record<string, (value: unknown) => boolean> = {
    contractVersion: (v) => v === SAFE_WRITE_CONTRACT_VERSION,
    receiptRef: (v) => typeof v === "string" && hex.test(v),
    personRef: (v) => typeof v === "string" && hex.test(v),
    principalRef: (v) => typeof v === "string" && hex.test(v),
    changeSetDigest: (v) => typeof v === "string" && hex.test(v),
    fields: (v) => Array.isArray(v) && v.length === 1 && v[0] === "language",
    committedAt: (v) => typeof v === "string" && new Date(v).toISOString() === v,
  };
  assert.ok(emitted.some((body) => (body as { receipt?: unknown }).receipt), "the corpus holds receipts");
  assert.ok(emitted.some((body) => (body as { error?: unknown }).error), "the corpus holds errors");
  for (const body of emitted as Record<string, unknown>[]) {
    if ("receipt" in body) {
      assert.deepEqual(Object.keys(body), ["receipt"]);
      const receipt = body.receipt as Record<string, unknown>;
      assert.deepEqual(Object.keys(receipt).sort(), Object.keys(receiptShape).sort());
      for (const [key, valid] of Object.entries(receiptShape)) assert.ok(valid(receipt[key]), `receipt.${key}`);
    } else {
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.ok(errors.has(body.error as string), `closed error vocabulary: ${String(body.error)}`);
    }
  }
  // Beyond the shapes: no raw person id, email or token material anywhere.
  assert.doesNotMatch(JSON.stringify(emitted), /shu84-|@|tokenId|"mac"|"token"/);
  const { rows } = await admin.query(
    "SELECT before_summary, after_summary FROM authorization_mutation_audit WHERE operation = 'profile.safe_write'",
  );
  assert.doesNotMatch(JSON.stringify(rows), /shu84-|@|"en"|"ar"/, "audit rows hold no ids, emails or values");
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.before_summary), ["valuePresent"]);
    const after = row.after_summary as Record<string, unknown>;
    assert.deepEqual(Object.keys(after).sort(),
      ["changeSetDigest", "committedAt", "contractVersion", "fields", "personRef", "tokenRef"]);
    for (const key of ["changeSetDigest", "personRef", "tokenRef"]) assert.match(after[key] as string, hex);
    assert.deepEqual(after.fields, ["language"]);
  }
  // The database refuses a receipt shape the application never writes.
  await assert.rejects(admin.query(
    `INSERT INTO authorization_mutation_audit (request_ref, actor_principal_ref, operation, target_principal_ref,
       before_summary, after_summary) VALUES ($1, $2, 'profile.safe_write', $2, '{"valuePresent":true}', $3)`,
    ["a".repeat(64), "b".repeat(64), JSON.stringify({
      contractVersion: "3.0.0", personRef: "c".repeat(64), changeSetDigest: "d".repeat(64),
      fields: ["language"], committedAt: "2026-10-04T00:00:00.000Z", tokenRef: "e".repeat(64), value: "en",
    })]), /auth_audit_after_summary_shape/);
});

test("SHU-84/AC-12 AUTHOR the database requires a receipt's author to be its owner", async () => {
  const insert = (client: pg.PoolClient, actor: string | null, tokenRef: string) => client.query(
    `INSERT INTO authorization_mutation_audit (request_ref, actor_principal_ref, operation, target_principal_ref,
       before_summary, after_summary) VALUES ($1, $2, 'profile.safe_write', $3, '{"valuePresent":false}', $4)`,
    [randomBytes(32).toString("hex"), actor, "b".repeat(64), JSON.stringify({
      contractVersion: "3.0.0", personRef: "c".repeat(64), changeSetDigest: "d".repeat(64),
      fields: ["language"], committedAt: "2026-10-04T00:00:00.000Z", tokenRef,
    })],
  );
  const client = await admin.connect();
  try {
    // Control: the same row with its owner as author is accepted (then rolled back,
    // since the ledger is append-only).
    await client.query("BEGIN");
    await insert(client, "b".repeat(64), randomBytes(32).toString("hex"));
    await client.query("ROLLBACK");
    for (const actor of [null, "f".repeat(64)]) {
      await client.query("BEGIN");
      await assert.rejects(insert(client, actor, randomBytes(32).toString("hex")), /auth_audit_safe_write_self/,
        `actor ${String(actor)} is refused`);
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
});

test("SHU-84/AC-12 AUTHOR a receipt row that is not well formed is never served", async () => {
  const id = `shu84-${randomUUID()}`;
  const good = {
    request_ref: "a".repeat(64), actor_principal_ref: safeWritePrincipalRef(id),
    after_summary: {
      contractVersion: SAFE_WRITE_CONTRACT_VERSION, personRef: personRecordRef(id), changeSetDigest: "d".repeat(64),
      fields: ["language"], committedAt: "2026-10-04T00:00:00.000Z",
    },
  };
  const serving = (row: unknown) => new PostgresSafeWriteStore({
    pool: { query: async () => ({ rows: [row] }) } as unknown as pg.Pool,
  });
  assert.deepEqual(await serving(good).readReceipt(id, "a".repeat(64)), {
    contractVersion: SAFE_WRITE_CONTRACT_VERSION, receiptRef: "a".repeat(64), personRef: personRecordRef(id),
    principalRef: safeWritePrincipalRef(id), changeSetDigest: "d".repeat(64), fields: ["language"],
    committedAt: "2026-10-04T00:00:00.000Z",
  }, "control: a well-formed row is served");
  for (const bad of [
    { ...good, actor_principal_ref: null },
    { ...good, actor_principal_ref: "f".repeat(64) },
    { ...good, after_summary: { ...good.after_summary, personRef: "c".repeat(64) } },
    { ...good, after_summary: { ...good.after_summary, fields: ["language", "email"] } },
    { ...good, after_summary: { ...good.after_summary, committedAt: "yesterday" } },
    { ...good, after_summary: { ...good.after_summary, changeSetDigest: null } },
  ]) {
    await assert.rejects(serving(bad).readReceipt(id, "a".repeat(64)), /malformed safe-write receipt/);
  }
});
