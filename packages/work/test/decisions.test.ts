import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DecisionService, HoursViews, parseCursor, parseDecision, parseRange, personDecisionView, employerDecisionView, WorkScope,
  type DecisionNotice, type DecisionStore, type DecisionTransaction, type HoursViewStore, type SessionFilter, type WorkDecision, type WorkEvent, type WorkGrant, type WorkSession,
} from "../src/index.js";

const STORE_A = "aaaaaaaa-0000-4000-8000-000000000001", STORE_B = "aaaaaaaa-0000-4000-8000-000000000002", RIVAL_STORE = "aaaaaaaa-0000-4000-8000-000000000003";
const ORG_OF: Record<string, string> = { [STORE_A]: "company", [STORE_B]: "company", [RIVAL_STORE]: "rival" };
const ANCESTORS: Record<string, string[]> = { company: ["group", "root"], rival: ["root"], group: ["root"], root: [] };
const GRANTS: Record<string, WorkGrant[]> = {
  staff: [{ orgId: "root", role: "staff", scope: "subtree" }],
  owner: [{ orgId: "company", role: "org-owner", scope: "self" }],
  groupOwner: [{ orgId: "group", role: "org-owner", scope: "subtree" }],
  groupSelfOwner: [{ orgId: "group", role: "org-owner", scope: "self" }],
  rivalOwner: [{ orgId: "rival", role: "org-owner", scope: "self" }],
  manager: [],
  person: [{ orgId: "company", role: "candidate", scope: "self" }],
};
const MANAGED: Record<string, { orgId: string; storeId: string }[]> = { manager: [{ orgId: "company", storeId: STORE_A }] };

let n = 0;
const sid = () => `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, "0")}`;
function session(over: Partial<WorkSession> = {}): WorkSession {
  const storeId = over.storeId ?? STORE_A;
  return {
    id: sid(), assignmentId: "a-1", personId: "person", orgId: ORG_OF[storeId]!, storeId, workDate: "2026-11-18",
    startedAt: "2026-11-18T06:00:00.000Z", endedAt: "2026-11-18T08:00:00.000Z", durationSeconds: 7200,
    startLocation: null, endLocation: null, source: "timer", status: "pending", flags: [], note: null, correctsSessionId: null,
    decisionId: null, deletedAt: null, createdBy: "person", createdAt: "2026-11-18T06:00:00.000Z", ...over,
  };
}

