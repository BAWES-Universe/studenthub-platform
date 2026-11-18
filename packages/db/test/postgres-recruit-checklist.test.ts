import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { PostgresAuthzStore, PostgresOrganizationStoresStore, PostgresRecruitChecklistStore, PostgresRecruitPipelineStore, PostgresRecruitRequestsStore, runMigrations } from "@studenthub/db";
import {
jobCandidateDecision,   checklistAdminDecision, pipelineAssignDecision, pipelineAuthority, pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed, recruitNotesDecision, recruitStaffDecision,
  requestAcceptsCards, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTransitionAllowed, requestTransitionDecision,
} from "../../recruit/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `rec2b-ops-${randomUUID()}`;
const OPS = [OPS_ORG];
let pool: pg.Pool, authz: PostgresAuthzStore, stores: PostgresOrganizationStoresStore, requests: PostgresRecruitRequestsStore, pipeline: PostgresRecruitPipelineStore, checklist: PostgresRecruitChecklistStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS_ORG, name: "Operator" }));
  stores = new PostgresOrganizationStoresStore({ pool, writeDecision: organizationStoreWriteDecision, readDecision: organizationStoreReadDecision });
  requests = new PostgresRecruitRequestsStore({
    pool, createDecision: (r, o, a) => requestCreateDecision(r, o, a, OPS), readDecision: (r, o, a) => requestReadDecision(r, o, a, OPS),
    transitionDecision: (r, o, a) => requestTransitionDecision(r, o, a, OPS), staffDecision: (r) => recruitStaffDecision(r, OPS), transitionAllowed: requestTransitionAllowed, managedStores: async () => [],
  });
  pipeline = new PostgresRecruitPipelineStore({
    pool, assignDecision: (r) => pipelineAssignDecision(r, OPS), leadDecision: (r) => pipelineLeadDecision(r, OPS), recruiterEligible: (r) => pipelineRecruiterEligible(r, OPS), candidateDecision: jobCandidateDecision,
    authority: pipelineAuthority, transitionAllowed: pipelineTransitionAllowed, acceptsCards: requestAcceptsCards, requestStatusAfter: requestStatusAfterPipeline,
    placement: { placeFromRecruit: async () => ({ kind: "refused", code: "work_unavailable" }) }, operatorOrgIds: OPS,
  });
  checklist = new PostgresRecruitChecklistStore({ pool, adminDecision: (r) => checklistAdminDecision(r, OPS), notesDecision: (r) => recruitNotesDecision(r, OPS) });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[] = [], displayName?: string) {
  const id = `rec2b-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  // A person with no other grant is a candidate (candidate:self): only candidates are suggested or invited.
  await authz.grantMany(id, grants.length ? grants : [{ orgId: OPS_ORG, role: "candidate", scope: "self" }]);
  return id;
}
async function setup() {
  const orgId = `rec2b-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: orgId, name: `Company ${orgId}`, parentOrgId: OPS_ORG }));
  const owner = await person([{ orgId, role: "org-owner", scope: "self" }]);
  const store = await stores.create(owner, orgId, { name: "Avenues", location: null, brandId: null, mallId: null });
  const storeId = (store as { storeId: string }).storeId;
  const created = await requests.create(owner, orgId, { storeId, positionTitle: "Cashier", description: "d", compensationText: "c", positionType: "part_time", headcount: 1, periodStart: null, periodEnd: null, payModel: null, gender: "any", location: null, priority: 0, draft: false });
  const requestId = (created as { requestId: string }).requestId;
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }], "Sara Staff");
  const recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }], "Rami Recruiter");
  const admin = await person([{ orgId: OPS_ORG, role: "admin", scope: "subtree" }]);
  return { orgId, owner, requestId, staff, recruiter, admin };
}
const item = (nameEn: string, sortOrder: number, required = true) => ({ nameEn, nameAr: null, required, sortOrder });

test("REC2B_ITEMS operator admins create, edit and softly remove steps; staff read them; others are refused", async () => {
  const s = await setup();
  assert.deepEqual(await checklist.createItem(s.staff, item("Call", 1)), { kind: "not_found" });
  assert.deepEqual(await checklist.createItem(s.owner, item("Call", 1)), { kind: "not_found" });
  const created = await checklist.createItem(s.admin, { nameEn: `Call ${randomUUID()}`, nameAr: "اتصل", required: true, sortOrder: 1 });
  assert.equal(created.kind, "created");
  const id = (created as { itemId: string }).itemId;
  assert.deepEqual(await checklist.updateItem(s.admin, id, item("Call the store", 2, false)), { kind: "updated" });
  assert.deepEqual(await checklist.updateItem(s.staff, id, item("x", 2)), { kind: "not_found" });
  const listed = (await checklist.items(s.recruiter))!.find((i) => i.id === id);
  assert.deepEqual(listed, { id, name_en: "Call the store", name_ar: null, required: false, sort_order: 2 });
  assert.equal(await checklist.items(s.owner), null, "a company owner does not see the internal checklist");
  assert.deepEqual(await checklist.removeItem(s.admin, id), { kind: "removed" });
  assert.deepEqual(await checklist.removeItem(s.admin, id), { kind: "not_found" });
  assert.deepEqual(await checklist.updateItem(s.admin, id, item("again", 1)), { kind: "not_found" }, "a removed step stays removed");
  assert.equal((await checklist.items(s.staff))!.some((i) => i.id === id), false);
  await assert.rejects(pool.query("DELETE FROM recruit_checklist_items WHERE id = $1", [id]), /removed softly/);
});

