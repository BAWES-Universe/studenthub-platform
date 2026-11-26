import { GRANT_SCOPES, ROLES, type GrantScope, type Role } from "@studenthub/contracts";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { mayPauseAccount } from "./account-pause.js";
import { mayManageBlocks } from "./abuse.js";
import { mayReadContacts, mayWriteContacts } from "./company-contacts.js";
import { mayReviewRegistrations } from "./company-registration.js";
import { catalogueAllows, grantCatalogue, mayOpenAccessAdmin, type HeldGrant } from "./grant-catalogue.js";
import { reportAccess } from "./report-access.js";
import { mayManageStoreAccess } from "./store-access.js";

/**
 * Access lane G-01: the grant catalogue as one read-only view, for the
 * operator's Access pages.
 *
 * Nothing here is typed by hand: every "who may give it" and "what it opens"
 * cell is the answer of the same rule the platform enforces, asked for one
 * synthetic grant. A change to any of those rules changes this view, and the
 * pinned digest test then asks for a new GRANT_CATALOGUE_VERSION, so the
 * catalogue's version moves whenever what a grant means moves.
 */
export const GRANT_CATALOGUE_VERSION = 1;

export type CataloguePlace = "operator" | "company";

export const CATALOGUE_CAPABILITIES = [
  "access_pages",
  "review_registrations",
  "pause_and_view_as",
  "pause_operator_roles",
  "manage_ip_blocks",
  "operations_reports",
  "finance_reports",
  "give_operator_roles",
  "give_company_roles",
  "give_company_roles_below",
  "read_company_contacts",
  "change_company_contacts",
  "manage_store_managers",
] as const;
export type CatalogueCapability = (typeof CATALOGUE_CAPABILITIES)[number];

export type CatalogueGiver = "operator_admins" | "operator_staff_and_admins" | "not_on_access_pages";

export interface CatalogueRow {
  readonly place: CataloguePlace;
  readonly role: Role;
  readonly scope: GrantScope;
  readonly givenBy: CatalogueGiver;
  readonly opens: readonly CatalogueCapability[];
}

export interface GrantCatalogueView {
  readonly version: number;
  readonly roles: readonly Role[];
  readonly scopes: readonly GrantScope[];
  readonly rows: readonly CatalogueRow[];
}

const CALLER = "catalogue-caller";
const TARGET = "catalogue-target";
const COMPANY = "catalogue-company";
const CHILD = "catalogue-child-company";

/**
 * Where the company-level questions are asked: a real company (with its
 * ancestors), or, for a grant on the operator, a company directly below it.
 */
export interface CapabilityPlace {
  readonly companyId: string;
  readonly companyAncestors: readonly string[];
}

/** What a set of grants opens, asked of the same rules the platform enforces. Pure. */
export function capabilitiesAt(grants: readonly HeldGrant[], place: CapabilityPlace, operatorOrgIds: readonly string[]): CatalogueCapability[] {
  const operator = operatorOrgIds[0];
  if (operator === undefined) throw new RangeError("capabilities need an operator organization");
  const { companyId: company, companyAncestors } = place;
  const child = { id: CHILD, ancestors: [...companyAncestors, company] };
  const reports = reportAccess(grants, operatorOrgIds);
  const checks: readonly [CatalogueCapability, boolean][] = [
    ["access_pages", mayOpenAccessAdmin(grants, operatorOrgIds)],
    ["review_registrations", mayReviewRegistrations(grants, operatorOrgIds)],
    ["pause_and_view_as", mayPauseAccount(CALLER, TARGET, grants, [], operatorOrgIds)],
    ["pause_operator_roles", mayPauseAccount(CALLER, TARGET, grants, [{ orgId: operator, role: "staff", scope: "subtree" }], operatorOrgIds)],
    ["manage_ip_blocks", mayManageBlocks(grants, operatorOrgIds)],
    ["operations_reports", reports.operations],
    ["finance_reports", reports.finance],
    ["give_operator_roles", grantCatalogue({ callerGrants: grants, targetOrgId: operator, targetAncestors: [], operatorOrgIds }).length > 0],
    ["give_company_roles", grantCatalogue({ callerGrants: grants, targetOrgId: company, targetAncestors: companyAncestors, operatorOrgIds }).length > 0],
    ["give_company_roles_below", grantCatalogue({ callerGrants: grants, targetOrgId: child.id, targetAncestors: child.ancestors, operatorOrgIds }).length > 0],
    ["read_company_contacts", mayReadContacts(grants, company, companyAncestors)],
    ["change_company_contacts", mayWriteContacts(grants, company, companyAncestors)],
    ["manage_store_managers", mayManageStoreAccess(grants, company, companyAncestors)],
  ];
  return checks.filter(([, allowed]) => allowed).map(([capability]) => capability);
}

