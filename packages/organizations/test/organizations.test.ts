import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import {
  InMemoryApprovedOrganizationAdapter,
  ORGANIZATION_FIELDS_BY_AUDIENCE,
  SYNTHETIC_ORGANIZATION_FIXTURES,
  UnconfiguredApprovedOrganizationAdapter,
  type OrganizationReadResult,
  type OrganizationView,
} from "../src/index.js";
import * as builtIn from "../src/organizations.js";

const implementation = process.env.SHU159_TEST_MODULE
  ? await import(process.env.SHU159_TEST_MODULE) as typeof builtIn
  : builtIn;
const { OrganizationRepository } = implementation;

const { parentA, childA1, unrelatedB } = SYNTHETIC_ORGANIZATION_FIXTURES;
const childA2 = Object.freeze({ ...childA1, org_id: "org-a2", company_name: "Synthetic Retail Salmiya" });

const PEOPLE = [
  "owner-a", "owner-a-subtree", "recruiter-a1", "staff", "admin", "candidate-a", "finance-a", "nobody",
].map((id) => createPrincipal({ id, pbuuids: [`pbuuid-${id}`] }));

async function setup(options: {
  readonly rows?: ReadonlyMap<string, unknown>;
  readonly unconfigured?: boolean;
  readonly extraOrganizations?: readonly { id: string; name: string; parentOrgId?: string }[];
} = {}) {
  const store = new InMemoryAuthzStore({
    principals: PEOPLE,
    organizations: [
      { id: "root", name: "StudentHub" },
      { id: "org-a", name: "Organization A", parentOrgId: "root" },
      { id: "org-a1", name: "Organization A1", parentOrgId: "org-a" },
      { id: "org-a2", name: "Organization A2", parentOrgId: "org-a" },
      { id: "org-b", name: "Organization B", parentOrgId: "root" },
      ...(options.extraOrganizations ?? []),
    ],
  });
  await store.grantMany("owner-a", [{ orgId: "org-a", role: "org-owner" }]);
  await store.grantMany("owner-a-subtree", [{ orgId: "org-a", role: "org-owner", scope: "subtree" }]);
  await store.grantMany("recruiter-a1", [{ orgId: "org-a1", role: "recruiter" }]);
  await store.grantMany("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await store.grantMany("admin", [{ orgId: "root", role: "admin", scope: "subtree" }]);
  await store.grantMany("candidate-a", [{ orgId: "org-a", role: "candidate" }]);
  await store.grantMany("finance-a", [{ orgId: "org-a", role: "finance" }]);
  const source = options.unconfigured
    ? new UnconfiguredApprovedOrganizationAdapter()
    : new InMemoryApprovedOrganizationAdapter(options.rows ?? new Map<string, unknown>([
      ["org-a", parentA], ["org-a1", childA1], ["org-a2", childA2], ["org-b", unrelatedB],
    ]));
  return { store, repository: new OrganizationRepository({ store, source }) };
}

function found(result: OrganizationReadResult): OrganizationView {
  assert.equal(result.kind, "found", JSON.stringify(result));
  return (result as Extract<OrganizationReadResult, { kind: "found" }>).organization;
}

function value(view: OrganizationView, name: string): unknown {
  const field = (view.fields as unknown as Record<string, { state: string; value?: unknown; reason?: string }>)[name];
  assert.ok(field, `missing field ${name}`);
  return field.state === "available" ? field.value : `unavailable:${field.reason}`;
}

const SENTINELS = /SENSITIVE-|company_auth_key|password|reset_token|commercial_licence|company_logo|staff_id|followup/i;

test("SHU-159/parity-contract two organizations, conflicting status fields, self and subtree grants", async () => {
  const { repository } = await setup();
  // One documented status rule: the stored company_status column (10 for A1) is never read.
  for (const [principalId, role] of [["owner-a-subtree", "org-owner"], ["recruiter-a1", "recruiter"], ["staff", "staff"], ["admin", "admin"]]) {
    const view = found(await repository.read({ principalId: principalId!, orgId: "org-a1", role: role! }));
    assert.equal(value(view, "status"), "inactive", `${role} status`);
  }
  // A self grant at the parent gives no access to the sub-organization.
  assert.deepEqual(await repository.read({ principalId: "owner-a", orgId: "org-a1", role: "org-owner" }), { kind: "not_found" });
  // Closed role DTO: an employer never receives the staff projection.
  const employer = found(await repository.read({ principalId: "owner-a", orgId: "org-a", role: "org-owner" }));
  assert.equal(employer.audience, "employer");
  assert.equal(Object.hasOwn(employer.fields, "email"), false);
  assert.doesNotMatch(JSON.stringify(employer), SENTINELS);
});

test("SHU-159/AC-01 STATUS status is derived from one source for every audience", async () => {
  const { repository } = await setup();
  const audiences = [["owner-a-subtree", "org-owner"], ["staff", "staff"], ["admin", "admin"]] as const;
  // OR-F2: legacy employer and manager projections ignored the override. B's override (9) wins for all.
  for (const [principalId, role] of [["staff", "staff"], ["admin", "admin"]] as const) {
    const view = found(await repository.read({ principalId, orgId: "org-b", role }));
    assert.equal(value(view, "status"), "under_review", `${role} sees the override`);
  }
  const staffB = found(await repository.read({ principalId: "staff", orgId: "org-b", role: "staff" }));
  assert.equal(value(staffB, "statusOverride"), "under_review");
  // A: no override, positive candidate counter -> active, for every audience.
  for (const [principalId, role] of audiences) {
    const view = found(await repository.read({ principalId, orgId: "org-a", role }));
    assert.equal(value(view, "status"), "active", `${role} org-a`);
  }
  // A1: stored column 10, override 0 (legacy "no override"), zero counters -> inactive.
  const staffA1 = found(await repository.read({ principalId: "staff", orgId: "org-a1", role: "staff" }));
  assert.equal(value(staffA1, "status"), "inactive");
  assert.equal(value(staffA1, "statusOverride"), "unavailable:not_recorded");
});

test("SHU-159/AC-01 STATUS employer sees the staff-applied override", async () => {
  const rows = new Map<string, unknown>([
    ["org-a", { ...parentA, company_status_override: 9 }], ["org-a1", childA1], ["org-a2", childA2], ["org-b", unrelatedB],
  ]);
  const { repository } = await setup({ rows });
  const employer = found(await repository.read({ principalId: "owner-a", orgId: "org-a", role: "org-owner" }));
  const staff = found(await repository.read({ principalId: "staff", orgId: "org-a", role: "staff" }));
  assert.equal(value(employer, "status"), "under_review");
  assert.equal(value(staff, "status"), value(employer, "status"));
});

test("SHU-159/AC-01 STATUS missing activity counters never become inactive", async () => {
  const rows = new Map<string, unknown>([
    ["org-a", { ...parentA, total_candidate: null, is_request_updates_in_30_days: 0, no_of_active_requests: 0 }],
  ]);
  const { repository } = await setup({ rows });
  const view = found(await repository.read({ principalId: "staff", orgId: "org-a", role: "staff" }));
  assert.equal(value(view, "status"), "unavailable:not_imported");
  const { total_candidate: _drop, ...withoutColumn } = parentA;
  const { repository: second } = await setup({ rows: new Map([["org-a", { ...withoutColumn, no_of_active_requests: 2 }]]) });
  // A positive counter decides on its own even while another is missing.
  assert.equal(value(found(await second.read({ principalId: "staff", orgId: "org-a", role: "staff" })), "status"), "active");
});

test("SHU-159/AC-02 HIERARCHY a sub-organization cannot have sub-organizations", async () => {
  const grandchild = { id: "org-a1x", name: "Organization A1X", parentOrgId: "org-a1" };
  const { repository } = await setup({
    extraOrganizations: [grandchild],
    rows: new Map<string, unknown>([
      ["org-a", parentA], ["org-a1", childA1], ["org-a1x", { ...childA1, org_id: "org-a1x", parent_org_id: "org-a1" }],
    ]),
  });
  assert.deepEqual(await repository.read({ principalId: "staff", orgId: "org-a1x", role: "staff" }), { kind: "unavailable" });
  assert.deepEqual(await repository.listSubOrganizations({ principalId: "staff", orgId: "org-a1", role: "staff" }), { kind: "unavailable" });
  // The valid levels above stay readable.
  const a1 = found(await repository.read({ principalId: "staff", orgId: "org-a1", role: "staff" }));
  assert.equal(a1.parentOrgId, "org-a");
  const a = found(await repository.read({ principalId: "staff", orgId: "org-a", role: "staff" }));
  assert.equal(a.parentOrgId, null);
});

test("SHU-159/AC-02 HIERARCHY the snapshot must agree with the registry", async () => {
  const { repository } = await setup({
    rows: new Map<string, unknown>([["org-a1", { ...childA1, parent_org_id: "org-b" }], ["org-a", parentA]]),
  });
  assert.deepEqual(await repository.read({ principalId: "staff", orgId: "org-a1", role: "staff" }), { kind: "unavailable" });
});

test("SHU-159/AC-03 PROJECTION each role gets exactly its closed whitelist", async () => {
  const { repository } = await setup();
  const cases = [
    ["owner-a", "org-owner", "employer"], ["owner-a-subtree", "org-owner", "employer"],
    ["staff", "staff", "staff"], ["admin", "admin", "admin"],
  ] as const;
  for (const [principalId, role, audience] of cases) {
    const view = found(await repository.read({ principalId, orgId: "org-a", role }));
    assert.equal(view.audience, audience, `${principalId} audience`);
    assert.deepEqual(Object.keys(view.fields), [...ORGANIZATION_FIELDS_BY_AUDIENCE[audience]], `${principalId} fields`);
    assert.deepEqual(Object.keys(view).sort(), ["audience", "fields", "orgId", "parentOrgId", "registryName", "snapshot", "version"]);
    assert.doesNotMatch(JSON.stringify(view), SENTINELS, `${principalId} sentinels`);
  }
  assert.deepEqual([...ORGANIZATION_FIELDS_BY_AUDIENCE.employer], [
    "legalName", "commonNameEn", "commonNameAr", "descriptionEn", "descriptionAr",
    "website", "currencyCode", "approvedToHire", "status", "hourlyRate",
  ]);
  const employer = found(await repository.read({ principalId: "owner-a", orgId: "org-a", role: "org-owner" }));
  for (const forbidden of ["email", "statusOverride", "bonusCommission"]) {
    assert.equal(Object.hasOwn(employer.fields, forbidden), false, `employer must not see ${forbidden}`);
  }
  const staff = found(await repository.read({ principalId: "staff", orgId: "org-a", role: "staff" }));
  assert.equal(Object.hasOwn(staff.fields, "bonusCommission"), false, "commission is admin-only");
  const admin = found(await repository.read({ principalId: "admin", orgId: "org-a", role: "admin" }));
  assert.equal(value(admin, "bonusCommission"), "20.00");
  assert.equal(value(admin, "email"), "hello@synthetic-retail.example.invalid");
  // Roles with no organization projection learn nothing.
  for (const [principalId, role] of [["candidate-a", "candidate"], ["finance-a", "finance"]] as const) {
    assert.deepEqual(await repository.read({ principalId, orgId: "org-a", role }), { kind: "not_found" });
  }
});

test("SHU-159/AC-04 SCOPE another organization's record is not_found, including a sibling", async () => {
  const { repository } = await setup();
  const notFound = { kind: "not_found" };
  // Recruiter on A1 reading sibling A2, the parent A and unrelated B.
  for (const orgId of ["org-a2", "org-a", "org-b"]) {
    assert.deepEqual(await repository.read({ principalId: "recruiter-a1", orgId, role: "recruiter" }), notFound, orgId);
  }
  assert.equal(found(await repository.read({ principalId: "recruiter-a1", orgId: "org-a1", role: "recruiter" })).audience, "employer");
  // Owner of A reading B; a claimed role the caller does not hold; unknown, missing and operator orgs.
  assert.deepEqual(await repository.read({ principalId: "owner-a", orgId: "org-b", role: "org-owner" }), notFound);
  assert.deepEqual(await repository.read({ principalId: "owner-a", orgId: "org-a", role: "admin" }), notFound);
  assert.deepEqual(await repository.read({ principalId: "nobody", orgId: "org-a", role: "org-owner" }), notFound);
  assert.deepEqual(await repository.read({ principalId: "staff", orgId: "org-missing", role: "staff" }), notFound);
  assert.deepEqual(await repository.read({ principalId: "staff", orgId: "root", role: "staff" }), notFound);
  // An explicit subtree grant covers the sub-organization.
  assert.equal(found(await repository.read({ principalId: "owner-a-subtree", orgId: "org-a1", role: "org-owner" })).orgId, "org-a1");
});

test("SHU-159/AC-05 RATES an unset rate falls back to the parent as exact decimals", async () => {
  const { repository } = await setup();
  const employerA1 = found(await repository.read({ principalId: "recruiter-a1", orgId: "org-a1", role: "recruiter" }));
  assert.equal(value(employerA1, "hourlyRate"), "1.500");
  const adminA1 = found(await repository.read({ principalId: "admin", orgId: "org-a1", role: "admin" }));
  assert.equal(value(adminA1, "bonusCommission"), "20.00");
  const adminB = found(await repository.read({ principalId: "admin", orgId: "org-b", role: "admin" }));
  assert.equal(value(adminB, "hourlyRate"), "2.000");
  // A top-level organization with no rate has nothing to inherit.
  const { repository: noRate } = await setup({ rows: new Map([["org-a", { ...parentA, company_hourly_rate: null }]]) });
  assert.equal(value(found(await noRate.read({ principalId: "staff", orgId: "org-a", role: "staff" })), "hourlyRate"), "unavailable:not_recorded");
});

test("SHU-159/AC-06 SCOPE revocation applies on the next read", async () => {
  const { repository, store } = await setup();
  found(await repository.read({ principalId: "owner-a", orgId: "org-a", role: "org-owner" }));
  await store.revokeMany("owner-a", [{ orgId: "org-a", role: "org-owner" }]);
  assert.deepEqual(await repository.read({ principalId: "owner-a", orgId: "org-a", role: "org-owner" }), { kind: "not_found" });
});

test("SHU-159/AC-07 SCOPE sub-organizations are listed only through a covering grant", async () => {
  const { repository } = await setup();
  const subtree = await repository.listSubOrganizations({ principalId: "owner-a-subtree", orgId: "org-a", role: "org-owner" });
  assert.equal(subtree.kind, "found");
  assert.deepEqual((subtree as Extract<typeof subtree, { kind: "found" }>).subOrganizations.map((s) => [s.orgId, s.status.state]), [
    ["org-a1", "available"], ["org-a2", "available"],
  ]);
  const self = await repository.listSubOrganizations({ principalId: "owner-a", orgId: "org-a", role: "org-owner" });
  assert.deepEqual(self, { kind: "found", subOrganizations: [] });
  assert.deepEqual(await repository.listSubOrganizations({ principalId: "recruiter-a1", orgId: "org-a", role: "recruiter" }), { kind: "not_found" });
});

test("SHU-159/AC-08 UNAVAILABLE missing or malformed data stays visibly unavailable", async () => {
  const { repository } = await setup({ unconfigured: true });
  const view = found(await repository.read({ principalId: "admin", orgId: "org-a1", role: "admin" }));
  assert.deepEqual(view.snapshot, { kind: "not_imported" });
  assert.equal(view.registryName, "Organization A1");
  for (const name of ORGANIZATION_FIELDS_BY_AUDIENCE.admin) {
    assert.equal(value(view, name), "unavailable:not_imported", name);
  }
  for (const bad of [
    { ...parentA, company_hourly_rate: 1.5e21 },
    { ...parentA, company_approved_to_hire: "yes" },
    { ...parentA, company_status_override: 3 },
    { ...parentA, total_candidate: -1 },
    { ...parentA, source_revision: "0".repeat(40) },
    { ...parentA, company_name: "" },
  ]) {
    const { repository: malformed } = await setup({ rows: new Map([["org-a", bad]]) });
    assert.deepEqual(await malformed.read({ principalId: "staff", orgId: "org-a", role: "staff" }), { kind: "unavailable" });
  }
});
