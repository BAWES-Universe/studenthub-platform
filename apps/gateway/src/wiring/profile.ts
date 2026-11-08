import pg from "pg";
import { createBrowserWriteTokens } from "@studenthub/safe-write-contract";
import { PostgresBankDetailsStore, PostgresLegacyLinkStore, PostgresPersonProfileStore, PostgresSafeWriteStore, safeWritePrincipalRef } from "@studenthub/db/profile";
import { readLiveLoginSessionPerson } from "@studenthub/db/access";
import { PostgresFinanceReferenceResolver } from "@studenthub/db/pay-contracts";
import { CivilIdVault, OwnProfileRepository, createCivilId, createPersonImportedFallbackReader, type ApprovedProfileAdapter, type OwnProfileReader } from "@studenthub/profile";
import { createBankDetails } from "../bank-details.js";
import { createLanguagePreference } from "../language-preference.js";
import { createProfileBrowserEdit } from "../profile-browser-edit-http.js";
import { createProfileEdit } from "../profile-edit-http.js";
import { HttpLegacyLogin } from "../legacy-login.js";
import { createLegacyLinkService } from "../legacy-link-http.js";
import type { Wired, WiringSettings } from "./context.js";
import type { wireAccess } from "./access.js";

type ReturnTypeAccess = ReturnType<typeof wireAccess>["services"];

export function wireProfile(settings: WiringSettings, access: ReturnTypeAccess, approvedProfiles: ApprovedProfileAdapter): Wired<{
  readonly application: Record<string, unknown>;
  readonly web: { readonly profiles: OwnProfileReader };
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
  const civilId = civilStore && civilKey ? createCivilId({ store: civilStore, vault: new CivilIdVault(civilKey) }) : undefined;
  // Freeze both protocol versions once, never derive them from a request.
  const browserKeyVersion = "profile-browser-key-v1";
  const browserNormalizationVersion = "profile-browser-normalization-v1";
  const browserTokens = safeWriteKey ? createBrowserWriteTokens({ activeKeyVersion: browserKeyVersion,
    keys: { [browserKeyVersion]: safeWriteKey } }) : undefined;
  const browserSessionPool = browserTokens ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
  const importedFallback = createPersonImportedFallbackReader({ source: profileSource });
  const safeWrites = safeWriteKey ? new PostgresSafeWriteStore({ connectionString: databaseUrl }) : undefined;
  const personProfiles = safeWriteKey ? new PostgresPersonProfileStore({ connectionString: databaseUrl }) : undefined;
  const profiles = new OwnProfileRepository({ principals: access.authzStore, source: profileSource,
    ...(safeWrites && personProfiles || civilId ? { preferences: { async readOwnPreferences(id: string) {
      const [language, person, civil] = await Promise.all([safeWrites?.readOwnPreferences(id), personProfiles?.readOwnPreferences(id), civilId?.readOwn(id)]);
      const merged = { ...(language ?? {}), ...(person ?? {}), ...(civil ? { civilId: civil } : {}) };
      return Object.keys(merged).length > 0 ? merged as never : null;
    } } } : {}) });
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
    sessions, authz:access.authzStore, origin: process.env.OIDC_CALLBACK_URL ? new URL(process.env.OIDC_CALLBACK_URL).origin : "",
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
      }, web: { profiles: webProfiles }, browserSessionPool, sessions,
    },
    async close() { await Promise.all([browserSessionPool?.end(), safeWrites?.close(), personProfiles?.close(), bankDetailsStore?.close(), banks?.close(), legacyStore?.close(), civilStore?.close()]); },
  };
}
