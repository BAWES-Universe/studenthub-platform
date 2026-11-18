/** Synthetic E2 integration: real gateway/script/Postgres; fake OIDC/pusher only.
 * No live host, credentials, provider requests, cookie injection or route mocks.
 */
import assert from 'node:assert/strict';
import {randomBytes, generateKeyPairSync, createHash, sign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:https';

export async function createE2Fixture({sourceRevision = null} = {}) {
  const database = process.env.BROWSER_ACCEPTANCE_DATABASE_URL;
  assert.ok(database, 'Disposable E2 database required');
  const db = new URL(database);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(db.hostname), 'E2 database must be loopback');
  const [{default:pg}, {runMigrations}, {PostgresLoginStore}, {PostgresUniverseEmbedStore}, aa,
    {createGatewayServer}, {createUniverseEmbedConfigFromEnv}, {assertSameSiteEmbed}, {sameProviderSubjectMapping}] = await Promise.all([
    import('pg'), import('@studenthub/db'), import('@studenthub/db/access'), import('@studenthub/db/universe'), import('@bawes/actor-assertion'),
    import('../../dist/apps/gateway/src/index.js'), import('../../dist/apps/gateway/src/universe/embed-policy.js'),
    import('../../dist/apps/gateway/src/wiring/universe.js'), import('../../dist/apps/gateway/src/universe/host-identity.js'),
  ]);
  const admin = new pg.Pool({connectionString:database,connectionTimeoutMillis:10000});
  const schema = `e2_browser_${randomBytes(10).toString('hex')}`;
  let pool, server, created=false;
  const close = async () => {
    if(server) { server.closeAllConnections(); await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())); server=null; }
    if(pool) {await pool.end();pool=null;}
    try {if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);} finally {await admin.end();}
  };
  try {
    const version=Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(version>=170000&&version<180000,'PostgreSQL 17 required');
    await admin.query(`CREATE SCHEMA ${schema}`);created=true;
    db.searchParams.set('options',`-c search_path=${schema}`);
    pool=new pg.Pool({connectionString:db.href,connectionTimeoutMillis:10000});
    await runMigrations(pool);
    const login=new PostgresLoginStore(pool), store=new PostgresUniverseEmbedStore(pool);
    const jwt=generateKeyPairSync('ed25519'), publicJwk=jwt.publicKey.export({format:'jwk'});
    const pusher=await aa.generateEd25519KeyPair();
    const requests=new Map(), codes=new Map();
    const subject='universe:student:synthetic-e2', issuer='https://synthetic-issuer.invalid';
    const facts={connectCookie:false,callbackCookie:false,profileCookie:false,profileReads:0};
    let gateway, origin, parentOrigin, providerOrigin;
    const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
    const oidc={
      authorizationUrl(request) {
        assert.equal(request.redirectUri,`${origin}/login/callback`);
        const id=randomBytes(24).toString('base64url');requests.set(id,request);
        return `${providerOrigin}/authorize?id=${id}`;
      },
      async exchange(request) {
        const auth=codes.get(request.code);assert.ok(auth,'Synthetic code exists');codes.delete(request.code);
        assert.equal(request.clientId,'synthetic-e2');assert.equal(request.clientSecret,'synthetic-e2-secret');
        assert.equal(request.redirectUri,auth.redirectUri);
        assert.equal(createHash('sha256').update(request.codeVerifier).digest('base64url'),auth.codeChallenge);
        const now=Math.floor(Date.now()/1000);
        const unsigned=`${encode({alg:'EdDSA',kid:'synthetic-e2',typ:'JWT'})}.${encode({iss:issuer,aud:'synthetic-e2',sub:subject,nonce:auth.nonce,iat:now,exp:now+300,name:'Synthetic E2 Person'})}`;
        return {accessToken:'synthetic-unused',idToken:`${unsigned}.${sign(null,Buffer.from(unsigned),jwt.privateKey).toString('base64url')}`};
      },
    };
    const tls={cert:await readFile(process.env.BROWSER_ACCEPTANCE_TLS_CERT),key:await readFile(process.env.BROWSER_ACCEPTANCE_TLS_KEY)};
    server=createServer(tls,(req,res)=>{
      const host=req.headers.host?.split(':')[0];const url=new URL(req.url,'https://synthetic.invalid');
      if(host==='parent.browser.test'&&url.pathname==='/') {
        res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});
        // Only the synthetic parent uses this fixture binding. The real embed script remains untouched.
        res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Universe</title><style>body{margin:0}iframe{border:0;width:100%;height:850px}</style><iframe title="StudentHub embed" src="${origin}/universe/embed"></iframe><script>
          window.addEventListener('message',async e=>{const frame=document.querySelector('iframe');
          if(e.origin!==${JSON.stringify(origin)}||e.source!==frame.contentWindow||e.data?.type!=='studenthub.embed.identity-request')return;
          const attestation=await window.syntheticHostAttestation(e.data.challenge);
          e.source.postMessage({type:'studenthub.embed.identity',v:1,attestation},e.origin);});</script>`);return;
      }
      if(host==='provider.browser.test'&&url.pathname==='/authorize') {
        const auth=requests.get(url.searchParams.get('id'));if(!auth){res.writeHead(400);res.end();return;}
        requests.delete(url.searchParams.get('id'));const code=randomBytes(24).toString('base64url');codes.set(code,auth);
        const callback=new URL(auth.redirectUri);callback.search=new URLSearchParams({state:auth.state,code}).toString();
        res.writeHead(302,{location:callback.href,'cache-control':'no-store'});res.end();return;
      }
      if(host!=='embed.browser.test'){res.writeHead(404);res.end();return;}
      // Record booleans only; never retain header values, URLs, states or tokens.
      if(url.pathname==='/universe/embed/connect')facts.connectCookie=Boolean(req.headers.cookie?.includes('__Host-studenthub_browser='));
      if(url.pathname==='/login/callback')facts.callbackCookie=Boolean(req.headers.cookie?.includes('__Host-studenthub_browser='));
      if(url.pathname==='/universe/embed/profile')facts.profileCookie=Boolean(req.headers.cookie?.includes('__Host-studenthub_session='));
      gateway.emit('request',req,res);
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    origin=`https://embed.browser.test:${port}`;parentOrigin=`https://parent.browser.test:${port}`;providerOrigin=`https://provider.browser.test:${port}`;
    assertSameSiteEmbed('browser.test',origin,[parentOrigin]);
    const base=createUniverseEmbedConfigFromEnv({UNIVERSE_EMBED_ORIGIN:origin,UNIVERSE_EMBED_ENABLED:'true',UNIVERSE_EMBED_ANCESTORS:parentOrigin,UNIVERSE_EMBED_OIDC_CALLBACK_URL:`${origin}/login/callback`},parentOrigin);
    const runtime={store,sessions:login.sessions,
      login:{dependencies:{oidc,jwks:{async resolve(i,k){return i===issuer&&k==='synthetic-e2'?publicJwk:undefined;}},
        clock:{nowEpochSeconds:()=>Math.floor(Date.now()/1000)},entropy:{bytes:n=>randomBytes(n)},states:login.states,sessions:login.sessions,identities:login.identities,authorization:{async roleFor(){return 'self';}}},
        config:{issuer,clientId:'synthetic-e2',clientSecret:'synthetic-e2-secret',callbackUrl:`${origin}/login/callback`,allowedReturnUrls:[`${origin}/universe/embed/done`],clockSkewSeconds:5,subjectPolicy:s=>s===subject}},
      hostIdentity:{pusherIssuer:'universe-pusher@browser',audience:'studenthub-embed/identity@browser',subjectPolicy:{humanSubjectPattern:/^universe:student:synthetic-e2$/},keys:async(i,k)=>i==='universe-pusher@browser'&&k==='synthetic-e2'?pusher.publicKeyPem:undefined,replay:new aa.MemoryReplayStore()},
      mapping:sameProviderSubjectMapping(issuer,(person,i)=>store.identitySubjects(person,i)),
      profiles:{async read(person){const identity=await login.identities.findBySubject(issuer,subject);assert.equal(person,identity?.personId,'Profile owner matches login identity');facts.profileReads++;return {state:'populated',fields:[{key:'displayName',value:'Synthetic E2 Person',source:'imported_snapshot'}]};}},
    };
    gateway=createGatewayServer(undefined,undefined,undefined,undefined,sourceRevision,undefined,undefined,undefined,undefined,undefined,{...base,runtime});
    return {origin,parentOrigin,facts,close,
      async attest(challenge){assert.match(challenge,/^[A-Za-z0-9_-]{43}$/);const now=Math.floor(Date.now()/1000);return aa.signAssertion({v:1,iss:'universe-pusher@browser',kid:'synthetic-e2',aud:'studenthub-embed/identity@browser',sub:subject,iat:now,exp:now+60,jti:challenge},pusher.privateKeyPem);},
    };
  } catch(error) {await close();throw error;}
}
