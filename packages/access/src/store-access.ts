import { grantCovers, type HeldGrant } from "./grant-catalogue.js";

/**
 * Access lane A4: the store manager scope, the one rule.
 *
 * A store grant is a row of store_manager_access naming one store and one
 * principal. It is not a row of grants: it adds no role and no scope to the
 * closed unions, so it can never satisfy a company check, and only store
 * pages read it. It holds only while it is not revoked, the store is active
 * and its company is live; all three are read with the grant row itself.
 */

export const STORE_MANAGER = "store-manager";
export const STORE_ACCESS_GRANTED_REASON = "Store manager invitation accepted";
export const STORE_ACCESS_REMOVED_REASON = "Store manager access removed";

/** One store grant as a store page reads it: the grant row joined with its store and company, at request time. */
export interface ManagedStoreRow {
  readonly principalId: string;
  readonly storeId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly name: string;
  readonly location: string | null;
  readonly brand: string | null;
  readonly mall: string | null;
  readonly revokedAt: string | null;
  readonly storeStatus: string;
  readonly orgLive: boolean;
}

/** The one rule: a store grant holds only while not revoked, the store active and its company live. */
export function storeAccessHolds(row: Pick<ManagedStoreRow, "revokedAt" | "storeStatus" | "orgLive">): boolean {
  return row.revokedAt === null && row.storeStatus === "active" && row.orgLive;
}

/** The stores a principal manages now, from their own grant rows only. */
export function managedStores(principalId: string, rows: readonly ManagedStoreRow[]): readonly ManagedStoreRow[] {
  return rows.filter((row) => row.principalId === principalId && storeAccessHolds(row));
}

/** The one store a principal may open, or undefined (answered as an unknown path). */
export function openManagedStore(principalId: string, storeId: string, rows: readonly ManagedStoreRow[]): ManagedStoreRow | undefined {
  return managedStores(principalId, rows).find((row) => row.storeId === storeId);
}

/** Who offers and takes away store manager access: an owner covering the company, or staff or admin covering it. */
export function mayManageStoreAccess(grants: readonly HeldGrant[], orgId: string, ancestors: readonly string[]): boolean {
  return grants.some((grant) => (grant.role === "org-owner" || grant.role === "staff" || grant.role === "admin") && grantCovers(grant, orgId, ancestors));
}

export type StoreAccessRefusal = "not_allowed" | "unknown_store" | "not_found";

export interface StoreOfferSnapshot {
  readonly callerGrants: readonly HeldGrant[];
  readonly orgLive: boolean;
  readonly orgAncestors: readonly string[];
  /** The store's company and status, or null when there is no such store. */
  readonly store: null | { readonly orgId: string; readonly status: string };
}

/** Offering or removing store manager access for one store of `orgId`. */
export function decideStoreAccessChange(orgId: string, snapshot: StoreOfferSnapshot):
  { readonly kind: "ok" } | { readonly kind: "refused"; readonly reason: StoreAccessRefusal } {
  if (!snapshot.orgLive || !snapshot.store || snapshot.store.orgId !== orgId || snapshot.store.status !== "active") {
    return { kind: "refused", reason: "unknown_store" };
  }
  if (!mayManageStoreAccess(snapshot.callerGrants, orgId, snapshot.orgAncestors)) return { kind: "refused", reason: "not_allowed" };
  return { kind: "ok" };
}
