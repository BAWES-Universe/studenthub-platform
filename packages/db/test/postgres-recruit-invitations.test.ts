import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitInvitationsStore, PostgresRecruitPipelineStore, PostgresRecruitRequestsStore, runMigrations } from "@studenthub/db";
import {
jobCandidateDecision,   acceptCardEffect, invitationOutbox, invitationTransitionAllowed, pipelineAssignDecision, pipelineAuthority, pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed,
  recruitNotesDecision, recruitStaffDecision, requestAcceptsCards, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTransitionAllowed, requestTransitionDecision,
} from "../../recruit/src/index.js";
import { PostgresAccessPausesStore } from "@studenthub/db";
import { revokeDuring } from "./recruit-races.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `rec4-ops-${randomUUID()}`;
const OPS = [OPS_ORG];
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresOrganizationStoresStore, requests: PostgresRecruitRequestsStore, pipeline: PostgresRecruitPipelineStore, invitations: PostgresRecruitInvitationsStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS_ORG, name: "Operator" }));
  stores = new PostgresOrganizationStoresStore({ pool, writeDecision: organizationStoreWriteDecision, readDecision: organizationStoreReadDecision });
  requests = new PostgresRecruitRequestsStore({
    pool, createDecision: (r, o, a) => requestCreateDecision(r, o, a, OPS), readDecision: (r, o, a) => requestReadDecision(r, o, a, OPS),
    transitionDecision: (r, o, a) => requestTransitionDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), transitionAllowed: requestTransitionAllowed, managedStores: async () => [], paused: (ids: readonly string[]) => new PostgresAccessPausesStore({ pool }).paused(ids), pipelineAuthority: (p, a, r) => pipelineAuthority(p, a, pipelineLeadDecision(r, OPS), pipelineRecruiterEligible(r, OPS)),
  });
  pipeline = new PostgresRecruitPipelineStore({
    pool, assignDecision: (r) => pipelineAssignDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS), recruiterEligible: (r) => pipelineRecruiterEligible(r, OPS), candidateDecision: jobCandidateDecision,
    authority: pipelineAuthority, transitionAllowed: pipelineTransitionAllowed, acceptsCards: requestAcceptsCards, requestStatusAfter: requestStatusAfterPipeline,
    placement: { placeFromRecruit: async () => ({ kind: "refused", code: "work_unavailable" }) }, operatorOrgIds: OPS,
  });
  invitations = new PostgresRecruitInvitationsStore({
    pool, leadDecision: (r) => pipelineLeadDecision(r, OPS), recruiterEligible: (r) => pipelineRecruiterEligible(r, OPS), staffDecision: (r) => recruitNotesDecision(r, OPS), authority: pipelineAuthority, acceptsCards: requestAcceptsCards,
    transitionAllowed: invitationTransitionAllowed, acceptCardEffect, requestStatusAfter: requestStatusAfterPipeline, candidateDecision: jobCandidateDecision, outbox: invitationOutbox,
  });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = [], displayName?: string) {
  const id = `rec4-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  // A person with no other grant is a candidate (candidate:self): only candidates are suggested or invited.
  await authz.grantMany(id, grants.length ? grants : [{ orgId: OPS_ORG, role: "candidate", scope: "self" }]);
  return id;
}
async function setup() {
  const orgId = `rec4-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: orgId, name: "Sultan Co", parentOrgId: OPS_ORG }));
  const owner = await person([{ orgId, role: "org-owner", scope: "self" }]);
  const storeId = ((await stores.create(owner, orgId, { name: "Avenues", location: null, brandId: null, mallId: null })) as { storeId: string }).storeId;
  const requestId = ((await requests.create(owner, orgId, { storeId, positionTitle: "Cashier", description: "d", compensationText: "3 KWD an hour", positionType: "part_time", headcount: 2, periodStart: "2026-12-01", periodEnd: "2026-12-31", payModel: "hourly", gender: "any", location: null, priority: 0, draft: false })) as { requestId: string }).requestId;
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }]);
  const recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }], "Rami Recruiter");
  const other = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
  await pipeline.assign(staff, requestId, recruiter);
  return { orgId, owner, requestId, staff, recruiter, other };
}
const outbox = async (subject: string) => (await pool.query<{ kind: string; recipient_principal_id: string }>("SELECT kind, recipient_principal_id FROM recruit_outbox WHERE subject_id = $1 ORDER BY id", [subject])).rows.map((r) => [r.kind, r.recipient_principal_id]);
const invitation = async (id: string) => (await pool.query<{ status: string; seen: boolean; answered: boolean }>("SELECT status, seen_at IS NOT NULL AS seen, answered_at IS NOT NULL AS answered FROM recruit_invitations WHERE id = $1", [id])).rows[0]!;
const cards = async (requestId: string) => (await pool.query<{ person_principal_id: string; stage: string }>("SELECT person_principal_id, stage FROM recruit_pipeline_cards WHERE request_id = $1 ORDER BY created_at", [requestId])).rows;

