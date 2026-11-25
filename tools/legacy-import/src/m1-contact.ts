// M-1 people, contact slice: the queue 13/14 columns a linked person's profile takes at cutover
// (person_profiles phone and profile_handle; the Q14-3 civil ID number, country and review flag).
// Pure. Values are checked with the platform's own rules (self-edit phone and handle, civil ID
// format), and uniqueness follows the platform's: a phone, handle or civil ID held by two
// imported people is recorded for neither, with a reconciliation row on each naming the other
// legacy id (queue 13: never forced through, never dropped silently; queue 14: a civil ID that
// fails the format or duplicates another active person's is imported as not recorded).
//
// Only candidates that M-1 imports (`mapLegacyCandidates` gives them a snapshot) are mapped:
// unusable ids, duplicates and archived candidates are already reported there, and a deleted
// candidate holds no value that could block an active one.
//
// The output holds personal values (a phone, a civil ID number). It stays in memory: no digest
// or report here carries one. Issues carry legacy ids, rule codes and column names only.
//
// Out of this slice: the store (the civil ID is sealed with the platform's CivilIdVault, and the
// row digest is keyed so that no plan or receipt can be used to guess a number), the run step,
// and loading only for people with no platform-written value.

import { normalizeCivilIdNumber, validateCivilId, validatePersonSelfEditValue, type CivilIdCountry } from "@studenthub/profile";
import type { PersonImportRow } from "./m1-people.js";

/**
 * Every legacy column this slice reads, all from `candidate`. The legacy handle column is
 * `profile_url` (added by m230406_110939; queue 13's table calls it `candidate_profile_url`).
 */
export const M1_CONTACT_SOURCES = {
  candidate: ["candidate_id", "candidate_phone", "profile_url", "candidate_civil_id", "candidate_civil_need_verification"],
} as const satisfies Record<string, readonly string[]>;

/** Names this mapper's rules, for the run plan that will pin it. */
export const M1_CONTACT_MAPPER_REVISION = "m1-contact-v1";

export interface PersonContactRow {
  readonly legacyId: string;
  /** "+" and 8 to 15 digits, as the self-edit rule stores it; null when not recorded. */
  readonly phone: string | null;
  /** Lower case, the self-edit handle rule; null when not recorded. */
  readonly handle: string | null;
  /** Kuwait (12 digits) or Bahrain (9 digits); null when not recorded. */
  readonly civilId: { readonly country: CivilIdCountry; readonly number: string } | null;
  /** Legacy's "needs verification" flag; recorded only with a civil ID. */
  readonly civilIdNeedsReview: boolean | null;
}

export type PersonContactIssueRule =
  | "contact.phoneRule" // the platform's phone rule refuses it; not recorded
  | "contact.phoneDuplicate" // another imported person holds the same phone; recorded for neither
  | "contact.handleRule" // the platform's handle rule refuses it; not recorded
  | "contact.handleDuplicate" // another imported person holds the same handle; recorded for neither
  | "contact.civilIdRule" // not a 12-digit Kuwait or 9-digit Bahrain civil ID; not recorded
  | "contact.civilIdDuplicate" // another imported person holds the same civil ID; recorded for neither
  | "contact.badValue"; // the review flag is not a legacy boolean; not recorded

export interface PersonContactIssue {
  readonly rule: PersonContactIssueRule;
  readonly legacyId: string;
  /** The legacy column, never its value. */
  readonly field: string;
  /** For a duplicate: the lowest other legacy id holding the same value. */
  readonly target?: string;
}

export interface M1Contacts {
  readonly contacts: readonly PersonContactRow[];
  readonly issues: readonly PersonContactIssue[];
}

type Row = Readonly<Record<string, unknown>>;

const isUnset = (raw: unknown) => raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
const byId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
/** The same canonical id M-1 uses: digits, no sign or leading zero. */
const canonicalId = (raw: unknown) => typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? String(raw)
  : typeof raw === "string" && /^[1-9][0-9]{0,17}$/.test(raw.trim()) ? raw.trim() : null;

/**
 * The country follows from the number's format: Kuwait civil IDs have 12 digits and Bahrain CPRs
 * 9, so the two never overlap. Legacy's country table has no ISO code, and a resident of either
 * country holds its civil ID whatever their nationality, so nationality cannot decide it.
 */
function civilId(raw: string): { country: CivilIdCountry; number: string } | null {
  const number = normalizeCivilIdNumber(raw);
  const country: CivilIdCountry | null = number.length === 12 ? "KW" : number.length === 9 ? "BH" : null;
  if (country === null) return null;
  const checked = validateCivilId({ country, number });
  return checked.ok ? checked.value : null;
}

