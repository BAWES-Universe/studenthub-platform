import { randomBytes } from "node:crypto";
import { createPublicKey } from "node:crypto";
import { UNIVERSE_SUBJECT_POLICY, USER_EMAIL_SUBJECT_POLICY, type SubjectPolicy } from "@bawes/actor-assertion";
import { InMemoryIssuerKeyRegistry } from "@studenthub/contracts";
import { PostgresAccessPausesStore, PostgresLoginStore } from "@studenthub/db/access";
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
  "UNIVERSE_EMBED_SITE",
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

/**
 * E2's cookies are `__Host-`, SameSite=Lax. A browser sends them to the embed
 * iframe and to the sign-in form's top-level POST only when the embed host and
 * every frame ancestor are one schemeful site. Cross-site (or partitioned)
 * embedding is not supported, so it refuses startup instead of failing in the
 * browser. UNIVERSE_EMBED_SITE names the registrable domain explicitly (no
 * public-suffix guessing); every host must be that domain or a subdomain of it.
 */
export function assertSameSiteEmbed(site: string, embedOrigin: string, ancestors: readonly string[]): void {
  const labels = site.split(".");
  if (site !== site.toLowerCase() || labels.length < 2
    || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || /^[0-9]+$/.test(labels[labels.length - 1]!)) fail();
  // The site must be a registrable domain, not a public suffix such as co.uk or
  // com.kw (browsers treat hosts under a public suffix as different sites).
  // Without a bundled public-suffix list, refuse the common two-label suffix
  // shapes: a generic second level under a two-letter country code.
  if (labels.length === 2 && labels[1]!.length === 2 && PUBLIC_SECOND_LEVELS.has(labels[0]!)) fail();
  // Common private suffixes from the public-suffix list (shared hosting platforms):
  // each customer subdomain is its own site there.
  if (PRIVATE_SUFFIXES.has(site)) fail();
  if (ancestors.length === 0) fail();
  for (const value of [embedOrigin, ...ancestors]) {
    const url = new URL(value);
    if (url.protocol !== "https:") fail();
    const host = url.hostname;
    if (host !== site && !host.endsWith(`.${site}`)) fail();
  }
}

/**
 * same_provider_subject compares the attested subject with the platform's
 * stored external subject, which the login keeps in its own (email) form. Only
 * the matching host format is accepted; hashed_user_id could never match.
 */
const PRIVATE_SUFFIXES = new Set(["github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app",
  "herokuapp.com", "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "onrender.com",
  "fly.dev", "railway.app", "glitch.me", "blogspot.com"]);
const PUBLIC_SECOND_LEVELS = new Set(["ac", "co", "com", "edu", "gov", "gv", "ltd", "me", "mil", "net", "nic", "or", "org", "plc", "sch"]);

/**
 * Browsers keep cookies per host, not per port, so the embed must not share
 * a hostname with the main application (its __Host- session cookie would be
 * replaced or cleared by the embed login).
 */
export function assertSeparateHosts(mainOrigin: string, embedOrigin: string): void {
  if (new URL(mainOrigin).hostname === new URL(embedOrigin).hostname) fail();
}

function subjectFormat(value: string): SubjectPolicy {
  if (value === "user_email" && UNIVERSE_SUBJECT_POLICY === USER_EMAIL_SUBJECT_POLICY) return USER_EMAIL_SUBJECT_POLICY;
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
    // Only a public SPKI key: createPublicKey would also accept (and derive from) a
    // private key, which must never sit in this configuration or the registry.
    if (!/^-----BEGIN PUBLIC KEY-----/.test(publicKey.trim())) return fail();
    let spki: string;
    try {
      const key = createPublicKey(publicKey);
      if (key.asymmetricKeyType !== "ed25519") return fail();
      spki = key.export({ type: "spki", format: "pem" }).toString();
    } catch { return fail(); }
    await registry.registerKey({ issuer, keyId, algorithm: "EdDSA", publicKey: spki });
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
  assertSameSiteEmbed(env.UNIVERSE_EMBED_SITE!, config.origin, config.ancestors);
  assertSeparateHosts(config.mainOrigin, config.origin);
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

  let authorization: URL;
  try { authorization = new URL(env.OIDC_AUTHORIZATION_URL!); } catch { return fail(); }
  // The CSP form-action source is the origin; a trailing-dot host would be redirected
  // to as written but normalized in the policy, so the two would not match.
  if (authorization.hostname.endsWith(".")) fail();
  if (authorization.protocol !== "https:") fail();

  const databaseUrl = env.DATABASE_URL!;
  const loginStore = new PostgresLoginStore({ connectionString: databaseUrl });
  const store = new PostgresUniverseEmbedStore({ connectionString: databaseUrl });
  const replay = new PostgresReplayStore({ connectionString: databaseUrl });
  // A paused person gets no session here either (A6). Pausing also ends existing
  // sessions, which ends any embed binding through readBinding's live-session join.
  const pauses = new PostgresAccessPausesStore({ connectionString: databaseUrl });
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
        accessPause: { isPaused: async (personId) => (await pauses.paused([personId])).has(personId) },
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
    authorizationOrigin: authorization.origin,
    hostIdentity: { pusherIssuer, audience, subjectPolicy, keys: registryKeyResolver(registry), replay },
    mapping: sameProviderSubjectMapping(issuer, (personId, at) => store.identitySubjects(personId, at)),
    profiles: embedProfilesFrom(profiles),
  };
  return {
    config: Object.freeze({ ...config, runtime }),
    async close() { await Promise.all([loginStore.close(), store.close(), replay.close(), pauses.close()]); },
  };
}
