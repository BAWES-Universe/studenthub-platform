import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationDirectoryRequest, OrganizationDirectoryResult } from "@studenthub/organizations";
import { directoryCompanyCounts } from "../src/comms/wiring.js";

const found = (total: number) => ({ kind: "found", directory: { version: 1, entries: [], page: 1, pageSize: 50, total } }) as unknown as OrganizationDirectoryResult;

test("REPORTS_STATISTICS_COMPANIES company totals come from the directory as the viewer: staff grant first, then admin; nothing when neither answers", async () => {
  const calls: OrganizationDirectoryRequest[] = [];
  const grants: Record<string, string> = { sara: "staff", aziz: "admin" };
  const counts = directoryCompanyCounts({ async listOrganizations(r) {
    calls.push(r);
    if (grants[r.principalId] !== r.role) return { kind: "not_found" };
    return found(r.filters?.status === "active" ? 4 : 10);
  } });
  assert.deepEqual(await counts.counts("sara"), { activeClients: 4, companies: 10 });
  assert.deepEqual(calls.map(c => [c.orgId, c.role, c.filters?.status ?? "all", c.page]), [["root", "staff", "all", 1], ["root", "staff", "active", 1]]);
  assert.deepEqual(await counts.counts("aziz"), { activeClients: 4, companies: 10 });
  assert.equal(await counts.counts("nobody"), undefined);
  const flaky = directoryCompanyCounts({ async listOrganizations(r) { return r.filters?.status ? { kind: "unavailable" } as OrganizationDirectoryResult : found(3); } });
  assert.equal(await flaky.counts("sara"), undefined, "an all-companies total without its active total is not shown");
});
