import assert from "node:assert/strict";
import { test } from "node:test";
import { grantCatalogueView, grantChangeEffect } from "../src/grant-catalogue-view.js";

const OPS = ["root"];
const opens = (place: string, role: string, scope: string) =>
  [...grantCatalogueView(OPS).rows.find((item) => item.place === place && item.role === role && item.scope === scope)!.opens];
const effect = (held: { orgId: string; role: string; scope: string }[], change: { orgId: string; role: string; after: string | null }, orgAncestors: string[] = []) => {
  const result = grantChangeEffect({ held, change, orgAncestors, operatorOrgIds: OPS });
  return { gained: [...result.gained], lost: [...result.lost], gainedBelow: [...result.gainedBelow], lostBelow: [...result.lostBelow] };
};
const none = { gained: [], lost: [], gainedBelow: [], lostBelow: [] };
const COMPANY = ["read_company_contacts", "change_company_contacts", "manage_store_managers"];

test("G02_EFFECT a change shows what the person gains or loses, counting the roles they already hold", () => {
  // A first role gains what the catalogue says it opens; taking it away loses the same.
  assert.deepEqual(effect([], { orgId: "root", role: "staff", after: "subtree" }), { ...none, gained: opens("operator", "staff", "subtree") });
  assert.deepEqual(effect([{ orgId: "root", role: "staff", scope: "subtree" }], { orgId: "root", role: "staff", after: null }), { ...none, lost: opens("operator", "staff", "subtree") });
  // A role their other roles already cover gains nothing.
  assert.deepEqual(effect([{ orgId: "root", role: "admin", scope: "subtree" }], { orgId: "root", role: "staff", after: "subtree" }), none);
  // Widening shows only the difference between the two scopes.
  assert.deepEqual(effect([{ orgId: "root", role: "admin", scope: "self" }], { orgId: "root", role: "admin", after: "subtree" }), {
    ...none, gained: ["operations_reports", "finance_reports", "give_company_roles", "give_company_roles_below", ...COMPANY],
  });
  // On a company: an owner grant above it still covers it and the companies below, so taking away the company's own grant loses nothing.
  const owners = [{ orgId: "root", role: "org-owner", scope: "subtree" }, { orgId: "acme", role: "org-owner", scope: "subtree" }];
  assert.deepEqual(effect(owners, { orgId: "acme", role: "org-owner", after: null }, ["root"]), none);
  assert.deepEqual(effect([owners[1]!], { orgId: "acme", role: "org-owner", after: null }, ["root"]), { ...none, lost: COMPANY, lostBelow: COMPANY });
});

test("G02_EFFECT_BELOW a company role's scope decides what it opens in the companies below it", () => {
  const self = [{ orgId: "acme", role: "org-owner", scope: "self" }];
  const subtree = [{ orgId: "acme", role: "org-owner", scope: "subtree" }];
  // Widening opens the sub-companies; at the company itself nothing changes.
  assert.deepEqual(effect(self, { orgId: "acme", role: "org-owner", after: "subtree" }, ["root"]), { ...none, gainedBelow: COMPANY });
  // Narrowing closes them.
  assert.deepEqual(effect(subtree, { orgId: "acme", role: "org-owner", after: "self" }, ["root"]), { ...none, lostBelow: COMPANY });
  // A first self grant opens only the company itself.
  assert.deepEqual(effect([], { orgId: "acme", role: "org-owner", after: "self" }, ["root"]), { ...none, gained: COMPANY });
  // StudentHub itself has no "below" of its own: its company abilities are already asked at a company below it.
  assert.deepEqual(effect([], { orgId: "root", role: "org-owner", after: "subtree" }).gainedBelow, []);
});
