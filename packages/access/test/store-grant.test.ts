import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStoreGrantService,
  decideStoreGrant,
  issueStoreGrantToken,
  issueGrantToken,
  parseStoreGrant,
  verifyStoreGrantToken,
  type StoreGrantRequest,
  type StoreGrantSnapshot,
  type StoreGrantWriteStore,
} from "../src/index.js";

// Access lane G-02: store manager access given or taken away on the Access pages.

const OPS = ["root"];
const SECRET = Buffer.alloc(32, 9);
const ADMIN = "admin-1", STAFF = "staff-1", OWNER = "owner-1", PERSON = "person-1";
const STORE = "11111111-2222-4333-8444-555555555555";
const OTHER_STORE = "11111111-2222-4333-8444-666666666666";

type Held = { principalId: string; orgId: string; role: string; scope: "self" | "subtree" };

const parents: Record<string, string | null> = { root: null, acme: "root", other: "root" };
const ancestors = (orgId: string) => { const out: string[] = []; let at = parents[orgId] ?? null; while (at) { out.push(at); at = parents[at] ?? null; } return out; };
const storesOf: Record<string, { orgId: string; name: string; active: boolean }> = {
  [STORE]: { orgId: "acme", name: "Acme Salmiya", active: true },
  [OTHER_STORE]: { orgId: "other", name: "Other Hawally", active: true },
};
const baseGrants: Held[] = [
  { principalId: ADMIN, orgId: "root", role: "admin", scope: "subtree" },
  { principalId: STAFF, orgId: "root", role: "staff", scope: "subtree" },
  { principalId: OWNER, orgId: "acme", role: "org-owner", scope: "self" },
  { principalId: OWNER, orgId: "root", role: "admin", scope: "self" },
];

/** An in-memory store that behaves like the Postgres one: lock, re-read, decide, write, record the token. */
function memoryStore(initial: { grants?: Held[]; managers?: string[]; paused?: string[] } = {}) {
  const grants = [...(initial.grants ?? baseGrants)];
  const managers = new Set(initial.managers ?? []); // `${principal}\u0000${store}`
  const paused = new Set(initial.paused ?? []);
  const usedTokens = new Set<string>();
  const events: { action: string; actor: string; target: string; storeId: string; reason: string }[] = [];
  const snapshot = (callerId: string, request: StoreGrantRequest): StoreGrantSnapshot => {
    const store = storesOf[request.storeId];
    return {
      callerGrants: grants.filter((grant) => grant.principalId === callerId),
      targetExists: [ADMIN, STAFF, OWNER, PERSON].includes(request.targetPrincipalId),
      store: store && store.active ? { storeId: request.storeId, name: store.name, orgId: store.orgId, orgName: store.orgId.toUpperCase(), orgAncestors: ancestors(store.orgId) } : null,
      held: managers.has(`${request.targetPrincipalId}\u0000${request.storeId}`),
      paused: paused.has(request.targetPrincipalId),
    };
  };
  const store: StoreGrantWriteStore = {
    async storeSnapshot(callerId, request) { return snapshot(callerId, request); },
    async applyStore({ callerId, request, tokenId, expectedHeld, decide, expiresAt, now }) {
      if (usedTokens.has(tokenId)) return { kind: "refused", reason: "token_already_used" };
      const seen = snapshot(callerId, request);
      if (now() >= expiresAt) return { kind: "refused", reason: "token_expired" };
      if (seen.held !== expectedHeld) return { kind: "refused", reason: "state_changed" };
      const decision = decide(seen);
      if (decision.kind !== "apply") return decision;
      const key = `${request.targetPrincipalId}\u0000${request.storeId}`;
      if (decision.after) managers.add(key); else managers.delete(key);
      usedTokens.add(tokenId);
      events.push({ action: request.action, actor: callerId, target: request.targetPrincipalId, storeId: request.storeId, reason: request.reason });
      return { kind: "applied", before: decision.before, after: decision.after };
    },
  };
  return { store, grants, managers, paused, events };
}

