import { randomBytes } from "node:crypto";

import { UNIVERSE_SUBJECT_POLICY } from "@bawes/actor-assertion";
import { PostgresAuthzStore, PostgresLoginStore, PostgresSafeWriteStore, PostgresOrganizationProfileStore, PostgresOrganizationProfileReads,
  PostgresBankDetailsStore, PostgresFinanceReferenceResolver, PostgresPayContractStore, PostgresPayContractSafeWriteStore, PostgresOrganizationStatusStore,PostgresOrganizationCommercialTermsStore,PostgresOrganizationApprovedToHireStore,PostgresOrganizationAccountManagerStore,PostgresOrganizationAccountManagerReads,PostgresOrganizationNotesStore,PostgresOrganizationBrandsStore,PostgresOrganizationDeletionStore,PostgresOrganizationStoresStore,PostgresOrganizationCreationStore, PostgresPersonProfileStore } from "@studenthub/db";
import type {
  AuthorizationRequest,
  JwksResolver,
  OidcTransport,
  TestJsonWebKey,
  TokenRequest,
  TokenResponse,
} from "@studenthub/login-contract";
import {
  OwnProfileRepository,
  UnconfiguredApprovedProfileAdapter,
  type ApprovedProfileAdapter,
} from "@studenthub/profile";

import { createLoginApplication } from "./login-application.js";
import { OrganizationRepository, UnconfiguredApprovedOrganizationAdapter, organizationOwnerDecision,
  organizationProfileStateDecision, organizationProfileRecordRef, organizationProfilePrincipalRef,
  organizationStatusDecision, organizationStatusStateDecision, organizationStatusEvent, organizationStatusRecordRef, organizationStatusPrincipalRef,
  organizationCommercialTermsDecision,organizationCommercialTermsStateDecision,organizationCommercialTermsRecordRef,organizationCommercialTermsPrincipalRef,
  organizationApprovedToHireDecision,organizationApprovedToHireStateDecision,organizationApprovedToHireRecordRef,organizationApprovedToHirePrincipalRef,
  organizationAccountManagerDecision,organizationAccountManagerReadDecision,organizationEligibleAccountManagersView,organizationAccountManagerStateDecision,organizationAccountManagerRecordRef,organizationAccountManagerPrincipalRef,
  organizationNoteDecision,organizationNoteRecordRef,organizationNotePrincipalRef,organizationNoteTypeOf,organizationBrandDecision,organizationBrandLinkOutcome,organizationBrandUnlinkOutcome,organizationStoreWriteDecision,organizationStoreReadDecision,organizationCreationDecision,organizationCreationParentAllowed,organizationDeletionDecision,organizationDeletionBlockers,organizationDeletionRecordRef,organizationDeletionPrincipalRef,DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import {payContractWriteDecision,payContractReadAccess,payContractCreator,payContractCreateCheck,payContractCompanyRecordRef,payContractPrincipalRef,payContractRecordRef,payContractChanger,payContractStateDecision,payContractEditableValue,payContractChangeCheck} from "@studenthub/pay-contracts";
import { createContextNavigation } from "./context-navigation.js";
import { createCompanyDirectory } from "./company-directory.js";
import { createLanguagePreference } from "./language-preference.js";
import { createProfileEdit } from "./profile-edit-http.js";
import { createOrganizationProfile } from "./organization-profile.js";
import { createOrganizationStatus } from "./organization-status.js";
import {createOrganizationCommercialTerms}from"./organization-commercial-terms.js";
import {createOrganizationApprovedToHire}from"./organization-approved-to-hire.js";
import {createOrganizationAccountManager}from"./organization-account-manager.js";
import {createOrganizationNotes}from"./organization-notes.js";
import {createOrganizationBrands}from"./organization-brands.js";
import {createOrganizationStores}from"./organization-stores.js";
import {createOrganizationDeletion}from"./organization-deletion.js";
import {createOrganizationCreation}from"./organization-creation.js";
import {createPayContracts}from"./pay-contracts-http.js";
import { createBankDetails } from "./bank-details.js";
import type { BrowserLoginApplication } from "./web-ui.js";

interface JwksDocument {
  readonly keys?: readonly TestJsonWebKey[];
}

const DEFAULT_OIDC_HTTP_TIMEOUT_MS = 10_000;

export class HttpOidcTransport implements OidcTransport {
  readonly #issuer: string;
  readonly #authorizationEndpoint: string;
  readonly #tokenEndpoint: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(
    issuer: string,
    authorizationEndpoint: string,
    tokenEndpoint: string,
    requestTimeoutMs = DEFAULT_OIDC_HTTP_TIMEOUT_MS,
    fetchImplementation: typeof fetch = fetch,
  ) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError("OIDC request timeout must be a positive safe integer");
    }
    this.#issuer = issuer;
    this.#authorizationEndpoint = authorizationEndpoint;
    this.#tokenEndpoint = tokenEndpoint;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = fetchImplementation;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    if (request.issuer !== this.#issuer) throw new Error("authorization issuer mismatch");
    const url = new URL(this.#authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallengeMethod,
    }).toString();
    return url.toString();
  }

  async exchange(request: TokenRequest): Promise<TokenResponse> {
    const response = await this.#fetch(this.#tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: request.code,
        client_id: request.clientId,
        client_secret: request.clientSecret,
        redirect_uri: request.redirectUri,
        code_verifier: request.codeVerifier,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("OIDC token exchange failed");
    }
    const payload = await response.json() as { readonly access_token?: unknown; readonly id_token?: unknown };
    if (typeof payload.access_token !== "string" || typeof payload.id_token !== "string") {
      throw new Error("OIDC token response is malformed");
    }
    return { accessToken: payload.access_token, idToken: payload.id_token };
  }
}

