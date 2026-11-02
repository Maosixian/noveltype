'use strict';
// Full-paragraph racing exercises the real preload, main process and durable
// Library in an isolated synthetic profile. No real novels, keys or API calls.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const {AlignmentCache}=require('../app/alignment.cjs');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-paragraph-race-'));
const evidence=path.join(root,'evidence'),id='paragraph-race-fixture';
const longTarget=Array.from({length:14},(_,index)=>`The traveler follows the quiet river beyond marker ${index+1}.`).join(' ')
  +'\nA silver lantern waits beside the gate.';
const book={id,title:'整段竞速与阅读接续 · 合成测试',demo:false,position:3,draft:'tHE ',completed:[],stats:{sessions:0,characters:0,seconds:0},segments:Array.from({length:80},(_,index)=>({source:`原创测试段落${index+1}。`,translation:index===3?longTarget:index===65?'Amber zeppelins circle the marigold valley. '.repeat(8).trim():[66,67,68].includes(index)?'':`The harbor waits at marker ${index+1}.`}))};
new Library(data).importData({version:1,books:[book],activeBookId:id});
// Cached neighbors let the final reading-resume test verify that the deferred
// preparation itself schedules no extra AI work, including after completion.
const alignmentCache=new AlignmentCache(data);
for(const {source,translation}of book.segments)if(translation)alignmentCache.set(source,translation,{version:1,spans:[{englishStart:0,englishEnd:translation.length,sourceStart:0,sourceEnd:source.length}]});
const env={...process.env,NOVELTYPE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
const report={checks:[],errors:[],isolatedData:true,realNetworkRequests:0,passed:false};
let app,page;
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function launch(){
 app=await _electron.launch({args:[root],env});
 assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),path.resolve(data));
 await app.evaluate(({net,ipcMain})=>{
  globalThis.paragraphProviderCalls=0;globalThis.paragraphFailProvider=false;globalThis.paragraphHoldProvider=false;
  net.fetch=async(_url,options)=>{
   paragraphProviderCalls++;
   if(paragraphHoldProvider)await new Promise(resolve=>{globalThis.paragraphReleaseProvider=resolve;});
   if(paragraphFailProvider)return new Response('{}',{status:429});
   const source=JSON.parse(JSON.parse(options.body).messages[1].content).source,translation='A new journey begins.';
   return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translation,groups:[{english:translation,chinese:source,occurrence:0}]})}}]}),{status:200});
  };
  const save=ipcMain._invokeHandlers.get('novel:saveGameResult');
  ipcMain._invokeHandlers.set('novel:saveGameResult',(event,payload)=>{globalThis.paragraphLastResult=structuredClone(payload);return save(event,payload);});
 });
 page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));
 await page.locator('.story-passage.is-active').waitFor();
}
async function close(){const closed=app.waitForEvent('close');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;app=null;}
const progress=()=>page.evaluate(async id=>{const b=(await window.novel.getState()).books.find(book=>book.id===id);return {position:b.position,draft:b.draft,completed:b.completed,stats:b.stats};},id);
const providerCalls=()=>app.evaluate(()=>paragraphProviderCalls);
async function saved(){await page.waitForFunction(()=>document.querySelector('#game-save-status')?.textContent.includes('已保存'),{},{timeout:10000});}
async function selectParagraph(index){await page.locator('#game-paragraph-index').fill(String(index+1));await page.locator('#game-paragraph-load').click();await page.waitForFunction(index=>document.querySelector('#game-paragraph-index')?.value===String(index+1),index);}
async function typeText(text){
 const input=page.locator('#game-input'),lines=text.split('\n');
 for(let index=0;index<lines.length;index++){
  if(index)await input.press('Enter');
  await input.pressSequentially(lines[index],{delay:2});
 }
}
async function openRace(){await page.locator('#nav-games').click();await page.locator('#game-race-open').click();await page.locator('#game-paragraph-index').waitFor();}
(async()=>{try{
 await launch();
 await check('free race defaults to the saved reading paragraph and retains its complete multiline target',async()=>{
  await openRace();
  assert.equal(await page.locator('#game-paragraph-index').inputValue(),'4');
  assert.equal(await page.locator('#game-race-text').textContent(),longTarget);
  assert.ok(longTarget.length>600);assert.equal(await page.locator('#game-race-source').textContent(),book.segments[3].source);
  assert.deepEqual(await progress(),{position:3,draft:'tHE ',completed:[],stats:{sessions:0,characters:0,seconds:0}});
  assert.equal(await providerCalls(),0);
 });
 await check('ending an incomplete race leaves the reading draft, bookmark and statistics unchanged',async()=>{
  const before=await progress();await page.locator('#game-start').click();await typeText('The traveler!');
  await page.locator('#game-end').click();await saved();assert.deepEqual(await progress(),before);
  await page.locator('#nav-reading').click();assert.equal(await page.locator('#typing-input').inputValue(),'tHE ');
  assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'3');
 });
 let completedProgress;
 await check('reader paragraph shortcut opens the same target; corrected punctuation and mixed case complete it exactly once',async()=>{
  await page.locator('.story-passage[data-index="3"] .race-here').click();
  assert.equal(await page.locator('#game-paragraph-index').inputValue(),'4');assert.equal(await page.locator('#game-race-text').textContent(),longTarget);
  await page.locator('#game-start').click();
  await typeText(longTarget.slice(0,-1).toUpperCase()+'!');
  assert.equal(await page.locator('#game-result').isVisible(),false);
  assert.ok(await page.locator('#game-race-text .is-wrong').count()>0);
  assert.equal((await progress()).position,3);
  assert.ok((await page.locator('#game-input').inputValue()).includes('\n'));
  await page.locator('#game-input').press('Backspace');await typeText('.');await saved();
  completedProgress=await progress();assert.equal(completedProgress.position,4);assert.equal(completedProgress.draft,'');
  assert.deepEqual(completedProgress.completed,[3]);assert.equal(completedProgress.stats.sessions,1);
  assert.equal(completedProgress.stats.characters,longTarget.length);assert.ok(completedProgress.stats.seconds>0);
  const payload=await app.evaluate(()=>paragraphLastResult);
  await page.evaluate(payload=>window.novel.saveGameResult(payload),payload);
  assert.deepEqual(await progress(),completedProgress);
  assert.equal(await page.locator('#game-next-paragraph').isEnabled(),true);
  assert.equal(await providerCalls(),0);
 });
 await check('returning to reading and restarting preserve the race completion without replaying the old draft',async()=>{
  await page.locator('#nav-reading').click();assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'4');
  assert.equal(await page.locator('#typing-input').inputValue(),'');assert.deepEqual(await progress(),completedProgress);
  await close();await launch();assert.deepEqual(await progress(),completedProgress);
  assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'4');
 });
 await check('arbitrary paragraph selection reaches beyond the cached picker and browsing does not move the reading bookmark',async()=>{
  await openRace();await selectParagraph(65);
  await page.waitForFunction(text=>document.querySelector('#game-race-text')?.textContent===text,book.segments[65].translation);
  assert.equal(await page.locator('#game-race-source').textContent(),book.segments[65].source);
  await page.locator('#game-paragraph-prev').click();await page.waitForFunction(()=>document.querySelector('#game-paragraph-index')?.value==='65');
  await page.locator('#game-paragraph-next').click();await page.waitForFunction(()=>document.querySelector('#game-paragraph-index')?.value==='66');
  await page.locator('#game-paragraph-current').click();await page.waitForFunction(()=>document.querySelector('#game-paragraph-index')?.value==='5');
  assert.deepEqual(await progress(),completedProgress);assert.equal(await providerCalls(),0);
  await selectParagraph(65);await page.waitForFunction(text=>document.querySelector('#game-race-text')?.textContent===text,book.segments[65].translation);
  await page.locator('#game-start').click();await typeText(book.segments[65].translation.toUpperCase());await saved();
  const next=await progress();assert.equal(next.position,66);assert.deepEqual(next.completed,[3,65]);assert.equal(next.stats.sessions,2);
  await page.locator('#game-next-paragraph').click();await page.waitForFunction(()=>document.querySelector('#game-paragraph-index')?.value==='67');
  const start=page.locator('#game-start');assert.ok(await start.count()===0||await start.isDisabled());await page.locator('#game-prepare').waitFor();assert.equal(await providerCalls(),0);
 });
 await check('an untranslated paragraph prepares only on explicit action; failure never silently retries or advances progress',async()=>{
  await page.evaluate(()=>window.novel.saveSettings({provider:'glm',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4.7-flash',apiKey:'isolated-test-placeholder'}));
  const before=await progress();await app.evaluate(()=>{paragraphFailProvider=true;});
  await page.locator('#game-prepare').click();await page.waitForFunction(()=>document.querySelector('#game-prepare')?.textContent.includes('重试'));
  await page.waitForTimeout(300);assert.equal(await providerCalls(),1);assert.deepEqual(await progress(),before);
  await app.evaluate(()=>{paragraphFailProvider=false;});await page.locator('#game-prepare').click();
  await page.waitForFunction(()=>document.querySelector('#game-race-text')?.textContent==='A new journey begins.');
  assert.equal(await providerCalls(),2);assert.equal(await page.locator('#game-start').isEnabled(),true);
  await page.waitForTimeout(250);assert.equal(await providerCalls(),2);
  await page.locator('#game-start').click();await typeText('a NEW JOURNEY BEGINS.');await saved();
  const next=await progress();assert.equal(next.position,67);assert.deepEqual(next.completed,[3,65,66]);assert.equal(next.stats.sessions,3);
  await page.locator('#nav-reading').click();assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'67');
  assert.equal(await page.locator('.story-passage[data-index="66"] .stream-english').textContent(),'A new journey begins.');
  assert.equal(await providerCalls(),2);
 });
 await check('defense enemies and map excerpts use the chosen paragraph while preserving reading progress',async()=>{
  const before=await progress();await page.locator('#nav-games').click();await selectParagraph(65);
  await page.locator('#game-defense-open').click();await page.locator('#game-start').click();
  await page.locator('.game-enemy-word').first().waitFor();const word=await page.locator('.game-enemy-word').first().textContent();
  assert.ok(book.segments[65].translation.toLowerCase().includes(word.toLowerCase()));
  await page.locator('#game-input').pressSequentially(word.toUpperCase(),{delay:25});
  await page.waitForFunction(()=>Number(document.querySelector('#game-score')?.textContent)>0);
  const context=await page.locator('#game-word-context').textContent();assert.ok(context.includes(book.segments[65].source));assert.ok(context.includes(book.segments[65].translation));
  await page.locator('#game-end').click();await saved();assert.deepEqual(await progress(),before);
  await page.locator('#game-leave').click();await page.locator('#game-map-open').click();
  assert.equal(await page.locator('#game-paragraph-index').inputValue(),'66');
  await page.locator('.game-map-node[data-level-id="1"]').click();
  const target=await page.locator('#game-race-text').textContent();assert.ok(target.length<=260);assert.ok(book.segments[65].translation.startsWith(target));
  assert.equal(await page.locator('#game-race-source').textContent(),book.segments[65].source);
  await page.locator('#game-start').click();await typeText(target.toUpperCase());await saved();
  assert.deepEqual(await progress(),before);assert.equal(await providerCalls(),2);
  await page.locator('#nav-reading').click();assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'67');
 });
 await check('finishing the last selected paragraph marks it complete without stepping beyond the book',async()=>{
  await openRace();await selectParagraph(79);await page.waitForFunction(text=>document.querySelector('#game-race-text')?.textContent===text,book.segments[79].translation);
  await page.locator('#game-start').click();await typeText(book.segments[79].translation);await saved();
  const final=await progress();assert.equal(final.position,79);assert.ok(final.completed.includes(79));assert.equal(final.stats.sessions,4);
  const next=page.locator('#game-next-paragraph');assert.ok(await next.count()===0||await next.isDisabled()||!await next.isVisible());
  await page.locator('#nav-reading').click();assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'79');
  assert.deepEqual(await progress(),final);assert.equal(await providerCalls(),2);
 });
 await check('a changed reading bookmark during a race is retained by the result callback, return to reading and restart',async()=>{
  await openRace();await selectParagraph(70);await page.waitForFunction(text=>document.querySelector('#game-race-text')?.textContent===text,book.segments[70].translation);
  await page.locator('#game-start').click();
  // Simulate an independent accepted progress update after the round obtained
  // its ticket. The old round must not overwrite this newer position or draft.
  await page.evaluate(id=>window.novel.saveProgress({bookId:id,position:72,draft:'Ne'}),id);
  const changed=await progress();await typeText(book.segments[70].translation.toUpperCase());await saved();
  assert.deepEqual(await progress(),changed);assert.match(await page.locator('#game-save-status').textContent(),/保留.*阅读位置/);
  await page.locator('#nav-reading').click();assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'72');
  assert.equal(await page.locator('#typing-input').inputValue(),'Ne');assert.deepEqual(await progress(),changed);
  await close();await launch();assert.deepEqual(await progress(),changed);assert.equal(await page.locator('#typing-input').inputValue(),'Ne');
 });
 await check('a deferred game preparation updates the paused reading target after navigation and resumes from that exact segment',async()=>{
  await page.locator('.story-passage[data-index="68"] .practice-here').click();
  await page.waitForFunction(()=>document.querySelector('.story-passage.is-active')?.dataset.index==='68');
  const before=await progress();assert.equal(before.position,68);assert.equal(before.draft,'');
  await app.evaluate(()=>{paragraphHoldProvider=true;});await openRace();await page.locator('#game-prepare').click();
  await app.evaluate(async()=>{const limit=Date.now()+5000;while(typeof paragraphReleaseProvider!=='function'&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,10));});
  if(!await app.evaluate(()=>typeof paragraphReleaseProvider==='function'))throw Error('Deferred preparation did not reach the simulated provider: '+await page.locator('#games-view').textContent());
  assert.equal(await providerCalls(),1);await page.locator('#nav-reading').click();
  assert.equal(await page.locator('#pause').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#typing-input').isDisabled(),true);
  assert.equal((await page.evaluate(()=>window.novel.getState())).books[0].segments[68].translation,'');
  assert.match(await page.locator('#translation-text').textContent(),/等待准备/);assert.deepEqual(await progress(),before);
  await app.evaluate(()=>{paragraphHoldProvider=false;paragraphReleaseProvider();});
  await page.waitForFunction(()=>document.querySelector('#translation-text')?.textContent==='A new journey begins.');
  assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'68');
  assert.equal(await page.locator('#typing-input').isDisabled(),false);assert.equal(await page.locator('#typing-input').getAttribute('readonly'),'');
  assert.equal(await page.locator('#pause').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#typing-input').inputValue(),'');
  assert.notEqual(await page.evaluate(()=>document.activeElement.id),'typing-input');assert.deepEqual(await progress(),before);
  await page.waitForTimeout(200);assert.equal(await providerCalls(),1);
  await page.locator('#pause').click();await page.waitForFunction(()=>document.activeElement.id==='typing-input'&&!document.querySelector('#typing-input').readOnly);
  await page.locator('#typing-input').pressSequentially('a NEW JOURNEY BEGINS.',{delay:20});
  await page.waitForFunction(()=>document.querySelector('.story-passage.is-active')?.dataset.index==='69');
  await page.locator('#pause').click();await page.waitForFunction(()=>document.querySelector('#save-state')?.textContent.startsWith('✓'));
  const after=await progress();assert.equal(after.position,69);assert.equal(after.draft,'');assert.ok(after.completed.includes(68));
  assert.equal(after.stats.sessions,before.stats.sessions+1);assert.equal(after.stats.characters,before.stats.characters+'A new journey begins.'.length);
  await page.waitForTimeout(200);assert.equal(await providerCalls(),1);
 });
 assert.deepEqual(report.errors,[]);report.simulatedProviderCalls=3;report.passed=true;
 console.log(JSON.stringify({passed:report.checks.length,realNetworkRequests:0}));
}finally{
 fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'paragraph-race-tests.json'),JSON.stringify(report,null,2));
 if(app){try{await app.evaluate(()=>{globalThis.paragraphReleaseProvider?.();});if(!report.passed)await app.evaluate(({app})=>app.exit(0));}catch{}await app.close();}
 const target=path.resolve(data);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('noveltype-paragraph-race-'));
 fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}})().catch(error=>{console.error(error);process.exitCode=1;});
