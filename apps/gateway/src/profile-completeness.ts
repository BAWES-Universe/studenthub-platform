import type { IncomingMessage, ServerResponse } from "node:http";
import { deriveProfileCompleteness, type OwnProfileProjection, type ProfileCompletenessSource } from "@studenthub/profile";
import type { PrincipalStore } from "@studenthub/contracts";
import type { ProfileRecordsRuntime } from "./profile-records-http.js";
import type { BrowserLoginApplication } from "./web-ui.js";
import type { OriginChoices } from "./profile-edit-http.js";
import { addNotificationBell, profileDocument, wantsHtml } from "./web-ui.js";
import { currentProfileAvatar } from "./profile-avatar.js";

type Source<T> = ProfileCompletenessSource<T>;
const available = <T>(value: T): Source<T> => ({ state: "available", value });
const failed = <T>(): Source<T> => ({ state: "failed" });
const unconfigured = <T>(): Source<T> => ({ state: "unconfigured" });
async function capture<T>(operation: () => Promise<T>): Promise<Source<T>> { try { return available(await operation()); } catch { return failed(); } }
const cookie = (request: IncomingMessage): string | undefined => request.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith("__Host-studenthub_session="))?.split("=")[1];

export interface ProfileCompletenessDependencies {
  readonly principals: Pick<PrincipalStore, "getPrincipal">;
  readonly records?: ProfileRecordsRuntime;
}

export function applyProfileCompleteness(profile: OwnProfileProjection, result: ReturnType<typeof deriveProfileCompleteness>): OwnProfileProjection {
  const freshness = { kind: "derived" as const, observedAt: profile.asOfDate };
  const completed = profile.fields.isProfileCompleted;
  const pending = profile.fields.pendingFields;
  const fields = result.kind === "available" ? {
    ...profile.fields,
    isProfileCompleted: { state: "available" as const, value: result.pendingFields.length === 0, provenance: completed.provenance, freshness },
    pendingFields: { state: "available" as const, value: result.pendingFields, provenance: pending.provenance, freshness },
  } : {
    ...profile.fields,
    isProfileCompleted: { state: "unavailable" as const, reason: result.reason, provenance: completed.provenance, freshness },
    pendingFields: { state: "unavailable" as const, reason: result.reason, provenance: pending.provenance, freshness },
  };
  return Object.freeze({ ...profile, fields: Object.freeze(fields) });
}

export async function handleProfileCompleteness(request: IncomingMessage, response: ServerResponse,
  login: BrowserLoginApplication | undefined, dependencies: ProfileCompletenessDependencies,
  writeHtml: (response: ServerResponse, status: number, html: string, headers?: Record<string, string>) => void): Promise<boolean> {
  if (request.method !== "GET" || request.url?.split("?", 1)[0] !== "/profile" || !wantsHtml(request.headers.accept) || !login) return false;
  const url = new URL(request.url, "http://gateway.invalid");
  let authorization;
  try { authorization = await login.profile({ sessionId: cookie(request), personId: url.searchParams.get("person_id") ?? undefined }); } catch { return false; }
  if (authorization.status !== 200 || !login.web) return false;
  const personId = authorization.body?.personId;
  if (typeof personId !== "string" || (url.searchParams.get("person_id") !== null && url.searchParams.get("person_id") !== personId)) return false;
  let own;
  try { own = await login.web.profiles.readOwn({ requesterPrincipalId: personId, targetPersonId: personId }); } catch { return false; }
  if (own.kind !== "found") return false;
  const avatar = currentProfileAvatar();
  const readChoices = login.profileEdit?.choices;
  const choicesPromise: Promise<Source<OriginChoices>> = readChoices ? capture(() => readChoices()) : Promise.resolve(unconfigured<OriginChoices>());
  const [email, background, civil, choices] = await Promise.all([
    capture(async () => Boolean((await dependencies.principals.getPrincipal(personId))?.email?.trim())),
    dependencies.records ? capture(async () => { const value = await dependencies.records!.service.background(personId); return { educationCount: value.education.length, skillCount: value.skill.length }; }) : Promise.resolve(unconfigured<{educationCount:number;skillCount:number}>()),
    login.civilId ? capture(async () => { const value = await login.civilId!.readOwn(personId); return { number: Boolean(value?.maskedNumber), expiry: Boolean(value?.expiry) }; }) : Promise.resolve(unconfigured<{number:boolean;expiry:boolean}>()),
    choicesPromise,
  ] as const);
  const nationality = own.profile.fields.nationality;
  const nationalityId = nationality.state === "available" && nationality.freshness.kind === "written_by_person" ? nationality.editValue : undefined;
  const code = choices.state === "available" ? available(choices.value.countries.find(country => country.id === nationalityId)?.code ?? null) : choices;
  const result = deriveProfileCompleteness({ profile: available(own.profile), principalEmailPresent: email, activeBackground: background,
    documentTypesOnFile: avatar ? available(avatar.documents.map(document => document.type).filter((type): type is "personal-photo"|"resume"|"civil-id-front"|"civil-id-back" => ["personal-photo","resume","civil-id-front","civil-id-back"].includes(type))) : failed(), civilIdRecorded: civil, writtenNationalityCode: code });
  const projection = applyProfileCompleteness(own.profile, result);
  const page = await profileDocument({ status: 200, body: projection }, login, undefined, true, undefined,
    choices.state === "available" ? choices.value : { countries: [], universities: [] });
  let html: string;
  try { html = addNotificationBell(page.html, await login.notifications?.count(cookie(request)) ?? 0); }
  catch { html = addNotificationBell(page.html, 0); }
  writeHtml(response, 200, html);
  return true;
}
