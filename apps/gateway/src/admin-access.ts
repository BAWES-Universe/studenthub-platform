import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthzStore } from "@studenthub/contracts";
import type { SessionStore } from "@studenthub/login-contract";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import type { AccessGrantView, AccessPerson, OwnAccessGrantView } from "@studenthub/db";
import { createAccessGrantWrites, type AccessGrantWrites, type AccessPreviewToken } from "../../../packages/access/src/grant-writes.js";
import type { PostgresAccessStore } from "@studenthub/db";
import { renderAdminAccess, renderAdminAccessPerson, writeHtml } from "./web-ui.js";

export interface AdminAccessResult {readonly status:200|400|404|409;readonly body:unknown}
export interface AdminAccess {
  authorized(session:string|undefined):Promise<boolean>;
  search(session:string|undefined,query:string):Promise<AdminAccessResult>;
  person(session:string|undefined,id:string):Promise<AdminAccessResult>;
  preview(session:string|undefined,change:unknown):Promise<AdminAccessResult>;
  confirm(session:string|undefined,change:unknown,token:AccessPreviewToken):Promise<AdminAccessResult>;
  own(session:string|undefined):Promise<readonly OwnAccessGrantView[]|null>;
}
export function createAdminAccess(input:{sessions:Pick<SessionStore,"get">;authz:Pick<AuthzStore,"listGrantsForPrincipal">;store:PostgresAccessStore;secret?:Buffer|string}):AdminAccess{
  const writes:AccessGrantWrites|undefined=input.secret===undefined?undefined:createAccessGrantWrites({store:input.store,secret:input.secret});
  const caller=async(session:string|undefined)=>{const p=session?(await input.sessions.get(session))?.personId:undefined;if(!p)return null;const grants=await input.authz.listGrantsForPrincipal(p);return grants.some(g=>g.role==="admin"&&(DEFAULT_OPERATOR_ORG_IDS as readonly string[]).includes(g.orgId))?p:null};
  const notFound={status:404 as const,body:{error:"not_found"}};
  return {
    async authorized(session){return await caller(session)!==null},
    async search(session,q){if(!await caller(session))return notFound;return{status:200,body:{people:await input.store.findPeople(q)}}},
    async person(session,id){if(!await caller(session))return notFound;const person=await input.store.getPerson(id);if(!person)return notFound;return{status:200,body:{person,grants:await input.store.listGrants(id)}}},
    async preview(session,change){const id=await caller(session);if(!id||!writes)return notFound;const out=await writes.preview(id,change);return out.ok?{status:200,body:out.value}:{status:out.reason==="not_found"||out.reason==="not_allowed"?404:400,body:{error:out.reason}}},
    async confirm(session,change,token){const id=await caller(session);if(!id||!writes)return notFound;const out=await writes.confirm(id,change,token);return out.ok?{status:200,body:out.value}:{status:out.reason==="not_found"||out.reason==="not_allowed"?404:out.reason.startsWith("token_")?409:400,body:{error:out.reason}}},
    async own(session){const p=session?(await input.sessions.get(session))?.personId:undefined;return p?input.store.listOwnGrants(p):null}
  };
}
const BODY_LIMIT=8192;
function cookie(raw:string|undefined){return raw?.split(";").map(x=>x.trim().split("=")).find(x=>x[0]==="__Host-studenthub_session")?.[1]}
async function body(req:IncomingMessage){const chunks:Buffer[]=[];let n=0;for await(const part of req){const b=Buffer.from(part);n+=b.length;if(n>BODY_LIMIT){req.resume();return null}chunks.push(b)}try{return JSON.parse(Buffer.concat(chunks).toString()) as unknown}catch{return null}}
export async function handleAdminAccess(req:IncomingMessage,res:ServerResponse,service:AdminAccess|undefined,origin:string|undefined,html:boolean):Promise<boolean>{
  const url=new URL(req.url??"/","http://invalid"),path=url.pathname,match=/^\/admin\/access\/([^/]+)$/.exec(path),write=path==="/admin/access/preview"||path==="/admin/access/confirm";
  if(path!=="/admin/access"&&!match&&!write)return false;
  const send=(result:AdminAccessResult,document?:string)=>{if(html&&document)writeHtml(res,result.status,document);else{res.writeHead(result.status,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});res.end(JSON.stringify(result.body))}};
  if(!service)return false;
  if(req.method==="GET"&&path==="/admin/access"){const result=await service.search(cookie(req.headers.cookie),url.searchParams.get("q")??"");if(result.status===404)return false;send(result,result.status===200?renderAdminAccess((result.body as {people:readonly AccessPerson[]}).people):undefined);return true}
  if(req.method==="GET"&&match){let id;try{id=decodeURIComponent(match[1]!)}catch{return false}const result=await service.person(cookie(req.headers.cookie),id);if(result.status===404)return false;send(result,result.status===200?renderAdminAccessPerson(result.body as {person:AccessPerson;grants:readonly AccessGrantView[]}):undefined);return true}
  if(req.method==="POST"&&write){if(!await service.authorized(cookie(req.headers.cookie))){req.resume();return false}if(!origin||req.headers["sec-fetch-site"]==="cross-site"||req.headers.origin!==origin){req.resume();return false}if(req.headers["content-type"]!=="application/json"){req.resume();send({status:400,body:{error:"invalid_request"}});return true}const value=await body(req);if(!value||typeof value!=="object"){send({status:400,body:{error:"invalid_request"}});return true}const record=value as Record<string,unknown>;const result=path.endsWith("confirm")?await service.confirm(cookie(req.headers.cookie),record.change,record.token as AccessPreviewToken):await service.preview(cookie(req.headers.cookie),record.change);if(result.status===404)return false;send(result);return true}
  return false;
}
