import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveAccess } from "../src/grant-catalogue-view.js";

const OPS = ["root"];
type Held = { orgId: string; role: string; scope: string };
const abilities = (list: readonly { capability: string; from: readonly Held[] }[]) =>
  list.map((ability) => [ability.capability, ability.from.map((grant) => `${grant.role}@${grant.orgId}/${grant.scope}`)]);
const view = (held: Held[], organizations: { orgId: string; ancestors: string[] }[], operatorOrgIds = OPS) => {
  const access = effectiveAccess({ held, organizations, operatorOrgIds });
  return {
    global: abilities(access.global),
    places: access.places.map((place) => ({ orgId: place.orgId, operator: place.operator, here: abilities(place.here), below: abilities(place.below) })),
  };
};

test("G03_EFFECTIVE what a person's grants open: once for everywhere, then place by place, with the grant that gives each", () => {
  // No grants: StudentHub is listed, with nothing open.
  assert.deepEqual(view([], []), { global: [], places: [{ orgId: "root", operator: true, here: [], below: [] }] });
  const held = [
    { orgId: "root", role: "finance", scope: "subtree" },
    { orgId: "acme", role: "org-owner", scope: "self" },
  ];
  const orgs = [{ orgId: "root", ancestors: [] }, { orgId: "acme", ancestors: ["root"] }, { orgId: "beta", ancestors: ["root"] }];
  assert.deepEqual(view(held, orgs), {
    // Finance reports do not depend on an organization: shown once, not under each place.
    global: [["finance_reports", ["finance@root/subtree"]]],
    places: [
      // Nothing at StudentHub itself; the finance grant reaches the companies below it.
      { orgId: "root", operator: true, here: [], below: [["read_company_contacts", ["finance@root/subtree"]]] },
      // A company is asked with its real ancestors, so the StudentHub finance grant counts there too.
      { orgId: "acme", operator: false, here: [
        ["read_company_contacts", ["finance@root/subtree", "org-owner@acme/self"]],
        ["change_company_contacts", ["org-owner@acme/self"]],
        ["manage_store_managers", ["org-owner@acme/self"]],
      ],
      // Below acme only the StudentHub-wide finance grant reaches: the owner grant is for acme itself.
      below: [["read_company_contacts", ["finance@root/subtree"]]] },
      // An organization they hold no grant on is not listed.
    ],
  });
  // A company listed twice, or the operator listed as a company, appears once.
  assert.equal(effectiveAccess({ held, organizations: [...orgs, orgs[1]!], operatorOrgIds: OPS }).places.length, 2);
  assert.throws(() => effectiveAccess({ held, organizations: orgs, operatorOrgIds: [] }), RangeError);
});

test("G03_EFFECTIVE_REACH scope decides what reaches below; StudentHub roles are given at the operator itself", () => {
  const acme = [{ orgId: "acme", ancestors: ["root"] }];
  assert.deepEqual(view([{ orgId: "acme", role: "org-owner", scope: "self" }], acme).places[1]!.below, [], "a self grant reaches nothing below");
  assert.deepEqual(view([{ orgId: "acme", role: "org-owner", scope: "subtree" }], acme).places[1]!.below, [
    ["read_company_contacts", ["org-owner@acme/subtree"]],
    ["change_company_contacts", ["org-owner@acme/subtree"]],
    ["manage_store_managers", ["org-owner@acme/subtree"]],
  ]);
  // An administrator on StudentHub itself only: StudentHub roles there, nothing in the companies below.
  const self = view([{ orgId: "root", role: "admin", scope: "self" }], [{ orgId: "root", ancestors: [] }]);
  assert.deepEqual(self.places, [{ orgId: "root", operator: true, here: [["give_operator_roles", ["admin@root/self"]]], below: [] }]);
  assert.ok(self.global.some(([capability]) => capability === "access_pages"));
  // The same role for StudentHub and below reaches the companies below too.
  assert.deepEqual(view([{ orgId: "root", role: "admin", scope: "subtree" }], [{ orgId: "root", ancestors: [] }]).places[0]!.below.map(([capability]) => capability),
    ["give_company_roles", "read_company_contacts", "change_company_contacts", "manage_store_managers"]);
});

test("G03_EFFECTIVE_ROOTS each operator is asked at itself; what holds everywhere is never claimed for one operator", () => {
  // Two operators: an administrator of the second gives StudentHub roles there, not on the first.
  const two = view([{ orgId: "root2", role: "admin", scope: "self" }], [{ orgId: "root2", ancestors: [] }], ["root", "root2"]);
  assert.deepEqual(two.places.map((place) => [place.orgId, place.operator, place.here.map(([capability]) => capability)]),
    [["root", true, []], ["root2", true, ["give_operator_roles"]]]);
  // Finance on the first operator, staff on the second: finance reports are listed once, and
  // the second operator's companies show only what the staff grant reaches there.
  const cross = view([{ orgId: "root", role: "finance", scope: "subtree" }, { orgId: "root2", role: "staff", scope: "subtree" }],
    [{ orgId: "root", ancestors: [] }, { orgId: "root2", ancestors: [] }], ["root", "root2"]);
  assert.deepEqual(cross.global.find(([capability]) => capability === "finance_reports"), ["finance_reports", ["finance@root/subtree"]]);
  assert.deepEqual(cross.places[0]!.below, [["read_company_contacts", ["finance@root/subtree"]]]);
  assert.deepEqual(cross.places[1]!.below, [
    ["give_company_roles", ["staff@root2/subtree"]],
    ["read_company_contacts", ["staff@root2/subtree"]],
    ["change_company_contacts", ["staff@root2/subtree"]],
    ["manage_store_managers", ["staff@root2/subtree"]],
  ]);
  for (const place of cross.places) {
    for (const [capability] of [...place.here, ...place.below]) assert.ok(!["finance_reports", "operations_reports", "access_pages"].includes(capability as string), `${place.orgId} claims ${capability}`);
  }
});
