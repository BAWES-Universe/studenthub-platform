import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { GRANT_SCOPES, ROLES } from "@studenthub/contracts";
import { CATALOGUE_CAPABILITIES, GRANT_CATALOGUE_VERSION, grantCatalogueView } from "../src/grant-catalogue-view.js";

const OPS = ["root"];
const row = (place: string, role: string, scope: string) =>
  grantCatalogueView(OPS).rows.find((item) => item.place === place && item.role === role && item.scope === scope)!;

test("G01_SHAPE every role at every scope, on StudentHub and on a company, once each", () => {
  const view = grantCatalogueView(OPS);
  assert.equal(view.version, GRANT_CATALOGUE_VERSION);
  assert.deepEqual(view.roles, ROLES);
  assert.deepEqual(view.scopes, GRANT_SCOPES);
  assert.equal(view.rows.length, 2 * ROLES.length * GRANT_SCOPES.length);
  assert.equal(new Set(view.rows.map((item) => `${item.place}/${item.role}/${item.scope}`)).size, view.rows.length);
  for (const item of view.rows) for (const capability of item.opens) assert.ok((CATALOGUE_CAPABILITIES as readonly string[]).includes(capability));
  assert.ok(Object.isFrozen(view.rows) && view.rows.every((item) => Object.isFrozen(item) && Object.isFrozen(item.opens)));
  assert.throws(() => grantCatalogueView([]), RangeError);
});

test("G01_GIVERS who may give each role follows the grant rules", () => {
  for (const role of ["staff", "admin", "finance"]) for (const scope of GRANT_SCOPES) assert.equal(row("operator", role, scope).givenBy, "operator_admins", `${role} ${scope}`);
  for (const role of ["org-owner", "recruiter", "finance"]) {
    assert.equal(row("company", role, "self").givenBy, "operator_staff_and_admins", role);
    assert.equal(row("company", role, "subtree").givenBy, "operator_admins", `${role} below needs an admin`);
  }
  for (const place of ["operator", "company"]) for (const scope of GRANT_SCOPES) assert.equal(row(place, "candidate", scope).givenBy, "not_on_access_pages");
  assert.equal(row("company", "admin", "self").givenBy, "not_on_access_pages");
  assert.equal(row("operator", "org-owner", "self").givenBy, "not_on_access_pages");
});

test("G01_OPENS what each grant opens is what the enforced rules allow", () => {
  assert.deepEqual(row("operator", "finance", "subtree").opens, ["finance_reports", "read_company_contacts"]);
  assert.deepEqual(row("operator", "finance", "self").opens, [], "a self finance grant reaches no company report");
  assert.ok(row("operator", "staff", "subtree").opens.includes("operations_reports"));
  assert.ok(!row("operator", "staff", "subtree").opens.includes("finance_reports"), "staff see no money figures");
  assert.ok(!row("operator", "staff", "subtree").opens.includes("manage_ip_blocks"));
  assert.deepEqual(row("operator", "staff", "self").opens, [], "a self staff grant reaches no company");
  assert.ok(row("operator", "admin", "self").opens.includes("manage_ip_blocks"));
  assert.ok(row("operator", "admin", "subtree").opens.includes("give_company_roles_below"));
  assert.deepEqual(row("company", "org-owner", "self").opens, ["read_company_contacts", "change_company_contacts", "manage_store_managers"]);
  assert.deepEqual(row("company", "recruiter", "self").opens, ["read_company_contacts"]);
  assert.deepEqual(row("company", "candidate", "self").opens, []);
  // Roles are given only on the Access pages: a lone company admin or staff grant cannot open them, so it gives nothing.
  for (const role of ["admin", "staff"]) for (const scope of GRANT_SCOPES) {
    assert.deepEqual(row("company", role, scope).opens, ["read_company_contacts", "change_company_contacts", "manage_store_managers"], `company ${role} ${scope}`);
  }
});

test("G01_VERSION the catalogue's meaning is pinned to its version; a rule change must bump GRANT_CATALOGUE_VERSION", () => {
  const view = grantCatalogueView(OPS);
  const digest = createHash("sha256").update(JSON.stringify(view)).digest("hex");
  const pinned: Record<number, string> = { 1: "6ee8cf1655fe1e06552069e8024fd0932c789d3613e4c6c2a1e657f68f8f4c43" };
  assert.equal(digest, pinned[GRANT_CATALOGUE_VERSION], "the catalogue changed: bump GRANT_CATALOGUE_VERSION and pin the new digest");
});