class Memory implements DecisionStore, HoursViewStore {
  sessions: WorkSession[] = [];
  decisionsList: WorkDecision[] = [];
  events: WorkEvent[] = [];
  notices: DecisionNotice[] = [];
  replaced = new Set<string>();
  inTransaction = false;
  /** Pool reads made while a transaction holds its client (the pool-starvation hazard). */
  poolReadsInTransaction = 0;
  lockedDays: string[] = [];
  async organizationAncestors(orgId: string) { if (this.inTransaction) this.poolReadsInTransaction++; return ANCESTORS[orgId]; }
  async transaction<T>(work: (tx: DecisionTransaction) => Promise<T>): Promise<T> {
    const snap = { s: [...this.sessions], d: [...this.decisionsList], e: [...this.events], n: [...this.notices] };
    const tx: DecisionTransaction = {
      lockSessions: async (ids) => this.sessions.filter((s) => ids.includes(s.id)),
      organizationAncestors: async (orgId) => ANCESTORS[orgId],
      lockDay: async (day) => (this.lockedDays.push(`${day.storeId}|${day.workDate}`), this.sessions).filter((s) => s.personId === day.personId && s.storeId === day.storeId && s.workDate === day.workDate && s.endedAt !== null && s.deletedAt === null && !this.replaced.has(s.id)),
      isReplaced: async (id) => this.replaced.has(id),
      insertDecision: async (d) => { this.decisionsList.push(d); },
      setStatus: async (ids, status, decisionId) => { this.sessions = this.sessions.map((s) => ids.includes(s.id) ? { ...s, status, decisionId } : s); },
      event: async (e) => { this.events.push(e); },
      notify: async (n) => { this.notices.push(n); },
    };
    this.inTransaction = true;
    try { return await work(tx); } catch (e) { this.sessions = snap.s; this.decisionsList = snap.d; this.events = snap.e; this.notices = snap.n; throw e; } finally { this.inTransaction = false; }
  }
  #match(f: Omit<SessionFilter, "after" | "limit">) {
    return this.sessions.filter((s) => s.deletedAt === null && !this.replaced.has(s.id) && (!f.personId || s.personId === f.personId)
      && (!f.orgIds || f.orgIds.some((o) => o === s.orgId || (f.includeSubtree === true && ANCESTORS[s.orgId]?.includes(o)))) && (!f.storeIds || f.storeIds.includes(s.storeId)) && (!f.sessionIds || f.sessionIds.includes(s.id))
      && (!f.status || (s.status === f.status && s.endedAt !== null)) && s.workDate >= f.range.from && s.workDate <= f.range.to)
      .sort((a, b) => a.workDate.localeCompare(b.workDate) || a.id.localeCompare(b.id));
  }
  async listSessions(f: SessionFilter) {
    return this.#match(f).filter((s) => !f.after || s.workDate > f.after.workDate || (s.workDate === f.after.workDate && s.id > f.after.id)).slice(0, f.limit);
  }
  async totals(f: Omit<SessionFilter, "after" | "limit">) {
    const rows = this.#match(f);
    const sum = (st: string) => rows.filter((s) => s.status === st && s.endedAt !== null).reduce((a, s) => a + (s.durationSeconds ?? 0), 0);
    return { approvedSeconds: sum("approved"), pendingSeconds: sum("pending"), rejectedSeconds: sum("rejected"), open: rows.filter((s) => s.endedAt === null).length };
  }
  async decisions(ids: readonly string[]) { return this.decisionsList.filter((d) => ids.includes(d.id)); }
}

const grants = { listGrantsForPrincipal: async (id: string) => GRANTS[id] ?? [] };
const managedStores = { managedStores: async (id: string) => MANAGED[id] ?? [] };
function setup() {
  const store = new Memory();
  let ids = 0;
  const svc = new DecisionService({ store, grants, managedStores, newId: () => `cccccccc-0000-4000-8000-${String(++ids).padStart(12, "0")}`, now: () => new Date("2026-11-19T06:00:00Z") });
  const views = new HoursViews(store, new WorkScope(grants, managedStores, (o) => store.organizationAncestors(o)), (id) => managedStores.managedStores(id));
  return { store, svc, views };
}

test("W4_PARSE decisions: reason up to 255, rating 1 to 5, public flag", () => {
  assert.deepEqual(parseDecision({ decision: "approve" }), { status: "approved", reason: null, note: null, rating: null, notePublic: false });
  assert.deepEqual(parseDecision({ decision: "reject", reason: " late ", rating: "4", notePublic: "on", note: "see me" }), { status: "rejected", reason: "late", note: "see me", rating: 4, notePublic: true });
  assert.equal(parseDecision({ decision: "approve", rating: 6 }), undefined);
  assert.equal(parseDecision({ decision: "approve", rating: 0 }), undefined);
  assert.equal(parseDecision({ decision: "approve", rating: 2.5 }), undefined);
  assert.equal(parseDecision({ decision: "approve", reason: "x".repeat(256) }), undefined);
  assert.equal(parseDecision({ decision: "maybe" as never }), undefined);
  assert.equal(parseDecision({ decision: "approve", notePublic: "yes" }), undefined);
  // Only a boolean or a form string: no coercion of arrays or objects.
  assert.equal(parseDecision({ decision: "approve", notePublic: ["true"] }), undefined);
  assert.equal(parseDecision({ decision: "approve", notePublic: { toString: 1 } }), undefined);
  assert.equal(parseDecision({ decision: "approve", notePublic: true })?.notePublic, true);
});

