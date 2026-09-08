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
 */

export const SAFE_WRITE_CONTRACT_VERSION = "1.0.0";

/** SHA-256 hex. Person and principal identities appear in this shape only. */
export const REFERENCE_PATTERN = /^[0-9a-f]{64}$/;

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
 * Issued by a preview, spent by a confirm. It commits to the exact change set:
 * that binding is the whole reason the token exists, and rule 2 is the scenario
 * that proves a confirm cannot apply something the preview never showed.
 */
export interface ActionToken {
  readonly tokenId: string;
  /** SHA-256 over the canonical change set. */
  readonly changeSetDigest: string;
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
 * The persistence port. `commit` must apply the field and write the receipt as
 * one unit: if it throws, neither happened. An implementation that writes the
 * field and then fails to record the receipt has left an unaudited mutation,
 * which is the failure rule 5 exists to forbid.
 */
export interface SafeWriteStore {
  readField(personRef: string, field: string): string | null;
  /** The record this principal may write, or null if it owns none. */
  ownedRecord(principalRef: string): string | null;
  commit(input: {
    readonly personRef: string;
    readonly principalRef: string;
    readonly field: string;
    readonly value: string;
    readonly changeSetDigest: string;
    readonly receipt: Receipt;
  }): void;
}

export interface SafeWriteClock {
  now(): Date;
}

export interface SafeWriteImplementation {
  preview(request: PreviewRequest): PreviewResult;
  confirm(request: ConfirmRequest): ConfirmResult;
}
