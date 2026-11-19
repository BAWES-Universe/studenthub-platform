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
  assert.deepEqual(await service.downloadFile("staff-1", uni.id), { kind: "catalogue-university", bytes: store.rows.get(uni.id)!.bytes });
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
