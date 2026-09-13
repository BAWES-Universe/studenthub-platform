/** SHU-233 — transport idempotency for every replacement-platform mutation. */

export const IDEMPOTENCY_CONTRACT_VERSION = "1.0.0";
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const DEFAULT_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_IDEMPOTENCY_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export type Awaitable<T> = T | Promise<T>;
export type MutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";
export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export interface StoredResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}

export interface MutationRequest {
  /** Value of the Idempotency-Key request header. */
  readonly key?: string;
  /** A SHA-256 reference, never a raw login subject. */
  readonly principalRef: string;
  readonly method: MutationMethod;
  /** Canonical route template without query parameters. */
  readonly route: string;
  /** Every body, path and query value that can affect the mutation. */
  readonly payload: JsonValue;
}

export type RefusalReason =
  | "missing_key"
  | "invalid_key"
  | "key_in_future"
  | "key_expired"
  | "invalid_request"
  | "key_payload_mismatch"
  | "operation_failed";

export type MutationResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly response: StoredResponse;
    }
  | {
      readonly ok: false;
      readonly status: 400 | 409 | 503;
      readonly reason: RefusalReason;
    };

export interface IdempotencyClock {
  now(): Date;
}

export interface IdempotencyTransaction {
  insert(collection: string, row: JsonValue): Awaitable<void>;
  enqueue(topic: string, event: JsonValue): Awaitable<void>;
}

export type MutationOperation = (transaction: IdempotencyTransaction) => Awaitable<StoredResponse>;

export interface AtomicMutationInput {
  /** Unique scope is (principalRef, key); endpoint and payload are fingerprinted. */
  readonly principalRef: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly expiresAt: Date;
}

export type AtomicMutationOutcome =
  | { readonly kind: "executed"; readonly response: StoredResponse }
  | { readonly kind: "replayed"; readonly response: StoredResponse }
  | { readonly kind: "conflict" }
  | { readonly kind: "expired" }
  | { readonly kind: "failed" };

/**
 * This is the load-bearing boundary. Implementations MUST make the uniqueness
 * claim, business rows, transactional-outbox rows, and stored response one
 * database transaction. They MUST also compare `expiresAt` to the database
 * transaction clock before looking up or inserting a record, closing the race
 * with cleanup. A caller-side Map or preflight SELECT is insufficient.
 */
export interface IdempotencyStore {
  executeAtomic(input: AtomicMutationInput, operation: MutationOperation): Promise<AtomicMutationOutcome>;
  cleanupExpired(now: Date): Promise<number>;
}

export interface IdempotencyImplementation {
  execute(request: MutationRequest, operation: MutationOperation): Promise<MutationResult>;
  cleanup(): Promise<number>;
}

export interface IdempotencyOptions {
  readonly store: IdempotencyStore;
  readonly clock?: IdempotencyClock;
  readonly retentionMs?: number;
  readonly futureSkewMs?: number;
}
