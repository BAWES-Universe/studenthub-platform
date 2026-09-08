import { createHash, createPublicKey, verify } from "node:crypto";

import type {
  BrowserResponse,
  ClaimedProfile,
  LoginApplication,
  LoginApplicationFactory,
  LoginConfig,
  LoginDependencies,
  LoginState,
} from "../src/index.js";

export interface ReferenceFaults {
  readonly leakBrowserSecrets?: boolean;
  readonly leakIdTokenOnly?: boolean;
  readonly leakRejectedSecrets?: boolean;
  readonly skipCodeExchange?: boolean;
  readonly ignoreLoginEntropy?: boolean;
  readonly ignoreSessionEntropy?: boolean;
  readonly shortState?: boolean;
  readonly skipStateBinding?: boolean;
  readonly preserveStateAfterBindingFailure?: boolean;
  readonly reusableState?: boolean;
  readonly exchangeBeforeStateValidation?: boolean;
  readonly skipPkce?: boolean;
  readonly omitNonceIssuance?: boolean;
  readonly skipNonceValidation?: boolean;
  readonly nonceNotSessionBound?: boolean;
  readonly unsafeRedirect?: boolean;
  readonly skipSignature?: boolean;
  readonly skipIssuer?: boolean;
  readonly wrongAuthorizationIssuer?: boolean;
  readonly skipAudience?: boolean;
  readonly skipExpiry?: boolean;
  readonly skipIssuedAt?: boolean;
  readonly skipSubjectPolicy?: boolean;
  readonly emailSubjectFallback?: boolean;
  readonly legacyProfileMatch?: boolean;
  readonly bindSubjectToEmail?: boolean;
  readonly trustClientRole?: boolean;
  readonly deriveRoleFromSubject?: boolean;
  readonly cacheAuthorization?: boolean;
  readonly exposeOtherProfile?: boolean;
  readonly insecureCookie?: boolean;
  readonly skipLogoutInvalidation?: boolean;
  readonly wrongCallbackUrl?: boolean;
}

interface Claims {
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
  readonly role?: string;
}

function randomToken(dependencies: LoginDependencies, length = 32): string {
  return Buffer.from(dependencies.entropy.bytes(length)).toString("base64url");
}

function failure(status = 400): BrowserResponse {
  return { status, body: { error: "login_rejected" } };
}

function jsonPart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

async function validateIdToken(
  idToken: string,
  expectedNonce: string,
  dependencies: LoginDependencies,
  config: LoginConfig,
  faults: ReferenceFaults,
): Promise<Claims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = jsonPart<{ alg?: string; kid?: string }>(encodedHeader);
  const claims = jsonPart<Claims>(encodedClaims);
  if (!faults.skipSignature) {
    if (header.alg !== "EdDSA" || typeof header.kid !== "string") throw new Error("unsupported token");
    const jwk = await dependencies.jwks.resolve(config.issuer, header.kid);
    if (!jwk) throw new Error("unknown signing key");
    const valid = verify(
      null,
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!valid) throw new Error("invalid signature");
  }
  const now = dependencies.clock.nowEpochSeconds();
  if (!faults.skipIssuer && claims.iss !== config.issuer) throw new Error("invalid issuer");
  const audienceValid = claims.aud === config.clientId
    || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === config.clientId);
  if (!faults.skipAudience && !audienceValid) throw new Error("invalid audience");
  if (!faults.skipExpiry && (!Number.isFinite(claims.exp) || claims.exp < now - config.clockSkewSeconds)) {
    throw new Error("expired token");
  }
  if (!faults.skipIssuedAt && (!Number.isFinite(claims.iat) || claims.iat > now + config.clockSkewSeconds)) {
    throw new Error("future token");
  }
  if (!faults.skipNonceValidation && claims.nonce !== expectedNonce) throw new Error("invalid nonce");
  if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new Error("missing subject");
  return claims;
}