test("REC2B_NOTES staff and recruiters note a request, tick a step and name a person on it; references must exist and belong", async () => {
  const s = await setup(), other = await setup();
  const step = ((await checklist.createItem(s.admin, item(`Brief ${randomUUID()}`, 0))) as { itemId: string }).itemId;
  const gone = ((await checklist.createItem(s.admin, item(`Gone ${randomUUID()}`, 0))) as { itemId: string }).itemId;
  await checklist.removeItem(s.admin, gone);
  assert.deepEqual(await pipeline.assign(s.staff, s.requestId, s.recruiter), { kind: "assigned" });
  const candidate = await person([], "Noor Candidate");
  const cardId = ((await pipeline.addCard(s.recruiter, s.requestId, candidate)) as { cardId: string }).cardId;
  await pipeline.assign(other.staff, other.requestId, other.recruiter);
  const otherCard = ((await pipeline.addCard(other.recruiter, other.requestId, await person())) as { cardId: string }).cardId;

  const note = (o: Partial<{ type: "internal_note" | "phone_call"; text: string; checklistItemId: string | null; cardId: string | null }> = {}) => ({ type: "phone_call" as const, text: "Called the store.", checklistItemId: null, cardId: null, ...o });
  assert.deepEqual(await checklist.addNote(s.owner, s.requestId, note()), { kind: "not_found" }, "company people cannot read or write staff notes");
  assert.deepEqual(await checklist.addNote(s.staff, randomUUID(), note()), { kind: "not_found" });
  assert.deepEqual(await checklist.addNote(s.staff, s.requestId, note({ checklistItemId: gone })), { kind: "item_not_found" });
  assert.deepEqual(await checklist.addNote(s.staff, s.requestId, note({ checklistItemId: randomUUID() })), { kind: "item_not_found" });
  assert.deepEqual(await checklist.addNote(s.staff, s.requestId, note({ cardId: otherCard })), { kind: "card_not_found" });
  assert.equal((await checklist.addNote(s.staff, s.requestId, note())).kind, "created");
  assert.equal((await checklist.addNote(s.recruiter, s.requestId, note({ type: "internal_note", text: "Brief done", checklistItemId: step, cardId }))).kind, "created");

  const view = (await checklist.requestNotes(s.staff, s.requestId))!;
  assert.equal(view.title, "Cashier");
  assert.deepEqual(view.notes.map((n) => [n.note_type, n.author_name, n.person_name, n.checklist_name?.startsWith("Brief") ?? null]), [["phone_call", "Sara Staff", null, null], ["internal_note", "Rami Recruiter", "Noor Candidate", true]]);
  assert.deepEqual(view.doneItemIds, [step]);
  assert.deepEqual(view.cards, [{ id: cardId, person_name: "Noor Candidate" }], "the page offers only this request's people for a note");
  assert.equal(view.items.some((i) => i.id === gone), false);
  assert.equal(await checklist.requestNotes(s.owner, s.requestId), null);
  assert.equal(await checklist.requestNotes(s.staff, randomUUID()), null);
  await assert.rejects(pool.query("INSERT INTO recruit_request_notes(id, request_id, card_id, note_type, note_text) VALUES($1, $2, $3, 'email', 'x')", [randomUUID(), s.requestId, otherCard]), /belong to the note request/);
});

test("REC2B_EDIT staff edit type and text and remove softly; a removed note is gone and read-only; nothing else can change", async () => {
  const s = await setup();
  const step = ((await checklist.createItem(s.admin, item(`Edit ${randomUUID()}`, 0))) as { itemId: string }).itemId;
  const noteId = ((await checklist.addNote(s.staff, s.requestId, { type: "phone_call", text: "First", checklistItemId: step, cardId: null })) as { noteId: string }).noteId;
  assert.deepEqual(await checklist.editNote(s.owner, noteId, "email", "Hijack"), { kind: "not_found" });
  assert.deepEqual(await checklist.editNote(s.recruiter, noteId, "email", "Sent the brief"), { kind: "updated" }, "any operator staff member may edit, as legacy allowed");
  const row = (await pool.query("SELECT note_type, note_text, author_principal_id, updated_by_principal_id, updated_at > created_at AS edited FROM recruit_request_notes WHERE id = $1", [noteId])).rows[0];
  assert.deepEqual(row, { note_type: "email", note_text: "Sent the brief", author_principal_id: s.staff, updated_by_principal_id: s.recruiter, edited: true });
  await assert.rejects(pool.query("UPDATE recruit_request_notes SET checklist_item_id = NULL WHERE id = $1", [noteId]), /only a note type and text/);
  await assert.rejects(pool.query("DELETE FROM recruit_request_notes WHERE id = $1", [noteId]), /removed softly/);
  assert.deepEqual(await checklist.removeNote(s.owner, noteId), { kind: "not_found" });
  assert.deepEqual(await checklist.removeNote(s.staff, noteId), { kind: "removed" });
  assert.deepEqual(await checklist.removeNote(s.staff, noteId), { kind: "not_found" });
  assert.deepEqual(await checklist.editNote(s.staff, noteId, "task", "Back"), { kind: "not_found" });
  await assert.rejects(pool.query("UPDATE recruit_request_notes SET note_text = 'x' WHERE id = $1", [noteId]), /read-only/);
  const view = (await checklist.requestNotes(s.staff, s.requestId))!;
  assert.deepEqual([view.notes.length, view.doneItemIds], [0, []], "a removed note no longer ticks its step");
});
