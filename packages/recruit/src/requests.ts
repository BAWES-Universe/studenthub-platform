// Recruit R1: a company raises a request for people and tracks it.
//
// Legacy keeps requests in one table whose string status is set by any save
// (common/models/Request.php:57-62, staff RequestController:808). Here there is
// one status convention with an allowed-transition list, and legacy rows map
// into it through `legacyRequestStatus`, the only place that changes if the
// production counts show another meaning.

export const REQUEST_STATUSES = ["draft", "open", "filling", "filled", "closed"] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
export const CLOSE_REASONS = ["fulfilled", "cancelled"] as const;
export type CloseReason = typeof CLOSE_REASONS[number];
export const POSITION_TYPES = ["full_time", "part_time"] as const;
export type PositionType = typeof POSITION_TYPES[number];
export const PAY_MODELS = ["hourly", "fixed_price", "monthly_salary"] as const;
export type PayModel = typeof PAY_MODELS[number];
export const GENDERS = ["any", "male", "female", "other"] as const;
export type Gender = typeof GENDERS[number];

export const REQUEST_TITLE_MAX = 255;
export const REQUEST_TEXT_MAX = 5000;
export const REQUEST_SHORT_TEXT_MAX = 500;
export const REQUEST_HEADCOUNT_MAX = 10000;
export const REQUEST_PRIORITY_MAX = 10;
export const REQUEST_PAGE_SIZE = 50;

/** Exactly these ordered pairs are allowed; every other pair, including any move out of closed, is refused. */
export const REQUEST_TRANSITIONS: readonly (readonly [RequestStatus, RequestStatus])[] = Object.freeze([
  ["draft", "open"],
  ["draft", "closed"],
  ["open", "filling"],
  ["open", "closed"],
  ["filling", "filled"],
  ["filling", "closed"],
  ["filled", "filling"],
  ["filled", "closed"],
]);

