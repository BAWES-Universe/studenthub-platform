/**
 * Source-connection import contract — SHU-77.
 *
 * Normalizes Discord and Google source-connection records into CANDIDATE
 * identity-link inputs for the StudentHub person registry. It produces
 * candidates and conflict reports; it never writes, never reads live data, and
 * never links anything itself.
 *
 * The property this contract exists to protect:
 *
 *   SHU-29's login binds identity on exact (issuer, subject) and creates a new
 *   person on first login. It deliberately does NOT match on email, phone, name
 *   or date of birth — `external_identities` has its primary key on
 *   (issuer, subject), and mutable profile fields are attributes, never lookup
 *   keys. A real-Postgres test pins it: "mutable profile attributes never match
 *   or merge external identities".
 *
 *   An importer that links an external identity to an EXISTING person is, by
 *   construction, doing the thing that binding refuses. So this contract states
 *   what evidence DOES justify a link, rather than inheriting a matching
 *   heuristic — most likely email — by accident.
 */

/** The external systems this contract accepts records from. */
export const SUPPORTED_SOURCES = ["discord", "google"] as const;
export type SourceSystem = (typeof SUPPORTED_SOURCES)[number];

export const SOURCE_CONNECTION_CONTRACT_VERSION = "1.0.0" as const;

/**
 * The input shape this contract accepts.
 *
 * These field names are the CONTRACT's own, not an observed donor schema. The
 * StudentHub Next donor baseline (`donor/studenthub-codex`, 129 Prisma models)
 * has no Discord or Google source-connection table at all, and neither does
 * this repository, so there was nothing to derive a field set from. Whatever
 * really produces these rows is a live Discord/Google export, and reading one
 * needs credentials and data authorization this card does not have. Mapping a
 * real export onto these fields is therefore an open operator dependency,
 * recorded on SHU-77; the rules below hold whatever the donor field names turn
 * out to be.
 *
 * Deliberately permissive: the point of normalization is to reject what does
 * not meet the contract, so the input type must be able to express the
 * malformed cases.
 */
export interface RawSourceRecord {
  readonly source?: string;
  /** The external system's own immutable id for the account. */
  readonly externalId?: string;
  /** The platform person this record claims to belong to. */
  readonly personId?: string;
  /** Where this record came from — file, export id, or system of record. */
  readonly provenance?: string;
  /** When the source observed this association. ISO-8601. */
  readonly observedAt?: string;
  /**
   * Mutable profile claims. Carried for operator review ONLY. Nothing in this
   * contract may key, match, or join on any field in here.
   */
  readonly profile?: Readonly<Record<string, unknown>>;
}

/**
 * A validated candidate link. `profile` is deliberately absent: once a record
 * is normalized, the mutable claims have served their purpose and carrying them
 * further is how they end up in a log, a diff, or a join.
 */
export interface NormalizedSourceConnection {
  readonly contractVersion: typeof SOURCE_CONNECTION_CONTRACT_VERSION;
  readonly source: SourceSystem;
  readonly externalId: string;
  readonly personId: string;
  readonly provenance: string;
  /** Normalized to a UTC instant so ordering is total and comparable. */
  readonly observedAt: string;
}

export type RejectionReason =
  | "unsupported_source"
  | "missing_external_id"
  /** An external id that would have to be cleaned before it could be a key. */
  | "malformed_external_id"
  | "missing_person_id"
  /** A person id that would have to be cleaned before it could be a key. */
  | "malformed_person_id"
  | "missing_provenance"
  | "missing_observed_at"
  | "malformed_observed_at";

/** One input that did not meet the contract, with the reason it failed. */
export interface RejectedRecord {
  readonly reason: RejectionReason;
  /** Masked. Never the raw value — see `maskIdentifier`. */
  readonly externalIdMask: string;
  readonly source: string;
}

export type ConflictKind =
  /** One external identity claimed by more than one person. */
  | "external_identity_claimed_by_multiple_people"
  /** One person claimed by the same source under different external ids. */
  | "person_claimed_inconsistently";

/**
 * A conflict that a human must resolve. Fails closed: neither side is imported,
 * because picking one silently is how a wrong link becomes permanent.
 */
export interface ConflictReport {
  readonly kind: ConflictKind;
  readonly source: SourceSystem;
  /** Masked identifiers only, sorted, so the report is deterministic. */
  readonly externalIdMasks: readonly string[];
  /**
   * SHA-256 references, never raw person ids -- see `personRef`. A person id can
   * be an email address under `sub_mode = user_email`, and a conflict report is
   * the artifact most likely to be pasted into an issue or a chat message.
   */
  readonly personRefs: readonly string[];
}

/** What a dry run is allowed to emit. Counts and masks, nothing else. */
export interface DryRunReport {
  readonly contractVersion: typeof SOURCE_CONNECTION_CONTRACT_VERSION;
  readonly accepted: number;
  readonly rejected: number;
  readonly conflicts: number;
  readonly bySource: Readonly<Record<SourceSystem, number>>;
  readonly rejections: readonly RejectedRecord[];
  readonly conflictReports: readonly ConflictReport[];
}

export interface NormalizationResult {
  readonly accepted: readonly NormalizedSourceConnection[];
  readonly rejected: readonly RejectedRecord[];
  readonly conflicts: readonly ConflictReport[];
}
