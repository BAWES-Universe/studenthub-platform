/** Real browser + real gateway/Postgres acceptance. Never record tokens, HTML, HAR or traces. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const output = path.resolve(process.env.BROWSER_ACCEPTANCE_ARTIFACTS || process.env.BROWSER_ARTIFACT_DIR || 'artifacts/browser-acceptance');
const phoneRecoveryStates=['conflict-reentry','status-read-only','same-phone-retry','changed-phone-rejected'];
const backgroundRecoveryNames=['en','ar'].flatMap(language=>['education','experience','skill','link'].map(kind=>`background-draft-recovery-${kind}-${language}`));
const names = [
  ...['en','ar'].flatMap(language => [320,390,1280].map(width => `layout-${language}-${width}`)),
  ...['en','ar'].flatMap(language => [320,390,1280].map(width => `editor-error-${language}-${width}`)),
  'arabic-save-clear', 'arabic-conflict', 'arabic-recovery',
  'keyboard-disclosure-accessible-controls', 'one-field-save-and-clear', 'invalid-phone-non-echo',
  'invalid-name-error-focus', 'nationality-mother-eligibility', 'native-radio-validation', 'conflict-fresh-state', 'cancel-back-forward', 'repeated-submission',
  'two-tab-notice-overwrite-clear', 'session-revocation', 'session-expiry',
  'committed-response-loss', 'uncertain-commit-status-read-only', 'uncertain-commit-exact-retry',
  'uncertain-commit-changed-draft-rejected', 'actual-token-expiry',
  ...['empty','finalized'].flatMap(state => ['en','ar'].flatMap(language => [320,390,1280].map(width => `documents-${state}-${language}-${width}`))),
  'documents-navigation-enabled', 'documents-navigation-disabled',
  'documents-keyboard-history-en', 'documents-keyboard-history-ar',
  'documents-session-missing', 'documents-session-revocation', 'documents-session-expiry',
  'documents-unavailable-en', 'documents-unavailable-ar', 'documents-person-isolation',
  ...['en','ar'].flatMap(language => [320,390,1280].map(width => `language-review-confirm-reload-${language}-${width}`)),
  ...['en','ar'].flatMap(language => ['cancel-history-safe-review','stale-two-tabs','single-use-confirm','invalid-value','preview-unavailable','confirm-rollback','confirm-acknowledgement-loss','token-expiry'].map(state => `language-${state}-${language}`)),
  ...['en','ar'].flatMap(language => ['missing-preview','revoked-confirm','expired-confirm'].map(state => `language-session-${state}-${language}`)),
  ...['en','ar'].flatMap(language => phoneRecoveryStates.map(state => `phone-recovery-${state}-${language}`)),
  ...backgroundRecoveryNames,
];
const bfcacheScenarios=['cancel','revoked-session','intervening-language'];
const bfcacheNames=['en','ar'].flatMap(language=>bfcacheScenarios.map(scenario=>`bfcache-language-${scenario}-${language}`));
const evidence = { schemaVersion:1, syntheticOnly:true, candidateSha:null, playwrightVersion:null,
  chromiumVersion:null, expectedChromiumVersion:null, chromiumRevision:null, startedAt:new Date().toISOString(), cases:[...names,...bfcacheNames].map(name=>({name,status:'NOT_RUN'})),
  policy:'Synthetic data only. No cookies, hidden tokens, credentials, HTML dumps, traces or HAR recorded. TLS verification enabled.' };
let browser, fixture, bfcacheBrowser;
const contexts = new Set();
const restorers = [];
let setupStage='candidate-check';
const check = (condition, label) => assert.ok(condition, label);
async function visible(locator) { check(await locator.isVisible(), 'Required visible DOM element missing'); }
async function textIncludes(page, text) { check((await page.locator('body').innerText()).includes(text), 'Required visible state missing'); }
async function noOverflow(page) {
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Document horizontal overflow');
  check(await page.locator('.p-card').evaluateAll(nodes => nodes.every(n=>n.scrollWidth <= n.clientWidth + 1)), 'Card content overflow');
}
async function screenshot(page, name) {
  await page.screenshot({path:path.join(output,`${name}.png`),fullPage:true,animations:'disabled'});
  return `${name}.png`;
}
async function subject(options={}) {
  const actor = await fixture.seedActor(options);
  const context = await browser.newContext({viewport:{width:options.width || 390,height:900},serviceWorkers:'block'});
  contexts.add(context);
  await context.addCookies([actor.cookie]);
  const page = await context.newPage();
  await page.goto(`${fixture.baseURL}/profile`);
  await visible(page.locator('#profile-heading'));
  return {actor,context,page};
}
const documentSlots=['personal-photo','resume','civil-id-front','civil-id-back'];
const documentCopy={
  en:{title:'My documents',onFile:'On file',missing:'Not uploaded',accepted:'Accepted formats',maximum:'Maximum size',bytes:'bytes',unavailable:'Documents are temporarily unavailable. Please try again.',labels:['Personal photo','CV','Civil ID front','Civil ID back']},
  ar:{title:'مستنداتي',onFile:'محفوظ',missing:'لم يتم الرفع',accepted:'الصيغ المقبولة',maximum:'الحجم الأقصى',bytes:'بايت',unavailable:'المستندات غير متاحة مؤقتًا. يرجى المحاولة مرة أخرى.',labels:['الصورة الشخصية','السيرة الذاتية','البطاقة المدنية (الوجه الأمامي)','البطاقة المدنية (الوجه الخلفي)']},
};
async function documentPage(page,language,metadata) {
  const copy=documentCopy[language];
  await visible(page.getByRole('heading',{level:1,name:copy.title,exact:true}));
  assert.equal(await page.locator('html').getAttribute('lang'),language,'Documents trusted language');
  assert.equal(await page.locator('html').getAttribute('dir'),language==='ar'?'rtl':'ltr','Documents direction');
  assert.equal(await page.locator('main dl > div').count(),4,'Exactly four document slots');
  for(const [index,type] of documentSlots.entries()) {
    const slot=page.locator(`#document-${type}`), uploaded=metadata && type==='personal-photo';
    await visible(slot);
    assert.equal(await slot.locator('dt').innerText(),copy.labels[index],'Localized document label');
    assert.equal(await slot.locator('strong').innerText(),uploaded?copy.onFile:copy.missing,'Truthful finalized slot state');
    const detail=await slot.locator('.p-meta').innerText();
    if(uploaded) assert.equal(detail,`PNG · ${metadata.size} ${copy.bytes}`,'Finalized format and exact byte size');
    else {
      check(detail.includes(copy.accepted) && detail.includes(copy.maximum),'Missing slot explains accepted format and maximum');
      check(detail.includes(type==='resume'?'PDF':'PNG, JPEG') && detail.includes('10 MiB'),'Guidance matches current admission');
    }
  }
  for(const type of documentSlots) {
    const uploaded=metadata && type==='personal-photo';
    const form=page.locator(`#document-${type} form[enctype="multipart/form-data"]`);
    assert.equal(await form.count(),1,'Exactly one upload form per slot');
    assert.equal(await form.getAttribute('method'),'post');
    assert.equal(await form.getAttribute('enctype'),'multipart/form-data');
    assert.equal(await form.getAttribute('action'),`/profile/documents/${type}/upload`);
    assert.equal(await form.locator('input[type="file"][name="file"]').count(),1);
    assert.equal(await form.locator('input[type="hidden"][name="submission"]').count(),1);
    assert.equal(await form.locator('button[type="submit"]').count(),1);
    assert.equal(await page.locator(`#document-${type} a[href="/profile/documents/${type}/remove"]`).count(),uploaded?1:0,'Remove exists only for an on-file slot');
    assert.equal(await page.locator(`#document-${type} form[action="/profile/documents/${type}/view"]`).count(),uploaded?1:0,'View POST exists only for an on-file slot');
  }
  assert.equal(await page.locator('main time, main a[href*="candidate-documents"], main a[href*="private-documents"]').count(),0,'Page has no delivery links or dates');
  const shown=await page.locator('main').innerText();
  check(!/Date unavailable|https?:\/\/|uploads\//.test(shown),'No document dates or storage URLs displayed');
  if(metadata) {
    check(!shown.includes(metadata.id) && !shown.includes(metadata.version),'No document IDs or versions displayed');
    check(await page.locator('main').evaluate((node,values)=>!values.some(value=>node.outerHTML.includes(value)),[metadata.id,metadata.version]),'No document identifiers leaked into DOM attributes');
  }
  await noOverflow(page);
}
async function edit(page, field) {
  await page.goto(`${fixture.baseURL}/profile/edit/${field}`);
  await visible(page.locator('#profile-edit-form'));
}
async function submit(page, button) {
  const [response]=await Promise.all([page.waitForNavigation({waitUntil:'load'}),button.click()]);
  return response;
}
async function save(page) { return submit(page,page.locator('#profile-edit-form button[type=submit]')); }
async function saved(page) { await visible(page.locator('#profile-heading')); await visible(page.locator('#profile-notice')); }
async function counts(actor, receipts, writes) {
  const state=await fixture.inspect(actor);
  assert.equal(state.receiptCount,receipts,'Unexpected durable receipt count');
  assert.equal(state.writeCount,writes,'Unexpected durable field write count');
  return state;
}
// Submit the untouched form through the browser's native navigation path. CSP
// deliberately disallows fetch; no CSP bypass or fabricated save response is used.
// The source document remains open, retaining the exact original signed form.
let replayTargetSequence=0;
async function nativeReplay(source,{expectLoss=false,holdRedirect=false}={}) {
  const name=`acceptance-save-${++replayTargetSequence}`;
  const popupReady=source.waitForEvent('popup');
  await source.evaluate(name=>{window.open('about:blank',name);},name);
  const target=await popupReady;
  await target.waitForLoadState('load');
  await source.locator('#profile-edit-form').evaluate((form,name)=>{form.target=name;},name);
  let releaseRedirect;
  let markHeld, rejectHeld;
  const held=new Promise((resolve,reject)=>{markHeld=resolve; rejectHeld=reject;});
  // Interception may fail before the main flow starts awaiting this promise.
  held.catch(()=>{});
  if(holdRedirect) {
    // Playwright route() handles only the first URL in a redirect chain.
    // Chromium Fetch interception also sees the actual subsequent GET, without
    // inventing responses, changing headers, or relaxing the production CSP.
    const cdp=await source.context().newCDPSession(target);
    let pausedRequestId, disposed=false;
    const paused=event=>{
      const url=new URL(event.request.url);
      if(event.request.method==='GET' && url.origin===new URL(fixture.baseURL).origin && url.pathname==='/profile') {
        pausedRequestId=event.requestId;
        markHeld();
      } else {
        cdp.send('Fetch.continueRequest',{requestId:event.requestId}).catch(()=>rejectHeld(new Error('Could not continue native browser request')));
      }
    };
    cdp.on('Fetch.requestPaused',paused);
    releaseRedirect=async()=>{
      if(disposed) return;
      disposed=true;
      try {
        if(pausedRequestId) await cdp.send('Fetch.failRequest',{requestId:pausedRequestId,errorReason:'Aborted'});
      } finally {
        // Always restore normal networking, including assertion/setup failures.
        await cdp.send('Fetch.disable').catch(()=>{});
        cdp.off('Fetch.requestPaused',paused);
        await cdp.detach().catch(()=>{});
      }
    };
    restorers.push(releaseRedirect);
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:`${fixture.baseURL}/profile*`,requestStage:'Request'}]});
  }
  const isSave=request=>request.method()==='POST' && new URL(request.url()).pathname.endsWith('/save');
  const resultReady=expectLoss
    ? target.waitForEvent('requestfailed',{predicate:isSave,timeout:15000}).then(()=>({transportLost:true}),()=>assert.fail('Native POST did not expose a transport failure within 15 seconds'))
    : target.waitForResponse(response=>isSave(response.request()),{timeout:15000}).then(response=>({status:response.status()}),()=>assert.fail('Native Save did not receive an HTTP response within 15 seconds'));
  resultReady.catch(()=>{}); // The click can fail before its listener is awaited.
  const navigation=target.waitForNavigation({waitUntil:'load',timeout:30000}).then(response=>({response}),error=>({navigationFailed:error?.name!=='TimeoutError',navigationTimedOut:error?.name==='TimeoutError'}));
  await source.locator('#profile-edit-form button[type=submit]').click({noWaitAfter:true});
  const result=await resultReady;
  if(holdRedirect) {
    assert.equal(result.status,303,'Native save emits real HTTP303 before deferred GET');
    let timer;
    try {
      await Promise.race([held,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Redirect GET interception timed out')),15000);})]);
    } finally {clearTimeout(timer);}
    return {...result,page:target,stopRedirect:async()=>{await releaseRedirect(); await navigation;}};
  }
  const outcome=await navigation;
  if(expectLoss) {
    check(!outcome.navigationTimedOut,'Transport-loss navigation must fail, not time out');
    check(outcome.navigationFailed,'Transport loss interrupts real browser navigation');
  }
  else {assert.equal(result.status,303,'Native save emits real HTTP303'); check(outcome.response?.status()===200,'Native save reaches rendered profile');}
  return {...result,page:target};
}
// Language acceptance uses native forms, real database state and closed evidence.
const languageForm='form[action="/profile/language/preview"]';
const languageConfirm='form[action="/profile/language/confirm"]';
const otherLanguage=language=>language==='en'?'ar':'en';
const languageCopy={
  en:{review:'Review language change',confirm:'Confirm change',cancel:'Cancel',label:'Language',en:'English',ar:'Arabic',notChanged:'Your language wasn’t changed.',conflict:'Your profile changed while you were reviewing. Open it again and retry.',unavailable:'The profile service is unavailable. Please try again in a moment.',invalid:'This change is no longer available.',unknownHeading:'Your language change wasn’t confirmed.',unknown:'We couldn’t confirm whether your language was changed. Open your profile to check before trying again.',updated:'Updated by you on '},
  ar:{review:'مراجعة تغيير اللغة',confirm:'تأكيد التغيير',cancel:'إلغاء',label:'اللغة',en:'الإنجليزية',ar:'العربية',notChanged:'لم يتم تغيير لغتك.',conflict:'تغيّر ملفك الشخصي أثناء المراجعة. افتحه مجددًا وأعد المحاولة.',unavailable:'خدمة الملف الشخصي غير متاحة. يرجى المحاولة مجددًا بعد قليل.',invalid:'لم يعد هذا التغيير متاحًا.',unknownHeading:'لم يتم تأكيد تغيير اللغة.',unknown:'تعذّر التأكد مما إذا كانت لغتك قد تغيّرت. افتح ملفك الشخصي للتحقق قبل المحاولة مجددًا.',updated:'آخر تحديث منك في '},
};
async function languageLocale(page,language) {
  assert.equal(await page.locator('html').getAttribute('lang'),language,'Language flow uses trusted current locale');
  assert.equal(await page.locator('html').getAttribute('dir'),language==='ar'?'rtl':'ltr','Language flow direction follows trusted locale');
}
async function languagePost(page,selector,{target=page,expectedStatus}={}) {
  const preview=selector===languageForm;
  const route=preview?'/profile/language/preview':'/profile/language/confirm';
  // Existing case expectations name the rendered error. A valid Preview now
  // redirects before the fresh Review GET can encounter a read failure.
  const redirectsToReview=preview && (expectedStatus===200 || expectedStatus===503);
  const postStatus=redirectsToReview?303:expectedStatus;
  const proposed=redirectsToReview?await page.locator('#profile-language').inputValue():null;
  const responseReady=target.waitForResponse(response=>response.request().method()==='POST' && new URL(response.url()).pathname===route,{timeout:15000});
  const navigation=target.waitForNavigation({waitUntil:'load',timeout:30000});
  // Keep both rejection handlers attached even if clicking fails. Never persist errors.
  responseReady.catch(()=>{}); navigation.catch(()=>{});
  await page.locator(`${selector} button[type=submit]`).click({noWaitAfter:true});
  const response=await responseReady;
  assert.equal(response.status(),postStatus,'Language native POST status');
  const destination=await navigation;
  assert.equal(destination?.status(),expectedStatus===303?200:expectedStatus,'Language native navigation status');
  assert.equal(response.headers()['cache-control'],'no-store','Language POST response must not be cached');
  if(redirectsToReview) {
    assert.equal(response.headers().location,`/profile/language/review?language=${proposed}`,'Preview redirects with only the proposed language');
    assert.equal(destination.request().method(),'GET','Review follows native POST303 with GET');
    assert.equal(destination.request().redirectedFrom(),response.request(),'Review GET follows the actual Preview POST');
    assert.equal(destination.headers()['cache-control'],'no-store','Review GET response must not be cached');
    languageReviewURL(target,proposed);
  } else if(expectedStatus===303) {
    assert.equal(response.headers().location,'/profile','Language confirmation redirects to profile');
    assert.equal(destination.request().method(),'GET','Confirmation redirects with a real GET');
    assert.equal(new URL(target.url()).pathname,'/profile','Language redirect reaches real profile');
  } else {
    assert.equal(destination.request().method(),'POST','Invalid or unauthenticated submission remains a direct POST failure');
  }
  return response.status();
}
function languageReviewURL(page,proposed) {
  const url=new URL(page.url());
  assert.equal(url.origin,fixture.baseURL,'Review stays on the fixture origin');
  assert.equal(url.pathname,'/profile/language/review','Review uses its authenticated GET route');
  assert.deepEqual([...url.searchParams],[['language',proposed]],'Review URL contains only the proposed language, never signed fields');
  assert.equal(url.hash,'','Review URL has no fragment payload');
}
async function languagePreview(page,language) {
  await page.locator('#profile-language').selectOption(otherLanguage(language));
  await languagePost(page,languageForm,{expectedStatus:200});
  await languageReview(page,language);
}
async function languageReview(page,language) {
  const copy=languageCopy[language];
  await languageLocale(page,language);
  await textIncludes(page,copy.review);
  assert.deepEqual(await page.locator('main p strong').allTextContents(),[copy[language],copy[otherLanguage(language)]],'Review displays localized current and proposed languages');
  await visible(page.locator(languageConfirm));
  await visible(page.getByRole('button',{name:copy.confirm,exact:true}));
  await visible(page.getByRole('link',{name:copy.cancel,exact:true}));
  await noOverflow(page);
}
async function languageState(actor,language,writes) {
  const state=await fixture.inspectLanguage(actor);
  assert.equal(state.language,language,'Durable language preference');
  assert.equal(state.writeCount,writes,'Language preference write count');
  assert.equal(state.receiptCount,writes,'Language-specific receipt count');
  if(writes) {
    assert.deepEqual(state.lastReceipt.fields,['language'],'Receipt is scoped only to language');
    check(Number.isFinite(Date.parse(state.updatedAt)),'Language update has a real durable timestamp');
  }
  return state;
}
async function languageProfile(page,language,{updatedAt}={}) {
  await visible(page.locator('#profile-heading')); await languageLocale(page,language);
  assert.equal(await page.locator('#profile-language').inputValue(),language,'Reloaded picker reflects durable language');
  await page.locator('#section-details > summary').click();
  assert.equal(await page.locator('#field-language .p-value').innerText(),languageCopy[language][language],'Reloaded language row reflects durable preference');
  if(updatedAt) {
    await page.locator('.p-provenance > summary').click();
    const row=page.locator('.p-provenance dl > div').filter({has:page.getByText(languageCopy[language].label,{exact:true})});
    assert.equal(await row.count(),1,'Exactly one language provenance row');
    const date=new Intl.DateTimeFormat(language==='ar'?'ar-KW':'en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(updatedAt.slice(0,10)));
    assert.equal(await row.locator('dd').innerText(),languageCopy[language].updated+date,'Language provenance uses actual durable write date');
  }
  await noOverflow(page);
}
async function languageError(page,language,key,{unknown=false}={}) {
  await languageLocale(page,language);
  await textIncludes(page,languageCopy[language][key]);
  await textIncludes(page,languageCopy[language][unknown?'unknownHeading':'notChanged']);
  if(unknown) check(!(await page.locator('body').innerText()).includes(languageCopy[language].notChanged),'Unknown commit outcome must not claim no change');
  assert.equal(await page.locator(languageConfirm).count(),0,'Error page must not expose protected confirmation form');
  const body=await page.locator('body').innerText();
  check(!['Synthetic language preference read failure','Synthetic language COMMIT dependency failure','Synthetic lost language COMMIT acknowledgement'].some(detail=>body.includes(detail)),'Language failure must not expose dependency details');
  await noOverflow(page);
}
async function languageReplayTarget(source) {
  const name=`acceptance-language-${++replayTargetSequence}`;
  const ready=source.waitForEvent('popup');
  await source.evaluate(name=>{window.open('about:blank',name);},name);
  const target=await ready; await target.waitForLoadState('load');
  // Only the native form target changes; all signed fields remain untouched.
  await source.locator(languageConfirm).evaluate((form,name)=>{form.target=name;},name);
  return target;
}
// Phone recovery checks never persist numbers, tokens, serialized HTML or receipt IDs.
const phoneRecoveryCopy={
  en:{label:'Phone number',conflict:'This value changed since you opened the form. Review the current value and your draft before saving.',reentry:'Enter your phone number again. Your previous entry is not shown.',unknownHeading:'Save not confirmed',unknown:'We could not confirm whether your change was saved. Check its status before trying another change.',retryHelp:'Enter the same phone number again to retry this save. Your previous entry is not shown.',check:'Check save status',retry:'Try again',different:'This is a different change. Review your current profile and open a new form before saving it.',saved:'Save confirmed'},
  ar:{label:'رقم الهاتف',conflict:'تغيّرت هذه القيمة منذ فتح النموذج. راجع القيمة الحالية ومسودتك قبل الحفظ.',reentry:'أدخل رقم هاتفك مجددًا. لن يظهر إدخالك السابق.',unknownHeading:'لم يتم تأكيد الحفظ',unknown:'تعذّر التأكد من حفظ تغييرك. تحقق من حالته قبل محاولة إجراء تغيير آخر.',retryHelp:'أدخل رقم الهاتف نفسه مجدداً لإعادة محاولة الحفظ. لن يظهر إدخالك السابق.',check:'التحقق من حالة الحفظ',retry:'المحاولة مرة أخرى',different:'هذا تغيير مختلف. راجع ملفك الشخصي الحالي وافتح نموذجاً جديداً قبل حفظه.',saved:'تم تأكيد الحفظ'},
};
async function phoneRecoveryLocale(page,language) {
  assert.equal(await page.locator('html').getAttribute('lang'),language,'Phone recovery trusted locale');
  assert.equal(await page.locator('html').getAttribute('dir'),language==='ar'?'rtl':'ltr','Phone recovery trusted direction');
}
async function phonePayloadAbsent(page,numbers) {
  // Include local-number digits to catch formatted/escaped country-code variants.
  const needles=[...new Set(numbers.filter(Boolean).flatMap(number=>[number,number.replace(/\D/g,'').slice(-8)]))];
  check(needles.length>0,'Phone non-echo requires nonempty payload witnesses');
  check(!needles.some(value=>(value.length<8)),'Phone non-echo witnesses must be meaningful');
  // Full serialization is inspected only in memory; assertion receives a boolean.
  const html=await page.content();
  check(!needles.some(value=>html.includes(value)),'Phone payload absent from full serialized HTML');
  check(await page.evaluate(values=>{
    const contains=value=>values.some(needle=>value.includes(needle));
    return !contains(document.body.innerText)
      && [...document.querySelectorAll('*')].every(node=>[...node.attributes].every(attr=>!contains(attr.value)))
      && [...document.querySelectorAll('input,textarea,select')].every(node=>!contains(node.value));
  },needles),'Phone payload absent from visible text, all attributes, hidden controls and live values');
}
async function phoneRecoveryPost(page,button,route,expectedStatus) {
  const responseReady=page.waitForResponse(response=>response.request().method()==='POST' && new URL(response.url()).pathname===route,{timeout:15000});
  responseReady.catch(()=>{});
  const destination=await submit(page,button), response=await responseReady;
  assert.equal(response.status(),expectedStatus,'Phone native POST status');
  assert.equal(destination?.status(),expectedStatus===303?200:expectedStatus,'Phone native navigation status');
  assert.equal(response.headers()['cache-control'],'no-store','Phone recovery response is not cached');
  if(expectedStatus===303) {
    assert.equal(response.headers().location,'/profile#field-phone','Phone recovery redirects to actual phone field');
    assert.equal(new URL(page.url()).pathname,'/profile','Phone recovery reaches actual profile');
  }
}
async function phoneRecoverySaved(page,language) {
  await saved(page); await phoneRecoveryLocale(page,language);
  assert.equal(await page.locator('#profile-notice-heading').innerText(),phoneRecoveryCopy[language].saved,'Localized verified save notice');
}
// BFCache acceptance is isolated from the original default-launch matrix. Only
// fixed lifecycle flags and request facts leave the browser, never DOM/fields.
const bfcacheConsolePrefix='studenthub-bfcache-lifecycle:';
async function bfcacheObserver(page) {
  const events=[], documents=new Map();
  const record=entry=>events.push({sequence:events.length+1,...entry});
  page.on('console',message=>{
    const text=message.text();
    if(!text.startsWith(bfcacheConsolePrefix)) return;
    let entry;
    try { entry=JSON.parse(text.slice(bfcacheConsolePrefix.length)); } catch { return; }
    if(!['pagehide','pageshow'].includes(entry.event) || !['before-guard','after-guard'].includes(entry.phase)
      || !Number.isFinite(entry.documentStamp) || !['navigate','reload','back_forward','unknown'].includes(entry.navigationType)
      || !['trusted','persisted','hidden','displayNone','actionable'].every(key=>typeof entry[key]==='boolean')) return;
    if(!documents.has(entry.documentStamp)) documents.set(entry.documentStamp,documents.size+1);
    record({kind:'lifecycle',document:documents.get(entry.documentStamp),event:entry.event,phase:entry.phase,
      trusted:entry.trusted,persisted:entry.persisted,hidden:entry.hidden,displayNone:entry.displayNone,
      actionable:entry.actionable,navigationType:entry.navigationType});
  });
  const isReview=request=>request.isNavigationRequest() && request.frame()===page.mainFrame()
    && new URL(request.url()).origin===fixture.baseURL && new URL(request.url()).pathname==='/profile/language/review';
  let nativePosts=0;
  page.on('request',request=>{
    if(request.isNavigationRequest() && request.method()==='POST') nativePosts++;
    if(isReview(request)) record({kind:'request',method:request.method()==='GET'?'GET':'OTHER'});
  });
  page.on('response',response=>{
    if(isReview(response.request())) record({kind:'response',method:response.request().method()==='GET'?'GET':'OTHER',
      status:response.status(),noStore:response.headers()['cache-control']==='no-store',fromServiceWorker:response.fromServiceWorker()});
  });
  await page.addInitScript(({prefix})=>{
    if(window!==window.top) return;
    const emit=(event,phase)=>{
      if(location.pathname!=='/profile/language/review') return;
      const root=document.documentElement, type=performance.getEntriesByType('navigation')[0]?.type;
      console.info(prefix+JSON.stringify({event:event.type,phase,documentStamp:performance.timeOrigin,
        trusted:event.isTrusted,persisted:event.persisted,hidden:root.hidden,
        displayNone:getComputedStyle(root).display==='none',actionable:!!document.querySelector('form[action="/profile/language/confirm"]'),
        navigationType:['navigate','reload','back_forward'].includes(type)?type:'unknown'}));
    };
    // This listener predates the production deferred script and observes the
    // snapshot before its pageshow handler can initiate the reload.
    addEventListener('pageshow',event=>emit(event,'before-guard'));
    addEventListener('DOMContentLoaded',()=>{
      // Deferred production scripts have registered their handlers by now.
      // No synthetic dispatch, mutation, binding, unload hook or interception.
      addEventListener('pagehide',event=>emit(event,'after-guard'));
      addEventListener('pageshow',event=>emit(event,'after-guard'));
    },{once:true});
  },{prefix:bfcacheConsolePrefix});
  return {events,get nativePosts(){return nativePosts;}};
}
async function waitForBfcacheObservation(predicate,timeout=15000) {
  const deadline=Date.now()+timeout;
  while(!predicate() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
  return predicate();
}
async function bfcacheSubject(language) {
  const actor=await fixture.seedActor({language});
  const context=await bfcacheBrowser.newContext({viewport:{width:390,height:900},serviceWorkers:'block'});
  contexts.add(context); await context.addCookies([actor.cookie]);
  const page=await context.newPage(), observer=await bfcacheObserver(page);
  await page.goto(`${fixture.baseURL}/profile`); await visible(page.locator('#profile-heading'));
  return {actor,context,page,observer};
}
async function bfcacheBack(page,observer,originalDocument) {
  const start=observer.events.length;
  // A guard-triggered reload can supersede Playwright's Back navigation wait.
  // Its return value is never BFCache proof; browser lifecycle evidence is.
  const navigation=await page.goBack({waitUntil:'commit',timeout:15000}).then(()=> 'completed',()=> 'interrupted-or-timed-out');
  const observed=()=>observer.events.slice(start);
  const freshShow=()=>observed().find(event=>event.kind==='lifecycle' && event.event==='pageshow'
    && event.phase==='after-guard' && event.trusted && !event.persisted && event.document!==originalDocument);
  await waitForBfcacheObservation(()=>!!freshShow() && observed().some(event=>event.kind==='response'));
  const restored=observed().filter(event=>event.kind==='lifecycle' && event.event==='pageshow' && event.persisted && event.trusted);
  const fresh=freshShow(), requests=observed().filter(event=>event.kind==='request'), responses=observed().filter(event=>event.kind==='response');
  if(restored.length) {
    const hidden=observer.events.find(event=>event.kind==='lifecycle' && event.document===originalDocument
      && event.event==='pagehide' && event.phase==='after-guard' && event.trusted && event.persisted);
    check(hidden?.hidden && hidden.displayNone && hidden.actionable,'Cached actionable Review is concealed at pagehide');
    for(const phase of ['before-guard','after-guard']) {
      const show=restored.find(event=>event.phase===phase && event.document===originalDocument);
      check(show?.hidden && show.displayNone && show.actionable,'Trusted persisted Review stays hidden before and after its restore handler');
      check(show.sequence>hidden.sequence,'Persisted pageshow restores the previously hidden document');
    }
    check(fresh?.navigationType==='reload','Persisted restore must produce a fresh reload document');
    check(requests.length===1 && requests[0].sequence>restored[0].sequence,'Exactly one fresh GET follows persisted restoration');
  }
  const network=responses.at(-1);
  check(fresh && !fresh.hidden && !fresh.displayNone,'Fresh Review response becomes visible in a new document');
  check(requests.length===1 && requests[0].method==='GET','Back performs one fresh Review GET, never POST');
  check(responses.length===1 && network.method==='GET' && network.noStore && !network.fromServiceWorker,'Fresh Review GET retains no-store and bypasses service workers');
  const notRestored=restored.length?null:await page.evaluate(()=>{
    const navigation=performance.getEntriesByType('navigation')[0], reasons=[];
    const visit=node=>{
      if(!node) return;
      for(const item of node.reasons ?? []) {
        // Browser reason codes only; never serialize URL/src/id/name details.
        if(typeof item.reason==='string' && /^[a-z][a-z0-9-]{0,79}$/.test(item.reason)) reasons.push(item.reason);
      }
      for(const child of node.children ?? []) visit(child);
    };
    visit(navigation?.notRestoredReasons);
    return {supported:!!navigation && 'notRestoredReasons' in navigation,
      reported:!!navigation?.notRestoredReasons,reasons:[...new Set(reasons)].sort()};
  });
  return {established:restored.length>0,status:network.status,
    evidence:{nativeBack:navigation,trustedPersistedRestore:restored.length>0,
      hiddenRestoredReview:restored.length>0,freshReviewGet:true,freshDocumentVisible:true,
      finalHttpStatus:network.status,...(notRestored?{notRestored}:{}),lifecycleAndNetwork:observer.events}};
}
async function verifyBfcacheLaunch(chromium,expected) {
  const commandLine=async (launched,stages)=>{
    setupStage=stages.discover;
    check(process.platform==='linux','Exact launch verification requires the hosted Linux process filesystem');
    const session=await launched.newBrowserCDPSession();
    try {
      const browserPid=async()=>{
        const {processInfo}=await session.send('SystemInfo.getProcessInfo');
        check(Array.isArray(processInfo),'Browser process discovery returns a process list');
        const matches=processInfo.filter(info=>info?.type==='browser');
        check(matches.length===1 && Number.isSafeInteger(matches[0].id) && matches[0].id>0,
          'Browser-target discovery identifies exactly one positive integer browser PID');
        return matches[0].id;
      };
      // Browser.getBrowserCommandLine requires --enable-automation, which the
      // pinned defaults omit. Read only the PID identified by this launched
      // browser's own CDP target, then confirm it is still the same live browser.
      const pid=await browserPid();
      setupStage=stages.read;
      const bytes=await readFile(`/proc/${pid}/cmdline`);
      setupStage=stages.parse;
      check(bytes.length>1 && bytes.at(-1)===0,'Browser process argv is nonempty and NUL-terminated');
      const content=bytes.subarray(0,-1), decoded=content.toString('utf8');
      check(Buffer.from(decoded,'utf8').equals(content),'Browser process argv is valid UTF-8');
      const args=decoded.split('\0');
      check(args.every(arg=>arg.length>0),'Browser process argv contains an executable and no empty arguments');
      setupStage=stages.recheck;
      check(await browserPid()===pid,'Browser-target process identity remains unchanged during argv read');
      return args;
    } finally { await session.detach(); }
  };
  const baseline=await commandLine(browser,{discover:'discover-default-browser-process',read:'read-default-browser-argv',
    parse:'parse-default-browser-argv',recheck:'recheck-default-browser-process'});
  setupStage='check-default-bfcache-flag';
  check(baseline.includes('--disable-back-forward-cache'),'Original Chromium launch explicitly disables BFCache');
  setupStage='launch-isolated-bfcache-chromium';
  bfcacheBrowser=await chromium.launch({headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-back-forward-cache']});
  setupStage='verify-isolated-bfcache-version';
  evidence.bfcacheChromiumVersion=bfcacheBrowser.version();
  assert.equal(evidence.bfcacheChromiumVersion,expected.browserVersion,'BFCache Chromium matches the unchanged pinned manifest');
  const actual=await commandLine(bfcacheBrowser,{discover:'discover-isolated-browser-process',read:'read-isolated-browser-argv',
    parse:'parse-isolated-browser-argv',recheck:'recheck-isolated-browser-process'});
  setupStage='compare-isolated-bfcache-launch';
  // The unchanged baseline already selects channel:'chromium', not the default
  // headless-shell. Keep argv[0] in the comparison to verify the same executable.
  const normalize=args=>args.filter(arg=>!arg.startsWith('--user-data-dir='));
  check(!actual.includes('--disable-back-forward-cache'),'Isolated Chromium launch removes the BFCache-disabling argument');
  check(JSON.stringify(normalize(actual))===JSON.stringify(normalize(baseline.filter(arg=>arg!=='--disable-back-forward-cache'))),
    'Only the BFCache-disabling default argument changes, apart from the disposable profile directory');
  evidence.bfcacheLaunch={verified:true,headless:true,channel:'chromium',removedDefaultArguments:['--disable-back-forward-cache'],
    samePinnedExecutable:true,otherArgumentsUnchanged:true,comparisonExcludes:'Disposable user-data-dir only. No command lines or local paths recorded.'};
}
async function run(name, action) {
  const record=evidence.cases.find(c=>c.name===name), start=Date.now();
  try { const result=await action(); Object.assign(record,{status:'PASS',...result}); }
  catch(error) {
    // Playwright error messages often contain full DOM/control values and URLs. Do not persist them.
    record.status='FAIL'; record.reason=error?.name==='AssertionError' ? String(error.message).split('\n')[0].replace(/https?:\/\/\S+|[A-Za-z0-9_=-]{40,}/g,'[redacted]').slice(0,180) : 'Browser/fixture operation failed. Reproduce locally without uploading raw diagnostics.';
    process.exitCode=1;
  } finally {
    for(const restore of restorers.splice(0).reverse()) await restore();
    record.durationMs=Date.now()-start;
    for(const context of contexts) await context.close().catch(()=>{});
    contexts.clear();
    await report();
    process.stdout.write(`${name}: ${record.status}\n`);
  }
}
async function report() {
  await mkdir(output,{recursive:true});
  const languageCases=evidence.cases.filter(c=>c.name.startsWith('language-'));
  const historyCases=['en','ar'].map(language=>evidence.cases.find(c=>c.name===`language-cancel-history-safe-review-${language}`));
  const historyAccepted=historyCases.every(c=>c?.status==='PASS');
  evidence.languageAcceptance={status:historyAccepted && languageCases.every(c=>c.status==='PASS')?'ACCEPTED':'NOT_ESTABLISHED',
    historySafeReview:historyAccepted?'ACCEPTED':'NOT_ESTABLISHED',
    historyScope:'Pinned Playwright Chromium runner with BFCache disabled.',
    limitation:'This baseline does not establish BFCache-enabled restoration. See the separate BFCache acceptance result below; Confirm still validates live state.'};
  const bfcacheCases=evidence.cases.filter(c=>bfcacheNames.includes(c.name));
  evidence.bfcacheAcceptance={status:bfcacheCases.every(c=>c.status==='PASS')?'ACCEPTED':'NOT_ESTABLISHED',
    scope:'Separate pinned Chromium process; only --disable-back-forward-cache removed from Playwright defaults.',
    required:'All six EN/AR cases require trusted persisted restoration, a hidden cached Review and a subsequent fresh no-store GET.',
    limitation:'A network-only Back or an unobserved restore is NOT_ESTABLISHED, not BFCache acceptance. Browser policy may decline to cache no-store pages.'};
  await writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  const lines=['# StudentHub browser acceptance','',`Candidate SHA: ${evidence.candidateSha || 'NOT_RUN'}`,`Playwright: ${evidence.playwrightVersion || 'NOT_RUN'}`,`Chromium: ${evidence.chromiumVersion || 'NOT_RUN'}`,'',evidence.policy,'',...evidence.cases.map(c=>`- ${c.status}: ${c.name}${c.screenshot ? ` ([screenshot](${c.screenshot}))` : ''}${c.stressScreenshot ? ` ([long-value stress](${c.stressScreenshot}))` : ''}${c.editorScreenshot ? ` ([editor](${c.editorScreenshot}))` : ''}${c.errorScreenshot ? ` ([validation](${c.errorScreenshot}))` : ''}${c.noChangeScreenshot ? ` ([confirmed no-change Review](${c.noChangeScreenshot}))` : ''}${c.disclosureScreenshot ? ` ([expanded disclosure](${c.disclosureScreenshot}))` : ''}${c.notes ? ` — ${c.notes}` : ''}${c.reason ? ` — ${c.reason}` : ''}`)];
  lines.push('',evidence.languageAcceptance.status==='ACCEPTED'
    ? 'Language flow accepted in the pinned Playwright Chromium runner with BFCache disabled, including native history-safe Review in English and Arabic.'
    : 'Language acceptance has not been established.',
    `History-safe Review: ${evidence.languageAcceptance.historySafeReview}. Both native history cases must pass to establish it within the pinned runner.`,
    `History scope: ${evidence.languageAcceptance.historyScope}`,
    `Limitation: ${evidence.languageAcceptance.limitation}`);
  lines.push('',`BFCache-enabled Review acceptance: ${evidence.bfcacheAcceptance.status}.`,
    `BFCache Chromium: ${evidence.bfcacheChromiumVersion || 'NOT_RUN'}`,
    `Scope: ${evidence.bfcacheAcceptance.scope}`,`Required evidence: ${evidence.bfcacheAcceptance.required}`,
    `Limitation: ${evidence.bfcacheAcceptance.limitation}`);
  for(const entry of evidence.cases.filter(c=>c.screenshots)) lines.push('',`${entry.name}:`,...entry.screenshots.map(file=>`- [${file}](${file})`));
  if(evidence.blocker) lines.push('',`Blocker: ${evidence.blocker}`);
  await writeFile(path.join(output,'evidence.md'),lines.join('\n')+'\n');
}
try {
  evidence.candidateSha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  check(/^[a-f0-9]{40}$/.test(evidence.candidateSha),'Invalid candidate SHA');
  if(process.env.BROWSER_ACCEPTANCE_SHA) assert.equal(evidence.candidateSha,process.env.BROWSER_ACCEPTANCE_SHA,'Checkout must match requested candidate SHA');
  if(process.argv.includes('--initialize-report')) {
    evidence.blocker='Browser execution has not started; inspect workflow step results.';
    await report(); process.exit(0);
  }
  setupStage='load-browser-dependency';
  const require=createRequire(import.meta.url);
  evidence.playwrightVersion=JSON.parse(await readFile(require.resolve('playwright/package.json'),'utf8')).version;
  const {chromium}=await import('playwright');
  const {createFixture}=await import('./fixture.mjs');
  setupStage='start-real-gateway-postgres-tls-fixture';
  fixture=await createFixture({databaseUrl:process.env.BROWSER_ACCEPTANCE_DATABASE_URL || process.env.DATABASE_URL,certPath:process.env.BROWSER_ACCEPTANCE_TLS_CERT || process.env.TLS_CERT_PATH,keyPath:process.env.BROWSER_ACCEPTANCE_TLS_KEY || process.env.TLS_KEY_PATH,sourceRevision:evidence.candidateSha});
  const browserManifest=JSON.parse(await readFile(path.join(path.dirname(require.resolve('playwright-core/package.json')),'browsers.json'),'utf8'));
  const expected=browserManifest.browsers.find(item=>item.name==='chromium');
  evidence.expectedChromiumVersion=expected.browserVersion; evidence.chromiumRevision=expected.revision;
  setupStage='launch-pinned-chromium';
  browser=await chromium.launch({headless:true,channel:'chromium'});
  evidence.chromiumVersion=browser.version();
  assert.equal(evidence.chromiumVersion,expected.browserVersion,'Installed Chromium must match pinned Playwright manifest');
  for (const language of ['en','ar']) for (const width of [320,390,1280]) {
    const name=`layout-${language}-${width}`;
    await run(name,async()=>{
      const ordinary=await subject({language,width});
      await noOverflow(ordinary.page);
      evidence.cases.find(c=>c.name===name).screenshot=await screenshot(ordinary.page,name);
      const {page}=await subject({language,width,longValues:true});
      evidence.cases.find(c=>c.name===name).stressScreenshot=await screenshot(page,`${name}-long-values`);
      assert.equal(await page.locator('html').getAttribute('lang'),language,'Document language');
      assert.equal(await page.locator('html').getAttribute('dir'),language==='ar'?'rtl':'ltr','Document direction');
      for(const id of ['profile-summary','section-work','section-personal','section-background']) await visible(page.locator(`#${id}`));
      await noOverflow(page);
      assert.equal(await page.locator('#field-phone .p-value').getAttribute('dir'),'ltr','Phone direction');
      assert.equal(await page.locator('#profile-name bdi').getAttribute('dir'),'auto','Name bidi isolation');
      const intro=page.locator('#field-intro .p-value');
      check((await intro.innerText()).length>=150,'Long synthetic value fixture required');
      check(await intro.evaluate(n=>n.getBoundingClientRect().height>parseFloat(getComputedStyle(n).lineHeight)*1.5),'Long text must wrap');
      const rail=await page.locator('.p-rail').boundingBox(), main=await page.locator('main').boundingBox();
      if(width===1280) check(language==='ar'?rail.x>main.x:rail.x<main.x,'Desktop rail follows reading direction');
      else check(main.y>=rail.y+rail.height-1,'Mobile rail stacks above profile');
      return {};
    });
  }
  for(const language of ['en','ar']) for(const width of [320,390,1280]) {
    const name=`editor-error-${language}-${width}`;
    await run(name,async()=>{
      const {actor,page}=await subject({language,width}); await edit(page,'phone');
      const record=evidence.cases.find(c=>c.name===name);
      record.editorScreenshot=await screenshot(page,`${name}-normal`);
      const label=language==='ar'?'رقم الهاتف':'Phone number';
      await visible(page.getByRole('textbox',{name:label,exact:true}));
      assert.equal(await page.locator('html').getAttribute('lang'),language,'Editor document language');
      assert.equal(await page.locator('html').getAttribute('dir'),language==='ar'?'rtl':'ltr','Editor direction');
      assert.equal(await page.locator('#field-phone').getAttribute('dir'),'ltr','Editor phone isolation');
      await noOverflow(page); await page.locator('[name=value]').fill('synthetic-invalid-555');
      const response=await save(page); assert.equal(response.status(),400,'Invalid editor submission returns validation state');
      record.errorScreenshot=await screenshot(page,`${name}-invalid`);
      await visible(page.locator('#profile-error-summary')); await noOverflow(page);
      await visible(page.getByRole('textbox',{name:label,exact:true}));
      assert.equal(await page.locator('html').getAttribute('lang'),language,'Error language');
      assert.equal(await page.locator('html').getAttribute('dir'),language==='ar'?'rtl':'ltr','Error direction');
      assert.equal(await page.locator('[name=value]').inputValue(),'','No phone echo in either locale');
      check(await page.locator('#profile-error-summary').evaluate(n=>n===document.activeElement),'Error summary receives focus');
      await counts(actor,0,0);
    });
  }
  await run('arabic-save-clear',async()=>{
    const {actor,page}=await subject({language:'ar'}); await edit(page,'objective');
    await visible(page.getByRole('textbox',{name:'الهدف المهني',exact:true}));
    await page.locator('[name=value]').fill('هدف اصطناعي للاختبار'); await save(page); await saved(page);
    assert.equal(await page.locator('#profile-notice-heading').innerText(),'تم تأكيد الحفظ','Arabic saved notice');
    await textIncludes(page,'هدف اصطناعي للاختبار'); await counts(actor,1,1);
    await edit(page,'objective'); await page.locator('[name=value]').fill(''); await save(page); await saved(page);
    const state=await counts(actor,2,2); check(state.values.objective===null || state.values.objective==='','Arabic clear persists');
    await noOverflow(page); return {screenshot:await screenshot(page,'arabic-cleared')};
  });
  await run('arabic-conflict',async()=>{
    const {actor,context,page}=await subject({language:'ar'}); const other=await context.newPage();
    await edit(page,'objective'); await page.locator('[name=value]').fill('مسودة اصطناعية قديمة');
    await edit(other,'objective'); await other.locator('[name=value]').fill('قيمة اصطناعية جديدة'); await save(other); await saved(other);
    const response=await save(page); assert.equal(response.status(),409,'Arabic conflict status');
    await textIncludes(page,'تغيّرت هذه القيمة منذ فتح النموذج.'); await textIncludes(page,'قيمة اصطناعية جديدة');
    assert.equal(await page.locator('[name=value]').inputValue(),'مسودة اصطناعية قديمة','Arabic draft retained');
    await noOverflow(page); const screenshotName=await screenshot(page,'arabic-conflict'); await counts(actor,1,1);
    await save(page); await saved(page); await counts(actor,2,2); return {screenshot:screenshotName};
  });
  await run('arabic-recovery',async()=>{
    const {actor,page}=await subject({language:'ar'}); const before=fixture.evidence.commitBoundaryThrows;
    restorers.push(await fixture.useCommitBoundaryFault());
    await edit(page,'objective'); await page.locator('[name=value]').fill('استعادة اصطناعية للاختبار');
    const response=await save(page); assert.equal(response.status(),503,'Arabic real uncertain commit');
    assert.equal(fixture.evidence.commitBoundaryThrows,before+1,'Arabic real COMMIT fault');
    await visible(page.getByRole('button',{name:'التحقق من حالة الحفظ',exact:true})); await noOverflow(page);
    const screenshotName=await screenshot(page,'arabic-recovery'); await counts(actor,1,1);
    await submit(page,page.getByRole('button',{name:'التحقق من حالة الحفظ',exact:true})); await saved(page); await counts(actor,1,1);
    assert.equal(await page.locator('html').getAttribute('lang'),'ar','Recovered profile Arabic');
    return {screenshot:screenshotName};
  });
  await run('keyboard-disclosure-accessible-controls',async()=>{
    const {page}=await subject();
    await page.keyboard.press('Tab');
    check(await page.locator('a.skip').evaluate(n=>n===document.activeElement),'Skip link first focus');
    check(await page.locator('a.skip').evaluate(n=>n.getBoundingClientRect().top>=0),'Skip link visible on focus');
    await page.keyboard.press('Enter');
    check(await page.evaluate(()=>location.hash==='#main'),'Skip link targets main');
    const summary=page.locator('#section-details > summary');
    await summary.focus(); await page.keyboard.press('Enter');
    check(await page.locator('#section-details').evaluate(n=>n.open),'Keyboard disclosure opens');
    await visible(page.locator('#field-language'));
    await page.keyboard.press('Space');
    check(!(await page.locator('#section-details').evaluate(n=>n.open)),'Keyboard disclosure closes');
    await summary.focus(); await page.keyboard.press('Enter');
    check(await page.locator('#section-details').evaluate(n=>n.open),'Open details before checking nested edit names');
    for(const link of await page.locator('.p-edit').all()) {
      await visible(link);
      check((await link.ariaSnapshot()).split('\n').some(line=>/^- link \"[^\"]+\"/.test(line.trim())),'Accessible edit link has nonempty computed name');
    }
    const disclosureScreenshot=await screenshot(page,'keyboard-expanded-disclosure');
    await edit(page,'objective');
    await visible(page.getByRole('textbox',{name:/objective/i}));
    await visible(page.getByRole('button',{name:'Save',exact:true}));
    await page.locator('#field-objective').focus(); await page.keyboard.press('Tab');
    check(await page.locator('button[type=submit]').evaluate(n=>n===document.activeElement),'Tab reaches Save');
    check(await page.locator('button[type=submit]').evaluate(n=>getComputedStyle(n).outlineStyle!=='none'),'Visible keyboard focus');
    return {screenshot:await screenshot(page,'keyboard-focus'),disclosureScreenshot};
  });
  await run('one-field-save-and-clear',async()=>{
    const {actor,page}=await subject(); const before=await fixture.inspect(actor);
    await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic revised objective'); await save(page); await saved(page);
    const after=await counts(actor,1,1);
    check(after.values.objective==='Synthetic revised objective','Saved field persists');
    for(const key of Object.keys(before.values)) if(key!=='objective') assert.deepEqual(after.values[key],before.values[key],'Unrelated field changed');
    await edit(page,'objective'); await page.locator('[name=value]').fill(''); await save(page); await saved(page);
    const cleared=await counts(actor,2,2); check(cleared.values.objective===null || cleared.values.objective==='','Explicit clear persists');
    return {screenshot:await screenshot(page,'cleared-objective')};
  });
  await run('invalid-phone-non-echo',async()=>{
    const {actor,page}=await subject(); await edit(page,'phone'); await page.locator('[name=value]').fill('synthetic-invalid-555'); await save(page);
    await visible(page.locator('#profile-error-summary'));
    assert.equal(await page.locator('[name=value]').inputValue(),'','Invalid phone is not echoed');
    check(!(await page.locator('body').innerText()).includes('synthetic-invalid-555'),'Phone absent in visible error');
    check(await page.locator('#field-phone').getAttribute('aria-describedby'),'Error associated to control');
    await counts(actor,0,0); return {screenshot:await screenshot(page,'phone-validation')};
  });
  await run('invalid-name-error-focus',async()=>{
    const {actor,page}=await subject(); await edit(page,'displayName'); await page.locator('[name=value]').fill('Mononym'); await save(page);
    await visible(page.locator('#profile-error-summary'));
    check(await page.locator('#profile-error-summary').evaluate(n=>n===document.activeElement),'Server validation focuses error summary');
    await page.locator('#profile-error-summary a').click();
    check(await page.locator('#field-displayName').evaluate(n=>n===document.activeElement),'Error link focuses named input');
    assert.equal(await page.locator('#field-displayName').getAttribute('aria-invalid'),'true','Invalid input exposes error');
    await counts(actor,0,0);
  });
  await run('nationality-mother-eligibility',async()=>{
    const kuwait=await subject({nationality:'KW'});
    assert.equal(await kuwait.page.locator('a[href="/profile/edit/kuwaitiMother"]').count(),0,'Kuwaiti profile has no mother edit');
    const bahrain=await subject({nationality:'BH'});
    await visible(bahrain.page.locator('a[href="/profile/edit/kuwaitiMother"]'));
    await edit(bahrain.page,'kuwaitiMother'); await bahrain.page.getByRole('radio',{name:'Yes',exact:true}).check(); await save(bahrain.page); await saved(bahrain.page); await counts(bahrain.actor,1,1);
    await kuwait.page.goto(`${fixture.baseURL}/profile/edit/kuwaitiMother`);
    assert.equal(await kuwait.page.locator('#profile-edit-form').count(),0,'Direct ineligible mother edit is denied'); await counts(kuwait.actor,0,0);
  });
  await run('native-radio-validation',async()=>{
    const {actor,page}=await subject({sparse:true}); await edit(page,'gender');
    const radios=page.getByRole('radio'); assert.equal(await radios.count(),3,'Native gender radio choices');
    check(await radios.evaluateAll(nodes=>nodes.every(n=>n.required)),'Required native radios');
    await radios.evaluateAll(nodes=>nodes.forEach(n=>{n.checked=false;}));
    await page.locator('button[type=submit]').click();
    check(await page.locator('form').evaluate(n=>!n.checkValidity()),'Native validation blocks empty radio'); await counts(actor,0,0);
    await radios.first().focus(); await page.keyboard.press('ArrowRight');
    check(await radios.evaluateAll(nodes=>nodes.filter(n=>n.checked).length===1),'Keyboard selects exactly one radio');
    await save(page); await saved(page); await counts(actor,1,1);
  });
  await run('conflict-fresh-state',async()=>{
    const {actor,context,page}=await subject(); const other=await context.newPage();
    await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic older draft');
    await edit(other,'objective'); await other.locator('[name=value]').fill('Synthetic newer value'); await save(other); await saved(other);
    await save(page); await textIncludes(page,'This value changed since you opened the form.'); await textIncludes(page,'Synthetic newer value');
    assert.equal(await page.locator('[name=value]').inputValue(),'Synthetic older draft','Conflict preserves draft');
    await counts(actor,1,1); await save(page); await saved(page); await counts(actor,2,2);
  });
  await run('cancel-back-forward',async()=>{
    const {actor,page}=await subject(); await page.locator('#field-objective .p-edit').click(); await page.locator('[name=value]').fill('Synthetic cancelled draft');
    await page.getByRole('link',{name:'Cancel',exact:true}).click(); await visible(page.locator('#profile-heading')); await counts(actor,0,0);
    await page.goBack(); await visible(page.locator('#profile-edit-form')); await page.goForward(); await visible(page.locator('#profile-heading'));
    check(!(await page.locator('body').innerText()).includes('Synthetic cancelled draft'),'Cancelled draft not published'); await counts(actor,0,0);
  });
  await run('repeated-submission',async()=>{
    const {actor,page}=await subject(); await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic exact replay');
    const first=await nativeReplay(page); await saved(first.page);
    const second=await nativeReplay(page); await saved(second.page);
    await counts(actor,1,1); await textIncludes(second.page,'Synthetic exact replay');
    return {notes:'Two native Save clicks submit the unchanged original form into separate named popup targets. Both real HTTP303 responses render verified notices; one durable write and receipt.'};
  });
  await run('two-tab-notice-overwrite-clear',async()=>{
    const {actor,context,page}=await subject(); const other=await context.newPage();
    await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic tab one');
    const first=await nativeReplay(page,{holdRedirect:true});
    const firstCookie=(await context.cookies()).find(c=>c.name==='studenthub_profile_notice')?.value;
    check(firstCookie,'First genuine save sets shared notice cookie');
    await edit(other,'preferredTime'); await other.locator('[name=value]').fill('Synthetic tab two');
    const second=await nativeReplay(other,{holdRedirect:true});
    const secondCookie=(await context.cookies()).find(c=>c.name==='studenthub_profile_notice')?.value;
    check(secondCookie && secondCookie!==firstCookie,'Second real save overwrites shared notice cookie');
    await first.stopRedirect(); await second.stopRedirect();
    // Fresh navigation must send the current shared cookie, not a Cookie header
    // captured by a redirect request before the other tab overwrote it.
    await page.goto(`${fixture.baseURL}/profile#field-objective`); await saved(page);
    assert.equal((await page.locator('#profile-notice p').innerText()).trim(),'A profile change was saved. Your current profile is shown below.','Notice remains generic across tabs');
    check(!(await context.cookies()).some(c=>c.name==='studenthub_profile_notice'),'Receipt notice cleared across context');
    await other.goto(`${fixture.baseURL}/profile`); assert.equal(await other.locator('#profile-notice').count(),0,'Second tab cannot reuse cleared notice'); await counts(actor,2,2);
    return {notes:'Native POST303 responses set and overwrite a shared cookie. Only redirect GETs are paused with Chromium Fetch interception then stopped; fresh first-tab navigation sends the current cookie, verifies the generic notice and clears it for the second tab.'};
  });
  for(const mode of ['revocation','expiry']) await run(`session-${mode}`,async()=>{
    const {actor,page}=await subject(); const protectedName=await page.locator('#profile-name').innerText();
    await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic protected draft');
    await fixture[mode==='revocation'?'revoke':'expire'](actor); const denied=await save(page);
    assert.equal(denied.status(),401,'Expired or revoked session explicitly denied');
    await textIncludes(page,'Sign in again to continue safely.');
    check(!(await page.locator('body').innerText()).includes('Synthetic protected draft'),'Protected draft removed');
    assert.equal(await page.locator('[name=value]').count(),0,'No protected input after session loss'); await counts(actor,0,0);
    await page.goto(`${fixture.baseURL}/profile`); assert.equal(await page.locator('#profile-summary').count(),0,'Protected profile removed');
    check(!(await page.locator('body').innerText()).includes(protectedName),'Protected name removed after session loss');
  });
  await run('committed-response-loss',async()=>{
    const {actor,page}=await subject(); await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic lost response');
    const record=evidence.cases.find(c=>c.name==='committed-response-loss');
    const droppedBefore=fixture.evidence.transportResponsesDropped;
    const requestsBefore=fixture.evidence.transportSaveRequestsObserved;
    const restore=await fixture.armTransportLoss({untilRestored:true});
    restorers.push(restore);
    try {
      const result=await nativeReplay(page,{expectLoss:true});
      check(fixture.evidence.transportResponsesDropped>droppedBefore,'Server actually dropped at least one committed HTTP response');
      check(result.transportLost,'Real HTTP connection loss observed'); await counts(actor,1,1);
    } finally {
      // Chromium can transparently retransmit a POST after a socket disappears.
      // Keep dropping real committed responses until navigation actually fails;
      // restore the transport before the explicit user-visible same-form retry.
      await restore();
      record.transportResponsesDropped=fixture.evidence.transportResponsesDropped-droppedBefore;
      record.transportSaveRequestsObserved=fixture.evidence.transportSaveRequestsObserved-requestsBefore;
      const durable=await fixture.inspect(actor);
      record.receiptsBeforeExplicitRetry=durable.receiptCount;
      record.writesBeforeExplicitRetry=durable.writeCount;
    }
    const retry=await nativeReplay(page); await saved(retry.page);
    await counts(actor,1,1); await textIncludes(retry.page,'Synthetic lost response');
    return {notes:'Real committed HTTP responses, including any transparent browser retransmission, are destroyed until native navigation fails. Transport is restored before a second native Save click uses the untouched form and recovers with HTTP303, one write and one receipt.'};
  });
  for(const variant of ['status-read-only','exact-retry','changed-draft-rejected']) await run(`uncertain-commit-${variant}`,async()=>{
    const {actor,page}=await subject(); const faultBefore=fixture.evidence.commitBoundaryThrows; const restore=await fixture.useCommitBoundaryFault(); restorers.push(restore);
    await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic uncertain save'); await save(page);
    await visible(page.getByRole('button',{name:'Check save status',exact:true}));
    const before=await counts(actor,1,1);
    assert.equal(fixture.evidence.commitBoundaryThrows,faultBefore+1,'Real database COMMIT boundary fault exercised');
    if(variant==='status-read-only') {
      await submit(page,page.getByRole('button',{name:'Check save status',exact:true})); await saved(page);
    } else {
      if(variant==='changed-draft-rejected') await page.locator('#profile-edit-form [name=value]').evaluate(n=>{n.value='Synthetic changed retry';});
      await submit(page,page.getByRole('button',{name:'Try again',exact:true}));
      if(variant==='exact-retry') await saved(page); else await textIncludes(page,'This is a different change.');
    }
    const after=await counts(actor,1,1); assert.deepEqual(after.values,before.values,'Recovery must not change durable values');
  });
  await run('actual-token-expiry',async()=>{
    const {actor,page}=await subject(); const issuedBefore=fixture.evidence.nearExpiryIssuances; const expiry=await fixture.useNearExpiryTokens(); restorers.push(()=>expiry.restore());
    await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic expired draft');
    const waitMs=await page.locator('input[name=token]').evaluate(n=>Math.max(0,Date.parse(JSON.parse(n.value).expiresAt)-Date.now())+250);
    check(fixture.evidence.nearExpiryIssuances>issuedBefore,'Real production signer issued near-expiry token');
    check(waitMs>0 && waitMs<15000,'Fixture must issue genuinely near-expired signed token');
    await new Promise(resolve=>setTimeout(resolve,waitMs)); await save(page);
    await textIncludes(page,'This form expired.'); assert.equal(await page.locator('[name=value]').inputValue(),'Synthetic expired draft','Expired draft preserved'); await counts(actor,0,0);
  });
  // Additive Documents acceptance. All original profile cases above stay intact.
  for(const state of ['empty','finalized']) for(const language of ['en','ar']) for(const width of [320,390,1280]) {
    const name=`documents-${state}-${language}-${width}`;
    await run(name,async()=>{
      restorers.push(fixture.useDocuments());
      const {actor,page}=await subject({language,width});
      const metadata=state==='finalized'?await fixture.finalizeSyntheticPhoto(actor):undefined;
      // Browser input cannot override the language from the trusted profile.
      const response=await page.goto(`${fixture.baseURL}/profile/documents?language=${language==='en'?'ar':'en'}`);
      assert.equal(response.status(),200,'Documents page status');
      await documentPage(page,language,metadata); await counts(actor,0,0);
      return {screenshot:await screenshot(page,name),notes:state==='finalized'?'Photo authorized, bytes validated and finalized through real CandidateDocuments into a new private synthetic FileDocumentStore. No list response mocked.':'Registered person with no candidate grant; four empty slots from real synthetic FileDocumentStore.'};
    });
  }
  for(const configured of [true,false]) await run(`documents-navigation-${configured?'enabled':'disabled'}`,async()=>{
    restorers.push(fixture.useDocuments({configured}));
    const {page}=await subject();
    for(const route of ['/profile','/workspace']) {
      const response=await page.goto(`${fixture.baseURL}${route}`);
      assert.equal(response.status(),200,'Navigation source renders');
      const links=page.locator('a[href="/profile/documents"]');
      if(configured) { assert.equal(await links.count(),1,'One configured Documents navigation link'); await visible(links); }
      else assert.equal(await links.count(),0,'Unconfigured Documents navigation omitted');
    }
    const response=await page.goto(`${fixture.baseURL}/profile/documents`);
    assert.equal(response.status(),configured?200:503,'Direct document route respects configuration');
  });
  for(const language of ['en','ar']) await run(`documents-keyboard-history-${language}`,async()=>{
    restorers.push(fixture.useDocuments());
    const {actor,page}=await subject({language});
    const link=page.locator('a[href="/profile/documents"]'); await visible(link); await link.focus();
    check(await link.evaluate(node=>node===document.activeElement),'Documents navigation can receive keyboard focus');
    await page.keyboard.press('Enter'); await page.waitForURL('**/profile/documents'); await documentPage(page,language);
    const back=page.locator('main a[href="/profile"]'); await back.focus();
    check(await back.evaluate(node=>node===document.activeElement),'Profile return can receive keyboard focus');
    await page.keyboard.press('Enter'); await page.waitForURL('**/profile'); await visible(page.locator('#profile-heading'));
    await page.goBack(); await documentPage(page,language);
    await page.goForward(); await visible(page.locator('#profile-heading')); await counts(actor,0,0);
  });
  for(const mode of ['missing','revocation','expiry']) await run(`documents-session-${mode}`,async()=>{
    restorers.push(fixture.useDocuments());
    const {actor,context,page}=await subject();
    await fixture.finalizeSyntheticPhoto(actor);
    await page.goto(`${fixture.baseURL}/profile/documents`);
    if(mode==='missing') await context.clearCookies(); else await fixture[mode==='revocation'?'revoke':'expire'](actor);
    const calls=fixture.documentStoreCalls();
    const response=await page.reload();
    assert.equal(response.status(),401,'Missing, expired or revoked session gets sign-in 401');
    assert.equal(fixture.documentStoreCalls(),calls,'Rejected session never accesses document store');
    await textIncludes(page,'Sign in to view your documents');
    await visible(page.getByRole('link',{name:'Continue with Universe',exact:true}));
    assert.equal(await page.locator('main dl').count(),0,'No protected document slots after session loss');
    check(!(await page.locator('main').innerText()).includes('On file'),'No protected document state after session loss');
    return {screenshot:await screenshot(page,`documents-session-${mode}`)};
  });
  for(const language of ['en','ar']) await run(`documents-unavailable-${language}`,async()=>{
    restorers.push(fixture.useDocuments({failStore:true}));
    const {page}=await subject({language}), before=fixture.documentStoreCalls();
    const response=await page.goto(`${fixture.baseURL}/profile/documents`);
    assert.equal(response.status(),503,'Store failure returns generic 503');
    check(fixture.documentStoreCalls()>before,'Real document-store boundary fault exercised');
    await textIncludes(page,documentCopy[language].unavailable);
    assert.equal(await page.locator('html').getAttribute('lang'),language,'Unavailable copy retains trusted locale');
    check(!(await page.locator('body').innerText()).includes('synthetic-document-store-private-sentinel'),'Dependency details never displayed');
    assert.equal(await page.locator('main dl').count(),0,'Failure does not fabricate empty slots');
    await noOverflow(page); return {screenshot:await screenshot(page,`documents-unavailable-${language}`)};
  });
  await run('documents-person-isolation',async()=>{
    restorers.push(fixture.useDocuments());
    const alice=await subject(), metadata=await fixture.finalizeSyntheticPhoto(alice.actor);
    const bob=await subject();
    await bob.page.goto(`${fixture.baseURL}/profile/documents`); await documentPage(bob.page,'en');
    await alice.page.goto(`${fixture.baseURL}/profile/documents`); await documentPage(alice.page,'en',metadata);
    await counts(alice.actor,0,0); await counts(bob.actor,0,0);
  });
  // Additive language acceptance. All preceding 54 case bodies remain unchanged.
  for(const language of ['en','ar']) for(const width of [320,390,1280]) {
    const name=`language-review-confirm-reload-${language}-${width}`;
    await run(name,async()=>{
      const {actor,page}=await subject({language,width}), before=await languageState(actor,language,0);
      await languagePreview(page,language);
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Review must not write language or receipts');
      const reviewScreenshot=await screenshot(page,name);
      await languagePost(page,languageConfirm,{expectedStatus:303});
      const state=await languageState(actor,otherLanguage(language),1);
      check(state.updatedAt!==before.updatedAt,'Confirmed language updates durable timestamp');
      assert.equal((await page.reload()).status(),200,'Changed profile reload succeeds');
      await languageProfile(page,otherLanguage(language),state);
      assert.deepEqual(await fixture.inspectLanguage(actor),state,'Reload must not add writes or receipts');
      return {screenshot:reviewScreenshot,disclosureScreenshot:await screenshot(page,`${name}-persisted`),notes:'Native Review 200, Confirm 303 and real profile reload; language-specific durable write and receipt count 1. Provenance checked against database timestamp.'};
    });
  }
  for(const language of ['en','ar']) {
    await run(`language-cancel-history-safe-review-${language}`,async()=>{
      const name=`language-cancel-history-safe-review-${language}`;
      const {actor,page}=await subject({language}), before=await languageState(actor,language,0);
      let nativePosts=0;
      page.on('request',request=>{if(request.isNavigationRequest() && request.method()==='POST') nativePosts++;});
      await languagePreview(page,language);
      assert.equal(nativePosts,1,'Preview uses exactly one native POST');
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Initial Review does not persist preference');
      const cancel=await submit(page,page.getByRole('link',{name:languageCopy[language].cancel,exact:true}));
      assert.equal(cancel?.status(),200,'Native Cancel reaches profile');
      assert.equal(cancel.request().method(),'GET','Cancel is read-only native navigation');
      await visible(page.locator('#profile-heading')); await languageLocale(page,language);
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Cancel does not persist preference');
      // Exercise real session history. Never replace Back with goto or accept a
      // Chromium interstitial, a missing response, or a resubmitted POST.
      const back=await page.goBack({waitUntil:'load'});
      assert.equal(back?.status(),200,'Native Back revalidates Review successfully');
      assert.equal(back.request().method(),'GET','Native Back revalidates with GET, never POST');
      assert.equal(back.headers()['cache-control'],'no-store','Revisited Review is not cached');
      languageReviewURL(page,otherLanguage(language)); await languageReview(page,language);
      check(!/ERR_CACHE_MISS|Confirm Form Resubmission/.test(await page.locator('body').innerText()),'Native Back has no resubmission interstitial');
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Native Back Review does not persist preference');
      const reviewReload=await page.reload({waitUntil:'load'});
      assert.equal(reviewReload?.status(),200,'Native Review reload succeeds');
      assert.equal(reviewReload.request().method(),'GET','Review reload does not resubmit Preview');
      assert.equal(reviewReload.headers()['cache-control'],'no-store','Reloaded Review is not cached');
      languageReviewURL(page,otherLanguage(language)); await languageReview(page,language);
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Review reload does not persist preference');
      const reviewScreenshot=await screenshot(page,`${name}-review`);
      const forward=await page.goForward({waitUntil:'load'});
      check(forward===null || (forward.status()===200 && forward.request().method()==='GET'),'Native Forward returns profile successfully');
      assert.equal(new URL(page.url()).pathname,'/profile','Native Forward reaches profile history entry');
      await visible(page.locator('#profile-heading')); await languageLocale(page,language);
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Native Forward does not persist preference');
      assert.equal((await page.reload()).status(),200,'Profile reload after native Forward succeeds');
      await languageProfile(page,language);
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Profile reload after native history does not persist preference');
      assert.equal(nativePosts,1,'Cancel, Back, Review reload, Forward and profile reload never resubmit POST');
      const profileScreenshot=await screenshot(page,`${name}-profile`);
      // A separate actor deliberately commits once, so the cancel actor above
      // remains a strict zero-write/zero-receipt history acceptance scenario.
      const confirmed=await subject({language});
      let confirmedPosts=0;
      confirmed.page.on('request',request=>{if(request.isNavigationRequest() && request.method()==='POST') confirmedPosts++;});
      await languageState(confirmed.actor,language,0);
      await languagePreview(confirmed.page,language);
      await languagePost(confirmed.page,languageConfirm,{expectedStatus:303});
      const changed=otherLanguage(language), committed=await languageState(confirmed.actor,changed,1);
      await visible(confirmed.page.locator('#profile-heading')); await languageLocale(confirmed.page,changed);
      assert.equal(confirmedPosts,2,'Separate actor submits exactly Preview and Confirm');
      const confirmedBack=await confirmed.page.goBack({waitUntil:'load'});
      assert.equal(confirmedBack?.status(),200,'Native Back after Confirm revalidates Review');
      assert.equal(confirmedBack.request().method(),'GET','Back after Confirm never resubmits a POST');
      assert.equal(confirmedBack.headers()['cache-control'],'no-store','No-change Review is not cached');
      const noChangeReview=async()=>{
        languageReviewURL(confirmed.page,changed); await languageLocale(confirmed.page,changed);
        await visible(confirmed.page.getByRole('heading',{level:1,name:languageCopy[changed].notChanged,exact:true}));
        assert.equal(await confirmed.page.locator(languageConfirm).count(),0,'No-change Review has no Confirm form');
        assert.equal(await confirmed.page.getByRole('button',{name:languageCopy[changed].confirm,exact:true}).count(),0,'No-change Review has no Confirm button');
        assert.equal(await confirmed.page.locator('input[name^="token."]').count(),0,'No-change Review exposes no signed fields');
        check(!/ERR_CACHE_MISS|Confirm Form Resubmission/.test(await confirmed.page.locator('body').innerText()),'No-change Review has no resubmission interstitial');
        await noOverflow(confirmed.page);
        assert.deepEqual(await fixture.inspectLanguage(confirmed.actor),committed,'No-change Review retains exactly the one confirmed write and receipt');
      };
      await noChangeReview();
      const confirmedReload=await confirmed.page.reload({waitUntil:'load'});
      assert.equal(confirmedReload?.status(),200,'No-change Review reload succeeds');
      assert.equal(confirmedReload.request().method(),'GET','No-change Review reload never resubmits a POST');
      assert.equal(confirmedReload.headers()['cache-control'],'no-store','Reloaded no-change Review is not cached');
      await noChangeReview();
      assert.equal(confirmedPosts,2,'Back and no-change reload add no POST after the deliberate confirmation');
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Separate confirmation leaves cancel actor at zero writes and receipts');
      return {screenshot:reviewScreenshot,disclosureScreenshot:profileScreenshot,noChangeScreenshot:await screenshot(confirmed.page,`${name}-confirmed-no-change`),
        cancelActor:{durableWrites:0,durableReceipts:0},confirmedActor:{durableWrites:1,durableReceipts:1},
        notes:'Cancel actor: native Preview POST303 → Review GET200; Cancel → Back → Review reload → Forward → profile reload, with zero writes/receipts and no additional POST. Separate confirmation actor: one deliberate Confirm, then native Back → no-change Review GET200 → reload, with changed locale, no Confirm or signed fields, one unchanged write/receipt and no resubmission.'};
    });
    await run(`language-stale-two-tabs-${language}`,async()=>{
      const {actor,context,page}=await subject({language});
      const second=await context.newPage(); await second.goto(`${fixture.baseURL}/profile`);
      await languagePreview(page,language); await languagePreview(second,language);
      await languagePost(second,languageConfirm,{expectedStatus:303});
      const committed=await languageState(actor,otherLanguage(language),1);
      await languagePost(page,languageConfirm,{expectedStatus:409});
      await languageError(page,otherLanguage(language),'conflict');
      assert.deepEqual(await fixture.inspectLanguage(actor),committed,'Stale tab cannot write a second change');
      return {screenshot:await screenshot(page,`language-stale-two-tabs-${language}`)};
    });
    await run(`language-single-use-confirm-${language}`,async()=>{
      const {actor,page}=await subject({language}); await languagePreview(page,language);
      const first=await languageReplayTarget(page);
      await languagePost(page,languageConfirm,{target:first,expectedStatus:303});
      await languageState(actor,otherLanguage(language),1);
      // Restore the original value through a fresh genuine browser transaction.
      // The untouched first token now matches state again, isolating its spent guard.
      await languagePreview(first,otherLanguage(language));
      await languagePost(first,languageConfirm,{expectedStatus:303});
      const committed=await languageState(actor,language,2);
      const repeated=await languageReplayTarget(page);
      await languagePost(page,languageConfirm,{target:repeated,expectedStatus:409});
      await languageError(repeated,language,'conflict');
      assert.deepEqual(await fixture.inspectLanguage(actor),committed,'Spent token cannot write again after original language is restored');
      return {screenshot:await screenshot(repeated,`language-single-use-confirm-${language}`)};
    });
    for(const mode of ['missing-preview','revoked-confirm','expired-confirm']) await run(`language-session-${mode}-${language}`,async()=>{
      const {actor,context,page}=await subject({language}), before=await languageState(actor,language,0);
      if(mode==='missing-preview') {
        await page.locator('#profile-language').selectOption(otherLanguage(language)); await context.clearCookies();
      } else {
        await languagePreview(page,language); await fixture[mode==='revoked-confirm'?'revoke':'expire'](actor);
      }
      await languagePost(page,mode==='missing-preview'?languageForm:languageConfirm,{expectedStatus:401});
      assert.equal(await page.locator(languageConfirm).count(),0,'Lost session never exposes protected confirmation');
      assert.equal(await page.locator('input[name^="token."]').count(),0,'Lost session never exposes signed fields');
      await textIncludes(page,'Sign in');
      // The existing signed-out shell has lang=en and implicit LTR, not a dir attribute.
      assert.equal(await page.locator('html').getAttribute('lang'),'en','Session loss uses English fallback metadata');
      assert.equal(await page.locator('html').evaluate(node=>getComputedStyle(node).direction),'ltr','Signed-out fallback renders left to right');
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Session loss cannot change preference or receipts');
      return {screenshot:await screenshot(page,`language-session-${mode}-${language}`)};
    });
    await run(`language-invalid-value-${language}`,async()=>{
      const {actor,page}=await subject({language}), before=await languageState(actor,language,0);
      // Deliberately invalid browser input, not a mocked response or hidden token edit.
      await page.locator('#profile-language').evaluate(select=>{const option=new Option('synthetic-invalid-language','synthetic-invalid-language');select.add(option);select.value=option.value;});
      await languagePost(page,languageForm,{expectedStatus:400});
      await languageError(page,language,'invalid');
      check(!(await page.locator('body').innerText()).includes('synthetic-invalid-language'),'Invalid language input must not be echoed');
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Invalid preview cannot write preference');
      return {screenshot:await screenshot(page,`language-invalid-value-${language}`)};
    });
    for(const [stateName,mode] of [['preview-unavailable','preview-read'],['confirm-rollback','confirm-before-commit'],['confirm-acknowledgement-loss','confirm-after-commit']]) await run(`language-${stateName}-${language}`,async()=>{
      const {actor,page}=await subject({language}), before=await languageState(actor,language,0);
      if(mode==='preview-read') await page.locator('#profile-language').selectOption(otherLanguage(language));
      else await languagePreview(page,language);
      const fault=fixture.useLanguageFault(mode); restorers.push(()=>fault.restore());
      await languagePost(page,mode==='preview-read'?languageForm:languageConfirm,{expectedStatus:503});
      await languageError(page,language,mode==='preview-read'?'unavailable':'unknown',{unknown:mode!=='preview-read'});
      const counter=mode==='preview-read'?'previewReadThrows':mode==='confirm-before-commit'?'beforeCommitThrows':'afterCommitThrows';
      assert.equal(fault.evidence[counter],1,'Requested real language dependency boundary exercised once');
      const writes=mode==='confirm-after-commit'?1:0;
      if(mode!=='preview-read') {
        assert.equal(fault.evidence.preferenceWriteStatements,1,'Real preference write statement exercised');
        assert.equal(fault.evidence.receiptInsertStatements,1,'Real language receipt insert exercised');
        assert.equal(fault.evidence.commits,writes,'Fault durable commit count');
        if(mode==='confirm-before-commit') assert.equal(fault.evidence.rollbacks,1,'Failed transaction actually rolled back');
      }
      const durable=await languageState(actor,writes?otherLanguage(language):language,writes);
      if(!writes) assert.deepEqual(durable,before,'Uncommitted failure leaves language timestamp and receipts unchanged');
      const errorScreenshot=await screenshot(page,`language-${stateName}-${language}`);
      fault.restore();
      await submit(page,page.locator('main a[href="/profile"]'));
      assert.equal((await page.reload()).status(),200,'Profile reload resolves uncertain outcome');
      await languageProfile(page,writes?otherLanguage(language):language,writes?durable:{});
      assert.deepEqual(await fixture.inspectLanguage(actor),durable,'Recovery read never writes');
      return {screenshot:errorScreenshot,boundaryCounters:{...fault.evidence},durableWrites:durable.writeCount,durableReceipts:durable.receiptCount,notes:`Real dependency boundary exercised; durable language writes and receipts ${writes}; recovery profile reload verified.`};
    });
    await run(`language-token-expiry-${language}`,async()=>{
      const {actor,page}=await subject({language}), before=await languageState(actor,language,0);
      const expiry=fixture.useLanguageExpiredTokens(); restorers.push(()=>expiry.restore());
      await languagePreview(page,language);
      const expired=await page.locator(languageConfirm).evaluate(form=>{
        const expiresAt=Date.parse(form.elements.namedItem('token.expiresAt').value);
        const issuedAt=Date.parse(form.elements.namedItem('token.issuedAt').value);
        return Number.isFinite(expiresAt) && expiresAt<=Date.now() && expiresAt-issuedAt===300000;
      });
      assert.equal(expiry.evidence.issuances,1,'Actual production signer issued language review token');
      check(expired,'Production-signed language review token must be expired with unchanged five-minute lifetime');
      await languagePost(page,languageConfirm,{expectedStatus:409}); await languageError(page,language,'conflict');
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Expired language token cannot write');
      return {screenshot:await screenshot(page,`language-token-expiry-${language}`),notes:'Production signer with backdated issuance only; unmodified lifetime and real verification clock.'};
    });
  }
  // Eight additive cases: conflict and each independent unknown-outcome action,
  // in both trusted locales. The original 82 case bodies remain unchanged above.
  for(const language of ['en','ar']) for(const [index,stateName] of phoneRecoveryStates.entries()) {
    const name=`phone-recovery-${stateName}-${language}`;
    await run(name,async()=>{
      const copy=phoneRecoveryCopy[language], {actor,context,page}=await subject({language});
      // Distinct valid synthetic contacts prevent cross-case uniqueness collisions.
      const suffix=String((language==='ar'?20:10)+index).padStart(4,'0');
      const draft=`+9655000${suffix}`, current=`+9656000${suffix}`, changed=`+9659000${suffix}`;
      await edit(page,'phone');
      const initial=await page.locator('#field-phone').inputValue();
      await page.locator('#field-phone').fill(draft);
      if(stateName==='conflict-reentry') {
        const other=await context.newPage(); await edit(other,'phone');
        await other.locator('#field-phone').fill(current); await save(other); await phoneRecoverySaved(other,language);
        const before=await counts(actor,1,1); check(before.values.phone===current,'Concurrent phone persisted');
        await phoneRecoveryPost(page,page.locator('#profile-edit-form button[type=submit]'),'/profile/edit/phone/save',409);
        await phoneRecoveryLocale(page,language);
        await visible(page.getByText(copy.conflict,{exact:true})); await visible(page.getByText(copy.reentry,{exact:true}));
        await visible(page.getByRole('textbox',{name:copy.label,exact:true}));
        check(await page.locator('#field-phone').inputValue()==='','Conflict requires deliberate phone re-entry');
        assert.equal(await page.locator('#field-phone').getAttribute('dir'),'ltr','Conflict phone input stays LTR');
        await phonePayloadAbsent(page,[initial,current,draft]); await noOverflow(page);
        const screenshotName=await screenshot(page,name);
        check((await counts(actor,1,1)).values.phone===current,'Stale phone submission does not overwrite concurrent value');
        await page.locator('#field-phone').fill(draft);
        await phoneRecoveryPost(page,page.locator('#profile-edit-form button[type=submit]'),'/profile/edit/phone/save',303);
        await phoneRecoverySaved(page,language);
        check((await counts(actor,2,2)).values.phone===draft,'Deliberate conflict re-entry persists intended phone');
        return {screenshot:screenshotName};
      }
      const faultBefore=fixture.evidence.commitBoundaryThrows;
      const restore=await fixture.useCommitBoundaryFault(); restorers.push(restore);
      await phoneRecoveryPost(page,page.locator('#profile-edit-form button[type=submit]'),'/profile/edit/phone/save',503);
      assert.equal(fixture.evidence.commitBoundaryThrows,faultBefore+1,'Phone save exercises actual lost COMMIT acknowledgement');
      await phoneRecoveryLocale(page,language);
      await visible(page.getByRole('heading',{level:1,name:copy.unknownHeading,exact:true}));
      await visible(page.getByText(copy.unknown,{exact:true})); await visible(page.getByText(copy.retryHelp,{exact:true}));
      await visible(page.getByRole('textbox',{name:copy.label,exact:true}));
      await visible(page.getByRole('button',{name:copy.check,exact:true})); await visible(page.getByRole('button',{name:copy.retry,exact:true}));
      check(await page.locator('#field-phone').inputValue()==='','Unknown phone save requires deliberate retry re-entry');
      assert.equal(await page.locator('#field-phone').getAttribute('dir'),'ltr','Unknown phone input stays LTR');
      assert.equal(await page.locator('form[action="/profile/edit/phone/status"] [name=value]').count(),0,'Read-only phone status carries no phone payload');
      await phonePayloadAbsent(page,[initial,draft]); await noOverflow(page);
      const screenshotName=await screenshot(page,name), before=await counts(actor,1,1);
      check(before.values.phone===draft,'Unknown acknowledgement follows a durable phone commit');
      const receiptUnchanged=await fixture.capturePhoneReceipt(actor);
      let errorScreenshot;
      await restore();
      if(stateName==='status-read-only') {
        // Leave the retry input empty. Native status must not demand phone re-entry.
        await phoneRecoveryPost(page,page.getByRole('button',{name:copy.check,exact:true}),'/profile/edit/phone/status',303);
        await phoneRecoverySaved(page,language);
      } else {
        await page.locator('#field-phone').fill(stateName==='same-phone-retry'?draft:changed);
        await phoneRecoveryPost(page,page.getByRole('button',{name:copy.retry,exact:true}),'/profile/edit/phone/save',stateName==='same-phone-retry'?303:409);
        if(stateName==='same-phone-retry') await phoneRecoverySaved(page,language);
        else {
          await phoneRecoveryLocale(page,language); await visible(page.getByText(copy.different,{exact:true}));
          assert.equal(await page.locator('#profile-edit-form').count(),0,'Changed phone retry has no resubmission form');
          await phonePayloadAbsent(page,[initial,draft,changed]); await noOverflow(page);
          errorScreenshot=await screenshot(page,`${name}-refused`);
        }
      }
      const after=await counts(actor,1,1);
      check(JSON.stringify(after.values)===JSON.stringify(before.values),'Recovery leaves all durable profile values unchanged');
      check(await receiptUnchanged(),'Recovery retains the exact original durable receipt');
      return {screenshot:screenshotName,...(errorScreenshot?{errorScreenshot}:{}),notes:'Real lost COMMIT acknowledgement; one durable phone write and the unchanged original receipt. No phone payload or receipt identifiers recorded.'};
    });
  }
  // Additive native form recovery cases. en/ar describes entered text only;
  // the background UI and synthetic actor preference stay English in every case.
  for(const enteredLanguage of ['en','ar']) for(const kind of ['education','experience','skill','link']) {
    const name=`background-draft-recovery-${kind}-${enteredLanguage}`;
    await run(name,async()=>{
      const restore=fixture.useBackgroundRecords(); restorers.push(restore);
      const {actor,page}=await subject({language:'en',width:390});
      const arabic=enteredLanguage==='ar';
      const first=arabic ? '  مختبر  "نور" & <b>تعلم</b>  ' : '  Noor  "Lab" & <b>Learning</b>  ';
      const second=arabic ? "  بحث  'وتطوير' <img src=x onerror=alert(1)>  " : "  Research  'and design' <img src=x onerror=alert(1)>  ";
      const normalize=value=>value.trim().replace(/\s+/gu,' ').normalize('NFKC');
      const inputs={
        education:{educationType:'custom_university',institutionName:first,customMajor:second,graduationYear:'1900'},
        experience:{title:first,employer:second,startYear:'2024',endYear:'2023'},
        skill:{name:first},
        link:{title:second,url:arabic?'ftp://example.invalid/ملف?x=1&y=2':'ftp://example.invalid/portfolio?x=1&y=2'},
      }[kind];
      const offending={education:'graduationYear',experience:'endYear',skill:'name',link:'url'}[kind];
      const corrected={education:'2026',experience:'2025',skill:second,
        link:arabic?'https://example.invalid/ملف?x=1&y=2':'https://example.invalid/portfolio?x=1&y=2'}[kind];
      const expected={
        education:{educationType:'custom_university',institutionName:normalize(first),customMajor:normalize(second),graduationYear:2026,currentlyStudying:false},
        experience:{title:normalize(first),employer:normalize(second),startYear:2024,endYear:2025},
        skill:{name:normalize(second)},
        link:{title:normalize(second),url:kind==='link'?new URL(corrected).href:''},
      }[kind];
      if(kind==='skill') await fixture.seedBackgroundSkill(actor,first);
      const before=await fixture.inspectBackground(actor,kind);
      assert.equal(before.activeCount,kind==='skill'?1:0,'Explicit synthetic baseline active count');
      assert.equal(before.auditCount,kind==='skill'?1:0,'Explicit synthetic baseline audit count');
      await page.goto(`${fixture.baseURL}/profile/background`);
      const section=page.locator(`#${kind}`), form=section.locator('form.record-form');
      await section.locator('details > summary').click();
      await visible(form);
      for(const [field,value] of Object.entries(inputs)) {
        const control=form.locator(`[name="${field}"]`);
        if(field==='educationType') await control.selectOption(value);
        else await control.fill(value);
      }
      check(await form.evaluate(node=>node.checkValidity()),'Server-invalid draft passes unchanged native HTML validation');
      const postPath=`/profile/background/${kind}`;
      const post=async status=>{
        const responseReady=page.waitForResponse(response=>response.request().method()==='POST' && new URL(response.url()).pathname===postPath);
        const navigation=await submit(page,form.getByRole('button',{name:'Save',exact:false}));
        const response=await responseReady;
        assert.equal(response.status(),status,'Original native POST status');
        assert.equal(response.headers()['cache-control'],'no-store','Native refusal and successful POST are not cached');
        if(status===303) {
          assert.equal(response.headers().location,`/profile/background?saved=${kind}#${kind}`,'Normal save redirect preserved');
          assert.equal(navigation.status(),200,'Correction follows redirect to successful GET');
          assert.equal(navigation.request().method(),'GET','Correction uses PRG');
          assert.equal(new URL(page.url()).pathname,'/profile/background');
        } else {
          assert.equal(response.headers().location,undefined,'Validation refusal does not redirect');
          assert.equal(response.request().redirectedFrom(),null,'Refusal is original POST');
          assert.equal(navigation.status(),status,'Browser receives original validation response');
          assert.equal(new URL(page.url()).pathname,postPath,'Same submitted form remains open');
        }
      };
      await post(kind==='skill'?409:400);
      await visible(form);
      check(await section.locator('details').evaluate(node=>node.open),'Refused Add form remains expanded');
      const errors={education:'Enter a graduation year between 1950 and 2100.',experience:'The end year can’t be before the start year.',skill:'You already have that skill.',link:'Enter a full web address starting with https://'};
      assert.equal(await section.getByRole('alert').innerText(),errors[kind],'Specific service validation error');
      assert.equal(await page.getByRole('status').count(),0,'No false save notice');
      for(const [field,value] of Object.entries(inputs)) assert.equal(await form.locator(`[name="${field}"]`).inputValue(),value,'Exact raw draft retained');
      if(kind==='education') assert.equal(await form.locator('[name="currentlyStudying"]').isChecked(),false,'Unchecked state retained');
      assert.deepEqual(await fixture.inspectBackground(actor,kind),before,'Refusal changes neither active records nor real audit rows');
      const captures=[];
      const capture=async state=>{
        // Check privacy and escaping BEFORE capture, including literal markup-like
        // synthetic strings. No HTML, traces, HAR, cookies or IDs enter evidence.
        await visible(page.getByRole('heading',{level:1,name:'Education and experience.',exact:true}));
        assert.equal(await page.locator('html').getAttribute('lang'),'en','Entered Arabic does not imply a localized UI');
        const shown=await page.locator('body').innerText();
        check(!shown.includes(actor.id) && !shown.includes(actor.cookie.value),'No principal or credential in screenshot');
        assert.equal(await page.locator('main img, main b, main script, main iframe').count(),0,'Draft markup never becomes injected elements');
        check(await page.locator('main *').evaluateAll(nodes=>nodes.every(node=>[...node.attributes].every(attr=>!/^on/i.test(attr.name)))),'Draft quotes never become executable attributes');
        for(const width of [320,390]) {
          await page.setViewportSize({width,height:900});
          await noOverflow(page);
          check(await page.locator('.record-section').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1)),'Background section has no horizontal overflow');
          check(await page.locator('.record-form input:visible, .record-form select:visible').evaluateAll(nodes=>nodes.every(node=>{const rect=node.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth+1;})),'Native controls fit narrow viewport');
          captures.push(await screenshot(page,`${name}-${state}-${width}`));
        }
      };
      await capture('invalid');
      // Deliberate user correction changes only the offending control; all other
      // controls continue to hold their exact original draft values.
      await form.locator(`[name="${offending}"]`).fill(corrected);
      for(const [field,value] of Object.entries(inputs)) assert.equal(await form.locator(`[name="${field}"]`).inputValue(),field===offending?corrected:value,'Only offending control corrected');
      await post(303);
      assert.equal(await section.getByRole('status').innerText(),'Saved.','Actual success notice after correction');
      assert.equal(await page.getByRole('alert').count(),0,'No stale validation alert after correction');
      const after=await fixture.inspectBackground(actor,kind);
      assert.equal(after.activeCount,before.activeCount+1,'Exactly one new durable active record');
      assert.equal(after.auditCount,before.auditCount+1,'Exactly one new durable mutation audit');
      assert.deepEqual(after.fields,[...before.fields,expected],'Durable stored fields match service normalization, not raw draft echo');
      await capture('corrected');
      await page.reload();
      assert.deepEqual(await fixture.inspectBackground(actor,kind),after,'Reload is read-only and durable values remain');
      return {screenshots:captures,baselineActiveRecords:before.activeCount,baselineAudits:before.auditCount,
        refusedRecordDelta:0,refusedAuditDelta:0,correctedRecordDelta:1,correctedAuditDelta:1,
        notes:`${enteredLanguage==='ar'?'Arabic':'English'} entered text; English UI. Exact raw draft survives native ${kind==='skill'?'409 duplicate refusal against one seeded skill/audit':'400 validation refusal'}. Only offending control corrected; native 303 to GET; normalized durable fields verified in real PostgreSQL. Invalid and corrected screenshots at 320/390.`};
    });
  }
  // Six isolated BFCache-enabled cases. All original 98 case bodies and their
  // default launch remain unchanged. A network-only Back cannot pass these.
  setupStage='launch-isolated-bfcache-chromium';
  await verifyBfcacheLaunch(chromium,expected);
  setupStage='run-isolated-bfcache-cases';
  for(const language of ['en','ar']) for(const scenario of bfcacheScenarios) {
    const name=`bfcache-language-${scenario}-${language}`;
    await run(name,async()=>{
      const {actor,context,page,observer}=await bfcacheSubject(language);
      evidence.cases.find(entry=>entry.name===name).bfcache={lifecycleAndNetwork:observer.events};
      const before=await languageState(actor,language,0), profileBefore=await counts(actor,0,0);
      await languagePreview(page,language);
      check(await waitForBfcacheObservation(()=>observer.events.some(event=>event.kind==='lifecycle'
        && event.event==='pageshow' && event.phase==='after-guard' && event.trusted && !event.persisted)),
        'Initial Review has a trusted fresh pageshow');
      const original=observer.events.find(event=>event.kind==='lifecycle' && event.event==='pageshow' && event.phase==='after-guard');
      check(original.actionable && !original.hidden && !original.displayNone,'Initial Review is visible and actionable');
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Initial BFCache Review has no language writes or receipts');
      const cancel=await submit(page,page.getByRole('link',{name:languageCopy[language].cancel,exact:true}));
      check(cancel?.status()===200 && cancel.request().method()==='GET','Cancel navigates to profile with a real GET');
      await visible(page.locator('#profile-heading'));
      assert.deepEqual(await fixture.inspectLanguage(actor),before,'Cancel leaves language writes and receipts at zero');
      let committed=before, cookiesUnchanged;
      if(scenario==='revoked-session') {
        // Revoke only in PostgreSQL, never clear/change browser cookies. Cookie
        // values remain local to this equality check and never enter evidence.
        const cookies=JSON.stringify(await context.cookies());
        await fixture.revoke(actor);
        cookiesUnchanged=JSON.stringify(await context.cookies())===cookies;
        check(cookiesUnchanged,'Server-side revocation leaves browser cookies unchanged');
      } else if(scenario==='intervening-language') {
        // Separate tab, same actor. Exactly one deliberate unrelated Confirm
        // while the first tab's actionable Review is in browser history.
        const second=await context.newPage(); await second.goto(`${fixture.baseURL}/profile`);
        await languagePreview(second,language); await languagePost(second,languageConfirm,{expectedStatus:303});
        committed=await languageState(actor,otherLanguage(language),1);
        await second.close();
      }
      const result=await bfcacheBack(page,observer,original.document);
      languageReviewURL(page,otherLanguage(language));
      if(scenario==='revoked-session') {
        assert.equal(result.status,401,'Fresh Review GET rejects the server-revoked session');
        await textIncludes(page,'Sign in');
        await visible(page.getByRole('link',{name:'Continue with Universe',exact:true}));
        assert.equal(await page.locator('html').getAttribute('lang'),'en','Revoked session uses the existing signed-out shell, not the cached locale');
      } else if(scenario==='intervening-language') {
        assert.equal(result.status,200,'Fresh Review GET resolves intervening language change');
        const current=otherLanguage(language); await languageLocale(page,current);
        await visible(page.getByRole('heading',{level:1,name:languageCopy[current].notChanged,exact:true}));
      } else {
        assert.equal(result.status,200,'Cancel Back refresh resolves current actionable Review');
        await languageReview(page,language);
      }
      if(scenario!=='cancel') {
        assert.equal(await page.locator(languageConfirm).count(),0,'Fresh refusal/no-change Review has no stale Confirm form');
        assert.equal(await page.locator('button[type="submit"]').count(),0,'Fresh refusal/no-change Review has no stale Confirm button');
        assert.equal(await page.locator('input[name^="token."]').count(),0,'Fresh refusal/no-change Review has no signed fields');
      }
      await noOverflow(page);
      assert.equal(observer.nativePosts,1,'Original tab submits Preview once and never replays or confirms during history recovery');
      assert.deepEqual(await fixture.inspectLanguage(actor),committed,'History recovery leaves language state and exact receipt summary unchanged');
      const writes=scenario==='intervening-language'?1:0;
      const profile=await counts(actor,writes,0);
      check(JSON.stringify(profile.values)===JSON.stringify(profileBefore.values),'History recovery does not mutate any other profile field');
      check(await page.evaluate(()=>!document.documentElement.hidden && getComputedStyle(document.documentElement).display!=='none'),
        'Final screenshot captures the visible fresh document');
      const screenshotName=await screenshot(page,name);
      if(!result.established) process.exitCode=1;
      return {status:result.established?'PASS':'NOT_ESTABLISHED',screenshot:screenshotName,
        ...(!result.established?{reason:'No trusted pageshow.persisted restore occurred. Ordinary network Back passed, but BFCache acceptance is not established; see notRestored reason codes.'}:{}),
        bfcache:result.evidence,durableLanguageWrites:writes,durableLanguageReceipts:writes,
        durableProfileWrites:0,totalActorReceipts:writes,originalTabNativePosts:observer.nativePosts,
        ...(scenario==='revoked-session'?{browserCookiesUnchanged:cookiesUnchanged}:{}),
        notes:scenario==='intervening-language'?'One deliberate language change in a separate tab; returning Review resolves no-change with no Confirm or signed fields.':
          scenario==='revoked-session'?'Session revoked in PostgreSQL while away, without touching browser cookies; fresh GET returns signed-out 401 with no Confirm or signed fields.':
            'Cancel and native Back refresh Review without confirming, replaying POST, or writing any preference/receipt.'};
    });
  }
} catch {
  evidence.blockedStage=setupStage;
  evidence.blocker='Browser/fixture setup could not complete. Remaining cases are NOT_RUN; no acceptance claim is made. Verify trusted TLS, PostgreSQL, built runtime and installed Chromium.';
  process.exitCode=1;
} finally {
  for(const context of contexts) await context.close().catch(()=>{});
  if(bfcacheBrowser) await bfcacheBrowser.close().catch(()=>{});
  if(browser) await browser.close().catch(()=>{});
  if(fixture) await fixture.close().catch(()=>{});
  evidence.finishedAt=new Date().toISOString(); await report();
}
