import type { OwnProfileProjection, PendingProfileRequirement, ProfileField } from "./types.js";

export const COMPLETENESS_ORDER = Object.freeze([
  "nationality", "display_name", "arabic_name", "gender", "objective", "personal_photo", "email", "phone",
  "birth_date", "civil_id", "civil_expiry", "civil_front", "civil_back", "driving_licence", "location",
  "kuwaiti_mother", "education", "skill",
] as const satisfies readonly PendingProfileRequirement[]);

export interface CompletenessEvidence {
  readonly emailPresent: boolean;
  readonly documents: readonly { readonly type: string }[];
  readonly educationPresent: boolean;
  readonly skillPresent: boolean;
  readonly nationalityCode: string | undefined;
  readonly sourcesAvailable: boolean;
}

const present = (field: ProfileField<unknown> | undefined): boolean => field?.state === "available" &&
  (typeof field.value !== "string" || field.value.trim().length > 0);
const importedPending = (profile: OwnProfileProjection): ReadonlySet<PendingProfileRequirement> | undefined => {
  const field = profile.fields.pendingFields;
  return field.state === "available" && field.freshness.kind === "imported_snapshot" ? new Set(field.value) : undefined;
};
const unprojected = (profile: OwnProfileProjection, name: PendingProfileRequirement, live: boolean | undefined): boolean => {
  if (live !== undefined) return live;
  const pending = importedPending(profile);
  return pending !== undefined ? !pending.has(name) : false;
};

export function deriveProfileCompleteness(profile: OwnProfileProjection, evidence: CompletenessEvidence): OwnProfileProjection {
  const provenance = Object.freeze({ system: "studenthub-production-approved-import" as const,
    revision: profile.fields.pendingFields.provenance.revision, sourceField: "live_profile_completeness" });
  const freshness = Object.freeze({ kind: "derived" as const, observedAt: new Date().toISOString() });
  const nationalityPresent = present(profile.fields.nationality);
  if (!evidence.sourcesAvailable || (nationalityPresent && !evidence.nationalityCode)) {
    const failed = Object.freeze({ state: "unavailable" as const, reason: "check_failed" as const, provenance, freshness });
    return Object.freeze({ ...profile, fields: Object.freeze({ ...profile.fields, isProfileCompleted: failed, pendingFields: failed }) });
  }
  const f = profile.fields;
  const civil = f.civilId?.state === "available" ? f.civilId.value : undefined;
  const missing = new Set<PendingProfileRequirement>();
  const require = (name: PendingProfileRequirement, met: boolean) => { if (!met) missing.add(name); };
  require("nationality", nationalityPresent); require("display_name", present(f.displayName));
  require("arabic_name", present(f.arabicName)); require("gender", present(f.gender)); require("objective", present(f.objective));
  require("personal_photo", evidence.documents.some(d => d.type === "personal-photo")); require("email", evidence.emailPresent);
  require("phone", unprojected(profile, "phone", present(f.phone) ? true : undefined)); require("birth_date", present(f.birthDate));
  require("civil_id", unprojected(profile, "civil_id", civil ? civil.maskedNumber !== null : undefined));
  require("civil_expiry", unprojected(profile, "civil_expiry", civil ? civil.expiry !== null : undefined));
  require("civil_front", evidence.documents.some(d => d.type === "civil-id-front"));
  require("civil_back", evidence.documents.some(d => d.type === "civil-id-back")); require("driving_licence", present(f.drivingLicence));
  require("location", present(f.area));
  if (evidence.nationalityCode !== undefined && evidence.nationalityCode !== "KW") require("kuwaiti_mother", unprojected(profile, "kuwaiti_mother", present(f.kuwaitiMother) ? true : undefined));
  require("education", evidence.educationPresent); require("skill", evidence.skillPresent);
  const value = Object.freeze(COMPLETENESS_ORDER.filter(name => missing.has(name)));
  const available = <T>(v: T) => Object.freeze({ state: "available" as const, value: v, provenance, freshness });
  return Object.freeze({ ...profile, fields: Object.freeze({ ...f, isProfileCompleted: available(value.length === 0), pendingFields: available(value) }) });
}
