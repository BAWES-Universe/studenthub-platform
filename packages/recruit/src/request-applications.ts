// Recruit R7b: people apply to open requests (legacy RequestApplication).
//
// Legacy candidates browsed the open requests of companies (Request list in the
// candidate app), opened one and applied once; the company and staff listed a
// request's applications and the company asked for an interview with an
// applicant. Here the same: a signed-in person browses open requests, applies
// once while the request takes cards, and sees their applications. The company
// (its request readers) or the request's recruiter accepts an applicant, which
// puts them on the pipeline at "contacted" where interviews are scheduled (R6),
// or rejects them. No gender or skills filter hides a request (decision SHU-207).

import type { RequestStatus } from "./requests.js";

export const REQUEST_APPLICATION_STATUSES = ["applied", "accepted", "rejected"] as const;
export type RequestApplicationStatus = typeof REQUEST_APPLICATION_STATUSES[number];
export const OPEN_REQUEST_PAGE_SIZE = 25;
export const OPEN_REQUEST_POSITION_TYPES = ["full_time", "part_time"] as const;

/** A person applies while the request takes new cards: open or filling. */
export function requestTakesApplications(status: RequestStatus): boolean {
  return status === "open" || status === "filling";
}

/** An application is decided once: applied to accepted or rejected. */
export function requestApplicationTransitionAllowed(from: RequestApplicationStatus, to: RequestApplicationStatus): boolean {
  return from === "applied" && (to === "accepted" || to === "rejected");
}

export const REQUEST_APPLICATION_OUTBOX_KINDS = ["request_application.received", "request_application.accepted", "request_application.rejected"] as const;
/** A new application tells the request's recruiter (none assigned: nobody yet, staff see it on the request); a decision tells the person. */
export function requestApplicationOutbox(to: RequestApplicationStatus, applicationId: string, personId: string, recruiterId: string | null): { readonly kind: string; readonly recipient: string; readonly dedupeKey: string } | null {
  if (to === "applied") return recruiterId === null ? null : { kind: "request_application.received", recipient: recruiterId, dedupeKey: `request_application.received:${applicationId}` };
  const kind = `request_application.${to}`;
  return { kind, recipient: personId, dedupeKey: `${kind}:${applicationId}` };
}

export function parseOpenRequestQuery(raw: Readonly<Record<string, string | readonly string[] | undefined>>): { readonly q: string | null; readonly positionType: "full_time" | "part_time" | null; readonly applied: boolean; readonly page: number } | undefined {
  for (const key of Object.keys(raw)) if (!["q", "type", "applied", "page"].includes(key) || Array.isArray(raw[key])) return undefined;
  const q = raw.q === undefined || (raw.q as string).trim() === "" ? null : (raw.q as string).trim();
  if (q !== null && ([...q].length > 100 || /[\u0000-\u001f\u007f]/.test(q))) return undefined;
  const type = raw.type === undefined || raw.type === "" ? null : (OPEN_REQUEST_POSITION_TYPES as readonly string[]).includes(raw.type as string) ? raw.type as "full_time" | "part_time" : undefined;
  const page = raw.page === undefined ? 1 : /^[1-9]\d{0,2}$/.test(raw.page as string) ? Number(raw.page) : undefined;
  if (type === undefined || page === undefined || (raw.applied !== undefined && raw.applied !== "1")) return undefined;
  return { q, positionType: type, applied: raw.applied === "1", page };
}

export interface OpenRequestRow {
  readonly id: string; readonly org_name: string; readonly store_name: string; readonly position_title: string; readonly description: string; readonly position_type: string;
  readonly compensation_text: string; readonly pay_model: string | null; readonly period_start: string | null; readonly period_end: string | null; readonly location: string | null;
  readonly status: RequestStatus; readonly created_at: string | Date; readonly application_id: string | null; readonly application_status: RequestApplicationStatus | null;
}
export interface OpenRequestView {
  readonly requestId: string; readonly company: string; readonly store: string; readonly positionTitle: string; readonly description: string; readonly positionType: string;
  readonly pay: string; readonly payModel: string | null; readonly period: { readonly start: string; readonly end: string } | null; readonly location: string | null;
  readonly postedAt: string; readonly application: { readonly applicationId: string; readonly status: RequestApplicationStatus } | null; readonly canApply: boolean;
}
export function openRequestView(row: OpenRequestRow): OpenRequestView {
  return {
    requestId: row.id, company: row.org_name, store: row.store_name, positionTitle: row.position_title, description: row.description, positionType: row.position_type,
    pay: row.compensation_text, payModel: row.pay_model, period: row.period_start && row.period_end ? { start: row.period_start, end: row.period_end } : null, location: row.location,
    postedAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
    application: row.application_id && row.application_status ? { applicationId: row.application_id, status: row.application_status } : null,
    canApply: !row.application_id && requestTakesApplications(row.status),
  };
}