/**
 * Maps the contact columns of the candidates M-1 imports, ordered by legacy id. `people` is
 * `mapLegacyCandidates(...).people` for the same candidate rows. A person with no recorded value
 * gets no row.
 */
export function mapLegacyPersonContacts(candidates: readonly Row[], people: readonly Pick<PersonImportRow, "legacyId">[]): M1Contacts {
  const imported = new Set(people.map((p) => p.legacyId));
  const issues: PersonContactIssue[] = [];
  type Draft = { legacyId: string; phone: string | null; handle: string | null; civilId: PersonContactRow["civilId"]; civilIdNeedsReview: boolean | null };
  const drafts = new Map<string, Draft>();

  for (const row of candidates) {
    const id = canonicalId(row.candidate_id);
    // M-1 imports an id only when it is on exactly one usable, active row.
    if (id === null || !imported.has(id) || drafts.has(id)) continue;
    const draft: Draft = { legacyId: id, phone: null, handle: null, civilId: null, civilIdNeedsReview: null };
    drafts.set(id, draft);
    const report = (rule: PersonContactIssueRule, field: string) => issues.push({ rule, legacyId: id, field });

    const phone = row.candidate_phone;
    if (!isUnset(phone)) {
      const checked = typeof phone === "string" || typeof phone === "number"
        ? validatePersonSelfEditValue("phone", String(phone).trim(), "2000-01-01") : null;
      if (checked?.ok && checked.value !== "") draft.phone = checked.value;
      else report("contact.phoneRule", "candidate_phone");
    }

    const handle = row.profile_url;
    if (!isUnset(handle)) {
      const checked = typeof handle === "string" ? validatePersonSelfEditValue("handle", handle.trim(), "2000-01-01") : null;
      if (checked?.ok && checked.value !== "") draft.handle = checked.value;
      else report("contact.handleRule", "profile_url");
    }

    const civil = row.candidate_civil_id;
    if (!isUnset(civil)) {
      const checked = typeof civil === "string" || (typeof civil === "number" && Number.isSafeInteger(civil)) ? civilId(String(civil)) : null;
      if (checked) draft.civilId = checked;
      else report("contact.civilIdRule", "candidate_civil_id");
    }
  }

  // Uniqueness among the imported people, as the platform's partial unique indexes require.
  const holders = (key: (d: Draft) => string | null) => {
    const index = new Map<string, string[]>();
    for (const d of drafts.values()) { const k = key(d); if (k !== null) (index.get(k) ?? index.set(k, []).get(k)!).push(d.legacyId); }
    return [...index.values()].filter((ids) => ids.length > 1).map((ids) => ids.sort(byId));
  };
  for (const [key, clear, rule, field] of [
    [(d: Draft) => d.phone, (d: Draft) => { d.phone = null; }, "contact.phoneDuplicate", "candidate_phone"],
    [(d: Draft) => d.handle, (d: Draft) => { d.handle = null; }, "contact.handleDuplicate", "profile_url"],
    [(d: Draft) => d.civilId && `${d.civilId.country}:${d.civilId.number}`, (d: Draft) => { d.civilId = null; }, "contact.civilIdDuplicate", "candidate_civil_id"],
  ] as const) {
    for (const ids of holders(key)) {
      for (const id of ids) {
        clear(drafts.get(id)!);
        issues.push({ rule, legacyId: id, field, target: ids.find((other) => other !== id)! });
      }
    }
  }

  // The review flag belongs to a recorded civil ID.
  for (const row of candidates) {
    const id = canonicalId(row.candidate_id);
    const draft = id === null ? undefined : drafts.get(id);
    if (!draft || draft.civilId === null) continue;
    const raw = row.candidate_civil_need_verification;
    if (isUnset(raw)) continue;
    if (raw === true || raw === 1 || raw === "1") draft.civilIdNeedsReview = true;
    else if (raw === false || raw === 0 || raw === "0") draft.civilIdNeedsReview = false;
    else issues.push({ rule: "contact.badValue", legacyId: draft.legacyId, field: "candidate_civil_need_verification" });
  }

  const contacts = [...drafts.values()]
    .filter((d) => d.phone !== null || d.handle !== null || d.civilId !== null)
    .sort((a, b) => byId(a.legacyId, b.legacyId))
    .map((d) => Object.freeze({ legacyId: d.legacyId, phone: d.phone, handle: d.handle,
      civilId: d.civilId && Object.freeze({ ...d.civilId }), civilIdNeedsReview: d.civilIdNeedsReview }));
  const order = (a: PersonContactIssue, b: PersonContactIssue) => byId(a.legacyId, b.legacyId) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
  return Object.freeze({ contacts: Object.freeze(contacts), issues: Object.freeze(issues.sort(order)) });
}