const request = (over: Partial<StoreGrantRequest> = {}): StoreGrantRequest =>
  ({ targetPrincipalId: PERSON, storeId: STORE, action: "grant", reason: "Runs the Salmiya branch", ...over });

function service(world: ReturnType<typeof memoryStore>, clock = { at: Date.parse("2026-11-27T08:00:00Z") }) {
  return createStoreGrantService({ store: world.store, secret: SECRET, operatorOrgIds: OPS, now: () => new Date(clock.at) });
}

test("G02_STORE_CONFIRM a preview writes nothing and the confirm applies exactly the reviewed change", async () => {
  const world = memoryStore();
  const svc = service(world);
  const preview = await svc.preview(ADMIN, request());
  assert.ok(preview.ok && preview.kind === "change");
  assert.equal(preview.before, false);
  assert.equal(preview.after, true);
  assert.equal(preview.store.name, "Acme Salmiya");
  assert.equal(world.managers.size, 0, "a preview writes nothing");
  assert.equal(world.events.length, 0);
  assert.deepEqual(await svc.confirm(ADMIN, request(), preview.token), { kind: "applied", before: false, after: true });
  assert.ok(world.managers.has(`${PERSON}\u0000${STORE}`));
  assert.deepEqual(world.events, [{ action: "grant", actor: ADMIN, target: PERSON, storeId: STORE, reason: "Runs the Salmiya branch" }]);

  const revoke = request({ action: "revoke", reason: "Moved to another branch" });
  const second = await svc.preview(ADMIN, revoke);
  assert.ok(second.ok && second.kind === "change");
  assert.equal(second.before, true);
  assert.equal(second.after, false);
  assert.deepEqual(await svc.confirm(ADMIN, revoke, second.token), { kind: "applied", before: true, after: false });
  assert.equal(world.managers.size, 0);
  assert.equal(world.events.length, 2);
});

test("G02_STORE_CONFIRM a replayed, altered, foreign, cross-domain or expired token is refused and changes nothing", async () => {
  const clock = { at: Date.parse("2026-11-27T08:00:00Z") };
  const world = memoryStore();
  const svc = service(world, clock);
  const preview = await svc.preview(ADMIN, request());
  assert.ok(preview.ok && preview.kind === "change");
  // Altered: another store, another reason, another action, another person.
  for (const altered of [request({ storeId: OTHER_STORE }), request({ reason: "Something else entirely" }), request({ action: "revoke" }), request({ targetPrincipalId: STAFF })]) {
    assert.deepEqual(await svc.confirm(ADMIN, altered, preview.token), { kind: "refused", reason: "token_invalid" });
  }
  // Foreign: another caller presents the admin's token.
  assert.deepEqual(await svc.confirm(STAFF, request(), preview.token), { kind: "refused", reason: "token_invalid" });
  // A forged mac, and a role-change token for the same fields, never verify.
  assert.deepEqual(await svc.confirm(ADMIN, request(), { ...preview.token, mac: "0".repeat(64) }), { kind: "refused", reason: "token_invalid" });
  const roleToken = issueGrantToken({ secret: SECRET, callerId: ADMIN, request: { targetPrincipalId: PERSON, orgId: "acme", role: "store-manager", scope: "self", action: "grant", reason: "Runs the Salmiya branch" } as never, before: null, now: new Date(clock.at) });
  assert.deepEqual(await svc.confirm(ADMIN, request(), roleToken), { kind: "refused", reason: "token_invalid" });
  assert.equal(world.events.length, 0);
  // Replayed: the first confirm applies, the second is refused.
  assert.equal((await svc.confirm(ADMIN, request(), preview.token)).kind, "applied");
  assert.deepEqual(await svc.confirm(ADMIN, request(), preview.token), { kind: "refused", reason: "token_already_used" });
  // Expired: 15 minutes later.
  const revoke = request({ action: "revoke" });
  const late = await svc.preview(ADMIN, revoke);
  assert.ok(late.ok && late.kind === "change");
  clock.at += 15 * 60 * 1000;
  assert.deepEqual(await svc.confirm(ADMIN, revoke, late.token), { kind: "refused", reason: "token_expired" });
  assert.equal(world.events.length, 1);
  // The token itself expires, before any store is asked.
  assert.deepEqual(verifyStoreGrantToken({ secret: SECRET, token: late.token, callerId: ADMIN, request: revoke, now: new Date(clock.at) }), { ok: false, reason: "token_expired" });
  assert.deepEqual(verifyStoreGrantToken({ secret: SECRET, token: late.token, callerId: ADMIN, request: revoke, now: new Date(clock.at - 1) }), { ok: true, held: true });
});

