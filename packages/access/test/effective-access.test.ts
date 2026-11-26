import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveAccess } from "../src/grant-catalogue-view.js";

const OPS = ["root"];
const view = (held: { orgId: string; role: string; scope: string }[], organizations: { orgId: string; ancestors: string[] }[]) =>
  effectiveAccess({ held, organizations, operatorOrgIds: OPS }).map((place) => ({
    orgId: place.orgId, operator: place.operator,
    abilities: place.abilities.map((ability) => [ability.capability, ability.from.map((grant) => `${grant.role}@${grant.orgId}/${grant.scope}`)]),
  }));

test("G03_EFFECTIVE what a person's grants do now, place by place, and which grant gives each ability", () => {
  // No grants: StudentHub is listed, with nothing open.
  assert.deepEqual(view([], []), [{ orgId: "root", operator: true, abilities: [] }]);
  const held = [
    { orgId: "root", role: "finance", scope: "subtree" },
    { orgId: "acme", role: "org-owner", scope: "self" },
  ];
  const orgs = [{ orgId: "root", ancestors: [] }, { orgId: "acme", ancestors: ["root"] }, { orgId: "beta", ancestors: ["root"] }];
  assert.deepEqual(view(held, orgs), [
    { orgId: "root", operator: true, abilities: [
      ["finance_reports", ["finance@root/subtree"]],
      ["read_company_contacts", ["finance@root/subtree"]],
    ] },
    // A company is asked with its real ancestors, so the StudentHub finance grant counts there too.
    { orgId: "acme", operator: false, abilities: [
      ["finance_reports", ["finance@root/subtree"]],
      ["read_company_contacts", ["finance@root/subtree", "org-owner@acme/self"]],
      ["change_company_contacts", ["org-owner@acme/self"]],
      ["manage_store_managers", ["org-owner@acme/self"]],
    ] },
    // An organization they hold no grant on is not listed.
  ]);
  // A company listed twice, or the operator listed as a company, appears once.
  assert.equal(effectiveAccess({ held, organizations: [...orgs, orgs[1]!], operatorOrgIds: OPS }).length, 2);
  assert.throws(() => effectiveAccess({ held, organizations: orgs, operatorOrgIds: [] }), RangeError);
});
