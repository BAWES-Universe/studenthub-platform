import { grantCovers, type HeldGrant } from "./grant-catalogue.js";
import { normalizeInvitationEmail } from "./invitations.js";

/**
 * Access lane A3: a company's extra contacts. A contact is a record, never a
 * person who can sign in: it has no principal and holds no grant, and a grant
 * change never edits a contact. Pure rules here; the store does the writes.
 */

export const CONTACT_NAME_MAX = 120;
export const CONTACT_LABEL_MAX = 40;
export const CONTACT_CHANNELS_MAX = 5;
export const MAX_CONTACTS_PER_COMPANY = 200;

export interface ContactChannel {
  readonly value: string;
  readonly label: string | null;
}

export interface ContactInput {
  readonly name: string;
  readonly roleTitle: string | null;
  readonly phones: readonly ContactChannel[];
  readonly emails: readonly ContactChannel[];
}

export interface CompanyContact extends ContactInput {
  readonly id: string;
  readonly updatedAt: string;
}

export type ContactFieldError = "name" | "role_title" | "phone" | "email" | "label" | "too_many";

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A phone is digits with an optional leading plus, 6 to 20 digits; spaces, dashes, dots and brackets are dropped. */
export function normalizeContactPhone(raw: string): string | undefined {
  const value = raw.trim().replace(/[\s().-]/g, "");
  return /^\+?[0-9]{6,20}$/.test(value) ? value : undefined;
}

function text(raw: unknown, max: number): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "") return null;
  if (value.length > max || CONTROL.test(value)) return undefined;
  return value;
}

/**
 * Reads the contact form: name, roleTitle, phone0..phone4 with phoneLabel0..4,
 * email0..email4 with emailLabel0..4. Empty slots are skipped. Unknown keys
 * are refused by the caller before this runs.
 */
export function parseContactForm(form: Readonly<Record<string, string | undefined>>):
  { readonly ok: true; readonly input: ContactInput } | { readonly ok: false; readonly error: ContactFieldError } {
  const name = text(form.name, CONTACT_NAME_MAX);
  if (!name) return { ok: false, error: "name" };
  const roleTitle = text(form.roleTitle, CONTACT_NAME_MAX);
  if (roleTitle === undefined) return { ok: false, error: "role_title" };
  const channels = (kind: "phone" | "email"): ContactChannel[] | ContactFieldError => {
    const out: ContactChannel[] = [];
    for (let index = 0; index < CONTACT_CHANNELS_MAX; index += 1) {
      const raw = form[`${kind}${index}`]?.trim() ?? "";
      const label = text(form[`${kind}Label${index}`], CONTACT_LABEL_MAX);
      if (label === undefined) return "label";
      if (raw === "") {
        if (label !== null) return kind;
        continue;
      }
      const value = kind === "phone" ? normalizeContactPhone(raw) : normalizeInvitationEmail(raw);
      if (!value) return kind;
      out.push({ value, label });
    }
    return out;
  };
  const phones = channels("phone");
  if (typeof phones === "string") return { ok: false, error: phones };
  const emails = channels("email");
  if (typeof emails === "string") return { ok: false, error: emails };
  return { ok: true, input: { name, roleTitle, phones, emails } };
}

/** The keys the contact form may carry. */
export const CONTACT_FORM_KEYS: ReadonlySet<string> = new Set([
  "name", "roleTitle",
  ...Array.from({ length: CONTACT_CHANNELS_MAX }, (_, index) => [`phone${index}`, `phoneLabel${index}`, `email${index}`, `emailLabel${index}`]).flat(),
]);

const OPERATOR_ROLES = new Set(["staff", "admin"]);
const MEMBER_ROLES = new Set(["org-owner", "recruiter", "finance"]);

/** Writing: an org-owner covering the company, or staff or admin covering it. */
export function mayWriteContacts(grants: readonly HeldGrant[], orgId: string, ancestors: readonly string[]): boolean {
  return grants.some((grant) => (grant.role === "org-owner" || OPERATOR_ROLES.has(grant.role)) && grantCovers(grant, orgId, ancestors));
}

/** Reading: the company's owners, recruiters and finance members, and staff or admin covering it. */
export function mayReadContacts(grants: readonly HeldGrant[], orgId: string, ancestors: readonly string[]): boolean {
  return grants.some((grant) => (MEMBER_ROLES.has(grant.role) || OPERATOR_ROLES.has(grant.role)) && grantCovers(grant, orgId, ancestors));
}

