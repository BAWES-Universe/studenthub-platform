import {
  ancestorOrgIdsIncludingSelf,
  resolveActiveContext,
  type AuthzStore,
  type Organization,
  type Role,
} from "@studenthub/contracts";

import {
  ORGANIZATION_PARITY_REVISION,
  ORGANIZATION_VIEW_VERSION,
  type ApprovedOrganizationAdapter,
  type ApprovedOrganizationSnapshot,
  type OrganizationAudience,
  type OrganizationField,
  type OrganizationFieldContract,
  type OrganizationFieldName,
  type OrganizationReadRequest,
  type OrganizationReadResult,
  type OrganizationReader,
  type OrganizationStatus,
  type OrganizationView,
  type SubOrganizationListResult,
  type SubOrganizationSummary,
} from "./types.js";

type Row = Readonly<Record<string, unknown>>;

/**
 * Which closed projection each role reads. Roles without an entry (candidate,
 * finance) have no organization projection and are answered `not_found`.
 */
export const ORGANIZATION_AUDIENCE_BY_ROLE: Readonly<Partial<Record<Role, OrganizationAudience>>> = Object.freeze({
  "org-owner": "employer",
  recruiter: "employer",
  staff: "staff",
  admin: "admin",
});

const EMPLOYER_FIELDS = Object.freeze([
  "legalName", "commonNameEn", "commonNameAr", "descriptionEn", "descriptionAr",
  "website", "currencyCode", "approvedToHire", "status", "hourlyRate",
] as const satisfies readonly OrganizationFieldName[]);
const STAFF_FIELDS = Object.freeze([...EMPLOYER_FIELDS, "email", "statusOverride"] as const);
const ADMIN_FIELDS = Object.freeze([...STAFF_FIELDS, "bonusCommission"] as const);

export const ORGANIZATION_FIELDS_BY_AUDIENCE: Readonly<Record<OrganizationAudience, readonly OrganizationFieldName[]>> = Object.freeze({
  employer: EMPLOYER_FIELDS,
  staff: STAFF_FIELDS,
  admin: ADMIN_FIELDS,
});

const STATUS_SOURCE = "company_status_override, total_candidate, is_request_updates_in_30_days, no_of_active_requests";

export const ORGANIZATION_FIELD_CONTRACT: Readonly<Record<OrganizationFieldName, OrganizationFieldContract>> = Object.freeze({
  legalName: { label: "Company name", sourceField: "company_name" },
  commonNameEn: { label: "Common name", sourceField: "company_common_name_en" },
  commonNameAr: { label: "Common name (Arabic)", sourceField: "company_common_name_ar" },
  descriptionEn: { label: "Description", sourceField: "company_description_en" },
  descriptionAr: { label: "Description (Arabic)", sourceField: "company_description_ar" },
  website: { label: "Website", sourceField: "company_website" },
  currencyCode: { label: "Currency", sourceField: "currency_code" },
  approvedToHire: { label: "Approved to hire", sourceField: "company_approved_to_hire" },
  status: { label: "Status", sourceField: STATUS_SOURCE },
  hourlyRate: { label: "Hourly rate", sourceField: "company_hourly_rate" },
  email: { label: "Company email", sourceField: "company_email" },
  statusOverride: { label: "Status set by staff", sourceField: "company_status_override" },
  bonusCommission: { label: "Bonus commission (%)", sourceField: "company_bonus_commission" },
});

function malformed(): never {
  throw new TypeError("malformed approved organization value");
}

function text(maxLength: number) {
  return (value: unknown): string => {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) malformed();
    return value;
  };
}

/** Exact decimal; floats are never introduced for money. */
function decimal(value: unknown): string {
  const raw = typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : value;
  if (typeof raw !== "string" || !/^\d{1,10}(?:\.\d{1,6})?$/.test(raw)) malformed();
  return raw;
}

function flag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return malformed();
}

function currency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) malformed();
  return value;
}

function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) malformed();
  return value;
}

const STATUS_CODES = new Map<unknown, OrganizationStatus>([[10, "active"], [9, "under_review"]]);

const PARSERS: Readonly<Record<Exclude<OrganizationFieldName, "status" | "statusOverride" | "hourlyRate" | "bonusCommission">, (value: unknown) => unknown>> = {
  legalName: text(255),
  commonNameEn: text(255),
  commonNameAr: text(255),
  descriptionEn: text(10_000),
  descriptionAr: text(10_000),
  website: text(2_048),
  currencyCode: currency,
  approvedToHire: flag,
  email: text(255),
};

function available<T>(name: OrganizationFieldName, value: T): OrganizationField<T> {
  return Object.freeze({ state: "available", value, sourceField: ORGANIZATION_FIELD_CONTRACT[name].sourceField });
}

function unavailable(name: OrganizationFieldName, reason: "not_imported" | "not_recorded"): OrganizationField<never> {
  return Object.freeze({ state: "unavailable", reason, sourceField: ORGANIZATION_FIELD_CONTRACT[name].sourceField });
}

