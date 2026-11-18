import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PENDING_INVITATIONS,
  createCompanyTeamService,
  decideAccept,
  decideInvite,
  decideRemove,
  emailMatches,
  hashInvitationToken,
  isInvitationTokenShape,
  newInvitationToken,
  normalizeInvitationEmail,
  recordingInvitationMailer,
  teamCatalogue,
  teamReadOnly,
  type AcceptSnapshot,
  type HeldGrant,
  type InvitationStore,
} from "../src/index.js";

const ACME = "acme", PARENT = "group";
const owner = (scope: "self" | "subtree" = "self", orgId = ACME): HeldGrant => ({ orgId, role: "org-owner", scope });
const NOW = new Date("2026-11-17T10:00:00Z");

function acceptSnapshot(over: Omit<Partial<AcceptSnapshot>, "invitation"> & { invitation?: Partial<NonNullable<AcceptSnapshot["invitation"]>> | null } = {}): AcceptSnapshot {
  const { invitation, ...rest } = over;
  return {
    invitation: invitation === null ? null : { orgId: ACME, role: "recruiter", scope: "self", email: "sara@example.com", invitedBy: "owner-1", expiresAt: new Date(NOW.getTime() + 1000), usedAt: null, revokedAt: null, ...invitation },
    now: NOW, orgLive: true, orgAncestors: [PARENT], principalEmail: " Sara@Example.com ", inviterGrants: [owner()],
    ...rest,
  };
}

test("A2_CATALOGUE an owner gives org-owner, recruiter and finance, subtree only from a subtree grant", () => {
  assert.deepEqual(teamCatalogue([owner()], ACME, [PARENT]).map((option) => [option.role, option.scopes]),
    [["org-owner", ["self"]], ["recruiter", ["self"]], ["finance", ["self"]]]);
  assert.deepEqual(teamCatalogue([owner("subtree", PARENT)], ACME, [PARENT])[0]!.scopes, ["self", "subtree"]);
  assert.deepEqual(teamCatalogue([owner("self", PARENT)], ACME, [PARENT]), [], "a self grant on a parent does not reach the child");
  assert.deepEqual(teamCatalogue([{ orgId: ACME, role: "recruiter", scope: "subtree" }], ACME, []), []);
  assert.equal(teamReadOnly([{ orgId: "root", role: "staff", scope: "subtree" }], ACME, ["root"]), true);
  assert.equal(teamReadOnly([{ orgId: ACME, role: "recruiter", scope: "self" }], ACME, []), false);
});

test("A2_TOKEN 32 random bytes as 43 characters; only a domain-separated SHA-256 hex is stored", () => {
  const { token, tokenHash } = newInvitationToken(() => Buffer.alloc(32, 1));
  assert.equal(token.length, 43);
  assert.equal(isInvitationTokenShape(token), true);
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(hashInvitationToken(token), tokenHash);
  assert.notEqual(newInvitationToken().token, newInvitationToken().token);
  assert.equal(isInvitationTokenShape(`${token}x`), false);
  assert.equal(isInvitationTokenShape("../../etc/passwd"), false);
});

