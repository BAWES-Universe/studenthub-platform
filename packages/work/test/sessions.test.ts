import assert from "node:assert/strict";
import { test } from "node:test";
import {
  kuwaitDate, parseInstant, parseLocation, SessionConflict, SessionService, sessionConflict, splitSeconds,
  type Assignment, type NewSession, type SessionStore, type SessionTransaction, type WorkEvent, type WorkSession,
} from "../src/index.js";

const ASSIGNMENT: Assignment = {
  id: "a-1", personId: "person", orgId: "company", storeId: "store", payContractId: "c-1",
  contractResolution: { version: "studenthub.pay-rate-resolution.v1", steps: [], matchedContractIds: ["c-1"], contractId: "c-1" },
  startDate: "2026-11-01", endDate: "2026-11-30", warnings: [], source: "staff", requestId: null, recruitCardId: null, recruitRequestId: null, createdBy: "staff", createdAt: "2026-11-01T00:00:00Z",
};
const HERE = { latitude: 29.3759, longitude: 47.9774 };
const THERE = { latitude: 29.3117, longitude: 47.4818 };

class MemorySessions implements SessionStore {
  sessions: WorkSession[] = [];
  events: WorkEvent[] = [];
  assignments = [ASSIGNMENT];
  async assignmentOn(personId: string, date: string) { return this.assignments.find((a) => a.personId === personId && a.startDate <= date && (a.endDate === null || a.endDate >= date)); }
  async assignment(id: string) { return this.assignments.find((a) => a.id === id); }
  async open(personId: string) { return this.sessions.find((s) => s.personId === personId && s.endedAt === null && s.deletedAt === null); }
  async transaction<T>(work: (tx: SessionTransaction) => Promise<T>): Promise<T> {
    const live = (s: WorkSession) => s.deletedAt === null;
    const overlaps = (personId: string, id: string, start: number, end: number) => this.sessions.some((s) => live(s) && s.personId === personId && s.id !== id &&
      Date.parse(s.startedAt) < end && (s.endedAt === null ? Infinity : Date.parse(s.endedAt)) > start);
    const tx: SessionTransaction = {
      insert: async (n: NewSession) => {
        if (n.endedAt === null && this.sessions.some((s) => live(s) && s.personId === n.personId && s.endedAt === null)) throw new SessionConflict("already_open");
        if (overlaps(n.personId, n.id, n.startedAt.getTime(), n.endedAt?.getTime() ?? Infinity)) throw new SessionConflict("overlap");
        const s: WorkSession = {
          id: n.id, assignmentId: n.assignmentId, personId: n.personId, orgId: n.orgId, storeId: n.storeId, workDate: n.workDate,
          startedAt: n.startedAt.toISOString(), endedAt: n.endedAt?.toISOString() ?? null,
          durationSeconds: n.endedAt ? Math.floor((n.endedAt.getTime() - n.startedAt.getTime()) / 1000) : null,
          startLocation: n.startLocation, endLocation: n.endLocation, source: n.source, status: n.status, flags: n.flags, note: n.note,
          correctsSessionId: n.correctsSessionId, deletedAt: null, createdBy: n.createdBy, createdAt: n.startedAt.toISOString(),
        };
        this.sessions.push(s);
        return s;
      },
      lockOpen: async (personId) => this.open(personId),
      lock: async (id) => this.sessions.find((s) => s.id === id),
      close: async (id, endedAt, endLocation) => {
        const i = this.sessions.findIndex((s) => s.id === id);
        const s = this.sessions[i]!;
        const closed = { ...s, endedAt: endedAt.toISOString(), endLocation, durationSeconds: Math.floor((endedAt.getTime() - Date.parse(s.startedAt)) / 1000) };
        this.sessions[i] = closed;
        return closed;
      },
      softDelete: async (id) => { const i = this.sessions.findIndex((s) => s.id === id); this.sessions[i] = { ...this.sessions[i]!, deletedAt: "now" }; },
      restore: async (id) => { const i = this.sessions.findIndex((s) => s.id === id); this.sessions[i] = { ...this.sessions[i]!, deletedAt: null }; },
      event: async (e) => { this.events.push(e); },
    };
    return work(tx);
  }
}

