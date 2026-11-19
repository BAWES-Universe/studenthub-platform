import assert from "node:assert/strict";
import { test } from "node:test";
import { StaffTimeService, STAFF_DAY_PAGE_SIZE, type StaffDay, type StaffSession, type StaffTimeStore, type WorkGrant } from "../src/index.js";

class Memory implements StaffTimeStore {
  sessions: StaffSession[] = [];
  staff = ["admin", "staff", "staff-2"];
  raceOnInsert = false;
  async openSession(staffId: string, workDate: string) { return this.sessions.find((s) => s.staffId === staffId && s.workDate === workDate && s.endedAt === null); }
  async insertOpen(s: { id: string; staffId: string; workDate: string; startedAt: Date }) {
    if (this.raceOnInsert) { this.raceOnInsert = false; this.sessions.push({ id: "raced", staffId: s.staffId, workDate: s.workDate, startedAt: s.startedAt.toISOString(), endedAt: null, minutes: null, source: "timer" }); return "exists" as const; }
    if (await this.openSession(s.staffId, s.workDate)) return "exists" as const;
    this.sessions.push({ id: s.id, staffId: s.staffId, workDate: s.workDate, startedAt: s.startedAt.toISOString(), endedAt: null, minutes: null, source: "timer" });
    return "inserted" as const;
  }
  async end(id: string, endedAt: Date) {
    const i = this.sessions.findIndex((s) => s.id === id && s.endedAt === null);
    if (i < 0) return undefined;
    const s = this.sessions[i]!;
    const end = Math.max(endedAt.getTime(), Date.parse(s.startedAt));
    this.sessions[i] = { ...s, endedAt: new Date(end).toISOString(), minutes: Math.floor((end - Date.parse(s.startedAt)) / 60000) };
    return this.sessions[i];
  }
  async sessionsOn(staffId: string, workDate: string) { return this.sessions.filter((s) => s.staffId === staffId && s.workDate === workDate); }
  async days(f: { range: { from: string; to: string }; staffId?: string; after?: { workDate: string; staffId: string }; limit: number }) {
    const map = new Map<string, StaffDay>();
    for (const s of this.sessions) {
      if (s.workDate < f.range.from || s.workDate > f.range.to || (f.staffId && s.staffId !== f.staffId)) continue;
      const key = `${s.workDate}|${s.staffId}`, d = map.get(key);
      map.set(key, { staffId: s.staffId, workDate: s.workDate, minutes: (d?.minutes ?? 0) + (s.minutes ?? 0), sessions: (d?.sessions ?? 0) + 1, open: (d?.open ?? false) || s.endedAt === null,
        firstStart: d && d.firstStart < s.startedAt ? d.firstStart : s.startedAt, lastEnd: s.endedAt ?? d?.lastEnd ?? null });
    }
    const after = (d: StaffDay) => !f.after || d.workDate < f.after.workDate || (d.workDate === f.after.workDate && d.staffId > f.after.staffId);
    return [...map.values()].filter(after).sort((a, b) => b.workDate.localeCompare(a.workDate) || a.staffId.localeCompare(b.staffId)).slice(0, f.limit);
  }
  async operatorStaff() { return this.staff; }
  async staffWithSessionOn(date: string) { return new Set(this.sessions.filter((s) => s.workDate === date).map((s) => s.staffId)); }
}

const GRANTS: Record<string, WorkGrant[]> = {
  admin: [{ orgId: "root", role: "admin", scope: "subtree" }],
  staff: [{ orgId: "root", role: "staff", scope: "subtree" }],
  "staff-2": [{ orgId: "root", role: "staff", scope: "subtree" }],
  groupStaff: [{ orgId: "group", role: "staff", scope: "subtree" }],
  selfAdmin: [{ orgId: "root", role: "admin", scope: "self" }],
  owner: [{ orgId: "company", role: "org-owner", scope: "self" }],
};
function service(now: { value: Date }, store = new Memory()) {
  let n = 0;
  return { store, svc: new StaffTimeService({ store, grants: { listGrantsForPrincipal: async (id) => GRANTS[id] ?? [] }, newId: () => `s-${++n}`, now: () => now.value }) };
}

test("STAFF_TIME a staff member starts and ends their Kuwait day; a second start returns the open session", async () => {
  // 21:30Z on the 17th is 00:30 on the 18th in Kuwait.
  const now = { value: new Date("2026-11-17T21:30:00Z") };
  const { store, svc } = service(now);
  const started = await svc.start("staff");
  assert.equal(started.kind, "started");
  assert.equal(started.kind === "started" && started.session.workDate, "2026-11-18");
  assert.equal(started.kind === "started" && started.already, false);
  now.value = new Date("2026-11-17T22:00:00Z");
  const again = await svc.start("staff");
  assert.deepEqual(again.kind === "started" && [again.already, again.session.id], [true, "s-1"]);
  assert.equal(store.sessions.length, 1);
  now.value = new Date("2026-11-18T00:15:59Z");
  const ended = await svc.end("staff");
  assert.equal(ended.kind === "ended" && ended.session.minutes, 165);
  assert.deepEqual(await svc.end("staff"), { kind: "refused", code: "not_working" });
  // A new session the same day is a second session, as legacy allowed.
  assert.equal((await svc.start("staff")).kind, "started");
  assert.equal(store.sessions.length, 2);
  const today = await svc.today("staff");
  assert.equal(today.kind === "today" && today.sessions.length, 2);
});

