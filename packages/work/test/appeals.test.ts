import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppealService, SessionConflict, WorkScope, parseAppealCursor,
  type AppealStore, type AppealTransaction, type AppealUpdate, type Assignment, type DecisionNotice, type WorkAppeal, type WorkDecision,
  type WorkEvent, type WorkGrant, type WorkSession,
} from "../src/index.js";

const STORE = "aaaaaaaa-0000-4000-8000-000000000001";
const ANCESTORS: Record<string, string[]> = { company: ["root"], rival: ["root"], root: [] };
const GRANTS: Record<string, WorkGrant[]> = {
  staff: [{ orgId: "root", role: "staff", scope: "subtree" }],
  owner: [{ orgId: "company", role: "org-owner", scope: "self" }],
  rivalStaff: [{ orgId: "rival", role: "staff", scope: "subtree" }],
  rootSelfStaff: [{ orgId: "root", role: "staff", scope: "self" }],
};
const ASSIGNMENT: Assignment = {
  id: "assignment", personId: "person", orgId: "company", storeId: STORE, payContractId: null,
  contractResolution: { version: "studenthub.pay-rate-resolution.v1", steps: [], matchedContractIds: [], contractId: null },
  startDate: "2026-11-01", endDate: "2026-11-30", warnings: [], source: "staff", requestId: null, recruitCardId: null, recruitRequestId: null,
  createdBy: "staff", createdAt: "2026-11-01T00:00:00.000Z",
} as unknown as Assignment;

