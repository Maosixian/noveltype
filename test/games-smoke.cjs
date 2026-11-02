const {_electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-games-'));
const library=new Library(data),book=library.getState().books[0];
book.id='game-fixture';book.demo=false;book.title='游戏隔离测试';
book.segments=[{source:'我们往前走。',translation:'We go.'},{source:'月亮照着河面。',translation:'The moon shines on the quiet river.'}];
library.importData({version:1,books:[book],activeBookId:book.id});
const env={...process.env,NOVELTYPE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const checks=[],errors=[];
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
async function launch(){app=await _electron.launch({args:[root],env});await app.evaluate(({net})=>{globalThis.gameNetworkCalls=0;net.fetch=async()=>{globalThis.gameNetworkCalls++;throw new Error('Games must remain offline');};});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.locator('#book-title').waitFor();}
(async()=>{try{
 await launch();
 await check('reading draft and case survive games, Continue restores typing focus',async()=>{
  await page.locator('#typing-input').click();await page.locator('#typing-input').pressSequentially('wE ',{delay:35});
  await page.locator('#nav-games').click();await page.locator('#game-race-open').waitFor();
  await page.locator('#nav-reading').click();await page.locator('#reading-view').waitFor();
  assert.equal(await page.locator('#typing-input').inputValue(),'wE ');assert.equal(await page.locator('#typing-input').getAttribute('readonly'),'');
  await page.locator('#pause').click();await page.waitForFunction(()=>document.activeElement.id==='typing-input');
  assert.equal(await page.locator('#typing-input').inputValue(),'wE ');assert.equal(await page.locator('#typing-input').getAttribute('readonly'),null);
  assert.equal(await page.locator('.target-char.wrong').count(),0);assert.equal(await app.evaluate(()=>globalThis.gameNetworkCalls),0);
 });
 let afterNovelRace;
 await check('games are available in the desktop shell',async()=>{await page.locator('#nav-games').click({timeout:3000});await page.locator('#game-race-open').waitFor();assert.equal(await page.locator('#reading-view').isVisible(),false);});
 await check('race accepts mixed case, saves its result and advances the novel to the next paragraph',async()=>{await page.locator('#game-race-open').click();await page.locator('#game-start').click();await page.locator('#game-input').pressSequentially('wE GO.',{delay:50});await page.locator('#game-result').waitFor();await page.waitForFunction(()=>document.querySelector('#game-save-status')?.textContent.includes('已保存'));assert.match(await page.locator('#game-result').textContent(),/完成|抵达|胜利/);afterNovelRace=await page.evaluate(()=>window.novel.getState());assert.equal(afterNovelRace.books[0].position,1);assert.equal(afterNovelRace.books[0].draft,'');assert.deepEqual(afterNovelRace.books[0].completed,[0]);assert.equal(afterNovelRace.books[0].stats.sessions,1);});
 await check('map unlock waits for successful save, failed writes retry only on demand',async()=>{
  await page.locator('#game-leave').click();await page.locator('#game-map-open').click();assert.equal(await page.locator('.game-map-node[data-level-id="2"]').isDisabled(),true);
  await page.locator('.game-map-node[data-level-id="1"]').click();
  fs.mkdirSync(path.join(data,'games.json.tmp'));
  await app.evaluate(({ipcMain})=>{const original=ipcMain._invokeHandlers.get('novel:saveGameResult');globalThis.failedGameWrites=0;ipcMain._invokeHandlers.set('novel:saveGameResult',(...args)=>{globalThis.failedGameWrites++;return original(...args);});});
  await page.locator('#game-start').click();const target=await page.locator('#game-race-text').textContent();await page.locator('#game-input').pressSequentially(target.toUpperCase(),{delay:30});await page.locator('#game-result').waitFor();await page.waitForFunction(()=>document.querySelector('#game-save-status')?.textContent.includes('尚未保存'));
  assert.equal(await page.locator('#game-next').isDisabled(),true);await page.waitForTimeout(200);assert.equal(await app.evaluate(()=>globalThis.failedGameWrites),1);
  await page.locator('#game-leave').click();assert.equal(await page.locator('#game-result').isVisible(),true);assert.equal(await app.evaluate(()=>globalThis.failedGameWrites),1);
  fs.rmdirSync(path.join(data,'games.json.tmp'));await page.locator('#game-retry-save').click();await page.waitForFunction(()=>document.querySelector('#game-save-status')?.textContent.includes('已保存'));
  await page.locator('#game-leave').click();assert.equal(await page.locator('.game-map-node[data-level-id="2"]').isDisabled(),false);
 });
 await check('defense clears a word, pauses, resumes and ends',async()=>{await page.locator('#nav-games').click();await page.locator('#game-defense-open').click();await page.locator('#game-start').click();await page.locator('.game-enemy-word').first().waitFor();const word=await page.locator('.game-enemy-word').first().textContent();await page.locator('#game-input').pressSequentially(word.toUpperCase(),{delay:25});await page.waitForFunction(()=>Number(document.querySelector('#game-score').textContent)>0);await page.locator('#game-pause').click();assert.equal(await page.locator('#game-input').isDisabled(),true);const time=await page.locator('#game-time').textContent();await page.waitForTimeout(300);assert.equal(await page.locator('#game-time').textContent(),time);await page.locator('#game-pause').click();assert.equal(await page.locator('#game-input').isDisabled(),false);await page.locator('#game-end').click();await page.locator('#game-result').waitFor();});
 await check('excerpt map races and defense do not advance reading again or request AI',async()=>{const after=await page.evaluate(()=>window.novel.getState());const pick=b=>({position:b.position,draft:b.draft,completed:b.completed,stats:b.stats});assert.deepEqual(pick(after.books[0]),pick(afterNovelRace.books[0]));assert.equal(await app.evaluate(()=>globalThis.gameNetworkCalls),0);});
 await check('games fit a compact desktop without page errors',async()=>{await page.locator('#game-leave').click();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,760));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);});
 await check('map stars and race best survive app restart',async()=>{const closed=app.waitForEvent('close');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;app=null;await launch();await page.locator('#nav-map').click();assert.equal(await page.locator('.game-map-node[data-level-id="2"]').isDisabled(),false);const gameData=await page.evaluate(()=>window.novel.getGameData({bookId:'game-fixture'}));assert.ok(Object.keys(gameData.progress.bestRaces).length>=2);await page.locator('#nav-games').click();await page.locator('#game-race-open').click();});
 await check('font, focus and dark theme work across reading and all three game pages',async()=>{
  await page.locator('#nav-reading').click();const size=await page.locator('#translation-text').evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
  await page.locator('#font-toggle').click();assert.ok(await page.locator('#translation-text').evaluate(node=>parseFloat(getComputedStyle(node).fontSize))>size);
  await page.locator('#focus-toggle').click();assert.equal(await page.locator('#focus-toggle').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.sidebar').isVisible(),false);
  await page.locator('#focus-toggle').click();assert.equal(await page.locator('.sidebar').isVisible(),true);
  if(await page.locator('body').getAttribute('data-theme')!=='dark')await page.locator('#theme-toggle').click();assert.equal(await page.locator('body').getAttribute('data-theme'),'dark');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,760));
  const fits=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await fits();await page.locator('#nav-games').click();await page.locator('#game-race-open').click();await fits();
  await page.locator('#game-leave').click();await page.locator('#game-defense-open').click();await fits();
  await page.locator('#nav-map').click();await page.locator('.game-map-node').first().waitFor();await fits();
  assert.equal(await page.locator('#nav-map').getAttribute('aria-current'),'page');assert.deepEqual(errors,[]);assert.equal(await app.evaluate(()=>globalThis.gameNetworkCalls),0);
 });
 fs.mkdirSync(path.join(root,'evidence'),{recursive:true});fs.writeFileSync(path.join(root,'evidence/games-tests.json'),JSON.stringify({checks,isolatedData:true,networkRequests:0},null,2));console.log(JSON.stringify({passed:checks.length}));
 }finally{if(app)await app.close();const p=path.resolve(data);assert.equal(path.dirname(p),path.resolve(os.tmpdir()));assert.ok(path.basename(p).startsWith('noveltype-games-'));fs.rmSync(p,{recursive:true,force:true,maxRetries:5,retryDelay:100});}})().catch(e=>{console.error(e);process.exitCode=1;});