test("G02_STORE_CONFIRM a change between preview and confirm is refused as state_changed", async () => {
  const world = memoryStore();
  const svc = service(world);
  const preview = await svc.preview(ADMIN, request());
  assert.ok(preview.ok && preview.kind === "change");
  world.managers.add(`${PERSON}\u0000${STORE}`); // given on the team page meanwhile
  assert.deepEqual(await svc.confirm(ADMIN, request(), preview.token), { kind: "refused", reason: "state_changed" });
  assert.equal(world.events.length, 0);
});

test("G02_STORE_GUARDS who may change store access, and on which store", async () => {
  const world = memoryStore({ grants: [...baseGrants,
    { principalId: "owner-only", orgId: "acme", role: "org-owner", scope: "self" },
    { principalId: "recruiter-1", orgId: "root", role: "recruiter", scope: "subtree" },
    { principalId: "root-admin", orgId: "root", role: "admin", scope: "self" },
    { principalId: "root-staff", orgId: "root", role: "staff", scope: "self" }] });
  const svc = service(world);
  // Self change is refused first, even for an admin.
  assert.deepEqual(await svc.preview(ADMIN, request({ targetPrincipalId: ADMIN })), { ok: false, reason: "self_change" });
  // A company owner who can't open the Access pages uses the team page instead.
  assert.deepEqual(await svc.preview("owner-only", request()), { ok: false, reason: "not_allowed" });
  // A recruiter can't open the Access pages at all.
  assert.deepEqual(await svc.preview("recruiter-1", request()), { ok: false, reason: "not_allowed" });
  // Staff on the operator itself only can't open the Access pages.
  assert.deepEqual(await svc.preview("root-staff", request()), { ok: false, reason: "not_allowed" });
  // An admin on the operator itself only opens the Access pages but doesn't cover a company below.
  assert.deepEqual(await svc.preview("root-admin", request()), { ok: false, reason: "not_allowed" });
  // Staff over the operator and its companies covers both stores.
  assert.ok((await svc.preview(STAFF, request())).ok);
  assert.ok((await svc.preview(STAFF, request({ storeId: OTHER_STORE }))).ok);
  // The same operator admin who also owns Acme: Acme's store, not Other's.
  const own = await svc.preview(OWNER, request());
  assert.ok(own.ok && own.kind === "change");
  assert.deepEqual(await svc.preview(OWNER, request({ storeId: OTHER_STORE })), { ok: false, reason: "not_allowed" });
  // The admin covers both companies.
  assert.ok((await svc.preview(ADMIN, request({ storeId: OTHER_STORE }))).ok);
  // Unknown person, unknown or removed store.
  assert.deepEqual(await svc.preview(ADMIN, request({ targetPrincipalId: "ghost" })), { ok: false, reason: "unknown_person" });
  assert.deepEqual(await svc.preview(ADMIN, request({ storeId: "11111111-2222-4333-8444-777777777777" })), { ok: false, reason: "unknown_store" });
  assert.equal(world.events.length, 0);
});

