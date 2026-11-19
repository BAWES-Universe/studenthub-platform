import assert from "node:assert/strict";
import test from "node:test";
import { ExportService, type ExportStore, type StoredExport } from "../src/exports.js";
import { CATALOGUE_LIST_KINDS, createCatalogueListExports, type CatalogueListSource } from "../src/catalogue-list-export.js";

class Memory implements ExportStore { rows = new Map<string, StoredExport>(); async save(r: StoredExport) { this.rows.set(r.id, r); } async find(id: string) { return this.rows.get(id) ?? null; } async cleanExpired() { return 0; } }
const staff = new Set(["staff-1"]);
const source: CatalogueListSource = {
  async isStaff(id) { return staff.has(id); },
  async list(type) { return type === "country" ? [{ id: "c1", name: "Kuwait", code: "KW", people: 3 }, { id: "c2", name: "=Formula land", code: null, people: 0 }] : [{ id: "u1", name: "Kuwait University", code: null, people: 5 }]; },
};

test("REPORTS_CATALOGUE_EXPORT country and university lists write only ID, Name, Code and Total Candidate, with an empty closed filter", async () => {
  const store = new Memory, service = new ExportService(store, createCatalogueListExports(source) as never);
  const made = await service.request("staff-1", CATALOGUE_LIST_KINDS.country, { orgId: "root", extra: "dropped" });
  assert.ok(made.ok); assert.equal(made.rowCount, 2);
  const row = store.rows.get(made.id)!;
  assert.deepEqual(row.filters, {}, "the kinds take no filters, so nothing from the request reaches the audit row");
  assert.equal(row.bytes!.toString("utf8"), "﻿ID,Name,Code,Total Candidate\r\nc1,Kuwait,KW,3\r\nc2,'=Formula land,,0\r\n");
  const uni = await service.request("staff-1", CATALOGUE_LIST_KINDS.university, {});
  assert.ok(uni.ok);
  assert.equal(store.rows.get(uni.id)!.bytes!.toString("utf8"), "﻿ID,Name,Code,Total Candidate\r\nu1,Kuwait University,,5\r\n");
  assert.deepEqual(await service.downloadFile("staff-1", uni.id), { kind: "catalogue-university", bytes: store.rows.get(uni.id)!.bytes, file: null });
});

test("REPORTS_CATALOGUE_EXPORT only staff: anyone else is refused and audited, and a lost grant stops the download", async () => {
  const store = new Memory, service = new ExportService(store, createCatalogueListExports(source) as never);
  assert.deepEqual(await service.request("person-1", CATALOGUE_LIST_KINDS.country, {}), { ok: false, reason: "not_found" });
  assert.equal([...store.rows.values()][0]?.outcome, "refused_authorization");
  staff.add("staff-2");
  const made = await service.request("staff-2", CATALOGUE_LIST_KINDS.country, {});
  assert.ok(made.ok);
  assert.equal(await service.download("staff-1", made.id), null, "another staff member cannot use the link");
  staff.delete("staff-2");
  assert.equal(await service.download("staff-2", made.id), null);
});

test("REPORTS_EXPORT_OWN_FORMAT a kind with its own format keeps every CSV guarantee: whitelisted rows only, requester binding, expiry, re-authorization and audit", async () => {
  const { EXPORT_EXPIRY_MS } = await import("../src/exports.js");
  let allowed = true, seen: unknown[][] = [];
  let now = new Date("2026-11-19T08:00:00Z");
  const bank = { id: "pay-bank-file", filterKeys: ["batch"], columns: ["Beneficiary", "Amount"], authorize: async () => allowed,
    async *rows() { yield ["A", 10]; yield ["B", 20]; },
    serialize(columns: readonly string[], rows: readonly (readonly unknown[])[], filters: { batch?: string }) {
      seen = [[...columns], ...rows.map(r => [...r])];
      return { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, rows.length]), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: `bank-${filters.batch}.xlsx` };
    } };
  const store = new Memory, service = new ExportService(store, [bank as never], () => now);
  const made = await service.request("staff-1", "pay-bank-file", { batch: "b7", extra: "dropped" });
  assert.ok(made.ok); assert.equal(made.rowCount, 2);
  assert.deepEqual(seen, [["Beneficiary", "Amount"], ["A", 10], ["B", 20]]);
  const record = store.rows.get(made.id)!;
  assert.deepEqual(record.filters, { batch: "b7" }); assert.equal(record.outcome, "created");
  assert.deepEqual(await service.downloadFile("staff-1", made.id), { kind: "pay-bank-file", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 2]),
    file: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: "bank-b7.xlsx" } });
  assert.equal(await service.download("staff-2", made.id), null, "only the requester");
  allowed = false; assert.equal(await service.download("staff-1", made.id), null, "access rechecked at download"); allowed = true;
  now = new Date(now.getTime() + EXPORT_EXPIRY_MS); assert.equal(await service.download("staff-1", made.id), null, "15-minute expiry");
  for (const bad of [{ fileName: "../x.xlsx" }, { fileName: "x\".xlsx" }, { contentType: "text/html; script" },
    // A trailing line break would end the download headers early; `$` without the m flag refuses it.
    { fileName: "safe.xlsx\n" }, { fileName: "safe.xlsx\r\n" }, { contentType: "text/plain\n" }, { contentType: "text/plain\r\n" }]) {
    const broken = { ...bank, id: "broken", serialize: () => ({ bytes: Buffer.from("x"), contentType: "text/plain", fileName: "x.txt", ...bad }) };
    await assert.rejects(new ExportService(new Memory, [broken as never]).request("staff-1", "broken", {}), /invalid file/, JSON.stringify(bad));
  }
});
