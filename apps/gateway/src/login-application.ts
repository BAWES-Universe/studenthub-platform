import { createHash, createPublicKey, verify } from "node:crypto";

import type {
  BrowserResponse,
  ClaimedProfile,
  LoginApplication,
  LoginApplicationFactory,
  LoginConfig,
  LoginDependencies,
  TestJsonWebKey,
} from "@studenthub/login-contract";

interface IdTokenClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly nonce: string;
  readonly exp: number;
  readonly iat: number;
  readonly email?: string;
  readonly phone?: string;
  readonly name?: string;
  readonly birthdate?: string;
}

function opaqueToken(dependencies: LoginDependencies): string {
  return Buffer.from(dependencies.entropy.bytes(32)).toString("base64url");
}

function rejected(status = 400): BrowserResponse {
  return { status, body: { error: "login_rejected" } };
}

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

function verifySignature(
  algorithm: string,
  signingInput: string,
  signature: Buffer,
  jwk: TestJsonWebKey,
): boolean {
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (algorithm === "EdDSA") return verify(null, Buffer.from(signingInput), key, signature);
  if (algorithm === "RS256") return verify("RSA-SHA256", Buffer.from(signingInput), key, signature);
  if (algorithm === "ES256") {
    return verify(
      "sha256",
      Buffer.from(signingInput),
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  }
  return false;
}

async function validateIdToken(
  idToken: string,
  expectedNonce: string,
  dependencies: LoginDependencies,
  config: LoginConfig,
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id token");
  const [headerWire, claimsWire, signatureWire] = parts as [string, string, string];
  const header = decodePart<{ readonly alg?: string; readonly kid?: string }>(headerWire);
  if (typeof header.alg !== "string" || typeof header.kid !== "string") {
    throw new Error("unsupported id token");
  }
  const claims = decodePart<IdTokenClaims>(claimsWire);
  const jwk = await dependencies.jwks.resolve(config.issuer, header.kid);
  if (
    !jwk
    || (jwk.alg !== undefined && jwk.alg !== header.alg)
    || (jwk.use !== undefined && jwk.use !== "sig")
    || !verifySignature(
    header.alg,
    `${headerWire}.${claimsWire}`,
    Buffer.from(signatureWire, "base64url"),
    jwk,
    )
  ) {
    throw new Error("invalid id token signature");
  }

  const now = dependencies.clock.nowEpochSeconds();
  const audienceValid = claims.aud === config.clientId
    || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === config.clientId);
  if (claims.iss !== config.issuer) throw new Error("invalid issuer");
  if (!audienceValid) throw new Error("invalid audience");
  if (!Number.isFinite(claims.exp) || claims.exp < now - config.clockSkewSeconds) {
    throw new Error("expired id token");
  }
  if (!Number.isFinite(claims.iat) || claims.iat > now + config.clockSkewSeconds) {
    throw new Error("future id token");
  }
  if (claims.nonce !== expectedNonce) throw new Error("invalid nonce");
  if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new Error("missing subject");
  return claims;
}

export const createLoginApplication: LoginApplicationFactory = (
  dependencies,
  config,
): LoginApplication => ({
  async start(request) {
    if (!config.allowedReturnUrls.includes(request.returnTo)) return rejected();
    const state = opaqueToken(dependencies);
    const nonce = opaqueToken(dependencies);
    const codeVerifier = opaqueToken(dependencies);
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    await dependencies.states.put({
      browserSessionId: request.browserSessionId,
      state,
      nonce,
      codeVerifier,
      returnTo: request.returnTo,
    });
    return {
      status: 302,
      headers: {
        location: dependencies.oidc.authorizationUrl({
          issuer: config.issuer,
          clientId: config.clientId,
          redirectUri: config.callbackUrl,
          state,
          nonce,
          codeChallenge,
          codeChallengeMethod: "S256",
        }),
      },
    };
  },

  async callback(request) {
    try {
      // consume() is deliberately atomic and precedes browser binding. A stolen
      // callback burns the state instead of leaving a replay window open.
      const loginState = await dependencies.states.consume(request.state);
      if (!loginState || loginState.browserSessionId !== request.browserSessionId) return rejected();
      const tokens = await dependencies.oidc.exchange({
        code: request.code,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.callbackUrl,
        codeVerifier: loginState.codeVerifier,
      });
      const claims = await validateIdToken(tokens.idToken, loginState.nonce, dependencies, config);
      if (!config.subjectPolicy(claims.sub)) return rejected();
      const profile: ClaimedProfile = {
        email: claims.email,
        phone: claims.phone,
        name: claims.name,
        dateOfBirth: claims.birthdate,
      };
      const identity = await dependencies.identities.findBySubject(config.issuer, claims.sub)
        ?? await dependencies.identities.createForSubject(config.issuer, claims.sub, profile);
      const sessionId = opaqueToken(dependencies);
      await dependencies.sessions.put({ id: sessionId, personId: identity.personId });
      return {
        status: 302,
        headers: {
          location: loginState.returnTo,
          "set-cookie": `studenthub_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      };
    } catch {
      return rejected();
    }
  },

  async profile(request) {
    try {
      if (!request.sessionId) return rejected(401);
      const session = await dependencies.sessions.get(request.sessionId);
      if (!session) return rejected(401);
      if (request.personId && request.personId !== session.personId) return rejected(404);
      const role = await dependencies.authorization.roleFor(session.personId);
      return { status: 200, body: { personId: session.personId, role } };
    } catch {
      return rejected(403);
    }
  },

  async logout(sessionId) {
    try {
      if (sessionId) await dependencies.sessions.delete(sessionId);
      return {
        status: 204,
        headers: {
          "set-cookie": "studenthub_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        },
      };
    } catch {
      return { status: 503, body: { error: "login_unavailable" } };
    }
  },
});
