import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresExportsStore, runMigrations } from "@studenthub/db";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, store: PostgresExportsStore, principalId: string;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  principalId = `own-format-${randomUUID()}`;
  await new PostgresAuthzStore(pool).registerPrincipal(createPrincipal({ id: principalId, pbuuids: [], email: `${principalId}@example.invalid` }));
  store = new PostgresExportsStore({ pool });
});
after(async () => pool.end());

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const row = (over: Record<string, unknown> = {}) => {
  const createdAt = new Date("2026-11-19T00:00:00Z");
  return { id: randomUUID(), kind: "pay-bank-file", requesterPrincipalId: principalId, filters: {}, rowCount: 2, outcome: "created" as const, createdAt,
    expiresAt: new Date(createdAt.getTime() + 900000), bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]), ...over };
};

test("REPORTS_EXPORT_OWN_FORMAT binary bytes round-trip with their content type and file name; a CSV export has none", async () => {
  const own = row({ file: { contentType: XLSX, fileName: "abk-payment-2026-11-19.xlsx" } });
  await store.save(own as never);
  const found = await store.find(own.id);
  assert.deepEqual(found?.bytes, own.bytes, "bytes are stored exactly, including non-UTF-8 bytes");
  assert.deepEqual(found?.file, { contentType: XLSX, fileName: "abk-payment-2026-11-19.xlsx" });
  const csv = row({ kind: "company-directory", bytes: Buffer.from("csv") });
  await store.save(csv as never);
  assert.equal((await store.find(csv.id))?.file, null);
});

test("REPORTS_EXPORT_OWN_FORMAT the table refuses an unsafe name, a bad type, half a pair, or a format on a refusal", async () => {
  for (const [file, outcome] of [
    [{ contentType: XLSX, fileName: "../etc/passwd" }, "created"],
    [{ contentType: XLSX, fileName: "a\"b.xlsx" }, "created"],
    [{ contentType: "text/html; script", fileName: "x.txt" }, "created"],
  ] as const) await assert.rejects(store.save(row({ file, outcome }) as never), /check constraint/, file.fileName);
  await assert.rejects(pool.query("INSERT INTO exports(id,kind,requester_principal_id,filters,row_count,outcome,created_at,expires_at,content_type) VALUES($1,'k',$2,'{}',0,'created',now(),now()+interval '1 minute','text/plain')",
    [randomUUID(), principalId]), /exports_own_format_pair/);
  await assert.rejects(store.save(row({ outcome: "refused_limit", bytes: null, file: { contentType: XLSX, fileName: "x.xlsx" } }) as never), /exports_own_format_created/);
});
