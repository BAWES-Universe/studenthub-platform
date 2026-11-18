import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { mayOpenAccessAdmin, type HeldGrant } from "./grant-catalogue.js";
import { REASON_MAX, REASON_MIN } from "./grant-change.js";
import { CONTACT_NAME_MAX } from "./company-contacts.js";

/**
 * Access lane A7: a company signs up and StudentHub staff approve it.
 *
 * Anyone signed in submits "Register a company" (the legacy CompanyRequest
 * fields: company name, contact name and position, phone, company email, what
 * they are hiring for). Operator staff see a review queue and approve or
 * reject with a reason. Approval creates the company under the operator
 * organization as Active and approved to hire (as legacy approval does), and
 * makes the submitter its owner, in one transaction. Staff approve before
 * activation (decision D-OR1). The licence document is asked for when the
 * company is activated, as in legacy, not at sign-up.
 */

export const COMPANY_NAME_MAX = 255;

export const CONTACT_POSITION_MAX = 120;
export const REQUESTING_FOR_MAX = 255;
export const EMAIL_MAX = 254;

export interface CompanyRegistrationRequest {
  readonly companyName: string;
  readonly contactName: string;
  readonly contactPosition: string;
  readonly phoneNumber: string;
  readonly companyEmail: string;
  readonly requestingFor: string;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,23}$/;
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function text(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  const length = [...trimmed].length;
  return length >= min && length <= max && !CONTROL.test(trimmed) ? trimmed : undefined;
}

/** Validates untrusted form fields into a registration, or undefined. */
export function parseCompanyRegistration(raw: Readonly<Record<string, unknown>>): CompanyRegistrationRequest | undefined {
  const companyName = text(raw.companyName, 2, COMPANY_NAME_MAX);
  const contactName = text(raw.contactName, 2, CONTACT_NAME_MAX);
  const contactPosition = text(raw.contactPosition ?? "", 0, CONTACT_POSITION_MAX);
  const phoneNumber = text(raw.phoneNumber, 6, 24);
  const companyEmail = text(raw.companyEmail, 3, EMAIL_MAX);
  const requestingFor = text(raw.requestingFor ?? "", 0, REQUESTING_FOR_MAX);
  if (companyName === undefined || contactName === undefined || contactPosition === undefined || requestingFor === undefined) return undefined;
  if (phoneNumber === undefined || !PHONE.test(phoneNumber)) return undefined;
  if (companyEmail === undefined || !EMAIL.test(companyEmail)) return undefined;
  return Object.freeze({ companyName, contactName, contactPosition, phoneNumber, companyEmail: companyEmail.toLowerCase(), requestingFor });
}

export type ReviewAction = "approve" | "reject";

export interface RegistrationReview {
  readonly registrationId: string;
  readonly action: ReviewAction;
  readonly reason: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseRegistrationReview(raw: Readonly<Record<string, unknown>>): RegistrationReview | undefined {
  const { registrationId, action, reason } = raw;
  if (typeof registrationId !== "string" || !UUID.test(registrationId)) return undefined;
  if (action !== "approve" && action !== "reject") return undefined;
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim().replace(/\r\n?/g, "\n");
  const length = [...trimmed].length;
  if (length < REASON_MIN || length > REASON_MAX) return undefined;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return undefined;
  return Object.freeze({ registrationId, action, reason: trimmed });
}

/** Operator staff and admins review registrations; nobody else sees the queue. */
export function mayReviewRegistrations(callerGrants: readonly HeldGrant[], operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS): boolean {
  return mayOpenAccessAdmin(callerGrants, operatorOrgIds);
}

export type RegistrationStatus = "pending" | "approved" | "rejected";

export type ReviewRefusal = "not_allowed" | "unknown_registration" | "already_decided" | "own_registration" | "name_taken" | "submitter_paused";

export interface ReviewSnapshot {
  readonly callerGrants: readonly HeldGrant[];
  readonly registration: { readonly submitterPrincipalId: string; readonly status: RegistrationStatus; readonly companyName: string } | null;
  /** A live company with the same name (any case) already exists under the operator organization. */
  readonly nameTaken: boolean;
  readonly submitterPaused: boolean;
}

export type ReviewDecision = { readonly kind: "apply" } | { readonly kind: "refused"; readonly reason: ReviewRefusal };

export function decideReview(
  callerId: string,
  review: RegistrationReview,
  snapshot: ReviewSnapshot,
  operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS,
): ReviewDecision {
  if (!mayReviewRegistrations(snapshot.callerGrants, operatorOrgIds)) return { kind: "refused", reason: "not_allowed" };
  const registration = snapshot.registration;
  if (!registration) return { kind: "refused", reason: "unknown_registration" };
  if (registration.status !== "pending") return { kind: "refused", reason: "already_decided" };
  if (registration.submitterPrincipalId === callerId) return { kind: "refused", reason: "own_registration" };
  if (review.action === "approve" && snapshot.nameTaken) return { kind: "refused", reason: "name_taken" };
  if (review.action === "approve" && snapshot.submitterPaused) return { kind: "refused", reason: "submitter_paused" };
  return { kind: "apply" };
}

export interface CompanyRegistration extends CompanyRegistrationRequest {
  readonly id: string;
  readonly submitter: { readonly principalId: string; readonly displayName: string | null; readonly email: string | null };
  readonly status: RegistrationStatus;
  readonly submittedAt: string;
  readonly reviewedAt: string | null;
  readonly reviewReason: string | null;
  readonly orgId: string | null;
}

export type SubmitOutcome = { readonly kind: "submitted"; readonly id: string } | { readonly kind: "refused"; readonly reason: "already_pending" | "unknown_person" };

export type ReviewOutcome =
  | { readonly kind: "approved"; readonly orgId: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "refused"; readonly reason: ReviewRefusal };

/** The Postgres side: submissions, the queue, and one transaction per review. */
export interface CompanyRegistrationStore {
  submit(principalId: string, request: CompanyRegistrationRequest): Promise<SubmitOutcome>;
  /** The submitter's own registrations, newest first. */
  mine(principalId: string): Promise<readonly CompanyRegistration[]>;
  /** Pending registrations, oldest first (at most 100), and the latest 25 decided. */
  queue(): Promise<{ readonly pending: readonly CompanyRegistration[]; readonly decided: readonly CompanyRegistration[] }>;
  review(input: {
    readonly callerId: string;
    readonly review: RegistrationReview;
    readonly parentOrgId: string;
    readonly decide: (snapshot: ReviewSnapshot) => ReviewDecision;
  }): Promise<ReviewOutcome>;
}

export interface CompanyRegistrationService {
  review(callerId: string, review: RegistrationReview): Promise<ReviewOutcome>;
}

export function createCompanyRegistrationService(options: {
  readonly store: Pick<CompanyRegistrationStore, "review">;
  readonly operatorOrgIds?: readonly string[];
}): CompanyRegistrationService {
  const operatorOrgIds = options.operatorOrgIds ?? DEFAULT_OPERATOR_ORG_IDS;
  const parentOrgId = operatorOrgIds[0];
  if (!parentOrgId) throw new Error("an operator organization is required to approve company registrations");
  return {
    review(callerId, review) {
      return options.store.review({ callerId, review, parentOrgId, decide: (snapshot) => decideReview(callerId, review, snapshot, operatorOrgIds) });
    },
  };
}
