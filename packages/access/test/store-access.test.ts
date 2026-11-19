import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideAccept,
  decideInvite,
  decideStoreAccessChange,
  managedStores,
  mayManageStoreAccess,
  openManagedStore,
  storeAccessHolds,
  teamCatalogue,
  type HeldGrant,
  type ManagedStoreRow,
} from "../src/index.js";

const ACME = "acme";
const S1 = "11111111-1111-4111-8111-111111111111", S2 = "22222222-2222-4222-8222-222222222222", S3 = "33333333-3333-4333-8333-333333333333";
const row = (over: Partial<ManagedStoreRow> = {}): ManagedStoreRow => ({
  principalId: "manager-1", storeId: S1, orgId: ACME, orgName: "Acme", name: "Avenues", location: "Hall 2", brand: "Brand", mall: "The Avenues",
  revokedAt: null, storeStatus: "active", orgLive: true, ...over,
});
const grant = (role: string, orgId = ACME, scope: "self" | "subtree" = "self"): HeldGrant => ({ orgId, role, scope });

test("A4_RULE a store grant holds only while not revoked, its store active and its company live", () => {
  assert.equal(storeAccessHolds(row()), true);
  assert.equal(storeAccessHolds(row({ revokedAt: "2026-11-17T10:00:00.000Z" })), false, "no live grant row, no store");
  assert.deepEqual(managedStores("manager-1", [row(), row({ storeId: S2, revokedAt: "2026-11-17T10:00:00.000Z" })]).map((item) => item.storeId), [S1]);
  assert.equal(openManagedStore("manager-1", S2, [row({ storeId: S2, revokedAt: "2026-11-17T10:00:00.000Z" })]), undefined);
  assert.deepEqual(managedStores("someone-else", [row()]), [], "rows of another principal never count");
});

test("A4_NO_LEAK a manager opens only a store they manage, never a sibling or a sub-company's store", () => {
  const rows = [row()];
  assert.equal(openManagedStore("manager-1", S1, rows)?.name, "Avenues");
  assert.equal(openManagedStore("manager-1", S2, rows), undefined, "a sibling store of the same company");
  assert.equal(openManagedStore("manager-1", S3, rows), undefined, "a store of a sub-company");
});

test("A4_REVOKE a removed store or a deleted company ends the grant on the next read", () => {
  assert.equal(storeAccessHolds(row({ storeStatus: "deleted" })), false);
  assert.equal(storeAccessHolds(row({ orgLive: false })), false);
  assert.equal(openManagedStore("manager-1", S1, [row({ storeStatus: "deleted" })]), undefined);
  assert.deepEqual(managedStores("manager-1", [row({ orgLive: false })]), []);
});

test("A4_GRANT owners, staff and admin offer one active store of the company, at self scope", () => {
  const store = { orgId: ACME, status: "active" };
  const base = { callerGrants: [grant("org-owner")], orgLive: true, orgAncestors: ["root"], store };
  assert.deepEqual(decideStoreAccessChange(ACME, base), { kind: "ok" });
  assert.deepEqual(decideStoreAccessChange(ACME, { ...base, callerGrants: [grant("staff", "root", "subtree")] }), { kind: "ok" });
  assert.deepEqual(decideStoreAccessChange(ACME, { ...base, callerGrants: [grant("recruiter")] }), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(decideStoreAccessChange(ACME, { ...base, store: { orgId: "other", status: "active" } }), { kind: "refused", reason: "unknown_store" });
  assert.deepEqual(decideStoreAccessChange(ACME, { ...base, store: { orgId: ACME, status: "deleted" } }), { kind: "refused", reason: "unknown_store" });
  assert.deepEqual(decideStoreAccessChange(ACME, { ...base, orgLive: false }), { kind: "refused", reason: "unknown_store" });
  const invite = { callerGrants: [grant("org-owner")], orgLive: true, orgAncestors: [], pendingCount: 0, duplicatePending: false, store };
  assert.deepEqual(decideInvite(ACME, { role: "store-manager", scope: "self", storeId: S1 }, invite), { kind: "ok" });
  assert.deepEqual(decideInvite(ACME, { role: "store-manager", scope: "subtree", storeId: S1 }, invite), { kind: "refused", reason: "role_not_allowed" });
  assert.deepEqual(decideInvite(ACME, { role: "store-manager", scope: "self" }, invite), { kind: "refused", reason: "role_not_allowed" });
  assert.deepEqual(decideInvite(ACME, { role: "recruiter", scope: "self", storeId: S1 }, invite), { kind: "refused", reason: "role_not_allowed" }, "a store invitation is never a company role");
  assert.deepEqual(decideInvite(ACME, { role: "store-manager", scope: "self", storeId: S1 }, { ...invite, store: { orgId: ACME, status: "deleted" } }), { kind: "refused", reason: "unknown_store" });
  const accept = {
    invitation: { orgId: ACME, role: "store-manager", scope: "self" as const, email: "m@example.com", invitedBy: "owner-1", expiresAt: new Date(Date.now() + 60_000), usedAt: null, revokedAt: null, storeId: S1 },
    now: new Date(), orgLive: true, orgAncestors: [], principalEmail: "m@example.com", inviterGrants: [grant("org-owner")], store,
  };
  assert.deepEqual(decideAccept(accept), { kind: "accept" });
  assert.deepEqual(decideAccept({ ...accept, store: { orgId: ACME, status: "deleted" } }), { kind: "invalid" }, "the store was removed after the invitation");
  assert.deepEqual(decideAccept({ ...accept, inviterGrants: [] }), { kind: "invalid" });
  assert.deepEqual(decideAccept({ ...accept, principalEmail: "x@example.com" }), { kind: "wrong_address" });
});

test("A4_INDEPENDENT a store grant gives no company right and a company role opens no store", () => {
  // Company checks read grants only; a store manager holds no grant on the company.
  assert.deepEqual(teamCatalogue([], ACME, []), []);
  assert.equal(mayManageStoreAccess([grant("recruiter")], ACME, []), false);
  // A recruiter of another company gets nothing from that grant on the store pages: only grant rows count.
  assert.equal(openManagedStore("manager-1", S2, [row({ storeId: S1, orgId: "beta" })]), undefined);
});
