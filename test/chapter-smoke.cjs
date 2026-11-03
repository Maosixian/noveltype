'use strict';
// Exercise chapter boundaries through the actual Electron preload and Library.
// Fixtures contain only synthetic writing, cached alignments, and no credentials.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const {AlignmentCache}=require('../app/alignment.cjs');
const root=path.resolve(__dirname,'..');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-chapter-'));
const evidence=path.join(root,'evidence');
const segment=(source,translation)=>({source,translation});
const novelSegments=()=>[
 segment('第一章 初见\n合成文字：灯亮了。','First light.'),segment('合成文字：走过小路。','A quiet road.'),
 segment('第二章 归途\n合成文字：小船靠岸。','A boat waits.'),segment('合成文字：回到家中。','We go home.'),
 segment('第三章 新晨\n合成文字：清晨到来。','Morning comes.'),segment('合成文字：旅程结束。','The story ends.')
];
const book=(id,segments,options={})=>({id,title:'章节测试 · '+id,demo:false,position:0,draft:'',completed:[],stats:{sessions:0,characters:0,seconds:0},segments,...options});
const books=[
 book('novel',novelSegments()),
 book('bible',[
  segment('【创世记 1:1】\n合成测试文字之一。','First verse.'),segment('【创世记 1:2】\n合成测试文字之二。','Second verse.'),
  segment('【创世记 2:1】\n合成测试文字之三。','Third verse.'),segment('【创世记 2:2】\n合成测试文字之四。','Fourth verse.'),
  segment('【出埃及记 1:1】\n合成测试文字之五。','Fifth verse.'),segment('【出埃及记 1:2】\n合成测试文字之六。','Last verse.')
 ]),
 book('untranslated',[segment('第一章 灯光\n合成测试。','A light.'),segment('第二章 远方\n合成测试。','')]),
 book('partial',novelSegments(),{position:1}),
 book('plain',[segment('只有普通文字，没有章名。','Plain words.'),segment('这里依然只有普通文字。','More words.')]),
 book('race',novelSegments(),{position:1,completed:[0]}),
 book('delayed-race',novelSegments(),{position:1,completed:[0]}),
 book('short-games',novelSegments().map(s=>({...s,translation:'Silver lanterns guide the quiet traveler across the harbor. '.repeat(6).trim()})),{position:1,completed:[0]}),
 book('failure',[segment('第一章 保存\n合成测试。','Save this.'),segment('第二章 继续\n合成测试。','Go on.')]),
 book('delayed',[segment('第一章 延迟\n合成测试。','Wait here.'),segment('第二章 到达\n合成测试。','Arrive soon.')]),
 book('restore',novelSegments(),{position:1,completed:[0]}),
 book('motion-reduced',novelSegments(),{position:1,completed:[0]}),
 book('motion-off',novelSegments(),{position:1,completed:[0]})
];
new Library(data).importData({version:1,books,activeBookId:'novel'});
const cache=new AlignmentCache(data);
for(const b of books)for(const {source,translation}of b.segments)if(translation)cache.set(source,translation,{version:1,spans:[{englishStart:0,englishEnd:translation.length,sourceStart:0,sourceEnd:source.length}]});
const packagedExe=process.env.NOVELTYPE_PACKAGED_EXE;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NOVELTYPE_TEST_DATA;
if(!packagedExe)env.NOVELTYPE_TEST_DATA=data;
const report={checks:[],errors:[],isolatedData:true,packaged:!!packagedExe,networkRequests:0,passed:false};
let app,page,totalProviderCalls=0;
const fixture=id=>books.find(b=>b.id===id);
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function launch(){
 app=await _electron.launch(packagedExe?{executablePath:packagedExe,args:[`--user-data-dir=${data}`],env,timeout:30000}:{args:[root],env,timeout:20000});
 const paths=await app.evaluate(({app})=>({userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),packaged:app.isPackaged,version:app.getVersion()}));
 assert.equal(path.resolve(paths.userData).toLowerCase(),path.resolve(data).toLowerCase());
 assert.equal(path.resolve(paths.sessionData).toLowerCase(),path.resolve(data).toLowerCase());
 assert.equal(paths.packaged,!!packagedExe);if(packagedExe)assert.equal(paths.version,require('../package.json').version);
 await app.evaluate(({net,ipcMain})=>{
  globalThis.chapterProviderCalls=0;globalThis.chapterFailSave=false;globalThis.chapterHoldSave=false;globalThis.chapterHeld=false;
  globalThis.chapterHoldGameSave=false;globalThis.chapterGameHeld=false;
  net.fetch=async()=>{chapterProviderCalls++;throw new Error('Chapter fixtures must not use a provider');};
  const save=ipcMain._invokeHandlers.get('novel:saveProgress');
  ipcMain._invokeHandlers.set('novel:saveProgress',async(event,payload)=>{
   if(payload.completed!==undefined&&payload.bookId==='failure'&&chapterFailSave)return {ok:false,error:'Synthetic chapter save failure'};
   if(payload.completed!==undefined&&payload.bookId==='delayed'&&chapterHoldSave){chapterHeld=true;await new Promise(resolve=>{globalThis.chapterReleaseSave=resolve;});}
   return save(event,payload);
  });
  const saveGame=ipcMain._invokeHandlers.get('novel:saveGameResult');
  ipcMain._invokeHandlers.set('novel:saveGameResult',async(event,payload)=>{
   if(payload.bookId==='delayed-race'&&chapterHoldGameSave){chapterGameHeld=true;await new Promise(resolve=>{globalThis.chapterReleaseGameSave=resolve;});}
   return saveGame(event,payload);
  });
 });
 page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.locator('.story-passage.is-active').waitFor();
}
async function close(){
 totalProviderCalls+=await app.evaluate(()=>chapterProviderCalls);
 const closed=app.waitForEvent('close',{timeout:15000});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;app=null;
}
async function select(id){
 if(!(await page.locator('#reading-view').isVisible()))await page.locator('#nav-reading').click();
 await page.locator(`.book-button[title="${fixture(id).title}"]`).click();
 await page.waitForFunction(title=>document.querySelector('#book-title')?.textContent===title,fixture(id).title,{timeout:10000});
}
async function typeReading(text){
 const input=page.locator('#typing-input');
 if(await input.getAttribute('readonly')!==null)await page.locator('#pause').click();
 await input.click();await input.pressSequentially(text.toUpperCase(),{delay:5});
}
async function waitPosition(index){await page.waitForFunction(index=>document.querySelector('.story-passage.is-active')?.dataset.index===String(index),index,{timeout:10000});}
async function saved(){await page.waitForFunction(()=>document.querySelector('#save-state')?.textContent.startsWith('✓'),null,{timeout:10000});}
async function gameSaved(){await page.waitForFunction(()=>document.querySelector('#game-save-status')?.textContent.includes('已保存'),null,{timeout:10000});}
async function noNotice(){assert.equal(await page.locator('#chapter-notice').isVisible(),false);}
async function notice(title,next){
 await page.locator('#chapter-notice').waitFor({state:'visible'});
 assert.match(await page.locator('#chapter-notice-title').textContent(),title);
 if(next)assert.match(await page.locator('#chapter-notice-next').textContent(),next);
}
async function progress(id){return page.evaluate(async id=>{const b=(await window.novel.getState()).books.find(b=>b.id===id);return {position:b.position,draft:b.draft,completed:b.completed,stats:b.stats};},id);}
async function openRace(){await page.locator('#nav-games').click();await page.locator('#game-race-open').click();await page.locator('#game-start').waitFor();}
async function typeGame(text){await page.locator('#game-input').pressSequentially(text.toUpperCase(),{delay:3});}
async function setMotion(value){
 await page.locator('#open-appearance').click();await page.locator('#motion-preference').selectOption(value);await page.locator('#appearance-close').click();
 await page.waitForFunction(value=>document.documentElement.dataset.motion===value,value,{timeout:10000});
}
(async()=>{try{
 await launch();
 await check('ordinary paragraph completion continues silently',async()=>{
  await typeReading(fixture('novel').segments[0].translation);await waitPosition(1);await saved();await noNotice();
 });
 await check('novel chapter completion announces the real next heading and retains continuous typing focus',async()=>{
  await typeReading(fixture('novel').segments[1].translation+'A');await waitPosition(2);await saved();
  await notice(/本章.*完成/,/下一章[：:]?\s*第二章.*归途/);
  assert.equal(await page.locator('#typing-input').inputValue(),'A');assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
  assert.deepEqual((await progress('novel')).completed,[0,1]);
 });
 await check('scrolling and selecting a paragraph do not create chapter completion',async()=>{
  await select('plain');await noNotice();await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await noNotice();
  await page.locator('.story-passage[data-index="1"] .practice-here').click();await waitPosition(1);await noNotice();
  await select('novel');await noNotice();await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await waitPosition(2);await noNotice();
  await page.locator('.story-passage[data-index="4"] .practice-here').click();await waitPosition(4);await noNotice();
 });
 await check('Bible chapter and book transitions show the next book and chapter number',async()=>{
  await select('bible');await typeReading('First verse.Second verse.');await waitPosition(2);await saved();
  await notice(/本章.*完成/,/下一章[：:]?\s*创世记.*第?\s*2\s*章/);
  await typeReading('Third verse.Fourth verse.');await waitPosition(4);await saved();
  await notice(/本章.*完成/,/下一章[：:]?\s*出埃及记.*第?\s*1\s*章/);
 });
 await check('the final chapter reports the actual book ending without inventing a next chapter',async()=>{
  await typeReading('Fifth verse.Last verse.');await saved();await notice(/全书.*完成|本书.*结尾/);
  assert.doesNotMatch(await page.locator('#chapter-notice-next').textContent(),/下一章[：:]/);
  assert.deepEqual((await progress('bible')).completed,[0,1,2,3,4,5]);
 });
 await check('an untranslated next chapter still has its boundary notice and does not request AI',async()=>{
  await select('untranslated');await typeReading('A light.');await waitPosition(1);await saved();await notice(/本章.*完成/,/第二章.*远方/);
  assert.equal(await page.locator('#typing-input').isDisabled(),true);assert.equal(await app.evaluate(()=>chapterProviderCalls),0);
 });
 await check('skipping earlier paragraphs reports reaching the chapter end without claiming full completion',async()=>{
  await select('partial');await typeReading('A quiet road.');await waitPosition(2);await saved();await notice(/已到本章末尾/,/第二章.*归途/);
  assert.doesNotMatch(await page.locator('#chapter-notice-title').textContent(),/本章已完成/);
 });
 await check('unstructured prose never invents a numbered chapter',async()=>{
  await select('plain');await typeReading('More words.');await saved();await noNotice();
 });
 await check('full paragraph racing gives the chapter notice and advances the reading bookmark once',async()=>{
  await select('race');await openRace();assert.equal(await page.locator('#game-paragraph-index').inputValue(),'2');
  await page.locator('#game-start').click();await typeGame('A quiet road.');await gameSaved();await notice(/本章.*完成/,/第二章.*归途/);
  assert.equal((await progress('race')).position,2);assert.deepEqual((await progress('race')).completed,[0,1]);
  fs.mkdirSync(evidence,{recursive:true});await page.locator('#chapter-notice').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(evidence,packagedExe?'chapter-packaged-race.png':'chapter-race.png')});
 });
 await check('a late race save after requesting reading cannot flash a stale chapter notice',async()=>{
  await select('delayed-race');await openRace();await app.evaluate(()=>{chapterHoldGameSave=true;});
  await page.locator('#game-start').click();await typeGame('A quiet road.');await page.locator('#game-result').waitFor();
  await app.evaluate(async()=>{const until=Date.now()+5000;while(!chapterGameHeld&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));if(!chapterGameHeld)throw Error('Expected delayed game save');});
  await noNotice();
  await page.evaluate(()=>{
   globalThis.chapterLateShows=[];
   const node=document.querySelector('#chapter-notice');
   globalThis.chapterLateObserver=new MutationObserver(records=>{
    // Reconstruct each mutation's new value from the next mutation's old value.
    // This catches show-and-hide in one microtask without counting hidden=true
    // assigned to an already hidden panel as a show.
    for(let index=0;index<records.length;index++){
     const record=records[index];if(record.attributeName!=='hidden'||record.oldValue===null)continue;
     const next=records.slice(index+1).find(item=>item.target===record.target&&item.attributeName===record.attributeName);
     const newValue=next?next.oldValue:record.target.getAttribute(record.attributeName);
     if(newValue===null)chapterLateShows.push(node.textContent);
    }
   });
   chapterLateObserver.observe(node,{attributes:true,attributeFilter:['hidden'],attributeOldValue:true});
  });
  await page.locator('#nav-reading').click();
  await app.evaluate(()=>{chapterHoldGameSave=false;chapterReleaseGameSave();});
  await page.locator('#reading-view').waitFor({state:'visible'});await waitPosition(2);await noNotice();
  assert.deepEqual(await page.evaluate(()=>{chapterLateObserver.disconnect();return chapterLateShows;}),[]);
  assert.deepEqual((await progress('delayed-race')).completed,[0,1]);
 });
 await check('short map races and defense never emit reading chapter completion',async()=>{
  await select('short-games');const before=await progress('short-games');
  await page.locator('#nav-map').click();await page.locator('.game-map-node[data-level-id="1"]').click();
  const target=await page.locator('#game-race-text').textContent();await page.locator('#game-start').click();await typeGame(target);await gameSaved();await noNotice();
  await page.locator('#game-leave').click();await page.locator('#nav-games').click();await page.locator('#game-defense-open').click();await page.locator('#game-start').click();
  await page.locator('.game-enemy-word').first().waitFor();const word=await page.locator('.game-enemy-word').first().textContent();await typeGame(word);
  await page.waitForFunction(()=>Number(document.querySelector('#game-score')?.textContent)>0,null,{timeout:10000});
  await page.locator('#game-end').click();await gameSaved();await noNotice();assert.deepEqual(await progress('short-games'),before);
 });
 await check('failed completion saves do not claim chapter completion; explicit retry is durable',async()=>{
  await select('failure');await app.evaluate(()=>{chapterFailSave=true;});await typeReading('Save this.');
  await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('Synthetic chapter save failure'),null,{timeout:10000});await noNotice();
  assert.deepEqual((await progress('failure')).completed,[]);
  await app.evaluate(()=>{chapterFailSave=false;});await page.locator('#pause').click();await saved();
  assert.deepEqual((await progress('failure')).completed,[0]);
 });
 await check('a delayed completion acknowledgement cannot leak a previous book notice into the newly selected book',async()=>{
  await select('delayed');await app.evaluate(()=>{chapterHoldSave=true;});await typeReading('Wait here.');await waitPosition(1);
  await app.evaluate(async()=>{const until=Date.now()+5000;while(!chapterHeld&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));if(!chapterHeld)throw Error('Expected delayed save');});
  await noNotice();
  await page.locator(`.book-button[title="${fixture('plain').title}"]`).click();
  await app.evaluate(()=>{chapterHoldSave=false;chapterReleaseSave();});
  await page.waitForFunction(title=>document.querySelector('#book-title')?.textContent===title,fixture('plain').title,{timeout:10000});await noNotice();
 });
 await check('restoring an old complete draft does not replay chapter celebration',async()=>{
  await close();const library=new Library(data);library.selectBook('restore');library.saveProgress({bookId:'restore',position:1,draft:'A QUIET ROAD.'});
  await launch();await waitPosition(2);await saved();await noNotice();
 });
 await check('reduced and off motion keep chapter status static without stealing typing focus',async()=>{
  for(const motion of ['reduced','off']){
   await select('motion-'+motion);await setMotion(motion);await typeReading('A quiet road.');await waitPosition(2);await saved();await notice(/本章.*完成/,/第二章.*归途/);
   assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
   assert.equal(await page.locator('#chapter-notice').evaluate(node=>node.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
  }
 });
 await check('chapter status fits a compact dark window and all flows remain offline',async()=>{
  if(await page.locator('body').getAttribute('data-theme')!=='dark')await page.locator('#theme-toggle').click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,760));await page.locator('#chapter-notice').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  fs.mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,packagedExe?'chapter-packaged-dark-compact.png':'chapter-dark-compact.png')});
  assert.deepEqual(report.errors,[]);assert.equal(totalProviderCalls+await app.evaluate(()=>chapterProviderCalls),0);
 });
 report.passed=true;
 }catch(error){report.failure=error.stack;throw error;}
 finally{
  if(app){await app.evaluate(()=>{chapterFailSave=false;chapterHoldSave=false;chapterHoldGameSave=false;globalThis.chapterReleaseSave?.();globalThis.chapterReleaseGameSave?.();}).catch(()=>{});await close().catch(async()=>{await app.close().catch(()=>{});});}
  report.networkRequests=totalProviderCalls;fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,packagedExe?'chapter-packaged-tests.json':'chapter-tests.json'),JSON.stringify(report,null,2));
  const resolved=path.resolve(data);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('noveltype-chapter-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
})().then(()=>console.log(JSON.stringify({passed:report.checks.length,networkRequests:report.networkRequests}))).catch(error=>{console.error(error);process.exitCode=1;});
