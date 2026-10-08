import { createHash } from "node:crypto";
import {
  createSafeWrite, type FieldPolicy, type SafeWriteClock, type SafeWriteImplementation,
  type SafeWriteSecret, type SafeWriteStore,
} from "@studenthub/safe-write-contract";
import { BENEFICIARY_NAME_FORBIDDEN_RANGES } from "@studenthub/pay-contracts";

/**
 * SHU-143 (S2): the fields a candidate changes on their own profile, rows PD-10 to
 * PD-15 of docs/parity/profile-and-private-documents.md. Each is one SHU-82 safe
 * write on the caller's own record. Language (PD-11) already has its own write
 * (SHU-84) and is not repeated here. Location (PD-13) waits for an area catalogue,
 * which the reference catalogue does not carry yet.
 */
export const SELF_EDIT_FIELDS = Object.freeze([
  "display_name", "arabic_name", "gender", "birth_date", "nationality", "kuwaiti_mother", "university",
  "objective", "intro", "preferred_time", "profile_url", "driving_licence", "job_search_status", "phone",
] as const);
export type SelfEditField = (typeof SELF_EDIT_FIELDS)[number];

export const PERSON_NAME_MAX = 255;
export const OBJECTIVE_MAX = 100;
export const PREFERRED_TIME_MAX = 100;
export const INTRO_MAX = 5_000;

/** The contract measures UTF-16 units; the longest field is the intro, two units per code point at most. */
export const SELF_EDIT_POLICY: FieldPolicy = Object.freeze({ allowed: SELF_EDIT_FIELDS, maxValueLength: INTRO_MAX * 2 });

export const GENDERS = Object.freeze(["male", "female", "other"] as const);
export const JOB_SEARCH_STATUSES = Object.freeze(["not_looking", "active", "open_to_offers"] as const);

/**
 * Legacy refuses a birth date outside ages 16 to 25 (`Candidate.php validateAge`).
 * Decision D4 may change the range, so it is configuration, not a constant in the rule.
 */
export interface AgeRule { readonly minYears: number; readonly maxYears: number }
export const LEGACY_AGE_RULE: AgeRule = Object.freeze({ minYears: 16, maxYears: 25 });

/**
 * Text fields refuse the same code points as the beneficiary name: controls, format
 * characters, line and paragraph separators, private use and code points unassigned in
 * Unicode 16. One generated list, so migration 0184 carries exactly the same set.
 */
export const PROFILE_TEXT_FORBIDDEN_RANGES = BENEFICIARY_NAME_FORBIDDEN_RANGES;

function forbidden(text: string, allowNewline: boolean): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (allowNewline && code === 0x0a) continue;
    if (PROFILE_TEXT_FORBIDDEN_RANGES.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

const codePoints = (text: string): number => [...text].length;

/** NFKC, every run of whitespace one space, trimmed. The result must be stable under NFKC again. */
function singleLine(value: unknown, max: number, min = 1): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const length = codePoints(cleaned);
  if (length < min || length > max || forbidden(cleaned, false) || cleaned.normalize("NFKC") !== cleaned) return undefined;
  return cleaned;
}

/** A person's name: at least two words (`validateFullName`), so at least three code points. */
export function normalizePersonName(value: unknown): string | undefined {
  const name = singleLine(value, PERSON_NAME_MAX, 3);
  return name !== undefined && name.includes(" ") ? name : undefined;
}

/**
 * The introduction keeps its line breaks: CR LF and CR become LF, each line is
 * trimmed with its inner whitespace collapsed, and blank lines collapse to one.
 */
export function normalizeIntro(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.normalize("NFKC").replace(/\r\n?/gu, "\n")
    .split("\n").map((line) => line.replace(/\s+/gu, " ").trim()).join("\n")
    .replace(/\n{3,}/gu, "\n\n").trim();
  const length = codePoints(cleaned);
  if (length < 1 || length > INTRO_MAX || forbidden(cleaned, true) || cleaned.normalize("NFKC") !== cleaned) return undefined;
  return cleaned;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Whole years between a birth date and a day, both `YYYY-MM-DD`. */
export function ageOn(birthDate: string, today: string): number {
  const [birthYear, birthMonth, birthDay] = birthDate.split("-").map(Number) as [number, number, number];
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  let age = year - birthYear;
  if (month < birthMonth || (month === birthMonth && day < birthDay)) age -= 1;
  return age;
}

/** Digits with an optional leading plus, after dropping spaces, dashes, dots and parentheses. */
export function normalizePhone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.normalize("NFKC").replace(/[\s().-]/gu, "");
  return /^\+?[0-9]{6,15}$/.test(cleaned) ? cleaned : undefined;
}

/** A vanity slug: lowercase letters, digits and inner hyphens, 3 to 63 characters. */
export function normalizeProfileUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(cleaned) ? cleaned : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The canonical stored value of one field, or undefined if the input is not one.
 * Catalogue membership, the age rule and uniqueness need more than the value and
 * are checked by `selfEditValueCheck`.
 */
