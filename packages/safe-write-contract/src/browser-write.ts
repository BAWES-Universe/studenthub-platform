import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Awaitable, Receipt, SafeWriteSecret } from "./types.js";

/** Browser single-Save extension. Existing preview/confirm APIs are unchanged. */
export const BROWSER_WRITE_VERSION = "1.0.0";
export const BROWSER_WRITE_PURPOSE = "self-profile-field-write";
export const BROWSER_WRITE_LIFETIME_MS = 5 * 60 * 1000;
const reference = /^[0-9a-f]{64}$/;
const code = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export interface BrowserWriteBinding {
  readonly principalRef: string;
  readonly personRef: string;
  readonly field: string;
  /** Identifies the caller's frozen normalization rules; this library never normalizes values. */
  readonly normalizationVersion: string;
}
export interface BrowserWriteToken extends BrowserWriteBinding {
  readonly contractVersion: typeof BROWSER_WRITE_VERSION;
  readonly purpose: typeof BROWSER_WRITE_PURPOSE;
  readonly keyVersion: string;
  readonly tokenId: string;
  readonly tokenRef: string;
  readonly baselineDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly mac: string;
}
export interface BrowserBaseline {
  /** SQL null and an explicitly present empty value must remain distinct. */
  readonly persisted: { readonly kind: "null" } | { readonly kind: "present"; readonly value: string | boolean };
  /** Only the imported fallback actually shown to the person belongs here. */
  readonly shownFallback: null | { readonly sourceRef: string; readonly valueDigest: string; readonly revision: string };
}
export type BrowserTokenVerification =
  | { readonly ok: true; readonly token: BrowserWriteToken }
  | { readonly ok: false; readonly reason: "invalid_token" | "recovery_unavailable" };
export type BrowserWriteOutcome =
  | { readonly status: "committed" | "already_committed"; readonly receipt: Receipt }
  | { readonly status: "token_payload_mismatch" | "state_changed" | "expired" | "not_authorized" | "unknown" | "recovery_unavailable" };
export type BrowserReceiptStatus =
  | { readonly status: "committed"; readonly receipt: Receipt }
  | { readonly status: "not_found" | "unknown" | "not_authorized" | "recovery_unavailable" };

/** Integration port, not an in-memory implementation or proof of database atomicity.
 * Implementations reauthorize before disclosure and again under the serialization lock,
 * look up the original receipt before expiry/baseline checks, and atomically persist
 * value, token consumption, payload digest, audit and receipt. Unknown COMMIT stays unknown.
 */
export interface BrowserWriteAPI {
  save(input: { readonly token: BrowserWriteToken; readonly canonicalValue: string | boolean | null }): Awaitable<BrowserWriteOutcome>;
  /** Authenticated read-only lookup: never calls save, consumes a token, or initiates a write. */
  receiptStatus(token: BrowserWriteToken): Awaitable<BrowserReceiptStatus>;
}

