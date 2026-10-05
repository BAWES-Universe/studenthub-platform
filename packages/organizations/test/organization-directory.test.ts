import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import {
  InMemoryApprovedOrganizationAdapter,
  ORGANIZATION_DIRECTORY_PAGE_SIZE,
  ORGANIZATION_DIRECTORY_VERSION,
  SYNTHETIC_ORGANIZATION_FIXTURES,
  UnconfiguredApprovedOrganizationAdapter,
  type ApprovedOrganizationAdapter,
  type OrganizationDirectoryEntry,
  type OrganizationDirectoryFilters,
  type OrganizationDirectoryResult,
} from "../src/index.js";
import * as builtIn from "../src/organizations.js";

const implementation = process.env.SHU163_TEST_MODULE
  ? await import(process.env.SHU163_TEST_MODULE) as typeof builtIn
  : builtIn;
const { OrganizationRepository } = implementation;

const { parentA, childA1, unrelatedB } = SYNTHETIC_ORGANIZATION_FIXTURES;
const childA2 = Object.freeze({ ...childA1, org_id: "org-a2", company_name: "Synthetic Retail Salmiya" });

const PEOPLE = [
  "staff", "admin", "staff-self-root", "staff-self-a", "owner-a-subtree", "recruiter-a1", "candidate-a", "finance-a",
].map((id) => createPrincipal({ id, pbuuids: [`pbuuid-${id}`] }));

async function setup(options: {
  readonly source?: ApprovedOrganizationAdapter;
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
  await store.grantMany("staff", [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await store.grantMany("admin", [{ orgId: "root", role: "admin", scope: "subtree" }]);
  // A staff grant without subtree covers the operator only; the org-owner grant is another role.
  await store.grantMany("staff-self-root", [
    { orgId: "root", role: "staff" }, { orgId: "org-a", role: "org-owner", scope: "subtree" },
  ]);
  await store.grantMany("staff-self-a", [{ orgId: "org-a", role: "staff" }]);
  await store.grantMany("owner-a-subtree", [{ orgId: "org-a", role: "org-owner", scope: "subtree" }]);
  await store.grantMany("recruiter-a1", [{ orgId: "org-a1", role: "recruiter" }]);
  await store.grantMany("candidate-a", [{ orgId: "org-a", role: "candidate" }]);
  await store.grantMany("finance-a", [{ orgId: "org-a", role: "finance" }]);
  const source = options.source ?? new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
    ["org-a", parentA], ["org-a1", childA1], ["org-a2", childA2], ["org-b", unrelatedB],
  ]));
  return { store, repository: new OrganizationRepository({ store, source }) };
}

function entries(result: OrganizationDirectoryResult): readonly OrganizationDirectoryEntry[] {
  assert.equal(result.kind, "found", JSON.stringify(result));
  return (result as Extract<OrganizationDirectoryResult, { kind: "found" }>).directory.entries;
}

function ids(result: OrganizationDirectoryResult): readonly string[] {
  return entries(result).map((entry) => entry.orgId);
}

function value(entry: OrganizationDirectoryEntry, name: keyof OrganizationDirectoryEntry): unknown {
  const field = entry[name] as { state: string; value?: unknown; reason?: string };
  return field.state === "available" ? field.value : `unavailable:${field.reason}`;
}

const STAFF = { principalId: "staff", orgId: "root", role: "staff" } as const;
const ENTRY_KEYS = [
  "approvedToHire", "commonNameAr", "commonNameEn", "currencyCode", "legalName", "orgId", "registryName", "status",
  "subOrganizationCount",
];
const SENTINELS = /SENSITIVE-|company_auth_key|password|reset_token|commercial_licence|company_logo|staff_id|followup|hourly|commission|email|example\.invalid/i;

