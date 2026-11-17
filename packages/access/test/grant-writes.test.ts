import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAccessGrantService,
  decideGrantChange,
  parseGrantChange,
  parseGrantToken,
  parsePeopleQuery,
  type AccessGrantWriteStore,
  type GrantChangeRequest,
  type GrantSnapshot,
} from "../src/index.js";

const OPS = ["root"];
const SECRET = Buffer.alloc(32, 7);
const ADMIN = "admin-1", STAFF = "staff-1", PERSON = "person-1";

type Held = { principalId: string; orgId: string; role: string; scope: "self" | "subtree" };

/** An in-memory store that behaves like the Postgres one: lock, re-read, decide, write, record the token. */
function memoryStore(initial: Held[]) {
  const grants = [...initial];
  const usedTokens = new Set<string>();
  const events: { action: string; actor: string; target: string; role: string; orgId: string; reason: string }[] = [];
  const parents: Record<string, string | null> = { root: null, acme: "root", "acme-kw": "acme", other: "root" };
  const ancestors = (orgId: string) => { const out: string[] = []; let at = parents[orgId] ?? null; while (at) { out.push(at); at = parents[at] ?? null; } return out; };
  const snapshot = (callerId: string, request: GrantChangeRequest): GrantSnapshot => ({
    callerGrants: grants.filter((grant) => grant.principalId === callerId),
    targetExists: [ADMIN, STAFF, PERSON, "admin-2"].includes(request.targetPrincipalId),
    orgLive: request.orgId in parents,
    orgAncestors: ancestors(request.orgId),
    current: grants.find((grant) => grant.principalId === request.targetPrincipalId && grant.orgId === request.orgId && grant.role === request.role)?.scope ?? null,
    adminCount: grants.filter((grant) => grant.orgId === request.orgId && grant.role === "admin").length,
  });
  const store: AccessGrantWriteStore = {
    async snapshot(callerId, request) { return snapshot(callerId, request); },
    async apply({ callerId, request, tokenId, expectedBefore, decide }) {
      if (usedTokens.has(tokenId)) return { kind: "refused", reason: "token_already_used" };
      const seen = snapshot(callerId, request);
      if (seen.current !== expectedBefore) return { kind: "refused", reason: "state_changed" };
      const decision = decide(seen);
      if (decision.kind !== "apply") return decision;
      const at = grants.findIndex((grant) => grant.principalId === request.targetPrincipalId && grant.orgId === request.orgId && grant.role === request.role);
      if (decision.after === null) grants.splice(at, 1);
      else if (at >= 0) grants[at] = { ...grants[at]!, scope: decision.after };
      else grants.push({ principalId: request.targetPrincipalId, orgId: request.orgId, role: request.role, scope: decision.after });
      usedTokens.add(tokenId);
      events.push({ action: decision.after === null ? "revoke" : "grant", actor: callerId, target: request.targetPrincipalId, role: request.role, orgId: request.orgId, reason: request.reason });
      return { kind: "applied", before: decision.before, after: decision.after };
    },
  };
  return { store, grants, events };
}

const operators = (): Held[] => [
  { principalId: ADMIN, orgId: "root", role: "admin", scope: "subtree" },
  { principalId: STAFF, orgId: "root", role: "staff", scope: "subtree" },
];

const change = (over: Partial<GrantChangeRequest> = {}): GrantChangeRequest => ({
  targetPrincipalId: PERSON, orgId: "acme", role: "recruiter", scope: "self", action: "grant", reason: "Joined the hiring team", ...over,
});

function service(store: AccessGrantWriteStore, now = () => new Date("2026-11-17T10:00:00Z")) {
  return createAccessGrantService({ store, secret: SECRET, now, operatorOrgIds: OPS, entropy: (n) => Buffer.alloc(n, Math.floor(Math.random() * 255)) });
}

test("A1_PREVIEW_CONFIRM a preview writes nothing and the confirm applies exactly the reviewed change", async () => {
  const memory = memoryStore(operators());
  const writes = service(memory.store);
  const preview = await writes.preview(STAFF, change());
  assert.equal(preview.ok && preview.kind, "change");
  assert.equal(memory.grants.length, 2, "a preview changes nothing");
  assert.equal(memory.events.length, 0, "a preview records nothing");
  if (!preview.ok || preview.kind !== "change") throw new Error("expected a change");
  assert.deepEqual(await writes.confirm(STAFF, change(), preview.token), { kind: "applied", before: null, after: "self" });
  assert.ok(memory.grants.some((grant) => grant.principalId === PERSON && grant.role === "recruiter" && grant.orgId === "acme"));
  assert.deepEqual(memory.events.map((event) => [event.action, event.actor, event.reason]), [["grant", STAFF, "Joined the hiring team"]]);
});

