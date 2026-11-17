import { randomBytes } from "node:crypto";
import { createPublicKey } from "node:crypto";
import { HASHED_USER_ID_SUBJECT_POLICY, UNIVERSE_SUBJECT_POLICY, USER_EMAIL_SUBJECT_POLICY, type SubjectPolicy } from "@bawes/actor-assertion";
import { InMemoryIssuerKeyRegistry } from "@studenthub/contracts";
import { PostgresLoginStore } from "@studenthub/db/access";
import { PostgresReplayStore } from "@studenthub/db/assertions";
import { PostgresUniverseEmbedStore } from "@studenthub/db/universe";
import type { OwnProfileReader } from "@studenthub/profile";
import { registryKeyResolver } from "../authz-middleware.js";
import { HttpOidcTransport, RefreshingJwksResolver } from "../login-runtime.js";
import type { UniverseEmbedConfig } from "../universe/embed-policy.js";
import type { EmbedProfileField, EmbedProfileSource, EmbedProfileView, UniverseEmbedRuntime } from "../universe/embed-service.js";
import { sameProviderSubjectMapping } from "../universe/host-identity.js";

/** E2 configuration names. All or none; partial configuration refuses startup. */
const E2_NAMES = [
  "UNIVERSE_EMBED_PUSHER_ISSUER",
  "UNIVERSE_EMBED_PUSHER_KEYS",
  "UNIVERSE_EMBED_IDENTITY_AUDIENCE",
  "UNIVERSE_EMBED_HOST_SUBJECT_FORMAT",
  "UNIVERSE_EMBED_HOST_MAPPING",
] as const;
const LOGIN_NAMES = ["DATABASE_URL", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET",
  "OIDC_AUTHORIZATION_URL", "OIDC_TOKEN_URL", "OIDC_JWKS_URL"] as const;

function fail(): never {
  // Never echo configuration values: they can include keys or secrets.
  throw new Error("Invalid Universe embed E2 configuration");
}

const PROFILE_KEYS = ["displayName", "arabicName", "nationality", "university", "area", "jobSearchStatus", "isProfileCompleted"] as const;

/**
 * Maps My profile's own projection (the same OwnProfileReader and provenance)
 * onto the embed's link and data states.
 */
export function embedProfilesFrom(reader: OwnProfileReader): EmbedProfileSource {
  return {
    async read(personId): Promise<EmbedProfileView> {
      const result = await reader.readOwn({ requesterPrincipalId: personId, targetPersonId: personId });
      if (result.kind === "unavailable") return { state: "unavailable_or_conflict" };
      if (result.kind === "not_found") return { state: "linked_data_not_ready" };
      const link = result.profile.legacyLinkState;
      if (link !== "linked") return { state: "not_linked" };
      const fields = result.profile.fields as unknown as Record<string, {
        state: string; value?: unknown; freshness?: { kind?: string };
      } | undefined>;
      const out: EmbedProfileField[] = [];
      let available = 0;
      for (const key of PROFILE_KEYS) {
        const field = fields[key];
        if (!field) continue;
        if (field.state === "available" && ["string", "number", "boolean"].includes(typeof field.value)) {
          available += 1;
          const kind = field.freshness?.kind;
          out.push({ key, value: field.value as string | number | boolean,
            source: kind === "imported_snapshot" || kind === "written_by_person" || kind === "derived" ? kind : "unavailable" });
        } else {
          out.push({ key, value: null, source: "unavailable" });
        }
      }
      if (available === 0) return { state: "linked_data_not_ready" };
      return { state: "populated", fields: out };
    },
  };
}

function subjectFormat(value: string): SubjectPolicy {
  if (value === "user_email") return USER_EMAIL_SUBJECT_POLICY;
  if (value === "hashed_user_id") return HASHED_USER_ID_SUBJECT_POLICY;
  return fail();
}

/** `{"<kid>":"<Ed25519 SPKI PEM>"}`; only active keys are listed (a removed kid is retired). */
async function pusherKeys(issuer: string, raw: string): Promise<InMemoryIssuerKeyRegistry> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail();
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return fail();
  const registry = new InMemoryIssuerKeyRegistry();
  for (const [keyId, publicKey] of entries) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || typeof publicKey !== "string") return fail();
    try {
      if (createPublicKey(publicKey).asymmetricKeyType !== "ed25519") return fail();
    } catch { return fail(); }
    await registry.registerKey({ issuer, keyId, algorithm: "EdDSA", publicKey });
  }
  return registry;
}