test("A2_INVITE addresses normalize; role, scope, duplicates and the 50 cap are refused with typed reasons", () => {
  assert.equal(normalizeInvitationEmail("  Sara@Example.COM "), "sara@example.com");
  for (const bad of ["", "sara", "sara@", "@example.com", "a b@example.com", "sara@example", `${"a".repeat(65)}@example.com`, 5]) {
    assert.equal(normalizeInvitationEmail(bad), undefined, String(bad));
  }
  const snapshot = { callerGrants: [owner()], orgLive: true, orgAncestors: [], pendingCount: 0, duplicatePending: false };
  assert.deepEqual(decideInvite(ACME, { role: "recruiter", scope: "self" }, snapshot), { kind: "ok" });
  assert.deepEqual(decideInvite(ACME, { role: "recruiter", scope: "subtree" }, snapshot), { kind: "refused", reason: "role_not_allowed" });
  assert.deepEqual(decideInvite(ACME, { role: "admin", scope: "self" }, snapshot), { kind: "refused", reason: "role_not_allowed" });
  assert.deepEqual(decideInvite(ACME, { role: "member", scope: "self" }, snapshot), { kind: "refused", reason: "role_not_allowed" });
  assert.deepEqual(decideInvite(ACME, { role: "recruiter", scope: "self" }, { ...snapshot, callerGrants: [] }), { kind: "refused", reason: "not_owner" });
  assert.deepEqual(decideInvite(ACME, { role: "recruiter", scope: "self" }, { ...snapshot, orgLive: false }), { kind: "refused", reason: "unknown_organization" });
  assert.deepEqual(decideInvite(ACME, { role: "recruiter", scope: "self" }, { ...snapshot, duplicatePending: true }), { kind: "refused", reason: "duplicate_invitation" });
  assert.deepEqual(decideInvite(ACME, { role: "recruiter", scope: "self" }, { ...snapshot, pendingCount: MAX_PENDING_INVITATIONS - 1 }), { kind: "ok" });
  assert.deepEqual(decideInvite(ACME, { role: "recruiter", scope: "self" }, { ...snapshot, pendingCount: MAX_PENDING_INVITATIONS }), { kind: "refused", reason: "too_many_invitations" });
});

test("A2_MATCH acceptance needs the signed-in principal's current email; a dead link is one answer", () => {
  assert.deepEqual(decideAccept(acceptSnapshot()), { kind: "accept" });
  assert.deepEqual(decideAccept(acceptSnapshot({ principalEmail: "other@example.com" })), { kind: "wrong_address" });
  assert.deepEqual(decideAccept(acceptSnapshot({ principalEmail: null })), { kind: "wrong_address" });
  assert.equal(emailMatches("sara@example.co", "sara@example.com"), false);
  // Dead before address: a probe with the wrong account learns nothing more than "no longer valid".
  assert.deepEqual(decideAccept(acceptSnapshot({ invitation: { expiresAt: NOW }, principalEmail: "other@example.com" })), { kind: "invalid" });
  assert.deepEqual(decideAccept(acceptSnapshot({ invitation: null })), { kind: "invalid" });
  assert.deepEqual(decideAccept(acceptSnapshot({ orgLive: false })), { kind: "invalid" });
  assert.deepEqual(decideAccept(acceptSnapshot({ inviterGrants: [] })), { kind: "invalid" }, "the inviter lost the right");
  assert.deepEqual(decideAccept(acceptSnapshot({ inviterGrants: [owner("self", PARENT)] })), { kind: "invalid" });
});

test("A2_REPLAY a used, revoked or expired invitation is invalid", () => {
  assert.deepEqual(decideAccept(acceptSnapshot({ invitation: { usedAt: NOW } })), { kind: "invalid" });
  assert.deepEqual(decideAccept(acceptSnapshot({ invitation: { revokedAt: NOW } })), { kind: "invalid" });
  assert.deepEqual(decideAccept(acceptSnapshot({ invitation: { expiresAt: new Date(NOW.getTime() - 1) } })), { kind: "invalid" });
});

test("A2_REMOVE an owner removes a member's grants here; the last owner stays", () => {
  const base = { callerGrants: [owner()], orgLive: true, orgAncestors: [], ownerCount: 2 };
  assert.deepEqual(decideRemove(ACME, { ...base, targetGrants: [{ role: "recruiter", scope: "self" }, { role: "finance", scope: "self" }] }),
    { kind: "remove", roles: ["recruiter", "finance"] });
  assert.deepEqual(decideRemove(ACME, { ...base, targetGrants: [{ role: "org-owner", scope: "self" }] }), { kind: "remove", roles: ["org-owner"] });
  assert.deepEqual(decideRemove(ACME, { ...base, ownerCount: 1, targetGrants: [{ role: "org-owner", scope: "self" }] }), { kind: "refused", reason: "last_owner" });
  assert.deepEqual(decideRemove(ACME, { ...base, ownerCount: 1, targetGrants: [{ role: "recruiter", scope: "self" }] }), { kind: "remove", roles: ["recruiter"] });
  assert.deepEqual(decideRemove(ACME, { ...base, targetGrants: [] }), { kind: "refused", reason: "not_found" });
  assert.deepEqual(decideRemove(ACME, { ...base, callerGrants: [{ orgId: ACME, role: "recruiter", scope: "self" }], targetGrants: [{ role: "recruiter", scope: "self" }] }), { kind: "refused", reason: "not_owner" });
  assert.deepEqual(decideRemove(ACME, { ...base, orgLive: false, targetGrants: [{ role: "recruiter", scope: "self" }] }), { kind: "refused", reason: "unknown_organization" });
});