function opensFor(grant: HeldGrant, operator: string, operatorOrgIds: readonly string[]): CatalogueCapability[] {
  const place = grant.orgId === operator
    ? { companyId: COMPANY, companyAncestors: [operator] }
    : { companyId: grant.orgId, companyAncestors: [] };
  return capabilitiesAt([grant], place, operatorOrgIds);
}

function givenBy(place: CataloguePlace, role: Role, scope: GrantScope, operator: string, operatorOrgIds: readonly string[]): CatalogueGiver {
  const target = place === "operator" ? { id: operator, ancestors: [] } : { id: COMPANY, ancestors: [operator] };
  const may = (giver: Role) => catalogueAllows(grantCatalogue({
    callerGrants: [{ orgId: operator, role: giver, scope: "subtree" }], targetOrgId: target.id, targetAncestors: target.ancestors, operatorOrgIds,
  }), role, scope);
  if (may("staff")) return "operator_staff_and_admins";
  if (may("admin")) return "operator_admins";
  return "not_on_access_pages";
}

/** The whole catalogue, every role at every scope on the operator and on a company. Pure. */
export function grantCatalogueView(operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS): GrantCatalogueView {
  const operator = operatorOrgIds[0];
  if (operator === undefined) throw new RangeError("grant catalogue needs an operator organization");
  const rows: CatalogueRow[] = [];
  for (const place of ["operator", "company"] as const) {
    for (const role of ROLES) {
      for (const scope of GRANT_SCOPES) {
        const grant = { orgId: place === "operator" ? operator : COMPANY, role, scope };
        rows.push(Object.freeze({ place, role, scope, givenBy: givenBy(place, role, scope, operator, operatorOrgIds), opens: Object.freeze(opensFor(grant, operator, operatorOrgIds)) }));
      }
    }
  }
  return Object.freeze({ version: GRANT_CATALOGUE_VERSION, roles: ROLES, scopes: GRANT_SCOPES, rows: Object.freeze(rows) });
}

/**
 * Access lane G-02: what one grant change does to a person, for the review
 * page before it is confirmed. The person's other grants count, so a role
 * that adds nothing they cannot already do shows no gain.
 */
export interface GrantChangeEffect {
  readonly gained: readonly CatalogueCapability[];
  readonly lost: readonly CatalogueCapability[];
}

export function grantChangeEffect(input: {
  /** Every grant the person holds now. */
  readonly held: readonly HeldGrant[];
  /** The change: the role on the organization ends at `after` (null: taken away). */
  readonly change: { readonly orgId: string; readonly role: string; readonly after: string | null };
  readonly orgAncestors: readonly string[];
  readonly operatorOrgIds?: readonly string[];
}): GrantChangeEffect {
  const operatorOrgIds = input.operatorOrgIds ?? DEFAULT_OPERATOR_ORG_IDS;
  const { change } = input;
  const place = operatorOrgIds.includes(change.orgId)
    ? { companyId: COMPANY, companyAncestors: [change.orgId] }
    : { companyId: change.orgId, companyAncestors: input.orgAncestors };
  const others = input.held.filter((grant) => !(grant.orgId === change.orgId && grant.role === change.role));
  const after = change.after === null ? others : [...others, { orgId: change.orgId, role: change.role, scope: change.after }];
  const before = new Set(capabilitiesAt(input.held, place, operatorOrgIds));
  const now = new Set(capabilitiesAt(after, place, operatorOrgIds));
  return Object.freeze({
    gained: Object.freeze(CATALOGUE_CAPABILITIES.filter((capability) => now.has(capability) && !before.has(capability))),
    lost: Object.freeze(CATALOGUE_CAPABILITIES.filter((capability) => before.has(capability) && !now.has(capability))),
  });
}
