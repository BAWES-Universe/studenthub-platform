import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { ActionToken, Receipt, SafeWriteClock, SafeWriteSecret, SafeWriteStore } from "@studenthub/safe-write-contract";
import { buildOrganizationProfileWrite, ORGANIZATION_PROFILE_FIELDS, ORGANIZATION_PROFILE_POLICY,
  organizationProfilePrincipalRef, organizationProfileRecordRef, type OrganizationProfileField } from "@studenthub/organizations";

export interface OrganizationProfileStore {
  forPrincipal(principalId: string, orgId: string): SafeWriteStore;
  readReceipt(principalId: string, orgId: string, receiptRef: string): Promise<Receipt | null>;
}
type Result = { readonly status: 200; readonly body: unknown } | { readonly status: 400|401|403|404|409|503; readonly body: { readonly error: string } };
export interface OrganizationProfile { preview(session: string|undefined, body: unknown): Promise<Result>; confirm(session: string|undefined, body: unknown): Promise<Result>; receipt(session: string|undefined, orgId: string, ref: string): Promise<Result> }
const TOKEN_KEYS = ["changeSetDigest","expectedBeforeDigest","expiresAt","issuedAt","mac","principalRef","tokenId"];
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> { return object(value) && Object.keys(value).sort().join() === [...keys].sort().join(); }
function token(value: unknown): ActionToken|undefined { return exact(value,TOKEN_KEYS) && TOKEN_KEYS.every(k=>typeof value[k]==="string") ? value as unknown as ActionToken : undefined; }
function request(body: unknown): {orgId:string;field:OrganizationProfileField;value:string}|undefined {
  if (!exact(body,["orgId","field","value"]) || typeof body.orgId!=="string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(body.orgId)
    || typeof body.field!=="string" || !ORGANIZATION_PROFILE_FIELDS.includes(body.field as OrganizationProfileField)
    || typeof body.value!=="string") return undefined;
  return body as {orgId:string;field:OrganizationProfileField;value:string};
}
function refused(reason:string):Result { return { status: reason==="not_own_record"?404:reason==="receipt_failed"?503:reason.startsWith("token_")||reason==="state_changed"?409:400, body:{error:reason} } as Result; }

export function createOrganizationProfile(ports:{sessions:Pick<SessionStore,"get">;store:OrganizationProfileStore;secret:SafeWriteSecret;clock?:SafeWriteClock}):OrganizationProfile {
  const principal=async(id:string|undefined)=>id?(await ports.sessions.get(id))?.personId:undefined;
  const writer=(person:string,org:string)=>buildOrganizationProfileWrite({store:ports.store.forPrincipal(person,org),secret:ports.secret,policy:ORGANIZATION_PROFILE_POLICY,...(ports.clock?{clock:ports.clock}:{})});
  return {
    async preview(session,body){ const person=await principal(session);if(!person)return {status:401,body:{error:"unauthorized"}};const r=request(body);if(!r)return {status:400,body:{error:"invalid_request"}};
      const out=await writer(person,r.orgId).preview({principalRef:organizationProfilePrincipalRef(person),change:{personRef:organizationProfileRecordRef(r.orgId),field:r.field,value:r.value}});return out.ok?{status:200,body:{changes:out.changes,token:out.token}}:refused(out.reason);},
    async confirm(session,body){ const person=await principal(session);if(!person)return {status:401,body:{error:"unauthorized"}};if(!object(body)||!("token" in body))return {status:400,body:{error:"invalid_request"}};
      const r=request(Object.fromEntries(Object.entries(body).filter(([k])=>k!=="token")));const t=token(body.token);if(!r)return {status:400,body:{error:"invalid_request"}};if(!t)return refused("token_not_issued");
      const out=await writer(person,r.orgId).confirm({principalRef:organizationProfilePrincipalRef(person),token:t,change:{personRef:organizationProfileRecordRef(r.orgId),field:r.field,value:r.value}});return out.ok?{status:200,body:{receipt:out.receipt}}:refused(out.reason);},
    async receipt(session,orgId,ref){const person=await principal(session);if(!person)return {status:401,body:{error:"unauthorized"}};const receipt=await ports.store.readReceipt(person,orgId,ref);return receipt?{status:200,body:{receipt}}:{status:404,body:{error:"receipt_not_found"}};},
  };
}

const PREVIEW="/organization/profile/preview", CONFIRM="/organization/profile/confirm", RECEIPT=/^\/organization\/profile\/([^/]+)\/receipts\/([0-9a-f]{64})$/;
const BODY_LIMIT=4096;
function cookie(header:string|undefined):string|undefined { for(const item of header?.split(";")??[]){const [key,...parts]=item.trim().split("=");const value=parts.join("=");if(key==="__Host-studenthub_session"&&/^[A-Za-z0-9_-]{43}$/.test(value))return value;}return undefined; }
async function json(req:IncomingMessage):Promise<{ok:true;value:unknown}|{ok:false}>{if(Number(req.headers["content-length"])>BODY_LIMIT){req.resume();return {ok:false};}const chunks:Buffer[]=[];let n=0;for await(const c of req.iterator({destroyOnReturn:false})){const bytes=Buffer.from(c);n+=bytes.length;if(n>BODY_LIMIT){req.resume();return {ok:false};}chunks.push(bytes);}try{return {ok:true,value:JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown};}catch{return {ok:false};}}
export async function handleOrganizationProfile(req:IncomingMessage,res:ServerResponse,service:OrganizationProfile|undefined,origin:string|undefined):Promise<boolean>{
  const path=new URL(req.url??"/","http://invalid").pathname, match=RECEIPT.exec(path);if(path!==PREVIEW&&path!==CONFIRM&&!match)return false;
  const send=(r:Result)=>{res.writeHead(r.status,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});res.end(JSON.stringify(r.body));};
  try {if(!service||!origin){send({status:503,body:{error:"safe_write_unavailable"}});return true;}const session=cookie(req.headers.cookie);
    if(match){if(req.method!=="GET"){send({status:404,body:{error:"not_found"}});return true;}send(await service.receipt(session,decodeURIComponent(match[1]!),match[2]!));return true;}
    if(req.method!=="POST"){send({status:404,body:{error:"not_found"}});return true;}if(req.headers.origin!==origin||req.headers["sec-fetch-site"]==="cross-site"){req.resume();send({status:403,body:{error:"origin_rejected"}});return true;}
    if(req.headers["content-type"]!=="application/json"){req.resume();send({status:400,body:{error:"invalid_request"}});return true;}const body=await json(req);if(!body.ok){send({status:400,body:{error:"invalid_request"}});return true;}send(path===PREVIEW?await service.preview(session,body.value):await service.confirm(session,body.value));
  } catch {if(!res.headersSent)send({status:503,body:{error:"safe_write_unavailable"}});else res.destroy();}return true;
}