function digest(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function bindingValid(b: BrowserWriteBinding): boolean {
  return Boolean(b) && typeof b.principalRef === "string" && reference.test(b.principalRef) &&
    typeof b.personRef === "string" && reference.test(b.personRef) &&
    typeof b.field === "string" && code.test(b.field) &&
    typeof b.normalizationVersion === "string" && code.test(b.normalizationVersion);
}
function bindingParts(b: BrowserWriteBinding): string[] {
  return [b.principalRef, b.personRef, b.field, b.normalizationVersion];
}
export function browserBaselineDigest(baseline: BrowserBaseline): string {
  const p = baseline.persisted;
  if (!p || (p.kind !== "null" && p.kind !== "present") ||
      (p.kind === "present" && typeof p.value !== "string" && typeof p.value !== "boolean")) throw new TypeError("Invalid persisted baseline");
  const f = baseline.shownFallback;
  if (f !== null && (!f || !reference.test(f.sourceRef) || !reference.test(f.valueDigest) || typeof f.revision !== "string" || !f.revision)) throw new TypeError("Invalid fallback evidence");
  return digest([BROWSER_WRITE_VERSION, "baseline", p.kind, p.kind === "present" ? p.value : null,
    f === null ? null : [f.sourceRef, f.valueDigest, f.revision]]);
}
/** Caller validates and normalizes first. Exact representation is shared by receipts and notices. */
export function browserChangeSetDigest(binding: BrowserWriteBinding, canonicalValue: string | boolean | null): string {
  if (!bindingValid(binding) || (canonicalValue !== null && typeof canonicalValue !== "string" && typeof canonicalValue !== "boolean")) throw new TypeError("Invalid browser change set");
  return digest([BROWSER_WRITE_VERSION, BROWSER_WRITE_PURPOSE, "change", ...bindingParts(binding), canonicalValue]);
}
function tokenParts(t: Omit<BrowserWriteToken, "mac">): unknown[] {
  return [t.contractVersion, t.purpose, t.keyVersion, t.tokenId, t.tokenRef, ...bindingParts(t), t.baselineDigest, t.issuedAt, t.expiresAt];
}
function signature(t: Omit<BrowserWriteToken, "mac">, secret: SafeWriteSecret): string {
  return createHmac("sha256", secret).update(JSON.stringify(tokenParts(t))).digest("base64url");
}
const tokenKeys = ["contractVersion", "purpose", "keyVersion", "tokenId", "tokenRef", "principalRef", "personRef", "field", "normalizationVersion", "baselineDigest", "issuedAt", "expiresAt", "mac"].sort();
function validTime(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
function tokenShape(value: unknown): value is BrowserWriteToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const t = value as BrowserWriteToken;
  return JSON.stringify(Object.keys(t).sort()) === JSON.stringify(tokenKeys) && Object.values(t).every(v => typeof v === "string") &&
    t.contractVersion === BROWSER_WRITE_VERSION && t.purpose === BROWSER_WRITE_PURPOSE && code.test(t.keyVersion) && bindingValid(t) &&
    /^[0-9a-f]{64}$/.test(t.tokenId) && reference.test(t.tokenRef) && reference.test(t.baselineDigest) && /^[A-Za-z0-9_-]{43}$/.test(t.mac) &&
    validTime(t.issuedAt) && validTime(t.expiresAt) && Date.parse(t.expiresAt) - Date.parse(t.issuedAt) === BROWSER_WRITE_LIFETIME_MS &&
    t.tokenRef === digest([BROWSER_WRITE_VERSION, BROWSER_WRITE_PURPOSE, "token", t.tokenId]);
}
/** Keys are copied at construction. Retired keys can be retained for recovery; no retention duty is imposed. */
export function createBrowserWriteTokens(options: { readonly activeKeyVersion: string; readonly keys: Readonly<Record<string, SafeWriteSecret>> }) {
  const keys = new Map<string, Buffer>();
  for (const [version, secret] of Object.entries(options.keys)) {
    if (!code.test(version) || (typeof secret !== "string" && !Buffer.isBuffer(secret))) throw new TypeError("Invalid signing key");
    const bytes = Buffer.from(secret);
    if (bytes.length < 32) throw new TypeError("Signing keys need at least 32 bytes");
    keys.set(version, bytes);
  }
  const activeKeyVersion = options.activeKeyVersion;
  const activeKey = keys.get(activeKeyVersion);
  if (!activeKey) throw new TypeError("Active signing key unavailable");
  return {
    issue(binding: BrowserWriteBinding, baselineDigest: string, now: Date): BrowserWriteToken {
      if (!bindingValid(binding) || !reference.test(baselineDigest) || !Number.isFinite(now.getTime())) throw new TypeError("Invalid browser token input");
      const tokenId = randomBytes(32).toString("hex");
      const unsigned: Omit<BrowserWriteToken, "mac"> = {
        contractVersion: BROWSER_WRITE_VERSION, purpose: BROWSER_WRITE_PURPOSE, keyVersion: activeKeyVersion,
        tokenId, tokenRef: digest([BROWSER_WRITE_VERSION, BROWSER_WRITE_PURPOSE, "token", tokenId]),
        principalRef: binding.principalRef, personRef: binding.personRef, field: binding.field, normalizationVersion: binding.normalizationVersion,
        baselineDigest, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + BROWSER_WRITE_LIFETIME_MS).toISOString(),
      };
      return Object.freeze({ ...unsigned, mac: signature(unsigned, activeKey) });
    },
    /** Authenticity/binding only, deliberately NOT expiry or current authorization. */
    verify(value: unknown, expected: BrowserWriteBinding): BrowserTokenVerification {
      if (!bindingValid(expected) || !tokenShape(value) || bindingParts(value).some((v, i) => v !== bindingParts(expected)[i])) return { ok: false, reason: "invalid_token" };
      const key = keys.get(value.keyVersion);
      if (!key) return { ok: false, reason: "recovery_unavailable" };
      if (!timingSafeEqual(Buffer.from(value.mac), Buffer.from(signature(value, key)))) return { ok: false, reason: "invalid_token" };
      return { ok: true, token: Object.freeze({ ...value }) };
    },
  };
}
/** Use ONLY on verified tokens in the no-receipt branch, with database wall-clock after lock. */
export function browserFirstWriteExpired(token: BrowserWriteToken, now: Date): boolean {
  return !Number.isFinite(now.getTime()) || now.getTime() < Date.parse(token.issuedAt) || now.getTime() >= Date.parse(token.expiresAt);
}
