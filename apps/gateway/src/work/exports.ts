// Work and hours exports, through the one export service (contract P-1): each
// kind is authorised when it is asked for and again at download, its link lasts
// 15 minutes, its columns are fixed here, and every export is audited.
// Legacy files they replace (BAWES-Universe/studenthub @ 55119d3):
// - company candidate/work-log-detailed-excel: one row per session;
// - company candidate/work-log-excel: hours per person and store;
// - staff candidate/export-assigned-history: who worked where, and when.
// Legacy wrote Excel with one sheet per person for the detailed file; P-1 writes
// one CSV, so the detailed and summary files are two kinds.

import { EXPORT_ROW_CAP, type ExportKind } from "../../../../packages/exports/src/exports.js";
import { isUuid, parseRange, type EmployerDecisionView, type HoursCursor, type HoursRange, type SessionStatus, type WorkSession } from "../../../../packages/work/src/index.js";
import type { WorkHttpServices } from "./http.js";

export const WORK_EXPORT_KINDS = { detailed: "work-log-detailed", summary: "work-log-summary", history: "work-assigned-history", staff: "work-staff-sessions" } as const;

export interface CompanyHoursExportFilters extends Readonly<Record<string, unknown>> {
  readonly orgId: string;
  readonly from: string;
  readonly to: string;
  readonly storeId?: string;
  readonly status?: SessionStatus;
}
export interface AssignedHistoryExportFilters extends Readonly<Record<string, unknown>> {
  readonly from: string;
  readonly to: string;
}

const STATUSES: readonly string[] = ["pending", "approved", "rejected"];
const STATUS: Readonly<Record<string, string>> = { pending: "Pending", approved: "Approved", rejected: "Rejected" };
const VIA: Readonly<Record<string, string>> = { timer: "Timer", manual: "Entered late", correction: "Correction by StudentHub", import: "Old system" };
const KUWAIT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuwait", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

