import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isGrantScope, isRole, type GrantScope, type Role } from "@studenthub/contracts";

export type AccessAction = "grant" | "revoke";
export interface AccessGrantChange { readonly action: AccessAction; readonly targetPrincipalId: string; readonly organizationId: string; readonly role: Role; readonly scope: GrantScope; readonly reason: string }
export type AccessWriteReason = "invalid_request"|"not_found"|"self_escalation"|"not_allowed"|"already_held"|"grant_not_held"|"last_operator_admin"|"operator_admin_conflict"|"token_not_issued"|"token_expired"|"token_principal_mismatch"|"token_change_mismatch"|"token_already_used";
export interface AccessPreviewToken { readonly tokenId:string; readonly callerPrincipalId:string; readonly change:string; readonly issuedAt:string; readonly expiresAt:string; readonly mac:string }
export type AccessWriteResult<T> = {readonly ok:true;readonly value:T}|{readonly ok:false;readonly reason:AccessWriteReason};
export interface AccessGrantWriteStore {
  preview(callerPrincipalId:string, change:AccessGrantChange):Promise<AccessWriteReason|null>;
  commit(callerPrincipalId:string, change:AccessGrantChange, tokenId:string):Promise<AccessWriteReason|null>;
}
export interface AccessGrantWrites { preview(callerPrincipalId:string,change:unknown):Promise<AccessWriteResult<{change:AccessGrantChange;token:AccessPreviewToken}>>; confirm(callerPrincipalId:string,change:unknown,token:AccessPreviewToken):Promise<AccessWriteResult<{change:AccessGrantChange}>> }

function parse(raw:unknown):AccessGrantChange|null {
  if(!raw||typeof raw!=="object")return null;
  const v=raw as Record<string,unknown>;
  if((v.action!=="grant"&&v.action!=="revoke")||typeof v.targetPrincipalId!=="string"||!v.targetPrincipalId||typeof v.organizationId!=="string"||!v.organizationId||!isRole(v.role)||!isGrantScope(v.scope)||typeof v.reason!=="string"||v.reason!==v.reason.trim()||[...v.reason].length<3||[...v.reason].length>500)return null;
  return Object.freeze({action:v.action,targetPrincipalId:v.targetPrincipalId,organizationId:v.organizationId,role:v.role,scope:v.scope,reason:v.reason});
}
const canonical=(c:AccessGrantChange)=>JSON.stringify([c.action,c.targetPrincipalId,c.organizationId,c.role,c.scope,c.reason]);
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)}

export function createAccessGrantWrites(input:{store:AccessGrantWriteStore;secret:string|Buffer;clock?:()=>Date;tokenLifetimeMs?:number}):AccessGrantWrites {
  const secret=Buffer.isBuffer(input.secret)?input.secret:Buffer.from(input.secret);
  if(secret.length<32)throw new Error("access write secret must be at least 32 bytes");
  const now=input.clock??(()=>new Date()), lifetime=input.tokenLifetimeMs??15*60_000;
  const sign=(t:Omit<AccessPreviewToken,"mac">)=>createHmac("sha256",secret).update("studenthub.access-grant-preview.v1\n").update(JSON.stringify(t)).digest("base64url");
  return {
    async preview(caller,raw){const change=parse(raw);if(!change)return{ok:false,reason:"invalid_request"};const refusal=await input.store.preview(caller,change);if(refusal)return{ok:false,reason:refusal};const issued=now();const unsigned={tokenId:randomBytes(16).toString("hex"),callerPrincipalId:caller,change:canonical(change),issuedAt:issued.toISOString(),expiresAt:new Date(issued.getTime()+lifetime).toISOString()};return{ok:true,value:{change,token:{...unsigned,mac:sign(unsigned)}}}},
    async confirm(caller,raw,token){const change=parse(raw);if(!change)return{ok:false,reason:"invalid_request"};if(!token||typeof token!=="object")return{ok:false,reason:"token_not_issued"};const {mac,...unsigned}=token;let expected:string;try{expected=sign(unsigned)}catch{return{ok:false,reason:"token_not_issued"}}if(typeof mac!=="string"||!equal(mac,expected))return{ok:false,reason:"token_not_issued"};if(token.callerPrincipalId!==caller)return{ok:false,reason:"token_principal_mismatch"};if(token.change!==canonical(change))return{ok:false,reason:"token_change_mismatch"};if(now().getTime()>=Date.parse(token.expiresAt))return{ok:false,reason:"token_expired"};const refusal=await input.store.commit(caller,change,token.tokenId);return refusal?{ok:false,reason:refusal}:{ok:true,value:{change}}}
  };
}
