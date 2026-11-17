import assert from "node:assert/strict";
import { test } from "node:test";
import type { PayContract } from "@studenthub/pay-contracts";
import {
  chooseContract, kuwaitDate, parsePlacementInput, PlacementConflict, placementWarnings, PlacementService,
  type Assignment, type AssignmentRequest, type PlacementStore, type PlacementTransaction, type StoreFacts, type WorkEvent, type WorkGrant,
} from "../src/index.js";

const STORE = "4b5d0f8e-8c7a-4d1e-9a51-0b6f2b1c3d4e";
const OTHER_STORE = "7e0c2a19-3f4b-4c5d-8e6f-1a2b3c4d5e6f";
const NOW = new Date("2026-11-17T21:30:00Z"); // 00:30 on 18 Nov in Kuwait

function contract(id: string, over: Partial<PayContract> = {}): PayContract {
  return {
    id, candidateId: "person", companyId: "company", storeId: STORE, startDate: "2026-01-01", currencyId: "kwd", transferCost: "0",
    autoGenerate: false, status: "active", terms: { payModel: "hourly", candidateHourlyRate: "1.000", companyHourlyRate: "2.000" },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
  };
}

class MemoryPlacements implements PlacementStore {
  stores = new Map<string, StoreFacts>([[STORE, { id: STORE, orgId: "company", status: "active", ancestors: ["group", "root"] }], [OTHER_STORE, { id: OTHER_STORE, orgId: "rival", status: "active", ancestors: ["root"] }]]);
  assignments: Assignment[] = [];
  requests: AssignmentRequest[] = [];
  events: WorkEvent[] = [];
  contractsByPerson = new Map<string, PayContract[]>([["person", [contract("c-1")]]]);
  civil = { present: true, expiry: "2027-01-01" as string | null };
  openSessions = 0;
  async store(id: string) { return this.stores.get(id); }
  async organizationAncestors(orgId: string) { return orgId === "company" ? ["group", "root"] : orgId === "rival" || orgId === "group" ? ["root"] : undefined; }
  async personExists(id: string) { return id === "person" || id === "other-person"; }
  async civilId() { return this.civil; }
  async contracts(personId: string) { return this.contractsByPerson.get(personId) ?? []; }
  async assignment(id: string) { return this.assignments.find((a) => a.id === id); }
  async request(id: string) { return this.requests.find((r) => r.id === id); }
  async assignmentForRecruitCard(id: string) { return this.assignments.find((a) => a.recruitCardId === id); }
  async listAssignments(filter: { personId?: string; orgIds?: readonly string[]; storeId?: string }) {
    return this.assignments.filter((a) => (!filter.personId || a.personId === filter.personId) && (!filter.orgIds || filter.orgIds.includes(a.orgId)) && (!filter.storeId || a.storeId === filter.storeId));
  }
  async listRequests() { return this.requests; }
  async transaction<T>(work: (tx: PlacementTransaction) => Promise<T>): Promise<T> {
    const snapshot = { a: [...this.assignments], r: [...this.requests], e: [...this.events] };
    const overlaps = (a: Assignment, start: string, end: string | null) =>
      this.assignments.some((b) => b.personId === a.personId && b.id !== a.id && b.startDate <= (end ?? "9999-12-31") && (b.endDate ?? "9999-12-31") >= start);
    const tx: PlacementTransaction = {
      insertAssignment: async (a) => { if (overlaps(a, a.startDate, a.endDate)) throw new PlacementConflict(); this.assignments.push(a); },
      lockAssignment: async (id) => this.assignments.find((a) => a.id === id),
      setEndDate: async (id, endDate) => {
        const i = this.assignments.findIndex((a) => a.id === id);
        const current = this.assignments[i]!;
        if (overlaps(current, current.startDate, endDate)) throw new PlacementConflict();
        this.assignments[i] = { ...current, endDate };
      },
      insertRequest: async (r) => { if (this.requests.some((x) => x.status === "pending" && x.personId === r.personId && x.storeId === r.storeId)) return "duplicate_pending"; this.requests.push(r); return "inserted"; },
      lockRequest: async (id) => this.requests.find((r) => r.id === id),
      decideRequest: async (id, status, actorId, reason) => { const i = this.requests.findIndex((r) => r.id === id); this.requests[i] = { ...this.requests[i]!, status, decidedBy: actorId, decidedAt: NOW.toISOString(), decisionReason: reason }; },
      openSessionCount: async () => this.openSessions,
      event: async (e) => { this.events.push(e); },
    };
    try { return await work(tx); } catch (error) { this.assignments = snapshot.a; this.requests = snapshot.r; this.events = snapshot.e; throw error; }
  }
}

