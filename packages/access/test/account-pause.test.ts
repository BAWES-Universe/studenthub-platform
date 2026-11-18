import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountPauseService, decidePause, mayPauseAccount, parsePauseRequest, type HeldGrant, type PauseSnapshot } from "../src/index.js";

const grant = (role: string, orgId = "root", scope: "self" | "subtree" = "subtree"): HeldGrant => ({ orgId, role, scope });
const snapshot = (over: Partial<PauseSnapshot> = {}): PauseSnapshot => ({
  callerGrants: [grant("staff")], targetExists: true, targetGrants: [grant("recruiter", "acme", "self")], paused: false, ...over,
});
const pause = { targetPrincipalId: "person-1", action: "pause" as const, reason: "Reported for misuse" };

test("A6_RULES a pause or resume needs a person, an action and a 3 to 500 character reason", () => {
  assert.deepEqual(parsePauseRequest({ ...pause, reason: "  Reported for misuse  " }), pause);
  assert.equal(parsePauseRequest({ ...pause, action: "delete" }), undefined);
  assert.equal(parsePauseRequest({ ...pause, reason: "no" }), undefined);
  assert.equal(parsePauseRequest({ ...pause, reason: "x".repeat(501) }), undefined);
  assert.ok(parsePauseRequest({ ...pause, reason: "x".repeat(500) }));
  assert.ok(parsePauseRequest({ ...pause, reason: "تم الإيقاف مؤقتا" }), "Arabic is accepted");
  assert.equal(parsePauseRequest({ ...pause, reason: "bad\u0007bell" }), undefined);
  assert.equal(parsePauseRequest({ ...pause, targetPrincipalId: "has space" }), undefined);
});

test("A6_RULES operator staff pause people; only an operator admin pauses staff or admins; never oneself", () => {
  assert.deepEqual(decidePause("staff-1", pause, snapshot()), { kind: "apply" });
  assert.deepEqual(decidePause("person-1", pause, snapshot()), { kind: "refused", reason: "self_change" });
  assert.deepEqual(decidePause("owner-1", pause, snapshot({ callerGrants: [grant("org-owner", "acme")] })), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(decidePause("staff-1", pause, snapshot({ callerGrants: [grant("staff", "root", "self")] })), { kind: "refused", reason: "not_allowed" }, "staff at self scope do not administer access");
  assert.deepEqual(decidePause("staff-1", pause, snapshot({ targetGrants: [grant("staff")] })), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(decidePause("admin-1", pause, snapshot({ callerGrants: [grant("admin")], targetGrants: [grant("staff")] })), { kind: "apply" });
  assert.deepEqual(decidePause("staff-1", pause, snapshot({ targetExists: false })), { kind: "refused", reason: "unknown_person" });
  assert.deepEqual(decidePause("staff-1", pause, snapshot({ paused: true })), { kind: "refused", reason: "already_paused" });
  const resume = { ...pause, action: "resume" as const };
  assert.deepEqual(decidePause("staff-1", resume, snapshot()), { kind: "refused", reason: "not_paused" });
  assert.deepEqual(decidePause("staff-1", resume, snapshot({ paused: true })), { kind: "apply" });
  assert.deepEqual(decidePause("staff-1", resume, snapshot({ paused: true, targetGrants: [grant("admin")] })), { kind: "refused", reason: "not_allowed" }, "the suspended set decides on resume");
  assert.equal(mayPauseAccount("staff-1", "person-1", [grant("staff")], []), true);
  assert.equal(mayPauseAccount("staff-1", "staff-1", [grant("admin")], []), false);
});

test("A6_RULES the service hands the store the decision it re-runs on what it read", async () => {
  const seen: unknown[] = [];
  const service = createAccountPauseService({ store: { async apply(input) { seen.push(input.decide(snapshot())); return { kind: "paused", grants: 1, storeGrants: 0 }; } } });
  assert.deepEqual(await service.change("staff-1", pause), { kind: "paused", grants: 1, storeGrants: 0 });
  assert.deepEqual(seen, [{ kind: "apply" }]);
});
