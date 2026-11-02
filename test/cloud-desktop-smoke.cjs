'use strict';
// Real Electron + the local service, with a main-process transport replacement.
// Product code still requires HTTPS; this file does not add an HTTP bypass.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomBytes,randomUUID}=require('node:crypto');
const {Library}=require('../app/library.cjs');
const {createService}=require('../server/service.cjs');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-cloud-desktop-'));
const profiles=[path.join(temporary,'device-a'),path.join(temporary,'device-b')];
const errors=[],checks=[],applications=[];
let service,providerCalls=0;
const fixtureBook={id:'cloud-desktop-book',title:'双机隔离测试',demo:false,segments:[{source:'我们往前走。',translation:'We go.'},{source:'光。',translation:''}],position:0,draft:'',completed:[],stats:{sessions:0,characters:0,seconds:0}};
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
async function launch(index,port){
  const env={...process.env,NOVELTYPE_TEST_DATA:profiles[index]};delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({args:[root],env});applications.push(app);
  await app.evaluate(({net},{port})=>{
    const nativeFetch=net.fetch.bind(net);globalThis.cloudSmokeRequests=[];
    net.fetch=async(url,options)=>{
      const parsed=new URL(url);
      if(parsed.origin!=='https://cloud-smoke.invalid')throw new Error('Unexpected external network request blocked by isolated test');
      globalThis.cloudSmokeRequests.push({method:options?.method||'GET',path:parsed.pathname});
      if(globalThis.cloudSmokeFailSync&&parsed.pathname==='/v1/sync')throw new Error('Simulated offline sync');
      return nativeFetch(`http://127.0.0.1:${port}${parsed.pathname}`,options);
    };
  },{port});
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#book-title').waitFor();return {app,page};
}
async function openAccount(page){await page.locator('#open-account').click();await page.locator('#account-dialog').waitFor();}
async function login(page,username,password){
  if(!await page.locator('#account-dialog').isVisible())await openAccount(page);
  await page.locator('#account-server').fill('https://cloud-smoke.invalid');
  await page.locator('#account-name').fill(username);await page.locator('#account-password').fill(password);
  await page.locator('#account-login').click();
  await page.waitForFunction(()=>document.querySelector('#account-message').textContent==='已登录，同步结果已载入。');
  await page.locator('#account-close').click();
}
async function sync(page){if(!await page.locator('#account-dialog').isVisible())await openAccount(page);await page.locator('#account-sync').click();await page.waitForFunction(()=>document.querySelector('#account-message').textContent.startsWith('已同步。'));await page.locator('#account-close').click();}
async function close(app){const event=app.waitForEvent('close');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await event;applications.splice(applications.indexOf(app),1);}
(async()=>{
  try{
    new Library(profiles[0]).importData({version:1,books:[fixtureBook],activeBookId:fixtureBook.id});
    new Library(profiles[1]);
    service=createService({directory:path.join(temporary,'server'),masterKey:randomBytes(32),allowedBaseUrls:['https://mock-provider.invalid/v1'],fetchImpl:async()=>{
      providerCalls++;return {status:200,ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translation:'Light.',groups:[{english:'Light.',chinese:'光。',occurrence:0}]})}}]})};
    }});
    await service.store.createUser({username:'desktop-admin',password:'isolated-test-only',role:'admin'});
    await service.store.createUser({username:'desktop-other',password:'another-isolated-test',role:'user'});
    await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const port=service.server.address().port;
    const a=await launch(0,port);
    await check('login followed by a network failure restores the original workspace and leaves the old UI attached to it',async()=>{
      await a.app.evaluate(()=>{globalThis.cloudSmokeFailSync=true;});
      await openAccount(a.page);await a.page.locator('#account-server').fill('https://cloud-smoke.invalid');await a.page.locator('#account-name').fill('desktop-admin');await a.page.locator('#account-password').fill('isolated-test-only');await a.page.locator('#account-login').click();
      await a.page.waitForFunction(()=>document.querySelector('#account-message').textContent.includes('无法完成服务器请求'));
      const s=await a.page.evaluate(()=>window.novel.getState());assert.equal(s.account.connected,false);assert.equal(s.activeBookId,fixtureBook.id);assert.equal(await a.page.locator('#book-title').innerText(),fixtureBook.title);
      await a.app.evaluate(()=>{globalThis.cloudSmokeFailSync=false;});await a.page.locator('#account-close').click();
    });
    await check('actual login UI migrates only isolated local data and keeps Electron sandbox boundaries',async()=>{
      await login(a.page,'desktop-admin','isolated-test-only');
      const s=await a.page.evaluate(()=>window.novel.getState());assert.equal(s.account.user.username,'desktop-admin');assert.equal(s.activeBookId,fixtureBook.id);assert.equal(s.books[0].segments[0].translation,'We go.');
      assert.equal(await a.page.evaluate(()=>typeof require),'undefined');
      const security=await a.app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});assert.deepEqual(security,{sandbox:true,contextIsolation:true,nodeIntegration:false});
    });
    await check('typing retains original case and synchronizes exact draft',async()=>{
      await a.page.locator('#typing-input').click();await a.page.locator('#typing-input').pressSequentially('wE ',{delay:20});await sync(a.page);
      assert.equal(await a.page.locator('#typing-input').inputValue(),'wE ');
      assert.equal((await a.page.evaluate(()=>window.novel.getAccount())).pending,0);
    });
    await check('server provider configuration is redacted and remote preparation reaches only simulated provider once',async()=>{
      await a.page.evaluate(()=>window.novel.saveSettings({provider:'custom',baseUrl:'https://mock-provider.invalid/v1',model:'test-model',apiKey:'isolated-provider-secret'}));
      const result=await a.page.evaluate(id=>window.novel.preparePassage({bookId:id,index:1}),fixtureBook.id);assert.equal(result.translation,'Light.');assert.equal(providerCalls,1);
      const cached=await a.page.evaluate(id=>window.novel.preparePassage({bookId:id,index:1}),fixtureBook.id);assert.equal(cached.translation,'Light.');assert.equal(providerCalls,1);
      assert.ok(!JSON.stringify(await a.page.evaluate(()=>window.novel.getState())).includes('isolated-provider-secret'));await sync(a.page);
    });
    await check('game result persists through the production IPC and enters the account sync',async()=>{
      const content=await a.page.evaluate(()=>window.novel.getGameData({bookId:'sample'}));
      const result={bookId:'sample',runId:randomUUID(),mode:'race',levelId:1,passageId:content.passages[0].id,won:true,stars:2,score:100,seconds:30,accuracy:98,wpm:40};
      await a.page.evaluate(value=>window.novel.saveGameResult(value),result);await sync(a.page);
      assert.equal((await a.page.evaluate(()=>window.novel.getGameData({bookId:'sample'}))).progress.levels['1'].stars,2);
    });
    await close(a.app);
    const b=await launch(1,port);
    await check('second isolated computer receives the same book, draft, translated text, alignment, provider and game progress',async()=>{
      await login(b.page,'desktop-admin','isolated-test-only');
      const s=await b.page.evaluate(()=>window.novel.getState());const book=s.books.find(v=>v.id===fixtureBook.id);
      assert.equal(s.activeBookId,fixtureBook.id);assert.equal(book.draft,'wE ');assert.equal(book.segments[1].translation,'Light.');assert.equal(s.settings.hasKey,true);assert.equal(s.settings.model,'test-model');
      assert.ok((await b.page.evaluate(id=>window.novel.getAlignment({bookId:id,index:1}),fixtureBook.id)).spans.length);
      assert.equal((await b.page.evaluate(()=>window.novel.getGameData({bookId:'sample'}))).progress.levels['1'].stars,2);
      assert.equal(providerCalls,1);
    });
    let raceProgress;
    await check('a complete novel race updates reading and game progress through the account outbox',async()=>{
      await b.page.locator('#nav-games').click();await b.page.locator('#game-race-open').click();
      assert.equal(await b.page.locator('#game-race-text').textContent(),'We go.');
      await b.page.locator('#game-start').click();await b.page.locator('#game-input').pressSequentially('wE GO.',{delay:35});
      await b.page.waitForFunction(()=>document.querySelector('#game-save-status')?.textContent.includes('已保存'));
      raceProgress=(await b.page.evaluate(()=>window.novel.getState())).books.find(book=>book.id===fixtureBook.id);
      assert.equal(raceProgress.position,1);assert.equal(raceProgress.draft,'');assert.deepEqual(raceProgress.completed,[0]);assert.equal(raceProgress.stats.sessions,1);
      await sync(b.page);assert.equal((await b.page.evaluate(()=>window.novel.getAccount())).pending,0);
      assert.equal((await b.page.evaluate(id=>window.novel.getGameData({bookId:id}),fixtureBook.id)).progress.recent[0].won,true);
      assert.equal(providerCalls,1);
    });
    await check('logout restores device-local library and another account cannot see the previous account books',async()=>{
      await openAccount(b.page);await b.page.locator('#account-logout').click();await b.page.waitForFunction(()=>document.querySelector('#account-message').textContent.startsWith('已退出'));
      let s=await b.page.evaluate(()=>window.novel.getState());assert.equal(s.account.connected,false);assert.ok(!s.books.some(v=>v.id===fixtureBook.id));
      await login(b.page,'desktop-other','another-isolated-test');s=await b.page.evaluate(()=>window.novel.getState());assert.equal(s.account.user.username,'desktop-other');assert.ok(!s.books.some(v=>v.id===fixtureBook.id));assert.equal(s.settings.hasKey,false);
      assert.deepEqual(errors,[]);
    });
    await close(b.app);
    const resumed=await launch(0,port);
    await check('the first computer receives both the new race result and the next reading paragraph without restoring its old draft',async()=>{
      await sync(resumed.page);
      const state=await resumed.page.evaluate(()=>window.novel.getState()),book=state.books.find(book=>book.id===fixtureBook.id);
      if(book.position!==1){const account=await resumed.page.evaluate(()=>window.novel.getAccount());console.error('Race sync diagnostic '+JSON.stringify({position:book.position,completed:book.completed,stats:book.stats,pending:account.pending,conflicts:account.conflicts?.map(({kind,key,currentRevision})=>({kind,key,currentRevision}))}));}
      assert.equal(book.position,1);assert.equal(book.draft,'');assert.deepEqual(book.completed,[0]);assert.deepEqual(book.stats,raceProgress.stats);
      assert.equal(await resumed.page.locator('.story-passage.is-active').getAttribute('data-index'),'1');
      assert.equal(await resumed.page.locator('#typing-input').inputValue(),'');
      const content=await resumed.page.evaluate(id=>window.novel.getGameData({bookId:id}),fixtureBook.id);
      assert.equal(content.progress.recent[0].won,true);assert.ok(Object.keys(content.progress.bestRaces).length>0);
      assert.equal(providerCalls,1);assert.deepEqual(errors,[]);
    });
    await close(resumed.app);
    fs.mkdirSync(path.join(root,'evidence'),{recursive:true});fs.writeFileSync(path.join(root,'evidence/cloud-desktop-tests.json'),JSON.stringify({checks,isolatedProfiles:2,providerCalls,errors,externalNetwork:false},null,2));
    console.log(JSON.stringify({passed:checks.length,providerCalls,isolatedProfiles:2}));
  }finally{
    for(const app of applications)try{await app.evaluate(({app})=>app.exit(0));await app.close();}catch{}
    if(service)await service.close();
    const resolved=path.resolve(temporary),prefix=path.resolve(os.tmpdir())+path.sep;if(!resolved.startsWith(prefix)||!path.basename(resolved).startsWith('noveltype-cloud-desktop-'))throw Error('Unexpected cleanup path');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
