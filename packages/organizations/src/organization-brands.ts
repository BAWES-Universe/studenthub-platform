import{DEFAULT_OPERATOR_ORG_IDS}from"./organizations.js";
export interface OrganizationBrandGrantRow{readonly org_id:string;readonly role:string;readonly scope:string}
export interface OrganizationBrandRow{readonly brand_id:string;readonly name:string;readonly status:string;readonly org_id?:string;readonly linked_at?:Date|string}
export interface OrganizationBrandView{readonly brandId:string;readonly name:string}
export function organizationBrandDecision(rows:readonly OrganizationBrandGrantRow[],orgId:string,ancestors:readonly string[],operators:readonly string[]=DEFAULT_OPERATOR_ORG_IDS){return!operators.includes(orgId)&&rows.some(row=>(row.role==="staff"||row.role==="admin")&&(row.org_id===orgId||(row.scope==="subtree"&&ancestors.includes(row.org_id))))}
export function isOrganizationBrandId(value:unknown):value is string{return typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)}
export function organizationBrandLinkOutcome(currentOrgId:string|null,orgId:string):"link"|"unchanged"|"owned_elsewhere"{return currentOrgId===null?"link":currentOrgId===orgId?"unchanged":"owned_elsewhere"}
export function organizationBrandUnlinkOutcome(currentOrgId:string|null,orgId:string):"unlink"|"not_linked"{return currentOrgId===orgId?"unlink":"not_linked"}
export function organizationBrandsView(rows:readonly OrganizationBrandRow[]):OrganizationBrandView[]{return rows.filter(row=>row.status==="active").sort((a,b)=>a.name.localeCompare(b.name)||a.brand_id.localeCompare(b.brand_id)).map(row=>({brandId:row.brand_id,name:row.name}))}
