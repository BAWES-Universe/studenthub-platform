// Work and hours JSON API (W-1 to W-7), under /api/work so the screens keep /work/.... Every handler resolves the signed-in
// person from the session cookie; scope always comes from that person, never
// from a request field (legacy took the company from the request). Writes need
// a same-origin JSON POST. Refusal codes from packages/work pass through.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseAppealCursor, parseCursor, parseLocation, parsePlacementInput, parseRange, formatCursor,
  type AppealService, type DecisionService, type HoursViews, type PlacementService, type SessionService, type SessionStatus,
} from "../../../../packages/work/src/index.js";

export interface WorkHttpServices {
  readonly personFor: (sessionId: string) => Promise<string | undefined>;
  readonly placements: PlacementService;
  readonly sessions: SessionService;
  readonly decisions: DecisionService;
  readonly views: HoursViews;
  readonly appeals: AppealService;
  /** Store names for the screens; absent means a generic label. */
  readonly storeNames?: (storeIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
}

type Json = { readonly status: number; readonly body: unknown };
const ok = (body: unknown): Json => ({ status: 200, body });
const NOT_FOUND = /(^|_)not_found$/;
const CONFLICT = new Set(["overlaps_assignment", "ambiguous_contract", "contract_not_applicable", "request_not_pending", "duplicate_request", "open_session",
  "recruit_card_reused", "already_working", "not_working", "overlaps_session", "session_open", "session_replaced", "not_decided", "not_deleted", "already_deleted",
  "outside_assignment", "not_assigned", "store_removed"]);
function refusal(code: string, extra: Record<string, unknown> = {}): Json {
  const status = code === "forbidden" ? 403 : NOT_FOUND.test(code) ? 404 : CONFLICT.has(code) ? 409 : 400;
  return { status, body: { error: code, ...extra } };
}
/** Maps a service outcome: `{ kind: "refused" }` to its status, anything else to 200. */
function outcome(value: unknown): Json {
  if (typeof value === "object" && value !== null && "kind" in value && (value as { kind: unknown }).kind === "refused") {
    const { kind: _kind, code, ...rest } = value as { kind: string; code: string };
    return refusal(code, rest);
  }
  return ok(value);
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const BODY_LIMIT = 64 * 1024;
const STATUSES = new Set<SessionStatus>(["pending", "approved", "rejected"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function sessionCookie(header: string | undefined): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...parts] = item.trim().split("=");
    const value = parts.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}
async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (Number(req.headers["content-length"]) > BODY_LIMIT) { req.resume(); return { ok: false }; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > BODY_LIMIT) { req.resume(); return { ok: false }; }
    chunks.push(bytes);
  }
  try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown }; } catch { return { ok: false }; }
}

type Handler = (person: string, input: { readonly query: URLSearchParams; readonly body: Record<string, unknown>; readonly params: readonly string[] }, s: WorkHttpServices) => Promise<Json>;
interface Route { readonly method: "GET" | "POST"; readonly pattern: RegExp; readonly handle: Handler }

const range = (q: URLSearchParams) => parseRange(q.get("from"), q.get("to"));
const status = (q: URLSearchParams): SessionStatus | null | undefined => {
  const v = q.get("status");
  return v === null || v === "" ? null : STATUSES.has(v as SessionStatus) ? v as SessionStatus : undefined;
};
function page<P extends { readonly next: { readonly workDate: string; readonly id: string } | null }>(p: P): unknown {
  return { ...p, next: p.next ? formatCursor(p.next) : null };
}
function hoursPage(result: unknown): Json {
  const r = record(result);
  return r && "rows" in r ? ok(page(r as unknown as { next: { workDate: string; id: string } | null })) : outcome(result);
}

