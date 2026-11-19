import type { SessionStore } from "@studenthub/login-contract";
import type { ExportService, ExportStore } from "../../../packages/exports/src/exports.js";
import type { CompanyDirectoryExportFilters } from "../../../packages/exports/src/company-directory-export.js";

export type ExportsHttpResult={readonly status:200;readonly body:{readonly id:string;readonly downloadUrl:string;readonly rowCount:number}}|{readonly status:404;readonly body:{readonly error:"not_found"}}|{readonly status:409;readonly body:{readonly error:"row_limit"}};
export interface ExportsHttp{request(sessionId:string|undefined,filters:CompanyDirectoryExportFilters):Promise<ExportsHttpResult>;download(sessionId:string|undefined,id:string):Promise<Buffer|null>;
 /** Any registered kind, for an area's own export screens (work and hours); the area parses its filters first. */
 requestKind?(sessionId:string|undefined,kindId:string,filters:Readonly<Record<string,unknown>>):Promise<ExportsHttpResult>;
 /** The file with its kind, so the download can be named after it. */
 file?(sessionId:string|undefined,id:string):Promise<{readonly kind:string;readonly bytes:Buffer}|null>}
const answer=(result:Awaited<ReturnType<ExportService["request"]>>):ExportsHttpResult=>result.ok?{status:200,body:{id:result.id,downloadUrl:result.downloadUrl,rowCount:result.rowCount}}:result.reason==="row_limit"?{status:409,body:{error:"row_limit"}}:{status:404,body:{error:"not_found"}};
// `store` (optional) is read only for a file's kind, after the service has checked the download.
export function createExportsHttp(sessions:Pick<SessionStore,"get">,service:ExportService,store?:Pick<ExportStore,"find">):ExportsHttp{return{
 async request(sessionId,filters){const session=sessionId?await sessions.get(sessionId):undefined;if(!session)return{status:404,body:{error:"not_found"}};const resolved=filters.accountManager==="me"?Object.freeze({...filters,accountManager:session.personId}):filters;const result=await service.request(session.personId,"company-directory",resolved);return result.ok?{status:200,body:{id:result.id,downloadUrl:result.downloadUrl,rowCount:result.rowCount}}:result.reason==="row_limit"?{status:409,body:{error:"row_limit"}}:{status:404,body:{error:"not_found"}};},
 async download(sessionId,id){const session=sessionId?await sessions.get(sessionId):undefined;return session?service.download(session.personId,id):null;},
 async requestKind(sessionId,kindId,filters){const session=sessionId?await sessions.get(sessionId):undefined;if(!session)return{status:404,body:{error:"not_found"}};return answer(await service.request(session.personId,kindId,filters));},
 async file(sessionId,id){const session=sessionId?await sessions.get(sessionId):undefined;const bytes=session?await service.download(session.personId,id):null;if(!bytes)return null;return{kind:(await store?.find(id))?.kind??"company-directory",bytes};}
};}
