/**
 * Issuer-key registry contract (Opus standard amendment, SHU-49).
 *
 * Every actor assertion names an issuer + key id (`kid`). The gateway must
 * never trust an assertion whose key it cannot account for, so it consults a
 * registry BEFORE any verification/authorization step. This module defines
 * the registry contract plus a reference in-memory implementation; the
 * Postgres-backed registry and real cryptographic verification land with the
 * authn work (SHU-0020).
 *
 * Rotation rules baked into the contract:
 * - Keys are only ever ACTIVE or RETIRED. Retiring replaces the previous
 *   active key(s) of an issuer for NEW assertions while keeping the row
 *   available for audit and (later) overlap verification of already-issued
 *   assertions — deletion would make in-flight sessions unverifiable.
 * - An unknown issuer/kid is a hard deny at the middleware layer; there is no
 *   "accept anything" fallback.
 * - Registering an already-known (issuer, keyId) is idempotent.
 */
export const ISSUER_KEY_ALGORITHMS = ["EdDSA", "ES256", "RS256"] as const;
export type IssuerKeyAlgorithm = (typeof ISSUER_KEY_ALGORITHMS)[number];

export const ISSUER_KEY_STATUSES = ["active", "retired"] as const;
export type IssuerKeyStatus = (typeof ISSUER_KEY_STATUSES)[number];

export interface IssuerKeyDescriptor {
  /** Stable issuer name (e.g. "authentik", "gateway", a tenant id). */
  readonly issuer: string;
  /** Key id referenced by an assertion's `keyId`. */
  readonly keyId: string;
  readonly algorithm: IssuerKeyAlgorithm;
  readonly status: IssuerKeyStatus;
  /** ISO-8601 registration timestamp. */
  readonly registeredAt: string;
  /**
   * Opaque public-key material (PEM/JWK). Carried here so the contract shape
   * survives the move to real crypto; contents are NOT interpreted yet.
   */
  readonly publicKey?: string;
}

/** What a caller supplies when registering a new signing key. */
export interface IssuerKeyRegistration {
  readonly issuer: string;
  readonly keyId: string;
  readonly algorithm: IssuerKeyAlgorithm;
  readonly publicKey?: string;
}

export interface IssuerKeyRegistry {
  getIssuerKey(issuer: string, keyId: string): Promise<IssuerKeyDescriptor | undefined>;
  listIssuerKeys(issuer?: string): Promise<readonly IssuerKeyDescriptor[]>;
  /** Register a key as ACTIVE. Idempotent for an existing (issuer, keyId). */
  registerKey(registration: IssuerKeyRegistration): Promise<IssuerKeyDescriptor>;
  /**
   * Rotate: retire every active key of `issuer` other than the one that stays,
   * keeping rows for overlap verification/audit.
   */
  retireIssuerKey(issuer: string, keyId: string): Promise<IssuerKeyDescriptor>;
}

function assertRegistryName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

/** Reference in-memory implementation. */
export class InMemoryIssuerKeyRegistry implements IssuerKeyRegistry {
  readonly #keysByIssuer = new Map<string, Map<string, IssuerKeyDescriptor>>();

  async getIssuerKey(
    issuer: string,
    keyId: string,
  ): Promise<IssuerKeyDescriptor | undefined> {
    return this.#keysByIssuer.get(issuer)?.get(keyId);
  }

  async listIssuerKeys(issuer?: string): Promise<readonly IssuerKeyDescriptor[]> {
    const rows =
      issuer === undefined
        ? [...this.#keysByIssuer.values()].flatMap((byKeyId) => [...byKeyId.values()])
        : [...(this.#keysByIssuer.get(issuer)?.values() ?? [])];
    return Object.freeze(
      [...rows].sort(
        (a, b) => a.issuer.localeCompare(b.issuer) || a.keyId.localeCompare(b.keyId),
      ),
    );
  }

  async registerKey(
    registration: IssuerKeyRegistration,
  ): Promise<IssuerKeyDescriptor> {
    const issuer = assertRegistryName(registration.issuer, "issuer");
    const keyId = assertRegistryName(registration.keyId, "keyId");
    if (!(ISSUER_KEY_ALGORITHMS as readonly string[]).includes(registration.algorithm)) {
      throw new TypeError(
        `algorithm must be one of ${JSON.stringify([...ISSUER_KEY_ALGORITHMS])}`,
      );
    }

    let byKeyId = this.#keysByIssuer.get(issuer);
    if (byKeyId === undefined) {
      byKeyId = new Map();
      this.#keysByIssuer.set(issuer, byKeyId);
    }
    const existing = byKeyId.get(keyId);
    if (existing !== undefined) return existing; // idempotent

    const key: IssuerKeyDescriptor = Object.freeze({
      issuer,
      keyId,
      algorithm: registration.algorithm,
      status: "active",
      registeredAt: new Date().toISOString(),
      ...(registration.publicKey !== undefined
        ? { publicKey: registration.publicKey }
        : {}),
    });
    byKeyId.set(keyId, key);
    return key;
  }

  async retireIssuerKey(issuer: string, keyId: string): Promise<IssuerKeyDescriptor> {
    const byKeyId = this.#keysByIssuer.get(issuer);
    const existing = byKeyId?.get(keyId);
    if (existing === undefined) {
      throw new RangeError(`no key '${keyId}' registered for issuer '${issuer}'`);
    }
    if (existing.status === "retired") return existing;
    const retired: IssuerKeyDescriptor = Object.freeze({ ...existing, status: "retired" });
    byKeyId?.set(keyId, retired);
    return retired;
  }
}