const GRANTS: Record<string, WorkGrant[]> = {
  staff: [{ orgId: "root", role: "staff", scope: "subtree" }],
  owner: [{ orgId: "company", role: "org-owner", scope: "self" }],
  groupOwner: [{ orgId: "group", role: "org-owner", scope: "subtree" }],
  rivalOwner: [{ orgId: "rival", role: "org-owner", scope: "self" }],
  candidate: [{ orgId: "company", role: "candidate", scope: "self" }],
  finance: [{ orgId: "company", role: "finance", scope: "self" }],
};
let ids = 0;
function service(store = new MemoryPlacements()) {
  ids = 0;
  return { store, svc: new PlacementService({ store, grants: { listGrantsForPrincipal: async (id) => GRANTS[id] ?? [] }, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, now: () => NOW }) };
}

test("W1_DATES Kuwait date is used for defaults: 21:30Z on the 17th is the 18th", () => {
  assert.equal(kuwaitDate(NOW), "2026-11-18");
  assert.equal(kuwaitDate(new Date("2026-11-17T20:59:59Z")), "2026-11-17");
});

test("W1_PARSE placement input refuses unknown keys, bad dates and bad ids", () => {
  assert.deepEqual(parsePlacementInput({ personId: "person", storeId: STORE.toUpperCase(), startDate: "2026-11-20" }), { personId: "person", storeId: STORE, startDate: "2026-11-20" });
  assert.equal(parsePlacementInput({ personId: "person", storeId: STORE, extra: 1 }), undefined);
  assert.equal(parsePlacementInput({ personId: "person", storeId: STORE, startDate: "2026-02-30" }), undefined);
  assert.equal(parsePlacementInput({ personId: "", storeId: STORE }), undefined);
  assert.equal(parsePlacementInput({ personId: "person", storeId: "not-a-uuid" }), undefined);
  assert.equal(parsePlacementInput({ personId: "person", storeId: STORE, payContractId: "x" }), undefined);
  assert.deepEqual(parsePlacementInput({ personId: "person", storeId: STORE, endDate: null }), { personId: "person", storeId: STORE, endDate: null });
});

test("W1_WARN civil ID is a warning, valid through the start date inclusive", () => {
  assert.deepEqual(placementWarnings({ present: true, expiry: "2026-11-20" }, "2026-11-20", "c"), []);
  assert.deepEqual(placementWarnings({ present: true, expiry: "2026-11-19" }, "2026-11-20", "c"), ["civil_id_expires_before_start"]);
  assert.deepEqual(placementWarnings({ present: false, expiry: null }, "2026-11-20", null), ["civil_id_missing", "no_pay_contract"]);
  assert.deepEqual(placementWarnings({ present: true, expiry: null }, "2026-11-20", "c"), []);
});

test("W1_CONTRACT the F1 contract is chosen with its reasoning; two matches need an explicit id", () => {
  const one = chooseContract([contract("c-1"), contract("c-old", { endDate: "2026-06-30" }), contract("c-gone", { status: "deleted" })], "person", STORE, "2026-11-18", null, "2026-11-18");
  assert.equal(one.ok, true);
  assert.deepEqual(one.ok && one.record, { version: "studenthub.pay-rate-resolution.v1", steps: ["contracts_matched_by_period", "single_contract_selected"], matchedContractIds: ["c-1"], contractId: "c-1" });
  const two = chooseContract([contract("c-1"), contract("c-2", { startDate: "2026-10-01" })], "person", STORE, "2026-11-18", null, "2026-11-18");
  assert.deepEqual(two, { ok: false, code: "ambiguous_contract", matchedContractIds: ["c-2", "c-1"] });
  const picked = chooseContract([contract("c-1"), contract("c-2", { startDate: "2026-10-01" })], "person", STORE, "2026-11-18", null, "2026-11-18", "c-1");
  assert.equal(picked.ok && picked.record.contractId, "c-1");
  const none = chooseContract([contract("c-elsewhere", { storeId: OTHER_STORE })], "person", STORE, "2026-11-18", null, "2026-11-18");
  assert.equal(none.ok && none.record.contractId, null);
  assert.deepEqual(chooseContract([contract("c-1")], "person", STORE, "2026-11-18", null, "2026-11-18", "c-missing"), { ok: false, code: "contract_not_applicable", matchedContractIds: ["c-1"] });
});

test("W1_PLACE staff place a person; the event and provenance are recorded", async () => {
  const { store, svc } = service();
  const out = await svc.place("staff", { personId: "person", storeId: STORE });
  assert.equal(out.kind, "placed");
  const a = out.kind === "placed" ? out.assignment : undefined;
  assert.equal(a?.startDate, "2026-11-18");
  assert.equal(a?.endDate, null);
  assert.equal(a?.payContractId, "c-1");
  assert.equal(a?.orgId, "company");
  assert.deepEqual(a?.warnings, []);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0]?.kind, "assignment.created");
  assert.equal(store.events[0]?.actorId, "staff");
});

