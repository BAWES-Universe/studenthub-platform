import assert from "node:assert/strict";
import test from "node:test";

import { projectOrganizationFields } from "@studenthub/organizations";
import { COMPANY_SNAPSHOT_COLUMNS, mapLegacyCompanies } from "../src/m4-organizations.js";

// Synthetic company rows only.
const company = (id: number, extra: Record<string, unknown> = {}) => ({
  company_id: id, parent_company_id: null, company_name: `Company ${id}`, company_common_name_en: `Common ${id}`,
  company_common_name_ar: null, company_description_en: "", company_description_ar: null, company_website: null,
  company_email: null, currency_code: "kwd", company_approved_to_hire: 1, company_hourly_rate: "1.500",
  company_bonus_commission: "20.000000", company_status_override: 0, total_candidate: 3,
  is_request_updates_in_30_days: 0, no_of_active_requests: "2", ...extra,
});

test("companies map parents first, with every projection column normalized", () => {
  const { organizations, issues } = mapLegacyCompanies([company(5, { parent_company_id: 2 }), company(2), company(17, { parent_company_id: 2 })]);
  assert.deepEqual(issues, []);
  assert.deepEqual(organizations.map((o) => [o.legacyId, o.parentLegacyId]), [["2", null], ["5", "2"], ["17", "2"]]);
  const snapshot = organizations[0]!.snapshot;
  assert.deepEqual(Object.keys(snapshot).sort(), [...COMPANY_SNAPSHOT_COLUMNS].sort());
  assert.equal(snapshot.currency_code, "KWD");
  assert.equal(snapshot.company_hourly_rate, "1.5");
  assert.equal(snapshot.company_bonus_commission, "20");
  assert.equal(snapshot.company_description_en, null);
  assert.equal(snapshot.no_of_active_requests, 2);
  assert.equal(organizations[0]!.name, "Company 2");
});

test("the normalized snapshot is one the organization projections read without error", () => {
  const { organizations } = mapLegacyCompanies([company(1)]);
  const row = { ...organizations[0]!.snapshot, org_id: "o1", parent_org_id: null };
  for (const audience of ["employer", "staff", "admin"] as const) {
    const fields = projectOrganizationFields(audience, row, null);
    assert.ok(Object.keys(fields).length > 0);
  }
  const staff = projectOrganizationFields("staff", row, null) as Record<string, { state: string; value?: unknown }>;
  assert.equal(staff.status!.state, "available");
  assert.equal(staff.status!.value, "active");
});

test("an unusable column becomes null and is reported by column; the company still imports", () => {
  const { organizations, issues } = mapLegacyCompanies([company(1, {
    currency_code: "dinar", company_hourly_rate: "-1", company_status_override: 4, company_approved_to_hire: "yes",
    total_candidate: -2, company_website: "x".repeat(2049),
  })]);
  assert.equal(organizations.length, 1);
  const s = organizations[0]!.snapshot;
  assert.deepEqual([s.currency_code, s.company_hourly_rate, s.company_status_override, s.company_approved_to_hire, s.total_candidate, s.company_website],
    [null, null, null, null, null, null]);
  assert.deepEqual(issues.map((i) => i.field).sort(),
    ["company_approved_to_hire", "company_hourly_rate", "company_status_override", "company_website", "currency_code", "total_candidate"]);
  assert.ok(issues.every((i) => i.rule === "company.badValue" && i.legacyId === "1"));
});

test("missing parents, loops, bad ids and nameless rows are reported and left out with their descendants", () => {
  const { organizations, issues } = mapLegacyCompanies([
    company(1),
    company(2, { parent_company_id: 99 }),
    company(3, { parent_company_id: 2 }),
    company(4, { parent_company_id: 5 }),
    company(5, { parent_company_id: 4 }),
    company(6, { parent_company_id: 6 }),
    company(7, { company_name: "  " }),
    { ...company(8), company_id: "x" },
    company(1),
    company(9, { parent_company_id: "abc" }),
    company(10, { parent_company_id: 0 }),
    company(11, { parent_company_id: 1 }),
    company(12, { parent_company_id: 11 }),
  ]);
  assert.deepEqual(organizations.map((o) => o.legacyId), ["1", "10", "11"]);
  assert.deepEqual(issues.map((i) => [i.rule, i.legacyId]), [
    ["company.noName", "7"],
    ["company.badId", "?"],
    ["company.duplicateId", "1"],
    ["company.missingParent", "9"],
    ["company.missingParent", "2"],
    ["company.missingParent", "3"],
    ["company.parentCycle", "4"],
    ["company.parentCycle", "5"],
    ["company.parentCycle", "6"],
    ["company.tooDeep", "12"],
  ]);
});

test("a repeated id is a duplicate even when its first row was refused, and the later valid row is not imported", () => {
  const { organizations, issues } = mapLegacyCompanies([
    company(1, { company_name: " " }),
    company(1),
    company(2, { parent_company_id: "abc" }),
    company(2),
    company(3, { parent_company_id: 2 }),
  ]);
  assert.deepEqual(organizations, []);
  assert.deepEqual(issues.map((i) => [i.rule, i.legacyId]), [
    ["company.noName", "1"],
    ["company.duplicateId", "1"],
    ["company.missingParent", "2"],
    ["company.duplicateId", "2"],
    ["company.missingParent", "3"],
  ]);
});

test("archived companies are excluded and reported; their children are held as archivedParent", () => {
  const { organizations, issues } = mapLegacyCompanies([
    company(1, { deleted: 1 }),
    company(2, { parent_company_id: 1 }),
    company(3, { deleted: "1" }),
    company(4, { deleted: 0 }),
    company(5, { parent_company_id: 4, deleted: true }),
    company(6, { parent_company_id: 4 }),
  ]);
  assert.deepEqual(organizations.map((o) => o.legacyId), ["4", "6"]);
  assert.deepEqual(issues.map((i) => [i.rule, i.legacyId]), [
    ["company.archived", "1"],
    ["company.archived", "3"],
    ["company.archived", "5"],
    ["company.archivedParent", "2"],
  ]);
});

test("the digest is stable and follows the row", () => {
  const a = mapLegacyCompanies([company(1)]).organizations[0]!.digest;
  assert.equal(mapLegacyCompanies([company(1)]).organizations[0]!.digest, a);
  assert.notEqual(mapLegacyCompanies([company(1, { company_hourly_rate: "2" })]).organizations[0]!.digest, a);
});
