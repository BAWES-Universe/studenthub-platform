import {
  createSafeWrite,
  type FieldPolicy,
  type SafeWriteClock,
  type SafeWriteImplementation,
  type SafeWriteSecret,
  type SafeWriteStore,
} from "@studenthub/safe-write-contract";

export const ORGANIZATION_PROFILE_FIELDS = Object.freeze([
  "commonNameEn", "commonNameAr", "descriptionEn", "descriptionAr", "website",
] as const);
export type OrganizationProfileField = (typeof ORGANIZATION_PROFILE_FIELDS)[number];

export function mayWriteOrganizationProfile(role: string, grantedOrgId: string, requestedOrgId: string): boolean {
  return role === "org-owner" && grantedOrgId === requestedOrgId;
}

export function organizationProfileStateMatches(current: string | null, expectedBefore: string | null): boolean {
  return current === expectedBefore;
}

export const ORGANIZATION_PROFILE_POLICY: FieldPolicy = Object.freeze({
  allowed: ORGANIZATION_PROFILE_FIELDS,
  maxValueLength: 10_000,
});

export interface OrganizationProfileWriteBuildInput {
  readonly store: SafeWriteStore;
  readonly secret: SafeWriteSecret;
  readonly clock?: SafeWriteClock;
  readonly tokenLifetimeMs?: number;
  /** Conformance supplies its canary policy; production omits this. */
  readonly policy?: FieldPolicy;
}

/** The exact builder used by the route and by conformance. */
export function buildOrganizationProfileWrite(input: OrganizationProfileWriteBuildInput): SafeWriteImplementation {
  const implementation = createSafeWrite({ ...input, policy: input.policy ?? ORGANIZATION_PROFILE_POLICY });
  return {
    preview: (request) => implementation.preview(request),
    confirm: (request) => implementation.confirm(request),
  };
}