export function requestTransitionAllowed(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

export type LegacyRequestStatusResult =
  | { readonly kind: "mapped"; readonly status: RequestStatus; readonly closeReason: CloseReason | null }
  | { readonly kind: "unmapped"; readonly value: string };

/** Legacy `request.request_status` to the one convention. Anything else is reported, never guessed. */
export function legacyRequestStatus(value: string): LegacyRequestStatusResult {
  switch (value) {
    case "pending": return { kind: "mapped", status: "open", closeReason: null };
    case "started": return { kind: "mapped", status: "filling", closeReason: null };
    case "re_work": return { kind: "mapped", status: "filling", closeReason: null };
    case "delivered": return { kind: "mapped", status: "filled", closeReason: null };
    case "finished_by_recruitment": return { kind: "mapped", status: "closed", closeReason: "fulfilled" };
    case "cancelled": return { kind: "mapped", status: "closed", closeReason: "cancelled" };
    default: return { kind: "unmapped", value };
  }
}

// ---- Grants -------------------------------------------------------------

export interface RecruitGrantRow { readonly org_id: string; readonly role: string; readonly scope: string }
export type RecruitDecision = (rows: readonly RecruitGrantRow[], orgId: string, ancestors: readonly string[]) => boolean;

const STAFF_ROLES = ["staff", "admin"];
const CREATE_ROLES = ["staff", "admin", "org-owner", "recruiter"];
const CLOSE_ROLES = ["staff", "admin", "org-owner"];

function covers(rows: readonly RecruitGrantRow[], roles: readonly string[], orgId: string, ancestors: readonly string[]): boolean {
  return rows.some((row) => roles.includes(row.role) && (row.org_id === orgId || (row.scope === "subtree" && ancestors.includes(row.org_id))));
}

/** Owners, recruiters, staff and admin of the company (self or through a subtree grant). Operator organizations raise no requests. */
export function requestCreateDecision(rows: readonly RecruitGrantRow[], orgId: string, ancestors: readonly string[], operators: readonly string[]): boolean {
  return !operators.includes(orgId) && covers(rows, CREATE_ROLES, orgId, ancestors);
}

/** Readers are exactly the people who may raise one. */
export const requestReadDecision = requestCreateDecision;

/** Opening, closing and other status changes: owners, staff and admin, never a recruiter grantee of the company. */
export function requestTransitionDecision(rows: readonly RecruitGrantRow[], orgId: string, ancestors: readonly string[], operators: readonly string[]): boolean {
  return !operators.includes(orgId) && covers(rows, CLOSE_ROLES, orgId, ancestors);
}

/** Staff queue: staff or admin through a subtree grant on an operator organization. */
export function recruitStaffDecision(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return rows.some((row) => STAFF_ROLES.includes(row.role) && row.scope === "subtree" && operators.includes(row.org_id));
}

// ---- Fields -------------------------------------------------------------

export interface RequestFields {
  readonly storeId: string;
  readonly positionTitle: string;
  readonly description: string;
  readonly compensationText: string;
  readonly positionType: PositionType;
  readonly headcount: number;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly payModel: PayModel | null;
  readonly gender: Gender;
  readonly location: string | null;
  readonly priority: number;
  readonly draft: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isRecruitId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

// Line breaks are allowed in long text; other control characters are refused.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CONTROL_LINE = /[\u0000-\u001f\u007f]/;

function text(value: unknown, max: number, multiline: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 1 || [...trimmed].length > max) return undefined;
  return (multiline ? CONTROL : CONTROL_LINE).test(trimmed) ? undefined : trimmed;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return text(value, max, false);
}

function date(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback?: T): T | undefined {
  if (value === undefined && fallback !== undefined) return fallback;
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

function integer(value: unknown, min: number, max: number, fallback?: number): number | undefined {
  if (value === undefined && fallback !== undefined) return fallback;
  const n = typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

const FIELD_KEYS = ["storeId", "positionTitle", "description", "compensationText", "positionType", "headcount", "periodStart", "periodEnd", "payModel", "gender", "location", "priority", "draft"];

/** Parses a new request. Unknown keys are refused; text is trimmed and length-limited. */
export function parseRequestFields(value: unknown): RequestFields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((key) => !FIELD_KEYS.includes(key))) return undefined;
  if (!isRecruitId(r.storeId)) return undefined;
  const positionTitle = text(r.positionTitle, REQUEST_TITLE_MAX, false);
  const description = text(r.description, REQUEST_TEXT_MAX, true);
  const compensationText = text(r.compensationText, REQUEST_SHORT_TEXT_MAX, true);
  const positionType = oneOf(r.positionType, POSITION_TYPES);
  const headcount = integer(r.headcount, 1, REQUEST_HEADCOUNT_MAX);
  const periodStart = date(r.periodStart), periodEnd = date(r.periodEnd);
  const payModel = r.payModel === undefined || r.payModel === null || r.payModel === "" ? null : oneOf(r.payModel, PAY_MODELS);
  const gender = oneOf(r.gender === "" ? undefined : r.gender, GENDERS, "any");
  const location = optionalText(r.location, REQUEST_SHORT_TEXT_MAX);
  const priority = integer(r.priority === "" ? undefined : r.priority, 0, REQUEST_PRIORITY_MAX, 0);
  const draft = r.draft === undefined || r.draft === false || r.draft === "" ? false : r.draft === true || r.draft === "on" ? true : undefined;
  if (positionTitle === undefined || description === undefined || compensationText === undefined || positionType === undefined ||
    headcount === undefined || periodStart === undefined || periodEnd === undefined || payModel === undefined ||
    gender === undefined || location === undefined || priority === undefined || draft === undefined) return undefined;
  if ((periodStart === null) !== (periodEnd === null)) return undefined;
  if (periodStart !== null && periodEnd !== null && periodEnd < periodStart) return undefined;
  return { storeId: r.storeId.toLowerCase(), positionTitle, description, compensationText, positionType, headcount, periodStart, periodEnd, payModel, gender, location, priority, draft };
}

export interface RequestTransitionInput { readonly to: RequestStatus; readonly closeReason: CloseReason | null }

/** A transition body: `to`, plus `closeReason` exactly when `to` is closed. */
export function parseRequestTransition(value: unknown): RequestTransitionInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((key) => key !== "to" && key !== "closeReason")) return undefined;
  const to = oneOf(r.to, REQUEST_STATUSES);
  if (to === undefined) return undefined;
  if (to === "closed") {
    const closeReason = oneOf(r.closeReason, CLOSE_REASONS);
    return closeReason === undefined ? undefined : { to, closeReason };
  }
  return r.closeReason === undefined || r.closeReason === null || r.closeReason === "" ? { to, closeReason: null } : undefined;
}