test("W4_SESSION a company approves its own closed session; one decision row and one event", async () => {
  const { store, svc } = setup();
  const s = session();
  store.sessions.push(s);
  const out = await svc.decideSessions("owner", [s.id], { decision: "approve", rating: 5 });
  assert.equal(out.kind, "decided");
  assert.equal(store.sessions[0]?.status, "approved");
  assert.equal(store.sessions[0]?.decisionId, store.decisionsList[0]?.id);
  assert.deepEqual([store.decisionsList.length, store.decisionsList[0]?.scope, store.decisionsList[0]?.rating, store.decisionsList[0]?.batchId], [1, "session", 5, null]);
  assert.deepEqual(store.events.map((e) => [e.kind, e.subjectId]), [["session.approved", s.id]]);
});

test("W4_SCOPE another company, a candidate, or a manager of a sibling store cannot decide (legacy ownership gap)", async () => {
  const { store, svc } = setup();
  const a = session(), b = session({ storeId: STORE_B });
  store.sessions.push(a, b);
  for (const actor of ["rivalOwner", "person", "nobody"]) {
    assert.deepEqual(await svc.decideSessions(actor, [a.id], { decision: "approve" }), { kind: "refused", code: "session_not_found", index: 0 }, actor);
  }
  assert.deepEqual(await svc.decideSessions("manager", [b.id], { decision: "approve" }), { kind: "refused", code: "session_not_found", index: 0 });
  assert.equal((await svc.decideSessions("manager", [a.id], { decision: "approve" })).kind, "decided");
  assert.equal((await svc.decideSessions("groupOwner", [b.id], { decision: "reject" })).kind, "decided");
  assert.equal((await svc.decideSessions("staff", [b.id], { decision: "approve" })).kind, "decided");
});

test("W4_BULK all or nothing: one bad item refuses the whole batch", async () => {
  const { store, svc } = setup();
  const a = session(), open = session({ endedAt: null, durationSeconds: null }), rival = session({ storeId: RIVAL_STORE });
  store.sessions.push(a, open, rival);
  assert.deepEqual(await svc.decideSessions("owner", [a.id, open.id], { decision: "approve" }), { kind: "refused", code: "session_open", index: 1 });
  assert.deepEqual(await svc.decideSessions("owner", [a.id, rival.id], { decision: "approve" }), { kind: "refused", code: "session_not_found", index: 1 });
  assert.deepEqual(await svc.decideSessions("owner", [a.id, "cccccccc-0000-4000-8000-00000000ffff"], { decision: "approve" }), { kind: "refused", code: "session_not_found", index: 1 });
  assert.equal(store.sessions[0]?.status, "pending");
  assert.equal(store.decisionsList.length, 0);
  assert.deepEqual(await svc.decideSessions("owner", [], { decision: "approve" }), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.decideSessions("owner", Array.from({ length: 201 }, () => a.id), { decision: "approve" }), { kind: "refused", code: "too_many" });
  const b = session();
  store.sessions.push(b);
  const ok = await svc.decideSessions("owner", [a.id, b.id], { decision: "approve" });
  assert.equal(ok.kind === "decided" && ok.decisions.length, 2);
  assert.equal(ok.kind === "decided" && ok.decisions[0]?.batchId !== null && ok.decisions[0]?.batchId === ok.decisions[1]?.batchId, true);
});

test("W4_REPLACED a session replaced by a correction is not decided", async () => {
  const { store, svc } = setup();
  const a = session();
  store.sessions.push(a);
  store.replaced.add(a.id);
  assert.deepEqual(await svc.decideSessions("owner", [a.id], { decision: "approve" }), { kind: "refused", code: "session_replaced", index: 0 });
});

test("W4_DAY a day decision changes pending closed sessions only, never earlier decisions or open sessions", async () => {
  const { store, svc } = setup();
  const pending1 = session(), pending2 = session(), rejected = session({ status: "rejected" }), open = session({ endedAt: null, durationSeconds: null });
  store.sessions.push(pending1, pending2, rejected, open);
  const out = await svc.decideDays("owner", [{ personId: "person", storeId: STORE_A, workDate: "2026-11-18" }], { decision: "approve" });
  assert.equal(out.kind === "decided" && out.changed, 2);
  assert.deepEqual(store.sessions.map((s) => s.status), ["approved", "approved", "rejected", "pending"]);
  assert.equal(store.decisionsList.length, 1);
  assert.deepEqual(store.decisionsList[0]?.sessionIds, [pending1.id, pending2.id]);
  assert.deepEqual(store.events.map((e) => e.kind), ["session.approved", "session.approved"]);
});

