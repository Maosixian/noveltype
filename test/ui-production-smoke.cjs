const {_electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-ui-production-'));
const env={...process.env,NOVELTYPE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
const report={checks:[],screens:[],errors:[]};let app,page;
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function capture(name){await page.waitForTimeout(180);const file='arcade-production-'+name+'.png';await page.screenshot({path:path.join(root,'evidence',file),fullPage:false});report.screens.push(file);}
async function fits(){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal document overflow');}
(async()=>{try{
 app=await _electron.launch({args:[root],env});page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));
 assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),path.resolve(data));
 await page.locator('#book-title').waitFor();
 await app.evaluate(({net})=>{globalThis.uiNetworkCalls=0;net.fetch=async()=>{globalThis.uiNetworkCalls++;throw new Error('No network in UI smoke');};});
 await check('appearance dialog pauses input, saves mode and restores focus',async()=>{
  await page.locator('#typing-input').click();await page.locator('#typing-input').pressSequentially('at ');
  await page.locator('#open-appearance').click();await page.locator('#appearance-dialog').waitFor();
  assert.equal(await page.locator('#typing-input').evaluate(el=>el.readOnly),true);
  await page.locator('#motion-preference').selectOption('off');assert.equal(await page.locator('html').getAttribute('data-motion'),'off');
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'open-appearance');
  await page.reload();await page.locator('#book-title').waitFor();assert.equal(await page.locator('html').getAttribute('data-motion'),'off');
  await page.locator('#open-appearance').click();await page.locator('#motion-preference').selectOption('full');await page.keyboard.press('Escape');
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.documentElement.dataset.motion==='reduced');
  await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>document.documentElement.dataset.motion==='full');
 });
 await check('reading and real game surfaces fit desktop and compact window',async()=>{
  for(const [w,h]of [[1380,930],[960,760],[880,680]]){
   await app.evaluate(({BrowserWindow},{w,h})=>BrowserWindow.getAllWindows()[0].setSize(w,h),{w,h});
   await page.locator('#nav-reading').click();await page.waitForFunction(()=>document.querySelector('#nav-reading').getAttribute('aria-current')==='page');await fits();await capture('reading-'+w);
   await page.locator('#theme-toggle').click();await fits();await capture('reading-alt-'+w);await page.locator('#theme-toggle').click();
   await page.locator('#nav-games').click();await page.locator('#game-map-open').waitFor();assert.equal(await page.locator('#nav-games').getAttribute('aria-current'),'page');await fits();await capture('home-'+w);
   assert.ok(await page.locator('.game-world-hero').evaluate(el=>getComputedStyle(el).backgroundImage.includes('arcade-world')));
   await page.locator('#game-race-open').click();await page.locator('#game-input').waitFor();await fits();await capture('race-'+w);
   assert.ok(await page.locator('#game-start').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight-16),'race start must fit with margin');
   await page.locator('#game-leave').click();await page.locator('#game-defense-open').click();await page.locator('#game-input').waitFor();await fits();await capture('defense-'+w);
   assert.ok(await page.locator('#game-start').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight-16),'defense start must fit with margin');
   await page.locator('#nav-map').click();await page.locator('.game-map-node').first().waitFor();await fits();await capture('map-'+w);
  }
 });
 await check('account and translation settings remain keyboard reachable',async()=>{
  await page.locator('#open-account').click();await page.locator('#account-dialog').waitFor();await fits();await capture('account');await page.keyboard.press('Escape');
  await page.locator('#nav-reading').click();await page.locator('#open-settings').click();await page.locator('#settings-dialog').waitFor();await fits();await capture('settings');await page.keyboard.press('Escape');
 });
 await check('long titles and input stay within content width',async()=>{
  await page.evaluate(async()=>window.novel.importText({title:'很长的小说名称与英文标题 '.repeat(7),text:'这是完整的原创界面测试文字，不包含任何用户小说。'}));
  await page.reload();await page.locator('#book-title').waitFor();await fits();await capture('long-title');
 });
 assert.deepEqual(report.errors,[]);assert.equal(await app.evaluate(()=>globalThis.uiNetworkCalls),0);report.networkCalls=0;
 fs.writeFileSync(path.join(root,'evidence/ui-production-tests.json'),JSON.stringify(report,null,2));
}finally{if(app)await app.close();assert.equal(path.dirname(path.resolve(data)),path.resolve(os.tmpdir()));fs.rmSync(data,{recursive:true,force:true,maxRetries:5,retryDelay:100});}})().catch(e=>{console.error(e);process.exitCode=1;});