export class RefreshingJwksResolver implements JwksResolver {
  readonly #keys = new Map<string, { readonly jwk: TestJsonWebKey; readonly expiresAt: number }>();
  readonly #issuer: string;
  readonly #jwksUrl: string;
  readonly #ttlSeconds: number;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(
    issuer: string,
    jwksUrl: string,
    ttlSeconds = 300,
    requestTimeoutMs = DEFAULT_OIDC_HTTP_TIMEOUT_MS,
    fetchImplementation: typeof fetch = fetch,
  ) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError("OIDC request timeout must be a positive safe integer");
    }
    this.#issuer = issuer;
    this.#jwksUrl = jwksUrl;
    this.#ttlSeconds = ttlSeconds;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = fetchImplementation;
  }

  async resolve(issuer: string, kid: string): Promise<TestJsonWebKey | undefined> {
    if (issuer !== this.#issuer) return undefined;
    const cacheKey = `${issuer}\u0000${kid}`;
    const cached = this.#keys.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() / 1000) return cached.jwk;

    // Refresh on expiry and every unknown kid. Keys absent from the latest
    // issuer document are evicted, so rotation cannot fall back to a retired
    // key indefinitely.
    const response = await this.#fetch(this.#jwksUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("OIDC JWKS refresh failed");
    }
    const document = await response.json() as JwksDocument;
    if (!Array.isArray(document.keys)) throw new Error("OIDC JWKS is malformed");
    this.#keys.clear();
    const expiresAt = Date.now() / 1000 + this.#ttlSeconds;
    for (const jwk of document.keys) {
      if (typeof jwk.kid === "string" && typeof jwk.kty === "string") {
        this.#keys.set(`${issuer}\u0000${jwk.kid}`, { jwk, expiresAt });
      }
    }
    return this.#keys.get(cacheKey)?.jwk;
  }
}

export interface RuntimeLogin {
  readonly application: BrowserLoginApplication;
  close(): Promise<void>;
}

