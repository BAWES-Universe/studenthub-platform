import pg from "pg";
import {databaseUrl} from "./connection.js";
type Status="active"|"under_review"|"inactive"|"none";
export interface StoredNotification{readonly id:string;readonly recipientPrincipalId:string;readonly kind:"organization.status_changed";readonly subjectReference:`organization:${string}`;readonly parameters:{readonly status:Status};readonly createdAt:Date|string;readonly readAt:Date|string|null}
type Client=Pick<pg.PoolClient,"query">;
export async function recordOrganizationStatusChanged(client:Client,orgId:string,status:Status,dedupeKey:string):Promise<void>{
 await client.query(`INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key)
 SELECT DISTINCT principal_id,'organization.status_changed',$2,$3::jsonb,$4 FROM grants
 WHERE org_id=$1 AND role='org-owner'
 ON CONFLICT(recipient_principal_id,dedupe_key) DO NOTHING`,[orgId,`organization:${orgId}`,JSON.stringify({status}),dedupeKey]);
}
export class PostgresNotificationsStore{
 readonly #pool:pg.Pool;readonly #owns:boolean;
 constructor(options:{readonly pool?:pg.Pool;readonly connectionString?:string}={}){this.#owns=!options.pool;this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()})}
 async close(){if(this.#owns)await this.#pool.end()}
 async record(event:{recipientPrincipalId:string;kind:"organization.status_changed";subjectReference:`organization:${string}`;parameters:{status:Status};dedupeKey:string}){await this.#pool.query(`INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(recipient_principal_id,dedupe_key) DO NOTHING`,[event.recipientPrincipalId,event.kind,event.subjectReference,JSON.stringify(event.parameters),event.dedupeKey])}
 async list(recipient:string,limit:number,offset:number):Promise<StoredNotification[]>{const {rows}=await this.#pool.query<{id:string;recipient_principal_id:string;kind:"organization.status_changed";subject_reference:`organization:${string}`;parameters:{status:Status};created_at:Date;read_at:Date|null}>(`SELECT id,recipient_principal_id,kind,subject_reference,parameters,created_at,read_at FROM notifications WHERE recipient_principal_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,[recipient,limit,offset]);return rows.map(r=>({id:r.id,recipientPrincipalId:r.recipient_principal_id,kind:r.kind,subjectReference:r.subject_reference,parameters:r.parameters,createdAt:r.created_at,readAt:r.read_at}))}
 async countVisibleUnread(recipient:string){const {rows}=await this.#pool.query<{n:number}>(`SELECT count(*)::int n FROM notifications n JOIN organizations o ON n.subject_reference='organization:'||o.id LEFT JOIN organization_deletions d ON d.org_id=o.id WHERE n.recipient_principal_id=$1 AND n.read_at IS NULL AND d.org_id IS NULL AND EXISTS(SELECT 1 FROM grants g WHERE g.principal_id=$1 AND (g.org_id=o.id OR g.scope='subtree' AND g.org_id IN (WITH RECURSIVE ancestors AS (SELECT parent_org_id id FROM organizations WHERE id=o.id UNION ALL SELECT x.parent_org_id FROM organizations x JOIN ancestors a ON x.id=a.id WHERE x.parent_org_id IS NOT NULL) SELECT id FROM ancestors)))`,[recipient]);return rows[0]?.n??0}
 async markRead(recipient:string,id:string){const r=await this.#pool.query("UPDATE notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE recipient_principal_id=$1 AND id=$2",[recipient,id]);return(r.rowCount??0)>0}
 async markAllRead(recipient:string){await this.#pool.query("UPDATE notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE recipient_principal_id=$1 AND read_at IS NULL",[recipient])}
 async readOrganizations(ids:readonly string[]){if(!ids.length)return[];const {rows}=await this.#pool.query<{id:string;name:string;parent_org_id:string|null}>("SELECT id,name,parent_org_id FROM organizations WHERE id=ANY($1::text[])",[ids]);return rows.map(r=>({id:r.id,name:r.name,...(r.parent_org_id?{parentOrgId:r.parent_org_id}:{})}))}
 async liveOrganizationIds(ids:readonly string[]){if(!ids.length)return new Set<string>();const {rows}=await this.#pool.query<{id:string}>("SELECT o.id FROM organizations o LEFT JOIN organization_deletions d ON d.org_id=o.id WHERE o.id=ANY($1::text[]) AND d.org_id IS NULL",[ids]);return new Set(rows.map(r=>r.id))}
}