test("G02_STORE_GUARDS a grant already held is a no-op, a revoke not held is refused, and nothing is given while paused", async () => {
  const world = memoryStore({ managers: [`${PERSON}\u0000${STORE}`], paused: [STAFF] });
  const svc = service(world);
  const same = await svc.preview(ADMIN, request());
  assert.ok(same.ok && same.kind === "unchanged");
  assert.ok(!("token" in same), "an unchanged preview issues no token");
  assert.deepEqual(await svc.preview(ADMIN, request({ storeId: OTHER_STORE, action: "revoke" })), { ok: false, reason: "not_held" });
  assert.deepEqual(await svc.preview(ADMIN, request({ targetPrincipalId: STAFF })), { ok: false, reason: "paused" });
  assert.equal(world.events.length, 0);
});

test("G02_STORE_GUARDS the decision checks hold on their own", () => {
  const snapshot: StoreGrantSnapshot = {
    callerGrants: [{ orgId: "root", role: "admin", scope: "subtree" }], targetExists: true,
    store: { storeId: STORE, name: "S", orgId: "acme", orgName: "Acme", orgAncestors: ["root"] }, held: false, paused: false,
  };
  assert.deepEqual(decideStoreGrant(ADMIN, request(), snapshot, OPS), { kind: "apply", before: false, after: true });
  assert.deepEqual(decideStoreGrant(PERSON, request(), snapshot, OPS), { kind: "refused", reason: "self_change" });
  assert.deepEqual(decideStoreGrant(ADMIN, request(), { ...snapshot, store: { ...snapshot.store!, orgAncestors: [] } }, OPS), { kind: "refused", reason: "not_allowed" });
  assert.deepEqual(decideStoreGrant(ADMIN, request(), { ...snapshot, paused: true }, OPS), { kind: "refused", reason: "paused" });
  assert.deepEqual(decideStoreGrant(ADMIN, request({ action: "revoke" }), { ...snapshot, held: true, paused: true }, OPS), { kind: "apply", before: true, after: false },
    "taking access away is still allowed while paused");
  assert.deepEqual(decideStoreGrant(ADMIN, request(), { ...snapshot, targetExists: false }, OPS), { kind: "refused", reason: "unknown_person" });
});

test("G02_STORE_PARSE store change requests are validated", () => {
  const ok = { targetPrincipalId: PERSON, storeId: STORE, action: "grant", reason: "  Runs the branch\r\n" };
  assert.deepEqual(parseStoreGrant(ok), { targetPrincipalId: PERSON, storeId: STORE, action: "grant", reason: "Runs the branch" });
  assert.equal(parseStoreGrant({ ...ok, storeId: "not-a-uuid" }), undefined);
  assert.equal(parseStoreGrant({ ...ok, storeId: "ABCDEF01-2222-4333-8444-555555555555" }), undefined);
  assert.equal(parseStoreGrant({ ...ok, action: "widen" }), undefined);
  assert.equal(parseStoreGrant({ ...ok, reason: "no" }), undefined);
  assert.equal(parseStoreGrant({ ...ok, reason: "x".repeat(501) }), undefined);
  assert.equal(parseStoreGrant({ ...ok, reason: "bad\u0007bell" }), undefined);
  assert.equal(parseStoreGrant({ ...ok, targetPrincipalId: "a b" }), undefined);
  // A token verifies only for the store change it was issued for.
  const now = new Date("2026-11-27T08:00:00Z");
  const token = issueStoreGrantToken({ secret: SECRET, callerId: ADMIN, request: request(), held: true, now });
  assert.deepEqual(verifyStoreGrantToken({ secret: SECRET, token, callerId: ADMIN, request: request(), now }), { ok: true, held: true });
  assert.deepEqual(verifyStoreGrantToken({ secret: SECRET, token: { ...token, before: "none" }, callerId: ADMIN, request: request(), now }), { ok: false, reason: "token_invalid" });
});