/** `YYYY-MM-DD HH:MM:SS` in Kuwait time, as legacy showed times. */
export function kuwaitTime(iso: string | null): string {
  if (!iso) return "";
  const p = Object.fromEntries(KUWAIT.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Legacy's "1 hour 5 minutes 3 seconds". */
export function spelledDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return `${h} hour ${m} minutes ${s} seconds`;
}

const clock = (seconds: number) => `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

/** The filters a company hours export accepts; undefined for anything else. */
export function companyHoursFilters(input: { readonly orgId?: unknown; readonly from?: unknown; readonly to?: unknown; readonly storeId?: unknown; readonly status?: unknown }): CompanyHoursExportFilters | undefined {
  if (typeof input.orgId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.orgId)) return undefined;
  const range = parseRange(input.from, input.to);
  if (!range) return undefined;
  if (input.storeId !== undefined && (typeof input.storeId !== "string" || !isUuid(input.storeId))) return undefined;
  if (input.status !== undefined && (typeof input.status !== "string" || !STATUSES.includes(input.status))) return undefined;
  return Object.freeze({ orgId: input.orgId, from: range.from, to: range.to,
    ...(input.storeId !== undefined ? { storeId: (input.storeId as string).toLowerCase() } : {}), ...(input.status !== undefined ? { status: input.status as SessionStatus } : {}) });
}

/** A query string from these values, leaving out the absent ones (for the export buttons). */
export function exportQuery(values: Readonly<Record<string, string | undefined>>): string {
  return new URLSearchParams(Object.entries(values).filter((e): e is [string, string] => e[1] !== undefined)).toString();
}

/** Each named parameter at most once and nothing else, or undefined. */
function only(query: URLSearchParams, keys: readonly string[]): Readonly<Record<string, string>> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!keys.includes(key) || key in out) return undefined;
    out[key] = value;
  }
  return out;
}

/** The company hours export's filters from the export route's query (orgId, from, to, status, store); null refuses. */
export function companyHoursQuery(query: URLSearchParams): CompanyHoursExportFilters | null {
  const q = only(query, ["orgId", "from", "to", "status", "store"]);
  return (q && companyHoursFilters({ orgId: q.orgId, from: q.from, to: q.to, ...(q.store !== undefined ? { storeId: q.store } : {}), ...(q.status !== undefined ? { status: q.status } : {}) })) ?? null;
}

async function* companyRows(services: WorkHttpServices, actor: string, f: CompanyHoursExportFilters): AsyncGenerator<{ readonly session: WorkSession; readonly decision: EmployerDecisionView | null }> {
  const range: HoursRange = { from: f.from, to: f.to };
  let after: HoursCursor | null = null;
  for (;;) {
    const page = await services.views.company(actor, f.orgId, range, { ...(f.storeId ? { storeId: f.storeId } : {}), ...(f.status ? { status: f.status } : {}), after });
    if ("kind" in page) throw new Error("export authorization changed");
    yield* page.rows;
    if (!page.next) return;
    after = page.next;
  }
}

async function authorizeCompany(services: WorkHttpServices, actor: string, f: CompanyHoursExportFilters): Promise<boolean> {
  // The stored filters are checked again at download: they must still parse, and the actor must still see this company or store.
  const parsed = companyHoursFilters(f);
  if (!parsed) return false;
  const page = await services.views.company(actor, parsed.orgId, { from: parsed.from, to: parsed.to }, { ...(parsed.storeId ? { storeId: parsed.storeId } : {}), ...(parsed.status ? { status: parsed.status } : {}) });
  return !("kind" in page);
}

const names = async (lookup: ((ids: readonly string[]) => Promise<ReadonlyMap<string, string>>) | undefined, ids: Iterable<string>) => {
  const list = [...new Set(ids)];
  return list.length && lookup ? lookup(list) : new Map<string, string>();
};

/** Company work-log, detailed: one row per session in force. */
export function workLogDetailedExport(services: WorkHttpServices): ExportKind<CompanyHoursExportFilters> {
  return {
    id: WORK_EXPORT_KINDS.detailed,
    filterKeys: ["orgId", "from", "to", "storeId", "status"],
    columns: ["Session ID", "Person ID", "Person", "Store ID", "Store", "Date", "Start time", "End time", "Total time", "Total seconds", "Note", "Status", "Via", "Created at", "Decided at"],
    authorize: (actor, f) => authorizeCompany(services, actor, f),
    async *rows(actor, f) {
      const rows = [];
      // One past the cap is enough for the export service to refuse the file.
      for await (const row of companyRows(services, actor, f)) { rows.push(row); if (rows.length > EXPORT_ROW_CAP) break; }
      const [people, stores] = await Promise.all([names(services.personNames, rows.map((r) => r.session.personId)), names(services.storeNames, rows.map((r) => r.session.storeId))]);
      for (const { session: s, decision } of rows) {
        const open = s.endedAt === null;
        yield [s.id, s.personId, people.get(s.personId) ?? "", s.storeId, stores.get(s.storeId) ?? "", s.workDate, kuwaitTime(s.startedAt), kuwaitTime(s.endedAt),
          open ? "" : spelledDuration(s.durationSeconds ?? 0), open ? "" : s.durationSeconds ?? 0, s.note ?? "", open ? "In progress" : STATUS[s.status] ?? s.status,
          VIA[s.source] ?? s.source, kuwaitTime(s.createdAt), kuwaitTime(decision?.decidedAt ?? null)];
      }
    },
  };
}

/**
 * Company work-log, summary: hours per person and store over the range. Legacy
 * added every status into one total; the total is kept, with the approved,
 * waiting and rejected parts beside it. Legacy's bonus column was always 0 and
 * is left out. Hours still in progress count nowhere.
 */
export function workLogSummaryExport(services: WorkHttpServices): ExportKind<CompanyHoursExportFilters> {
  return {
    id: WORK_EXPORT_KINDS.summary,
    filterKeys: ["orgId", "from", "to", "storeId", "status"],
    columns: ["Person ID", "Person", "Company", "Store", "Hours", "Minutes", "Seconds", "Approved", "Waiting", "Rejected"],
    authorize: (actor, f) => authorizeCompany(services, actor, f),
    async *rows(actor, f) {
      const totals = new Map<string, { personId: string; orgId: string; storeId: string; approved: number; pending: number; rejected: number }>();
      for await (const { session: s } of companyRows(services, actor, f)) {
        if (s.endedAt === null) continue;
        const key = `${s.personId}\u0000${s.storeId}`;
        const t = totals.get(key) ?? { personId: s.personId, orgId: s.orgId, storeId: s.storeId, approved: 0, pending: 0, rejected: 0 };
        t[s.status] += s.durationSeconds ?? 0;
        totals.set(key, t);
      }
      const list = [...totals.values()];
      const [people, stores, companies] = await Promise.all([names(services.personNames, list.map((t) => t.personId)), names(services.storeNames, list.map((t) => t.storeId)),
        names(services.companyNames, list.map((t) => t.orgId))]);
      // By name, then ID, then store, so a file is the same for the same hours.
      const order = (t: (typeof list)[number]) => [people.get(t.personId) ?? "", t.personId, stores.get(t.storeId) ?? "", t.storeId];
      const compare = (a: (typeof list)[number], b: (typeof list)[number]) => { const x = order(a), y = order(b); for (let i = 0; i < x.length; i++) { const c = x[i]!.localeCompare(y[i]!); if (c) return c; } return 0; };
      for (const t of list.sort(compare)) {
        const total = t.approved + t.pending + t.rejected;
        yield [t.personId, people.get(t.personId) ?? "", companies.get(t.orgId) ?? t.orgId, stores.get(t.storeId) ?? "",
          Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60, clock(t.approved), clock(t.pending), clock(t.rejected)];
      }
    },
  };
}

/** The filters the assigned-history export accepts; undefined for anything else. */
export function assignedHistoryFilters(input: { readonly from?: unknown; readonly to?: unknown }): AssignedHistoryExportFilters | undefined {
  const range = parseRange(input.from, input.to);
  return range ? Object.freeze({ from: range.from, to: range.to }) : undefined;
}

/** The who-worked-where export's filters from the export route's query (from, to); null refuses. */
export function assignedHistoryQuery(query: URLSearchParams): AssignedHistoryExportFilters | null {
  const q = only(query, ["from", "to"]);
  return (q && assignedHistoryFilters({ from: q.from, to: q.to })) ?? null;
}

/** Staff: who worked where. Legacy wrote "Un-Assigned" for a removed store; a placement here always keeps its store. */
export function assignedHistoryExport(services: WorkHttpServices): ExportKind<AssignedHistoryExportFilters> {
  return {
    id: WORK_EXPORT_KINDS.history,
    filterKeys: ["from", "to"],
    columns: ["Person ID", "Person", "Start date", "End date", "Company", "Store"],
    async authorize(actor, f) {
      const parsed = assignedHistoryFilters(f);
      return parsed !== undefined && (await services.placements.history(actor, parsed)) !== undefined;
    },
    async *rows(actor, f) {
      // Page by page, so a long history is never held whole; one row past the cap
      // is enough for the export service to refuse the file.
      let after = null, count = 0;
      for (;;) {
        const page = await services.placements.history(actor, { from: f.from, to: f.to }, after);
        if (!page) throw new Error("export authorization changed");
        const [people, stores, companies] = await Promise.all([names(services.personNames, page.rows.map((a) => a.personId)), names(services.storeNames, page.rows.map((a) => a.storeId)),
          names(services.companyNames, page.rows.map((a) => a.orgId))]);
        for (const a of page.rows) {
          yield [a.personId, people.get(a.personId) ?? "", a.startDate, a.endDate ?? "", companies.get(a.orgId) ?? a.orgId, stores.get(a.storeId) ?? ""];
          if (++count > EXPORT_ROW_CAP) return;
        }
        if (!page.next) return;
        after = page.next;
      }
    },
  };
}

export interface StaffHoursExportFilters extends Readonly<Record<string, unknown>> {
  readonly from: string;
  readonly to: string;
  readonly staffId?: string;
}

/** The staff hours export's filters; undefined for anything else. */
export function staffHoursFilters(input: { readonly from?: unknown; readonly to?: unknown; readonly staffId?: unknown }): StaffHoursExportFilters | undefined {
  const range = parseRange(input.from, input.to);
  if (!range) return undefined;
  if (input.staffId !== undefined && (typeof input.staffId !== "string" || !/^[A-Za-z0-9._:@-]{1,256}$/.test(input.staffId))) return undefined;
  return Object.freeze({ from: range.from, to: range.to, ...(input.staffId !== undefined ? { staffId: input.staffId as string } : {}) });
}

/** The staff hours export's filters from the export route's query (from, to, staff); null refuses. */
export function staffHoursQuery(query: URLSearchParams): StaffHoursExportFilters | null {
  const q = only(query, ["from", "to", "staff"]);
  return (q && staffHoursFilters({ from: q.from, to: q.to, ...(q.staff !== undefined ? { staffId: q.staff } : {}) })) ?? null;
}

/**
 * Closed minutes and days not ended, per staff member, read page by page: only
 * the per-person totals are kept, and reading stops once there are more people
 * than the export can hold.
 */
async function staffTotals(services: WorkHttpServices, actor: string, f: StaffHoursExportFilters) {
  const totals = new Map<string, { minutes: number; open: number }>();
  let after = null;
  for (;;) {
    const page = await services.staffTime!.days(actor, f.from, f.to, { ...(f.staffId ? { staffId: f.staffId } : {}), after });
    if (page.kind !== "days") return undefined;
    for (const d of page.days) {
      const t = totals.get(d.staffId) ?? { minutes: 0, open: 0 };
      t.minutes += d.minutes;
      if (d.open) t.open++;
      totals.set(d.staffId, t);
    }
    if (!page.next || totals.size > EXPORT_ROW_CAP) return totals;
    after = page.next;
  }
}

/**
 * Internal staff time (legacy staff-work-session/download-list-excel): minutes per
 * staff member over the range. An admin exports everyone or one staff member; a
 * staff member who isn't an admin, only themself (the service decides). Legacy
 * counted a session with no end as the staff record's hours per day; that comes
 * from `staffHoursPerDay`, and while it is absent a day still in progress adds
 * nothing (the cutover lane's release gate wires it before cutover).
 */
export function staffHoursExport(services: WorkHttpServices): ExportKind<StaffHoursExportFilters> {
  return {
    id: WORK_EXPORT_KINDS.staff,
    filterKeys: ["from", "to", "staffId"],
    columns: ["Staff ID", "Name", "Email", "Total minutes", "Total hours", "From", "To"],
    async authorize(actor, f) {
      const parsed = staffHoursFilters(f);
      if (!parsed || !services.staffTime) return false;
      const page = await services.staffTime.days(actor, parsed.from, parsed.to, { ...(parsed.staffId ? { staffId: parsed.staffId } : {}) });
      return page.kind === "days";
    },
    async *rows(actor, f) {
      const totals = await staffTotals(services, actor, f);
      if (!totals) throw new Error("export authorization changed");
      // Past the cap the file is refused; the rows themselves don't matter then.
      if (totals.size > EXPORT_ROW_CAP) { for (const id of [...totals.keys()].slice(0, EXPORT_ROW_CAP + 1)) yield [id]; return; }
      const ids = [...totals.keys()];
      const [people, emails, perDay] = await Promise.all([names(services.personNames, ids), names(services.staffEmails, ids),
        ids.length && services.staffHoursPerDay ? services.staffHoursPerDay(ids) : new Map<string, number>()]);
      for (const id of ids.sort((a, b) => (people.get(a) ?? "").localeCompare(people.get(b) ?? "") || a.localeCompare(b))) {
        const t = totals.get(id)!;
        const total = t.minutes + t.open * Math.round((perDay.get(id) ?? 0) * 60);
        yield [id, people.get(id) ?? "", emails.get(id) ?? "", total, (total / 60).toFixed(2), f.from, f.to];
      }
    },
  };
}

/** Every work export kind, for the export service. */
export function workExportKinds(services: WorkHttpServices): readonly ExportKind<never>[] {
  return [workLogDetailedExport(services), workLogSummaryExport(services), assignedHistoryExport(services), ...(services.staffTime ? [staffHoursExport(services)] : [])] as unknown as readonly ExportKind<never>[];
}