test("A2_SERVICE invite shows the link once, hands it to the mailer, and stores only the hash", async () => {
  const stored: { tokenHash: string; email: string }[] = [];
  const store = {
    async context() { return { callerGrants: [owner()], organization: { orgId: ACME, name: "Acme", ancestors: [] } }; },
    async team() { return { members: [], invitations: [] }; },
    async invitation() { return null; },
    async invite(input: Parameters<InvitationStore["invite"]>[0]) {
      const decision = input.decide({ callerGrants: [owner()], orgLive: true, orgAncestors: [], pendingCount: 0, duplicatePending: false });
      if (decision.kind === "refused") return decision;
      stored.push({ tokenHash: input.tokenHash, email: input.email });
      return { kind: "invited" as const, id: "11111111-1111-4111-8111-111111111111", expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString() };
    },
    async revokeInvitation() { return { kind: "revoked" as const }; },
    async accept() { return { kind: "invalid" as const }; },
    async removeMember() { return { kind: "removed" as const, roles: [] }; },
  } as unknown as InvitationStore;
  const mailer = recordingInvitationMailer();
  const service = createCompanyTeamService({ store, mailer, now: () => NOW, entropy: () => Buffer.alloc(32, 2) });
  const result = await service.invite("owner-1", ACME, { email: " Sara@Example.com", role: "recruiter", scope: "self" }, "https://hub.example");
  if (result.kind !== "invited") throw new Error(JSON.stringify(result));
  const token = Buffer.alloc(32, 2).toString("base64url");
  assert.equal(result.link, `https://hub.example/invitations/${token}`);
  assert.equal(result.expiresAt, "2026-11-24T10:00:00.000Z");
  assert.deepEqual(stored, [{ tokenHash: hashInvitationToken(token), email: "sara@example.com" }]);
  assert.equal(JSON.stringify(stored).includes(token), false, "the token itself is never stored");
  assert.deepEqual(mailer.sent, [{ to: "sara@example.com", organizationName: "Acme", role: "recruiter", link: result.link, expiresAt: result.expiresAt }]);
  assert.deepEqual(await service.invite("owner-1", ACME, { email: "nope", role: "recruiter", scope: "self" }, "https://hub.example"), { kind: "refused", reason: "invalid_email" });
  assert.equal(await service.invitation("short"), null);
  assert.deepEqual(await service.accept("short", "p"), { kind: "invalid" });
});

test("A2_SERVICE a saved invitation still returns its link when the mail lookup fails", async () => {
  const store = {
    async context() { throw new Error("database went away"); },
    async invite(input: Parameters<InvitationStore["invite"]>[0]) {
      return { kind: "invited" as const, id: "11111111-1111-4111-8111-111111111111", expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString() };
    },
  } as unknown as InvitationStore;
  const mailer = recordingInvitationMailer();
  const service = createCompanyTeamService({ store, mailer, now: () => NOW, entropy: () => Buffer.alloc(32, 3) });
  const result = await service.invite("owner-1", ACME, { email: "sara@example.com", role: "recruiter", scope: "self" }, "https://hub.example");
  assert.equal(result.kind, "invited");
  if (result.kind !== "invited") return;
  assert.equal(result.link, `https://hub.example/invitations/${Buffer.alloc(32, 3).toString("base64url")}`);
  assert.equal(result.mailed, false);
  assert.deepEqual(mailer.sent, []);
});
