import assert from 'node:assert/strict';
import test from 'node:test';
import { inSpan, newSpan } from '../../../packages/observability/src/index.js';
const avatarModule=process.env.SHU549_AVATAR_MODULE??new URL('../src/profile-avatar.js',import.meta.url).href;
const {readProfileAvatar,prepareProfileAvatar,currentProfileAvatarUrl}=await import(avatarModule) as typeof import('../src/profile-avatar.js');

test('Q14_2_AVATAR lists once and mints only the personal photo delivery', async () => {
  let lists = 0, deliveries = 0;
  const service = {
    async list() { lists++; return [{id:'cv-id',version:'version',type:'resume',mime:'application/pdf',size:8},{id:'photo-id',version:'version',type:'personal-photo',mime:'image/png',size:8}]; },
    async issueDelivery(_credential:string,id:string) { deliveries++; assert.equal(id,'photo-id'); return {url:'https://student.test/private-documents/delivery?t=signed',expiresAt:60}; },
  };
  const result = await readProfileAvatar(service as never, 'session');
  assert.equal(result.avatarUrl, 'https://student.test/private-documents/delivery?t=signed');
  assert.equal(result.documents.length, 2); assert.equal(lists, 1); assert.equal(deliveries, 1);
});

test('Q14_2_SHOWN no photo costs one list and no delivery', async () => {
  let deliveries = 0;
  const result = await readProfileAvatar({ list: async()=>[], issueDelivery:async()=>{deliveries++;throw new Error('unexpected');} } as never, 'session');
  assert.deepEqual(result.documents, []); assert.equal(result.avatarUrl, undefined); assert.equal(deliveries, 0);
});

test('Q14_2_AVATAR delivery failure is a best-effort empty avatar', async () => {
  await inSpan(newSpan(), async () => {
    prepareProfileAvatar({ method:'GET', url:'/profile', headers:{ accept:'text/html ;q=1', cookie:`__Host-studenthub_session=${'s'.repeat(43)}` } } as never, {
      async list() { return [{id:'photo-id',version:'version',type:'personal-photo',mime:'image/png',size:8}]; },
      async issueDelivery() { throw new Error('unavailable'); },
    } as never);
    assert.equal(await currentProfileAvatarUrl(), undefined);
  });
});