test("A1_PREVIEW_CONFIRM a replayed, altered, foreign or expired token is refused and changes nothing", async () => {
  let now = new Date("2026-11-17T10:00:00Z");
  const memory = memoryStore(operators());
  const writes = service(memory.store, () => now);
  const preview = await writes.preview(ADMIN, change());
  if (!preview.ok || preview.kind !== "change") throw new Error("expected a change");
  const token = preview.token;
  // Altered change: another role, another scope, another reason, another person.
  for (const altered of [change({ role: "finance" }), change({ scope: "subtree" }), change({ reason: "Something else" }), change({ targetPrincipalId: STAFF })]) {
    assert.deepEqual(await writes.confirm(ADMIN, altered, token), { kind: "refused", reason: "token_invalid" });
  }
  // Altered token fields.
  assert.deepEqual(await writes.confirm(ADMIN, change(), { ...token, expiresAt: "2099-01-01T00:00:00.000Z" }), { kind: "refused", reason: "token_invalid" });
  assert.deepEqual(await writes.confirm(ADMIN, change(), { ...token, before: "self" }), { kind: "refused", reason: "token_invalid" });
  // Another caller cannot spend it.
  assert.deepEqual(await writes.confirm(STAFF, change(), token), { kind: "refused", reason: "token_invalid" });
  assert.equal(memory.events.length, 0);
  // Expired after 15 minutes.
  now = new Date("2026-11-17T10:15:00Z");
  assert.deepEqual(await writes.confirm(ADMIN, change(), token), { kind: "refused", reason: "token_expired" });
  now = new Date("2026-11-17T10:14:59Z");
  assert.deepEqual(await writes.confirm(ADMIN, change(), token), { kind: "applied", before: null, after: "self" });
  // Replayed.
  assert.deepEqual(await writes.confirm(ADMIN, change(), token), { kind: "refused", reason: "token_already_used" });
  assert.equal(memory.events.length, 1);
});

test("A1_PREVIEW_CONFIRM a change between preview and confirm is refused as state_changed", async () => {
  const memory = memoryStore(operators());
  const writes = service(memory.store);
  const preview = await writes.preview(ADMIN, change());
  if (!preview.ok || preview.kind !== "change") throw new Error("expected a change");
  memory.grants.push({ principalId: PERSON, orgId: "acme", role: "recruiter", scope: "subtree" });
  assert.deepEqual(await writes.confirm(ADMIN, change(), preview.token), { kind: "refused", reason: "state_changed" });
  assert.equal(memory.events.length, 0);
});

test("A1_PREVIEW_CONFIRM tokens parse only in their exact shape", () => {
  const good = { tokenId: "a".repeat(64), callerRef: "b".repeat(64), changeDigest: "c".repeat(64), before: "none", issuedAt: "2026-11-17T10:00:00.000Z", expiresAt: "2026-11-17T10:15:00.000Z", mac: "d".repeat(64) };
  assert.ok(parseGrantToken(good));
  assert.equal(parseGrantToken({ ...good, before: "everything" }), undefined);
  assert.equal(parseGrantToken({ ...good, mac: "zz" }), undefined);
  assert.equal(parseGrantToken({ ...good, tokenId: undefined }), undefined);
});

test("A1_GUARDS no self change, no grant outside the catalogue, no removal of the last admin", async () => {
  const memory = memoryStore(operators());
  const writes = service(memory.store);
  assert.deepEqual(await writes.preview(ADMIN, change({ targetPrincipalId: ADMIN, orgId: "root", role: "finance" })), { ok: false, reason: "self_change" });
  assert.deepEqual(await writes.preview(ADMIN, change({ targetPrincipalId: ADMIN, orgId: "root", role: "admin", scope: "subtree" })), { ok: false, reason: "self_change" });
  assert.deepEqual(await writes.preview(STAFF, change({ targetPrincipalId: STAFF, role: "org-owner" })), { ok: false, reason: "self_change" });
  // Staff cannot give operator roles, nor subtree on a company.
  assert.deepEqual(await writes.preview(STAFF, change({ orgId: "root", role: "staff" })), { ok: false, reason: "not_allowed" });
  assert.deepEqual(await writes.preview(STAFF, change({ scope: "subtree" })), { ok: false, reason: "not_allowed" });
  // Candidate is never grantable; company roles are not given on the operator org.
  assert.deepEqual(await writes.preview(ADMIN, change({ role: "candidate" })), { ok: false, reason: "not_allowed" });
  assert.deepEqual(await writes.preview(ADMIN, change({ orgId: "root", role: "org-owner" })), { ok: false, reason: "not_allowed" });
  // A recruiter grants nothing.
  memory.grants.push({ principalId: "admin-2", orgId: "acme", role: "recruiter", scope: "subtree" });
  assert.deepEqual(await writes.preview("admin-2", change()), { ok: false, reason: "not_allowed" });
  // The last admin of the operator organization stays.
  memory.grants.splice(memory.grants.findIndex((grant) => grant.principalId === "admin-2"), 1);
  memory.grants.push({ principalId: PERSON, orgId: "root", role: "admin", scope: "self" });
  const removeSecond = await writes.preview(ADMIN, change({ orgId: "root", role: "admin", action: "revoke" }));
  assert.equal(removeSecond.ok, true, "two admins: one may go");
  memory.grants.splice(memory.grants.findIndex((grant) => grant.principalId === ADMIN && grant.role === "admin"), 1);
  memory.grants.push({ principalId: "admin-2", orgId: "root", role: "admin", scope: "subtree" });
  memory.grants.splice(memory.grants.findIndex((grant) => grant.principalId === PERSON && grant.role === "admin"), 1);
  assert.deepEqual(await writes.preview("admin-2", change({ targetPrincipalId: ADMIN, orgId: "root", role: "admin", action: "revoke" })), { ok: false, reason: "not_held" });
  memory.grants.push({ principalId: PERSON, orgId: "root", role: "admin", scope: "self" });
  memory.grants.splice(memory.grants.findIndex((grant) => grant.principalId === "admin-2"), 1);
  memory.grants.push({ principalId: "admin-2", orgId: "acme", role: "admin", scope: "subtree" });
  // admin-2 holds no admin on root now: it may not take the last root admin away either way.
  assert.deepEqual(await writes.preview("admin-2", change({ orgId: "root", role: "admin", action: "revoke" })), { ok: false, reason: "not_allowed" });
  assert.equal(memory.events.length, 0);
});

