/**
 * SHU-82 — the executable contract for a safe write.
 *
 * Every surface the platform has shipped so far reads. This is the shape of the
 * first thing that writes, and the rules it must obey stated so they can be
 * executed rather than admired.
 *
 * There is no I/O in this package: no route, no database handle, no network
 * call, no credential. The store is a port the caller supplies, which is what
 * lets a scenario prove "a preview writes nothing" instead of asserting it.
 *
 * The port is ASYNCHRONOUS. Every real store this contract must bind — the
 * platform's PostgreSQL adapters, the gateway's request path — is async, and a
 * synchronous port could not run against them. Worse, a synchronous port would
 * accept a Promise from `commit` and treat a rejected write as a successful
 * one, so the "receipt is part of the transaction" rule would silently not
 * hold. Sync implementations still satisfy `Awaitable`.
 */

export const SAFE_WRITE_CONTRACT_VERSION = "3.0.0";

/** SHA-256 hex. Person and principal identities appear in this shape only. */
export const REFERENCE_PATTERN = /^[0-9a-f]{64}$/;

export type Awaitable<T> = T | Promise<T>;

/**
 * Every way a preview or a confirm can be refused. A closed vocabulary, so a
 * report's strings can be checked against a whitelist rather than scanned for
 * the identifiers someone happened to think of.
 */
export const REJECTION_REASONS = [
  "unknown_field",
  "invalid_value",
  "malformed_reference",
  "not_own_record",
  "token_expired",
  "token_already_used",
  "token_principal_mismatch",
  "token_change_set_mismatch",
  "token_not_issued",
  "state_changed",
  "receipt_failed",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** The fields a deployment permits. SHU-83 decides the real membership. */
export interface FieldPolicy {
  readonly allowed: readonly string[];
  readonly maxValueLength: number;
}

export interface ChangeRequest {
  /** SHA-256 reference to the record being changed. */
  readonly personRef: string;
  readonly field: string;
  readonly value: string;
}

export interface FieldChange {
  readonly field: string;
  readonly before: string | null;
  readonly after: string;
}

/**
 * Issued by a preview, spent by a confirm.
 *
 * It commits to the whole transition, not just the destination: `changeSetDigest`
 * covers what the value becomes and `expectedBeforeDigest` covers what it was
 * when the person looked. A person who approves "A becomes C" has not approved
 * "B becomes C", and without the second digest a change landing between preview
 * and confirm is silently overwritten.
 */
export interface ActionToken {
  readonly tokenId: string;
  /**
   * HMAC over the token's own fields. Without it every field is
   * caller-suppliable, so a caller can mint one and confirm a change no
   * preview ever showed — which is precisely the step the token exists to
   * make unskippable.
   */
  readonly mac: string;
  /** SHA-256 over the canonical change set. */
  readonly changeSetDigest: string;
  /** SHA-256 over the value the preview showed as current. */
  readonly expectedBeforeDigest: string;
  /** Only this principal may confirm. */
  readonly principalRef: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface PreviewAccepted {
  readonly ok: true;
  readonly changes: readonly FieldChange[];
  readonly token: ActionToken;
}

export interface Refused {
  readonly ok: false;
  readonly reason: RejectionReason;
}

export type PreviewResult = PreviewAccepted | Refused;

/**
 * What a completed write leaves behind. Carries references and closed
 * vocabulary only: under `sub_mode = user_email` a subject IS an email address,
 * so a receipt that echoed one would be publishing personal data into an audit
 * surface built to be shared.
 */
export interface Receipt {
  readonly contractVersion: string;
  readonly receiptRef: string;
  readonly personRef: string;
  readonly principalRef: string;
  readonly changeSetDigest: string;
  readonly fields: readonly string[];
  readonly committedAt: string;
}

export interface ConfirmAccepted {
  readonly ok: true;
  readonly receipt: Receipt;
}

export type ConfirmResult = ConfirmAccepted | Refused;

export interface ConfirmRequest {
  readonly token: ActionToken;
  readonly change: ChangeRequest;
  readonly principalRef: string;
}

export interface PreviewRequest {
  readonly change: ChangeRequest;
  readonly principalRef: string;
}

/**
 * What an atomic commit reports. A rejected precondition is a normal outcome and
 * says which one failed; a thrown error means the transaction failed and neither
 * the field nor the receipt survived it.
 *
 * All three refusals exist because all three preconditions are re-checked INSIDE
 * the transaction. Anything checked before it can change before the write lands:
 * the record can move, the grant can be revoked, and a second confirm of the
 * same token can arrive while the first is still in flight.
 */
export type CommitRefusal = "state_changed" | "token_already_used" | "not_own_record";

export type CommitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CommitRefusal };

export interface CommitInput {
  readonly personRef: string;
  readonly principalRef: string;
  /**
   * The token being spent. Single-use is enforced HERE, not by the caller: an
   * in-memory guard cannot survive a restart and cannot see a second process,
   * so a store that does not record spent tokens does not have a single-use
   * token, it has a token that is usually used once.
   */
  readonly tokenId: string;
  readonly field: string;
  /**
   * The value the preview showed. The commit must apply the change ONLY if the
   * stored value still equals this — the compare half of compare-and-write.
   * Checking it in application code instead would leave a window between the
   * read and the write.
   */
  readonly expectedBefore: string | null;
  readonly value: string;
  readonly changeSetDigest: string;
  readonly receipt: Receipt;
}

/**
 * The persistence port. `commit` must check every precondition, apply the field
 * and write the receipt as ONE unit: if it throws, none of it happened. An
 * implementation that writes the field and then fails to record the receipt has
 * left an unaudited mutation, which is the failure rule 6 exists to forbid.
 *
 * The preconditions are checked inside the transaction and NOT delegated back to
 * the caller, because each one can change between a caller-side check and the
 * write:
 *
 * - `expectedBefore` still matches the stored value  -> else `state_changed`
 * - `tokenId` has not already been committed         -> else `token_already_used`
 * - `principalRef` still owns `personRef`            -> else `not_own_record`
 */
export interface SafeWriteStore {
  readField(personRef: string, field: string): Awaitable<string | null>;
  /** The record this principal may write, or null if it owns none. */
  ownedRecord(principalRef: string): Awaitable<string | null>;
  commit(input: CommitInput): Awaitable<CommitOutcome>;
}

/** Signing key for action tokens. At least 32 bytes. */
export type SafeWriteSecret = string | Buffer;

export interface SafeWriteClock {
  now(): Date;
}

export interface SafeWriteImplementation {
  preview(request: PreviewRequest): Promise<PreviewResult>;
  confirm(request: ConfirmRequest): Promise<ConfirmResult>;
}
