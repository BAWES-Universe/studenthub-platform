import pg from "pg";
import { createBrowserWriteTokens } from "@studenthub/safe-write-contract";
import { PostgresBankDetailsStore, PostgresLegacyLinkStore, PostgresPersonLocationStore, PostgresPersonProfileStore, PostgresSafeWriteStore, safeWritePrincipalRef } from "@studenthub/db/profile";
import { readLiveLoginSessionPerson } from "@studenthub/db/access";
import { PostgresFinanceReferenceResolver } from "@studenthub/db/pay-contracts";
import { CivilIdVault, OwnProfileRepository, createArea, createCivilId, createPersonImportedFallbackReader, kuwaitDate, type ApprovedProfileAdapter, type CivilIdOcrStore, type CivilIdStore, type OwnProfileReader } from "@studenthub/profile";
import { createBankDetails } from "../bank-details.js";
import { createLanguagePreference } from "../language-preference.js";
import { createProfileBrowserEdit } from "../profile-browser-edit-http.js";
import { createProfileEdit } from "../profile-edit-http.js";
import { HttpLegacyLogin } from "../legacy-login.js";
import { createLegacyLinkService } from "../legacy-link-http.js";
import type { Wired, WiringSettings } from "./context.js";
import type { wireAccess } from "./access.js";
import type { ProfileCompletenessDependencies } from "../profile-completeness.js";
import { isCivilIdReviewStaff } from "../civil-id-review-http.js";

type ReturnTypeAccess = ReturnType<typeof wireAccess>["services"];

type OwnPreferencesReader = { readOwnPreferences(id: string): Promise<object | null | undefined> };

/**
 * The My profile read as production composes it: the approved profile source
 * plus the person's own preferences, civil ID and area, merged in one read.
 * wireProfile builds it over Postgres stores; tests build it over in-memory
 * stores through test/helpers/real-profile-server.ts, so both run this code.
 */
export function composeOwnProfiles(options: {
  readonly principals: ConstructorParameters<typeof OwnProfileRepository>[0]["principals"];
  readonly source: ApprovedProfileAdapter;
  readonly safeWrites?: OwnPreferencesReader;
  readonly personProfiles?: OwnPreferencesReader;
  readonly civilId?: { readOwn(id: string): Promise<unknown> };
  readonly area: { readOwn(id: string): Promise<unknown> };
  readonly today?: () => string;
}): OwnProfileRepository {
  const { safeWrites, personProfiles, civilId, area } = options;
  return new OwnProfileRepository({ principals: options.principals, source: options.source, ...(options.today ? { today: options.today } : {}),
    preferences: { async readOwnPreferences(id: string) {
      const [language, person, civil, location] = await Promise.all([safeWrites?.readOwnPreferences(id), personProfiles?.readOwnPreferences(id), civilId?.readOwn(id), area.readOwn(id).catch(() => null)]);
      const merged = { ...(language ?? {}), ...(person ?? {}), ...(civil ? { civilId: civil } : {}), ...(location ? { area: location } : {}) };
      return Object.keys(merged).length > 0 ? merged as never : null;
    } } });
}

/**
 * The civil ID suggestion service as production composes it, over whatever
 * stores it is given; wireProfile passes Postgres stores, the test helper
 * in-memory ones. The current suggestion is judged against now() in Kuwait.
 */
