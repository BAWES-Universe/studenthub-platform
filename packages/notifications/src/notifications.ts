export const NOTIFICATION_KINDS = Object.freeze(["organization.status_changed"] as const);
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type OrganizationStatus = "active"|"under_review"|"inactive"|null;
export type NotificationEvent = {readonly kind:"organization.status_changed";readonly subjectRef:`organization:${string}`;readonly parameters:{readonly status:OrganizationStatus}};
export interface NotificationTransaction {query(sql:string,values?:readonly unknown[]):Promise<{rowCount:number|null;rows:readonly unknown[]}>}
export async function recordNotification(transaction:NotificationTransaction,recipientPrincipalId:string,event:NotificationEvent,dedupeKey:string):Promise<void>{
 if(!recipientPrincipalId||!dedupeKey||!event.subjectRef.startsWith("organization:"))throw new TypeError("invalid notification event");
 await transaction.query(`INSERT INTO notifications(recipient_principal_id,kind,subject_ref,parameters,dedupe_key) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(recipient_principal_id,dedupe_key) DO NOTHING`,[recipientPrincipalId,event.kind,event.subjectRef,JSON.stringify(event.parameters),dedupeKey]);
}
export interface StoredNotification {readonly id:string;readonly recipientPrincipalId:string;readonly kind:NotificationKind;readonly subjectRef:string;readonly parameters:unknown;readonly createdAt:Date|string;readonly readAt:Date|string|null}
export interface NotificationStorage {list(principalId:string,page:number,pageSize:number):Promise<readonly StoredNotification[]>;countUnread?(principalId:string):Promise<number>;markRead(principalId:string,id:string):Promise<boolean>;markAllRead(principalId:string):Promise<void>}
export interface NotificationSubjects {organizations(ids:readonly string[]):Promise<ReadonlyMap<string,{readonly name:string}>>;visibleOrganizationIds(principalId:string,ids:readonly string[]):Promise<ReadonlySet<string>>}
export interface RenderedNotification {readonly id:string;readonly text:string;readonly href:string;readonly createdAt:string;readonly read:boolean}
const labels:Record<Exclude<OrganizationStatus,null>,string>={active:"Active",under_review:"Under review",inactive:"Inactive"};
function parameters(value:unknown):{status:OrganizationStatus}|null{if(typeof value!=="object"||value===null||!("status" in value))return null;const status=(value as {status:unknown}).status;return status===null||status==="active"||status==="under_review"||status==="inactive"?{status}:null}
export class NotificationFeed {
 constructor(private readonly storage:NotificationStorage,private readonly subjects:NotificationSubjects){}
 async list(principalId:string,page=1):Promise<readonly RenderedNotification[]>{if(!Number.isSafeInteger(page)||page<1)throw new RangeError("invalid page");const rows=await this.storage.list(principalId,page,25),ids=[...new Set(rows.map(row=>row.subjectRef.startsWith("organization:")?row.subjectRef.slice(13):"").filter(Boolean))];const [organizations,visible]=await Promise.all([this.subjects.organizations(ids),this.subjects.visibleOrganizationIds(principalId,ids)]);return rows.flatMap(row=>{if(row.kind!=="organization.status_changed"||!row.subjectRef.startsWith("organization:"))return[];const id=row.subjectRef.slice(13),org=organizations.get(id),p=parameters(row.parameters);if(!org||!p||!visible.has(id))return[];return[{id:row.id,text:`${org.name} status changed to ${p.status===null?"Not set":labels[p.status]}.`,href:`/workspace?${new URLSearchParams({org_id:id,role:"org-owner"})}`,createdAt:new Date(row.createdAt).toISOString(),read:row.readAt!==null}]})}
 async count(principalId:string):Promise<number>{if(this.storage.countUnread)return this.storage.countUnread(principalId);const items=await this.list(principalId,1);return items.filter(item=>!item.read).length}
 markRead(principalId:string,id:string){return this.storage.markRead(principalId,id)}
 markAllRead(principalId:string){return this.storage.markAllRead(principalId)}
}
