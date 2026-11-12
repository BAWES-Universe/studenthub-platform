import { deriveProfileCompleteness, type CivilIdService, type OwnProfileProjection, type ProfileCompletenessResult } from "@studenthub/profile";
import type { ProfileRecordsRuntime } from "./profile-records-http.js";
import type { ProfileAvatarRead } from "./profile-avatar.js";

export interface ProfileCompletenessDependencies {
  choices(): Promise<{ readonly countries: readonly { readonly id: string; readonly code: string | null }[] }>;
  readonly civilId: Pick<CivilIdService, "readOwn">;
}
export interface GatheredProfileCompleteness { readonly result: ProfileCompletenessResult; readonly profile: OwnProfileProjection }
const failed = { state: "failed" } as const;

export async function gatherProfileCompleteness(input: { readonly principalId: string; readonly email?: string; readonly profile: OwnProfileProjection; readonly avatar?: ProfileAvatarRead; readonly records?: ProfileRecordsRuntime; readonly dependencies?: ProfileCompletenessDependencies }): Promise<GatheredProfileCompleteness> {
  const [background, choices, civil] = await Promise.all([
    input.records?.service.background(input.principalId).then(value => ({ state: "available", value: { educationCount: value.education.length, skillCount: value.skill.length } } as const)).catch(() => failed) ?? Promise.resolve(failed),
    input.dependencies?.choices().then(value => ({ state: "available", value } as const)).catch(() => failed) ?? Promise.resolve(failed),
    input.dependencies?.civilId.readOwn(input.principalId).then(value => ({ state: "available", value: { number: typeof value?.maskedNumber === "string" && value.maskedNumber.trim().length > 0, expiry: typeof value?.expiry === "string" && value.expiry.trim().length > 0 } } as const)).catch(() => failed) ?? Promise.resolve(failed),
  ]);
  const nationality = input.profile.fields.nationality;
  const nationalityId = nationality.state === "available" && nationality.freshness.kind === "written_by_person" ? nationality.editValue : undefined;
  const nationalityCode = choices.state === "available" && nationalityId !== undefined ? choices.value.countries.find(country => country.id === nationalityId)?.code ?? null : null;
  const result = deriveProfileCompleteness({
    profile: { state: "available", value: input.profile },
    principalEmailPresent: { state: "available", value: typeof input.email === "string" && input.email.trim().length > 0 },
    activeBackground: background,
    documentTypesOnFile: input.avatar ? { state: "available", value: input.avatar.documents.map(document => document.type).filter((type): type is "personal-photo" | "resume" | "civil-id-front" | "civil-id-back" => type === "personal-photo" || type === "resume" || type === "civil-id-front" || type === "civil-id-back") } : failed,
    civilIdRecorded: civil,
    writtenNationalityCode: choices.state === "available" ? { state: "available", value: nationalityCode } : failed,
  });
  const freshness = Object.freeze({ kind: "derived" as const, observedAt: input.profile.asOfDate });
  const completed = input.profile.fields.isProfileCompleted, pending = input.profile.fields.pendingFields;
  const fields = result.kind === "available" ? { ...input.profile.fields,
    isProfileCompleted: { state: "available" as const, value: result.pendingFields.length === 0, provenance: completed.provenance, freshness },
    pendingFields: { state: "available" as const, value: result.pendingFields, provenance: pending.provenance, freshness },
  } : { ...input.profile.fields,
    isProfileCompleted: { state: "unavailable" as const, reason: "check_failed" as const, provenance: completed.provenance, freshness },
    pendingFields: { state: "unavailable" as const, reason: "check_failed" as const, provenance: pending.provenance, freshness },
  };
  return { result, profile: Object.freeze({ ...input.profile, fields: Object.freeze(fields) }) };
}
