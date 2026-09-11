import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_IDEMPOTENCY_FUTURE_SKEW_MS,
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
  IDEMPOTENCY_CONTRACT_VERSION,
  type IdempotencyImplementation,
  type IdempotencyOptions,
  type JsonValue,
  type MutationOperation,
  type MutationRequest,
  type MutationResult,
  type RefusalReason,
} from "./types.js";

const REFERENCE_PATTERN = /^[0-9a-f]{64}$/;
const KEY_PATTERN = /^v1\.(\d{13})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const ROUTE_PATTERN = /^\/[A-Za-z0-9_{}.:/-]*$/;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

function sortedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key]!)]));
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortedJson(value));
}

export function mutationFingerprint(request: MutationRequest): string {
  return createHash("sha256").update(canonicalJson({
    contractVersion: IDEMPOTENCY_CONTRACT_VERSION,
    method: request.method,
    payload: request.payload,
    principalRef: request.principalRef,
    route: request.route,
  })).digest("hex");
}

export function createIdempotencyKey(now = new Date(), uuid = randomUUID()): string {
  if (!Number.isSafeInteger(now.getTime())) throw new RangeError("key time must be a valid instant");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new TypeError("idempotency key UUID must be version 4");
  }
  return `v1.${now.getTime()}.${uuid.toLowerCase()}`;
}

function refusal(status: 400 | 409 | 503, reason: RefusalReason): MutationResult {
  return { ok: false, status, reason };
}

function requestIsValid(request: MutationRequest): boolean {
  if (!REFERENCE_PATTERN.test(request.principalRef)) return false;
  if (!MUTATION_METHODS.has(request.method)) return false;
  if (!ROUTE_PATTERN.test(request.route) || request.route.includes("?")) return false;
  return isJsonValue(request.payload);
}

export function createIdempotency(options: IdempotencyOptions): IdempotencyImplementation {
  const { store } = options;
  const clock = options.clock ?? { now: () => new Date() };
  const retentionMs = options.retentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
  const futureSkewMs = options.futureSkewMs ?? DEFAULT_IDEMPOTENCY_FUTURE_SKEW_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) throw new RangeError("retentionMs must be positive");
  if (!Number.isSafeInteger(futureSkewMs) || futureSkewMs < 0) throw new RangeError("futureSkewMs must be non-negative");

  return {
    async execute(request: MutationRequest, operation: MutationOperation): Promise<MutationResult> {
      if (!requestIsValid(request)) return refusal(400, "invalid_request");
      if (request.key === undefined || request.key.length === 0) return refusal(400, "missing_key");
      const match = KEY_PATTERN.exec(request.key);
      if (!match) return refusal(400, "invalid_key");

      const issuedAtMs = Number(match[1]);
      const nowMs = clock.now().getTime();
      if (!Number.isSafeInteger(nowMs)) return refusal(503, "operation_failed");
      if (issuedAtMs > nowMs + futureSkewMs) return refusal(400, "key_in_future");
      // This check happens before storage lookup. After cleanup deletes the
      // response, the immutable timestamp in the same key still makes replay a
      // refusal rather than a second execution.
      if (nowMs >= issuedAtMs + retentionMs) return refusal(409, "key_expired");

      let outcome;
      try {
        outcome = await store.executeAtomic({
          principalRef: request.principalRef,
          key: request.key,
          fingerprint: mutationFingerprint(request),
          expiresAt: new Date(issuedAtMs + retentionMs),
        }, operation);
      } catch {
        return refusal(503, "operation_failed");
      }

      if (outcome.kind === "conflict") return refusal(409, "key_payload_mismatch");
      if (outcome.kind === "expired") return refusal(409, "key_expired");
      if (outcome.kind === "failed") return refusal(503, "operation_failed");
      return { ok: true, replayed: outcome.kind === "replayed", response: outcome.response };
    },

    cleanup(): Promise<number> {
      return store.cleanupExpired(clock.now());
    },
  };
}