/** Build the real login stack only when the complete explicit env contract is present. */
export function createRuntimeLoginFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  approvedProfiles: ApprovedProfileAdapter = new UnconfiguredApprovedProfileAdapter(),
): RuntimeLogin | undefined {
  const names = [
    "DATABASE_URL",
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_CALLBACK_URL",
    "OIDC_AUTHORIZATION_URL",
    "OIDC_TOKEN_URL",
    "OIDC_JWKS_URL",
    "LOGIN_ALLOWED_RETURN_URLS",
  ] as const;
  const present = names.filter((name) => env[name] !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== names.length) {
    throw new Error(`incomplete login configuration: missing ${names.filter((name) => !env[name]).join(", ")}`);
  }

  const value = (name: typeof names[number]): string => env[name]!;
  for (const name of ["DATABASE_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const) {
    if (value(name).trim().length === 0) throw new Error(`${name} must be non-empty`);
  }
  const issuer = exactHttpsUrl(value("OIDC_ISSUER"), "OIDC_ISSUER");
  const callbackUrl = exactHttpsUrl(value("OIDC_CALLBACK_URL"), "OIDC_CALLBACK_URL");
  if (new URL(callbackUrl).pathname !== "/login/callback") {
    throw new Error("OIDC_CALLBACK_URL must target the gateway /login/callback route");
  }
  const authorizationUrl = exactHttpsUrl(value("OIDC_AUTHORIZATION_URL"), "OIDC_AUTHORIZATION_URL");
  const tokenUrl = exactHttpsUrl(value("OIDC_TOKEN_URL"), "OIDC_TOKEN_URL");
  const jwksUrl = exactHttpsUrl(value("OIDC_JWKS_URL"), "OIDC_JWKS_URL");
  if (value("LOGIN_ALLOWED_RETURN_URLS").trim().length === 0) {
    throw new Error("LOGIN_ALLOWED_RETURN_URLS must not be empty");
  }
  const allowedReturnUrls = value("LOGIN_ALLOWED_RETURN_URLS").split(",").map((item) =>
    exactHttpsUrl(item.trim(), "LOGIN_ALLOWED_RETURN_URLS"));

  // SHU-84: the first safe write is off unless its own signing key is set. The
  // deployment does not pass this variable, so no deployed gateway writes.
  const safeWriteKey = safeWriteSigningKey(env.SAFE_WRITE_SIGNING_KEY);
  const loginStore = new PostgresLoginStore({ connectionString: value("DATABASE_URL") });
  const authzStore = new PostgresAuthzStore({ connectionString: value("DATABASE_URL") });
  const safeWrites = safeWriteKey ? new PostgresSafeWriteStore({ connectionString: value("DATABASE_URL") }) : undefined;
  const personProfiles = safeWriteKey ? new PostgresPersonProfileStore({ connectionString: value("DATABASE_URL") }) : undefined;
  const profiles = new OwnProfileRepository({ principals: authzStore, source: approvedProfiles,
    ...(safeWrites && personProfiles ? { preferences: { async readOwnPreferences(id: string) {
      const [language, person, profileChoices] = await Promise.all([safeWrites.readOwnPreferences(id), personProfiles.readOwnPreferences(id), personProfiles.readProfileChoices()]);
      const written = { ...(language ?? {}), ...(person ?? {}) };
      return { ...written, profileChoices } as never;
    } } } : {}) });
  const organizationProfileStore = safeWriteKey ? new PostgresOrganizationProfileStore({ connectionString:value("DATABASE_URL"),
    ownerDecision:organizationOwnerDecision,stateDecision:organizationProfileStateDecision,
    recordRef:organizationProfileRecordRef,principalRef:organizationProfilePrincipalRef }) : undefined;
  const organizationProfileReads = new PostgresOrganizationProfileReads({connectionString:value("DATABASE_URL")});
  const organizationStatusStore = new PostgresOrganizationStatusStore({connectionString:value("DATABASE_URL"),
    decision:organizationStatusDecision,stateDecision:organizationStatusStateDecision,event:organizationStatusEvent,
    recordRef:organizationStatusRecordRef,principalRef:organizationStatusPrincipalRef});
  const organizationCommercialTermsStore=new PostgresOrganizationCommercialTermsStore({connectionString:value("DATABASE_URL"),decision:organizationCommercialTermsDecision,stateDecision:organizationCommercialTermsStateDecision,recordRef:organizationCommercialTermsRecordRef,principalRef:organizationCommercialTermsPrincipalRef});
  const organizationApprovedToHireStore=new PostgresOrganizationApprovedToHireStore({connectionString:value("DATABASE_URL"),decision:organizationApprovedToHireDecision,stateDecision:organizationApprovedToHireStateDecision,recordRef:organizationApprovedToHireRecordRef,principalRef:organizationApprovedToHirePrincipalRef});
  const organizationAccountManagerStore=new PostgresOrganizationAccountManagerStore({connectionString:value("DATABASE_URL"),decision:organizationAccountManagerDecision,readDecision:organizationAccountManagerReadDecision,eligibleView:organizationEligibleAccountManagersView,stateDecision:organizationAccountManagerStateDecision,recordRef:organizationAccountManagerRecordRef,principalRef:organizationAccountManagerPrincipalRef});
  const organizationAccountManagerReads=new PostgresOrganizationAccountManagerReads({connectionString:value("DATABASE_URL"),decision:organizationAccountManagerReadDecision});
  const organizationNotesStore=new PostgresOrganizationNotesStore({connectionString:value("DATABASE_URL"),decision:organizationNoteDecision,recordRef:organizationNoteRecordRef,principalRef:organizationNotePrincipalRef,noteType:organizationNoteTypeOf});
  const organizationBrandsStore=new PostgresOrganizationBrandsStore({connectionString:value("DATABASE_URL"),decision:organizationBrandDecision,linkOutcome:organizationBrandLinkOutcome,unlinkOutcome:organizationBrandUnlinkOutcome});
  const organizationStoresStore=new PostgresOrganizationStoresStore({connectionString:value("DATABASE_URL"),writeDecision:organizationStoreWriteDecision,readDecision:organizationStoreReadDecision});
  const organizationCreationStore=new PostgresOrganizationCreationStore({connectionString:value("DATABASE_URL"),decision:organizationCreationDecision,parentAllowed:(parent,grand)=>organizationCreationParentAllowed(parent,grand,DEFAULT_OPERATOR_ORG_IDS)});
  const organizationDeletionStore=new PostgresOrganizationDeletionStore({connectionString:value("DATABASE_URL"),decision:organizationDeletionDecision,blockers:organizationDeletionBlockers,recordRef:organizationDeletionRecordRef,principalRef:organizationDeletionPrincipalRef});
  // SHU-182: a candidate's own bank details, behind the same signing key.
  const bankDetailsStore = safeWriteKey ? new PostgresBankDetailsStore({ connectionString: value("DATABASE_URL") }) : undefined;
  const banks = safeWriteKey ? new PostgresFinanceReferenceResolver({ connectionString: value("DATABASE_URL") }) : undefined;
  const payContracts = new PostgresPayContractStore({ connectionString: value("DATABASE_URL") });
  const payContractReferences = new PostgresFinanceReferenceResolver({ connectionString: value("DATABASE_URL") });
  const payContractWrites = new PostgresPayContractSafeWriteStore({connectionString:value("DATABASE_URL"),
    decision:(rows,company,ancestors)=>payContractWriteDecision(rows,company,ancestors,DEFAULT_OPERATOR_ORG_IDS),
    readDecision:(rows,company,ancestors)=>payContractReadAccess(rows,company,ancestors,DEFAULT_OPERATOR_ORG_IDS),
    creator:payContractCreator(payContractReferences),changer:payContractChanger(payContractReferences),stateDecision:payContractStateDecision,editableValue:payContractEditableValue,recordRef:payContractCompanyRecordRef,contractRecordRef:payContractRecordRef,principalRef:payContractPrincipalRef});
  const application = createLoginApplication({
    oidc: new HttpOidcTransport(issuer, authorizationUrl, tokenUrl),
    clock: { nowEpochSeconds: () => Math.floor(Date.now() / 1000) },
    entropy: { bytes: (length) => randomBytes(length) },
    states: loginStore.states,
    sessions: loginStore.sessions,
    identities: loginStore.identities,
    authorization: {
      async roleFor(personId) {
        // Session ownership proves access to this one profile. The principal
        // must still exist in the persistent authz store on every request.
        if (!await authzStore.getPrincipal(personId)) throw new Error("unknown principal");
        return "self";
      },
    },
    jwks: new RefreshingJwksResolver(issuer, jwksUrl),
  }, {
    issuer,
    clientId: value("OIDC_CLIENT_ID"),
    clientSecret: value("OIDC_CLIENT_SECRET"),
    callbackUrl,
    allowedReturnUrls,
    clockSkewSeconds: 60,
    subjectPolicy: (subject) => UNIVERSE_SUBJECT_POLICY.humanSubjectPattern.test(subject),
  });
  // Organization snapshots stay unconfigured until an approved import exists:
  // the card and the company list show registry names and visibly unavailable fields.
  const organizations = new OrganizationRepository({
    store: authzStore, source: new UnconfiguredApprovedOrganizationAdapter(), statusRecords:organizationStatusStore,commercialTerms:organizationCommercialTermsStore,approvedToHire:organizationApprovedToHireStore,deletions:organizationDeletionStore,storeCounts:organizationStoresStore,accountManagers:organizationAccountManagerReads,profiles:organizationProfileReads,
  });
  return {
    application: {
      ...application,
      navigation: createContextNavigation(loginStore.sessions, authzStore, Object.assign(organizations,{accountManagers:organizationAccountManagerStore}), organizationDeletionStore, organizationStatusStore),
      companies: createCompanyDirectory(loginStore.sessions, authzStore, organizations, organizationAccountManagerStore),
      ...(safeWrites && safeWriteKey
        ? { preferences: createLanguagePreference({ sessions: loginStore.sessions, store: safeWrites, secret: safeWriteKey }) }
        : {}),
      ...(personProfiles && safeWriteKey ? { profileEdit: createProfileEdit({ sessions: loginStore.sessions, store: personProfiles, secret: safeWriteKey }) } : {}),
      ...(bankDetailsStore && banks && safeWriteKey
        ? { bankDetails: createBankDetails({ sessions: loginStore.sessions, store: bankDetailsStore, banks, secret: safeWriteKey }) }
        : {}),
      ...(organizationProfileStore && safeWriteKey ? { organizationProfile: createOrganizationProfile({sessions:loginStore.sessions,store:organizationProfileStore,secret:safeWriteKey}) } : {}),
      ...(safeWriteKey ? {organizationStatus:createOrganizationStatus({sessions:loginStore.sessions,store:organizationStatusStore,secret:safeWriteKey})}:{}),
      ...(safeWriteKey?{organizationCommercialTerms:createOrganizationCommercialTerms({sessions:loginStore.sessions,store:organizationCommercialTermsStore,secret:safeWriteKey})}:{}),
      ...(safeWriteKey?{organizationApprovedToHire:createOrganizationApprovedToHire({sessions:loginStore.sessions,store:organizationApprovedToHireStore,secret:safeWriteKey})}:{}),
      ...({organizationAccountManager:createOrganizationAccountManager({sessions:loginStore.sessions,store:organizationAccountManagerStore,...(safeWriteKey?{secret:safeWriteKey}:{})})} as {}),
      ...(safeWriteKey?{organizationNotes:createOrganizationNotes({sessions:loginStore.sessions,store:organizationNotesStore,secret:safeWriteKey})}:{}),
      ...({organizationBrands:createOrganizationBrands({sessions:loginStore.sessions,store:organizationBrandsStore})} as {}),
      ...({organizationStores:createOrganizationStores({sessions:loginStore.sessions,store:organizationStoresStore})} as {}),
      ...({organizationCreation:createOrganizationCreation({sessions:loginStore.sessions,store:organizationCreationStore})} as {}),
      ...(safeWriteKey?{organizationDeletion:createOrganizationDeletion({sessions:loginStore.sessions,store:organizationDeletionStore,secret:safeWriteKey})}:{}),
      ...{payContracts:createPayContracts({sessions:loginStore.sessions,store:payContractWrites,contracts:payContracts,
        ...(safeWriteKey?{secret:safeWriteKey,check:payContractCreateCheck({references:payContractReferences,contracts:payContracts,candidates:payContractWrites}),changeCheck:payContractChangeCheck({references:payContractReferences,contracts:payContracts})}: {})})},
      web: {
        origin: new URL(callbackUrl).origin,
        // Keep the existing exact return allowlist. No Host-derived redirect,
        // new IdP configuration, or implicit expansion of approved targets.
        returnTo: allowedReturnUrls.includes(new URL("/profile", callbackUrl).href)
          ? new URL("/profile", callbackUrl).href : undefined,
        // Called only after application.profile establishes session ownership;
        // the repository independently re-enforces the same owner boundary.
        profiles,
      },
    },
    async close() {
      await Promise.all([loginStore.close(), authzStore.close(), safeWrites?.close(), personProfiles?.close(), organizationProfileStore?.close(), organizationProfileReads.close(), organizationStatusStore.close(),organizationCommercialTermsStore.close(),organizationApprovedToHireStore.close(),organizationAccountManagerStore.close(),organizationAccountManagerReads.close(),organizationNotesStore.close(),
        organizationBrandsStore.close(),organizationStoresStore.close(),organizationCreationStore.close(),organizationDeletionStore.close(),bankDetailsStore?.close(), banks?.close(),payContracts.close(),payContractReferences.close(),payContractWrites.close()]);
    },
  };
}

/** Base64 of at least 32 random bytes, exactly as encoded; anything else refuses to start. */
function safeWriteSigningKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined) return undefined;
  const key = Buffer.from(raw, "base64");
  if (key.toString("base64") !== raw || key.length < 32) {
    throw new Error("SAFE_WRITE_SIGNING_KEY must be base64 of at least 32 bytes");
  }
  return key;
}

function exactHttpsUrl(raw: string, name: string): string {
  if (raw !== raw.trim()) throw new Error(`${name} must be an exact URL without surrounding whitespace`);
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`${name} must use https`);
  if (url.username || url.password || url.hash) throw new Error(`${name} must not contain credentials or a fragment`);
  // Preserve the configured wire value. In particular, adding a trailing
  // slash would break OIDC's exact `iss` comparison.
  return raw;
}