// ---- Views --------------------------------------------------------------

export interface RequestRow {
  readonly id: string;
  readonly org_id: string;
  readonly org_name: string;
  readonly store_id: string;
  readonly store_name: string;
  readonly position_title: string;
  readonly description: string;
  readonly compensation_text: string;
  readonly position_type: PositionType;
  readonly headcount: number;
  readonly period_start: string | null;
  readonly period_end: string | null;
  readonly pay_model: PayModel | null;
  readonly gender: Gender;
  readonly location: string | null;
  readonly priority: number;
  readonly status: RequestStatus;
  readonly close_reason: CloseReason | null;
  readonly assigned: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  /** Microsecond UTC text of created_at, for the page cursor. */
  readonly cursor_at: string;
}
export interface RequestEventRow {
  readonly from_status: RequestStatus | null;
  readonly to_status: RequestStatus;
  readonly close_reason: CloseReason | null;
  readonly actor_name: string | null;
  readonly at: string;
}

export interface RequestSummaryView {
  readonly requestId: string;
  readonly orgId: string;
  readonly organizationName: string;
  readonly storeName: string;
  readonly positionTitle: string;
  readonly headcount: number;
  readonly status: RequestStatus;
  readonly closeReason: CloseReason | null;
  readonly lastChange: string;
}
export interface RequestView extends RequestSummaryView {
  readonly storeId: string;
  readonly description: string;
  readonly compensationText: string;
  readonly positionType: PositionType;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly payModel: PayModel | null;
  readonly gender: Gender;
  readonly location: string | null;
  readonly priority: number;
  readonly assigned: boolean;
  readonly createdAt: string;
  readonly allowedTransitions: readonly RequestStatus[];
}
export interface RequestEventView { readonly from: RequestStatus | null; readonly to: RequestStatus; readonly closeReason: CloseReason | null; readonly actor: string | null; readonly at: string }

const iso = (value: string | Date) => (value instanceof Date ? value : new Date(value)).toISOString();

export function requestSummaryView(row: RequestRow): RequestSummaryView {
  return {
    requestId: row.id, orgId: row.org_id, organizationName: row.org_name, storeName: row.store_name, positionTitle: row.position_title,
    headcount: row.headcount, status: row.status, closeReason: row.close_reason, lastChange: iso(row.updated_at),
  };
}

export function requestView(row: RequestRow, canTransition: boolean): RequestView {
  return {
    ...requestSummaryView(row), storeId: row.store_id, description: row.description, compensationText: row.compensation_text,
    positionType: row.position_type, periodStart: row.period_start, periodEnd: row.period_end, payModel: row.pay_model,
    gender: row.gender, location: row.location, priority: row.priority, assigned: row.assigned, createdAt: iso(row.created_at),
    allowedTransitions: canTransition ? REQUEST_TRANSITIONS.filter(([from]) => from === row.status).map(([, to]) => to) : [],
  };
}

export function requestEventView(row: RequestEventRow): RequestEventView {
  return { from: row.from_status, to: row.to_status, closeReason: row.close_reason, actor: row.actor_name, at: iso(row.at) };
}

// ---- Cursor -------------------------------------------------------------

export interface RequestCursor { readonly createdAt: string; readonly id: string }

export function encodeRequestCursor(cursor: RequestCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString("base64url");
}

export function decodeRequestCursor(value: string): RequestCursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [createdAt, id] = parsed as unknown[];
    // Microsecond UTC text, exactly as the store wrote it, so the keyset never skips a row.
    if (typeof createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(createdAt) || !isRecruitId(id)) return undefined;
    return { createdAt, id: id.toLowerCase() };
  } catch {
    return undefined;
  }
}
