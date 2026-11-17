export interface BrowserResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface AuthorizationRequest {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
}

export interface TokenRequest {
  readonly code: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export interface TokenResponse {
  readonly accessToken: string;
  readonly idToken: string;
}

export interface OidcTransport {
  authorizationUrl(request: AuthorizationRequest): string;
  exchange(request: TokenRequest): Promise<TokenResponse>;
}

export interface Clock {
  nowEpochSeconds(): number;
}

export interface EntropySource {
  bytes(length: number): Uint8Array;
}

export interface LoginState {
  readonly browserSessionId: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
}

export interface LoginStateStore {
  put(record: LoginState): Promise<void>;
  consume(state: string): Promise<LoginState | undefined>;
}

export interface LoginSession {
  readonly id: string;
  readonly personId: string;
  /**
   * The upstream (issuer) session reference from the identity token's `sid`
   * claim. A lookup value, not a secret, but never logged, put in a URL we
   * build, or shown. Absent when the token carried no `sid` or the login has
   * no UpstreamSessions port.
   */
  readonly upstreamReference?: string;
  /** Epoch seconds of the last upstream check, whatever its answer. */
  readonly lastCheckedAt?: number;
  /** Epoch seconds of the last upstream answer of `active` (or the sign-in). */
  readonly lastConfirmedAt?: number;
}

export interface SessionStore {
  put(record: LoginSession): Promise<void>;
  get(id: string): Promise<LoginSession | undefined>;
  delete(id: string): Promise<void>;
  /** Deletes the session and returns what it held, in one step. */
  take?(id: string): Promise<LoginSession | undefined>;
  /**
   * Claims the right to check this session upstream: sets last_checked_at to
   * `now` only if it is unset or at or before `checkedAtOrBefore`, and answers
   * whether this call won. Two concurrent requests make one upstream call.
   */
  claimUpstreamCheck?(id: string, checkedAtOrBefore: number, now: number): Promise<boolean>;
  /** Records an upstream answer of `active` at `now`. */
  confirmUpstream?(id: string, now: number): Promise<void>;
}

/** Answer of the issuer when asked to end its session. */
export type UpstreamEndResult = "ended" | "unreachable";
/** Answer of the issuer when asked whether its session is still alive. */
export type UpstreamActivity = "active" | "ended" | "unknown";

/**
 * SHU-457: the issuer's own session. Optional; a login application built
 * without it behaves exactly as contract 1.0.0 describes.
 */
export interface UpstreamSessions {
  end(reference: string): Promise<UpstreamEndResult>;
  isActive(reference: string): Promise<UpstreamActivity>;
}

/** One log event for an upstream call that did not answer: a count and a reason class, never the reference or the person. */
export interface UpstreamSessionEvent {
  readonly event: "upstream_end_unreachable" | "upstream_check_unknown";
  readonly reason: "timeout" | "error" | "unreachable" | "unknown";
  readonly count: number;
}

export interface ExternalIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly personId: string;
}

export interface ClaimedProfile {
  readonly email?: string;
  readonly phone?: string;
  readonly name?: string;
  readonly dateOfBirth?: string;
  readonly stableUserId?: string;
}

export interface IdentityStore {
  findBySubject(issuer: string, subject: string): Promise<ExternalIdentity | undefined>;
  createForSubject(issuer: string, subject: string, claims: ClaimedProfile): Promise<ExternalIdentity>;
  /** Forbidden migration escape hatch: conformance fails if login calls this. */
  findLegacyMatch(claims: ClaimedProfile): Promise<ExternalIdentity | undefined>;
  bindStableId?(
    issuer: string,
    subject: string,
    stableUserId: string,
  ): Promise<"bound" | "matched" | "mismatch" | "locked">;
}

export interface AuthorizationStore {
  roleFor(personId: string): Promise<string>;
  principalFor?(personId: string): Promise<{ readonly role: string; readonly email?: string }>;
}

export interface TestJsonWebKey {
  readonly [property: string]: string | undefined;
}

export interface JwksResolver {
  resolve(issuer: string, kid: string): Promise<TestJsonWebKey | undefined>;
}

export interface LoginDependencies {
  readonly oidc: OidcTransport;
  readonly clock: Clock;
  readonly entropy: EntropySource;
  readonly states: LoginStateStore;
  readonly sessions: SessionStore;
  readonly identities: IdentityStore;
  readonly authorization: AuthorizationStore;
  readonly jwks: JwksResolver;
  readonly upstreamSessions?: UpstreamSessions;
  readonly upstreamLog?: (event: UpstreamSessionEvent) => void;
  /** Access lane A6: a paused person gets no session (403 access_paused). */
  readonly accessPause?: AccessPauseReader;
}

export interface AccessPauseReader {
  isPaused(personId: string): Promise<boolean>;
}

export interface LoginConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  readonly allowedReturnUrls: readonly string[];
  readonly clockSkewSeconds: number;
  readonly subjectPolicy: (subject: string) => boolean;
  /** Bound T in seconds for an upstream-ended session (default 900, valid 60 to 3600). */
  readonly upstreamCheckSeconds?: number;
  /** Bound on each upstream call in milliseconds (default 3000). */
  readonly upstreamTimeoutMs?: number;
}

export interface StartLoginRequest {
  readonly browserSessionId: string;
  readonly returnTo: string;
}

export interface LoginCallbackRequest {
  readonly browserSessionId: string;
  readonly state: string;
  readonly code: string;
}

export interface ProfileRequest {
  readonly sessionId?: string;
  readonly personId?: string;
  readonly requestedRole?: string;
}

export interface LoginApplication {
  start(request: StartLoginRequest): Promise<BrowserResponse>;
  callback(request: LoginCallbackRequest): Promise<BrowserResponse>;
  profile(request: ProfileRequest): Promise<BrowserResponse>;
  logout(sessionId?: string): Promise<BrowserResponse>;
}

export type LoginApplicationFactory = (
  dependencies: LoginDependencies,
  config: LoginConfig,
) => LoginApplication;
