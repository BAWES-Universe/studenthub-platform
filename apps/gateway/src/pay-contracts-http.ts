import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { ActionToken, Receipt, SafeWriteClock, SafeWriteSecret, SafeWriteStore } from "@studenthub/safe-write-contract";
import { pageDocument, wantsHtml, writeHtml } from "./web-ui.js";
import { buildPayContractCreateWrite, PAY_CONTRACT_CREATE_FIELD, PAY_CONTRACT_CREATE_POLICY,
  payContractPrincipalRef, payContractCompanyRecordRef, type PayContractCreateCheck, buildPayContractChangeWrite,
  PAY_CONTRACT_CHANGE_POLICY, payContractRecordRef, type PayContractChangeCheck, payContractListView,
  type PayContract, type PayContractView } from "@studenthub/pay-contracts";

export interface PayContractsCreateStore {
  forCompany(principalId: string, orgId: string): SafeWriteStore;
  readReceipt(principalId: string, orgId: string, receiptRef: string): Promise<Receipt | null>;
  forContract?(principalId:string,contractId:string):SafeWriteStore;
  readChangeReceipt?(principalId:string,contractId:string,receiptRef:string):Promise<Receipt|null>;
  readAccess?(principalId:string,orgId:string):Promise<PayContractView|null>;
  isCandidate?(principalId:string):Promise<boolean>;
}
export interface PayContractsReadStore { listForCompany(orgId:string):Promise<readonly PayContract[]>;listForCandidate(candidateId:string):Promise<readonly PayContract[]> }
type Result = { readonly status: 200; readonly body: unknown } | { readonly status: 400|401|403|404|409|503; readonly body: { readonly error: string } };
export interface PayContractsCreate { preview(session: string|undefined, body: unknown): Promise<Result>; confirm(session: string|undefined, body: unknown): Promise<Result>; receipt(session: string|undefined, orgId: string, ref: string): Promise<Result>; changePreview(session:string|undefined,body:unknown):Promise<Result>;changeConfirm(session:string|undefined,body:unknown):Promise<Result>;changeReceipt(session:string|undefined,contractId:string,ref:string):Promise<Result>;listCompany(session:string|undefined,orgId:string):Promise<Result>;listMine(session:string|undefined):Promise<Result> }
const TOKEN_KEYS = ["changeSetDigest","expectedBeforeDigest","expiresAt","issuedAt","mac","principalRef","tokenId"];
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> { return object(value) && Object.keys(value).sort().join() === [...keys].sort().join(); }
function token(value: unknown): ActionToken|undefined { return exact(value,TOKEN_KEYS) && TOKEN_KEYS.every(k=>typeof value[k]==="string") ? value as unknown as ActionToken : undefined; }
function request(body: unknown): {orgId:string;field:typeof PAY_CONTRACT_CREATE_FIELD;value:string}|undefined {
  if (!exact(body,["orgId","field","value"]) || typeof body.orgId!=="string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(body.orgId)
    || body.field!==PAY_CONTRACT_CREATE_FIELD
    || typeof body.value!=="string" || body.value.length>1024) return undefined;
  return body as {orgId:string;field:typeof PAY_CONTRACT_CREATE_FIELD;value:string};
}
function refused(reason:string):Result { return { status: reason==="not_own_record"?404:reason==="receipt_failed"?503:reason.startsWith("token_")||reason==="state_changed"?409:400, body:{error:reason} } as Result; }