function service(now: { value: Date }) {
  const store = new MemorySessions();
  let ids = 0;
  return { store, svc: new SessionService({ store, newId: () => `s-${++ids}`, now: () => now.value }) };
}

test("W3_LOCATION coordinates are required, range-checked and rounded to six places", () => {
  assert.deepEqual(parseLocation("29.37591234", "47.9774"), { latitude: 29.375912, longitude: 47.9774 });
  assert.deepEqual(parseLocation(0, 0), { latitude: 0, longitude: 0 });
  assert.equal(parseLocation("", "47"), undefined);
  assert.equal(parseLocation(91, 0), undefined);
  assert.equal(parseLocation(0, -181), undefined);
  assert.equal(parseLocation("abc", 1), undefined);
  assert.equal(parseLocation(Number.NaN, 1), undefined);
  assert.equal(parseLocation(undefined, undefined), undefined);
});

test("W3_INSTANT manual times need an explicit offset", () => {
  assert.equal(parseInstant("2026-11-18T09:00:00+03:00")?.toISOString(), "2026-11-18T06:00:00.000Z");
  assert.equal(parseInstant("2026-11-18T09:00Z")?.toISOString(), "2026-11-18T09:00:00.000Z");
  assert.equal(parseInstant("2026-11-18T09:00:00"), undefined);
  assert.equal(parseInstant("2026-11-18"), undefined);
  assert.equal(parseInstant("2026-13-18T09:00:00Z"), undefined);
});

test("W3_CLOCK start then stop: server time, both locations kept (WK-F2 regression)", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  const started = await svc.start("person", HERE);
  assert.equal(started.kind, "started");
  assert.equal(started.kind === "started" && started.session.workDate, "2026-11-18");
  now.value = new Date("2026-11-18T09:25:09.900Z");
  const stopped = await svc.stop("person", THERE);
  assert.equal(stopped.kind, "stopped");
  const s = stopped.kind === "stopped" ? stopped.session : undefined;
  assert.deepEqual(s?.startLocation, HERE);
  assert.deepEqual(s?.endLocation, THERE);
  assert.equal(s?.durationSeconds, 12309);
  assert.deepEqual(splitSeconds(12309), { hours: 3, minutes: 25, seconds: 9 });
  assert.deepEqual(store.events.map((e) => [e.kind, e.actorId]), [["session.started", "person"], ["session.stopped", "person"]]);
});

test("W3_CLOCK start needs a location, a placement today and no open session", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  assert.deepEqual(await svc.start("person", undefined), { kind: "refused", code: "location_required" });
  assert.deepEqual(await svc.start("stranger", HERE), { kind: "refused", code: "not_assigned" });
  assert.equal((await svc.start("person", HERE)).kind, "started");
  assert.deepEqual(await svc.start("person", HERE), { kind: "refused", code: "already_working" });
  assert.equal(store.sessions.length, 1);
  now.value = new Date("2026-12-01T06:00:00Z");
  assert.deepEqual(await svc.start("stranger", HERE), { kind: "refused", code: "not_assigned" });
});

test("W3_CLOCK a parallel start that loses the race is refused, not a second open session", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  // Simulate the race: lockOpen sees nothing, but the unique index fires on insert.
  const original = store.transaction.bind(store);
  store.transaction = async (work) => original(async (tx) => work({ ...tx, lockOpen: async () => undefined, insert: async () => { throw Object.assign(new Error("dup"), { code: "23505", constraint: "work_sessions_one_open" }); } }));
  assert.deepEqual(await svc.start("person", HERE), { kind: "refused", code: "already_working" });
});

