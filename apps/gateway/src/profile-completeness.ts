import { deriveProfileCompleteness, type OwnProfileProjection, type ProfileCompletenessDocumentType, type ProfileCompletenessResult } from "@studenthub/profile";
import type { ProfileRecordsRuntime } from "./profile-records-http.js";
import type { BrowserLoginApplication } from "./web-ui.js";
import { currentProfileAvatar } from "./profile-avatar.js";

export interface ProfileCompletenessView {
  readonly result: ProfileCompletenessResult;
  readonly profile: OwnProfileProjection;
  readonly choices: Awaited<ReturnType<NonNullable<NonNullable<BrowserLoginApplication["profileEdit"]>["choices"]>>> | null;
}

const failed = { state: "failed" } as const;
const attempt = <T>(operation: () => Promise<T>) => {
  try { return operation().then(value => ({ state: "available" as const, value }), () => failed); }
  catch { return Promise.resolve(failed); }
};

export async function gatherProfileCompleteness(
  profile: OwnProfileProjection,
  principalId: string,
  principalEmail: unknown,
  login: Partial<BrowserLoginApplication>,
  records: ProfileRecordsRuntime | undefined,
): Promise<ProfileCompletenessView> {
  const avatar = currentProfileAvatar();
  const background = records
    ? await attempt(() => records.service.background(principalId)).then(read => read.state === "available" ? ({ state: "available" as const, value: { educationCount: read.value.education.length, skillCount: read.value.skill.length } }) : read)
    : { state: "unconfigured" as const };
  const choices = login.profileEdit?.choices
    ? await attempt(() => login.profileEdit!.choices!())
    : { state: "unconfigured" as const };
  const civil = login.civilId
    ? await attempt(() => login.civilId!.readOwn(principalId)).then(read => read.state === "available" ? ({ state: "available" as const, value: { number: Boolean(read.value?.maskedNumber), expiry: Boolean(read.value?.expiry) } }) : read)
    : { state: "unconfigured" as const };
  const nationality = profile.fields.nationality;
  const nationalityId = nationality.state === "available" ? nationality.editValue : undefined;
  const nationalityCode = choices.state === "available"
    ? (nationalityId === undefined ? null : choices.value.countries.find(country => country.id === nationalityId)?.code ?? null)
    : null;
  const result = deriveProfileCompleteness({
    profile: { state: "available", value: profile },
    principalEmailPresent: { state: "available", value: typeof principalEmail === "string" && principalEmail.trim().length > 0 },
    activeBackground: background,
    documentTypesOnFile: avatar ? { state: "available", value: avatar.documents.map(document => document.type).filter((type): type is ProfileCompletenessDocumentType => type === "personal-photo" || type === "resume" || type === "civil-id-front" || type === "civil-id-back") } : { state: "failed" },
    civilIdRecorded: civil,
    writtenNationalityCode: choices.state === "available" ? { state: "available", value: nationalityCode } : choices,
  });
  const source = profile.fields.isProfileCompleted;
  const freshness = { kind: "derived" as const, observedAt: new Date().toISOString() };
  const fields = result.kind === "available"
    ? { ...profile.fields,
        isProfileCompleted: { state: "available" as const, value: result.pendingFields.length === 0, provenance: source.provenance, freshness },
        pendingFields: { state: "available" as const, value: result.pendingFields, provenance: profile.fields.pendingFields.provenance, freshness } }
    : { ...profile.fields,
        isProfileCompleted: { state: "unavailable" as const, reason: "check_failed" as const, provenance: source.provenance, freshness },
        pendingFields: { state: "unavailable" as const, reason: "check_failed" as const, provenance: profile.fields.pendingFields.provenance, freshness } };
  return { result, profile: Object.freeze({ ...profile, fields: Object.freeze(fields) }), choices: choices.state === "available" ? choices.value : null };
}
