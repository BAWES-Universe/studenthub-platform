import type { SessionStore } from "@studenthub/login-contract";
import type { ExportService } from "../../../packages/exports/src/exports.js";
import type { CompanyDirectoryExportFilters } from "../../../packages/exports/src/company-directory-export.js";

export type ExportsHttpResult={readonly status:200;readonly body:{readonly id:string;readonly downloadUrl:string;readonly rowCount:number}}|{readonly status:404;readonly body:{readonly error:"not_found"}}|{readonly status:409;readonly body:{readonly error:"row_limit"}};
export interface ExportsHttp{request(sessionId:string|undefined,filters:CompanyDirectoryExportFilters):Promise<ExportsHttpResult>;download(sessionId:string|undefined,id:string):Promise<Buffer|null>}
export function createExportsHttp(sessions:Pick<SessionStore,"get">,service:ExportService):ExportsHttp{return{
 async request(sessionId,filters){const session=sessionId?await sessions.get(sessionId):undefined;if(!session)return{status:404,body:{error:"not_found"}};const resolved=filters.accountManager==="me"?Object.freeze({...filters,accountManager:session.personId}):filters;const result=await service.request(session.personId,"company-directory",resolved);return result.ok?{status:200,body:{id:result.id,downloadUrl:result.downloadUrl,rowCount:result.rowCount}}:result.reason==="row_limit"?{status:409,body:{error:"row_limit"}}:{status:404,body:{error:"not_found"}};},
 async download(sessionId,id){const session=sessionId?await sessions.get(sessionId):undefined;return session?service.download(session.personId,id):null;}
};}
