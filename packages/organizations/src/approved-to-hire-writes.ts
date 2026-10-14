import {createHash} from "node:crypto";
import {createSafeWrite,type ConfirmRequest,type FieldPolicy,type PreviewRequest,type SafeWriteClock,type SafeWriteImplementation,type SafeWriteSecret,type SafeWriteStore} from "@studenthub/safe-write-contract";
import {DEFAULT_OPERATOR_ORG_IDS} from "./organizations.js";
export const ORGANIZATION_APPROVED_TO_HIRE_FIELDS=Object.freeze(["approved_to_hire"] as const);
export const ORGANIZATION_APPROVED_TO_HIRE_POLICY:FieldPolicy=Object.freeze({allowed:ORGANIZATION_APPROVED_TO_HIRE_FIELDS,maxValueLength:5});
export interface OrganizationApprovedToHireGrantRow{readonly org_id:string;readonly role:string;readonly scope:string}
export function organizationApprovedToHireValue(field:string,value:string):boolean{return field==="approved_to_hire"&&(value==="true"||value==="false");}
export function organizationApprovedToHireDecision(rows:readonly OrganizationApprovedToHireGrantRow[],orgId:string,ancestors:readonly string[],operators:readonly string[]=DEFAULT_OPERATOR_ORG_IDS):boolean{return !operators.includes(orgId)&&rows.some(row=>(row.role === "staff" || row.role === "admin")&&(row.org_id===orgId||(row.scope==="subtree"&&ancestors.includes(row.org_id))));}
export function organizationApprovedToHireStateDecision(current:string|null,expected:string|null):boolean{return current===expected;}
function ref(domain:string,value:string){return createHash("sha256").update(`studenthub:${domain}:v1\0`).update(value).digest("hex");}
export const organizationApprovedToHireRecordRef=(orgId:string)=>ref("organization-approved-to-hire-record",orgId);
export const organizationApprovedToHirePrincipalRef=(id:string)=>ref("organization-approved-to-hire-principal",id);
export interface OrganizationApprovedToHireBuildInput{readonly store:SafeWriteStore;readonly secret:SafeWriteSecret;readonly policy?:FieldPolicy;readonly clock?:SafeWriteClock;readonly tokenLifetimeMs?:number;readonly check?:(field:string,value:string)=>boolean}
export function buildOrganizationApprovedToHireWrite(input:OrganizationApprovedToHireBuildInput):SafeWriteImplementation{const implementation=createSafeWrite({store:input.store,secret:input.secret,policy:input.policy??ORGANIZATION_APPROVED_TO_HIRE_POLICY,...(input.clock?{clock:input.clock}:{}),...(input.tokenLifetimeMs===undefined?{}:{tokenLifetimeMs:input.tokenLifetimeMs})});const valid=(request:PreviewRequest|ConfirmRequest)=>typeof request.change?.field==="string"&&typeof request.change?.value==="string"&&(input.check??organizationApprovedToHireValue)(request.change.field,request.change.value);return{preview:async request=>valid(request)?implementation.preview(request):{ok:false,reason:"invalid_value"},confirm:async request=>valid(request)?implementation.confirm(request):{ok:false,reason:"invalid_value"}};}
