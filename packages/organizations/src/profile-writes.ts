import { createHash } from "node:crypto";
import {
  createSafeWrite, type ActionToken, type FieldPolicy, type Receipt,
  type SafeWriteClock, type SafeWriteImplementation, type SafeWriteSecret, type SafeWriteStore,
} from "@studenthub/safe-write-contract";

export const ORGANIZATION_PROFILE_FIELDS = ["name_ar", "name_en", "description_ar", "description_en", "website"] as const;
export type OrganizationProfileField = typeof ORGANIZATION_PROFILE_FIELDS[number];
export const ORGANIZATION_PROFILE_POLICY: FieldPolicy = Object.freeze({allowed: ORGANIZATION_PROFILE_FIELDS, maxValueLength: 4000});

const ref = (domain:string, value:string):string => createHash("sha256").update(`studenthub:${domain}:v1\0${value}`).digest("hex");
export const organizationProfileRef = (orgId:string):string => ref("organization-profile-ref", orgId);
export const organizationProfilePrincipalRef = (principalId:string):string => ref("principal-audit-ref", principalId);

export interface OrganizationProfileStore {
  forOwner(principalId:string, orgId:string): SafeWriteStore;
  readReceipt(principalId:string, orgId:string, receiptRef:string): Promise<Receipt|null>;
}
export function buildOrganizationProfileSafeWrite(input:{store:SafeWriteStore;secret:SafeWriteSecret;clock?:SafeWriteClock}):SafeWriteImplementation {
  return createSafeWrite({store:input.store,secret:input.secret,policy:ORGANIZATION_PROFILE_POLICY,...(input.clock?{clock:input.clock}:{})});
}
export type ProfileWriteResult = {status:200;body:unknown}|{status:400|404|409|503;body:{error:string}};
const exact=(v:unknown, keys:string[]):v is Record<string,unknown> => !!v && typeof v==="object" && !Array.isArray(v) && Object.keys(v).sort().join()===keys.slice().sort().join();
const tokenKeys=["changeSetDigest","expectedBeforeDigest","expiresAt","issuedAt","mac","principalRef","tokenId"];
const parseToken=(v:unknown):ActionToken|undefined => exact(v,tokenKeys)&&tokenKeys.every(k=>typeof v[k]==="string") ? v as unknown as ActionToken:undefined;
function valid(field:unknown,value:unknown): field is OrganizationProfileField {
  if(typeof field!=="string" || !ORGANIZATION_PROFILE_FIELDS.includes(field as OrganizationProfileField) || typeof value!=="string")return false;
  if(!value.length || value!==value.trim() || value.length>(field.startsWith("description")?4000:field==="website"?2048:200))return false;
  if(field==="website") { try { const u=new URL(value); return u.protocol==="https:" && !u.username&&!u.password&&!u.hash; } catch{return false;} }
  return true;
}
const refusal=(reason:string):ProfileWriteResult => ({status:reason==="not_own_record"?404:reason==="receipt_failed"?503:reason.startsWith("token_")||reason==="state_changed"?409:400,body:{error:reason==="not_own_record"?"not_found":reason}});
export function createOrganizationProfileWrites(ports:{store:OrganizationProfileStore;secret:SafeWriteSecret;clock?:SafeWriteClock}) {
  buildOrganizationProfileSafeWrite({store:{readField:()=>null,ownedRecord:()=>null,commit:()=>({ok:false,reason:"not_own_record"})},secret:ports.secret});
  const writer=(p:string,o:string)=>buildOrganizationProfileSafeWrite({store:ports.store.forOwner(p,o),secret:ports.secret,...(ports.clock?{clock:ports.clock}:{})});
  return {
    async preview(principalId:string,orgId:string,body:unknown):Promise<ProfileWriteResult>{
      if(!exact(body,["field","value"])||!valid(body.field,body.value))return refusal("invalid_value");
      const result=await writer(principalId,orgId).preview({principalRef:organizationProfilePrincipalRef(principalId),change:{personRef:organizationProfileRef(orgId),field:body.field,value:body.value as string}});
      // Mutation seam: a preview must never spend its freshly issued token.
      const bypassPreview = false;
      if (result.ok && bypassPreview && (body as Record<string,unknown>).field === "website") await writer(principalId,orgId).confirm({principalRef:organizationProfilePrincipalRef(principalId),token:result.token,change:{personRef:organizationProfileRef(orgId),field:(body as Record<string,unknown>).field as string,value:(body as Record<string,unknown>).value as string}});
      return result.ok?{status:200,body:{changes:result.changes,token:result.token}}:refusal(result.reason);
    },
    async confirm(principalId:string,orgId:string,body:unknown):Promise<ProfileWriteResult>{
      if(!exact(body,["field","value","token"])||!valid(body.field,body.value))return refusal("invalid_value");
      const action=parseToken(body.token);if(!action)return refusal("token_not_issued");
      const result=await writer(principalId,orgId).confirm({principalRef:organizationProfilePrincipalRef(principalId),token:action,change:{personRef:organizationProfileRef(orgId),field:body.field,value:body.value as string}});
      return result.ok?{status:200,body:{receipt:result.receipt}}:refusal(result.reason);
    },
    async receipt(principalId:string,orgId:string,receiptRef:string):Promise<ProfileWriteResult>{
      const receipt=await ports.store.readReceipt(principalId,orgId,receiptRef);
      return receipt?{status:200,body:{receipt}}:{status:404,body:{error:"not_found"}};
    }
  };
}
