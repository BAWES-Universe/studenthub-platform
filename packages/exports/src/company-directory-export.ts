import type { OrganizationDirectory,OrganizationDirectoryEntry } from "@studenthub/organizations";
import type { ExportKind } from "./exports.js";

export interface CompanyDirectoryExportFilters extends Readonly<Record<string,unknown>> {readonly orgId:string;readonly role:"staff"|"admin";readonly query?:string;readonly status?:"active"|"under_review"|"inactive";readonly approvedToHire?:boolean;readonly currencyCode?:string;readonly accountManager?:string}
const field=(value:{state:string;value?:unknown})=>value.state==="available"?value.value:"";
const directoryFilters=({query,status,approvedToHire,currencyCode,accountManager}:CompanyDirectoryExportFilters)=>({query,status,approvedToHire,currencyCode,accountManager});
export function createCompanyDirectoryExport(directory:OrganizationDirectory):ExportKind<CompanyDirectoryExportFilters>{return{
 id:"company-directory",filterKeys:["orgId","role","query","status","approvedToHire","currencyCode","accountManager"],columns:["Name","Status","Approved to hire","Currency","Account manager name"],
 async authorize(principalId,filters){if(filters.role!=="staff"&&filters.role!=="admin")return false;const result=await directory.listOrganizations({principalId,orgId:filters.orgId,role:filters.role,filters:directoryFilters(filters),page:1});return result.kind==="found";},
 async *rows(principalId,filters){let page=1;for(;;){const result=await directory.listOrganizations({principalId,orgId:filters.orgId,role:filters.role,filters:directoryFilters(filters),page});if(result.kind!=="found")throw new Error("export authorization changed");for(const entry of result.directory.entries){const extended=entry as OrganizationDirectoryEntry&{accountManager?:{displayName:string|null}|null};yield[field(entry.legalName)||entry.registryName,field(entry.status),field(entry.approvedToHire)===true?"Yes":field(entry.approvedToHire)===false?"No":"",field(entry.currencyCode),extended.accountManager?.displayName??""];}if(page*result.directory.pageSize>=result.directory.total)return;page++;}}
};}