test("SHU-163/parity-contract staff list top-level companies with one status rule and grant coverage", async () => {
  const { repository } = await setup();
  const result = await repository.listOrganizations(STAFF);
  assert.equal(result.kind, "found");
  const directory = (result as Extract<OrganizationDirectoryResult, { kind: "found" }>).directory;
  assert.equal(directory.version, ORGANIZATION_DIRECTORY_VERSION);
  assert.deepEqual([directory.page, directory.pageSize, directory.total], [1, ORGANIZATION_DIRECTORY_PAGE_SIZE, 2]);
  assert.deepEqual(ids(result), ["org-a", "org-b"]);
  // OR-F2 in the legacy filters: B has positive counters and a staff override of 9. It is under review only.
  assert.deepEqual(ids(await repository.listOrganizations({ ...STAFF, filters: { status: "under_review" } })), ["org-b"]);
  assert.deepEqual(ids(await repository.listOrganizations({ ...STAFF, filters: { status: "active" } })), ["org-a"]);
  assert.deepEqual(ids(await repository.listOrganizations({ principalId: "admin", orgId: "root", role: "admin" })), ["org-a", "org-b"]);
});

test("SHU-163/AC-01 SCOPE only staff and admin list, and only what their current grants cover", async () => {
  const { store, repository } = await setup();
  for (const [principalId, orgId, role] of [
    ["owner-a-subtree", "org-a", "org-owner"], ["recruiter-a1", "org-a1", "recruiter"],
    ["candidate-a", "org-a", "candidate"], ["finance-a", "org-a", "finance"],
    // A claimed role the principal does not hold, and a context it holds no grant at.
    ["staff", "root", "admin"], ["staff-self-a", "root", "staff"], ["nobody", "root", "staff"],
  ] as const) {
    assert.deepEqual(await repository.listOrganizations({ principalId, orgId, role }), { kind: "not_found" }, `${principalId} ${role}`);
  }
  // The active context bounds the list, even when a wider grant exists.
  assert.deepEqual(ids(await repository.listOrganizations({ ...STAFF, orgId: "org-b" })), ["org-b"]);
  // A staff grant without subtree covers no company, and an org-owner grant is never borrowed.
  assert.deepEqual(ids(await repository.listOrganizations({ principalId: "staff-self-root", orgId: "root", role: "staff" })), []);
  // Uncovered sub-organizations are not even counted.
  const selfA = entries(await repository.listOrganizations({ principalId: "staff-self-a", orgId: "org-a", role: "staff" }));
  assert.deepEqual(selfA.map((entry) => [entry.orgId, entry.subOrganizationCount]), [["org-a", 0]]);
  // Revocation applies on the next call.
  await store.revokeMany("staff", [{ orgId: "root", role: "staff" }]);
  assert.deepEqual(await repository.listOrganizations(STAFF), { kind: "not_found" });
});

test("SHU-163/AC-02 HIERARCHY the list holds top-level companies and refuses a nested registry", async () => {
  const { repository } = await setup();
  const list = entries(await repository.listOrganizations(STAFF));
  assert.deepEqual(list.map((entry) => [entry.orgId, entry.subOrganizationCount]), [["org-a", 2], ["org-b", 0]]);
  assert.deepEqual(ids(await repository.listOrganizations({ ...STAFF, filters: { query: "Kuwait City" } })), []);
  const nested = await setup({ extraOrganizations: [{ id: "org-a1x", name: "Nested", parentOrgId: "org-a1" }] });
  assert.deepEqual(await nested.repository.listOrganizations(STAFF), { kind: "unavailable" });
});