export function normalizeSelfEdit(field: SelfEditField, value: unknown): string | undefined {
  switch (field) {
    case "display_name":
    case "arabic_name": return normalizePersonName(value);
    case "objective": return singleLine(value, OBJECTIVE_MAX);
    case "preferred_time": return singleLine(value, PREFERRED_TIME_MAX);
    case "intro": return normalizeIntro(value);
    case "gender": return typeof value === "string" && (GENDERS as readonly string[]).includes(value) ? value : undefined;
    case "job_search_status":
      return typeof value === "string" && (JOB_SEARCH_STATUSES as readonly string[]).includes(value) ? value : undefined;
    case "kuwaiti_mother":
    case "driving_licence": return value === true ? "true" : value === false ? "false" : undefined;
    case "birth_date": return typeof value === "string" && isDate(value) ? value : undefined;
    case "nationality":
    case "university": {
      if (typeof value !== "string") return undefined;
      const id = value.toLowerCase();
      return UUID.test(id) ? id : undefined;
    }
    case "phone": return normalizePhone(value);
    case "profile_url": return normalizeProfileUrl(value);
  }
}

/** True if a stored value is exactly what normalization produces, so the database and the check agree. */
export function isCanonicalSelfEditValue(field: SelfEditField, value: string): boolean {
  if (field === "kuwaiti_mother" || field === "driving_licence") return value === "true" || value === "false";
  return normalizeSelfEdit(field, value) === value;
}

/** Why a value is refused, so a form can say which part is wrong. Never the value itself. */
export type SelfEditValueProblem = "invalid_value" | "age_out_of_range" | "not_in_catalogue" | "already_taken";

/** What the value check needs from outside: the catalogue and the uniqueness of phone and profile URL. */
export interface SelfEditReferences {
  /** True if the id is an active catalogue item of that type. */
  activeCatalogueItem(type: "country" | "university", id: string): Promise<boolean>;
  /** True if no other person holds this value. */
  available(field: "phone" | "profile_url", value: string): Promise<boolean>;
}

/** The value check the builder runs at preview and again at confirm. `today` is `YYYY-MM-DD`. */
export type SelfEditCheck = (field: SelfEditField, value: string) => Promise<SelfEditValueProblem | undefined>;

export function selfEditValueCheck(references: SelfEditReferences, options: {
  readonly ageRule?: AgeRule;
  readonly today: () => string;
}): SelfEditCheck {
  const rule = options.ageRule ?? LEGACY_AGE_RULE;
  if (!Number.isInteger(rule.minYears) || !Number.isInteger(rule.maxYears) || rule.minYears < 0 || rule.minYears > rule.maxYears) {
    throw new TypeError("invalid age rule");
  }
  return async (field, value) => {
    if (!isCanonicalSelfEditValue(field, value)) return "invalid_value";
    switch (field) {
      case "birth_date": {
        const age = ageOn(value, options.today());
        return age < rule.minYears || age > rule.maxYears ? "age_out_of_range" : undefined;
      }
      case "nationality": return await references.activeCatalogueItem("country", value) ? undefined : "not_in_catalogue";
      case "university": return await references.activeCatalogueItem("university", value) ? undefined : "not_in_catalogue";
      case "phone":
      case "profile_url": return await references.available(field, value) ? undefined : "already_taken";
      default: return undefined;
    }
  };
}

/** Accepts every value: only for the contract's conformance run, whose fixture values are arbitrary. */
export const acceptAnySelfEditValue: SelfEditCheck = async () => undefined;

function ref(domain: string, value: string): string {
  return createHash("sha256").update(`studenthub:${domain}:v1\0`).update(value).digest("hex");
}

/** The contract's `personRef` for a candidate's own profile. Never the raw id. */
export const candidateProfileRecordRef = (principalId: string): string => ref("candidate-profile-record", principalId);

/** Only a person holding a candidate grant has a candidate profile to edit. */
export function candidateProfileOwnerDecision(rows: readonly { readonly role: string }[]): boolean {
  return rows.some((row) => row.role === "candidate");
}

export interface SelfEditBuildInput {
  readonly store: SafeWriteStore;
  readonly secret: SafeWriteSecret;
  readonly check: SelfEditCheck;
  readonly policy?: FieldPolicy;
  readonly clock?: SafeWriteClock;
  readonly tokenLifetimeMs?: number;
}

/**
 * Production and conformance both enter through this builder. Every field goes
 * through the same preview and confirm; the value check runs at both, so a value
 * that stops being acceptable between them (a country retired, a phone taken) is
 * refused at confirm and nothing is written.
 */
export function buildSelfEditWrite(input: SelfEditBuildInput): SafeWriteImplementation {
  const implementation = createSafeWrite({
    store: input.store, secret: input.secret, policy: input.policy ?? SELF_EDIT_POLICY,
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.tokenLifetimeMs === undefined ? {} : { tokenLifetimeMs: input.tokenLifetimeMs }),
  });
  const acceptable = async (field: string, value: string) =>
    !(SELF_EDIT_FIELDS as readonly string[]).includes(field) || await input.check(field as SelfEditField, value) === undefined;
  return {
    preview: async (request) => await acceptable(request.change.field, request.change.value)
      ? implementation.preview(request) : { ok: false, reason: "invalid_value" },
    confirm: async (request) => await acceptable(request.change.field, request.change.value)
      ? implementation.confirm(request) : { ok: false, reason: "invalid_value" },
  };
}
