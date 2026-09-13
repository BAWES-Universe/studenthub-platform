export const OWN_PROFILE_VERSION = "studenthub.own-profile.v1" as const;
export const PROFILE_PARITY_REVISION = "c2ce255695eabc7e3a0f23b162f5996274234c63" as const;

export type Gender = "male" | "female" | "other";
export type LanguagePreference = "en" | "ar";
export type JobSearchStatus = "not_looking" | "active" | "open_to_offers";

export type PendingProfileRequirement =
  | "identity_reference"
  | "nationality"
  | "display_name"
  | "arabic_name"
  | "gender"
  | "objective"
  | "personal_photo"
  | "email"
  | "phone"
  | "birth_date"
  | "civil_id"
  | "civil_expiry"
  | "civil_front"
  | "civil_back"
  | "driving_licence"
  | "location"
  | "kuwaiti_mother"
  | "education"
  | "skill";

export interface FieldProvenance {
  readonly system: "studenthub-production-approved-import";
  readonly revision: typeof PROFILE_PARITY_REVISION;
  readonly sourceField: string;
}

export interface FieldFreshness {
  readonly kind: "imported_snapshot";
  readonly observedAt: string;
}

export interface AvailableProfileField<T> {
  readonly state: "available";
  readonly value: T;
  readonly provenance: FieldProvenance;
  readonly freshness: FieldFreshness;
}

export interface UnavailableProfileField {
  readonly state: "unavailable";
  readonly reason: "not_imported" | "not_recorded";
  readonly provenance: FieldProvenance;
  readonly freshness: FieldFreshness;
}

export type ProfileField<T> = AvailableProfileField<T> | UnavailableProfileField;

export interface OwnProfileFields {
  readonly displayName: ProfileField<string>;
  readonly arabicName: ProfileField<string>;
  readonly gender: ProfileField<Gender>;
  readonly birthDate: ProfileField<string>;
  readonly age: ProfileField<number>;
  readonly nationality: ProfileField<string>;
  readonly university: ProfileField<string>;
  readonly objective: ProfileField<string>;
  readonly intro: ProfileField<string>;
  readonly preferredTime: ProfileField<string>;
  readonly language: ProfileField<LanguagePreference>;
  readonly area: ProfileField<string>;
  readonly drivingLicence: ProfileField<boolean>;
  readonly jobSearchStatus: ProfileField<JobSearchStatus>;
  readonly committed: ProfileField<boolean>;
  readonly isProfileCompleted: ProfileField<boolean>;
  readonly pendingFields: ProfileField<readonly PendingProfileRequirement[]>;
  readonly employeeIdentifier: ProfileField<string>;
  readonly civilExpired: ProfileField<boolean>;
}

export type OwnProfileFieldName = keyof OwnProfileFields;

export interface OwnProfileProjection {
  readonly [key: string]: unknown;
  readonly version: typeof OWN_PROFILE_VERSION;
  /** Date used for age and civil-expiry derivations. */
  readonly asOfDate: string;
  readonly fields: Readonly<OwnProfileFields>;
}

export interface OwnProfileFieldContract {
  readonly label: string;
  readonly sourceField: string;
  readonly semantics: string;
  readonly unavailable: "not_imported_or_not_recorded";
}

export type ApprovedProfileLink =
  | { readonly kind: "linked"; readonly candidateRef: string }
  | { readonly kind: "missing" }
  | { readonly kind: "conflict" };

/**
 * Approved-data seam only. Implementations resolve an already-approved
 * principal-to-candidate mapping and read its snapshot. They never search by
 * email, name, phone, or another mutable profile attribute.
 */
export interface ApprovedProfileAdapter {
  resolveLink(principalId: string): Promise<ApprovedProfileLink>;
  readCandidate(candidateRef: string): Promise<unknown | undefined>;
}

export interface OwnProfileReadRequest {
  readonly requesterPrincipalId: string;
  readonly targetPersonId: string;
}

export type OwnProfileReadResult =
  | { readonly kind: "found"; readonly profile: OwnProfileProjection }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

export interface OwnProfileReader {
  readOwn(request: OwnProfileReadRequest): Promise<OwnProfileReadResult>;
}