const ROUTES: readonly Route[] = [
  // W-1 placements.
  { method: "GET", pattern: /^\/api\/work\/placements\/mine$/, handle: async (p, _i, s) => ok({ assignments: await s.placements.mine(p) }) },
  { method: "GET", pattern: /^\/api\/work\/placements\/company\/([A-Za-z0-9._:-]{1,256})$/, handle: async (p, { params, query }, s) => {
    const storeId = query.get("storeId") ?? undefined;
    const list = await s.placements.forOrganization(p, params[0]!, storeId);
    return list ? ok({ assignments: list }) : refusal("forbidden");
  } },
  { method: "POST", pattern: /^\/api\/work\/placements$/, handle: async (p, { body }, s) => {
    const input = parsePlacementInput(body);
    return input ? outcome(await s.placements.place(p, input)) : refusal("invalid_input");
  } },
  { method: "POST", pattern: new RegExp(`^/api/work/placements/(${UUID})/end-date$`), handle: async (p, { params, body }, s) => {
    const end = body.endDate;
    if (end !== null && typeof end !== "string") return refusal("invalid_input");
    return outcome(await s.placements.setEndDate(p, params[0]!.toLowerCase(), end as string | null));
  } },
  { method: "POST", pattern: /^\/api\/work\/placement-requests$/, handle: async (p, { body }, s) => {
    if (typeof body.personId !== "string" || typeof body.storeId !== "string" || (body.note !== undefined && typeof body.note !== "string")) return refusal("invalid_input");
    return outcome(await s.placements.request(p, { personId: body.personId, storeId: body.storeId, ...(typeof body.note === "string" ? { note: body.note } : {}) }));
  } },
  { method: "POST", pattern: new RegExp(`^/api/work/placement-requests/(${UUID})/(accept|reject|cancel)$`), handle: async (p, { params, body }, s) => {
    const placement = record(body.placement);
    if ((body.reason !== undefined && typeof body.reason !== "string") || (body.placement !== undefined && !placement)) return refusal("invalid_input");
    return outcome(await s.placements.decideRequest(p, params[0]!.toLowerCase(), params[1] as "accept" | "reject" | "cancel", {
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ...(placement ? { placement: placement as { startDate?: string; endDate?: string | null; payContractId?: string } } : {}),
    }));
  } },
  // W-3 clock in and out.
  { method: "GET", pattern: /^\/api\/work\/today$/, handle: async (p, _i, s) => ok(await s.sessions.today(p)) },
  { method: "POST", pattern: /^\/api\/work\/sessions\/start$/, handle: async (p, { body }, s) => outcome(await s.sessions.start(p, parseLocation(body.latitude, body.longitude))) },
  { method: "POST", pattern: /^\/api\/work\/sessions\/stop$/, handle: async (p, { body }, s) => outcome(await s.sessions.stop(p, parseLocation(body.latitude, body.longitude))) },
  { method: "POST", pattern: /^\/api\/work\/sessions\/discard$/, handle: async (p, _i, s) => outcome(await s.sessions.discard(p)) },
  { method: "POST", pattern: /^\/api\/work\/sessions\/manual$/, handle: async (p, { body }, s) => outcome(await s.sessions.addManual(p, { startedAt: body.startedAt, endedAt: body.endedAt, note: body.note })) },
  // W-4 decisions.
  { method: "POST", pattern: /^\/api\/work\/decisions\/sessions$/, handle: async (p, { body }, s) =>
    Array.isArray(body.sessionIds) ? outcome(await s.decisions.decideSessions(p, body.sessionIds, body as never)) : refusal("invalid_input") },
  { method: "POST", pattern: /^\/api\/work\/decisions\/days$/, handle: async (p, { body }, s) =>
    Array.isArray(body.days) ? outcome(await s.decisions.decideDays(p, body.days, body as never)) : refusal("invalid_input") },
  { method: "POST", pattern: new RegExp(`^/api/work/sessions/(${UUID})/undo$`), handle: async (p, { params, body }, s) => outcome(await s.decisions.undo(p, params[0], body.reason)) },
  // W-5 hours.
  { method: "GET", pattern: /^\/api\/work\/hours\/mine$/, handle: async (p, { query }, s) => {
    const r = range(query), after = parseCursor(query.get("after"));
    return r && after !== undefined ? ok(page(await s.views.mine(p, r, after))) : refusal("invalid_input");
  } },
  { method: "GET", pattern: /^\/api\/work\/hours\/company\/([A-Za-z0-9._:-]{1,256})$/, handle: async (p, { params, query }, s) => {
    const r = range(query), after = parseCursor(query.get("after")), st = status(query), storeId = query.get("storeId");
    if (!r || after === undefined || st === undefined) return refusal("invalid_input");
    return hoursPage(await s.views.company(p, params[0]!, r, { ...(storeId ? { storeId } : {}), ...(st ? { status: st } : {}), after }));
  } },
  { method: "GET", pattern: /^\/api\/work\/hours\/all$/, handle: async (p, { query }, s) => {
    const r = range(query), after = parseCursor(query.get("after")), st = status(query), personId = query.get("personId");
    if (!r || after === undefined || st === undefined) return refusal("invalid_input");
    return hoursPage(await s.views.all(p, r, { ...(personId ? { personId } : {}), ...(st ? { status: st } : {}), after }));
  } },
  // W-6 appeals and corrections.
  { method: "POST", pattern: /^\/api\/work\/appeals$/, handle: async (p, { body }, s) => outcome(await s.appeals.raise(p, body.sessionId, body.reason)) },
  { method: "GET", pattern: /^\/api\/work\/appeals\/mine$/, handle: async (p, { query }, s) => {
    const after = parseAppealCursor(query.get("after"));
    return after === undefined ? refusal("invalid_input") : ok({ appeals: await s.appeals.mine(p, after) });
  } },
  { method: "GET", pattern: /^\/api\/work\/appeals$/, handle: async (p, { query }, s) => {
    const after = parseAppealCursor(query.get("after"));
    if (after === undefined) return refusal("invalid_input");
    const orgId = query.get("orgId");
    const list = await s.appeals.list(p, { status: query.get("status") ?? undefined, ...(query.has("from") || query.has("to") ? { from: query.get("from"), to: query.get("to") } : {}),
      ...(orgId ? { orgId } : {}), after });
    return Array.isArray(list) ? ok({ appeals: list }) : outcome(list);
  } },
  { method: "GET", pattern: new RegExp(`^/api/work/appeals/(${UUID})$`), handle: async (p, { params }, s) => outcome(await s.appeals.detail(p, params[0])) },
  { method: "POST", pattern: new RegExp(`^/api/work/appeals/(${UUID})/updates$`), handle: async (p, { params, body }, s) =>
    outcome(await s.appeals.postUpdate(p, params[0], { title: body.title, detail: body.detail })) },
  { method: "POST", pattern: new RegExp(`^/api/work/appeals/(${UUID})/status$`), handle: async (p, { params, body }, s) => outcome(await s.appeals.setStatus(p, params[0], body.status)) },
  { method: "POST", pattern: new RegExp(`^/api/work/appeals/(${UUID})/missing-time$`), handle: async (p, { params, body }, s) =>
    outcome(await s.appeals.addMissing(p, params[0], { startedAt: body.startedAt, endedAt: body.endedAt, reason: body.reason, note: body.note })) },
  { method: "POST", pattern: new RegExp(`^/api/work/appeal-updates/(${UUID})/read$`), handle: async (p, { params }, s) => outcome(await s.appeals.markRead(p, params[0])) },
  { method: "POST", pattern: new RegExp(`^/api/work/sessions/(${UUID})/correct$`), handle: async (p, { params, body }, s) =>
    outcome(await s.appeals.correct(p, params[0], { startedAt: body.startedAt, endedAt: body.endedAt, reason: body.reason, note: body.note, appealId: body.appealId })) },
];

