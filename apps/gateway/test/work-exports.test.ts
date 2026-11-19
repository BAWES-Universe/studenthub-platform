import assert from "node:assert/strict";
import test from "node:test";
import { ExportService as BaseService, EXPORT_ROW_CAP, type ExportStore, type StoredExport } from "../../../packages/exports/src/exports.js";
import { createExportsHttp } from "../src/exports-http.js";
import { companyHoursFilters, kuwaitTime, spelledDuration, workExportKinds } from "../src/work/exports.js";
import type { WorkHttpServices } from "../src/work/http.js";

const STORE = "aaaaaaaa-0000-4000-8000-000000000001", STORE2 = "aaaaaaaa-0000-4000-8000-000000000002";
const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
// The service as the gateway serves it: file() is the HTTP layer's, named after the stored kind.
class ExportService extends BaseService {
  readonly #http: ReturnType<typeof createExportsHttp>;
  constructor(store: Memory, kinds: ConstructorParameters<typeof BaseService>[1]) { super(store, kinds); this.#http = createExportsHttp({ get: async (id: string) => ({ id, personId: id }) } as never, this, store); }
  file(personId: string, exportId: string) { return this.#http.file!(personId, exportId); }
}
class Memory implements ExportStore { rows = new Map<string, StoredExport>(); async save(r: StoredExport) { this.rows.set(r.id, r); } async find(i: string) { return this.rows.get(i) ?? null; } async cleanExpired() { return 0; } }

function session(n: number, over: Record<string, unknown> = {}) {
  return { id: id(n), assignmentId: "a", personId: "p1", orgId: "co", storeId: STORE, workDate: "2026-11-18", startedAt: "2026-11-18T06:00:00.000Z", endedAt: "2026-11-18T08:30:05.000Z",
    durationSeconds: 9005, startLocation: null, endLocation: null, source: "timer", status: "approved", flags: [], note: null, correctsSessionId: null, decisionId: null, deletedAt: null,
    createdBy: "p1", createdAt: "2026-11-18T08:30:05.000Z", ...over };
}

interface World { allowed: Set<string>; sessions: unknown[]; pageSize?: number; history?: unknown[]; staff?: Set<string> }
function services(world: World, calls: unknown[][] = []): WorkHttpServices {
  return {
    views: {
      company: async (actor: string, orgId: string, range: unknown, options: { storeId?: string; status?: string; after?: { id: string } | null }) => {
        calls.push(["company", actor, orgId, range, { storeId: options.storeId, status: options.status }]);
        if (!world.allowed.has(actor)) return { kind: "refused", code: "forbidden" };
        const size = world.pageSize ?? 100;
        const start = options.after ? world.sessions.findIndex((s) => (s as { id: string }).id === options.after!.id) + 1 : 0;
        const rows = world.sessions.slice(start, start + size).map((s) => ({ session: s, decision: (s as { status: string }).status === "pending" ? null : { outcome: "approved", decidedAt: "2026-11-18T09:00:00.000Z" } }));
        const last = rows[rows.length - 1]?.session as { id: string; workDate: string } | undefined;
        return { rows, totals: {}, next: start + size < world.sessions.length && last ? { workDate: last.workDate, id: last.id } : null };
      },
    },
    placements: {
      history: async (actor: string, _range: unknown, after: { id: string } | null) => {
        if (!world.staff?.has(actor)) return undefined;
        return after ? { rows: (world.history ?? []).slice(1), next: null } : { rows: (world.history ?? []).slice(0, 1), next: (world.history ?? []).length > 1 ? { startDate: "x", id: "y" } : null };
      },
    },
    storeNames: async (ids: readonly string[]) => new Map(ids.map((i) => [i, i === STORE ? "Avenues" : "Marina, \"Mall\""])),
    personNames: async (ids: readonly string[]) => new Map(ids.filter((i) => i !== "nameless").map((i) => [i, i === "p1" ? "Sara" : "Ali"])),
    companyNames: async (ids: readonly string[]) => new Map(ids.map((i) => [i, "Coffee Co"])),
  } as unknown as WorkHttpServices;
}

const csv = (b: Buffer) => b.toString("utf8").replace(/^﻿/, "").trim().split(/\r?\n/);

test("WORK_EXPORT the helpers write Kuwait times and legacy's spelled durations", () => {
  assert.equal(kuwaitTime("2026-11-18T21:30:00.000Z"), "2026-11-19 00:30:00");
  assert.equal(kuwaitTime(null), "");
  assert.equal(spelledDuration(9005), "2 hour 30 minutes 5 seconds");
  assert.deepEqual(companyHoursFilters({ orgId: "co", from: "2026-11-01", to: "2026-11-18", storeId: STORE.toUpperCase(), status: "pending" }),
    { orgId: "co", from: "2026-11-01", to: "2026-11-18", storeId: STORE, status: "pending" });
  for (const bad of [{ orgId: "co", from: "2026-11-18", to: "2026-11-01" }, { orgId: "c o", from: "2026-11-01", to: "2026-11-18" }, { orgId: "co", from: "2026-11-01", to: "2026-11-18", status: "open" },
    { orgId: "co", from: "2026-11-01", to: "2026-11-18", storeId: "x" }, { orgId: "co", from: "2025-01-01", to: "2026-11-18" }]) assert.equal(companyHoursFilters(bad), undefined, JSON.stringify(bad));
});

test("WORK_EXPORT detailed: one row per session, every page, names and Kuwait times; download re-checks the actor", async () => {
  const world: World = { allowed: new Set(["owner"]), pageSize: 2, sessions: [
    session(1), session(2, { status: "pending", source: "manual", note: "forgot, sorry" }), session(3, { endedAt: null, durationSeconds: null, storeId: STORE2, personId: "p2" }),
  ] };
  const calls: unknown[][] = [];
  const store = new Memory(), service = new ExportService(store, workExportKinds(services(world, calls)));
  const filters = { orgId: "co", from: "2026-11-01", to: "2026-11-18", status: "approved", extra: "dropped" };
  const made = await service.request("owner", "work-log-detailed", filters);
  assert.ok(made.ok);
  assert.equal(made.rowCount, 3);
  const [head, ...rows] = csv((await service.file("owner", made.id))!.bytes);
  assert.equal(head, "Session ID,Person ID,Person,Store ID,Store,Date,Start time,End time,Total time,Total seconds,Note,Status,Via,Created at,Decided at");
  assert.equal(rows[0], `${id(1)},p1,Sara,${STORE},Avenues,2026-11-18,2026-11-18 09:00:00,2026-11-18 11:30:05,2 hour 30 minutes 5 seconds,9005,,Approved,Timer,2026-11-18 11:30:05,2026-11-18 12:00:00`);
  assert.match(rows[1]!, /"forgot, sorry",Pending,Entered late,2026-11-18 11:30:05,$/);
  assert.match(rows[2]!, /,p2,Ali,aaaaaaaa-0000-4000-8000-000000000002,"Marina, ""Mall""",2026-11-18,2026-11-18 09:00:00,,,,,In progress,Timer,/);
  // The filter is passed through as asked, unknown keys dropped and stored that way.
  assert.deepEqual(calls[0], ["company", "owner", "co", { from: "2026-11-01", to: "2026-11-18" }, { storeId: undefined, status: "approved" }]);
  assert.deepEqual([...store.rows.values()][0]!.filters, { orgId: "co", from: "2026-11-01", to: "2026-11-18", status: "approved" });
  assert.equal((await service.file("owner", made.id))?.kind, "work-log-detailed");
  // Someone else can't download it, and the owner can't once they lose the company.
  assert.equal(await service.file("other", made.id), null);
  world.allowed.delete("owner");
  assert.equal(await service.file("owner", made.id), null);
  // Refused at request time too, and audited.
  assert.deepEqual(await service.request("owner", "work-log-detailed", filters), { ok: false, reason: "not_found" });
  assert.equal([...store.rows.values()].filter((r) => r.outcome === "refused_authorization").length, 1);
  assert.deepEqual(await new ExportService(new Memory(), workExportKinds(services({ allowed: new Set(["owner"]), sessions: [] }))).request("owner", "work-log-detailed", { orgId: "co", from: "2026-11-18", to: "2026-11-01" }),
    { ok: false, reason: "not_found" }, "a reversed range is refused");
});

test("WORK_EXPORT detailed: over 10,000 sessions is refused without reading every page", async () => {
  const sessions = Array.from({ length: EXPORT_ROW_CAP + 150 }, (_, i) => session(i + 1));
  const calls: unknown[][] = [];
  const service = new ExportService(new Memory(), workExportKinds(services({ allowed: new Set(["owner"]), sessions, pageSize: 100 }, calls)));
  assert.deepEqual(await service.request("owner", "work-log-detailed", { orgId: "co", from: "2026-11-01", to: "2026-11-18" }), { ok: false, reason: "row_limit" });
  // One authorisation call plus the pages up to one row past the cap.
  assert.equal(calls.length, 1 + Math.ceil((EXPORT_ROW_CAP + 1) / 100));
});

test("WORK_EXPORT summary: hours per person and store with the status split; open hours count nowhere", async () => {
  const world: World = { allowed: new Set(["owner"]), sessions: [
    session(1, { durationSeconds: 3600 }), session(2, { status: "pending", durationSeconds: 1800 }), session(3, { status: "rejected", durationSeconds: 65 }),
    session(4, { endedAt: null, durationSeconds: null, personId: "p3" }), session(5, { personId: "p2", storeId: STORE2, durationSeconds: 7200 }), session(6, { personId: "nameless", durationSeconds: 1 }),
  ] };
  const service = new ExportService(new Memory(), workExportKinds(services(world)));
  const made = await service.request("owner", "work-log-summary", { orgId: "co", from: "2026-11-01", to: "2026-11-18" });
  assert.ok(made.ok);
  assert.deepEqual(csv((await service.file("owner", made.id))!.bytes), [
    "Person ID,Person,Company,Store,Hours,Minutes,Seconds,Approved,Waiting,Rejected",
    "nameless,,Coffee Co,Avenues,0,0,1,0:00:01,0:00:00,0:00:00",
    `p2,Ali,Coffee Co,"Marina, ""Mall""",2,0,0,2:00:00,0:00:00,0:00:00`,
    "p1,Sara,Coffee Co,Avenues,1,31,5,1:00:00,0:30:00,0:01:05",
  ]);
  assert.deepEqual(await service.request("stranger", "work-log-summary", { orgId: "co", from: "2026-11-01", to: "2026-11-18" }), { ok: false, reason: "not_found" });
});

test("WORK_EXPORT assigned history: staff only, every page, open ends left blank", async () => {
  const a = (n: number, over: Record<string, unknown> = {}) => ({ id: id(n), personId: "p1", orgId: "co", storeId: STORE, startDate: "2026-01-01", endDate: "2026-03-31", ...over });
  const world: World = { allowed: new Set(), sessions: [], staff: new Set(["staff"]), history: [a(1), a(2, { personId: "p2", storeId: STORE2, startDate: "2026-04-01", endDate: null })] };
  const service = new ExportService(new Memory(), workExportKinds(services(world)));
  const made = await service.request("staff", "work-assigned-history", { from: "2026-01-01", to: "2026-11-18" });
  assert.ok(made.ok);
  assert.deepEqual(csv((await service.file("staff", made.id))!.bytes), [
    "Person ID,Person,Start date,End date,Company,Store",
    `p1,Sara,2026-01-01,2026-03-31,Coffee Co,Avenues`,
    `p2,Ali,2026-04-01,,Coffee Co,"Marina, ""Mall"""`,
  ]);
  assert.deepEqual(await service.request("owner", "work-assigned-history", { from: "2026-01-01", to: "2026-11-18" }), { ok: false, reason: "not_found" });
  assert.deepEqual(await service.request("staff", "work-assigned-history", { from: "2026-11-18", to: "2026-01-01" }), { ok: false, reason: "not_found" });
  world.staff!.delete("staff");
  assert.equal(await service.file("staff", made.id), null, "download re-checks staff");
});
