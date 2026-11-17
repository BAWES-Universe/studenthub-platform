// Shared vocabulary for the work lane: dates in Asia/Kuwait, ids, and who may
// do what. Pure: no I/O, so the rules can be tested without a database.

/** Calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

export const WORK_TIME_ZONE = "Asia/Kuwait";

const KUWAIT_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: WORK_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** The Asia/Kuwait calendar date of an instant (legacy dates sessions and contracts this way). */
export function kuwaitDate(instant: Date): IsoDate {
  return KUWAIT_DATE.format(instant);
}

/** A real `YYYY-MM-DD` date; `2026-02-30` is refused rather than rolled over. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Principal ids are opaque text; refuse empty, oversized or control-character input. */
export function isPrincipalId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Trimmed free text of 1..max characters with no control characters except newlines and tabs. */
export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) return undefined;
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed) ? undefined : trimmed;
}

export interface WorkGrant {
  readonly orgId: string;
  readonly role: string;
  readonly scope: string;
}

/** Operator organizations (StudentHub itself) never employ people through stores. */
export const OPERATOR_ORG_IDS: readonly string[] = Object.freeze(["root"]);

/** Staff and admin run placements, corrections and appeals (legacy staff app). */
export const STAFF_ROLES: readonly string[] = Object.freeze(["staff", "admin"]);
/** Company people who see and decide their stores' hours (legacy company app users). */
export const COMPANY_ROLES: readonly string[] = Object.freeze(["org-owner", "recruiter"]);
/** Finance reads payable inputs; it never edits hours. */
export const FINANCE_ROLES: readonly string[] = Object.freeze(["finance"]);

/**
 * True when one grant with one of `roles` covers `orgId`: on the organization
 * itself, or on an ancestor through a subtree grant (`ancestors` lists the
 * organization's ancestors, nearest first, without the organization).
 */
export function grantsCover(grants: readonly WorkGrant[], roles: readonly string[], orgId: string, ancestors: readonly string[]): boolean {
  return grants.some((g) => roles.includes(g.role) && (g.orgId === orgId || (g.scope === "subtree" && ancestors.includes(g.orgId))));
}

/** Staff or admin anywhere in the tree above (or at) the organization. */
export function isStaffFor(grants: readonly WorkGrant[], orgId: string, ancestors: readonly string[]): boolean {
  return grantsCover(grants, STAFF_ROLES, orgId, ancestors);
}

/** Staff or admin of the operator organization: may see every company's work. */
export function isOperatorStaff(grants: readonly WorkGrant[]): boolean {
  return grants.some((g) => STAFF_ROLES.includes(g.role) && OPERATOR_ORG_IDS.includes(g.orgId) && g.scope === "subtree");
}

export function isCompanyFor(grants: readonly WorkGrant[], orgId: string, ancestors: readonly string[]): boolean {
  return grantsCover(grants, COMPANY_ROLES, orgId, ancestors);
}

/** The SQLSTATE of a database error, if the error carries one (the db stores pass pg errors through). */
export function sqlState(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}
export function constraintName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { constraint?: unknown }).constraint === "string" ? (error as { constraint: string }).constraint : undefined;
}
