import type {LoginApplication} from "@studenthub/login-contract";
import type {NotificationPage,NotificationsService} from "../../../packages/notifications/src/notifications.js";
export type NotificationsResult={readonly status:200;readonly body:NotificationPage}|{readonly status:401|404;readonly body:{readonly error:"not_found"}}|{readonly status:503;readonly body:{readonly error:"unavailable"}};
export interface NotificationsHttp{open(sessionId:string|undefined,page:number):Promise<NotificationsResult>;count(sessionId:string|undefined):Promise<number>;read(sessionId:string|undefined,id:string):Promise<{status:204|401|404}>;readAll(sessionId:string|undefined):Promise<{status:204|401}>}
export function createNotificationsHttp(login:Pick<LoginApplication,"profile">,service:NotificationsService):NotificationsHttp{
 const principal=async(sessionId:string|undefined)=>sessionId?await login.profile({sessionId}):{status:401 as const,body:{}};
 return{
  async open(session,page){const p=await principal(session);if(p.status===503)return{status:503,body:{error:"unavailable"}};const personId=(p.body as {personId?:string}).personId;if(!personId)return{status:401,body:{error:"not_found"}};const [body,unreadCount]=await Promise.all([service.list(personId,page),service.count(personId)]);return{status:200,body:{...body,unreadCount}}},
  async count(session){const p=await principal(session),personId=(p.body as {personId?:string}).personId;return p.status===200&&personId?service.count(personId):0},
  async read(session,id){const p=await principal(session),personId=(p.body as {personId?:string}).personId;if(p.status!==200||!personId)return{status:401};return{status:await service.markRead(personId,id)?204:404}},
  async readAll(session){const p=await principal(session),personId=(p.body as {personId?:string}).personId;if(p.status!==200||!personId)return{status:401};await service.markAllRead(personId);return{status:204}}
 };
}