test("SHU-163/AC-03 FILTERS search and filters match available values only", async () => {
  const { repository } = await setup();
  const list = (filters: OrganizationDirectoryFilters) => repository.listOrganizations({ ...STAFF, filters });
  assert.deepEqual(ids(await list({ query: "التجزئة" })), ["org-a"], "Arabic common name");
  assert.deepEqual(ids(await list({ query: "CAFE" })), ["org-b"], "case-insensitive");
  assert.deepEqual(ids(await list({ query: "Synthetic Retail Group" })), ["org-a"], "legal name");
  assert.deepEqual(ids(await list({ query: "organization b" })), ["org-b"], "registry name");
  assert.deepEqual(ids(await list({ status: "inactive" })), []);
  assert.deepEqual(ids(await list({ approvedToHire: true })), ["org-a", "org-b"]);
  assert.deepEqual(ids(await list({ approvedToHire: false })), []);
  assert.deepEqual(ids(await list({ currencyCode: "KWD", status: "active" })), ["org-a"]);
  assert.deepEqual(ids(await list({ currencyCode: "USD" })), []);
  // Without an approved snapshot, nothing is guessed: filters on imported fields match nothing.
  const bare = await setup({ source: new UnconfiguredApprovedOrganizationAdapter() });
  const bareList = (filters: OrganizationDirectoryFilters) => bare.repository.listOrganizations({ ...STAFF, filters });
  for (const filters of [{ status: "inactive" }, { status: "active" }, { approvedToHire: false }, { currencyCode: "KWD" }] as const) {
    assert.deepEqual(ids(await bareList(filters)), [], JSON.stringify(filters));
  }
  assert.deepEqual(ids(await bareList({ query: "Organization A" })), ["org-a"]);
  for (const filters of [
    { query: " Cafe" }, { query: "" }, { query: "x".repeat(101) }, { status: "approved" }, { currencyCode: "kwd" },
    { approvedToHire: 1 }, { staffId: 77 },
  ]) {
    assert.deepEqual(await list(filters as OrganizationDirectoryFilters), { kind: "invalid" }, JSON.stringify(filters));
  }
  for (const page of [0, -1, 1.5, Number.NaN]) {
    assert.deepEqual(await repository.listOrganizations({ ...STAFF, page }), { kind: "invalid" }, String(page));
  }
});

test("SHU-163/AC-04 PROJECTION entries carry a closed field set with no commercial terms or contact data", async () => {
  const { repository } = await setup();
  for (const request of [STAFF, { principalId: "admin", orgId: "root", role: "admin" }]) {
    const list = entries(await repository.listOrganizations(request));
    for (const entry of list) assert.deepEqual(Object.keys(entry).sort(), ENTRY_KEYS);
    assert.doesNotMatch(JSON.stringify(list), SENTINELS);
    const a = list.find((entry) => entry.orgId === "org-a")!;
    assert.deepEqual(
      ["legalName", "commonNameEn", "currencyCode", "approvedToHire", "status"].map((name) => value(a, name as keyof OrganizationDirectoryEntry)),
      ["Synthetic Retail Group", "Synthetic Retail", "KWD", true, "active"],
    );
  }
});

test("SHU-163/AC-05 PAGES twenty companies per page, ordered by registry name", async () => {
  const extra = Array.from({ length: 45 }, (_, index) => ({
    id: `org-x${String(index).padStart(2, "0")}`, name: `Extra ${String(index).padStart(2, "0")}`, parentOrgId: "root",
  }));
  const { repository } = await setup({ extraOrganizations: extra });
  const pages = await Promise.all([1, 2, 3, 4].map((page) => repository.listOrganizations({ ...STAFF, page })));
  assert.deepEqual(pages.map((page) => entries(page).length), [20, 20, 7, 0]);
  for (const page of pages) assert.equal((page as Extract<OrganizationDirectoryResult, { kind: "found" }>).directory.total, 47);
  const all = pages.flatMap((page) => ids(page));
  assert.equal(new Set(all).size, 47);
  assert.deepEqual(all.slice(0, 2), ["org-x00", "org-x01"]);
  assert.deepEqual(all.slice(-2), ["org-a", "org-b"]);
});

test("SHU-163/AC-06 UNAVAILABLE malformed or unreadable data refuses the list instead of hiding a company", async () => {
  const mismatched = await setup({ source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
    ["org-a", { ...parentA, parent_org_id: "org-b" }], ["org-b", unrelatedB],
  ])) });
  assert.deepEqual(await mismatched.repository.listOrganizations(STAFF), { kind: "unavailable" });
  const failing = await setup({ source: { readSnapshot: async () => { throw new Error("source down"); } } });
  assert.deepEqual(await failing.repository.listOrganizations(STAFF), { kind: "unavailable" });
});