let n = 0;
const uid = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, "0")}`;
function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: uid(), assignmentId: "assignment", personId: "person", orgId: "company", storeId: STORE, workDate: "2026-11-18",
    startedAt: "2026-11-18T06:00:00.000Z", endedAt: "2026-11-18T08:00:00.000Z", durationSeconds: 7200, startLocation: null, endLocation: null,
    source: "timer", status: "approved", flags: [], note: null, correctsSessionId: null, decisionId: null, deletedAt: null, createdBy: "person",
    createdAt: "2026-11-18T06:00:00.000Z", ...over,
  };
}

class Memory implements AppealStore {
  sessions: WorkSession[] = [];
  appeals: WorkAppeal[] = [];
  updates: AppealUpdate[] = [];
  decisions: WorkDecision[] = [];
  events: WorkEvent[] = [];
  notices: DecisionNotice[] = [];
  async organizationAncestors(orgId: string) { return ANCESTORS[orgId]; }
  inForce(s: WorkSession) { return s.deletedAt === null && !this.sessions.some((c) => c.correctsSessionId === s.id && c.deletedAt === null); }
  async transaction<T>(work: (tx: AppealTransaction) => Promise<T>): Promise<T> {
    const snap = JSON.stringify([this.sessions, this.appeals, this.updates, this.decisions, this.events, this.notices]);
    const tx: AppealTransaction = {
      lockSession: async (id) => this.sessions.find((s) => s.id === id),
      isReplaced: async (id) => this.sessions.some((c) => c.correctsSessionId === id && c.deletedAt === null),
      hasOpenAppeal: async (id) => this.appeals.some((a) => a.sessionId === id && a.status !== "resolved"),
      assignment: async (id) => id === ASSIGNMENT.id ? ASSIGNMENT : undefined,
      insertSession: async (s) => {
        const start = s.startedAt.getTime(), end = s.endedAt!.getTime();
        if (this.sessions.some((o) => o.personId === s.personId && o.id !== s.correctsSessionId && this.inForce(o)
          && Date.parse(o.startedAt) < end && Date.parse(o.endedAt ?? "9999-01-01") > start)) throw new SessionConflict("overlap");
        const row = session({ ...s, startedAt: s.startedAt.toISOString(), endedAt: s.endedAt!.toISOString(), durationSeconds: Math.floor((end - start) / 1000), decisionId: null });
        this.sessions.push(row);
        return row;
      },
      insertDecision: async (d) => { this.decisions.push(d); },
      setStatus: async (ids, status, decisionId) => { this.sessions = this.sessions.map((s) => ids.includes(s.id) ? { ...s, status, decisionId } : s); },
      insertAppeal: async (a) => { const row = { ...a, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; this.appeals.push(row); return row; },
      lockAppeal: async (id) => this.appeals.find((a) => a.id === id),
      setAppealStatus: async (id, status) => { this.appeals = this.appeals.map((a) => a.id === id ? { ...a, status } : a); return this.appeals.find((a) => a.id === id)!; },
      insertUpdate: async (u) => { const row = { ...u, createdAt: new Date().toISOString(), readAt: null }; this.updates.push(row); return row; },
      markRead: async (id, personId) => {
        const u = this.updates.find((x) => x.id === id);
        if (!u || this.appeals.find((a) => a.id === u.appealId)?.personId !== personId) return false;
        this.updates = this.updates.map((x) => x.id === id ? { ...x, readAt: x.readAt ?? "now" } : x);
        return true;
      },
      event: async (e) => { this.events.push(e); },
      notify: async (x) => { this.notices.push(x); },
    };
    try { return await work(tx); } catch (e) {
      [this.sessions, this.appeals, this.updates, this.decisions, this.events, this.notices] = JSON.parse(snap);
      throw e;
    }
  }
  async appeal(id: string) {
    const appeal = this.appeals.find((a) => a.id === id);
    const s = appeal && this.sessions.find((x) => x.id === appeal.sessionId);
    return appeal && s ? { appeal, session: s, updates: this.updates.filter((u) => u.appealId === id).reverse(), entries: this.sessions.filter((x) => x.appealId === id) } : undefined;
  }
  async listAppeals(f: { personId?: string; status?: string; orgIds?: readonly string[]; includeSubtree?: boolean }) {
    return this.appeals.filter((a) => (!f.personId || a.personId === f.personId) && (!f.status || a.status === f.status)
      && (!f.orgIds || f.orgIds.includes(a.orgId) || (f.includeSubtree === true && (ANCESTORS[a.orgId] ?? []).some((o) => f.orgIds!.includes(o)))));
  }
}

function setup() {
  const store = new Memory();
  const grants = { listGrantsForPrincipal: async (id: string) => GRANTS[id] ?? [] };
  const scope = new WorkScope(grants, { managedStores: async () => [] }, (o) => store.organizationAncestors(o));
  const svc = new AppealService({ store, scope, newId: uid, now: () => new Date("2026-11-19T06:00:00Z") });
  return { store, svc };
}

test("W6_RAISE a person appeals only their own session (legacy accepted any id)", async () => {
  const { store, svc } = setup();
  const mine = session({ status: "rejected" }), theirs = session({ personId: "other", status: "rejected" });
  store.sessions.push(mine, theirs);
  assert.deepEqual(await svc.raise("person", theirs.id, "wrong"), { kind: "refused", code: "session_not_found" });
  assert.deepEqual(await svc.raise("person", mine.id, "  "), { kind: "refused", code: "invalid_input" });
  const out = await svc.raise("person", mine.id, "I worked until 9");
  assert.equal(out.kind, "raised");
  assert.equal(out.kind === "raised" && out.appeal.status, "submitted");
  assert.deepEqual(store.events.map((e) => e.kind), ["appeal.raised"]);
});

test("W6_RAISE only ended, rejected hours in force are appealed, one open appeal at a time", async () => {
  const { store, svc } = setup();
  const open = session({ endedAt: null, durationSeconds: null, status: "pending" });
  const pending = session({ status: "pending" }), approved = session({ status: "approved" });
  const deleted = session({ status: "rejected", deletedAt: "2026-11-18T09:00:00.000Z" });
  const replaced = session({ status: "rejected" });
  const correction = session({ status: "approved", correctsSessionId: replaced.id, source: "correction" });
  const rejected = session({ status: "rejected" });
  store.sessions.push(open, pending, approved, deleted, replaced, correction, rejected);
  assert.deepEqual(await svc.raise("person", open.id, "still here"), { kind: "refused", code: "session_open" });
  assert.deepEqual(await svc.raise("person", pending.id, "why"), { kind: "refused", code: "session_not_rejected" });
  assert.deepEqual(await svc.raise("person", approved.id, "why"), { kind: "refused", code: "session_not_rejected" });
  assert.deepEqual(await svc.raise("person", deleted.id, "why"), { kind: "refused", code: "session_not_found" });
  assert.deepEqual(await svc.raise("person", replaced.id, "why"), { kind: "refused", code: "session_replaced" });
  const first = await svc.raise("person", rejected.id, "I worked these hours");
  assert.equal(first.kind, "raised");
  assert.deepEqual(await svc.raise("person", rejected.id, "again"), { kind: "refused", code: "appeal_open" });
  // Once the appeal is resolved, the person can appeal the same hours again.
  assert.equal((await svc.setStatus("staff", first.kind === "raised" ? first.appeal.id : "", "resolved")).kind, "updated");
  assert.equal((await svc.raise("person", rejected.id, "still wrong")).kind, "raised");
  assert.equal(store.appeals.length, 2);
  assert.deepEqual(store.events.filter((e) => e.kind === "appeal.raised").length, 2);
});

test("W6_STAFF only staff over the company answer, set a named status, and read the appeal", async () => {
  const { store, svc } = setup();
  const s = session({ status: "rejected" });
  store.sessions.push(s);
  const raised = await svc.raise("person", s.id, "missing hour");
  const appealId = raised.kind === "raised" ? raised.appeal.id : "";
  for (const actor of ["owner", "rivalStaff", "person"]) {
    assert.deepEqual(await svc.postUpdate(actor, appealId, { detail: "ok" }), { kind: "refused", code: "appeal_not_found" });
    assert.deepEqual(await svc.setStatus(actor, appealId, "resolved"), { kind: "refused", code: "appeal_not_found" });
  }
  assert.deepEqual(await svc.setStatus("staff", appealId, 7), { kind: "refused", code: "invalid_input" });
  assert.equal((await svc.setStatus("staff", appealId, "in_progress")).kind, "updated");
  const posted = await svc.postUpdate("staff", appealId, { title: "Checking", detail: "We are checking the store log" });
  assert.equal(posted.kind, "posted");
  const detail = await svc.detail("person", appealId);
  assert.equal("appeal" in detail && detail.appeal.status, "in_progress");
  assert.deepEqual(await svc.detail("owner", appealId), { kind: "refused", code: "appeal_not_found" });
  assert.equal("appeal" in (await svc.detail("staff", appealId)), true);
  // Only the appellant marks an update read (legacy had no owner check).
  const updateId = posted.kind === "posted" ? posted.update.id : "";
  assert.deepEqual(await svc.markRead("other", updateId), { kind: "refused", code: "update_not_found" });
  assert.deepEqual(await svc.markRead("person", updateId), { kind: "read" });
  assert.deepEqual(store.events.map((e) => e.kind), ["appeal.raised", "appeal.status_changed", "appeal.updated"]);
  assert.deepEqual(await svc.list("owner"), { kind: "refused", code: "forbidden" });
  assert.equal((await svc.list("staff", { status: "in_progress" }) as readonly WorkAppeal[]).length, 1);
  // A company's appeals reach staff above it only through a subtree grant.
  const everyAppeal = (await svc.list("staff") as readonly WorkAppeal[]).length;
  assert.equal(everyAppeal > 0 && (await svc.list("staff", { orgId: "root" }) as readonly WorkAppeal[]).length, everyAppeal);
  assert.deepEqual(await svc.list("rootSelfStaff", { orgId: "root" }), []);
  assert.deepEqual(await svc.list("staff", { from: "2026-11-01", to: "2025-01-01" }), { kind: "refused", code: "invalid_input" });
});

test("W6_CORRECT a staff correction replaces the session, approved by staff, with a reason; the original is kept", async () => {
  const { store, svc } = setup();
  const s = session();
  store.sessions.push(s);
  const input = { startedAt: "2026-11-18T06:00:00Z", endedAt: "2026-11-18T09:00:00Z", reason: "store log shows 9am" };
  assert.deepEqual(await svc.correct("owner", s.id, input), { kind: "refused", code: "session_not_found" });
  assert.deepEqual(await svc.correct("staff", s.id, { ...input, reason: "" }), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.correct("staff", s.id, { ...input, endedAt: "2026-11-18T05:00:00Z" }), { kind: "refused", code: "end_before_start" });
  assert.deepEqual(await svc.correct("staff", s.id, { ...input, endedAt: "2026-11-20T05:00:00Z" }), { kind: "refused", code: "in_future" });
  assert.deepEqual(await svc.correct("staff", s.id, { ...input, startedAt: "2026-12-01T06:00:00+03:00", endedAt: "2026-12-01T07:00:00+03:00" }), { kind: "refused", code: "in_future" });
  const out = await svc.correct("staff", s.id, input);
  assert.equal(out.kind, "entered");
  if (out.kind !== "entered") return;
  assert.deepEqual([out.session.source, out.session.status, out.session.correctsSessionId, out.session.durationSeconds], ["correction", "approved", s.id, 10800]);
  assert.deepEqual([out.decision.outcome, out.decision.reason, out.decision.decidedBy], ["approved", "store log shows 9am", "staff"]);
  assert.equal(store.sessions.find((x) => x.id === s.id)?.deletedAt, null);
  assert.deepEqual(await svc.correct("staff", s.id, input), { kind: "refused", code: "session_replaced" });
  // A correction of the correction replaces the live one.
  assert.equal((await svc.correct("staff", out.session.id, { ...input, endedAt: "2026-11-18T08:30:00Z" })).kind, "entered");
  assert.deepEqual(store.events.filter((e) => e.kind === "session.corrected").length, 2);
  assert.deepEqual(store.notices.map((x) => x.kind), ["decided", "decided"]);
});

test("W6_CORRECT open sessions, overlaps and dates outside the placement are refused", async () => {
  const { store, svc } = setup();
  const open = session({ endedAt: null, durationSeconds: null, status: "pending" });
  const a = session({ startedAt: "2026-11-17T06:00:00.000Z", endedAt: "2026-11-17T08:00:00.000Z", workDate: "2026-11-17" });
  const b = session({ startedAt: "2026-11-17T09:00:00.000Z", endedAt: "2026-11-17T10:00:00.000Z", workDate: "2026-11-17" });
  store.sessions.push(open, a, b);
  const reason = "fix";
  assert.deepEqual(await svc.correct("staff", open.id, { startedAt: "2026-11-18T06:00:00Z", endedAt: "2026-11-18T07:00:00Z", reason }), { kind: "refused", code: "session_open" });
  assert.deepEqual(await svc.correct("staff", a.id, { startedAt: "2026-11-17T06:00:00Z", endedAt: "2026-11-17T09:30:00Z", reason }), { kind: "refused", code: "overlaps_session" });
  assert.deepEqual(await svc.correct("staff", a.id, { startedAt: "2026-10-30T06:00:00Z", endedAt: "2026-10-30T07:00:00Z", reason }), { kind: "refused", code: "outside_assignment" });
  // An appeal from another company (same person) can't carry this company's correction.
  const elsewhere: WorkAppeal = { id: uid(), sessionId: uid(), personId: "person", orgId: "rival", storeId: STORE, reason: "x", status: "submitted", createdAt: "2026-11-18T06:00:00.000Z", updatedAt: "2026-11-18T06:00:00.000Z" };
  store.appeals.push(elsewhere);
  assert.deepEqual(await svc.correct("staff", b.id, { startedAt: "2026-11-17T09:00:00Z", endedAt: "2026-11-17T10:30:00Z", reason, appealId: elsewhere.id }), { kind: "refused", code: "appeal_not_found" });
  assert.equal((await svc.correct("staff", a.id, { startedAt: "2026-11-17T05:00:00Z", endedAt: "2026-11-17T09:00:00Z", reason })).kind, "entered");
});

test("W6_ADD staff add missing time for an appeal; it is approved and linked, not a replacement", async () => {
  const { store, svc } = setup();
  const s = session({ status: "rejected" });
  store.sessions.push(s);
  const raised = await svc.raise("person", s.id, "I also worked the evening");
  const appealId = raised.kind === "raised" ? raised.appeal.id : "";
  const input = { startedAt: "2026-11-18T14:00:00Z", endedAt: "2026-11-18T16:00:00Z", reason: "evening shift confirmed" };
  assert.deepEqual(await svc.addMissing("owner", appealId, input), { kind: "refused", code: "appeal_not_found" });
  const out = await svc.addMissing("staff", appealId, input);
  assert.equal(out.kind, "entered");
  if (out.kind !== "entered") return;
  assert.deepEqual([out.session.source, out.session.status, out.session.correctsSessionId, out.session.appealId], ["manual", "approved", null, appealId]);
  const detail = await svc.detail("person", appealId);
  assert.equal("entries" in detail && detail.entries.length, 1);
  // A correction can name the appeal too, only the appellant's.
  const other = session({ personId: "other", startedAt: "2026-11-16T06:00:00.000Z", endedAt: "2026-11-16T07:00:00.000Z", workDate: "2026-11-16" });
  store.sessions.push(other);
  assert.deepEqual(await svc.correct("staff", other.id, { ...input, appealId }), { kind: "refused", code: "appeal_not_found" });
});

test("W6_CURSOR appeal cursors are strict", () => {
  assert.equal(parseAppealCursor(""), null);
  assert.deepEqual(parseAppealCursor("2026-11-18T06:00:00.000Z~DDDDDDDD-0000-4000-8000-000000000001"), { createdAt: "2026-11-18T06:00:00.000Z", id: "dddddddd-0000-4000-8000-000000000001" });
  assert.equal(parseAppealCursor("2026-11-18~dddddddd-0000-4000-8000-000000000001"), undefined);
  assert.equal(parseAppealCursor("2026-11-18T06:00:00Z~x"), undefined);
});