export function createPayContracts(ports:{sessions:Pick<SessionStore,"get">;store:PayContractsCreateStore;contracts?:PayContractsReadStore;secret?:SafeWriteSecret;check?:PayContractCreateCheck;changeCheck?:PayContractChangeCheck;clock?:SafeWriteClock}):PayContractsCreate {
  const principal=async(id:string|undefined)=>id?(await ports.sessions.get(id))?.personId:undefined;
  const writer=(person:string,org:string)=>{if(!ports.secret||!ports.check)throw new Error("pay contract write service is not configured");return buildPayContractCreateWrite({store:ports.store.forCompany(person,org),secret:ports.secret,check:ports.check,companyId:org,policy:PAY_CONTRACT_CREATE_POLICY,...(ports.clock?{clock:ports.clock}:{})});};
  const changeRequest=(body:unknown):{contractId:string;field:string;value:string}|undefined=>!exact(body,["contractId","field","value"])||typeof body.contractId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.contractId)||typeof body.field!=="string"||typeof body.value!=="string"||body.value.length>1024?undefined:body as {contractId:string;field:string;value:string};
  const changeWriter=(person:string,id:string)=>{if(!ports.store.forContract||!ports.changeCheck||!ports.secret)throw new Error("pay contract change service is not configured");return buildPayContractChangeWrite({store:ports.store.forContract(person,id),secret:ports.secret,check:ports.changeCheck,contractId:id,policy:PAY_CONTRACT_CHANGE_POLICY,...(ports.clock?{clock:ports.clock}:{})});};
  return {
    async preview(session,body){ const person=await principal(session);if(!person)return {status:401,body:{error:"unauthorized"}};const r=request(body);if(!r)return {status:400,body:{error:"invalid_request"}};
      const out=await writer(person,r.orgId).preview({principalRef:payContractPrincipalRef(person),change:{personRef:payContractCompanyRecordRef(r.orgId),field:r.field,value:r.value}});return out.ok?{status:200,body:{changes:out.changes,token:out.token}}:refused(out.reason);},
    async confirm(session,body){ const person=await principal(session);if(!person)return {status:401,body:{error:"unauthorized"}};if(!object(body)||!("token" in body))return {status:400,body:{error:"invalid_request"}};
      const r=request(Object.fromEntries(Object.entries(body).filter(([k])=>k!=="token")));const t=token(body.token);if(!r)return {status:400,body:{error:"invalid_request"}};if(!t)return refused("token_not_issued");
      const out=await writer(person,r.orgId).confirm({principalRef:payContractPrincipalRef(person),token:t,change:{personRef:payContractCompanyRecordRef(r.orgId),field:r.field,value:r.value}});return out.ok?{status:200,body:{receipt:out.receipt}}:refused(out.reason);},
    async receipt(session,orgId,ref){const person=await principal(session);if(!person)return {status:401,body:{error:"unauthorized"}};const receipt=await ports.store.readReceipt(person,orgId,ref);return receipt?{status:200,body:{receipt}}:{status:404,body:{error:"receipt_not_found"}};},
    async changePreview(session,body){const person=await principal(session);if(!person)return{status:401,body:{error:"unauthorized"}};const r=changeRequest(body);if(!r)return{status:400,body:{error:"invalid_request"}};const out=await changeWriter(person,r.contractId).preview({principalRef:payContractPrincipalRef(person),change:{personRef:payContractRecordRef(r.contractId),field:r.field,value:r.value}});return out.ok?{status:200,body:{changes:out.changes,token:out.token}}:refused(out.reason);},
    async changeConfirm(session,body){const person=await principal(session);if(!person)return{status:401,body:{error:"unauthorized"}};if(!object(body)||!("token"in body))return{status:400,body:{error:"invalid_request"}};const r=changeRequest(Object.fromEntries(Object.entries(body).filter(([k])=>k!=="token"))),t=token(body.token);if(!r)return{status:400,body:{error:"invalid_request"}};if(!t)return refused("token_not_issued");const out=await changeWriter(person,r.contractId).confirm({principalRef:payContractPrincipalRef(person),token:t,change:{personRef:payContractRecordRef(r.contractId),field:r.field,value:r.value}});return out.ok?{status:200,body:{receipt:out.receipt}}:refused(out.reason);},
    async changeReceipt(session,id,ref){const person=await principal(session);if(!person)return{status:401,body:{error:"unauthorized"}};if(!ports.store.readChangeReceipt)throw new Error("pay contract change service is not configured");const receipt=await ports.store.readChangeReceipt(person,id,ref);return receipt?{status:200,body:{receipt}}:{status:404,body:{error:"receipt_not_found"}};},
    async listCompany(session,orgId){const person=await principal(session);if(!person)return{status:401,body:{error:"unauthorized"}};if(!ports.store.readAccess||!ports.contracts)throw new Error("pay contract read service is not configured");const view=await ports.store.readAccess(person,orgId);if(!view)return{status:404,body:{error:"not_found"}};const contracts=payContractListView(await ports.contracts.listForCompany(orgId),view);return{status:200,body:{view,contracts}};},
    async listMine(session){const person=await principal(session);if(!person)return{status:401,body:{error:"unauthorized"}};if(!ports.store.isCandidate||!ports.contracts)throw new Error("pay contract read service is not configured");if(!await ports.store.isCandidate(person))return{status:404,body:{error:"not_found"}};return{status:200,body:{contracts:payContractListView(await ports.contracts.listForCandidate(person),"candidate")}};},
  };
}

