import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Metadata } from '../../../packages/private-documents/src/index.js';
import type { CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { wantsHtml } from './web-ui.js';
export type ProfileAvatarRead={readonly documents:readonly Metadata[];readonly avatarUrl?:string};
const context=new AsyncLocalStorage<IncomingMessage>(),reads=new Map<IncomingMessage,ProfileAvatarRead>();
const credential=(r:IncomingMessage)=>{const v=(r.headers.cookie?.split(';')??[]).map(x=>x.trim()).filter(x=>x.startsWith('__Host-studenthub_session='));return v.length===1?/^__Host-studenthub_session=([A-Za-z0-9_-]{43})$/.exec(v[0]!)?.[1]:undefined;};
export async function prepareProfileAvatar(request:IncomingMessage,response:ServerResponse,service?:CandidateDocuments):Promise<void>{if(request.method!=='GET'||(request.url??'').split('?')[0]!=='/profile'||!wantsHtml(request.headers.accept)||!service)return;context.enterWith(request);const session=credential(request);if(!session)return;const cleanup=()=>reads.delete(request);response.once('finish',cleanup);response.once('close',cleanup);const documents=await service.list(session).catch(()=>undefined);if(!documents)return;const photo=documents.find(row=>row.type==='personal-photo');const avatarUrl=photo?await service.issueDelivery(session,photo.id).then(v=>v.url).catch(()=>undefined):undefined;if(response.writableEnded||response.destroyed)return;reads.set(request,{documents,...(avatarUrl?{avatarUrl}:{})});}
export function currentProfileAvatar():ProfileAvatarRead|undefined{const request=context.getStore();return request?reads.get(request):undefined;}
