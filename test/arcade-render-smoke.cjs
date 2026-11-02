const {_electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-arcade-render-'));
const library=new Library(data),book=library.getState().books[0];
book.id='arcade-render';book.demo=false;book.title='海岸打字 / 隔离测试';
book.segments=[{source:'这是用于检查连续输入性能的原创测试句。',translation:'The quiet harbor welcomes every journey. '.repeat(14)}];
library.importData({version:1,books:[book],activeBookId:book.id});
const env={...process.env,NOVELTYPE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const evidence={checks:[],metrics:{}};
async function check(name,fn){await fn();evidence.checks.push(name);console.log('PASS '+name);}
(async()=>{try{
 app=await _electron.launch({args:[root],env});page=await app.firstWindow();await page.locator('#book-title').waitFor();
 await page.locator('#nav-games').click();await page.locator('#game-race-open').click();await page.locator('#game-start').click();
 await check('correct mixed-case input never displays a wrong character',async()=>{
  await page.locator('#game-input').pressSequentially('tH',{delay:15});
  assert.equal(await page.locator('#game-race-text .is-wrong').count(),0);
  await page.locator('#game-input').press('Backspace');await page.locator('#game-input').press('Backspace');
  assert.equal(await page.locator('#game-race-text .is-wrong').count(),0);
 });
 await check('race target nodes stay stable while typing and HUD has bounded mutations',async()=>{
  await page.evaluate(()=>{window.raceFirst=document.querySelector('#game-race-text span');window.mutations=0;window.hudObserver=new MutationObserver(items=>window.mutations+=items.length);window.hudObserver.observe(document.querySelector('.game-metrics'),{childList:true,subtree:true,characterData:true});});
  await page.locator('#game-input').pressSequentially('The quiet harbor welcomes',{delay:15});
  const state=await page.evaluate(()=>({stable:window.raceFirst===document.querySelector('#game-race-text span'),mutations:window.mutations}));evidence.metrics.race=state;
  assert.equal(state.stable,true,'target is rebuilt on each input');
  await page.evaluate(()=>{window.mutations=0;});await page.waitForTimeout(400);
  const idle=await page.evaluate(()=>window.mutations);evidence.metrics.raceIdleHudMutations400ms=idle;assert.ok(idle<=12,'unchanged HUD rewritten each frame: '+idle);
 });
 await check('overflow is marked only while present and deleting it clears its error state',async()=>{
  const target=await page.locator('#game-race-text').textContent(),input=page.locator('#game-input');
  await input.fill('X'+target.slice(1)+'!');
  assert.equal(await page.locator('#game-race-text .is-wrong').count(),2);
  assert.equal(await page.locator('#game-race-text span').last().textContent(),'!');
  await input.press('Backspace');
  assert.equal(await page.locator('#game-race-text .is-wrong').count(),1);
  assert.equal(await page.locator('#game-race-text span').last().getAttribute('class'),'');
  await input.fill(target.slice(0,3).toUpperCase());
  assert.equal(await page.locator('#game-race-text .is-wrong').count(),0);
 });
 await page.locator('#game-end').click();await page.waitForFunction(()=>document.querySelector('#game-save-status')?.textContent.includes('已保存'));
 await page.locator('#game-leave').click();await page.locator('#game-defense-open').click();await page.locator('#game-start').click();
 await check('defense idle frames preserve text nodes and use compositor movement',async()=>{
  await page.locator('.game-enemy').waitFor();const before=await page.evaluate(()=>{window.enemyWord=document.querySelector('.game-enemy-word');window.defenseMutations=0;new MutationObserver(items=>window.defenseMutations+=items.length).observe(document.querySelector('.game-metrics'),{childList:true,subtree:true,characterData:true});return window.enemyWord.textContent;});
  await page.waitForTimeout(350);const state=await page.evaluate(()=>({mutations:window.defenseMutations,stable:window.enemyWord===document.querySelector('.game-enemy-word'),transform:document.querySelector('.game-enemy').style.transform,top:document.querySelector('.game-enemy').style.top}));evidence.metrics.defense=state;
  assert.equal(state.stable,true);assert.ok(state.mutations<=5,'unchanged defense HUD rewritten each frame');assert.match(state.transform,/translate/);assert.equal(state.top,'');
  await page.locator('#game-input').pressSequentially(before.toUpperCase(),{delay:20});await page.waitForFunction(()=>Number(document.querySelector('#game-score').textContent)>0);
  assert.match(await page.locator('#game-feedback').textContent(),/击破/);
 });
 await check('motion preference removes active effects without stopping game or input',async()=>{
  await page.evaluate(()=>{document.documentElement.dataset.motion='off';window.dispatchEvent(new Event('noveltype:motion-change'));});
  assert.equal(await page.locator('#game-input').isDisabled(),false);assert.equal(await page.locator('.game-impact').count(),0);
  assert.ok(await page.locator('.game-enemy-time').count()===0||await page.locator('.game-enemy-time').first().isVisible());
 });
 await page.locator('#game-end').click();await page.waitForFunction(()=>document.querySelector('#game-save-status')?.textContent.includes('已保存'));
 await page.locator('#nav-map').click();await check('all twelve map nodes remain accessible at compact size',async()=>{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,760));assert.equal(await page.locator('.game-map-node').count(),12);assert.equal(await page.locator('.game-map-node[data-level-id="1"]').isEnabled(),true);assert.equal(await page.locator('.game-map-node[data-level-id="2"]').isDisabled(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 });
 fs.writeFileSync(path.join(root,'evidence/arcade-render-tests.json'),JSON.stringify(evidence,null,2));
}finally{if(app)await app.close();assert.equal(path.dirname(path.resolve(data)),path.resolve(os.tmpdir()));fs.rmSync(data,{recursive:true,force:true,maxRetries:5,retryDelay:100});}})().catch(error=>{console.error(error);process.exitCode=1;});
