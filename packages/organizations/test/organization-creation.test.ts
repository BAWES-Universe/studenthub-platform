import assert from "node:assert/strict";
import { test } from "node:test";
import * as normal from "../src/organization-creation.js";
const subject = process.env.SHU333_TEST_MODULE ? (await import(process.env.SHU333_TEST_MODULE)) as typeof normal : normal;

test("SHU333_DECISION subtree staff and admin create while other grants refuse", () => {
  for (const role of ["staff", "admin"]) {
    assert.equal(subject.organizationCreationDecision([{ org_id: "company", role, scope: "subtree" }], "company", []), true);
    assert.equal(subject.organizationCreationDecision([{ org_id: "root", role, scope: "subtree" }], "company", ["root"]), true);
  }
  assert.equal(subject.organizationCreationDecision([{ org_id: "company", role: "staff", scope: "self" }], "company", []), false);
  for (const role of ["org-owner", "recruiter", "finance", "candidate"])
    assert.equal(subject.organizationCreationDecision([{ org_id: "company", role, scope: "subtree" }], "company", []), false, role);
});

test("SHU333_HIERARCHY permits only companies and one level of sub-company", () => {
  assert.equal(subject.organizationCreationParentAllowed("root", null, ["root"]), true);
  assert.equal(subject.organizationCreationParentAllowed("company", "root", ["root"]), true);
  assert.equal(subject.organizationCreationParentAllowed("company", null, ["root"]), true);
  assert.equal(subject.organizationCreationParentAllowed("sub-company", "company", ["root"]), false);
});

test("SHU333_NAME trims and validates organization names", () => {
  assert.equal(subject.parseOrganizationName("  Acme  "), "Acme");
  for (const value of ["", "x".repeat(256), "bad\nname", 3]) assert.equal(subject.parseOrganizationName(value), undefined);
});
