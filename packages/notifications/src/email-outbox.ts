import type {PoolClient} from "pg";
import {EMAIL_TEMPLATES,validateTemplateParameters,type EmailClass}from"./email-templates.js";
import type{EmailFailureCode,EmailPort}from"./email-port.js";
export async function enqueueEmail(client:PoolClient,messageClass:EmailClass,recipientPrincipalId:string,parameters:Readonly<Record<string,string>>,idempotencyKey:string):Promise<string>{validateTemplateParameters(messageClass,parameters);const row=await client.query<{id:string}>("INSERT INTO email_outbox(class,recipient_principal_id,template_parameters,idempotency_key) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id",[messageClass,recipientPrincipalId,JSON.stringify(parameters),idempotencyKey]);return row.rows[0]!.id}
export interface DeliveryStore{deliverBatch(port:EmailPort,production:boolean,limit?:number):Promise<number>}
export function createEmailDeliveryJob(store:DeliveryStore,port:EmailPort,production:boolean){return async(_signal:AbortSignal)=>{try{return await store.deliverBatch(port,production)}catch(error){throw new Error("email delivery failed")}}}
export function shouldSuppressEmail(enabled:boolean|null,required:boolean):boolean{return enabled===false&&!required}
export type{EmailClass,EmailFailureCode};
