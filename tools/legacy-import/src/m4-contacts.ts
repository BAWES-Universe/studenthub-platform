// M-4 contacts: legacy `company_contact` links without access become the company's extra contacts
// (migration 0402), with the person's name, position, email addresses and phone numbers. Pure.
// The access contract decides the split: a link with `allow_access = 1` is a member who signs in,
// and imports as a grant once the person is linked (M-3), never as a contact. A link with
// `allow_access = 0` is a contact only. Any other value is quarantined and copies nothing.
// One legacy person on several companies gives one contact per link.
// Values are normalized with the contacts screen's own rules, so an imported contact is one the
// screen could have saved. Issues carry legacy ids, rule codes and column names only.

import { createHash } from "node:crypto";
import { CONTACT_CHANNELS_MAX, CONTACT_NAME_MAX, normalizeContactPhone } from "../../../packages/access/src/company-contacts.js";
import { normalizeInvitationEmail } from "../../../packages/access/src/invitations.js";
import { kuwaitInstant } from "./m4-catalogue.js";

export interface ContactImportRow {
  /** The legacy company_contact_uuid: one platform contact per company link. */
  readonly legacyId: string;
  readonly companyLegacyId: string;
  readonly name: string;
  readonly roleTitle: string | null;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
  readonly removed: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly digest: string;
}

export type ContactIssueRule =
  | "contact.badId"
  | "contact.duplicateId"
  | "contact.access" // allow_access = 1: a member, imported as a grant through M-3; not a contact
  | "contact.badAccess" // allow_access null, missing or not 0/1: quarantined; neither a contact nor a member, no channels copied
  | "contact.noCompany" // no usable company_id; not imported
  | "contact.noPerson" // the link names no legacy contact row; not imported
  | "contact.badName" // blank, over 120 characters or with control characters; not imported
  | "contact.badRoleTitle" // over 120 characters or with control characters; imported without it
  | "contact.badPhone" // one number the contacts screen would refuse; dropped
  | "contact.badEmail" // one address the contacts screen would refuse; dropped
  | "contact.tooManyPhones" // more than 5 usable numbers; the first 5 are kept
  | "contact.tooManyEmails"; // more than 5 usable addresses; the first 5 are kept

/**
 * Where each legacy link went, by link id. Every link with a usable id is in exactly one list, so
 * the reconciliation can count legacy links against the dispositions.
 */
export interface ContactDispositions {
  readonly contact: readonly string[];
  readonly access: readonly string[];
  readonly quarantined: readonly string[];
  readonly refused: readonly string[];
}

export interface ContactIssue {
  readonly rule: ContactIssueRule;
  readonly legacyId: string;
  readonly field?: string;
}

type Row = Readonly<Record<string, unknown>>;

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const truthy = (value: unknown) => value === true || value === 1 || value === "1";

/**
 * Legacy `company_contact.allow_access` is a nullable boolean, DEFAULT 0 (migration
 * m210128_071555_role). Only an explicit 0 makes a contact and only an explicit 1 a member;
 * anything else is unknown and quarantined, never guessed.
 */
function access(value: unknown): "member" | "contact" | "unknown" {
  if (value === true || value === 1 || value === "1") return "member";
  if (value === false || value === 0 || value === "0") return "contact";
  return "unknown";
}

function key(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return KEY.test(text) ? text : null;
}

function companyId(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value.trim()) ? value.trim() : null;
}

/** Trimmed text: null when absent or blank, undefined when unusable. */
function text(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return [...trimmed].length > max || CONTROL.test(trimmed) ? undefined : trimmed;
}

function digestOf(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Child rows of one person, oldest first (then by their own key), as legacy lists them. */
function byPerson(rows: readonly Row[], keyColumn: string, createdColumn: string): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const person = key(row.contact_uuid);
    if (person === null) continue;
    grouped.set(person, [...(grouped.get(person) ?? []), row]);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => compare(kuwaitInstant(a[createdColumn]) ?? "", kuwaitInstant(b[createdColumn]) ?? "")
      || compare(String(a[keyColumn] ?? ""), String(b[keyColumn] ?? "")));
  }
  return grouped;
}

/**
 * Maps legacy company links to contacts. `contacts` are the legacy `contact` rows, `emails` the
 * `contact_email` rows and `phones` the `contact_phone` rows. The person's sign-in email comes
 * first, then the extra addresses; repeats are kept once. A contact deleted in legacy imports as
 * removed, so it is never listed but the record of it stays.
 */