test("A1_GUARDS last-admin and self checks hold in the decision itself", () => {
  const snapshot: GrantSnapshot = { callerGrants: [{ orgId: "root", role: "admin", scope: "subtree" }], targetExists: true, orgLive: true, orgAncestors: [], current: "self", adminCount: 1 };
  assert.deepEqual(decideGrantChange(ADMIN, change({ orgId: "root", role: "admin", action: "revoke" }), snapshot, OPS), { kind: "refused", reason: "last_admin" });
  assert.deepEqual(decideGrantChange(ADMIN, change({ orgId: "root", role: "admin", action: "revoke" }), { ...snapshot, adminCount: 2 }, OPS), { kind: "apply", before: "self", after: null });
  assert.deepEqual(decideGrantChange(ADMIN, change({ targetPrincipalId: ADMIN }), snapshot, OPS), { kind: "refused", reason: "self_change" });
  assert.deepEqual(decideGrantChange(ADMIN, change(), { ...snapshot, targetExists: false }, OPS), { kind: "refused", reason: "unknown_person" });
  assert.deepEqual(decideGrantChange(ADMIN, change(), { ...snapshot, orgLive: false }, OPS), { kind: "refused", reason: "unknown_organization" });
});

test("A1_GUARDS a grant already held at that scope or wider is a no-op that records nothing", async () => {
  const memory = memoryStore([...operators(), { principalId: PERSON, orgId: "acme", role: "recruiter", scope: "subtree" }]);
  const writes = service(memory.store);
  assert.deepEqual(await writes.preview(ADMIN, change()), { ok: true, kind: "unchanged", current: "subtree" });
  assert.deepEqual(await writes.preview(ADMIN, change({ scope: "subtree" })), { ok: true, kind: "unchanged", current: "subtree" });
  // Widening self to subtree is a change.
  const narrow = memoryStore([...operators(), { principalId: PERSON, orgId: "acme", role: "recruiter", scope: "self" }]);
  const widened = await service(narrow.store).preview(ADMIN, change({ scope: "subtree" }));
  assert.equal(widened.ok && widened.kind === "change" && widened.before, "self");
  assert.equal(memory.events.length + narrow.events.length, 0);
});

test("A1_GUARDS change requests and people lookups are validated", () => {
  const raw = { targetPrincipalId: PERSON, orgId: "acme", role: "recruiter", scope: "self", action: "grant", reason: "  Joined  " };
  assert.deepEqual(parseGrantChange(raw), { ...raw, reason: "Joined" });
  assert.equal(parseGrantChange({ ...raw, reason: "ok" }), undefined, "reason under 3 characters");
  assert.equal(parseGrantChange({ ...raw, reason: "x".repeat(501) }), undefined, "reason over 500 characters");
  assert.ok(parseGrantChange({ ...raw, reason: "x".repeat(500) }));
  assert.equal(parseGrantChange({ ...raw, role: "owner" }), undefined);
  assert.equal(parseGrantChange({ ...raw, scope: "store" }), undefined);
  assert.equal(parseGrantChange({ ...raw, action: "delete" }), undefined);
  assert.equal(parseGrantChange({ ...raw, orgId: "a b" }), undefined);
  assert.equal(parseGrantChange({ ...raw, reason: "bell\u0007 rings" }), undefined);
  assert.deepEqual(parsePeopleQuery(" Dana@Example.COM "), { kind: "email", value: "dana@example.com" });
  assert.deepEqual(parsePeopleQuery("Dan"), { kind: "name", value: "Dan" });
  assert.equal(parsePeopleQuery("Da"), undefined);
  assert.equal(parsePeopleQuery(null), undefined);
});
