import type { OwnProfileProjection, PendingProfileRequirement } from "./types.js";

export type ProfileCompletenessSource<T> =
  | { readonly state: "available"; readonly value: T }
  | { readonly state: "unconfigured" }
  | { readonly state: "failed" };

export type ProfileCompletenessDocumentType =
  | "personal-photo"
  | "resume"
  | "civil-id-front"
  | "civil-id-back";

export interface ProfileCompletenessInput {
  readonly profile: ProfileCompletenessSource<OwnProfileProjection>;
  readonly principalEmailPresent: ProfileCompletenessSource<boolean>;
  readonly activeBackground: ProfileCompletenessSource<Readonly<{ educationCount: number; skillCount: number }>>;
  readonly documentTypesOnFile: ProfileCompletenessSource<readonly ProfileCompletenessDocumentType[]>;
  readonly civilIdRecorded: ProfileCompletenessSource<Readonly<{ number: boolean; expiry: boolean }>>;
  /** Catalogue code for a written nationality; null means its stored id was not found. */
  readonly writtenNationalityCode: ProfileCompletenessSource<string | null>;
}

export type ProfileCompletenessResult =
  | { readonly kind: "available"; readonly pendingFields: readonly PendingProfileRequirement[] }
  | { readonly kind: "unavailable"; readonly reason: "check_failed" };

const ORDER: readonly PendingProfileRequirement[] = Object.freeze([
  "nationality", "display_name", "arabic_name", "gender", "objective", "personal_photo",
  "email", "phone", "birth_date", "civil_id", "civil_expiry", "civil_front", "civil_back",
  "driving_licence", "location", "kuwaiti_mother", "education", "skill",
]);

function isDerivedRequirement(requirement: PendingProfileRequirement): boolean {
  switch (requirement) {
    case "nationality": case "display_name": case "arabic_name": case "gender": case "objective":
    case "personal_photo": case "email": case "phone": case "birth_date": case "civil_id":
    case "civil_expiry": case "civil_front": case "civil_back": case "driving_licence": case "location":
    case "kuwaiti_mother": case "education": case "skill":
      return true;
    default:
      return false;
  }
}

function present(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "boolean") return true;
  return value !== null && value !== undefined;
}

function fieldPresent(profile: OwnProfileProjection, name: keyof OwnProfileProjection["fields"]): boolean {
  const field = profile.fields[name];
  return field?.state === "available" && present(field.value);
}

function importedPending(profile: OwnProfileProjection): readonly PendingProfileRequirement[] | undefined {
  if (Object.values(profile.fields).some((field) => field.freshness.kind === "written_by_person")) return undefined;
  const field = profile.fields.pendingFields;
  return field.state === "available" && field.freshness.kind === "imported_snapshot" ? field.value : undefined;
}

function importedOnlyMet(
  profile: OwnProfileProjection,
  requirement: PendingProfileRequirement,
  liveValue: boolean,
): boolean {
  if (liveValue) return true;
  const pending = importedPending(profile);
  return pending !== undefined && !pending.includes(requirement);
}

/** Pure, fixed-order implementation of the legacy candidate completeness rules. */
export function deriveProfileCompleteness(input: ProfileCompletenessInput): ProfileCompletenessResult {
  if (input.profile.state !== "available"
    || input.principalEmailPresent.state !== "available"
    || input.activeBackground.state !== "available"
    || input.documentTypesOnFile.state !== "available"
    || input.civilIdRecorded.state !== "available"
    || input.writtenNationalityCode.state !== "available") {
    return Object.freeze({ kind: "unavailable", reason: "check_failed" });
  }

  const profile = input.profile.value;
  const nationality = profile.fields.nationality;
  const writtenNationality = nationality.state === "available" && nationality.freshness.kind === "written_by_person";
  const nationalityCode = input.writtenNationalityCode.value;
  if (writtenNationality && nationalityCode === null) {
    return Object.freeze({ kind: "unavailable", reason: "check_failed" });
  }

  const documents = new Set(input.documentTypesOnFile.value);
  const missing = new Set<PendingProfileRequirement>();
  const requireField = (requirement: PendingProfileRequirement, name: keyof OwnProfileProjection["fields"]) => {
    if (!fieldPresent(profile, name)) missing.add(requirement);
  };

  requireField("nationality", "nationality");
  requireField("display_name", "displayName");
  requireField("arabic_name", "arabicName");
  requireField("gender", "gender");
  requireField("objective", "objective");
  if (!documents.has("personal-photo")) missing.add("personal_photo");
  if (!input.principalEmailPresent.value) missing.add("email");
  if (!importedOnlyMet(profile, "phone", fieldPresent(profile, "phone"))) missing.add("phone");
  requireField("birth_date", "birthDate");
  if (!importedOnlyMet(profile, "civil_id", input.civilIdRecorded.value.number)) missing.add("civil_id");
  if (!importedOnlyMet(profile, "civil_expiry", input.civilIdRecorded.value.expiry)) missing.add("civil_expiry");
  if (!documents.has("civil-id-front")) missing.add("civil_front");
  if (!documents.has("civil-id-back")) missing.add("civil_back");
  requireField("driving_licence", "drivingLicence");
  requireField("location", "area");

  const motherAnswered = fieldPresent(profile, "kuwaitiMother");
  let motherRequired = false;
  if (writtenNationality) motherRequired = nationalityCode !== "KW";
  else if (fieldPresent(profile, "nationality")) {
    const pending = importedPending(profile);
    motherRequired = pending?.includes("kuwaiti_mother") ?? false;
  }
  if (motherRequired && !importedOnlyMet(profile, "kuwaiti_mother", motherAnswered)) missing.add("kuwaiti_mother");
  if (input.activeBackground.value.educationCount < 1) missing.add("education");
  if (input.activeBackground.value.skillCount < 1) missing.add("skill");

  return Object.freeze({
    kind: "available",
    pendingFields: Object.freeze(ORDER.filter((item) => !isDerivedRequirement(item) || missing.has(item))),
  });
}
