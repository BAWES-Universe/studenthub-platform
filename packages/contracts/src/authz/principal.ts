/**
 * A Principal is ONE human (or other acting entity) across the whole platform.
 *
 * A human can own several platform business user UUIDs (pbuuids) — e.g. a
 * WorkAdventure player record, an Authentik-managed SSO identity, or a legacy
 * account — so grants are attached to the principal, never to a single
 * pbuuid. The authn layer maps a verified session to a principal server-side;
 * a pbuuid supplied by the client is only ever a lookup key, never proof.
 */
export interface Principal {
  readonly id: string;
  /** Every platform user uuid that maps back to this human. */
  readonly pbuuids: readonly string[];
  readonly displayName?: string;
  readonly email?: string;
}

export function createPrincipal(input: {
  readonly id: string;
  readonly pbuuids?: readonly string[];
  readonly displayName?: string;
  readonly email?: string;
}): Principal {
  const { id, displayName, email } = input;
  const pbuuids = [...new Set(input.pbuuids ?? [])];
  if (id.trim().length === 0) throw new TypeError("principal id must be a non-empty string");
  if (pbuuids.some((p) => p.trim().length === 0)) {
    throw new TypeError("pbuuids must be non-empty strings");
  }
  return Object.freeze({ id, pbuuids: Object.freeze(pbuuids), displayName, email });
}

export function principalHasPbuuid(principal: Principal, pbuuid: string): boolean {
  return principal.pbuuids.includes(pbuuid);
}