export interface WiredUniverse {
  readonly config: UniverseEmbedConfig | undefined;
  close(): Promise<void>;
}

/**
 * Builds the E2 runtime only when the embed is reserved, enabled and every E2
 * name is set, with E0's mapping rule pinned. Otherwise the E1 behaviour stands
 * ("not ready"). Partial E2 configuration refuses startup.
 */
export async function wireUniverse(
  env: Readonly<Record<string, string | undefined>>,
  config: UniverseEmbedConfig | undefined,
  profiles: OwnProfileReader | undefined,
): Promise<WiredUniverse> {
  const present = E2_NAMES.filter((name) => env[name] !== undefined);
  if (present.length === 0 || !config) {
    if (present.length !== 0 && !config) fail();
    return { config, async close() {} };
  }
  if (present.length !== E2_NAMES.length || !config.enabled || !config.callbackUrl || !profiles) fail();
  for (const name of LOGIN_NAMES) if (!env[name] || env[name]!.trim() !== env[name]) fail();
  if (new URL(config.callbackUrl).pathname !== "/login/callback") fail();
  // E0 pins exactly one rule. Only the same-provider rule is implemented.
  if (env.UNIVERSE_EMBED_HOST_MAPPING !== "same_provider_subject") fail();
  const pusherIssuer = env.UNIVERSE_EMBED_PUSHER_ISSUER!;
  const audience = env.UNIVERSE_EMBED_IDENTITY_AUDIENCE!;
  if (!/^universe-pusher@[a-z0-9-]+$/.test(pusherIssuer) || !/^studenthub-embed\/identity@[a-z0-9-]+$/.test(audience)) fail();
  if (pusherIssuer.split("@")[1] !== audience.split("@")[1]) fail();
  const issuer = env.OIDC_ISSUER!;
  if (pusherIssuer === issuer) fail();
  const subjectPolicy = subjectFormat(env.UNIVERSE_EMBED_HOST_SUBJECT_FORMAT!);
  const registry = await pusherKeys(pusherIssuer, env.UNIVERSE_EMBED_PUSHER_KEYS!);

  const databaseUrl = env.DATABASE_URL!;
  const loginStore = new PostgresLoginStore({ connectionString: databaseUrl });
  const store = new PostgresUniverseEmbedStore({ connectionString: databaseUrl });
  const replay = new PostgresReplayStore({ connectionString: databaseUrl });
  const runtime: UniverseEmbedRuntime = {
    store,
    sessions: loginStore.sessions,
    login: {
      dependencies: {
        oidc: new HttpOidcTransport(issuer, env.OIDC_AUTHORIZATION_URL!, env.OIDC_TOKEN_URL!),
        clock: { nowEpochSeconds: () => Math.floor(Date.now() / 1000) },
        entropy: { bytes: (length) => randomBytes(length) },
        states: loginStore.states,
        sessions: loginStore.sessions,
        identities: loginStore.identities,
        // The embed login only issues a session; reads go through the embed service.
        authorization: { async roleFor() { return "self"; } },
        jwks: new RefreshingJwksResolver(issuer, env.OIDC_JWKS_URL!),
      },
      config: {
        issuer,
        clientId: env.OIDC_CLIENT_ID!,
        clientSecret: env.OIDC_CLIENT_SECRET!,
        callbackUrl: config.callbackUrl,
        allowedReturnUrls: [`${config.origin}/universe/embed/done`],
        clockSkewSeconds: 60,
        subjectPolicy: (subject) => UNIVERSE_SUBJECT_POLICY.humanSubjectPattern.test(subject),
      },
    },
    hostIdentity: { pusherIssuer, audience, subjectPolicy, keys: registryKeyResolver(registry), replay },
    mapping: sameProviderSubjectMapping(issuer, (personId, at) => store.identitySubjects(personId, at)),
    profiles: embedProfilesFrom(profiles),
  };
  return {
    config: Object.freeze({ ...config, runtime }),
    async close() { await Promise.all([loginStore.close(), store.close(), replay.close()]); },
  };
}
