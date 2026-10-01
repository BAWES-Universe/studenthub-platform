import type { Role } from "@studenthub/contracts";

export const CATALOGUE_TYPES = [
  "country", "currency", "bank", "tag", "brand", "mall",
  "university", "major", "degree", "degree-group",
] as const;
export type CatalogueType = typeof CATALOGUE_TYPES[number];

export const SUBMITTABLE_CATALOGUE_TYPES = ["university", "major"] as const;
export type SubmittableCatalogueType = typeof SUBMITTABLE_CATALOGUE_TYPES[number];

export interface CatalogueActor {
  readonly principalRef: string;
  readonly orgId: string;
  readonly role: Role;
}

export interface CatalogueItem {
  readonly id: string;
  readonly type: CatalogueType;
  readonly name: string;
  readonly code?: string;
  readonly status: "active" | "deleted";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export interface CatalogueSubmission {
  readonly id: string;
  readonly type: SubmittableCatalogueType;
  readonly name: string;
  readonly code?: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly submittedAt: string;
  readonly moderatedAt?: string;
  readonly createdItemId?: string;
}

export interface CataloguePage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface CatalogueItemInput {
  readonly name: string;
  readonly code?: string;
}

export interface CatalogueSortKey {
  readonly sortKey: string;
  readonly id: string;
}

export interface CatalogueStore {
  listActive(type: CatalogueType, after: CatalogueSortKey | undefined, limit: number): Promise<readonly CatalogueItem[]>;
  resolveById(type: CatalogueType, id: string): Promise<CatalogueItem | undefined>;
  createItem(input: CatalogueItem & { readonly actorRef: string }): Promise<CatalogueItem>;
  updateItem(type: CatalogueType, id: string, input: CatalogueItemInput & { readonly actorRef: string; readonly now: string }): Promise<CatalogueItem | undefined>;
  softDeleteItem(type: CatalogueType, id: string, actorRef: string, now: string): Promise<CatalogueItem | undefined>;
  createSubmission(input: CatalogueSubmission & { readonly actorRef: string; readonly orgId: string }): Promise<CatalogueSubmission>;
  listSubmissions(status: CatalogueSubmission["status"], type: SubmittableCatalogueType | undefined, after: CatalogueSortKey | undefined, limit: number): Promise<readonly CatalogueSubmission[]>;
  moderateSubmission(id: string, decision: "approved" | "rejected", actorRef: string, now: string, itemId: string): Promise<CatalogueSubmission | undefined>;
}

export function isCatalogueType(value: unknown): value is CatalogueType {
  return typeof value === "string" && (CATALOGUE_TYPES as readonly string[]).includes(value);
}

export function isSubmittableCatalogueType(value: unknown): value is SubmittableCatalogueType {
  return typeof value === "string" && (SUBMITTABLE_CATALOGUE_TYPES as readonly string[]).includes(value);
}
