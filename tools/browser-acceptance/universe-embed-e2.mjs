/** E2 browser proof, distinct from inert E1. No cookie/header injection. */
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {E2CaseFailure} from './e2-safe-progress.mjs';
export const universeEmbedE2Names = [
  ...['en','ar'].flatMap(language=>[320,390].map(width=>`universe-e2-signin-return-${language}-${width}`)),
  'universe-e2-cancel-retry-en',
  'universe-e2-cancel-retry-ar',
  'universe-e2-copied-url',
  'universe-e2-cross-site-startup-refused',
];

export async function crossSiteStartupRefused() {
  const [{wireUniverse}, {createUniverseEmbedConfigFromEnv}] = await Promise.all([
    import('../../dist/apps/gateway/src/wiring/universe.js'),
    import('../../dist/apps/gateway/src/universe/embed-policy.js'),
  ]);
  const origin='https://embed.browser.test';
  const config=createUniverseEmbedConfigFromEnv({UNIVERSE_EMBED_ENABLED:'true',UNIVERSE_EMBED_ORIGIN:origin,
    UNIVERSE_EMBED_ANCESTORS:'https://parent.other.test',UNIVERSE_EMBED_OIDC_CALLBACK_URL:`${origin}/login/callback`},'https://parent.browser.test');
  // All prerequisite fields valid, including keys; rejection is due to topology.
  const env={UNIVERSE_EMBED_PUSHER_ISSUER:'universe-pusher@browser',UNIVERSE_EMBED_PUSHER_KEYS:JSON.stringify({'synthetic-e2':generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'})}),
    UNIVERSE_EMBED_IDENTITY_AUDIENCE:'studenthub-embed/identity@browser',UNIVERSE_EMBED_HOST_SUBJECT_FORMAT:'user_email',
    UNIVERSE_EMBED_HOST_MAPPING:'same_provider_subject',UNIVERSE_EMBED_SITE:'browser.test',
    DATABASE_URL:'postgresql://unused@127.0.0.1:1/unused',OIDC_ISSUER:'https://provider.browser.test',
    OIDC_CLIENT_ID:'synthetic',OIDC_CLIENT_SECRET:'synthetic',OIDC_AUTHORIZATION_URL:'https://provider.browser.test/authorize',
    OIDC_TOKEN_URL:'https://provider.browser.test/token',OIDC_JWKS_URL:'https://provider.browser.test/keys'};
  // Exercise the exact guard and its production wiring call separately.
  const {assertSameSiteEmbed}=await import('../../dist/apps/gateway/src/wiring/universe.js');
  assert.doesNotThrow(()=>assertSameSiteEmbed('browser.test',origin,['https://parent.browser.test']));
  assert.throws(()=>assertSameSiteEmbed('browser.test',origin,config.ancestors),/Invalid Universe embed E2 configuration/);
  await assert.rejects(async()=>{const wired=await wireUniverse(env,config,{readOwn:async()=>{throw Error('unused');}});await wired.close();},/Invalid Universe embed E2 configuration/);
  return {unsupportedTopologyRefused:true,liveEnablement:false};
}

export async function runUniverseEmbedE2(options) { return runE2Cases(options,universeEmbedE2Names); }
// Diagnostic caller is separate; the required matrix never accepts a filter.
export async function runOneE2Diagnostic(options,name) {
  assert.ok(universeEmbedE2Names.includes(name),'Known E2 diagnostic case required');
  return runE2Cases(options,[name]);
}
async function runE2Cases({browser,run,screenshot,sourceRevision},names) {
  if(names.includes('universe-e2-cross-site-startup-refused'))await run('universe-e2-cross-site-startup-refused',crossSiteStartupRefused);
  const {createE2Fixture}=await import('./universe-embed-e2-fixture.mjs');
  for(const name of names.filter(n=>n!=='universe-e2-cross-site-startup-refused')) {
    await run(name,async()=>{
      const cancelLanguage=/cancel-retry-(en|ar)$/.exec(name)?.[1];
      let stage='fixture',fixture,context;
      try {
        fixture=await createE2Fixture({sourceRevision,cancelFirstAuthorization:Boolean(cancelLanguage)});
        stage='context';
        const match=/signin-return-(en|ar)-(320|390)$/.exec(name);
        const language=match?.[1]??cancelLanguage??'en',width=Number(match?.[2]??390);
        context=await browser.newContext({viewport:{width,height:900},locale:language,serviceWorkers:'block'});
        await context.exposeBinding('syntheticHostAttestation',async({page,frame},challenge)=>{
          assert.equal(frame,page.mainFrame(),'Only the synthetic parent can request an attestation');
          assert.equal(new URL(frame.url()).origin,fixture.parentOrigin,'Synthetic parent origin');
          return fixture.attest(challenge);
        });
        const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(15000);
        if(!match && !cancelLanguage) {
          stage='copied-url';
          await page.goto(`${fixture.origin}/universe/embed`);
          assert.ok((await page.locator('body').innerText()).includes('Open this in Universe'));
          assert.equal(await page.locator('#profile').count(),0);
          assert.equal((await context.cookies()).length,0,'Copied URL creates no cookies');
          return {copiedUrlHasNoProfile:true};
        }
        stage='parent';
        await page.goto(`${fixture.parentOrigin}/`);
        const frame=page.frameLocator('iframe');
        stage='signed-out';
        await frame.locator('body[data-state="signed_out"]').waitFor();
        assert.equal(fixture.facts.profileReads,0,'No profile read before sign-in and host verification');
        if(cancelLanguage){
          stage='cancel-open';
          const canceledPopupPromise=context.waitForEvent('page');
          canceledPopupPromise.catch(()=>{});
          await frame.locator('#connect button').click();
          const canceledPopup=await canceledPopupPromise;
          stage='cancel-provider';
          await canceledPopup.getByRole('heading',{name:'Finish synthetic sign-in',exact:true}).waitFor();
          // Use native tab focus/close only. Never dispatch visibility events,
          // navigate/reload the app, or call its APIs to manufacture recovery.
          await canceledPopup.bringToFront();
          assert.equal(fixture.facts.callbacks,0,'Canceled attempt never reached callback');
          assert.equal(fixture.facts.exchanges,0,'Canceled attempt never exchanged a code');
          assert.equal(fixture.facts.profileReads,0,'Canceled attempt never read profile');
          assert.deepEqual(await fixture.recoveryCounts(),{sessions:0,handoffs:{pending:1}});
          stage='cancel-return';
          await canceledPopup.close();await page.bringToFront();
          await frame.locator('body[data-state="signed_out"]').waitFor();
          assert.equal(await frame.locator('#profile').innerText(),'','Canceled attempt leaves no profile');
          stage='retry-control';
          await frame.locator('#connect button').waitFor({state:'visible'});
        }
        stage='login-open';
        const popupPromise=context.waitForEvent('page');
        popupPromise.catch(()=>{});
        await frame.locator('#connect button').click();
        const popup=await popupPromise;
        stage='login-callback';
        await popup.waitForURL(`${fixture.origin}/universe/embed/done`);
        await popup.waitForLoadState('domcontentloaded');
        // Native tab return only: do not dispatch a synthetic visibility event,
        // reload to hide a stuck waiting state, or inject authenticated cookies.
        stage='native-return';
        await popup.close();await page.bringToFront();
        stage='profile';
        await frame.locator('body[data-state="populated"]').waitFor();
        stage='assertions';
        assert.ok((await frame.locator('#profile').innerText()).includes('Synthetic E2 Person'));
        assert.ok((await frame.locator('#profile').innerText()).includes(language==='ar'?'من سجلك في StudentHub':'From your StudentHub record'));
        assert.equal(await frame.locator('html').getAttribute('lang'),language);
        assert.equal(await frame.locator('html').getAttribute('dir'),language==='ar'?'rtl':'ltr');
        assert.ok(await frame.locator('html').evaluate(el=>el.scrollWidth<=innerWidth+1),'No iframe overflow');
        assert.ok(await page.locator('html').evaluate(el=>el.scrollWidth<=innerWidth+1),'No parent overflow');
        assert.equal(fixture.facts.connectCookie,true,'Native cookie delivered on form POST');
        assert.equal(fixture.facts.callbackCookie,true,'Native cookie delivered on callback');
        assert.equal(fixture.facts.profileCookie,true,'Native session cookie delivered on iframe profile read');
        if(cancelLanguage){
          assert.equal(fixture.facts.authorizations,2,'Retry starts a fresh authorization');
          assert.equal(fixture.facts.callbacks,1,'Exactly one callback completes');
          assert.equal(fixture.facts.exchanges,1,'Exactly one code exchanged');
          assert.deepEqual(await fixture.recoveryCounts(),{sessions:1,handoffs:{superseded:1,consumed:1}});
        }
        stage='screenshot';
        return {...(cancelLanguage?{cancelRecovery:true,freshLogin:true,singleCompletion:true}:{}),screenshot:await screenshot(page,name),nativeCookies:true,realGateway:true,realPostgres:true,
          returnMode:'native tab close and foreground; no reload or synthetic visibility event',syntheticOidcAndPusher:true,liveEnablement:false};
      } catch(error) {throw new E2CaseFailure(stage,error,fixture?.facts);}
      finally {if(context)await context.close();if(fixture)await fixture.close();}
    });
  }
}
