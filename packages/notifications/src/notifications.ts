import type {AuthzStore,RoleGrant} from "@studenthub/contracts";
import {isStaffMessageKind,renderStaffMessage,type StaffMessageKind} from "../../comms/src/staff-messages.js";

/** The recruit lane's outbox events, each its own feed kind (`recruit.<event>`), legacy candidate notification types 0, 10 and 11 and their recruiter side. */
export const RECRUIT_EVENTS=Object.freeze(["invitation.sent","invitation.accepted","invitation.declined","invitation.withdrawn","interview.scheduled","interview.cancelled","application.shortlisted","application.rejected","request_application.received","request_application.accepted","request_application.rejected"] as const);
export type RecruitEvent=typeof RECRUIT_EVENTS[number];
type RecruitKind=`recruit.${RecruitEvent}`;
export const NOTIFICATION_KINDS=Object.freeze(["organization.status_changed","staff.message","work.session_approved","work.session_rejected","work.assigned","pay.line_paid",...RECRUIT_EVENTS.map(e=>`recruit.${e}` as RecruitKind)] as const);
export type NotificationKind=typeof NOTIFICATION_KINDS[number];
export type NotificationParameters={readonly "organization.status_changed":{readonly status:"active"|"under_review"|"inactive"|"none"};readonly "staff.message":Readonly<Record<string,never>>;readonly "work.session_approved":{readonly workDate:string};readonly "work.session_rejected":{readonly workDate:string};readonly "work.assigned":Readonly<Record<string,never>>;readonly "pay.line_paid":Readonly<Record<string,never>>}&{readonly [K in RecruitKind]:Readonly<Record<string,never>>};
export type NotificationSubjectReference={readonly "organization.status_changed":`organization:${string}`;readonly "staff.message":`staff_message:${string}`;readonly "work.session_approved":`work_session:${string}`;readonly "work.session_rejected":`work_session:${string}`;readonly "work.assigned":`work_assignment:${string}`;readonly "pay.line_paid":`bank_confirmation:${string}`}&{readonly [K in RecruitKind]:`recruit_outbox:${string}`};
type EventOf<K extends NotificationKind>={readonly id:string;readonly recipientPrincipalId:string;readonly kind:K;readonly subjectReference:NotificationSubjectReference[K];readonly parameters:NotificationParameters[K];readonly createdAt:Date|string;readonly readAt:Date|string|null};
export type NotificationEvent<K extends NotificationKind=NotificationKind>={[P in K]:EventOf<P>}[K];
/** A stored feed row as the registry sees it: any registered kind, its parameters still unchecked. */
export interface FeedRow{readonly id:string;readonly recipientPrincipalId:string;readonly kind:string;readonly subjectReference:string;readonly parameters:unknown;readonly createdAt:Date|string;readonly readAt:Date|string|null}
export interface NotificationEventStore{list(recipient:string,limit:number,offset:number,kinds?:readonly string[]):Promise<readonly FeedRow[]>;countVisibleUnread?(recipient:string):Promise<number>;markRead(recipient:string,id:string):Promise<boolean>;markAllRead(recipient:string):Promise<void>}
export interface NotificationOrganization{readonly id:string;readonly name:string;readonly parentOrgId?:string}
export interface StoredStaffMessage{readonly id:string;readonly kind:StaffMessageKind;readonly body:string|null}
/** One recruit outbox event addressed to the recipient, with its request's current position title and company name. */
export interface StoredRecruitEvent{readonly id:string;readonly event:string;readonly requestId:string;readonly positionTitle:string;readonly companyName:string}
/** One placement of the recipient, with its store and company names and start date as they are now. */
export interface StoredPlacement{readonly id:string;readonly storeName:string;readonly companyName:string;readonly startDate:string}
/** One bank payment confirmation of the recipient's own pay line: the line's id, amount and currency, and its store and company names as they are now. */
export interface StoredPaidLine{readonly id:string;readonly lineId:string;readonly amount:string;readonly currencyCode:string;readonly storeName:string;readonly companyName:string}
/** readStaffMessages must return only messages addressed to the recipient; a feed row whose message is missing is not shown. */
export interface NotificationSubjectStore{readOrganizations(ids:readonly string[]):Promise<readonly NotificationOrganization[]>;liveOrganizationIds(ids:readonly string[]):Promise<ReadonlySet<string>>;readStaffMessages?(recipient:string,ids:readonly string[]):Promise<readonly StoredStaffMessage[]>;/** Only events addressed to the recipient; a feed row whose event is missing is not shown. */readRecruitEvents?(recipient:string,ids:readonly string[]):Promise<readonly StoredRecruitEvent[]>;/** Only the recipient's own placements; a feed row whose placement is missing is not shown. */readPlacements?(recipient:string,ids:readonly string[]):Promise<readonly StoredPlacement[]>;/** Only confirmations of the recipient's own pay lines; a feed row whose confirmation is missing is not shown. */readPaidLines?(recipient:string,ids:readonly string[]):Promise<readonly StoredPaidLine[]>}
export interface RenderedNotification{readonly id:string;readonly text:string;readonly href:string;readonly createdAt:string;readonly read:boolean}
export interface NotificationPage{readonly items:readonly RenderedNotification[];readonly unreadCount:number;readonly page:number}
export interface NotificationLine{readonly text:string;readonly href:string}
export interface NotificationRenderContext{readonly recipient:string;readonly subjects:NotificationSubjectStore;readonly authz:Pick<AuthzStore,"listGrantsForPrincipal">}

