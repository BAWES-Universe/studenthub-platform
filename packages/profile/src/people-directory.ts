import { validatePersonSelfEditValue } from "./self-edit.js";

export const PEOPLE_PAGE_SIZE = 25;
export type PeopleWorkStatus = "not_looking" | "active" | "open_to_offers" | "unset";
export type PeopleCivilState = "none" | "waiting" | "rejected" | "expired" | "checked" | "recorded";

export interface PeopleDirectoryQuery { q?: string; status?: PeopleWorkStatus; nationality?: string; civil?: PeopleCivilState; details?: "complete" | "missing"; page: number }
export interface PeopleDirectoryRow {
  principalId: string; name: string | null; universeName: string | null; arabicName: string | null;
  workStatus: "not_looking" | "active" | "open_to_offers" | null;
  nationality: { id: string; name: string } | null; detailsMissing: number; civilState: PeopleCivilState;
  imported: boolean; employeeId: string | null; phoneLast4: string | null;
}
export interface PeopleDirectoryStore { page(query: PeopleDirectoryQuery, today: string): Promise<{ rows: PeopleDirectoryRow[]; total: number }> }

export const PEOPLE_DETAILS_KEYS = Object.freeze([
  "nationality", "display_name", "arabic_name", "gender", "objective", "email", "phone", "birth_date",
  "civil_id", "civil_expiry", "driving_licence", "location", "kuwaiti_mother", "education", "skill",
] as const);
export const PEOPLE_DOCUMENT_KEYS = Object.freeze(["personal_photo", "civil_front", "civil_back"] as const);

export interface ClassifiedPeopleSearch {
  employeeId: string | null; phone: string | null; phoneSuffix: string | null; handle: string | null;
  nameTokens: readonly string[];
}

const digitValue = (character: string) => /[0-9]/.test(character) ? character
  : /[\u0660-\u0669]/.test(character) ? String(character.charCodeAt(0) - 0x0660)
  : /[\u06f0-\u06f9]/.test(character) ? String(character.charCodeAt(0) - 0x06f0) : character;

export function classifySearchTerm(raw: string): ClassifiedPeopleSearch {
  const q = raw.trim().normalize("NFC");
  const employee = /^c0*([1-9][0-9]*)$/i.exec(q);
  const phoneCandidate = q.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, digitValue);
  const validated = validatePersonSelfEditValue("phone", phoneCandidate, "2000-01-01");
  const onlyPhoneCharacters = /^[+0-9\u0660-\u0669\u06f0-\u06f9 ()-]+$/.test(q);
  const suffixDigits = [...q].map(digitValue).join("").replace(/\D/g, "");
  const link = /^(?:https?:\/\/[^/]+)?\/(?:people|profile)\/([a-z][a-z0-9._-]{2,29})\/?$/i.exec(q);
  const bareHandle = /^[a-z][a-z0-9._-]{2,29}$/i.test(q) && !q.includes(" ") ? q.toLowerCase() : null;
  const nameTokens = Object.freeze((q.toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean));
  return Object.freeze({
    employeeId: employee?.[1] ?? null,
    phone: onlyPhoneCharacters && validated.ok && validated.value !== "" ? validated.value : null,
    phoneSuffix: onlyPhoneCharacters && (!validated.ok || validated.value === "") && suffixDigits.length >= 4 ? suffixDigits : null,
    handle: link?.[1]?.toLowerCase() ?? bareHandle,
    nameTokens,
  });
}

export interface CivilStateInput {
  released?: boolean; numberPresent?: boolean; expiry?: string | null; needsReview?: boolean;
  newestDecision?: "confirmed" | "rejected" | null;
}
export function civilStateOf(value: CivilStateInput, today: string): PeopleCivilState {
  if (value.released || (!value.numberPresent && !value.expiry)) return "none";
  if (value.needsReview) return "waiting";
  if (value.newestDecision === "rejected") return "rejected";
  if (value.expiry !== null && value.expiry !== undefined && value.expiry < today) return "expired";
  if (value.newestDecision === "confirmed") return "checked";
  return "recorded";
}

export function maskPhone(last4: string): string { return `•••• ${last4}`; }