export function mapLegacyContacts(links: readonly Row[], contacts: readonly Row[], emails: readonly Row[], phones: readonly Row[]):
  { readonly contacts: readonly ContactImportRow[]; readonly issues: readonly ContactIssue[]; readonly dispositions: ContactDispositions } {
  const issues: ContactIssue[] = [];
  const people = new Map<string, Row>();
  for (const person of contacts) {
    const id = key(person.contact_uuid);
    if (id !== null && !people.has(id)) people.set(id, person);
  }
  const emailsOf = byPerson(emails, "email_uuid", "email_created_datetime");
  const phonesOf = byPerson(phones, "phone_uuid", "phone_created_datetime");

  const seen = new Set<string>();
  const out: ContactImportRow[] = [];
  const memberIds: string[] = [], quarantined: string[] = [], refused: string[] = [];
  for (const link of links) {
    const id = key(link.company_contact_uuid);
    if (id === null) { issues.push({ rule: "contact.badId", legacyId: "?" }); continue; }
    if (seen.has(id)) { issues.push({ rule: "contact.duplicateId", legacyId: id }); continue; }
    seen.add(id);
    const kind = access(link.allow_access);
    if (kind === "member") { memberIds.push(id); issues.push({ rule: "contact.access", legacyId: id }); continue; }
    if (kind === "unknown") { quarantined.push(id); issues.push({ rule: "contact.badAccess", legacyId: id, field: "allow_access" }); continue; }
    const company = companyId(link.company_id);
    if (company === null) { refused.push(id); issues.push({ rule: "contact.noCompany", legacyId: id, field: "company_id" }); continue; }
    const personId = key(link.contact_uuid);
    const person = personId === null ? undefined : people.get(personId);
    if (person === undefined || personId === null) { refused.push(id); issues.push({ rule: "contact.noPerson", legacyId: id, field: "contact_uuid" }); continue; }
    const name = text(person.contact_name, CONTACT_NAME_MAX);
    if (!name) { refused.push(id); issues.push({ rule: "contact.badName", legacyId: id, field: "contact_name" }); continue; }
    let roleTitle = text(link.contact_position, CONTACT_NAME_MAX);
    if (roleTitle === undefined) { issues.push({ rule: "contact.badRoleTitle", legacyId: id, field: "contact_position" }); roleTitle = null; }

    const channels = (kind: "phone" | "email", raws: readonly unknown[]): string[] => {
      const kept: string[] = [];
      let bad = false, extra = false;
      for (const raw of raws) {
        if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) continue;
        const value = typeof raw !== "string" ? undefined : kind === "phone" ? normalizeContactPhone(raw) : normalizeInvitationEmail(raw);
        if (value === undefined) { bad = true; continue; }
        if (kept.includes(value)) continue;
        if (kept.length === CONTACT_CHANNELS_MAX) { extra = true; continue; }
        kept.push(value);
      }
      if (bad) issues.push({ rule: kind === "phone" ? "contact.badPhone" : "contact.badEmail", legacyId: id });
      if (extra) issues.push({ rule: kind === "phone" ? "contact.tooManyPhones" : "contact.tooManyEmails", legacyId: id });
      return kept;
    };
    const emailList = channels("email", [person.contact_email, ...(emailsOf.get(personId) ?? []).map((r) => r.email_address)]);
    const phoneList = channels("phone", (phonesOf.get(personId) ?? []).map((r) => r.phone_number));

    const draft = {
      legacyId: id, companyLegacyId: company, name, roleTitle, phones: phoneList, emails: emailList,
      removed: truthy(person.deleted), createdAt: kuwaitInstant(link.created_at), updatedAt: kuwaitInstant(link.updated_at),
    };
    out.push(Object.freeze({ ...draft, digest: digestOf(draft) }));
  }
  out.sort((a, b) => compare(a.legacyId, b.legacyId));
  const sorted = (ids: string[]) => Object.freeze([...ids].sort(compare));
  const dispositions = Object.freeze({ contact: sorted(out.map((c) => c.legacyId)), access: sorted(memberIds), quarantined: sorted(quarantined), refused: sorted(refused) });
  return Object.freeze({ contacts: Object.freeze(out), issues: Object.freeze(issues), dispositions });
}
