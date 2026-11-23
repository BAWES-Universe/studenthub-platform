import assert from "node:assert/strict";
import test from "node:test";

import { M4_SOURCES, readM4Sources, receiptSafe, runM4, sourceSql, type M4Sources, type M4Table, type M4Writers } from "../src/m4-run.js";
import { receipt } from "../src/m4-cli.js";
import { bind } from "../src/twin/staging.js";

// Synthetic legacy rows only. SECRET marks every value that must never reach a report.
const SECRET = "Secret";
function sources(): M4Sources {
  const empty = Object.fromEntries(Object.keys(M4_SOURCES).map((t) => [t, []])) as unknown as Record<M4Table, Record<string, unknown>[]>;
  return {
    ...empty,
    mall: [{ mall_uuid: "m-1", mall_name_en: `${SECRET} Mall` }],
    brand: [{ brand_uuid: "b-1", company_id: 7, brand_name_en: `${SECRET} Brand` }, { brand_uuid: "b-2", company_id: 404, brand_name_en: `${SECRET} Other` }],
    company: [{ company_id: 7, parent_company_id: null, company_name: `${SECRET} Co`, deleted: 0 }, { company_id: 8, company_name: `${SECRET} Gone`, deleted: 1 }, { company_id: "x", company_name: `${SECRET} Bad` }],
    store: [{ store_id: 1, company_id: 7, brand_uuid: "b-1", mall_uuid: "m-1", store_name: `${SECRET} Store`, store_location: `${SECRET} Block`, deleted: 0 },
      { store_id: 2, company_id: 7, brand_uuid: "b-2", store_name: `${SECRET} Store 2`, deleted: 0 }],
    contact: [{ contact_uuid: "p-1", contact_name: `${SECRET} Person`, contact_email: "secret@example.com", deleted: 0 }],
    company_contact: [
      { company_contact_uuid: "l-1", contact_uuid: "p-1", company_id: 7, contact_position: `${SECRET} Role`, allow_access: 0 },
      { company_contact_uuid: "l-2", contact_uuid: "p-1", company_id: 7, allow_access: 1 },
      { company_contact_uuid: "l-3", contact_uuid: "p-1", company_id: 7, allow_access: null },
    ],
    contact_phone: [{ phone_uuid: "f-1", contact_uuid: "p-1", phone_number: "+965 5000 0001" }],
  };
}

test("every source statement selects only its listed columns and passes the legacy binder", () => {
  for (const table of Object.keys(M4_SOURCES) as M4Table[]) {
    const sql = sourceSql(table);
    assert.equal(bind(sql, []), sql);
    assert.equal(sql, `SELECT JSON_OBJECT(${M4_SOURCES[table].map((c) => `'${c}', \`${c}\``).join(", ")}) FROM \`${table}\``);
  }
});

test("a failed read stops the run with a fixed code naming the table, never the reader's text", async () => {
  const reader = { rows: async (sql: string) => { if (sql.includes("FROM `store`")) throw new Error(`${SECRET} row text`); return []; } };
  await assert.rejects(readM4Sources(reader), (e: Error) => e.message === "m4.read.store");
});

test("a plan maps every step in order, writes nothing, and its report and receipt carry no legacy text", async () => {
  const report = await runM4(sources(), null, "2026-11-23T00:00:00.000Z");
  assert.equal(report.mode, "plan");
  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((s) => s.step), [
    "catalogue.country", "catalogue.currency", "catalogue.bank", "catalogue.tag", "catalogue.brand", "catalogue.mall",
    "catalogue.university", "catalogue.area", "company", "brand_company", "store", "company_contact"]);
  const by = new Map(report.steps.map((s) => [s.step, s]));
  // A row with no usable id is counted under its rule but has no id to list.
  assert.deepEqual([by.get("company")!.legacy, by.get("company")!.mapped, by.get("company")!.rules, by.get("company")!.issueIds],
    [3, 1, { "company.archived": 1, "company.badId": 1 }, { "company.archived": ["8"] }]);
  assert.deepEqual(by.get("store")!.issueIds, { "store.brandOtherCompany": ["2"] });
  assert.deepEqual(by.get("company_contact")!.issueIds, { "contact.access": ["l-2"], "contact.badAccess": ["l-3"] });
  assert.ok(report.steps.every((s) => s.write === undefined));
  const text = JSON.stringify(report) + receipt(report).join("\n");
  assert.ok(!text.includes(SECRET) && !text.includes("example.com") && !text.includes("5000"));
  assert.ok(receiptSafe(report));
});

test("write mode calls each store once, in dependency order, and the report keeps ids and codes only", async () => {
  const calls: string[] = [];
  const done = (n: number) => ({ inserted: n, unchanged: 0, conflicts: [], refused: [] });
  const writers: M4Writers = {
    catalogue: async (table, items) => { calls.push(`catalogue.${table}`); return { ...done(items.length), merged: 0, adopted: 0 }; },
    companies: async (rows) => { calls.push("company"); return done(rows.length); },
    brandLinks: async (rows) => { calls.push("brand_company"); return { inserted: 1, unchanged: 0, conflicts: [], refused: rows.slice(1).map((r) => ({ legacyId: r.brandLegacyId, code: "no_organization" })) }; },
    stores: async (rows) => { calls.push("store"); return done(rows.length); },
    contacts: async (rows) => { calls.push("company_contact"); return { inserted: 0, unchanged: 0, conflicts: rows.map((r) => ({ legacyId: r.legacyId, existingDigest: "a".repeat(64), incomingDigest: "b".repeat(64) })), refused: [] }; },
  };
  const report = await runM4(sources(), writers, "2026-11-23T00:00:00.000Z");
  assert.deepEqual(calls, report.steps.map((s) => s.step));
  assert.equal(report.ok, false);
  const by = new Map(report.steps.map((s) => [s.step, s]));
  assert.deepEqual(by.get("brand_company")!.write!.refused, { no_organization: ["b-2"] });
  assert.deepEqual(by.get("company_contact")!.write!.conflicts, ["l-1"]);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test("a writer result that would carry free text into the report is refused", async () => {
  const writers = {
    catalogue: async () => ({ inserted: 0, unchanged: 0, conflicts: [], refused: [] }),
    companies: async () => ({ inserted: 0, unchanged: 0, conflicts: [], refused: [{ legacyId: `${SECRET} name`, code: "invalid" }] }),
  } as unknown as M4Writers;
  await assert.rejects(runM4(sources(), writers, "2026-11-23T00:00:00.000Z"), (e: Error) => e.message === "m4.report.unsafeRefusal");
});
