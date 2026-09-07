/**
 * Shared authz fixtures. The gateway now fails closed, so any test that
 * exercises a protected route must present a genuinely signed, in-date,
 * destination-bound assertion for a principal that holds a real grant.
 */
import {
  UNIVERSE_SUBJECT_POLICY,
  generateEd25519KeyPair,
  MemoryReplayStore,
  signAssertion,
  type ActorAssertionAct,
} from "@bawes/actor-assertion";
import {
  createOrganization,
  createPrincipal,
  InMemoryAuthzStore,
  InMemoryIssuerKeyRegistry,
  type AuthzStore,
} from "@studenthub/contracts";

import { createAuthzMiddleware, type AuthzMiddleware } from "../../src/authz-middleware.js";
import type {
  AuthorizationAuditFailureHandler,
  AuthorizationAuditSink,
} from "../../src/authz-audit.js";

export const TEST_ISSUER = "bawes.universe";
export const TEST_KID = "k1";
export const TEST_AUDIENCE = "studenthub/mcp/tools/call";
/** Universe emits sub_mode=user_email, so a real subject is an email address. */
export const TEST_SUB = "student@bawes.net";
export const TEST_ORG = "org-root";

/**
 * Audit seams a test may pin. Omitted entirely, the fixture keeps SHU-49
 * behaviour with the production stdout sink replaced by a discard, so existing
 * tests neither write to stdout nor depend on audit behaviour.
 */
export interface AuthzFixtureAudit {
  readonly auditSink?: AuthorizationAuditSink;
  readonly onAuditFailure?: AuthorizationAuditFailureHandler;
  readonly now?: () => Date;
  readonly newRequestId?: () => string;
  /** Replace the grants store, e.g. with one that throws, for dependency tests. */
  readonly store?: AuthzStore;
}

export interface AuthzFixture {
  readonly middleware: AuthzMiddleware;
  readonly store: InMemoryAuthzStore;
  /** Mint a valid header value; overrides let a test break exactly one property. */
  mint(overrides?: {
    readonly aud?: string;
    readonly sub?: string;
    readonly kid?: string;
    readonly act?: ActorAssertionAct;
    readonly expOffsetSeconds?: number;
  }): Promise<string>;
}

export async function createAuthzFixture(audit: AuthzFixtureAudit = {}): Promise<AuthzFixture> {
  const keyPair = await generateEd25519KeyPair();
  const registry = new InMemoryIssuerKeyRegistry();
  await registry.registerKey({
    issuer: TEST_ISSUER,
    keyId: TEST_KID,
    algorithm: "EdDSA",
    publicKey: keyPair.publicKeyPem,
  });

  const store = new InMemoryAuthzStore({
    organizations: [createOrganization({ id: TEST_ORG, name: "Root" })],
    principals: [createPrincipal({ id: "p-1", pbuuids: [TEST_SUB] })],
  });
  await store.grantMany("p-1", [{ orgId: TEST_ORG, role: "staff" }]);

  const middleware = createAuthzMiddleware({
    store: audit.store ?? store,
    registry,
    replayStore: new MemoryReplayStore(),
    subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    expectedAudience: TEST_AUDIENCE,
    // Default to discarding so the pre-existing suite does not emit audit lines
    // onto stdout while node --test is parsing that same stream.
    auditSink: audit.auditSink ?? { record: () => undefined },
    ...(audit.onAuditFailure !== undefined ? { onAuditFailure: audit.onAuditFailure } : {}),
    ...(audit.now !== undefined ? { now: audit.now } : {}),
    ...(audit.newRequestId !== undefined ? { newRequestId: audit.newRequestId } : {}),
  });

  let counter = 0;
  return {
    middleware,
    store,
    async mint(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      counter += 1;
      return signAssertion(
        {
          v: 1,
          iss: TEST_ISSUER,
          kid: overrides.kid ?? TEST_KID,
          aud: overrides.aud ?? TEST_AUDIENCE,
          sub: overrides.sub ?? TEST_SUB,
          iat: now,
          exp: now + (overrides.expOffsetSeconds ?? 300),
          jti: `jti-${counter}-${now}`,
          ...(overrides.act !== undefined ? { act: overrides.act } : {}),
        },
        keyPair.privateKeyPem,
      );
    },
  };
}