test("W1_PLACE only staff place; a company, a candidate or finance is refused", async () => {
  for (const actor of ["owner", "groupOwner", "candidate", "finance", "nobody"]) {
    const { store, svc } = service();
    assert.deepEqual(await svc.place(actor, { personId: "person", storeId: STORE }), { kind: "refused", code: "forbidden" }, actor);
    assert.equal(store.assignments.length, 0);
  }
});

test("W1_PLACE refusals: unknown store, removed store, unknown person, end before start", async () => {
  const { store, svc } = service();
  assert.deepEqual(await svc.place("staff", { personId: "person", storeId: "00000000-0000-4000-8000-00000000ffff" }), { kind: "refused", code: "store_not_found" });
  assert.deepEqual(await svc.place("staff", { personId: "ghost", storeId: STORE }), { kind: "refused", code: "person_not_found" });
  assert.deepEqual(await svc.place("staff", { personId: "person", storeId: STORE, startDate: "2026-12-01", endDate: "2026-11-30" }), { kind: "refused", code: "end_before_start" });
  store.stores.set(STORE, { ...store.stores.get(STORE)!, status: "deleted" });
  assert.deepEqual(await svc.place("staff", { personId: "person", storeId: STORE }), { kind: "refused", code: "store_removed" });
  assert.equal(store.assignments.length, 0);
});

test("W1_OVERLAP one place at a time; history and a later placement are allowed", async () => {
  const { store, svc } = service();
  assert.equal((await svc.place("staff", { personId: "person", storeId: STORE, startDate: "2026-01-01", endDate: "2026-06-30" })).kind, "placed");
  assert.deepEqual(await svc.place("staff", { personId: "person", storeId: STORE, startDate: "2026-06-30" }), { kind: "refused", code: "overlaps_assignment" });
  assert.equal((await svc.place("staff", { personId: "person", storeId: STORE, startDate: "2026-07-01" })).kind, "placed");
  assert.equal(store.assignments.length, 2);
});

test("W1_PLACE ambiguous contracts are refused with the matched ids, no contract is a warning", async () => {
  const { store, svc } = service();
  store.contractsByPerson.set("person", [contract("c-1"), contract("c-2", { startDate: "2026-10-01" })]);
  assert.deepEqual(await svc.place("staff", { personId: "person", storeId: STORE }), { kind: "refused", code: "ambiguous_contract", matchedContractIds: ["c-2", "c-1"] });
  store.contractsByPerson.set("person", []);
  store.civil = { present: true, expiry: "2026-11-01" };
  const out = await svc.place("staff", { personId: "person", storeId: STORE });
  assert.deepEqual(out.kind === "placed" && out.assignment.warnings, ["civil_id_expires_before_start", "no_pay_contract"]);
});

test("W1_REQUEST a company asks for a person at its own store; duplicates and other companies are refused", async () => {
  const { store, svc } = service();
  const out = await svc.request("owner", { personId: "person", storeId: STORE, note: "  weekend shifts " });
  assert.equal(out.kind, "requested");
  assert.equal(out.kind === "requested" && out.request.note, "weekend shifts");
  assert.deepEqual(await svc.request("owner", { personId: "person", storeId: STORE }), { kind: "refused", code: "duplicate_request" });
  assert.deepEqual(await svc.request("rivalOwner", { personId: "person", storeId: STORE }), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await svc.request("candidate", { personId: "person", storeId: STORE }), { kind: "refused", code: "forbidden" });
  assert.equal((await svc.request("groupOwner", { personId: "other-person", storeId: STORE })).kind, "requested");
  assert.deepEqual(store.events.map((e) => e.kind), ["assignment_request.created", "assignment_request.created"]);
});

test("W1_REQUEST staff accept places the person in the same transaction; a refusal leaves the request pending", async () => {
  const { store, svc } = service();
  const req = await svc.request("owner", { personId: "person", storeId: STORE });
  const id = req.kind === "requested" ? req.request.id : "";
  assert.deepEqual(await svc.decideRequest("owner", id, "accept"), { kind: "refused", code: "forbidden" });
  store.contractsByPerson.set("person", [contract("c-1"), contract("c-2", { startDate: "2026-10-01" })]);
  assert.equal((await svc.decideRequest("staff", id, "accept")).kind, "refused");
  assert.equal(store.requests[0]?.status, "pending");
  const accepted = await svc.decideRequest("staff", id, "accept", { placement: { payContractId: "c-1" } });
  assert.equal(accepted.kind, "accepted");
  assert.equal(accepted.kind === "accepted" && accepted.assignment.source, "request");
  assert.equal(accepted.kind === "accepted" && accepted.assignment.requestId, id);
  assert.equal(store.requests[0]?.status, "accepted");
  assert.deepEqual(await svc.decideRequest("staff", id, "reject"), { kind: "refused", code: "request_not_pending" });
  assert.deepEqual(store.events.map((e) => e.kind), ["assignment_request.created", "assignment.created", "assignment_request.accepted"]);
});

