import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { deriveProfileCompleteness, type OwnProfileProjection, type ProfileCompletenessSource } from "@studenthub/profile";
import type { ProfileRecordsRuntime } from "./profile-records-http.js";
import type { OriginChoices } from "./profile-edit-http.js";
import { currentProfileAvatar } from "./profile-avatar.js";
import { wantsHtml } from "./web-ui.js";
import type { CandidateDocuments } from "../../../packages/private-documents/src/candidate-lifecycle.js";

type Source<T> = ProfileCompletenessSource<T>;
const available = <T>(value: T): Source<T> => ({ state: "available", value });
const failed = <T>(): Source<T> => ({ state: "failed" });
const unconfigured = <T>(): Source<T> => ({ state: "unconfigured" });
async function capture<T>(operation: () => Promise<T>): Promise<Source<T>> { try { return available(await operation()); } catch { return failed(); } }

export interface ProfileCompletenessDependencies { readonly records?: ProfileRecordsRuntime; readonly documents?: CandidateDocuments; readonly civilIdConfigured?: boolean; }
type RequestState = { readonly dependencies: ProfileCompletenessDependencies; principalEmailPresent?: boolean; personId?: string; civilIdFailed?: boolean };
const requestState = new AsyncLocalStorage<RequestState>();

/** Starts browser-only evidence collection. It deliberately never handles the route. */
export async function handleProfileCompleteness(request: IncomingMessage, _response: ServerResponse, dependencies: ProfileCompletenessDependencies): Promise<boolean> {
  if (request.method === "GET" && request.url?.split("?", 1)[0] === "/profile" && wantsHtml(request.headers.accept)) requestState.enterWith({ dependencies });
  return false;
}

/** Called by the real repository's existing principal read. No additional read is made. */
export function observeProfilePrincipal(personId: string, email: string | undefined): void { const state = requestState.getStore(); if (state) { state.personId = personId; state.principalEmailPresent = Boolean(email?.trim()); } }
export function observeCivilIdFailure(): void { const state = requestState.getStore(); if (state) state.civilIdFailed = true; }

export function applyProfileCompleteness(profile: OwnProfileProjection, result: ReturnType<typeof deriveProfileCompleteness>): OwnProfileProjection {
  const freshness = { kind: "derived" as const, observedAt: profile.asOfDate }, completed = profile.fields.isProfileCompleted, pending = profile.fields.pendingFields;
  const fields = result.kind === "available" ? { ...profile.fields,
    isProfileCompleted: { state: "available" as const, value: result.pendingFields.length === 0, provenance: completed.provenance, freshness },
    pendingFields: { state: "available" as const, value: result.pendingFields, provenance: pending.provenance, freshness },
  } : { ...profile.fields,
    isProfileCompleted: { state: "unavailable" as const, reason: result.reason, provenance: completed.provenance, freshness },
    pendingFields: { state: "unavailable" as const, reason: result.reason, provenance: pending.provenance, freshness },
  };
  return Object.freeze({ ...profile, fields: Object.freeze(fields) });
}

/** Runs only after the established route has found the person's own projection. */
export async function deriveProfileForHtml(profile: OwnProfileProjection, choices: OriginChoices | undefined | null): Promise<OwnProfileProjection> {
  const state = requestState.getStore();
  if (!state) return profile.fields.isProfileCompleted.freshness.kind === "derived" && profile.fields.pendingFields.freshness.kind === "derived"
    ? profile : applyProfileCompleteness(profile, { kind: "unavailable", reason: "check_failed" });
  const avatar = currentProfileAvatar();
  const background = state.dependencies.records && state.personId ? await capture(async () => { const rows = await state.dependencies.records!.service.background(state.personId!); return { educationCount: rows.education.length, skillCount: rows.skill.length }; }) : unconfigured<{ educationCount: number; skillCount: number }>();
  const nationality = profile.fields.nationality;
  const nationalityId = nationality.state === "available" && nationality.freshness.kind === "written_by_person" ? nationality.editValue : undefined;
  const code: Source<string | null> = choices === null ? failed() : choices ? available(choices.countries.find(country => country.id === nationalityId)?.code ?? null) : unconfigured();
  const civil = profile.fields.civilId;
  const civilRecorded = state.civilIdFailed ? failed<{ number: boolean; expiry: boolean }>() : !state.dependencies.civilIdConfigured ? unconfigured<{ number: boolean; expiry: boolean }>()
    : civil?.state === "available" ? available({ number: Boolean(civil.value.maskedNumber), expiry: Boolean(civil.value.expiry) }) : available({ number: false, expiry: false });
  const result = deriveProfileCompleteness({ profile: available(profile),
    principalEmailPresent: state.principalEmailPresent === undefined ? unconfigured() : available(state.principalEmailPresent), activeBackground: background,
    documentTypesOnFile: avatar ? available(avatar.documents.map(row => row.type).filter((type): type is "personal-photo"|"resume"|"civil-id-front"|"civil-id-back" => ["personal-photo","resume","civil-id-front","civil-id-back"].includes(type))) : failed(),
    civilIdRecorded: civilRecorded, writtenNationalityCode: code });
  return applyProfileCompleteness(profile, result);
}