test("W3_CLOCK stop needs an open session and a location; discard soft-deletes it", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  assert.deepEqual(await svc.stop("person", THERE), { kind: "refused", code: "not_working" });
  await svc.start("person", HERE);
  assert.deepEqual(await svc.stop("person", undefined), { kind: "refused", code: "location_required" });
  assert.deepEqual(await svc.discard("person"), { kind: "discarded" });
  assert.equal(store.sessions[0]?.deletedAt, "now");
  assert.deepEqual(await svc.discard("person"), { kind: "refused", code: "not_working" });
  assert.equal((await svc.start("person", HERE)).kind, "started");
});

test("W3_MIDNIGHT a session past midnight keeps its start date", async () => {
  const now = { value: new Date("2026-11-18T20:30:00Z") }; // 23:30 Kuwait
  const { svc } = service(now);
  await svc.start("person", HERE);
  now.value = new Date("2026-11-18T22:00:00Z"); // 01:00 Kuwait, next day
  const out = await svc.stop("person", THERE);
  assert.equal(out.kind === "stopped" && out.session.workDate, "2026-11-18");
  assert.equal(kuwaitDate(now.value), "2026-11-19");
});

test("W3_MANUAL manual entry is validated, pending and flagged late", async () => {
  const now = { value: new Date("2026-11-18T12:00:00Z") };
  const { store, svc } = service(now);
  assert.deepEqual(await svc.addManual("person", { startedAt: "2026-11-17T10:00:00+03:00", endedAt: "2026-11-17T09:00:00+03:00" }), { kind: "refused", code: "end_before_start" });
  assert.deepEqual(await svc.addManual("person", { startedAt: "2026-11-17T10:00:00+03:00", endedAt: "2026-11-17T10:00:00+03:00" }), { kind: "refused", code: "end_before_start" });
  assert.deepEqual(await svc.addManual("person", { startedAt: "2026-11-17T10:00:00+03:00" , endedAt: undefined }), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.addManual("person", { startedAt: "2026-11-18T14:00:00+03:00", endedAt: "2026-11-18T16:00:00+03:00" }), { kind: "refused", code: "in_future" });
  assert.deepEqual(await svc.addManual("person", { startedAt: "2026-10-31T10:00:00+03:00", endedAt: "2026-10-31T12:00:00+03:00" }), { kind: "refused", code: "outside_assignment" });
  const ok = await svc.addManual("person", { startedAt: "2026-11-17T10:00:00+03:00", endedAt: "2026-11-17T12:30:00+03:00", note: "forgot to clock in" });
  assert.equal(ok.kind, "added");
  const s = ok.kind === "added" ? ok.session : undefined;
  assert.equal(s?.status, "pending");
  assert.equal(s?.source, "manual");
  assert.deepEqual(s?.flags, ["late_entry"]);
  assert.equal(s?.durationSeconds, 9000);
  assert.deepEqual(await svc.addManual("person", { startedAt: "2026-11-17T12:00:00+03:00", endedAt: "2026-11-17T13:00:00+03:00" }), { kind: "refused", code: "overlaps_session" });
  assert.equal(store.sessions.length, 1);
  assert.deepEqual(store.events.map((e) => e.kind), ["session.added"]);
});

test("W3_TODAY shows the open session and today's placement", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { svc } = service(now);
  assert.deepEqual(await svc.today("person"), { open: null, assignment: ASSIGNMENT });
  await svc.start("person", HERE);
  assert.equal((await svc.today("person")).open?.id, "s-1");
  assert.deepEqual(await svc.today("stranger"), { open: null, assignment: null });
});

test("W3_CONFLICT store errors map by SQLSTATE", () => {
  assert.equal(sessionConflict(new SessionConflict("overlap")), "overlap");
  assert.equal(sessionConflict({ code: "23505", constraint: "work_sessions_one_open" }), "already_open");
  assert.equal(sessionConflict({ code: "23505", constraint: "something_else" }), undefined);
  assert.equal(sessionConflict({ code: "23P01" }), "overlap");
  assert.equal(sessionConflict(new Error("x")), undefined);
  assert.throws(() => splitSeconds(-1));
});