const PREVIEW="/pay-contracts/create/preview", CONFIRM="/pay-contracts/create/confirm", RECEIPT=/^\/pay-contracts\/create\/([^/]+)\/receipts\/([0-9a-f]{64})$/;
const CHANGE_PREVIEW="/pay-contracts/change/preview",CHANGE_CONFIRM="/pay-contracts/change/confirm",CHANGE_RECEIPT=/^\/pay-contracts\/change\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/receipts\/([0-9a-f]{64})$/;
const COMPANY_LIST=/^\/pay-contracts\/company\/([^/]+)$/,MINE="/pay-contracts/mine";
const ORGANIZATION_CONTRACTS=/^\/organization\/([^/]+)\/contracts$/;
const BODY_LIMIT=8192;
const ORGANIZATION_ID=/^[A-Za-z0-9._:-]{1,256}$/;
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);
function organizationContractsPage(orgId:string,body:unknown):string {
  const contracts=object(body)&&Array.isArray(body.contracts)?body.contracts:[];
  const rows=contracts.map(value=>{
    const contract=object(value)?value:{},terms=object(contract.terms)?contract.terms:{};
    const model=terms.payModel==="hourly"?"Hourly":terms.payModel==="fixed_price"?"Fixed price":terms.payModel==="monthly_salary"?"Monthly salary":String(terms.payModel??"");
    const amount=terms.payModel==="hourly"?`${String(terms.companyHourlyRate??"")} per hour`:terms.payModel==="fixed_price"?`${String(terms.companyTotal??"")} (${String(terms.completionPercentage??"")}% complete)`:terms.payModel==="monthly_salary"?`${String(terms.companyTotal??"")} (salary day ${String(terms.salaryDay??"")})`:"";
    const status=contract.status==="active"?"Active":contract.status==="inactive"?"Inactive":String(contract.status??"");
    return `<tr><td>${escapeHtml(String(contract.startDate??""))}</td><td>${escapeHtml(contract.endDate===undefined?"Open-ended":String(contract.endDate))}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(model)}</td><td>${escapeHtml(amount)}</td></tr>`;
  }).join("");
  const content=rows?`<table><thead><tr><th>Start date</th><th>End date</th><th>Status</th><th>Pay model</th><th>Company pays</th></tr></thead><tbody>${rows}</tbody></table>`:"<p>No contracts yet.</p>";
  return pageDocument("Contracts",`<main><nav aria-label="Breadcrumb"><a href="/organization/${escapeHtml(orgId)}">Organization</a></nav><h1>Contracts</h1>${content}</main>`);
}
function organizationContractsHtml(req:IncomingMessage,res:ServerResponse,status:number,orgId:string,body:unknown):void {
  const message=status===401?"Sign in to see this company's contracts.":status===503?"Contracts are unavailable right now.":"The page could not be found.";
  const html=status===200?organizationContractsPage(orgId,body):pageDocument(status===503?"Contracts unavailable":status===401?"Sign in":"Not found",`<main><h1>${escapeHtml(message)}</h1></main>`);
  writeHtml(res,status,html,{"cache-control":"no-store"});
}
function cookie(header:string|undefined):string|undefined { for(const item of header?.split(";")??[]){const [key,...parts]=item.trim().split("=");const value=parts.join("=");if(key==="__Host-studenthub_session"&&/^[A-Za-z0-9_-]{43}$/.test(value))return value;}return undefined; }
async function json(req:IncomingMessage):Promise<{ok:true;value:unknown}|{ok:false}>{if(Number(req.headers["content-length"])>BODY_LIMIT){req.resume();return {ok:false};}const chunks:Buffer[]=[];let n=0;for await(const c of req.iterator({destroyOnReturn:false})){const bytes=Buffer.from(c);n+=bytes.length;if(n>BODY_LIMIT){req.resume();return {ok:false};}chunks.push(bytes);}try{return {ok:true,value:JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown};}catch{return {ok:false};}}
export async function handlePayContracts(req:IncomingMessage,res:ServerResponse,service:PayContractsCreate|undefined,origin:string|undefined):Promise<boolean>{
  const url=new URL(req.url??"/","http://invalid"),path=url.pathname, match=RECEIPT.exec(path),changeMatch=CHANGE_RECEIPT.exec(path),companyMatch=COMPANY_LIST.exec(path),pageMatch=ORGANIZATION_CONTRACTS.exec(path);if(pageMatch&&req.method!=="GET"&&req.method!=="HEAD")return false;if(path!==PREVIEW&&path!==CONFIRM&&path!==CHANGE_PREVIEW&&path!==CHANGE_CONFIRM&&path!==MINE&&!match&&!changeMatch&&!companyMatch&&!pageMatch)return false;
  const send=(r:Result)=>{res.writeHead(r.status,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});res.end(JSON.stringify(r.body));};
  let pageOrgId="";
  try {if(pageMatch){try{pageOrgId=decodeURIComponent(pageMatch[1]!);}catch{pageOrgId="";}const html=wantsHtml(req.headers.accept);if(url.search){if(html)organizationContractsHtml(req,res,400,pageOrgId,{error:"invalid_request"});else send({status:400,body:{error:"invalid_request"}});return true;}if(!ORGANIZATION_ID.test(pageOrgId)){if(html)organizationContractsHtml(req,res,404,pageOrgId,{error:"not_found"});else send({status:404,body:{error:"not_found"}});return true;}if(!service||!origin){if(html)organizationContractsHtml(req,res,503,pageOrgId,{error:"safe_write_unavailable"});else send({status:503,body:{error:"safe_write_unavailable"}});return true;}const result=await service.listCompany(cookie(req.headers.cookie),pageOrgId);if(html)organizationContractsHtml(req,res,result.status,pageOrgId,result.body);else send(result);return true;}if(!service||!origin){send({status:503,body:{error:"safe_write_unavailable"}});return true;}const session=cookie(req.headers.cookie);
    if(companyMatch||path===MINE){if(req.method!=="GET"){send({status:404,body:{error:"not_found"}});return true;}if(path===MINE){send(await service.listMine(session));return true;}let orgId:string;try{orgId=decodeURIComponent(companyMatch![1]!);}catch{send({status:404,body:{error:"not_found"}});return true;}send(await service.listCompany(session,orgId));return true;}
    if(match||changeMatch){if(req.method!=="GET"){send({status:404,body:{error:"not_found"}});return true;}if(changeMatch){send(await service.changeReceipt(session,changeMatch[1]!,changeMatch[2]!));return true;}let orgId:string;try{orgId=decodeURIComponent(match![1]!);}catch{send({status:400,body:{error:"invalid_request"}});return true;}send(await service.receipt(session,orgId,match![2]!));return true;}
    if(req.method!=="POST"){send({status:404,body:{error:"not_found"}});return true;}if(req.headers.origin!==origin||req.headers["sec-fetch-site"]==="cross-site"){req.resume();send({status:403,body:{error:"origin_rejected"}});return true;}
    if(req.headers["content-type"]!=="application/json"){req.resume();send({status:400,body:{error:"invalid_request"}});return true;}const body=await json(req);if(!body.ok){send({status:400,body:{error:"invalid_request"}});return true;}send(path===PREVIEW?await service.preview(session,body.value):path===CONFIRM?await service.confirm(session,body.value):path===CHANGE_PREVIEW?await service.changePreview(session,body.value):await service.changeConfirm(session,body.value));
  } catch {if(!res.headersSent){if(pageMatch&&wantsHtml(req.headers.accept))organizationContractsHtml(req,res,503,pageOrgId,{error:"safe_write_unavailable"});else send({status:503,body:{error:"safe_write_unavailable"}});}else res.destroy();}return true;
}