test("W4_DAY bulk days roll back together when one day is missing or out of scope", async () => {
  const { store, svc } = setup();
  store.sessions.push(session(), session({ storeId: RIVAL_STORE }));
  const good = { personId: "person", storeId: STORE_A, workDate: "2026-11-18" };
  assert.deepEqual(await svc.decideDays("owner", [good, { ...good, workDate: "2026-11-17" }], { decision: "approve" }), { kind: "refused", code: "day_not_found", index: 1 });
  assert.deepEqual(await svc.decideDays("owner", [good, { ...good, storeId: RIVAL_STORE }], { decision: "approve" }), { kind: "refused", code: "day_not_found", index: 1 });
  assert.deepEqual(await svc.decideDays("owner", [{ ...good, extra: 1 }], { decision: "approve" }), { kind: "refused", code: "invalid_input" });
  assert.equal(store.decisionsList.length, 0);
  assert.equal(store.sessions[0]?.status, "pending");
});

test("W4_DAY days lock in one stable order and the scope reads no second pool client inside the transaction", async () => {
  const { store, svc } = setup();
  store.sessions.push(session({ workDate: "2026-11-17" }), session());
  const day = (workDate: string) => ({ personId: "person", storeId: STORE_A, workDate });
  const out = await svc.decideDays("owner", [day("2026-11-18"), day("2026-11-17")], { decision: "approve" });
  assert.deepEqual(out.kind === "decided" && out.decisions.map((d) => d.workDate), ["2026-11-18", "2026-11-17"]);
  assert.deepEqual(store.lockedDays, [`${STORE_A}|2026-11-17`, `${STORE_A}|2026-11-18`]);
  assert.equal((await svc.decideSessions("owner", [store.sessions[0]!.id], { decision: "reject" })).kind, "decided");
  assert.equal((await svc.undo("owner", store.sessions[0]!.id)).kind, "decided");
  assert.equal(store.poolReadsInTransaction, 0);
});

test("W4_DAY the same day named twice is decided once", async () => {
  const { store, svc } = setup();
  store.sessions.push(session());
  const day = { personId: "person", storeId: STORE_A, workDate: "2026-11-18" };
  const out = await svc.decideDays("owner", [day, { ...day, storeId: STORE_A.toUpperCase() }], { decision: "approve" });
  assert.deepEqual(out.kind === "decided" && [out.decisions.length, out.changed], [1, 1]);
  assert.deepEqual([store.decisionsList.length, store.notices.length], [1, 1]);
});

test("W4_UNDO undo returns a decided session to pending with its own record", async () => {
  const { store, svc } = setup();
  const a = session();
  store.sessions.push(a);
  assert.deepEqual(await svc.undo("owner", a.id), { kind: "refused", code: "not_decided" });
  await svc.decideSessions("owner", [a.id], { decision: "reject", reason: "no show" });
  assert.deepEqual(await svc.undo("rivalOwner", a.id), { kind: "refused", code: "session_not_found" });
  const out = await svc.undo("owner", a.id, "mistake");
  assert.equal(out.kind, "decided");
  assert.equal(store.sessions[0]?.status, "pending");
  assert.deepEqual(store.decisionsList.map((d) => [d.outcome, d.reason]), [["rejected", "no show"], ["undone", "mistake"]]);
  assert.equal(store.sessions[0]?.decisionId, store.decisionsList[1]?.id);
  assert.deepEqual(store.events.map((e) => e.kind), ["session.rejected", "session.undone"]);
});

