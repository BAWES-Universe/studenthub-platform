import type { Role } from "@studenthub/contracts";

export const ORGANIZATION_VIEW_VERSION = "studenthub.organization.v1" as const;
export const ORGANIZATION_PARITY_REVISION = "c2ce255695eabc7e3a0f23b162f5996274234c63" as const;

/** Legacy codes 10 / 9 / 0 (`common/models/Company.php:70-72`). */
export type OrganizationStatus = "active" | "under_review" | "inactive";

/**
 * One closed projection per audience, replacing the four legacy `fields()`
 * overrides (employer, manager, staff, admin). The store-manager audience has
 * no platform role yet: it arrives with the versioned store-scoped grant (I4).
 */
export type OrganizationAudience = "employer" | "staff" | "admin";

export interface AvailableOrganizationField<T> {
  readonly state: "available";
  readonly value: T;
  readonly sourceField: string;
}

export interface UnavailableOrganizationField {
  readonly state: "unavailable";
  readonly reason: "not_imported" | "not_recorded";
  readonly sourceField: string;
}

export type OrganizationField<T> = AvailableOrganizationField<T> | UnavailableOrganizationField;

export interface EmployerOrganizationFields {
  readonly legalName: OrganizationField<string>;
  readonly commonNameEn: OrganizationField<string>;
  readonly commonNameAr: OrganizationField<string>;
  readonly descriptionEn: OrganizationField<string>;
  readonly descriptionAr: OrganizationField<string>;
  readonly website: OrganizationField<string>;
  readonly currencyCode: OrganizationField<string>;
  readonly approvedToHire: OrganizationField<boolean>;
  readonly status: OrganizationField<OrganizationStatus>;
  /** Exact decimal string; falls back to the parent's rate when unset. */
  readonly hourlyRate: OrganizationField<string>;
}

export interface StaffOrganizationFields extends EmployerOrganizationFields {
  readonly email: OrganizationField<string>;
  readonly statusOverride: OrganizationField<OrganizationStatus>;
}

export interface AdminOrganizationFields extends StaffOrganizationFields {
  /** Exact decimal percent; falls back to the parent's commission when unset. */
  readonly bonusCommission: OrganizationField<string>;
}

export type OrganizationFieldName = keyof AdminOrganizationFields;

export interface OrganizationFieldContract {
  readonly label: string;
  readonly sourceField: string;
}

interface OrganizationViewBase {
  readonly version: typeof ORGANIZATION_VIEW_VERSION;
  readonly orgId: string;
  /** Present only for a sub-organization; the parent is always a top-level organization. */
  readonly parentOrgId: string | null;
  /** Platform registry name, which the grant context already shows. */
  readonly registryName: string;
  readonly snapshot: { readonly kind: "imported"; readonly observedAt: string } | { readonly kind: "not_imported" };
}

export type OrganizationView =
  | (OrganizationViewBase & { readonly audience: "employer"; readonly fields: Readonly<EmployerOrganizationFields> })
  | (OrganizationViewBase & { readonly audience: "staff"; readonly fields: Readonly<StaffOrganizationFields> })
  | (OrganizationViewBase & { readonly audience: "admin"; readonly fields: Readonly<AdminOrganizationFields> });

export interface SubOrganizationSummary {
  readonly orgId: string;
  readonly registryName: string;
  readonly status: OrganizationField<OrganizationStatus>;
}

export type ApprovedOrganizationSnapshot =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "missing" }
  | { readonly kind: "found"; readonly row: unknown };

/**
 * Approved-data seam only. An implementation returns the imported legacy
 * `company` snapshot already linked to a platform organization id. It never
 * resolves an organization by name, email or another mutable attribute.
 */
export interface ApprovedOrganizationAdapter {
  readSnapshot(orgId: string): Promise<ApprovedOrganizationSnapshot>;
}

export interface OrganizationReadRequest {
  readonly principalId: string;
  readonly orgId: string;
  /** The role the caller acts as; validated against current grants. */
  readonly role: Role | string;
}

export type OrganizationReadResult =
  | { readonly kind: "found"; readonly organization: OrganizationView }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

export type SubOrganizationListResult =
  | { readonly kind: "found"; readonly subOrganizations: readonly SubOrganizationSummary[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

export interface OrganizationReader {
  read(request: OrganizationReadRequest): Promise<OrganizationReadResult>;
  listSubOrganizations(request: OrganizationReadRequest): Promise<SubOrganizationListResult>;
}