test("REC4_INVITE the assigned recruiter invites once per person; others are refused; the person hears through the outbox", async () => {
  const s = await setup(), noor = await person([], "Noor");
  assert.deepEqual(await invitations.invite(s.other, s.requestId, noor), { kind: "not_found" }, "only the assigned recruiter or a lead");
  assert.deepEqual(await invitations.invite(s.owner, s.requestId, noor), { kind: "not_found" });
  assert.deepEqual(await invitations.invite(s.recruiter, s.requestId, "nobody"), { kind: "not_found" });
  for (const account of [s.owner, s.staff]) assert.deepEqual(await invitations.invite(s.recruiter, s.requestId, account), { kind: "not_found" }, "only candidates are invited; employer and staff accounts are not");
  const sent = await invitations.invite(s.recruiter, s.requestId, noor);
  assert.equal(sent.kind, "invited");
  const id = (sent as { invitationId: string }).invitationId;
  assert.deepEqual(await invitations.invite(s.recruiter, s.requestId, noor), { kind: "duplicate", invitationId: id });
  assert.deepEqual(await outbox(id), [["invitation.sent", noor]]);
  const mine = await invitations.mine(noor);
  assert.deepEqual(mine.map((r) => [r.id, r.status, r.org_name, r.store_name, r.period_start, r.period_end, r.compensation_text, r.pay_model]), [[id, "sent", "Sultan Co", "Avenues", "2026-12-01", "2026-12-31", "3 KWD an hour", "hourly"]]);
  assert.deepEqual(await invitations.mine(s.recruiter), []);
  assert.deepEqual((await invitations.forRequest(s.recruiter, s.requestId))!.map((r) => [r.person_name, r.status]), [["Noor", "sent"]]);
  assert.equal(await invitations.forRequest(s.owner, s.requestId), null);
  assert.equal((await requests.transition(s.owner, s.requestId, "closed", "cancelled")).kind, "transitioned");
  assert.deepEqual(await invitations.invite(s.recruiter, s.requestId, await person()), { kind: "not_found" }, "cancelling clears the recruiter");
  const lead = await person([{ orgId: OPS_ORG, role: "admin", scope: "subtree" }]);
  assert.deepEqual(await invitations.invite(lead, s.requestId, await person()), { kind: "request_not_open" });
});

test("REC4_ANSWER the person marks seen and accepts into the pipeline; a suggestion moves on; answers are final and only the person's own", async () => {
  const s = await setup(), noor = await person(), sara = await person(), lina = await person();
  const inv = async (who: string) => ((await invitations.invite(s.recruiter, s.requestId, who)) as { invitationId: string }).invitationId;
  const a = await inv(noor);
  assert.deepEqual(await invitations.answer(sara, a, "accepted"), { kind: "not_found" }, "someone else's invitation is not found");
  assert.deepEqual(await invitations.answer(noor, a, "seen"), { kind: "done", status: "seen", cardId: null });
  assert.deepEqual(await invitations.answer(noor, a, "seen"), { kind: "done", status: "seen", cardId: null }, "seeing twice is harmless");
  const accepted = await invitations.answer(noor, a, "accepted");
  assert.equal(accepted.kind, "done");
  assert.deepEqual(await invitation(a), { status: "accepted", seen: true, answered: true });
  assert.deepEqual(await cards(s.requestId), [{ person_principal_id: noor, stage: "contacted" }]);
  assert.equal((await pool.query("SELECT status FROM recruit_requests WHERE id = $1", [s.requestId])).rows[0].status, "filling", "the first card fills an open request");
  assert.deepEqual(await outbox(a), [["invitation.sent", noor], ["invitation.accepted", s.recruiter]]);
  assert.deepEqual(await invitations.answer(noor, a, "declined"), { kind: "refused", status: "accepted" });

  await pipeline.addCard(s.recruiter, s.requestId, sara);
  const b = await inv(sara);
  await invitations.answer(sara, b, "accepted");
  assert.deepEqual((await cards(s.requestId)).find((c) => c.person_principal_id === sara), { person_principal_id: sara, stage: "contacted" }, "a suggestion moves on to contacted");
  const events = (await pool.query("SELECT e.from_stage, e.to_stage FROM recruit_pipeline_events e JOIN recruit_pipeline_cards c ON c.id = e.card_id WHERE c.person_principal_id = $1 ORDER BY e.at, e.id", [sara])).rows;
  assert.deepEqual(events, [{ from_stage: null, to_stage: "suggested" }, { from_stage: "suggested", to_stage: "contacted" }]);

  const card = ((await pipeline.addCard(s.recruiter, s.requestId, lina)) as { cardId: string }).cardId;
  await pipeline.move(s.recruiter, card, "withdrawn");
  const c = await inv(lina);
  assert.deepEqual(await invitations.answer(lina, c, "accepted"), { kind: "card_withdrawn" });
  assert.deepEqual(await invitations.answer(lina, c, "declined"), { kind: "done", status: "declined", cardId: null });
  assert.deepEqual(await outbox(c), [["invitation.sent", lina], ["invitation.declined", s.recruiter]]);
  await assert.rejects(pool.query("UPDATE recruit_invitations SET status = 'sent', answered_at = NULL WHERE id = $1", [c]), /not allowed/);
  const company = (await requests.get(s.owner, s.requestId))!;
  assert.deepEqual(company.people.map((x) => x.stage), ["contacted", "contacted"], "the company sees suggested and contacted people, never withdrawn ones");
  await assert.rejects(pool.query("DELETE FROM recruit_invitations WHERE id = $1", [c]), /kept/);
});