test("W4_NOTIFY the person hears each decision once; a re-decision or undo withdraws the earlier one", async () => {
  const { store, svc } = setup();
  const a = session({ storeId: STORE_A });
  const b = session({ storeId: STORE_A, startedAt: "2026-11-18T09:00:00.000Z", endedAt: "2026-11-18T10:00:00.000Z" });
  store.sessions.push(a, b);
  const first = await svc.decideDays("owner", [{ personId: "person", storeId: STORE_A, workDate: "2026-11-18" }], { decision: "approve" });
  assert.equal(first.kind, "decided");
  const dayId = first.kind === "decided" ? first.decisions[0]!.id : "";
  assert.deepEqual(store.notices.map((n) => [n.kind, n.sessionId]).sort(), [["decided", a.id], ["decided", b.id]].sort());
  store.notices = [];
  const again = await svc.decideSessions("owner", [a.id], { decision: "reject", reason: "late" });
  const rejectId = again.kind === "decided" ? again.decisions[0]!.id : "";
  assert.deepEqual(store.notices, [
    { kind: "undone", personId: "person", sessionId: a.id, withdrawnDecisionId: dayId },
    { kind: "decided", personId: "person", sessionId: a.id, decisionId: rejectId, outcome: "rejected", workDate: "2026-11-18" },
  ]);
  store.notices = [];
  await svc.undo("owner", a.id);
  assert.deepEqual(store.notices, [{ kind: "undone", personId: "person", sessionId: a.id, withdrawnDecisionId: rejectId }]);
  store.notices = [];
  // A refused batch tells nobody.
  await svc.decideSessions("owner", [b.id, "00000000-0000-4000-8000-00000000ffff"], { decision: "reject" });
  assert.deepEqual(store.notices, []);
});

test("W5_PARSE ranges are bound dates of at most a year; cursors are strict", () => {
  assert.deepEqual(parseRange("2026-11-01", "2026-11-30"), { from: "2026-11-01", to: "2026-11-30" });
  assert.equal(parseRange("2026-11-30", "2026-11-01"), undefined);
  assert.equal(parseRange("2026-11-01') OR 1=1 --", "2026-11-30"), undefined);
  assert.equal(parseRange("2025-11-01", "2026-11-30"), undefined);
  assert.equal(parseCursor(undefined), null);
  assert.deepEqual(parseCursor("2026-11-18~BBBBBBBB-0000-4000-8000-000000000001"), { workDate: "2026-11-18", id: "bbbbbbbb-0000-4000-8000-000000000001" });
  assert.equal(parseCursor("2026-11-18~x"), undefined);
  assert.equal(parseCursor("2026-11-18~bbbbbbbb-0000-4000-8000-000000000001~z"), undefined);
});

test("W5_PRIVATE the person never sees the rating, nor a note the employer kept private", () => {
  const base: WorkDecision = { id: "d", orgId: "company", storeId: STORE_A, personId: "person", workDate: "2026-11-18", scope: "session", outcome: "rejected", sessionIds: [], reason: "late", note: "internal", rating: 2, notePublic: false, batchId: null, decidedBy: "owner", decidedAt: "t" };
  assert.deepEqual(personDecisionView(base), { outcome: "rejected", reason: "late", note: null, decidedAt: "t" });
  assert.deepEqual(personDecisionView({ ...base, notePublic: true }), { outcome: "rejected", reason: "late", note: "internal", decidedAt: "t" });
  assert.equal(JSON.stringify(personDecisionView(base)).includes("rating"), false);
  assert.equal(employerDecisionView(base).rating, 2);
});