test("W1_REQUEST staff reject with a reason; the company may cancel its own pending request", async () => {
  const { store, svc } = service();
  const a = await svc.request("owner", { personId: "person", storeId: STORE });
  const b = await svc.request("owner", { personId: "other-person", storeId: STORE });
  assert.deepEqual(await svc.decideRequest("staff", a.kind === "requested" ? a.request.id : "", "reject", { reason: "not available" }), { kind: "rejected" });
  assert.equal(store.requests[0]?.decisionReason, "not available");
  assert.deepEqual(await svc.decideRequest("rivalOwner", b.kind === "requested" ? b.request.id : "", "cancel"), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await svc.decideRequest("owner", b.kind === "requested" ? b.request.id : "", "cancel"), { kind: "cancelled" });
  assert.deepEqual(await svc.decideRequest("staff", "00000000-0000-4000-8000-00000000ffff", "accept"), { kind: "refused", code: "request_not_found" });
});

test("W1_END staff end or extend; an open session blocks ending", async () => {
  const { store, svc } = service();
  const placed = await svc.place("staff", { personId: "person", storeId: STORE, startDate: "2026-11-01" });
  const id = placed.kind === "placed" ? placed.assignment.id : "";
  assert.deepEqual(await svc.setEndDate("owner", id, "2026-11-18"), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await svc.setEndDate("staff", id, "2026-10-31"), { kind: "refused", code: "end_before_start" });
  store.openSessions = 1;
  assert.deepEqual(await svc.setEndDate("staff", id, "2026-11-18"), { kind: "refused", code: "open_session" });
  // A future end date does not end anything today, so an open session doesn't block it.
  assert.deepEqual(await svc.setEndDate("staff", id, "2026-12-31"), { kind: "ended", endDate: "2026-12-31" });
  store.openSessions = 0;
  assert.deepEqual(await svc.setEndDate("staff", id, "2026-11-18"), { kind: "ended", endDate: "2026-11-18" });
  assert.deepEqual(await svc.setEndDate("staff", id, "2026-11-18"), { kind: "unchanged", endDate: "2026-11-18" });
  assert.deepEqual(await svc.setEndDate("staff", id, null), { kind: "extended", endDate: null });
  assert.deepEqual(store.events.slice(1).map((e) => [e.kind, e.detail.from, e.detail.to]), [["assignment.ended", null, "2026-12-31"], ["assignment.ended", "2026-12-31", "2026-11-18"], ["assignment.extended", "2026-11-18", null]]);
});

test("W1_READ the person sees their places; a company sees its own; another company sees nothing", async () => {
  const { svc } = service();
  await svc.place("staff", { personId: "person", storeId: STORE });
  assert.equal((await svc.mine("person")).length, 1);
  assert.equal((await svc.mine("other-person")).length, 0);
  assert.equal((await svc.forOrganization("owner", "company"))?.length, 1);
  assert.equal((await svc.forOrganization("staff", "company"))?.length, 1);
  assert.equal(await svc.forOrganization("rivalOwner", "company"), undefined);
  assert.equal(await svc.forOrganization("candidate", "company"), undefined);
  assert.equal(await svc.forOrganization("owner", "missing"), undefined);
});

test("W1_RECRUIT the recruit stage places once; a repeat returns the same placement; a reused card id is refused", async () => {
  const { store, svc } = service();
  const card = "11111111-2222-4333-8444-555555555555", request = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const input = { recruitCardId: card, requestId: request, personId: "person", storeId: STORE, startDate: null, endDate: null };
  assert.deepEqual(await svc.placeFromRecruit("owner", input), { kind: "refused", code: "forbidden" });
  const first = await svc.placeFromRecruit("staff", input);
  assert.equal(first.kind === "placed" && first.created, true);
  const again = await svc.placeFromRecruit("staff", input);
  assert.deepEqual(again, { kind: "placed", assignmentId: first.kind === "placed" ? first.assignmentId : "", created: false });
  assert.equal(store.assignments.length, 1);
  assert.deepEqual([store.assignments[0]?.source, store.assignments[0]?.recruitCardId, store.assignments[0]?.recruitRequestId, store.assignments[0]?.startDate], ["recruit", card, request, "2026-11-18"]);
  assert.deepEqual(await svc.placeFromRecruit("staff", { ...input, personId: "other-person" }), { kind: "refused", code: "recruit_card_reused" });
  assert.deepEqual(await svc.placeFromRecruit("staff", { ...input, recruitCardId: "nope" }), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(store.events.map((e) => e.kind), ["assignment.created"]);
});