/**
 * Raw `company_status_override`. Legacy applies the override only when it is
 * truthy, so 0/false (the column default) means "no override", not "inactive".
 */
function statusOverride(row: Row): OrganizationField<OrganizationStatus> {
  if (!Object.hasOwn(row, "company_status_override")) return unavailable("statusOverride", "not_imported");
  const raw = row.company_status_override;
  if (raw === null || raw === 0 || raw === false) return unavailable("statusOverride", "not_recorded");
  const status = STATUS_CODES.get(raw);
  if (status === undefined) malformed();
  return available("statusOverride", status);
}

/**
 * The single status derivation for every audience. Legacy kept four copies;
 * two ignored the override (OR-F2). The stored `company_status` column is
 * never read: an override wins, otherwise any positive activity counter makes
 * the organization active. Missing counters never silently become zero.
 */
export function deriveOrganizationStatus(row: Row): OrganizationField<OrganizationStatus> {
  const override = statusOverride(row);
  if (override.state === "available") return available("status", override.value);
  if (override.reason === "not_imported") return unavailable("status", "not_imported");
  let missing = false;
  for (const name of ["total_candidate", "is_request_updates_in_30_days", "no_of_active_requests"]) {
    if (!Object.hasOwn(row, name) || row[name] === null) {
      missing = true;
      continue;
    }
    if (counter(row[name]) > 0) return available("status", "active");
  }
  return missing ? unavailable("status", "not_imported") : available("status", "inactive");
}

function plainField(name: keyof typeof PARSERS, row: Row): OrganizationField<unknown> {
  const sourceField = ORGANIZATION_FIELD_CONTRACT[name].sourceField;
  if (!Object.hasOwn(row, sourceField)) return unavailable(name, "not_imported");
  const raw = row[sourceField];
  if (raw === null) return unavailable(name, "not_recorded");
  return available(name, PARSERS[name](raw));
}

/** Own value when recorded; otherwise the parent's, as both legacy projections do. */
function inheritedDecimal(name: "hourlyRate" | "bonusCommission", row: Row, parent: Row | null | undefined): OrganizationField<string> {
  const sourceField = ORGANIZATION_FIELD_CONTRACT[name].sourceField;
  if (!Object.hasOwn(row, sourceField)) return unavailable(name, "not_imported");
  if (row[sourceField] !== null) return available(name, decimal(row[sourceField]));
  if (parent === null) return unavailable(name, "not_recorded");
  if (parent === undefined || !Object.hasOwn(parent, sourceField)) return unavailable(name, "not_imported");
  return parent[sourceField] === null ? unavailable(name, "not_recorded") : available(name, decimal(parent[sourceField]));
}

function observedAt(row: Row): string {
  const value = row.imported_at;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("malformed approved organization snapshot");
  }
  if (row.source_revision !== ORGANIZATION_PARITY_REVISION) {
    throw new TypeError("unapproved organization source revision");
  }
  return value;
}

function snapshotRow(snapshot: ApprovedOrganizationSnapshot, orgId: string, parentOrgId: string | null): Row | undefined {
  if (snapshot.kind !== "found") return undefined;
  const row = snapshot.row;
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new TypeError("malformed approved organization snapshot");
  }
  const record = row as Row;
  observedAt(record);
  // The snapshot must describe the same place in the hierarchy that grants are resolved against.
  if (record.org_id !== orgId || (record.parent_org_id ?? null) !== parentOrgId) {
    throw new TypeError("approved organization snapshot disagrees with the organization registry");
  }
  return record;
}

/** Every field of an audience, in its declared order. */
export function projectOrganizationFields(
  audience: OrganizationAudience,
  row: Row | undefined,
  parent: Row | null | undefined,
): Readonly<Record<string, OrganizationField<unknown>>> {
  const names = ORGANIZATION_FIELDS_BY_AUDIENCE[audience];
  const fields: Record<string, OrganizationField<unknown>> = {};
  for (const name of names) {
    if (row === undefined) {
      fields[name] = unavailable(name, "not_imported");
    } else if (name === "status") {
      fields[name] = deriveOrganizationStatus(row);
    } else if (name === "statusOverride") {
      fields[name] = statusOverride(row);
    } else if (name === "hourlyRate" || name === "bonusCommission") {
      fields[name] = inheritedDecimal(name, row, parent);
    } else {
      fields[name] = plainField(name, row);
    }
  }
  return Object.freeze(fields);
}

export class HierarchyViolation extends Error {}

/**
 * Organization ids treated as the platform operator rather than as a company:
 * staff and admin grants live there (`bootstrap-admin` uses `root`). It is not
 * itself a readable organization and does not count as a hierarchy level.
 */
export const DEFAULT_OPERATOR_ORG_IDS = Object.freeze(["root"]);

/**
 * Company-level parent of `orgId`: null for a top-level organization.
 * Throws when the registry describes more than one level of sub-organization.
 */
