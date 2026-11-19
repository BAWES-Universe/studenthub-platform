import type { SessionStore } from "@studenthub/login-contract";
import type { ExportService } from "../../../packages/exports/src/exports.js";
import { CATALOGUE_LIST_KINDS } from "../../../packages/exports/src/catalogue-list-export.js";
import { parseCompanyDirectoryExportQuery } from "./company-directory.js";

/**
 * The HTTP side of the export service (contract P-1). `POST /exports/<kind>` asks for an export
 * of one kind; `GET /exports/<id>` downloads it. Each kind the gateway offers is one entry in
 * EXPORT_HTTP_KINDS: how its query string becomes its closed filters (null refuses the request
 * before the service is reached), what its file is called and what its rows are called on the
 * page. Who may export is not decided here: the kind registered with the ExportService decides,
 * at request and again at download. A kind listed here but not registered with the service is
 * not found.
 */
export interface ExportsHttpKind {
  readonly id: string;
  /** Download name for a CSV kind, e.g. countries.csv. A kind with its own format names each file itself (ExportKind.serialize). */
  readonly filename: string;
  /** What the rows are, for "<n> <noun> exported.", e.g. companies. */
  readonly noun: string;
  /** The kind's filters from the request's query string, or null to refuse the request. */
  filters(query: URLSearchParams): Readonly<Record<string, unknown>> | null;
  /** Filters that name the requester, such as account manager "me", resolved for them. */
  forRequester?(filters: Readonly<Record<string, unknown>>, personId: string): Readonly<Record<string, unknown>>;
}
export type ExportsHttpResult={readonly status:200;readonly body:{readonly id:string;readonly downloadUrl:string;readonly rowCount:number}}|{readonly status:404;readonly body:{readonly error:"not_found"}}|{readonly status:409;readonly body:{readonly error:"row_limit"}};
export interface ExportsHttpFile{readonly bytes:Buffer;readonly filename:string;readonly contentType:string}
export interface ExportsHttp{request(sessionId:string|undefined,kindId:string,filters:Readonly<Record<string,unknown>>):Promise<ExportsHttpResult>;download(sessionId:string|undefined,id:string):Promise<ExportsHttpFile|null>}

/** A kind with no filters: any query parameter refuses the request. */
const noFilters = (query: URLSearchParams) => [...query.keys()].length ? null : {};
export const EXPORT_HTTP_KINDS: ReadonlyMap<string, ExportsHttpKind> = new Map(([
  { id: "company-directory", filename: "company-directory.csv", noun: "companies", filters: parseCompanyDirectoryExportQuery,
    forRequester: (filters, personId) => filters.accountManager === "me" ? Object.freeze({ ...filters, accountManager: personId }) : filters },
  { id: CATALOGUE_LIST_KINDS.country, filename: "countries.csv", noun: "countries", filters: noFilters },
  { id: CATALOGUE_LIST_KINDS.university, filename: "universities.csv", noun: "universities", filters: noFilters },
] satisfies ExportsHttpKind[]).map(kind => [kind.id, kind]));

const answer=(result:Awaited<ReturnType<ExportService["request"]>>):ExportsHttpResult=>result.ok?{status:200,body:{id:result.id,downloadUrl:result.downloadUrl,rowCount:result.rowCount}}:result.reason==="row_limit"?{status:409,body:{error:"row_limit"}}:{status:404,body:{error:"not_found"}};
export function createExportsHttp(sessions:Pick<SessionStore,"get">,service:ExportService):ExportsHttp{return{
 async request(sessionId,kindId,filters){const session=sessionId?await sessions.get(sessionId):undefined;const kind=EXPORT_HTTP_KINDS.get(kindId);if(!session||!kind)return{status:404,body:{error:"not_found"}};return answer(await service.request(session.personId,kind.id,kind.forRequester?.(filters,session.personId)??filters));},
 async download(sessionId,id){const session=sessionId?await sessions.get(sessionId):undefined;const file=session?await service.downloadFile(session.personId,id):null;if(!file)return null;return file.file?{bytes:file.bytes,filename:file.file.fileName,contentType:file.file.contentType}:{bytes:file.bytes,filename:EXPORT_HTTP_KINDS.get(file.kind)?.filename??"export.csv",contentType:"text/csv; charset=utf-8"};}
};}
