import {
  ancestorOrgIdsIncludingSelf,
  descendantOrgIdsIncludingSelf,
  listEffectiveContexts,
  resolveActiveContext,
  type AuthzStore,
  type Organization,
  type Role,
} from "@studenthub/contracts";

import {
  ORGANIZATION_DIRECTORY_PAGE_SIZE,
  ORGANIZATION_DIRECTORY_VERSION,
  ORGANIZATION_PARITY_REVISION,
  ORGANIZATION_VIEW_VERSION,
  type ApprovedOrganizationAdapter,
  type ApprovedOrganizationSnapshot,
  type OrganizationAudience,
  type OrganizationDirectory,
  type OrganizationDirectoryEntry,
  type OrganizationDirectoryFilters,
  type OrganizationDirectoryRequest,
  type OrganizationDirectoryResult,
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
export type OrganizationStatusRecord = { readonly kind:"absent" } | { readonly kind:"cleared" } | { readonly kind:"status"; readonly status:OrganizationStatus };
export interface OrganizationStatusRecords {
  read(orgId:string):Promise<OrganizationStatusRecord>;
  readMany?(orgIds:readonly string[]):Promise<ReadonlyMap<string,OrganizationStatusRecord>>;
}
export type OrganizationCommercialTermRecord={readonly kind:"absent"}|{readonly kind:"cleared"}|{readonly kind:"value";readonly value:string};
export interface OrganizationCommercialTermsRecords{read(orgId:string):Promise<{readonly hourlyRate:OrganizationCommercialTermRecord;readonly bonusCommission:OrganizationCommercialTermRecord}>}
export type OrganizationApprovedToHireRecord={readonly kind:"absent"}|{readonly kind:"value";readonly value:boolean};
export interface OrganizationApprovedToHireRecords{read(orgId:string):Promise<OrganizationApprovedToHireRecord>;readMany(orgIds:readonly string[]):Promise<ReadonlyMap<string,OrganizationApprovedToHireRecord>>}

export function deriveOrganizationStatus(row: Row, record?:OrganizationStatusRecord): OrganizationField<OrganizationStatus> {
  if (record?.kind === "status") return available("status", record.status);
  const override = statusOverride(row);
  if (record?.kind !== "cleared") {
    if (override.state === "available") return available("status", override.value);
    if (override.reason === "not_imported") return unavailable("status", "not_imported");
  }
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

function storedDecimal(
  name: "hourlyRate" | "bonusCommission",
  row: Row | undefined,
  parent: Row | null | undefined,
  own: OrganizationCommercialTermRecord,
  parentRecord: OrganizationCommercialTermRecord,
): OrganizationField<string> {
  if (own.kind === "value") return available(name, decimal(own.value));

  // An absent stored record is deliberately indistinguishable from having no
  // commercial-terms port: retain every detail of the legacy snapshot result.
  if (own.kind === "absent") {
    if (row === undefined) return unavailable(name, "not_imported");
    const ownSnapshot = inheritedDecimal(name, row, null);
    if (ownSnapshot.state === "available" || ownSnapshot.reason === "not_imported") return ownSnapshot;
  }

  if (parent === null) return unavailable(name, "not_recorded");
  if (parentRecord.kind === "value") return available(name, decimal(parentRecord.value));
  if (parentRecord.kind === "cleared") return unavailable(name, "not_recorded");

  // Route the parent snapshot through the legacy implementation. A synthetic
  // null own value is needed when an explicit clear overrides a populated row.
  const sourceField = ORGANIZATION_FIELD_CONTRACT[name].sourceField;
  return inheritedDecimal(name, { [sourceField]: null }, parent);
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
  record?: OrganizationStatusRecord,
  terms?:{readonly own:{readonly hourlyRate:OrganizationCommercialTermRecord;readonly bonusCommission:OrganizationCommercialTermRecord};readonly parent:{readonly hourlyRate:OrganizationCommercialTermRecord;readonly bonusCommission:OrganizationCommercialTermRecord}},
  approvedRecord?:OrganizationApprovedToHireRecord,
): Readonly<Record<string, OrganizationField<unknown>>> {
  const names = ORGANIZATION_FIELDS_BY_AUDIENCE[audience];
  const fields: Record<string, OrganizationField<unknown>> = {};
  for (const name of names) {
    if(name==="approvedToHire"&&approvedRecord?.kind==="value"){
      fields[name]=available(name,approvedRecord.value);
    } else if (name === "status" && (row !== undefined || record?.kind === "status")) {
      fields[name] = deriveOrganizationStatus(row ?? {}, record);
    } else if (name === "statusOverride" && record !== undefined && record.kind !== "absent") {
      fields[name] = record.kind === "status" ? available("statusOverride", record.status) : unavailable("statusOverride", "not_recorded");
    } else if ((name === "hourlyRate" || name === "bonusCommission") && terms) {
      fields[name] = storedDecimal(name,row,parent,terms.own[name],terms.parent[name]);
    } else if (row === undefined) {
      fields[name] = unavailable(name, "not_imported");
    } else if (name === "status") {
      fields[name] = deriveOrganizationStatus(row, record);
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

/** Roles that list companies across their grant coverage (OR-05). Employers use sub-organization listing. */
export const ORGANIZATION_DIRECTORY_ROLES: ReadonlySet<string> = new Set<Role>(["staff", "admin"]);

const DIRECTORY_STATUSES: ReadonlySet<unknown> = new Set<OrganizationStatus>(["active", "under_review", "inactive"]);

function validDirectoryFilters(filters: OrganizationDirectoryFilters): boolean {
  const { query, status, approvedToHire, currencyCode, ...rest } = filters;
  if (Object.keys(rest).length > 0) return false;
  if (query !== undefined && (typeof query !== "string" || query.trim() !== query || query.length === 0
    || query.length > 100)) return false;
  if (status !== undefined && !DIRECTORY_STATUSES.has(status)) return false;
  if (approvedToHire !== undefined && typeof approvedToHire !== "boolean") return false;
  return currencyCode === undefined || (typeof currencyCode === "string" && /^[A-Z]{3}$/.test(currencyCode));
}

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en");
}

function availableValue<T>(field: OrganizationField<T>): T | undefined {
  return field.state === "available" ? field.value : undefined;
}

/** A filter on a field that is unavailable for a company never matches it. */
function matchesDirectoryFilters(entry: OrganizationDirectoryEntry, filters: OrganizationDirectoryFilters): boolean {
  if (filters.query !== undefined) {
    const needle = searchable(filters.query);
    const names = [entry.registryName, availableValue(entry.legalName), availableValue(entry.commonNameEn),
      availableValue(entry.commonNameAr)].filter((name): name is string => name !== undefined);
    if (!names.some((name) => searchable(name).includes(needle))) return false;
  }
  if (filters.status !== undefined && availableValue(entry.status) !== filters.status) return false;
  if (filters.approvedToHire !== undefined && availableValue(entry.approvedToHire) !== filters.approvedToHire) return false;
  return filters.currencyCode === undefined || availableValue(entry.currencyCode) === filters.currencyCode;
}

function directoryEntry(org: Organization, row: Row | undefined, subOrganizationCount: number, record?:OrganizationStatusRecord,approvedRecord?:OrganizationApprovedToHireRecord): OrganizationDirectoryEntry {
  const field = <T>(name: "legalName" | "commonNameEn" | "commonNameAr" | "currencyCode" | "approvedToHire") =>
    (row === undefined ? unavailable(name, "not_imported") : plainField(name, row)) as OrganizationField<T>;
  return Object.freeze({
    orgId: org.id,
    registryName: org.name,
    subOrganizationCount,
    legalName: field<string>("legalName"),
    commonNameEn: field<string>("commonNameEn"),
    commonNameAr: field<string>("commonNameAr"),
    currencyCode: field<string>("currencyCode"),
    approvedToHire: approvedRecord?.kind==="value"?available("approvedToHire",approvedRecord.value):field<boolean>("approvedToHire"),
    status: row === undefined && record?.kind !== "status" ? unavailable("status", "not_imported") : deriveOrganizationStatus(row ?? {},record),
  });
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

export class OrganizationRepository implements OrganizationReader, OrganizationDirectory {
  readonly #store: AuthzStore;
  readonly #source: ApprovedOrganizationAdapter;
  readonly #operators: ReadonlySet<string>;
  readonly #statusRecords?: OrganizationStatusRecords;
  readonly #commercialTerms?:OrganizationCommercialTermsRecords;
  readonly #approvedToHire?:OrganizationApprovedToHireRecords;

  constructor(options: {
    readonly store: AuthzStore;
    readonly source: ApprovedOrganizationAdapter;
    readonly operatorOrgIds?: readonly string[];
    readonly statusRecords?: OrganizationStatusRecords;
    readonly commercialTerms?:OrganizationCommercialTermsRecords;
    readonly approvedToHire?:OrganizationApprovedToHireRecords;
  }) {
    this.#store = options.store;
    this.#source = options.source;
    this.#operators = new Set(options.operatorOrgIds ?? DEFAULT_OPERATOR_ORG_IDS);
    this.#statusRecords = options.statusRecords;
    this.#commercialTerms=options.commercialTerms;
    this.#approvedToHire=options.approvedToHire;
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
      const statusRecord = await this.#statusRecords?.read(org.id);
      const approvedRecord=await this.#approvedToHire?.read(org.id);
      const absent={hourlyRate:{kind:"absent" as const},bonusCommission:{kind:"absent" as const}};
      const ownTerms=await this.#commercialTerms?.read(org.id)??absent;
      const row = snapshotRow(snapshot, org.id, parentOrgId);
      let parent: Row | null | undefined = null;
      if (parentOrgId !== null) {
        const grandparent = companyParentOf(organizations, parentOrgId, this.#operators);
        parent = snapshotRow(await this.#source.readSnapshot(parentOrgId), parentOrgId, grandparent);
      }
      const parentTerms=parentOrgId===null?absent:await this.#commercialTerms?.read(parentOrgId)??absent;
      const view = Object.freeze({
        version: ORGANIZATION_VIEW_VERSION,
        audience,
        orgId: org.id,
        parentOrgId,
        registryName: org.name,
        snapshot: row === undefined
          ? Object.freeze({ kind: "not_imported" as const })
          : Object.freeze({ kind: "imported" as const, observedAt: observedAt(row) }),
        fields: projectOrganizationFields(audience, row, parent, statusRecord,{own:ownTerms,parent:parentTerms},approvedRecord),
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
      const visibleChildren: Organization[] = [];
      for (const child of children) {
        // Sub-organizations are visible only through an explicit covering grant.
        if (await this.#authorize(request, child.id) === undefined) continue;
        visibleChildren.push(child);
      }
      const batchRecords = visibleChildren.length > 0 && this.#statusRecords?.readMany
        ? await this.#statusRecords.readMany(visibleChildren.map((child) => child.id))
        : undefined;
      const summaries: SubOrganizationSummary[] = [];
      for (const child of visibleChildren) {
        const row = snapshotRow(await this.#source.readSnapshot(child.id), child.id, request.orgId);
        const statusRecord = batchRecords
          ? batchRecords.get(child.id) ?? { kind: "absent" as const }
          : await this.#statusRecords?.read(child.id);
        summaries.push(Object.freeze({
          orgId: child.id,
          registryName: child.name,
          status: row === undefined && statusRecord?.kind !== "status" ? unavailable("status", "not_imported") : deriveOrganizationStatus(row ?? {},statusRecord),
        }));
      }
      summaries.sort((a, b) => a.registryName.localeCompare(b.registryName) || a.orgId.localeCompare(b.orgId));
      return { kind: "found", subOrganizations: Object.freeze(summaries) };
    } catch {
      return { kind: "unavailable" };
    }
  }

  /**
   * Staff and admin company list. The active context is re-resolved, then the
   * caller's current grants decide which companies appear: coverage comes from
   * the same expansion that builds workspace contexts, never from the snapshot.
   */
  async listOrganizations(request: OrganizationDirectoryRequest): Promise<OrganizationDirectoryResult> {
    try {
      if (!ORGANIZATION_DIRECTORY_ROLES.has(request.role)) return { kind: "not_found" };
      const filters = request.filters ?? {};
      const page = request.page ?? 1;
      if (!validDirectoryFilters(filters) || !Number.isSafeInteger(page) || page < 1) return { kind: "invalid" };
      const identity = { kind: "principal" as const, principalId: request.principalId };
      const resolution = await resolveActiveContext(identity, { orgId: request.orgId, role: request.role }, this.#store);
      if (resolution.kind !== "authorized" || resolution.context.orgId !== request.orgId
        || resolution.context.role !== request.role) return { kind: "not_found" };
      const [contexts, organizations] = await Promise.all([
        listEffectiveContexts(identity, this.#store), this.#store.listOrganizations(),
      ]);
      const within = new Set(descendantOrgIdsIncludingSelf(organizations, request.orgId));
      const covered = new Set(contexts
        .filter((context) => context.role === request.role && within.has(context.orgId)
          && !this.#operators.has(context.orgId))
        .map((context) => context.orgId));
      const shown: Organization[] = [];
      for (const org of organizations) {
        if (!covered.has(org.id)) continue;
        if (companyParentOf(organizations, org.id, this.#operators) !== null)
          continue;
        shown.push(org);
      }
      const batchRecords = shown.length > 0 && this.#statusRecords?.readMany
        ? await this.#statusRecords.readMany(shown.map((org) => org.id))
        : undefined;
      const approvedBatch=shown.length>0&&this.#approvedToHire?await this.#approvedToHire.readMany(shown.map(org=>org.id)):undefined;
      const entries: OrganizationDirectoryEntry[] = [];
      for (const org of shown) {
        // As in legacy (`filterParent`), the list holds top-level companies; sub-organizations open from their parent.
        const row = snapshotRow(await this.#source.readSnapshot(org.id), org.id, null);
        const statusRecord = batchRecords
          ? batchRecords.get(org.id) ?? { kind: "absent" as const }
          : await this.#statusRecords?.read(org.id);
        const children = organizations.filter((child) => child.parentOrgId === org.id && covered.has(child.id)).length;
        const approvedRecord=approvedBatch?.get(org.id)??{kind:"absent" as const};
        const entry = directoryEntry(org, row, children, statusRecord,approvedRecord);
        if (matchesDirectoryFilters(entry, filters)) entries.push(entry);
      }
      entries.sort((a, b) => a.registryName.localeCompare(b.registryName) || a.orgId.localeCompare(b.orgId));
      const start = (page - 1) * ORGANIZATION_DIRECTORY_PAGE_SIZE;
      return { kind: "found", directory: Object.freeze({
        version: ORGANIZATION_DIRECTORY_VERSION,
        entries: Object.freeze(entries.slice(start, start + ORGANIZATION_DIRECTORY_PAGE_SIZE)),
        page,
        pageSize: ORGANIZATION_DIRECTORY_PAGE_SIZE,
        total: entries.length,
      }) };
    } catch {
      return { kind: "unavailable" };
    }
  }
}
