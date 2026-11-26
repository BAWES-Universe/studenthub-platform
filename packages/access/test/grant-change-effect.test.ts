import assert from "node:assert/strict";
import { test } from "node:test";
import { grantCatalogueView, grantChangeEffect } from "../src/grant-catalogue-view.js";

const OPS = ["root"];
const opens = (place: string, role: string, scope: string) =>
  [...grantCatalogueView(OPS).rows.find((item) => item.place === place && item.role === role && item.scope === scope)!.opens];
const effect = (held: { orgId: string; role: string; scope: string }[], change: { orgId: string; role: string; after: string | null }, orgAncestors: string[] = []) => {
  const result = grantChangeEffect({ held, change, orgAncestors, operatorOrgIds: OPS });
  return { gained: [...result.gained], lost: [...result.lost] };
};

test("G02_EFFECT a change shows what the person gains or loses, counting the roles they already hold", () => {
  // A first role gains what the catalogue says it opens; taking it away loses the same.
  assert.deepEqual(effect([], { orgId: "root", role: "staff", after: "subtree" }), { gained: opens("operator", "staff", "subtree"), lost: [] });
  assert.deepEqual(effect([{ orgId: "root", role: "staff", scope: "subtree" }], { orgId: "root", role: "staff", after: null }), { gained: [], lost: opens("operator", "staff", "subtree") });
  // A role their other roles already cover gains nothing.
  assert.deepEqual(effect([{ orgId: "root", role: "admin", scope: "subtree" }], { orgId: "root", role: "staff", after: "subtree" }), { gained: [], lost: [] });
  // Widening shows only the difference between the two scopes.
  assert.deepEqual(effect([{ orgId: "root", role: "admin", scope: "self" }], { orgId: "root", role: "admin", after: "subtree" }), {
    gained: ["operations_reports", "finance_reports", "give_company_roles", "give_company_roles_below", "read_company_contacts", "change_company_contacts", "manage_store_managers"],
    lost: [],
  });
  // On a company: an owner grant above it still covers it, so taking away the company's own grant loses nothing.
  const owners = [{ orgId: "root", role: "org-owner", scope: "subtree" }, { orgId: "acme", role: "org-owner", scope: "subtree" }];
  assert.deepEqual(effect(owners, { orgId: "acme", role: "org-owner", after: null }, ["root"]), { gained: [], lost: [] });
  assert.deepEqual(effect([owners[1]!], { orgId: "acme", role: "org-owner", after: null }, ["root"]), {
    gained: [], lost: ["read_company_contacts", "change_company_contacts", "manage_store_managers"],
  });
});
