import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { createSafeWrite, type ActionToken, type Receipt, type SafeWriteSecret, type SafeWriteStore } from "@studenthub/safe-write-contract";
import { isSelfEditField, parseSelfEditValue, SELF_EDIT_FIELDS, SELF_EDIT_LIMITS, type SelfEditField } from "@studenthub/profile";
import { personRecordRef, safeWritePrincipalRef } from "@studenthub/db";

const TOKEN_KEYS=["changeSetDigest","expectedBeforeDigest","expiresAt","issuedAt","mac","principalRef","tokenId"] as const;
const LIMIT=8192;
export interface ProfileEditStore { forPrincipal(id:string):SafeWriteStore; readReceipt(id:string,ref:string):Promise<Receipt|null>; }
export interface ProfileEditService { preview(session:string|undefined,body:unknown):Promise<any>; confirm(session:string|undefined,body:unknown):Promise<any>; }
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
export function createProfileEdit(ports:{sessions:Pick<SessionStore,"get">;store:ProfileEditStore;secret:SafeWriteSecret}):ProfileEditService{
  const principal=async(s:string|undefined)=>s?(await ports.sessions.get(s))?.personId:undefined;
  const result=(reason:string)=>({status:reason==="not_own_record"?403:reason==="receipt_failed"?503:reason.startsWith("token_")||reason==="state_changed"?409:400,body:{error:reason}});
  const writer=(id:string,field:SelfEditField)=>createSafeWrite({store:ports.store.forPrincipal(id),secret:ports.secret,policy:{allowed:[field],maxValueLength:SELF_EDIT_LIMITS[field]}});
  return{
    async preview(session,body){const id=await principal(session);if(!id)return{status:401,body:{error:"unauthorized"}};if(!exact(body,["field","value"])||!isSelfEditField(body.field))return{status:400,body:{error:"invalid_request"}};let value:string;try{value=parseSelfEditValue(body.field,body.value)}catch{return result("invalid_value")}const r=await writer(id,body.field).preview({principalRef:safeWritePrincipalRef(id),change:{personRef:personRecordRef(id),field:body.field,value}});return r.ok?{status:200,body:{changes:r.changes,token:r.token}}:result(r.reason)},
    async confirm(session,body){const id=await principal(session);if(!id)return{status:401,body:{error:"unauthorized"}};if(!exact(body,["field","value","token"])||!isSelfEditField(body.field)||!exact(body.token,[...TOKEN_KEYS]))return{status:400,body:{error:"invalid_request"}};const supplied=body.token as Record<string,unknown>;if(!TOKEN_KEYS.every(k=>typeof supplied[k]==="string"))return{status:400,body:{error:"invalid_request"}};let value:string;try{value=parseSelfEditValue(body.field,body.value)}catch{return result("invalid_value")}const r=await writer(id,body.field).confirm({principalRef:safeWritePrincipalRef(id),change:{personRef:personRecordRef(id),field:body.field,value},token:supplied as unknown as ActionToken});return r.ok?{status:200,body:{receipt:r.receipt}}:result(r.reason)}
  };
}
function cookie(h:string|undefined){return h?.split(";").map(x=>x.trim()).find(x=>x.startsWith("__Host-studenthub_session="))?.split("=")[1];}
async function form(req:IncomingMessage){const chunks:Buffer[]=[];let n=0;for await(const c of req){const b=Buffer.from(c);n+=b.length;if(n>LIMIT)return;chunks.push(b)}return new URLSearchParams(Buffer.concat(chunks).toString())}
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export async function handleProfileEditPage(req:IncomingMessage,res:ServerResponse,service:ProfileEditService|undefined,origin:string|undefined,write:(s:number,t:string,b:string)=>void){
  const m=/^\/profile\/edit\/(display_name|arabic_name|objective|intro|preferred_time)\/(preview|confirm)$/.exec(new URL(req.url??"/","http://x").pathname);if(!m)return false;
  if(req.method!=="POST"||!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")){write(404,"Profile edit","");return true}if(!service||!origin){write(503,"Profile edit","<main><h1>Your profile wasn’t changed.</h1></main>");return true}if(req.headers.origin!==origin||req.headers["sec-fetch-site"]==="cross-site"){req.resume();write(403,"Profile edit","");return true}
  const p=await form(req),field=m[1] as SelfEditField,action=m[2];if(!p){write(400,"Profile edit","");return true}const session=cookie(req.headers.cookie);
  if(action==="preview"){if([...p.keys()].join()!=="value"){write(400,"Profile edit","");return true}const value=p.get("value")!;const r=await service.preview(session,{field,value});if(r.status!==200){write(r.status,"Profile edit","<main><h1>Your profile wasn’t changed.</h1></main>");return true}const hidden=TOKEN_KEYS.map(k=>`<input type="hidden" name="token.${k}" value="${esc(r.body.token[k])}">`).join("");write(200,"Review profile change",`<main id="main"><h1>Review change</h1><p>${esc(field.replaceAll("_"," "))}: <strong>${esc(value)}</strong></p><form method="post" action="/profile/edit/${field}/confirm"><input type="hidden" name="value" value="${esc(value)}">${hidden}<button class="button primary">Confirm change</button></form></main>`);return true}
  const names=["value",...TOKEN_KEYS.map(k=>`token.${k}`)];if([...p.keys()].sort().join()!==names.sort().join()){write(400,"Profile edit","");return true}const token=Object.fromEntries(TOKEN_KEYS.map(k=>[k,p.get(`token.${k}`)]));const r=await service.confirm(session,{field,value:p.get("value"),token});if(r.status!==200){write(r.status,"Profile edit","<main><h1>Your profile wasn’t changed.</h1></main>");return true}res.writeHead(303,{location:"/profile","cache-control":"no-store"});res.end();return true;
}
export { SELF_EDIT_FIELDS };