export function companyParentOf(
  organizations: readonly Organization[],
  orgId: string,
  operatorOrgIds: ReadonlySet<string>,
): string | null {
  const chain = [...ancestorOrgIdsIncludingSelf(organizations, orgId)];
  if (chain.length > 0 && operatorOrgIds.has(chain[chain.length - 1]!)) chain.pop();
  if (chain.length === 0 || chain.some((id) => operatorOrgIds.has(id))) throw new HierarchyViolation("not a company");
  const top = organizations.find((org) => org.id === chain[chain.length - 1]);
  if (top?.parentOrgId !== undefined && !operatorOrgIds.has(top.parentOrgId)) {
    throw new HierarchyViolation("organization ancestry is incomplete or cyclic");
  }
  if (chain.length > 2) throw new HierarchyViolation("sub-organizations cannot have sub-organizations");
  return chain[1] ?? null;
}

export class OrganizationRepository implements OrganizationReader {
  readonly #store: AuthzStore;
  readonly #source: ApprovedOrganizationAdapter;
  readonly #operators: ReadonlySet<string>;

  constructor(options: {
    readonly store: AuthzStore;
    readonly source: ApprovedOrganizationAdapter;
    readonly operatorOrgIds?: readonly string[];
  }) {
    this.#store = options.store;
    this.#source = options.source;
    this.#operators = new Set(options.operatorOrgIds ?? DEFAULT_OPERATOR_ORG_IDS);
  }

  /** The audience the caller may read at `orgId` right now, or undefined. */
  async #authorize(request: OrganizationReadRequest, orgId: string): Promise<OrganizationAudience | undefined> {
    if (this.#operators.has(orgId)) return undefined;
    const audience = ORGANIZATION_AUDIENCE_BY_ROLE[request.role as Role];
    if (audience === undefined) return undefined;
    const resolution = await resolveActiveContext(
      { kind: "principal", principalId: request.principalId },
      { orgId, role: request.role },
      this.#store,
    );
    if (resolution.kind !== "authorized" || resolution.context.orgId !== orgId
      || resolution.context.role !== request.role) return undefined;
    return audience;
  }

  async read(request: OrganizationReadRequest): Promise<OrganizationReadResult> {
    try {
      // Authorization comes first so an unauthorized caller learns nothing, not even existence.
      const audience = await this.#authorize(request, request.orgId);
      if (audience === undefined) return { kind: "not_found" };
      const organizations = await this.#store.listOrganizations();
      const org = organizations.find((candidate) => candidate.id === request.orgId);
      if (!org) return { kind: "not_found" };
      const parentOrgId = companyParentOf(organizations, org.id, this.#operators);
      const snapshot = await this.#source.readSnapshot(org.id);
      const row = snapshotRow(snapshot, org.id, parentOrgId);
      let parent: Row | null | undefined = null;
      if (parentOrgId !== null) {
        const grandparent = companyParentOf(organizations, parentOrgId, this.#operators);
        parent = snapshotRow(await this.#source.readSnapshot(parentOrgId), parentOrgId, grandparent);
      }
      const view = Object.freeze({
        version: ORGANIZATION_VIEW_VERSION,
        audience,
        orgId: org.id,
        parentOrgId,
        registryName: org.name,
        snapshot: row === undefined
          ? Object.freeze({ kind: "not_imported" as const })
          : Object.freeze({ kind: "imported" as const, observedAt: observedAt(row) }),
        fields: projectOrganizationFields(audience, row, parent),
      }) as unknown as OrganizationView;
      return { kind: "found", organization: view };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async listSubOrganizations(request: OrganizationReadRequest): Promise<SubOrganizationListResult> {
    try {
      if (await this.#authorize(request, request.orgId) === undefined) return { kind: "not_found" };
      const organizations = await this.#store.listOrganizations();
      const parentOrgId = companyParentOf(organizations, request.orgId, this.#operators);
      const children = organizations.filter((org) => org.parentOrgId === request.orgId);
      // A sub-organization lists no sub-organizations; data that claims some is refused.
      if (parentOrgId !== null && children.length > 0) throw new HierarchyViolation("nested sub-organizations");
      const summaries: SubOrganizationSummary[] = [];
      for (const child of children) {
        // Sub-organizations are visible only through an explicit covering grant.
        if (await this.#authorize(request, child.id) === undefined) continue;
        const row = snapshotRow(await this.#source.readSnapshot(child.id), child.id, request.orgId);
        summaries.push(Object.freeze({
          orgId: child.id,
          registryName: child.name,
          status: row === undefined ? unavailable("status", "not_imported") : deriveOrganizationStatus(row),
        }));
      }
      summaries.sort((a, b) => a.registryName.localeCompare(b.registryName) || a.orgId.localeCompare(b.orgId));
      return { kind: "found", subOrganizations: Object.freeze(summaries) };
    } catch {
      return { kind: "unavailable" };
    }
  }
}
