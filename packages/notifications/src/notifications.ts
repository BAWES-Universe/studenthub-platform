import type {AuthzStore,RoleGrant} from "@studenthub/contracts";

export const NOTIFICATION_KINDS=Object.freeze(["organization.status_changed"] as const);
export type NotificationKind=typeof NOTIFICATION_KINDS[number];
export type NotificationParameters={readonly "organization.status_changed":{readonly status:"active"|"under_review"|"inactive"|"none"}};
export interface NotificationEvent<K extends NotificationKind=NotificationKind>{readonly id:string;readonly recipientPrincipalId:string;readonly kind:K;readonly subjectReference:`organization:${string}`;readonly parameters:NotificationParameters[K];readonly createdAt:Date|string;readonly readAt:Date|string|null}
export interface NotificationRecordPort{record<K extends NotificationKind>(event:{readonly recipientPrincipalId:string;readonly kind:K;readonly subjectReference:`organization:${string}`;readonly parameters:NotificationParameters[K];readonly dedupeKey:string}):Promise<void>}
export async function recordNotification<K extends NotificationKind>(port:NotificationRecordPort,event:{readonly recipientPrincipalId:string;readonly kind:K;readonly subjectReference:`organization:${string}`;readonly parameters:NotificationParameters[K];readonly dedupeKey:string}):Promise<void>{if(!NOTIFICATION_KINDS.includes(event.kind))throw new TypeError("unknown notification kind");await port.record({...event,dedupeKey:event.dedupeKey})}
export interface NotificationEventStore{list(recipient:string,limit:number,offset:number):Promise<readonly NotificationEvent[]>;countVisibleUnread?(recipient:string):Promise<number>;markRead(recipient:string,id:string):Promise<boolean>;markAllRead(recipient:string):Promise<void>}
export interface NotificationOrganization{readonly id:string;readonly name:string;readonly parentOrgId?:string}
export interface NotificationSubjectStore{readOrganizations(ids:readonly string[]):Promise<readonly NotificationOrganization[]>;liveOrganizationIds(ids:readonly string[]):Promise<ReadonlySet<string>>}
export interface RenderedNotification{readonly id:string;readonly text:string;readonly href:string;readonly createdAt:string;readonly read:boolean}
export interface NotificationPage{readonly items:readonly RenderedNotification[];readonly unreadCount:number;readonly page:number}
const labels={active:"Active",under_review:"Under review",inactive:"Inactive",none:"Not set"} as const;
function visible(grants:readonly RoleGrant[],org:NotificationOrganization,byId:ReadonlyMap<string,NotificationOrganization>):boolean{return grants.some(g=>g.orgId===org.id||g.scope==="subtree"&&(()=>{let at=org.parentOrgId;while(at){if(at===g.orgId)return true;at=byId.get(at)?.parentOrgId}return false})())}
export class NotificationsService{
 constructor(private readonly events:NotificationEventStore,private readonly subjects:NotificationSubjectStore,private readonly authz:Pick<AuthzStore,"listGrantsForPrincipal">){}
 async list(recipient:string,page=1):Promise<NotificationPage>{if(!Number.isSafeInteger(page)||page<1)throw new RangeError("page must be positive");const rows=await this.events.list(recipient,25,(page-1)*25);const ids=[...new Set(rows.map(r=>r.subjectReference.slice(13)))];const [organizations,live,grants]=await Promise.all([this.subjects.readOrganizations(ids),this.subjects.liveOrganizationIds(ids),this.authz.listGrantsForPrincipal(recipient)]);const byId=new Map(organizations.map(o=>[o.id,o]));const items=rows.flatMap(row=>{const id=row.subjectReference.slice(13),org=byId.get(id);if(!org||!live.has(id)||!visible(grants,org,byId))return[];return[{id:row.id,text:`${org.name} status changed to ${labels[row.parameters.status]}.`,href:`/workspace?${new URLSearchParams({org_id:id,role:"org-owner"})}`,createdAt:new Date(row.createdAt).toISOString(),read:row.readAt!==null}]});return{items,unreadCount:items.filter(i=>!i.read).length,page}}
 async count(recipient:string):Promise<number>{return this.events.countVisibleUnread?this.events.countVisibleUnread(recipient):(await this.list(recipient,1)).unreadCount}
 markRead(recipient:string,id:string){return this.events.markRead(recipient,id)}
 markAllRead(recipient:string){return this.events.markAllRead(recipient)}
}