export type ContactRefusal = "not_allowed" | "unknown_organization" | "not_found" | "too_many_contacts";

export interface ContactWriteSnapshot {
  readonly callerGrants: readonly HeldGrant[];
  readonly orgLive: boolean;
  readonly orgAncestors: readonly string[];
  readonly liveContacts: number;
}

/** Decided inside the store's transaction on what it read there. */
export function decideContactWrite(orgId: string, action: "create" | "update" | "remove", snapshot: ContactWriteSnapshot):
  { readonly kind: "ok" } | { readonly kind: "refused"; readonly reason: ContactRefusal } {
  if (!snapshot.orgLive) return { kind: "refused", reason: "unknown_organization" };
  if (!mayWriteContacts(snapshot.callerGrants, orgId, snapshot.orgAncestors)) return { kind: "refused", reason: "not_allowed" };
  if (action === "create" && snapshot.liveContacts >= MAX_CONTACTS_PER_COMPANY) return { kind: "refused", reason: "too_many_contacts" };
  return { kind: "ok" };
}

type Refused = { readonly kind: "refused"; readonly reason: ContactRefusal };

export interface CompanyContactsStore {
  context(callerId: string, orgId: string): Promise<{
    readonly callerGrants: readonly HeldGrant[];
    readonly organization: null | { readonly orgId: string; readonly name: string; readonly ancestors: readonly string[] };
  }>;
  /** Live contacts and all their channels, in a fixed number of queries. */
  contacts(orgId: string): Promise<readonly CompanyContact[]>;
  create(input: { readonly callerId: string; readonly orgId: string; readonly contact: ContactInput; readonly now: Date;
    readonly decide: (snapshot: ContactWriteSnapshot) => { readonly kind: "ok" } | Refused }): Promise<{ readonly kind: "created"; readonly id: string } | Refused>;
  update(input: { readonly callerId: string; readonly orgId: string; readonly contactId: string; readonly contact: ContactInput; readonly now: Date;
    readonly decide: (snapshot: ContactWriteSnapshot) => { readonly kind: "ok" } | Refused }): Promise<{ readonly kind: "updated" } | Refused>;
  remove(input: { readonly callerId: string; readonly orgId: string; readonly contactId: string; readonly now: Date;
    readonly decide: (snapshot: ContactWriteSnapshot) => { readonly kind: "ok" } | Refused }): Promise<{ readonly kind: "removed" } | Refused>;
}

export interface ContactsView {
  readonly orgId: string;
  readonly orgName: string;
  readonly writable: boolean;
  readonly contacts: readonly CompanyContact[];
}

export interface CompanyContactsService {
  /** Null when the caller may not read this company's contacts (answered as an unknown path). */
  view(callerId: string, orgId: string): Promise<ContactsView | null>;
  create(callerId: string, orgId: string, contact: ContactInput): Promise<{ readonly kind: "created"; readonly id: string } | Refused>;
  update(callerId: string, orgId: string, contactId: string, contact: ContactInput): Promise<{ readonly kind: "updated" } | Refused>;
  remove(callerId: string, orgId: string, contactId: string): Promise<{ readonly kind: "removed" } | Refused>;
}

export function createCompanyContactsService(options: { readonly store: CompanyContactsStore; readonly now?: () => Date }): CompanyContactsService {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const service: CompanyContactsService = {
    async view(callerId, orgId) {
      const context = await store.context(callerId, orgId);
      const org = context.organization;
      if (!org || !mayReadContacts(context.callerGrants, org.orgId, org.ancestors)) return null;
      return Object.freeze({
        orgId: org.orgId, orgName: org.name,
        writable: mayWriteContacts(context.callerGrants, org.orgId, org.ancestors),
        contacts: await store.contacts(org.orgId),
      });
    },
    async create(callerId, orgId, contact) {
      return store.create({ callerId, orgId, contact, now: now(), decide: (snapshot) => decideContactWrite(orgId, "create", snapshot) });
    },
    async update(callerId, orgId, contactId, contact) {
      return store.update({ callerId, orgId, contactId, contact, now: now(), decide: (snapshot) => decideContactWrite(orgId, "update", snapshot) });
    },
    async remove(callerId, orgId, contactId) {
      return store.remove({ callerId, orgId, contactId, now: now(), decide: (snapshot) => decideContactWrite(orgId, "remove", snapshot) });
    },
  };
  return Object.freeze(service);
}