export function composeCivilIdSuggestion(options: { readonly store: CivilIdOcrStore; readonly civilId: ReturnType<typeof createCivilId>; readonly civilStore: CivilIdStore; readonly vault: CivilIdVault; readonly now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  return { store: options.store, civilId: options.civilId, civilStore: options.civilStore, vault: options.vault, now,
    current: (principalId: string) => options.store.currentSuggestion(principalId, kuwaitDate(now())) };
}

export function wireProfile(settings: WiringSettings, access: ReturnTypeAccess, approvedProfiles: ApprovedProfileAdapter): Wired<{
  readonly application: Record<string, unknown>;
  readonly web: { readonly profiles: OwnProfileReader; readonly profileCompleteness?: ProfileCompletenessDependencies };
  readonly browserSessionPool: pg.Pool | undefined;
  readonly sessions: typeof access.loginStore.sessions;
}> {
  const { databaseUrl, safeWriteKey } = settings;
  const legacyValues = [process.env.LEGACY_CANDIDATE_BASE_URL, process.env.LEGACY_CANDIDATE_ALLOWED_HOST, process.env.LEGACY_PASSWORD_RESET_URL];
  let legacyConfig: {baseUrl:string;allowedHost:string;resetUrl:string}|undefined;
  if (legacyValues.some(value => value !== undefined)) {
    if (!legacyValues.every(value => value !== undefined && value.trim().length > 0)) throw new Error("incomplete legacy account link configuration");
    const reset = new URL(legacyValues[2]!); if (reset.protocol !== "https:") throw new Error("LEGACY_PASSWORD_RESET_URL must use https");
    legacyConfig = { baseUrl: legacyValues[0]!, allowedHost: legacyValues[1]!, resetUrl: reset.href };
    // Validate even when SAFE_WRITE_SIGNING_KEY is absent, so an unsafe target never starts.
    new HttpLegacyLogin({baseUrl:legacyConfig.baseUrl,allowedHost:legacyConfig.allowedHost});
  }
  const legacyStore = legacyConfig && safeWriteKey ? new PostgresLegacyLinkStore({connectionString:databaseUrl}, approvedProfiles) : undefined;
  const profileSource = legacyStore ?? approvedProfiles;
  const CivilIdStore = (PostgresPersonProfileStore as typeof PostgresPersonProfileStore & { CivilIdStore: typeof import("../../../../packages/db/src/postgres-person-civil-id-store.js").PostgresPersonCivilIdStore }).CivilIdStore;
  const civilRaw = process.env.CIVIL_ID_ENCRYPTION_KEY;
  const civilKey = civilRaw === undefined ? undefined : Buffer.from(civilRaw, "base64");
  if (civilRaw !== undefined && (civilKey!.length !== 32 || civilKey!.toString("base64") !== civilRaw)) throw new Error("CIVIL_ID_ENCRYPTION_KEY must be canonical base64 for 32 bytes");
  const civilStore = civilKey ? new CivilIdStore({ connectionString: databaseUrl }) : undefined;
  const civilVault = civilKey ? new CivilIdVault(civilKey) : undefined;
  const civilId = civilStore && civilVault ? createCivilId({ store: civilStore, vault: civilVault }) : undefined;
  const CivilIdOcrStore = (PostgresPersonProfileStore as typeof PostgresPersonProfileStore & { CivilIdOcrStore: typeof import("../../../../packages/db/src/postgres-civil-id-ocr-store.js").PostgresCivilIdOcrStore }).CivilIdOcrStore;
  const civilSuggestionStore = civilKey ? new CivilIdOcrStore({ connectionString: databaseUrl }) : undefined;
  const civilIdSuggestion = civilSuggestionStore && civilId && civilStore && civilVault ? composeCivilIdSuggestion({ store: civilSuggestionStore, civilId, civilStore, vault: civilVault }) : undefined;
  const CivilIdReviewStore = (PostgresPersonProfileStore as typeof PostgresPersonProfileStore & { CivilIdReviewStore: typeof import("../../../../packages/db/src/postgres-civil-id-review-store.js").PostgresCivilIdReviewStore }).CivilIdReviewStore;
  const civilIdReviewStore = civilKey ? new CivilIdReviewStore({ connectionString: databaseUrl }) : undefined;
  const civilIdReview = civilIdReviewStore && civilVault ? { store: civilIdReviewStore, vault: civilVault, secret: civilKey!, async isStaff(principalId:string) { return isCivilIdReviewStaff(await access.authzStore.listGrantsForPrincipal(principalId)); }, ...(civilSuggestionStore ? { async reading(principalId:string) { const result=await civilSuggestionStore.currentSuggestion(principalId,kuwaitDate(new Date())); return result ? { number:result.last4, expiry:result.expiry, state:result.state } : null; } } : {}) } : undefined;
  // Freeze both protocol versions once, never derive them from a request.
  const browserKeyVersion = "profile-browser-key-v1";
  const browserNormalizationVersion = "profile-browser-normalization-v1";
  const browserTokens = safeWriteKey ? createBrowserWriteTokens({ activeKeyVersion: browserKeyVersion,
    keys: { [browserKeyVersion]: safeWriteKey } }) : undefined;
  const browserSessionPool = browserTokens ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
  const importedFallback = createPersonImportedFallbackReader({ source: profileSource });
  const safeWrites = safeWriteKey ? new PostgresSafeWriteStore({ connectionString: databaseUrl }) : undefined;
  const personProfiles = safeWriteKey ? new PostgresPersonProfileStore({ connectionString: databaseUrl }) : undefined;
  const personLocations = new PostgresPersonLocationStore({ connectionString: databaseUrl });
  const area = createArea({ store: personLocations });
  const profiles = composeOwnProfiles({ principals: access.authzStore, source: profileSource, safeWrites, personProfiles, civilId, area });
  // SHU-182: a candidate's own bank details, behind the same signing key.
  const bankDetailsStore = safeWriteKey ? new PostgresBankDetailsStore({ connectionString: databaseUrl }) : undefined;
  const banks = safeWriteKey ? new PostgresFinanceReferenceResolver({ connectionString: databaseUrl }) : undefined;
  const sessions = browserSessionPool ? {
    put: access.loginStore.sessions.put,
    delete: access.loginStore.sessions.delete,
    async get(id: string) {
      const personId = await readLiveLoginSessionPerson(browserSessionPool, id);
      return personId ? { id, personId } : undefined;
    },
  } : access.loginStore.sessions;
  const legacyLink = legacyConfig && safeWriteKey && legacyStore ? createLegacyLinkService({
    legacy: new HttpLegacyLogin({baseUrl:legacyConfig.baseUrl,allowedHost:legacyConfig.allowedHost}), store:legacyStore,
    sessions, authz:access.authzStore, origin: settings.callbackUrl ? new URL(settings.callbackUrl).origin : "",
    resetUrl:legacyConfig.resetUrl, secret:safeWriteKey,
  }) : undefined;
  const webProfiles: OwnProfileReader = legacyStore ? { async readOwn(request) {
    const result = await profiles.readOwn(request);
    if (result.kind !== "found") return result;
    const status = await legacyStore.status(request.targetPersonId);
    return { kind: "found", profile: Object.freeze({ ...result.profile, legacyLinkState: status.linked ? "linked" : "unlinked" }) };
  } } : profiles;
  return {
    services: { application: {
      ...(safeWrites && safeWriteKey
        ? { preferences: createLanguagePreference({ sessions: access.loginStore.sessions, store: safeWrites, secret: safeWriteKey }) }
        : {}),
      ...(personProfiles && safeWriteKey && browserTokens && browserSessionPool ? {
        browserEdit: createProfileBrowserEdit({
          secret: safeWriteKey,
          secure: true,
          choices: () => personProfiles.readOriginChoices(),
          async authorize(session) {
            if (!session) return null;
            const principalId = await readLiveLoginSessionPerson(browserSessionPool, session);
            if (!principalId || !await access.authzStore.getPrincipal(principalId)) return null;
            const canEdit = async (field: string): Promise<boolean> => {
              if (field !== "kuwaitiMother") return true;
              const own = await profiles.readOwn({ requesterPrincipalId: principalId, targetPersonId: principalId });
              if (own.kind !== "found" || own.profile.fields.nationality.state !== "available") return false;
              const nationalityId = own.profile.fields.nationality.editValue;
              const { countries } = await personProfiles.readOriginChoices();
              return countries.some(country => country.id === nationalityId && country.code !== "KW") &&
                !countries.some(country => country.id === nationalityId && country.code === "KW") &&
                await personProfiles.originValueAvailable(principalId, "kuwaitiMother", "true");
            };
            const ownProfile = await profiles.readOwn({ requesterPrincipalId: principalId, targetPersonId: principalId });
            const language = ownProfile.kind === "found" && ownProfile.profile.fields.language.state === "available"
              && ownProfile.profile.fields.language.value === "ar" ? "ar" : "en";
            return { actorRef: safeWritePrincipalRef(principalId), language, store: { ...personProfiles.forBrowserSession({
              principalId, sessionToken: session, tokens: browserTokens,
              normalizationVersion: browserNormalizationVersion,
              sessionLiveness: { read: readLiveLoginSessionPerson }, importedFallback,
            }),
              canEdit,
              async validate(field, canonicalValue) {
                if (field === "kuwaitiMother" && !await canEdit(field)) return "choice";
                if (field === "phone" || field === "handle") return canonicalValue !== "" &&
                  !await personProfiles.contactValueAvailable(principalId, field, canonicalValue) ? "contact_unavailable" : null;
                if (field === "nationality" || field === "university" || field === "kuwaitiMother") return await personProfiles.originValueAvailable(principalId, field, canonicalValue) ? null : "choice";
                return null;
              },
            } };
          },
        }),
      } : {}),
      ...(personProfiles && safeWriteKey ? { profileEdit: createProfileEdit({ sessions: access.loginStore.sessions, store: personProfiles, secret: safeWriteKey }) } : {}),
      ...(bankDetailsStore && banks && safeWriteKey
        ? { bankDetails: createBankDetails({ sessions: access.loginStore.sessions, store: bankDetailsStore, banks, secret: safeWriteKey }) }
        : {}),
      ...(legacyLink ? { legacyLink } : {}),
      ...(civilId ? { civilId } : {}),
      ...(civilIdSuggestion ? { civilIdSuggestion } : {}),
      ...(civilIdReview ? { civilIdReview } : {}),
      area: { area, sessions: access.loginStore.sessions, origin: settings.callbackUrl ? new URL(settings.callbackUrl).origin : "" },
      }, web: { profiles: webProfiles, ...(personProfiles && civilId ? { profileCompleteness: { choices: () => personProfiles.readOriginChoices(), civilId } } : {}) }, browserSessionPool, sessions,
    },
    async close() { await Promise.all([browserSessionPool?.end(), safeWrites?.close(), personProfiles?.close(), personLocations.close(), bankDetailsStore?.close(), banks?.close(), legacyStore?.close(), civilStore?.close(), civilSuggestionStore?.close(), civilIdReviewStore?.close()]); },
  };
}