export function referenceLoginFactory(faults: ReferenceFaults = {}): LoginApplicationFactory {
  return (dependencies, config): LoginApplication => {
    const stateCache = new Map<string, LoginState>();
    const subjectRoles = new Map<string, string>();
    const cachedAuthorization = new Map<string, string>();
    let ignoredLoginCounter = 1;
    let ignoredSessionCounter = 101;
    let latestIssuedNonce = "";
    const loginToken = () => faults.ignoreLoginEntropy
      ? Buffer.alloc(32, ignoredLoginCounter++).toString("base64url")
      : randomToken(dependencies);
    const sessionToken = () => faults.ignoreSessionEntropy
      ? Buffer.alloc(32, ignoredSessionCounter++).toString("base64url")
      : randomToken(dependencies);

    return {
      async start(request) {
        if (!faults.unsafeRedirect && !config.allowedReturnUrls.includes(request.returnTo)) return failure();
        const state = faults.shortState ? "weak" : loginToken();
        const nonce = faults.omitNonceIssuance ? "" : loginToken();
        latestIssuedNonce = nonce;
        const codeVerifier = loginToken();
        const codeChallenge = faults.skipPkce
          ? codeVerifier
          : createHash("sha256").update(codeVerifier).digest("base64url");
        const record = {
          browserSessionId: request.browserSessionId,
          state,
          nonce,
          codeVerifier,
          returnTo: request.returnTo,
        };
        await dependencies.states.put(record);
        stateCache.set(state, record);
        const location = dependencies.oidc.authorizationUrl({
          issuer: faults.wrongAuthorizationIssuer ? "https://attacker.invalid" : config.issuer,
          clientId: config.clientId,
          redirectUri: faults.wrongCallbackUrl ? "https://attacker.invalid/callback" : config.callbackUrl,
          state,
          nonce,
          codeChallenge,
          codeChallengeMethod: "S256",
        });
        return { status: 302, headers: { location } };
      },

      async callback(request) {
        try {
          if (faults.exchangeBeforeStateValidation) {
            const latestState = [...stateCache.values()].at(-1);
            if (latestState) {
              await dependencies.oidc.exchange({
                code: request.code,
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                redirectUri: config.callbackUrl,
                codeVerifier: latestState.codeVerifier,
              });
            }
          }
          if (faults.preserveStateAfterBindingFailure) {
            const cachedState = stateCache.get(request.state);
            if (cachedState && cachedState.browserSessionId !== request.browserSessionId) return failure();
          }
          const loginState = faults.reusableState
            ? stateCache.get(request.state)
            : await dependencies.states.consume(request.state);
          if (!loginState) return failure();
          if (!faults.skipStateBinding && loginState.browserSessionId !== request.browserSessionId) return failure();
          if (faults.skipCodeExchange) {
            const identity = await dependencies.identities.createForSubject(
              config.issuer,
              "universe:student:synthetic-1",
              {},
            );
            const sessionId = sessionToken();
            await dependencies.sessions.put({ id: sessionId, personId: identity.personId });
            return {
              status: 302,
              headers: {
                location: loginState.returnTo,
                "set-cookie": `__Host-studenthub_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
              },
            };
          }
          const tokens = await dependencies.oidc.exchange({
            code: request.code,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: faults.wrongCallbackUrl ? "https://attacker.invalid/callback" : config.callbackUrl,
            codeVerifier: loginState.codeVerifier,
          });
          const expectedNonce = faults.nonceNotSessionBound ? latestIssuedNonce : loginState.nonce;
          const claims = await validateIdToken(tokens.idToken, expectedNonce, dependencies, config, faults);
          const candidateSubject = faults.emailSubjectFallback ? claims.email ?? claims.sub : claims.sub;
          if (!faults.skipSubjectPolicy && !config.subjectPolicy(candidateSubject)) return failure();
          const profile: ClaimedProfile = {
            email: claims.email,
            phone: claims.phone,
            name: claims.name,
            dateOfBirth: claims.birthdate,
          };
          const boundSubject = faults.bindSubjectToEmail ? `${candidateSubject}:${claims.email ?? ""}` : candidateSubject;
          let identity = await dependencies.identities.findBySubject(config.issuer, boundSubject);
          if (!identity && faults.legacyProfileMatch) identity = await dependencies.identities.findLegacyMatch(profile);
          identity ??= await dependencies.identities.createForSubject(config.issuer, boundSubject, profile);
          const sessionId = sessionToken();
          await dependencies.sessions.put({ id: sessionId, personId: identity.personId });
          if (faults.deriveRoleFromSubject) subjectRoles.set(sessionId, "owner");
          if (faults.cacheAuthorization) {
            cachedAuthorization.set(sessionId, await dependencies.authorization.roleFor(identity.personId));
          }
          const secureAttributes = faults.insecureCookie ? "Path=/" : "Path=/; HttpOnly; Secure; SameSite=Lax";
          const response: BrowserResponse = {
            status: 302,
            headers: {
              location: loginState.returnTo,
              "set-cookie": `__Host-studenthub_session=${sessionId}; ${secureAttributes}`,
            },
          };
          if (!faults.leakBrowserSecrets && !faults.leakIdTokenOnly) return response;
          return {
            ...response,
            body: faults.leakIdTokenOnly
              ? { idToken: tokens.idToken }
              : {
                code: request.code,
                accessToken: tokens.accessToken,
                idToken: tokens.idToken,
                clientSecret: config.clientSecret,
                codeVerifier: loginState.codeVerifier,
              },
          };
        } catch {
          if (faults.leakRejectedSecrets) {
            return failureWithDetails(request.code, config.clientSecret);
          }
          return failure();
        }
      },

      async profile(request) {
        if (!request.sessionId) return failure(401);
        const session = await dependencies.sessions.get(request.sessionId);
        if (!session) return failure(401);
        if (request.personId && request.personId !== session.personId && !faults.exposeOtherProfile) return failure(404);
        const role = faults.trustClientRole && request.requestedRole
          ? request.requestedRole
          : subjectRoles.get(request.sessionId)
            ?? cachedAuthorization.get(request.sessionId)
            ?? await dependencies.authorization.roleFor(session.personId);
        return { status: 200, body: { personId: request.personId ?? session.personId, role } };
      },

      async logout(sessionId) {
        if (sessionId && !faults.skipLogoutInvalidation) await dependencies.sessions.delete(sessionId);
        return {
          status: 204,
          headers: { "set-cookie": "__Host-studenthub_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" },
        };
      },
    };
  };
}

function failureWithDetails(code: string, clientSecret: string): BrowserResponse {
  return { status: 400, body: { error: "login_rejected", code, clientSecret, accessToken: "synthetic-access-token" } };
}
