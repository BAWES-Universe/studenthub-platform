import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogueAllows, grantCatalogue, grantCovers, mayOpenAccessAdmin } from "../src/grant-catalogue.js";

const OPS = ["root"];
const roles = (options: ReturnType<typeof grantCatalogue>) => options.map((option) => `${option.role}:${option.scopes.join("+")}`);

test("A1_CATALOGUE admins give staff, admin and finance on the operator organization; nobody else does", () => {
  const admin = [{ orgId: "root", role: "admin", scope: "subtree" }];
  assert.deepEqual(roles(grantCatalogue({ callerGrants: admin, targetOrgId: "root", targetAncestors: [], operatorOrgIds: OPS })),
    ["staff:self+subtree", "admin:self+subtree", "finance:self+subtree"]);
  const staff = [{ orgId: "root", role: "staff", scope: "subtree" }];
  assert.deepEqual(grantCatalogue({ callerGrants: staff, targetOrgId: "root", targetAncestors: [], operatorOrgIds: OPS }), []);
  for (const role of ["candidate", "recruiter", "finance", "org-owner"]) {
    assert.deepEqual(grantCatalogue({ callerGrants: [{ orgId: "root", role, scope: "subtree" }], targetOrgId: "root", targetAncestors: [], operatorOrgIds: OPS }), [], role);
  }
});

test("A1_CATALOGUE staff give company roles at self scope only; admins may also give subtree", () => {
  const staff = [{ orgId: "root", role: "staff", scope: "subtree" }];
  assert.deepEqual(roles(grantCatalogue({ callerGrants: staff, targetOrgId: "acme", targetAncestors: ["root"], operatorOrgIds: OPS })),
    ["org-owner:self", "recruiter:self", "finance:self"]);
  const admin = [{ orgId: "root", role: "admin", scope: "subtree" }];
  assert.deepEqual(roles(grantCatalogue({ callerGrants: admin, targetOrgId: "acme", targetAncestors: ["root"], operatorOrgIds: OPS })),
    ["org-owner:self+subtree", "recruiter:self+subtree", "finance:self+subtree"]);
  // A self-scoped staff grant on root does not reach a company below it.
  assert.deepEqual(grantCatalogue({ callerGrants: [{ orgId: "root", role: "staff", scope: "self" }], targetOrgId: "acme", targetAncestors: ["root"], operatorOrgIds: OPS }), []);
});

test("A1_CATALOGUE holding a role never lets you grant it, and candidate is never offered", () => {
  for (const role of ["org-owner", "recruiter", "finance", "candidate"]) {
    const caller = [{ orgId: "acme", role, scope: "subtree" }];
    assert.deepEqual(grantCatalogue({ callerGrants: caller, targetOrgId: "acme", targetAncestors: ["root"], operatorOrgIds: OPS }), [], role);
    assert.deepEqual(grantCatalogue({ callerGrants: caller, targetOrgId: "acme-child", targetAncestors: ["acme", "root"], operatorOrgIds: OPS }), [], role);
  }
  const admin = [{ orgId: "root", role: "admin", scope: "subtree" }];
  for (const target of ["root", "acme"]) {
    const options = grantCatalogue({ callerGrants: admin, targetOrgId: target, targetAncestors: target === "root" ? [] : ["root"], operatorOrgIds: OPS });
    assert.equal(catalogueAllows(options, "candidate", "self"), false);
  }
  assert.equal(catalogueAllows([{ role: "recruiter", scopes: ["self"] }], "recruiter", "subtree"), false);
});

test("A1_CATALOGUE a grant covers its own organization and, at subtree scope, descendants only", () => {
  assert.equal(grantCovers({ orgId: "acme", role: "staff", scope: "self" }, "acme", ["root"]), true);
  assert.equal(grantCovers({ orgId: "root", role: "staff", scope: "self" }, "acme", ["root"]), false);
  assert.equal(grantCovers({ orgId: "root", role: "staff", scope: "subtree" }, "acme", ["root"]), true);
  assert.equal(grantCovers({ orgId: "sibling", role: "staff", scope: "subtree" }, "acme", ["root"]), false);
  assert.equal(grantCovers({ orgId: "acme", role: "not-a-role", scope: "self" }, "acme", []), false);
});

test("A1_LIST only operator staff and admins may open the Access pages", () => {
  assert.equal(mayOpenAccessAdmin([{ orgId: "root", role: "admin", scope: "self" }], OPS), true);
  assert.equal(mayOpenAccessAdmin([{ orgId: "root", role: "staff", scope: "subtree" }], OPS), true);
  assert.equal(mayOpenAccessAdmin([{ orgId: "root", role: "staff", scope: "self" }], OPS), false);
  assert.equal(mayOpenAccessAdmin([{ orgId: "acme", role: "admin", scope: "subtree" }], OPS), false);
  assert.equal(mayOpenAccessAdmin([{ orgId: "root", role: "finance", scope: "subtree" }], OPS), false);
  assert.equal(mayOpenAccessAdmin([], OPS), false);
});