test("STAFF_TIME a session left open on an earlier day is not ended for the staff member", async () => {
  const now = { value: new Date("2026-11-17T06:00:00Z") };
  const { store, svc } = service(now);
  await svc.start("staff");
  now.value = new Date("2026-11-18T06:00:00Z");
  assert.deepEqual(await svc.end("staff"), { kind: "refused", code: "not_working" });
  assert.equal(store.sessions[0]!.endedAt, null);
  const started = await svc.start("staff");
  assert.equal(started.kind === "started" && started.session.workDate, "2026-11-18");
});

test("STAFF_TIME a parallel start that won the race is returned, not a second session", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  store.raceOnInsert = true;
  const out = await svc.start("staff");
  assert.deepEqual(out.kind === "started" && [out.session.id, out.already], ["raced", true]);
  assert.equal(store.sessions.length, 1);
});

test("STAFF_TIME only operator staff time their day", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  for (const actor of ["groupStaff", "selfAdmin", "owner", "nobody"]) {
    assert.deepEqual(await svc.start(actor), { kind: "refused", code: "forbidden" }, actor);
    assert.deepEqual(await svc.end(actor), { kind: "refused", code: "forbidden" }, actor);
    assert.deepEqual(await svc.today(actor), { kind: "refused", code: "forbidden" }, actor);
  }
  assert.equal(store.sessions.length, 0);
  assert.equal((await svc.start("admin")).kind, "started", "an admin times their own day too");
});

test("STAFF_TIME_LIST an admin sees everyone's days; a staff member only their own; ranges and cursors are checked", async () => {
  const now = { value: new Date("2026-11-16T06:00:00Z") };
  const { svc } = service(now);
  for (const day of ["16", "17", "18"]) {
    now.value = new Date(`2026-11-${day}T06:00:00Z`);
    await svc.start("staff"); await svc.start("staff-2");
    now.value = new Date(`2026-11-${day}T08:00:00Z`);
    await svc.end("staff");
  }
  const all = await svc.days("admin", "2026-11-01", "2026-11-18");
  assert.deepEqual(all.kind === "days" && all.days.map((d) => [d.workDate, d.staffId, d.minutes, d.open]), [
    ["2026-11-18", "staff", 120, false], ["2026-11-18", "staff-2", 0, true],
    ["2026-11-17", "staff", 120, false], ["2026-11-17", "staff-2", 0, true],
    ["2026-11-16", "staff", 120, false], ["2026-11-16", "staff-2", 0, true],
  ]);
  const one = await svc.days("admin", "2026-11-01", "2026-11-18", { staffId: "staff-2" });
  assert.equal(one.kind === "days" && one.days.every((d) => d.staffId === "staff-2"), true);
  const own = await svc.days("staff", "2026-11-01", "2026-11-18");
  assert.deepEqual(own.kind === "days" && [...new Set(own.days.map((d) => d.staffId))], ["staff"]);
  assert.deepEqual(await svc.days("staff", "2026-11-01", "2026-11-18", { staffId: "staff-2" }), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await svc.days("owner", "2026-11-01", "2026-11-18"), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await svc.days("admin", "2026-11-18", "2026-11-01"), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.days("admin", "2025-01-01", "2026-11-18"), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.days("admin", "2026-11-01", "2026-11-18", { after: { workDate: "2026-02-30", staffId: "x" } }), { kind: "refused", code: "invalid_input" });
  const next = await svc.days("admin", "2026-11-01", "2026-11-18", { after: { workDate: "2026-11-17", staffId: "staff" } });
  assert.deepEqual(next.kind === "days" && next.days.map((d) => `${d.workDate} ${d.staffId}`), ["2026-11-17 staff-2", "2026-11-16 staff", "2026-11-16 staff-2"]);
});

test("STAFF_TIME_LIST days are paged", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  store.staff = Array.from({ length: STAFF_DAY_PAGE_SIZE + 1 }, (_, i) => `p-${String(i).padStart(3, "0")}`);
  for (const id of store.staff) store.sessions.push({ id, staffId: id, workDate: "2026-11-18", startedAt: "2026-11-18T06:00:00.000Z", endedAt: null, minutes: null, source: "timer" });
  const first = await svc.days("admin", "2026-11-01", "2026-11-18");
  assert.equal(first.kind === "days" && first.days.length, STAFF_DAY_PAGE_SIZE);
  assert.ok(first.kind === "days" && first.next);
  const second = await svc.days("admin", "2026-11-01", "2026-11-18", { after: first.kind === "days" ? first.next : null });
  assert.deepEqual(second.kind === "days" && [second.days.length, second.next], [1, null]);
});

test("STAFF_TIME_INACTIVE admins see the staff who didn't start on a date", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { svc } = service(now);
  await svc.start("staff");
  assert.deepEqual(await svc.inactive("admin", "2026-11-18"), { kind: "inactive", workDate: "2026-11-18", staffIds: ["admin", "staff-2"] });
  assert.deepEqual(await svc.inactive("admin", "2026-11-17"), { kind: "inactive", workDate: "2026-11-17", staffIds: ["admin", "staff", "staff-2"] });
  assert.deepEqual(await svc.inactive("staff", "2026-11-18"), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await svc.inactive("admin", "2026-02-30"), { kind: "refused", code: "invalid_input" });
});