/** Handles `/api/work/...`; returns false for other paths. Screens (work/pages.ts) own `/work/...`. */
export async function handleWork(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, origin: string | undefined): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  if (url.pathname !== "/api/work" && !url.pathname.startsWith("/api/work/")) return false;
  const send = (r: Json) => {
    res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.end(JSON.stringify(r.body));
  };
  try {
    const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    const match = route?.pattern.exec(url.pathname);
    if (!route || !match) { req.resume(); send({ status: 404, body: { error: "not_found" } }); return true; }
    if (!services || !origin) { req.resume(); send({ status: 503, body: { error: "work_unavailable" } }); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const person = sessionId ? await services.personFor(sessionId) : undefined;
    let body: Record<string, unknown> = {};
    if (route.method === "POST") {
      if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); send({ status: 403, body: { error: "origin_rejected" } }); return true; }
      if (!person) { req.resume(); send({ status: 401, body: { error: "unauthorized" } }); return true; }
      if (req.headers["content-type"] !== "application/json") { req.resume(); send(refusal("invalid_input")); return true; }
      const parsed = await readJson(req);
      const object = parsed.ok ? record(parsed.value) : undefined;
      if (!object) { send(refusal("invalid_input")); return true; }
      body = object;
    } else if (!person) { send({ status: 401, body: { error: "unauthorized" } }); return true; }
    let params: string[];
    try { params = match.slice(1).map((p) => decodeURIComponent(p)); } catch { send(refusal("invalid_input")); return true; }
    send(await route.handle(person, { query: url.searchParams, body, params }, services));
  } catch {
    if (!res.headersSent) send({ status: 503, body: { error: "work_unavailable" } }); else res.destroy();
  }
  return true;
}
