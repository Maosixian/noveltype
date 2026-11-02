'use strict';
const {_electron}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-paragraph-async-'));
const env={...process.env,NOVELTYPE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const report={checks:[],errors:[],isolatedData:true};
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function holdNext(){return app.evaluate(()=>{globalThis.holdNextParagraph=true;return globalThis.heldParagraphs.length;});}
async function held(index){await page.waitForTimeout(50);for(let i=0;i<50;i++){if(await app.evaluate((_,index)=>globalThis.heldParagraphs.length>index,index))return;await page.waitForTimeout(20);}throw Error('deferred paragraph request not issued '+JSON.stringify({state:await app.evaluate(()=>({hold:globalThis.holdNextParagraph,held:globalThis.heldParagraphs.length})),screen:await page.locator('#games-view').textContent()}));}
async function release(index){await app.evaluate((_,index)=>globalThis.heldParagraphs[index](),index);await page.waitForTimeout(100);}
(async()=>{try{
 app=await _electron.launch({args:[root],env});page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.locator('#book-title').waitFor();
 await app.evaluate(({ipcMain,net})=>{globalThis.heldParagraphs=[];globalThis.holdNextParagraph=false;globalThis.paragraphAsyncNetwork=0;net.fetch=async()=>{paragraphAsyncNetwork++;throw Error('No network allowed');};const original=ipcMain._invokeHandlers.get('novel:getGamePassage');ipcMain._invokeHandlers.set('novel:getGamePassage',async(...args)=>{const hold=globalThis.holdNextParagraph;globalThis.holdNextParagraph=false;const value=await original(...args);if(hold)await new Promise(resolve=>globalThis.heldParagraphs.push(resolve));return value;});});
 await page.locator('#nav-games').click();await page.locator('#game-race-open').click();
 await check('leaving a pending race start cannot start a different game',async()=>{
  const request=await holdNext();await page.locator('#game-start').click();await held(request);
  await page.locator('#game-leave').click();await page.locator('#game-defense-open').click();await release(request);
  assert.equal(await page.locator('#game-start').isVisible(),true);assert.equal(await page.locator('#game-input').isDisabled(),true);assert.equal(await page.locator('#game-time').textContent(),'60');
 });
 await check('an older start response cannot unlock or start a newer pending race',async()=>{
  await page.locator('#game-leave').click();await page.locator('#game-race-open').click();
  const old=await holdNext();await page.locator('#game-start').click();await held(old);await page.locator('#game-leave').click();await page.locator('#game-race-open').click();
  const current=await holdNext();await page.locator('#game-start').click();await held(current);await release(old);
  assert.equal(await page.locator('#game-start').isVisible(),true);assert.equal(await page.locator('#game-start').isDisabled(),true);assert.equal(await page.locator('#game-input').isDisabled(),true);
  await release(current);assert.equal(await page.locator('#game-start').isVisible(),false);assert.equal(await page.locator('#game-input').isDisabled(),false);
  await page.locator('#game-leave').click();
 });
 await check('leaving a pending paragraph selection keeps the destination screen and selection',async()=>{
  await page.locator('#game-race-open').click();const before=await page.locator('#game-paragraph-index').inputValue();
  const request=await holdNext();await page.locator('#game-paragraph-index').fill('2');await page.locator('#game-paragraph-load').click();await held(request);
  await page.locator('#game-leave').click();await release(request);
  assert.equal(await page.locator('#game-race-open').isVisible(),true);assert.equal(await page.locator('#game-input').count(),0);assert.equal(await page.locator('#game-paragraph-index').inputValue(),before);
 });
 assert.deepEqual(report.errors,[]);assert.equal(await app.evaluate(()=>paragraphAsyncNetwork),0);fs.writeFileSync(path.join(root,'evidence/paragraph-async-tests.json'),JSON.stringify(report,null,2));
}finally{if(app)await app.close();assert.equal(path.dirname(data),path.resolve(os.tmpdir()));fs.rmSync(data,{recursive:true,force:true,maxRetries:5,retryDelay:100});}})().catch(error=>{console.error(error);process.exitCode=1;});
