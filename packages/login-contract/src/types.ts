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
}

export interface SessionStore {
  put(record: LoginSession): Promise<void>;
  get(id: string): Promise<LoginSession | undefined>;
  delete(id: string): Promise<void>;
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
}

export interface IdentityStore {
  findBySubject(issuer: string, subject: string): Promise<ExternalIdentity | undefined>;
  createForSubject(issuer: string, subject: string, claims: ClaimedProfile): Promise<ExternalIdentity>;
  /** Forbidden migration escape hatch: conformance fails if login calls this. */
  findLegacyMatch(claims: ClaimedProfile): Promise<ExternalIdentity | undefined>;
}

export interface AuthorizationStore {
  roleFor(personId: string): Promise<string>;
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
}

export interface LoginConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  readonly allowedReturnUrls: readonly string[];
  readonly clockSkewSeconds: number;
  readonly subjectPolicy: (subject: string) => boolean;
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
