import { createHash } from "node:crypto";
import { createSafeWrite, type FieldPolicy, type SafeWriteClock, type SafeWriteImplementation,
  type SafeWriteSecret, type SafeWriteStore } from "@studenthub/safe-write-contract";
import { DEFAULT_OPERATOR_ORG_IDS } from "./organizations.js";
import type { OrganizationStatus } from "./types.js";

export const ORGANIZATION_STATUS_FIELDS = Object.freeze(["status"] as const);
export const ORGANIZATION_STATUS_POLICY: FieldPolicy = Object.freeze({ allowed: ORGANIZATION_STATUS_FIELDS, maxValueLength: 12 });
export type OrganizationStatusValue = "active" | "under_review" | "inactive" | "none";
export function organizationStatusEvent(before:string|null,value:string):{from:OrganizationStatus|null;to:OrganizationStatus|null}|null {
  const from=before as OrganizationStatus|null,to=value==="none"?null:value as OrganizationStatus;
  if(from===to)return null;
  return {from,to};
}
export interface OrganizationStatusEventRow { readonly from_status: string | null; readonly to_status: string | null; readonly occurred_at: Date | string }
export interface OrganizationStatusHistoryEntry { readonly from: OrganizationStatus | null; readonly to: OrganizationStatus | null; readonly occurredAt: string }
export const ORGANIZATION_STATUS_HISTORY_LIMIT = 50;
export function organizationStatusHistoryView(rows: readonly OrganizationStatusEventRow[]): OrganizationStatusHistoryEntry[] {
  return rows.map(row => ({ from: row.from_status as OrganizationStatus | null, to: row.to_status as OrganizationStatus | null, occurredAt: new Date(row.occurred_at).toISOString() }))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, ORGANIZATION_STATUS_HISTORY_LIMIT);
}
export interface OrganizationStatusGrantRow { readonly org_id:string; readonly role:string; readonly scope:string }

export function organizationStatusDecision(rows:readonly OrganizationStatusGrantRow[], orgId:string,
  ancestorOrgIds:readonly string[], operatorOrgIds:readonly string[]=DEFAULT_OPERATOR_ORG_IDS):boolean {
  if (operatorOrgIds.includes(orgId)) return false;
  return rows.some(row => (row.role === "staff" || row.role === "admin")
    && (row.org_id === orgId || (row.scope === "subtree" && ancestorOrgIds.includes(row.org_id))));
}
export function organizationStatusStateDecision(current:string|null, expected:string|null):boolean { return current === expected; }
function ref(domain:string,value:string):string { return createHash("sha256").update(`studenthub:${domain}:v1\0`).update(value).digest("hex"); }
export const organizationStatusRecordRef=(orgId:string):string=>ref("organization-status-record",orgId);
export const organizationStatusPrincipalRef=(principalId:string):string=>ref("organization-status-principal",principalId);
export interface OrganizationStatusBuildInput { readonly store:SafeWriteStore; readonly secret:SafeWriteSecret; readonly policy?:FieldPolicy; readonly clock?:SafeWriteClock; readonly tokenLifetimeMs?:number }
export function buildOrganizationStatusWrite(input:OrganizationStatusBuildInput):SafeWriteImplementation {
  const implementation=createSafeWrite({store:input.store,secret:input.secret,policy:input.policy??ORGANIZATION_STATUS_POLICY,
    ...(input.clock?{clock:input.clock}:{}),...(input.tokenLifetimeMs===undefined?{}:{tokenLifetimeMs:input.tokenLifetimeMs})});
  return {preview:implementation.preview,confirm:implementation.confirm};
}
