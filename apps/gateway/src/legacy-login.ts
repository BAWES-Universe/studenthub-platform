export type LegacyLoginResult =
  | { readonly kind: "ok"; readonly candidateId: string }
  | { readonly kind: "two_step"; readonly pendingToken: string }
  | { readonly kind: "bad_credentials" }
  | { readonly kind: "email_not_verified"; readonly message: string }
  | { readonly kind: "unavailable" };

export interface LegacyLogin {
  login(input: { readonly email: string; readonly password: string }): Promise<LegacyLoginResult>;
  confirmTwoStep(input: { readonly pendingToken: string; readonly otp: string }): Promise<LegacyLoginResult>;
}

export interface LegacyLoginSettings {
  readonly baseUrl: string;
  readonly allowedHost: string;
  readonly timeoutMs?: number;
}

type Fetch = typeof fetch;
function settings(input: LegacyLoginSettings): { base: URL; timeoutMs: number } {
  let base: URL;
  try { base = new URL(input.baseUrl); } catch { throw new Error("LEGACY_CANDIDATE_BASE_URL must be a valid URL"); }
  if (base.protocol !== "https:") throw new Error("LEGACY_CANDIDATE_BASE_URL must use https");
  if (base.host !== input.allowedHost) throw new Error("LEGACY_CANDIDATE_BASE_URL host must equal LEGACY_CANDIDATE_ALLOWED_HOST");
  if (base.username || base.password || base.search || base.hash) throw new Error("LEGACY_CANDIDATE_BASE_URL must not contain credentials, query, or fragment");
  const timeoutMs = input.timeoutMs ?? 3_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error("legacy timeout must be 100-30000ms");
  return { base, timeoutMs };
}
function endpoint(base: URL, path: string): URL {
  const normalized = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
  return new URL(path, normalized);
}
function validCandidateId(value: unknown): value is string | number {
  return (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function message(value: unknown): string { return typeof value === "string" ? [...value].slice(0, 300).join("") : "Email verification is required."; }
function mapPayload(value: unknown): LegacyLoginResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unavailable" };
  const row = value as Record<string, unknown>;
  if (row.operation === "error" && row.errorType === "email-not-verified") return { kind: "email_not_verified", message: message(row.message) };
  if (row.operation !== "success") return { kind: "unavailable" };
  if (row.token_status === 0 && typeof row.token === "string" && row.token.length > 0) return { kind: "two_step", pendingToken: row.token };
  if (!validCandidateId(row.id)) return { kind: "unavailable" };
  return { kind: "ok", candidateId: String(row.id) };
}

export class HttpLegacyLogin implements LegacyLogin {
  readonly #base: URL; readonly #timeoutMs: number; readonly #fetch: Fetch;
  constructor(input: LegacyLoginSettings, fetchImplementation: Fetch = fetch) {
    const configured = settings(input); this.#base = configured.base; this.#timeoutMs = configured.timeoutMs; this.#fetch = fetchImplementation;
  }
  async login(input: {email:string;password:string}): Promise<LegacyLoginResult> {
    const authorization = `Basic ${Buffer.from(`${input.email}:${input.password}`, "utf8").toString("base64")}`;
    return this.#request(endpoint(this.#base, "v1/auth/login"), { method: "GET", headers: { authorization, accept: "application/json" } });
  }
  async confirmTwoStep(input: {pendingToken:string;otp:string}): Promise<LegacyLoginResult> {
    return this.#request(endpoint(this.#base, "v1/auth/login-two-step"), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ token: input.pendingToken, otp: input.otp }) });
  }
  async #request(url: URL, init: RequestInit): Promise<LegacyLoginResult> {
    try {
      const response = await this.#fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs) });
      if (response.status === 401) { await response.body?.cancel().catch(() => undefined); return { kind: "bad_credentials" }; }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { kind: "unavailable" }; }
      let body: unknown; try { body = await response.json(); } catch { return { kind: "unavailable" }; }
      return mapPayload(body);
    } catch { return { kind: "unavailable" }; }
  }
}

export class FakeLegacyLogin implements LegacyLogin {
  readonly calls: Array<{method:"login"|"confirmTwoStep"}> = [];
  constructor(private readonly results: LegacyLoginResult[] = []) {}
  async login(): Promise<LegacyLoginResult> { this.calls.push({method:"login"}); return this.results.shift() ?? {kind:"unavailable"}; }
  async confirmTwoStep(): Promise<LegacyLoginResult> { this.calls.push({method:"confirmTwoStep"}); return this.results.shift() ?? {kind:"unavailable"}; }
}
