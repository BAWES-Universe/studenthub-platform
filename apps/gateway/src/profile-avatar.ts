import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import type { CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import type { Metadata } from '../../../packages/private-documents/src/index.js';

export interface ProfileAvatarRead { readonly documents: readonly Metadata[]; readonly avatarUrl?: string }
const renderAvatar = new AsyncLocalStorage<Promise<ProfileAvatarRead | undefined>>();
function acceptsHtml(value: string | undefined): boolean {
  const qualities = new Map<string, number>();
  for (const part of value?.toLowerCase().split(',') ?? []) {
    const [mime, ...parameters] = part.trim().split(';');
    const q = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    if (mime && Number.isFinite(quality) && quality >= 0 && quality <= 1) qualities.set(mime, Math.max(qualities.get(mime) ?? 0, quality));
  }
  const html = qualities.get('text/html') ?? 0;
  return html > 0 && html > (qualities.get('application/json') ?? 0);
}

export async function readProfileAvatar(service: CandidateDocuments, credential: string): Promise<ProfileAvatarRead> {
  const documents = await service.list(credential);
  const photo = documents.find(document => document.type === 'personal-photo');
  if (!photo) return { documents };
  return { documents, avatarUrl: (await service.issueDelivery(credential, photo.id)).url };
}
export function prepareProfileAvatar(request: IncomingMessage, service?: CandidateDocuments): void {
  if (request.method !== 'GET' || (request.url ?? '').split('?')[0] !== '/profile' || !acceptsHtml(request.headers.accept)) return;
  const matches = (request.headers.cookie?.split(';') ?? []).map(value => value.trim()).filter(value => value.startsWith('__Host-studenthub_session='));
  const credential = matches.length === 1 ? /^__Host-studenthub_session=([A-Za-z0-9_-]{43})$/.exec(matches[0]!)?.[1] : undefined;
  if (credential && service) renderAvatar.enterWith(readProfileAvatar(service, credential).catch(() => undefined));
}
export async function currentProfileAvatarUrl(): Promise<string | undefined> { return (await renderAvatar.getStore())?.avatarUrl; }
