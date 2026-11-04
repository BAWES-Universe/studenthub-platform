/** Real browser + real gateway/Postgres acceptance. Never record tokens, HTML, HAR or traces. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const output = path.resolve(process.env.BROWSER_ACCEPTANCE_ARTIFACTS || process.env.BROWSER_ARTIFACT_DIR || 'artifacts/browser-acceptance');
const names = [
  ...['en','ar'].flatMap(language => [320,390,1280].map(width => `layout-${language}-${width}`)),
  ...['en','ar'].flatMap(language => [320,390,1280].map(width => `editor-error-${language}-${width}`)),
  'arabic-save-clear', 'arabic-conflict', 'arabic-recovery',
  'keyboard-disclosure-accessible-controls', 'one-field-save-and-clear', 'invalid-phone-non-echo',
  'invalid-name-error-focus', 'nationality-mother-eligibility', 'native-radio-validation', 'conflict-fresh-state', 'cancel-back-forward', 'repeated-submission',
  'two-tab-notice-overwrite-clear', 'session-revocation', 'session-expiry',
  'committed-response-loss', 'uncertain-commit-status-read-only', 'uncertain-commit-exact-retry',
  'uncertain-commit-changed-draft-rejected', 'actual-token-expiry',
];
const evidence = { schemaVersion:1, syntheticOnly:true, candidateSha:null, playwrightVersion:null,
  chromiumVersion:null, expectedChromiumVersion:null, chromiumRevision:null, startedAt:new Date().toISOString(), cases:names.map(name=>({name,status:'NOT_RUN'})),
  policy:'Synthetic data only. No cookies, hidden tokens, credentials, HTML dumps, traces or HAR recorded. TLS verification enabled.' };
let browser, fixture;
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
// Hold original form only inside the live browser realm. Never serialize it to runner/log/artifact.
async function rememberForm(page) {
  await page.evaluate(() => {const form=document.querySelector('#profile-edit-form'); window.__acceptanceForm={action:form.action,body:new URLSearchParams(new FormData(form)).toString()};});
}
async function replay(page) {
  return page.evaluate(async()=>{try {const r=await fetch(window.__acceptanceForm.action,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:window.__acceptanceForm.body,redirect:'manual'});return {status:r.status,type:r.type};}catch{return {transportLost:true};}});
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
  await writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  const lines=['# StudentHub browser acceptance','',`Candidate SHA: ${evidence.candidateSha || 'NOT_RUN'}`,`Playwright: ${evidence.playwrightVersion || 'NOT_RUN'}`,`Chromium: ${evidence.chromiumVersion || 'NOT_RUN'}`,'',evidence.policy,'',...evidence.cases.map(c=>`- ${c.status}: ${c.name}${c.screenshot ? ` ([screenshot](${c.screenshot}))` : ''}${c.stressScreenshot ? ` ([long-value stress](${c.stressScreenshot}))` : ''}${c.editorScreenshot ? ` ([editor](${c.editorScreenshot}))` : ''}${c.errorScreenshot ? ` ([validation](${c.errorScreenshot}))` : ''}${c.reason ? ` — ${c.reason}` : ''}`)];
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
    for(const link of await page.locator('.p-edit').all()) check((await link.getAttribute('aria-label') || await link.innerText()).trim().length>0,'Accessible edit name');
    await edit(page,'objective');
    await visible(page.getByRole('textbox',{name:/objective/i}));
    await visible(page.getByRole('button',{name:'Save',exact:true}));
    await page.locator('#field-objective').focus(); await page.keyboard.press('Tab');
    check(await page.locator('button[type=submit]').evaluate(n=>n===document.activeElement),'Tab reaches Save');
    check(await page.locator('button[type=submit]').evaluate(n=>getComputedStyle(n).outlineStyle!=='none'),'Visible keyboard focus');
    return {screenshot:await screenshot(page,'keyboard-focus')};
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
    const {actor,page}=await subject(); await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic exact replay'); await rememberForm(page);
    assert.equal((await replay(page)).type,'opaqueredirect','First real save redirects successfully');
    assert.equal((await replay(page)).type,'opaqueredirect','Exact repeated submission redirects successfully');
    await counts(actor,1,1);
    await page.goto(`${fixture.baseURL}/profile`); await saved(page); await textIncludes(page,'Synthetic exact replay');
  });
  await run('two-tab-notice-overwrite-clear',async()=>{
    const {actor,context,page}=await subject(); const other=await context.newPage();
    await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic tab one'); await rememberForm(page); assert.equal((await replay(page)).type,'opaqueredirect','First tab save succeeds');
    await edit(other,'preferredTime'); await other.locator('[name=value]').fill('Synthetic tab two'); await rememberForm(other); assert.equal((await replay(other)).type,'opaqueredirect','Second tab save succeeds');
    check((await context.cookies()).some(c=>c.name==='studenthub_profile_notice'),'Real shared notice cookie exists');
    await page.goto(`${fixture.baseURL}/profile#field-objective`); await saved(page);
    assert.equal((await page.locator('#profile-notice p').innerText()).trim(),'A profile change was saved. Your current profile is shown below.','Notice remains generic across tabs');
    check(!(await context.cookies()).some(c=>c.name==='studenthub_profile_notice'),'Receipt notice cleared across context');
    await other.goto(`${fixture.baseURL}/profile`); assert.equal(await other.locator('#profile-notice').count(),0,'Second tab cannot reuse cleared notice'); await counts(actor,2,2);
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
    const {actor,page}=await subject(); await edit(page,'objective'); await page.locator('[name=value]').fill('Synthetic lost response'); await rememberForm(page);
    const droppedBefore=fixture.evidence.transportResponsesDropped;
    await fixture.armTransportLoss(); const result=await replay(page);
    assert.equal(fixture.evidence.transportResponsesDropped,droppedBefore+1,'Server actually dropped committed HTTP response'); check(result.transportLost,'Real HTTP connection loss observed'); await counts(actor,1,1);
    assert.equal((await replay(page)).type,'opaqueredirect','Lost-response exact retry succeeds');
    await counts(actor,1,1); await page.goto(`${fixture.baseURL}/profile`); await saved(page); await textIncludes(page,'Synthetic lost response');
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
} catch {
  evidence.blockedStage=setupStage;
  evidence.blocker='Browser/fixture setup could not complete. Remaining cases are NOT_RUN; no acceptance claim is made. Verify trusted TLS, PostgreSQL, built runtime and installed Chromium.';
  process.exitCode=1;
} finally {
  for(const context of contexts) await context.close().catch(()=>{});
  if(browser) await browser.close().catch(()=>{});
  if(fixture) await fixture.close().catch(()=>{});
  evidence.finishedAt=new Date().toISOString(); await report();
}
