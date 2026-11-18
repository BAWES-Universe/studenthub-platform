import assert from "node:assert/strict";
import { test } from "node:test";
import { STAFF_VIEW_SECONDS, mayViewAs, parseStaffViewRequest, viewOpen } from "../src/index.js";

const staff = [{ orgId: "root", role: "staff", scope: "subtree" }];
const admin = [{ orgId: "root", role: "admin", scope: "subtree" }];

test("A9_RULES operator staff view a person; only an admin views someone who works for StudentHub; never oneself", () => {
  assert.equal(mayViewAs("staff-1", "person-1", staff, []), true);
  assert.equal(mayViewAs("staff-1", "staff-1", staff, staff), false);
  assert.equal(mayViewAs("staff-1", "staff-2", staff, staff), false);
  assert.equal(mayViewAs("admin-1", "staff-2", admin, staff), true);
  assert.equal(mayViewAs("owner-1", "person-1", [{ orgId: "acme", role: "org-owner", scope: "subtree" }], []), false);
  assert.deepEqual(parseStaffViewRequest({ targetPrincipalId: "person-1", reason: " Support ticket 1234 " }), { targetPrincipalId: "person-1", reason: "Support ticket 1234" });
  assert.equal(parseStaffViewRequest({ targetPrincipalId: "person-1", reason: "no" }), undefined);
  assert.equal(parseStaffViewRequest({ targetPrincipalId: "person 1", reason: "Support ticket" }), undefined);
});

test("A9_WINDOW a view is open for exactly 15 minutes from its start", () => {
  const start = "2026-11-17T10:00:00.000Z", end = "2026-11-17T10:15:00.000Z";
  assert.equal(STAFF_VIEW_SECONDS, 900);
  assert.equal(viewOpen({ startedAt: start, expiresAt: end }, new Date("2026-11-17T10:00:00.000Z")), true);
  assert.equal(viewOpen({ startedAt: start, expiresAt: end }, new Date("2026-11-17T10:14:59.999Z")), true);
  assert.equal(viewOpen({ startedAt: start, expiresAt: end }, new Date("2026-11-17T10:15:00.000Z")), false);
  assert.equal(viewOpen({ startedAt: start, expiresAt: end }, new Date("2026-11-17T09:59:59.000Z")), false);
  assert.equal(viewOpen({ startedAt: start, expiresAt: "2026-11-17T11:00:00.000Z" }, new Date("2026-11-17T10:20:00.000Z")), false, "a longer window is never honoured");
});
