import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { ActionToken, Receipt, RejectionReason, SafeWriteClock, SafeWriteSecret, SafeWriteStore } from "@studenthub/safe-write-contract";
import { buildOrganizationProfileWrite, ORGANIZATION_PROFILE_FIELDS, type OrganizationProfileField } from "@studenthub/organizations";
import { organizationProfileRecordRef, safeWritePrincipalRef } from "@studenthub/db";

export interface OrganizationProfileStore {
  forPrincipal(principalId: string, orgId: string): SafeWriteStore;
  readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null>;
}
type Result = { readonly status: 200; readonly body: unknown }
  | { readonly status: 400 | 401 | 404 | 409 | 503; readonly body: { readonly error: string } };
export interface OrganizationProfileWrite {
  preview(sessionId: string | undefined, body: unknown): Promise<Result>;
  confirm(sessionId: string | undefined, body: unknown): Promise<Result>;
  receipt(sessionId: string | undefined, ref: string): Promise<Result>;
}

const TOKEN_KEYS = ["changeSetDigest","expectedBeforeDigest","expiresAt","issuedAt","mac","principalRef","tokenId"];
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual=Object.keys(value).sort(), wanted=[...keys].sort();
  return actual.length===wanted.length && actual.every((key,index)=>key===wanted[index]);
}
function refusal(reason: RejectionReason): Result {
  return { status: reason === "not_own_record" ? 404 : reason === "receipt_failed" ? 503
    : reason.startsWith("token_") || reason === "state_changed" ? 409 : 400, body: { error: reason } };
}
function parse(body: unknown, confirming: boolean): { orgId:string; field:OrganizationProfileField; value:string; token?:ActionToken } | undefined {
  if (!exact(body, confirming ? ["orgId","field","value","token"] : ["orgId","field","value"])) return;
  if (typeof body.orgId!=="string" || body.orgId.length<1 || body.orgId.length>4096
    || typeof body.field!=="string" || !ORGANIZATION_PROFILE_FIELDS.includes(body.field as OrganizationProfileField)
    || typeof body.value!=="string") return;
  if (confirming && (!exact(body.token,TOKEN_KEYS) || !TOKEN_KEYS.every(k=>typeof (body.token as Record<string,unknown>)[k]==="string"))) return;
  return { orgId:body.orgId, field:body.field as OrganizationProfileField, value:body.value,
    ...(confirming ? {token:body.token as unknown as ActionToken}: {}) };
}

export function createOrganizationProfileWrite(ports: { sessions:Pick<SessionStore,"get">; store:OrganizationProfileStore;
  secret:SafeWriteSecret; clock?:SafeWriteClock }): OrganizationProfileWrite {
  return {
    async preview(sessionId, body) {
      const person=(sessionId ? await ports.sessions.get(sessionId):undefined)?.personId;
      if (!person) return {status:401,body:{error:"unauthorized"}};
      const input=parse(body,false); if (!input) return {status:400,body:{error:"invalid_request"}};
      const writer=buildOrganizationProfileWrite({store:ports.store.forPrincipal(person,input.orgId),secret:ports.secret,...(ports.clock?{clock:ports.clock}:{})});
      const result=await writer.preview({principalRef:safeWritePrincipalRef(person),change:{personRef:organizationProfileRecordRef(input.orgId),field:input.field,value:input.value}});
      return result.ok ? {status:200,body:{changes:result.changes,token:result.token}} : refusal(result.reason);
    },
    async confirm(sessionId, body) {
      const person=(sessionId ? await ports.sessions.get(sessionId):undefined)?.personId;
      if (!person) return {status:401,body:{error:"unauthorized"}};
      const input=parse(body,true); if (!input?.token) return {status:400,body:{error:"invalid_request"}};
      const writer=buildOrganizationProfileWrite({store:ports.store.forPrincipal(person,input.orgId),secret:ports.secret,...(ports.clock?{clock:ports.clock}:{})});
      const result=await writer.confirm({principalRef:safeWritePrincipalRef(person),token:input.token,
        change:{personRef:organizationProfileRecordRef(input.orgId),field:input.field,value:input.value}});
      return result.ok ? {status:200,body:{receipt:result.receipt}} : refusal(result.reason);
    },
    async receipt(sessionId, ref) {
      const person=(sessionId ? await ports.sessions.get(sessionId):undefined)?.personId;
      if (!person) return {status:401,body:{error:"unauthorized"}};
      const receipt=await ports.store.readReceipt(person,ref);
      return receipt ? {status:200,body:{receipt}} : {status:404,body:{error:"receipt_not_found"}};
    },
  };
}

const RECEIPT=/^\/organizations\/profile\/receipts\/([0-9a-f]{64})$/;
const BODY_LIMIT=12_288;
function sessionCookie(header:string|undefined):string|undefined{for(const item of header?.split(";")??[]){const[key,...value]=item.trim().split("=");const candidate=value.join("=");if(key==="__Host-studenthub_session"&&/^[A-Za-z0-9_-]{43}$/.test(candidate))return candidate;}return undefined;}
export async function handleOrganizationProfile(request:IncomingMessage,response:ServerResponse,service:OrganizationProfileWrite|undefined,origin:string|undefined):Promise<boolean>{
  const path=new URL(request.url??"/","http://gateway.invalid").pathname;
  const receipt=RECEIPT.exec(path)?.[1];
  if (path!=="/organizations/profile/preview"&&path!=="/organizations/profile/confirm"&&receipt===undefined)return false;
  const send=(result:Result)=>{response.writeHead(result.status,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});response.end(JSON.stringify(result.body));};
  try{
    if(!service||!origin){send({status:503,body:{error:"safe_write_unavailable"}});return true;}
    const session=sessionCookie(request.headers.cookie);
    if(receipt!==undefined){if(request.method!=="GET")send({status:404,body:{error:"not_found"}});else send(await service.receipt(session,receipt));return true;}
    if(request.method!=="POST"){send({status:404,body:{error:"not_found"}});return true;}
    if(request.headers.origin!==origin||request.headers["sec-fetch-site"]==="cross-site"){request.resume();send({status:404,body:{error:"not_found"}});return true;}
    if(request.headers["content-type"]!=="application/json"){request.resume();send({status:400,body:{error:"invalid_request"}});return true;}
    const chunks:Buffer[]=[];let size=0;for await(const chunk of request.iterator({destroyOnReturn:false})){const b=Buffer.from(chunk);size+=b.length;if(size>BODY_LIMIT){request.resume();send({status:400,body:{error:"invalid_request"}});return true;}chunks.push(b);}
    let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{send({status:400,body:{error:"invalid_request"}});return true;}
    send(path.endsWith("/preview")?await service.preview(session,body):await service.confirm(session,body));
  }catch{if(!response.headersSent)send({status:503,body:{error:"safe_write_unavailable"}});else response.destroy();}
  return true;
}

declare module "./web-ui.js" { interface BrowserLoginApplication { readonly organizationProfile?: OrganizationProfileWrite } }
