import { deriveProfileCompleteness, type OwnProfileProjection, type ProfileCompletenessResult } from "@studenthub/profile";
import type { ProfileRecordsRuntime } from "./profile-records-http.js";
import type { BrowserLoginApplication } from "./web-ui.js";
import type { ProfileAvatarRead } from "./profile-avatar.js";

export interface ProfileCompletenessDependencies {
  readonly profileRecords?: ProfileRecordsRuntime;
  readonly login: Partial<BrowserLoginApplication>;
  readonly documents?: ProfileAvatarRead;
}

export interface GatheredProfileCompleteness {
  readonly result: ProfileCompletenessResult;
  readonly profile: OwnProfileProjection;
}

const failed = { state: "failed" } as const;
const unconfigured = { state: "unconfigured" } as const;

export async function gatherProfileCompleteness(
  personId: string,
  profile: OwnProfileProjection,
  email: unknown,
  dependencies: ProfileCompletenessDependencies,
): Promise<GatheredProfileCompleteness> {
  const background = dependencies.profileRecords
    ? await dependencies.profileRecords.service.background(personId).then(value => ({ state: "available" as const, value: { educationCount: value.education.length, skillCount: value.skill.length } }), () => failed)
    : unconfigured;
  const choices = dependencies.login.profileEdit?.choices
    ? await dependencies.login.profileEdit.choices().then(value => ({ state: "available" as const, value }), () => failed)
    : unconfigured;
  const civil = dependencies.login.civilId
    ? await dependencies.login.civilId.readOwn(personId).then(value => ({ state: "available" as const, value: { number: Boolean(value?.maskedNumber), expiry: Boolean(value?.expiry) } }), () => failed)
    : unconfigured;
  const nationality = profile.fields.nationality;
  const nationalityId = nationality.state === "available" && nationality.freshness.kind === "written_by_person" ? nationality.editValue : undefined;
  const result = deriveProfileCompleteness({
    profile: { state: "available", value: profile },
    principalEmailPresent: { state: "available", value: typeof email === "string" && email.trim().length > 0 },
    activeBackground: background,
    documentTypesOnFile: dependencies.documents
      ? { state: "available", value: dependencies.documents.documents.map(document => document.type).filter((type): type is "personal-photo" | "resume" | "civil-id-front" | "civil-id-back" => type === "personal-photo" || type === "resume" || type === "civil-id-front" || type === "civil-id-back") }
      : unconfigured,
    civilIdRecorded: civil,
    writtenNationalityCode: choices.state === "available"
      ? { state: "available", value: nationalityId === undefined ? null : choices.value.countries.find(country => country.id === nationalityId)?.code ?? null }
      : choices,
  });
  const freshness = { kind: "derived" as const, observedAt: profile.asOfDate };
  const fields = result.kind === "available" ? {
    ...profile.fields,
    isProfileCompleted: { ...profile.fields.isProfileCompleted, state: "available" as const, value: result.pendingFields.length === 0, freshness },
    pendingFields: { ...profile.fields.pendingFields, state: "available" as const, value: result.pendingFields, freshness },
  } : {
    ...profile.fields,
    isProfileCompleted: { ...profile.fields.isProfileCompleted, state: "unavailable" as const, reason: "check_failed" as const, freshness },
    pendingFields: { ...profile.fields.pendingFields, state: "unavailable" as const, reason: "check_failed" as const, freshness },
  };
  return { result, profile: Object.freeze({ ...profile, fields: Object.freeze(fields) }) };
}