test("W5_VIEWS each viewer sees only their scope; totals split by status across all pages", async () => {
  const { store, svc, views } = setup();
  const range = { from: "2026-11-01", to: "2026-11-30" };
  const mine = session(), other = session({ personId: "other" }), storeB = session({ storeId: STORE_B }), rival = session({ storeId: RIVAL_STORE });
  store.sessions.push(mine, other, storeB, rival, session({ endedAt: null, durationSeconds: null, workDate: "2026-11-19" }));
  await svc.decideSessions("owner", [mine.id], { decision: "approve", note: "private", rating: 3 });
  const page = await views.mine("person", range, null);
  assert.deepEqual(page.rows.map((r) => r.session.id).includes(other.id), false);
  assert.deepEqual(page.rows.find((r) => r.session.id === mine.id)?.decision, { outcome: "approved", reason: null, note: null, decidedAt: "2026-11-19T06:00:00.000Z" });
  assert.deepEqual(page.totals, { approvedSeconds: 7200, pendingSeconds: 7200 * 2, rejectedSeconds: 0, open: 1 });
  // A single-session lookup reads only the person's own session on that day.
  assert.deepEqual((await views.mineSession("person", mine.workDate, mine.id.toUpperCase()))?.decision?.outcome, "approved");
  for (const [date, id] of [[mine.workDate, other.id], ["2026-11-01", mine.id], ["nope", mine.id], [mine.workDate, "x"]] as const) assert.equal(await views.mineSession("person", date, id), undefined, `${date} ${id}`);
  const company = await views.company("owner", "company", range);
  assert.equal("rows" in company && company.rows.length, 5 - 1);
  assert.equal("rows" in company && company.rows.find((r) => r.session.id === mine.id)?.decision?.rating, 3);
  assert.deepEqual(await views.company("rivalOwner", "company", range), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await views.company("person", "company", range), { kind: "refused", code: "forbidden" });
  const manager = await views.company("manager", "company", range);
  assert.equal("rows" in manager && manager.rows.every((r) => r.session.storeId === STORE_A), true);
  assert.deepEqual(await views.company("manager", "company", range, { storeId: STORE_B }), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await views.all("owner", range), { kind: "refused", code: "forbidden" });
  // The A-13 correction form looks one session up by id, for operator staff only.
  assert.equal((await views.staffSession("staff", other.workDate, other.id.toUpperCase()))?.session.id, other.id);
  for (const [actor, date, id] of [["owner", other.workDate, other.id], ["staff", "2026-11-01", other.id], ["staff", "nope", other.id], ["staff", other.workDate, "x"]] as const) {
    assert.equal(await views.staffSession(actor, date, id), undefined, `${actor} ${date} ${id}`);
  }
  const all = await views.all("staff", range);
  assert.equal("rows" in all && all.rows.length, 5);
  // A group owner's sub-companies are in reach only through a subtree grant; a self-scoped one sees the group alone.
  const group = await views.company("groupOwner", "group", range);
  assert.equal("rows" in group && group.rows.length, 4);
  const groupSelf = await views.company("groupSelfOwner", "group", range);
  assert.deepEqual("rows" in groupSelf && [groupSelf.rows.length, groupSelf.totals], [0, { approvedSeconds: 0, pendingSeconds: 0, rejectedSeconds: 0, open: 0 }]);
  assert.deepEqual(await views.company("groupSelfOwner", "company", range), { kind: "refused", code: "forbidden" });
});

test("W5_VIEWS a revoked grant stops at the next request (the shared scope keeps no grants)", async () => {
  const { store, views } = setup();
  store.sessions.push(session());
  const range = { from: "2026-11-01", to: "2026-11-30" };
  GRANTS.revocable = [{ orgId: "company", role: "org-owner", scope: "self" }];
  assert.equal("rows" in await views.company("revocable", "company", range), true);
  GRANTS.revocable = [];
  assert.deepEqual(await views.company("revocable", "company", range), { kind: "refused", code: "forbidden" });
});

test("W5_PAGING paging is stable across equal dates and ends with no cursor", async () => {
  const { store, views } = setup();
  for (let i = 0; i < 205; i++) store.sessions.push(session({ workDate: i < 150 ? "2026-11-18" : "2026-11-19" }));
  const seen: string[] = [];
  let after = null as ReturnType<typeof parseCursor>;
  for (let i = 0; i < 5; i++) {
    const page = await views.mine("person", { from: "2026-11-01", to: "2026-11-30" }, after ?? null);
    seen.push(...page.rows.map((r) => r.session.id));
    after = page.next;
    if (!after) break;
  }
  assert.equal(seen.length, 205);
  assert.equal(new Set(seen).size, 205);
  assert.equal(after, null);
});