test("REC4_WITHDRAW staff with authority withdraw an open invitation; the person can no longer accept; a race accepts or withdraws, never both", async () => {
  const s = await setup(), noor = await person(), sara = await person();
  const a = ((await invitations.invite(s.recruiter, s.requestId, noor)) as { invitationId: string }).invitationId;
  assert.deepEqual(await invitations.withdraw(s.other, a), { kind: "not_found" });
  assert.deepEqual(await invitations.withdraw(noor, a), { kind: "not_found" });
  assert.deepEqual(await invitations.withdraw(s.recruiter, a), { kind: "done", status: "withdrawn", cardId: null });
  assert.deepEqual(await invitations.answer(noor, a, "accepted"), { kind: "refused", status: "withdrawn" });
  assert.deepEqual(await outbox(a), [["invitation.sent", noor], ["invitation.withdrawn", noor]]);
  const b = ((await invitations.invite(s.recruiter, s.requestId, sara)) as { invitationId: string }).invitationId;
  const [x, y] = await Promise.all([invitations.answer(sara, b, "accepted"), invitations.withdraw(s.recruiter, b)]);
  assert.equal([x, y].filter((r) => r.kind === "done").length, 1, JSON.stringify([x, y]));
  const final = (await invitation(b)).status;
  assert.equal((await cards(s.requestId)).some((c) => c.person_principal_id === sara), final === "accepted");
  await assert.rejects(pool.query("UPDATE recruit_outbox SET kind = 'invitation.sent' WHERE subject_id = $1", [b]), /dispatched/);
});

test("REC4_REVOKE_RACE a recruiter losing the grant while inviting or withdrawing, or a person losing the candidate grant while accepting, is refused", async () => {
  const s = await setup(), noor = await person(), sami = await person();
  assert.deepEqual(await revokeDuring(pool, s.recruiter, () => invitations.invite(s.recruiter, s.requestId, noor)), { kind: "not_found" });
  const lead = await person([{ orgId: OPS_ORG, role: "admin", scope: "subtree" }]);
  const invited = ((await invitations.invite(lead, s.requestId, noor)) as { invitationId: string }).invitationId;
  const lead2 = await person([{ orgId: OPS_ORG, role: "admin", scope: "subtree" }]);
  assert.deepEqual(await revokeDuring(pool, lead2, () => invitations.withdraw(lead2, invited)), { kind: "not_found" });
  assert.deepEqual(await revokeDuring(pool, noor, () => invitations.answer(noor, invited, "accepted")), { kind: "not_found" }, "no longer a candidate: no pipeline card");
  assert.equal((await pool.query("SELECT 1 FROM recruit_pipeline_cards WHERE request_id = $1::uuid AND person_principal_id = $2::text", [s.requestId, noor])).rowCount, 0);
  assert.equal((await pool.query<{ status: string }>("SELECT status FROM recruit_invitations WHERE id = $1::uuid", [invited])).rows[0]!.status, "sent");
  assert.deepEqual(await invitations.invite(lead, s.requestId, sami).then((r) => r.kind), "invited");
});
