import { PROFILE_PARITY_REVISION, type OwnProfileProjection, type PendingProfileRequirement } from "./types.js";

export const COMPLETENESS_REQUIREMENTS = Object.freeze([
  "nationality", "display_name", "arabic_name", "gender", "objective", "personal_photo", "email", "phone",
  "birth_date", "civil_id", "civil_expiry", "civil_front", "civil_back", "driving_licence", "location",
  "kuwaiti_mother", "education", "skill",
] as const satisfies readonly PendingProfileRequirement[]);

export interface CompletenessEvidence {
  readonly emailPresent: boolean;
  readonly documents: readonly { readonly type: string }[];
  readonly hasEducation: boolean;
  readonly hasSkill: boolean;
  readonly civilIdRecorded: boolean;
  readonly civilExpiryRecorded: boolean;
  readonly countries: readonly { readonly id: string; readonly code: string }[];
  readonly observedAt?: string;
}

const present = (field: { readonly state: string; readonly value?: unknown } | undefined): boolean =>
  field?.state === "available" && (typeof field.value !== "string" || field.value.trim().length > 0);

export function deriveProfileCompleteness(profile: OwnProfileProjection, evidence: CompletenessEvidence): OwnProfileProjection {
  const fields = profile.fields;
  const pending = fields.pendingFields.state === "available" && fields.pendingFields.freshness.kind === "imported_snapshot"
    ? new Set(fields.pendingFields.value) : undefined;
  const importedFallback = (requirement: PendingProfileRequirement, live: boolean): boolean => live || (!!pending && !pending.has(requirement));
  const nationality = fields.nationality;
  let nationalityCode: string | undefined;
  if (nationality.state === "available") {
    if (!nationality.editValue) throw new Error("nationality choice unavailable");
    nationalityCode = evidence.countries.find(country => country.id === nationality.editValue)?.code;
    if (!nationalityCode) throw new Error("nationality choice unavailable");
  }
  const documents = new Set(evidence.documents.map(document => document.type));
  const missing: PendingProfileRequirement[] = [];
  const require = (name: PendingProfileRequirement, met: boolean) => { if (!met) missing.push(name); };
  require("nationality", present(nationality));
  require("display_name", present(fields.displayName));
  require("arabic_name", present(fields.arabicName));
  require("gender", present(fields.gender));
  require("objective", present(fields.objective));
  require("personal_photo", documents.has("personal-photo"));
  require("email", evidence.emailPresent);
  require("phone", importedFallback("phone", present(fields.phone)));
  require("birth_date", present(fields.birthDate));
  require("civil_id", importedFallback("civil_id", evidence.civilIdRecorded));
  require("civil_expiry", importedFallback("civil_expiry", evidence.civilExpiryRecorded));
  require("civil_front", documents.has("civil-id-front"));
  require("civil_back", documents.has("civil-id-back"));
  require("driving_licence", present(fields.drivingLicence));
  require("location", present(fields.area));
  if (nationalityCode !== undefined && nationalityCode !== "KW") require("kuwaiti_mother", importedFallback("kuwaiti_mother", present(fields.kuwaitiMother)));
  require("education", evidence.hasEducation);
  require("skill", evidence.hasSkill);
  const observedAt = evidence.observedAt ?? new Date().toISOString();
  const provenance = Object.freeze({ system: "studenthub-production-approved-import" as const, revision: PROFILE_PARITY_REVISION, sourceField: "derived_profile_completeness" });
  const freshness = Object.freeze({ kind: "derived" as const, observedAt });
  return Object.freeze({ ...profile, fields: Object.freeze({ ...fields,
    isProfileCompleted: Object.freeze({ state: "available" as const, value: missing.length === 0, provenance, freshness }),
    pendingFields: Object.freeze({ state: "available" as const, value: Object.freeze(missing), provenance, freshness }),
  }) });
}

export function unavailableProfileCompleteness(profile: OwnProfileProjection): OwnProfileProjection {
  const provenance = Object.freeze({ system: "studenthub-production-approved-import" as const, revision: PROFILE_PARITY_REVISION, sourceField: "derived_profile_completeness" });
  const field = Object.freeze({ state: "unavailable" as const, reason: "check_failed" as const, provenance,
    freshness: Object.freeze({ kind: "derived" as const, observedAt: "" }) });
  return Object.freeze({ ...profile, fields: Object.freeze({ ...profile.fields, isProfileCompleted: field, pendingFields: field }) });
}
