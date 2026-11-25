import assert from "node:assert/strict";
import { test } from "node:test";
import { mayViewFinanceReports, reportAccess } from "../src/report-access.js";

const OPS = ["root"];
const at = (role: string, scope = "subtree", orgId = "root") => [{ orgId, role, scope }];

test("REPORTS_OPERATIONS operator staff and admins read operations reports; finance does not", () => {
  assert.equal(reportAccess(at("staff"), OPS).operations, true);
  assert.equal(reportAccess(at("admin"), OPS).operations, true);
  assert.equal(reportAccess(at("finance"), OPS).operations, false);
});

test("REPORTS_FINANCE operator finance and admins read money figures; staff do not", () => {
  assert.equal(mayViewFinanceReports(at("finance"), OPS), true);
  assert.equal(mayViewFinanceReports(at("admin"), OPS), true);
  assert.equal(mayViewFinanceReports(at("staff"), OPS), false);
  assert.deepEqual(reportAccess([...at("staff"), ...at("finance")], OPS), { operations: true, finance: true });
});

test("REPORTS_SUBTREE only a subtree grant on an operator organization counts", () => {
  for (const role of ["admin", "staff", "finance"]) {
    assert.deepEqual(reportAccess(at(role, "self"), OPS), { operations: false, finance: false }, `${role} self`);
    assert.deepEqual(reportAccess(at(role, "subtree", "acme"), OPS), { operations: false, finance: false }, `${role} on a company`);
  }
});

test("REPORTS_NOBODY_ELSE company and candidate roles, and no grants, read nothing", () => {
  assert.deepEqual(reportAccess([], OPS), { operations: false, finance: false });
  for (const role of ["candidate", "recruiter", "org-owner", "auditor"]) {
    assert.deepEqual(reportAccess(at(role), OPS), { operations: false, finance: false }, role);
  }
  assert.equal(Object.isFrozen(reportAccess(at("admin"), OPS)), true);
});
