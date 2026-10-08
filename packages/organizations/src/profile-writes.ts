import { createHash } from "node:crypto";
import {
  createSafeWrite, type FieldPolicy, type SafeWriteClock, type SafeWriteImplementation,
  type SafeWriteSecret, type SafeWriteStore,
} from "@studenthub/safe-write-contract";

export const ORGANIZATION_PROFILE_FIELDS = Object.freeze([
  "name_en", "name_ar", "description_en", "description_ar", "website",
] as const);
export type OrganizationProfileField = (typeof ORGANIZATION_PROFILE_FIELDS)[number];
export const ORGANIZATION_PROFILE_POLICY: FieldPolicy = Object.freeze({
  allowed: ORGANIZATION_PROFILE_FIELDS,
  maxValueLength: 2_000,
});

export interface OrganizationGrantRow { readonly org_id: string; readonly role: string }

/** The sole owner decision, shared by the real store and its focused tests. */
export function organizationOwnerDecision(rows: readonly OrganizationGrantRow[], orgId: string): boolean {
  return rows.some((row) => row.org_id === orgId && row.role === "org-owner");
}

/** The sole lost-update decision, called on the value read under the transaction lock. */
export function organizationProfileStateDecision(current: string | null, expectedBefore: string | null): boolean {
  return current === expectedBefore;
}

function ref(domain: string, value: string): string {
  return createHash("sha256").update(`studenthub:${domain}:v1\0`).update(value).digest("hex");
}
export const organizationProfileRecordRef = (orgId: string): string => ref("organization-profile-record", orgId);
export const organizationProfilePrincipalRef = (principalId: string): string => ref("organization-profile-principal", principalId);

export interface OrganizationProfileBuildInput {
  readonly store: SafeWriteStore;
  readonly secret: SafeWriteSecret;
  readonly policy?: FieldPolicy;
  readonly clock?: SafeWriteClock;
  readonly tokenLifetimeMs?: number;
}

/** Production and conformance both enter through this exact builder. */
export function buildOrganizationProfileWrite(input: OrganizationProfileBuildInput): SafeWriteImplementation {
  const implementation = createSafeWrite({
    store: input.store, secret: input.secret, policy: input.policy ?? ORGANIZATION_PROFILE_POLICY,
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.tokenLifetimeMs === undefined ? {} : { tokenLifetimeMs: input.tokenLifetimeMs }),
  });
  return { preview: implementation.preview, confirm: implementation.confirm };
}