/**
 * One feed kind. It owns the closed check of its stored subject reference and parameters
 * (the same rule as the database CHECK), how its subject id is read from the reference, and
 * how one page of its rows is rendered. Subjects are read once per page, never per row. A row
 * the definition cannot show (missing subject, no longer visible) is left out of the page.
 */
export interface NotificationKindDefinition{
 readonly kind:string;
 /** The subject id inside a well-formed reference, or null when the reference is not this kind's. */
 subject(reference:string):string|null;
 parameters(value:unknown):boolean;
 render(rows:readonly FeedRow[],context:NotificationRenderContext):Promise<ReadonlyMap<string,NotificationLine>>;
}
const KIND=/^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/;
/** The registered kinds. A lane adds a kind with one definition here (and its database payload rule), not an edit to the feed. */
export class NotificationKindRegistry{
 readonly #byKind=new Map<string,NotificationKindDefinition>();
 constructor(definitions:readonly NotificationKindDefinition[]){for(const d of definitions){if(!KIND.test(d.kind))throw new TypeError(`invalid notification kind ${d.kind}`);if(this.#byKind.has(d.kind))throw new TypeError(`duplicate notification kind ${d.kind}`);this.#byKind.set(d.kind,d)}}
 kinds():readonly string[]{return[...this.#byKind.keys()]}
 get(kind:string):NotificationKindDefinition|undefined{return this.#byKind.get(kind)}
 /** True when the row's kind is registered and its reference and parameters pass that kind's check. */
 accepts(row:Pick<FeedRow,"kind"|"subjectReference"|"parameters">):boolean{const d=this.#byKind.get(row.kind);return!!d&&d.subject(row.subjectReference)!==null&&d.parameters(row.parameters)}
 /** A types filter: every entry must be a registered kind, at most one of each. Returns null when any entry is not. */
 types(values:readonly string[]):readonly string[]|null{if(values.some(v=>!this.#byKind.has(v)))return null;return values.length?[...new Set(values)]:[]}
}

const plainObject=(value:unknown):value is Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value);
const onlyKeys=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).length===keys.length&&keys.every(k=>k in value);
const prefixed=(prefix:string,pattern:RegExp)=>(reference:string)=>reference.startsWith(prefix)&&pattern.test(reference.slice(prefix.length))?reference.slice(prefix.length):null;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,TOKEN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Same rule as the database's notification_calendar_date: a real date, year 0001 or later. */
function isCalendarDate(value:unknown):value is string{if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith("0000"))return false;const parsed=new Date(`${value}T00:00:00Z`);return!Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value}

const labels={active:"Active",under_review:"Under review",inactive:"Inactive",none:"Not set"} as const;
function visible(grants:readonly RoleGrant[],org:NotificationOrganization,byId:ReadonlyMap<string,NotificationOrganization>):boolean{return grants.some(g=>g.orgId===org.id||g.scope==="subtree"&&(()=>{let at=org.parentOrgId;while(at){if(at===g.orgId)return true;at=byId.get(at)?.parentOrgId}return false})())}
const organizationSubject=prefixed("organization:",/^[\s\S]+$/);
export const organizationStatusChangedKind:NotificationKindDefinition={
 kind:"organization.status_changed",
 subject:organizationSubject,
 parameters:value=>plainObject(value)&&onlyKeys(value,["status"])&&typeof value.status==="string"&&Object.hasOwn(labels,value.status),
 async render(rows,{recipient,subjects,authz}){const ids=[...new Set(rows.map(r=>organizationSubject(r.subjectReference)!))];const [organizations,live,grants]=await Promise.all([subjects.readOrganizations(ids),subjects.liveOrganizationIds(ids),authz.listGrantsForPrincipal(recipient)]);const byId=new Map(organizations.map(o=>[o.id,o])),lines=new Map<string,NotificationLine>();for(const row of rows){const id=organizationSubject(row.subjectReference)!,org=byId.get(id);if(!org||!live.has(id)||!visible(grants,org,byId))continue;const status=(row.parameters as {status:keyof typeof labels}).status;lines.set(row.id,{text:`${org.name} status changed to ${labels[status]}.`,href:`/workspace?${new URLSearchParams({org_id:id,role:"org-owner"})}`})}return lines}
};
const staffSubject=prefixed("staff_message:",UUID);
export const staffMessageKind:NotificationKindDefinition={
 kind:"staff.message",
 subject:staffSubject,
 parameters:value=>plainObject(value)&&Object.keys(value).length===0,
 async render(rows,{recipient,subjects}){const ids=[...new Set(rows.map(r=>staffSubject(r.subjectReference)!))];const messages=subjects.readStaffMessages?await subjects.readStaffMessages(recipient,ids):[];const byId=new Map(messages.map(m=>[m.id,m])),lines=new Map<string,NotificationLine>();for(const row of rows){const message=byId.get(staffSubject(row.subjectReference)!);if(!message||!isStaffMessageKind(message.kind))continue;lines.set(row.id,renderStaffMessage(message.kind,message.body))}return lines}
};
/** The person's hours history for one day (screen contract C-12). */
export const workHistoryHref=(workDate:string)=>`/work/history/${encodeURIComponent(workDate)}`;
const workDecisionKind=(decision:"approved"|"rejected"):NotificationKindDefinition=>({
 kind:`work.session_${decision}`,
 subject:prefixed("work_session:",TOKEN),
 parameters:value=>plainObject(value)&&onlyKeys(value,["workDate"])&&isCalendarDate(value.workDate),
 async render(rows){return new Map(rows.map(row=>{const workDate=(row.parameters as {workDate:string}).workDate;return[row.id,{text:`Your hours for ${workDate} were ${decision}.`,href:workHistoryHref(workDate)}]}))}
});
export const workSessionApprovedKind=workDecisionKind("approved"),workSessionRejectedKind=workDecisionKind("rejected");
const placementSubject=prefixed("work_assignment:",UUID);
/** A new placement (legacy candidate notification type 1): where and from when, read from the placement as it is now. Opens the person's work page. */
export const workAssignedKind:NotificationKindDefinition={
 kind:"work.assigned",
 subject:placementSubject,
 parameters:value=>plainObject(value)&&Object.keys(value).length===0,
 async render(rows,{recipient,subjects}){const ids=[...new Set(rows.map(r=>placementSubject(r.subjectReference)!))];const placements=subjects.readPlacements?await subjects.readPlacements(recipient,ids):[];const byId=new Map(placements.map(p=>[p.id,p])),lines=new Map<string,NotificationLine>();for(const row of rows){const p=byId.get(placementSubject(row.subjectReference)!);if(!p)continue;lines.set(row.id,{text:`You were placed at ${p.storeName}, ${p.companyName}, starting ${p.startDate}.`,href:"/work"})}return lines}
};
const paidSubject=prefixed("bank_confirmation:",/^[1-9][0-9]{0,18}$/);
/** Legacy number_format(amount, 3): thousands separated by commas, three decimals, from the stored decimal text. */
export function formatPaidAmount(amount:string):string|null{const m=/^(\d+)(?:\.(\d{1,3}))?$/.exec(amount);if(!m)return null;return`${m[1]!.replace(/^0+(?=\d)/,"").replace(/\B(?=(\d{3})+$)/g,",")}.${(m[2]??"").padEnd(3,"0")}`}
/** A pay line paid by the bank (legacy TransferCandidate::sendTransferPaidNotification, switched off in legacy and sent here): legacy's words, the amount the person is paid on that line, and where it was earned. Opens the line in the person's pay history. */
export const payLinePaidKind:NotificationKindDefinition={
 kind:"pay.line_paid",
 subject:paidSubject,
 parameters:value=>plainObject(value)&&Object.keys(value).length===0,
 async render(rows,{recipient,subjects}){const ids=[...new Set(rows.map(r=>paidSubject(r.subjectReference)!))];const paid=subjects.readPaidLines?await subjects.readPaidLines(recipient,ids):[];const byId=new Map(paid.map(p=>[p.id,p])),lines=new Map<string,NotificationLine>();for(const row of rows){const p=byId.get(paidSubject(row.subjectReference)!);const amount=p&&formatPaidAmount(p.amount);if(!p||!amount)continue;lines.set(row.id,{text:`Transfer paid: ${p.currencyCode} ${amount} has been transferred to your bank account (${p.storeName}, ${p.companyName}).`,href:`/pay/${encodeURIComponent(p.lineId)}`})}return lines}
};
const recruitSubject=prefixed("recruit_outbox:",/^[1-9][0-9]{0,18}$/);
const requestPath=(id:string)=>encodeURIComponent(id);
/** What each recruit event says and where it leads, from the request as it is now. The person's events open their own lists; the recruiter's open the request. */
const RECRUIT_LINES:{readonly [E in RecruitEvent]:(e:StoredRecruitEvent)=>NotificationLine}={
 "invitation.sent":e=>({text:`You're invited to apply for ${e.positionTitle} at ${e.companyName}.`,href:"/recruit/invitations"}),
 "invitation.withdrawn":e=>({text:`Your invitation to ${e.positionTitle} at ${e.companyName} was withdrawn.`,href:"/recruit/invitations"}),
 "invitation.accepted":e=>({text:`An invitation to ${e.positionTitle} at ${e.companyName} was accepted.`,href:`/recruit/staff/requests/${requestPath(e.requestId)}/invitations`}),
 "invitation.declined":e=>({text:`An invitation to ${e.positionTitle} at ${e.companyName} was declined.`,href:`/recruit/staff/requests/${requestPath(e.requestId)}/invitations`}),
 "interview.scheduled":e=>({text:`Your interview for ${e.positionTitle} at ${e.companyName} is scheduled.`,href:"/recruit/my-interviews"}),
 "interview.cancelled":e=>({text:`Your interview for ${e.positionTitle} at ${e.companyName} was cancelled.`,href:"/recruit/my-interviews"}),
 "application.shortlisted":e=>({text:`You were shortlisted for ${e.positionTitle} at ${e.companyName}.`,href:"/recruit/jobs?applied=1"}),
 "application.rejected":e=>({text:`Your application for ${e.positionTitle} at ${e.companyName} was not taken forward.`,href:"/recruit/jobs?applied=1"}),
 "request_application.received":e=>({text:`Someone applied for ${e.positionTitle} at ${e.companyName}.`,href:`/recruit/requests/${requestPath(e.requestId)}/applications`}),
 "request_application.accepted":e=>({text:`Your application for ${e.positionTitle} at ${e.companyName} was accepted.`,href:"/recruit/open-requests?applied=1"}),
 "request_application.rejected":e=>({text:`Your application for ${e.positionTitle} at ${e.companyName} was not taken forward.`,href:"/recruit/open-requests?applied=1"}),
};
const recruitKind=(event:RecruitEvent):NotificationKindDefinition=>({
 kind:`recruit.${event}`,
 subject:recruitSubject,
 parameters:value=>plainObject(value)&&Object.keys(value).length===0,
 async render(rows,{recipient,subjects}){const ids=[...new Set(rows.map(r=>recruitSubject(r.subjectReference)!))];const events=subjects.readRecruitEvents?await subjects.readRecruitEvents(recipient,ids):[];const byId=new Map(events.map(e=>[e.id,e])),lines=new Map<string,NotificationLine>();for(const row of rows){const stored=byId.get(recruitSubject(row.subjectReference)!);if(!stored||stored.event!==event)continue;lines.set(row.id,RECRUIT_LINES[event](stored))}return lines}
});
export const RECRUIT_KINDS=RECRUIT_EVENTS.map(recruitKind);
export const NOTIFICATION_REGISTRY=new NotificationKindRegistry([organizationStatusChangedKind,staffMessageKind,workSessionApprovedKind,workSessionRejectedKind,workAssignedKind,payLinePaidKind,...RECRUIT_KINDS]);

export interface NotificationRecordPort{record<K extends NotificationKind>(event:{readonly recipientPrincipalId:string;readonly kind:K;readonly subjectReference:NotificationSubjectReference[K];readonly parameters:NotificationParameters[K];readonly dedupeKey:string}):Promise<void>}
export async function recordNotification<K extends NotificationKind>(port:NotificationRecordPort,event:{readonly recipientPrincipalId:string;readonly kind:K;readonly subjectReference:NotificationSubjectReference[K];readonly parameters:NotificationParameters[K];readonly dedupeKey:string},registry:NotificationKindRegistry=NOTIFICATION_REGISTRY):Promise<void>{if(!registry.accepts(event))throw new TypeError("unknown notification kind or payload");await port.record({...event,dedupeKey:event.dedupeKey})}

export class NotificationsService{
 constructor(private readonly events:NotificationEventStore,private readonly subjects:NotificationSubjectStore,private readonly authz:Pick<AuthzStore,"listGrantsForPrincipal">,readonly registry:NotificationKindRegistry=NOTIFICATION_REGISTRY){}
 /** One page of the person's feed. types narrows it to registered kinds; an unregistered type is a RangeError. */
 async list(recipient:string,page=1,types:readonly string[]=[]):Promise<NotificationPage>{
  if(!Number.isSafeInteger(page)||page<1)throw new RangeError("page must be positive");
  const kinds=this.registry.types(types);if(!kinds)throw new RangeError("unknown notification type");
  const rows=(await this.events.list(recipient,25,(page-1)*25,kinds.length?kinds:undefined)).filter(r=>this.registry.accepts(r)&&(!kinds.length||kinds.includes(r.kind)));
  const groups=new Map<string,FeedRow[]>();for(const row of rows)groups.set(row.kind,[...groups.get(row.kind)??[],row]);
  const context={recipient,subjects:this.subjects,authz:this.authz};
  const rendered=await Promise.all([...groups].map(([kind,group])=>this.registry.get(kind)!.render(group,context)));
  const lines=new Map(rendered.flatMap(m=>[...m]));
  const items=rows.flatMap((row):RenderedNotification[]=>{const line=lines.get(row.id);return line?[{id:row.id,text:line.text,href:line.href,createdAt:new Date(row.createdAt).toISOString(),read:row.readAt!==null}]:[]});
  return{items,unreadCount:items.filter(i=>!i.read).length,page}
 }
 async count(recipient:string):Promise<number>{return this.events.countVisibleUnread?this.events.countVisibleUnread(recipient):(await this.list(recipient,1)).unreadCount}
 markRead(recipient:string,id:string){return this.events.markRead(recipient,id)}
 markAllRead(recipient:string){return this.events.markAllRead(recipient)}
}
