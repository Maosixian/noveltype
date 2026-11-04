'use strict';
// Synthetic bilingual passages only. No user data or translation provider is used.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const {AlignmentCache}=require('../app/alignment.cjs');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-parallel-layout-'));
const evidence=path.join(root,'evidence');fs.mkdirSync(evidence,{recursive:true});
const source='清晨，旅人走过石桥。她看见远处的小船，听见水面上的钟声。';
const translation='At dawn, a traveler crosses the bridge. She sees a boat in the distance and hears a bell over the water.';
const book={id:'parallel-layout',title:'左右对照 · 原创测试',demo:false,position:0,draft:'',completed:[],stats:{sessions:0,characters:0,seconds:0},segments:[{source,translation},{source:'旅人继续前行。',translation:'The traveler continues.'},{source:'一段长文，用于测试两列在滚动时仍可对照。'.repeat(8),translation:'The warm light falls across the quiet water. '.repeat(18).trim()},{source:'这是检查最大字体长段落在较矮窗口中可以完整阅读的合成文字。'.repeat(10).slice(0,260),translation:'The traveler follows a long road across the open valley. '.repeat(30).trim()}]};
new Library(data).importData({version:1,books:[book],activeBookId:book.id});
const cache=new AlignmentCache(data);for(const s of book.segments)cache.set(s.source,s.translation,{version:1,spans:[{englishStart:0,englishEnd:s.translation.length,sourceStart:0,sourceEnd:s.source.length}]});
const packagedExe=process.env.NOVELTYPE_PACKAGED_EXE;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NOVELTYPE_TEST_DATA;
if(!packagedExe)env.NOVELTYPE_TEST_DATA=data;
let app,page;const report={checks:[],geometry:[],errors:[],passed:false};
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function resize(width,height){await app.evaluate(({BrowserWindow},{width,height})=>{const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(520,500);win.setContentSize(width,height);},{width,height});await page.waitForFunction(width=>innerWidth===width,width);}
async function geometry(){return page.evaluate(()=>{const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};return {source:rect('.story-passage.is-active .stream-source'),english:rect('.story-passage.is-active .stream-english'),input:rect('#typing-input'),sourceColumn:rect('.story-passage.is-active .passage-source'),toolbar:rect('.stream-toolbar'),viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth};});}
async function progress(){return page.evaluate(async()=>{const b=(await window.novel.getState()).books[0];return {position:b.position,draft:b.draft,completed:b.completed};});}
async function durable(expected){
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){
  const actual=await progress();if(JSON.stringify(actual)===JSON.stringify(expected))return actual;
  await page.waitForTimeout(50);
 }
 assert.fail('Expected progress did not become durable');
}
(async()=>{try{
 app=await _electron.launch(packagedExe?{executablePath:packagedExe,args:[`--user-data-dir=${data}`],env,timeout:30000}:{args:[root],env,timeout:30000});
 assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),path.resolve(data));
 await app.evaluate(({net})=>{globalThis.parallelNetworkCalls=0;net.fetch=async()=>{parallelNetworkCalls++;throw Error('No network in bilingual layout test');};});
 page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.locator('.story-passage.is-active').waitFor();
 await check('desktop puts Chinese left and target plus input right without horizontal overflow',async()=>{
  await resize(1440,1000);const g=await geometry();report.geometry.push({stage:'desktop',...g});
  assert.ok(g.source.right<g.english.x,'Chinese should be left of English');assert.ok(g.input.x>=g.english.x-2&&g.input.right<=g.english.right+3);assert.ok(g.input.y>=g.english.y-2&&g.input.y<g.english.bottom,'Input focus proxy belongs on the English passage');assert.equal(g.overflow,false);
  assert.equal(await page.locator('.story-passage.is-active .passage-practice #typing-input').count(),1);
  await page.screenshot({path:path.join(evidence,'parallel-reading-desktop.png')});
 });
 await check('alignment highlighting and automatic continuation retain the original input node and focus',async()=>{
  await page.locator('#typing-input').click();await page.locator('#typing-input').pressSequentially('AT ');
  await page.locator('#source-text .source-highlight').waitFor();
  await page.evaluate(()=>{globalThis.originalTypingInput=document.getElementById('typing-input');});
  await page.keyboard.type(translation.slice(3)+'T');
  await page.waitForFunction(()=>document.querySelector('.story-passage.is-active').dataset.index==='1');
  assert.equal(await page.locator('#typing-input').inputValue(),'T');
  assert.equal(await page.evaluate(()=>document.activeElement===originalTypingInput&&document.getElementById('typing-input')===originalTypingInput),true);
  assert.deepEqual(await durable({position:1,draft:'T',completed:[0]}),{position:1,draft:'T',completed:[0]});
 });
 await check('narrow and enlarged-text layouts stay readable; resizing and scrolling do not change the passage',async()=>{
  const before=await progress();
  for(const width of [960,880,620]){
   await resize(width,width===960?760:850);await page.locator('#return-to-input').click();const g=await geometry();report.geometry.push({stage:'narrow-'+width,...g});
   assert.ok(g.source.bottom<=g.english.y,'Narrow layout must stack Chinese above English');assert.equal(g.overflow,false);
   await page.screenshot({path:path.join(evidence,`parallel-reading-${width}.png`)});
  }
  await page.locator('#font-toggle').click();await page.locator('#font-toggle').click();assert.equal((await geometry()).overflow,false);
  await page.evaluate(()=>window.scrollBy(0,500));assert.deepEqual(await progress(),before);
  await page.locator('#font-toggle').click();
 });
 await check('Chinese remains beside a long active passage while scrolling, in light and dark themes',async()=>{
  await resize(1440,900);await page.locator('.story-passage[data-index="2"] .practice-here').click();
  await page.waitForFunction(()=>document.querySelector('.story-passage.is-active').dataset.index==='2');
  await page.waitForFunction(()=>document.querySelector('#save-state').textContent.startsWith('✓'));const before=await progress();
  await page.evaluate(()=>window.scrollBy(0,250));const g=await geometry();report.geometry.push({stage:'long-scroll',...g});
  assert.ok(g.sourceColumn.y>=g.toolbar.bottom-1,'Chinese must not slide behind sticky controls');assert.ok(g.sourceColumn.y<g.viewport.height-100,'Chinese must remain visible');assert.ok(g.source.right<g.english.x);assert.equal(g.overflow,false);
  await page.screenshot({path:path.join(evidence,'parallel-reading-long.png')});
  await page.locator('#theme-toggle').click();assert.equal((await geometry()).overflow,false);await page.screenshot({path:path.join(evidence,'parallel-reading-dark.png')});
  assert.deepEqual(await progress(),before);
 });
 await check('oversized Chinese scrolls in full and sticky eligibility recovers after viewport, font and paragraph changes',async()=>{
  await resize(1100,700);await page.locator('.story-passage[data-index="3"] .practice-here').click();
  await page.waitForFunction(()=>document.querySelector('.story-passage.is-active').dataset.index==='3');
  await page.locator('#font-toggle').click();await page.locator('#font-toggle').click();
  await page.waitForFunction(()=>document.body.dataset.font==='largest');
  const sourceColumn=page.locator('.story-passage.is-active .passage-source');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.story-passage.is-active .passage-source')).position!=='sticky');
  await page.evaluate(()=>{globalThis.tallSourceColumn=document.querySelector('.story-passage.is-active .passage-source');});
  const tall=await geometry();assert.ok(tall.sourceColumn.height>tall.viewport.height-tall.toolbar.height-96);report.geometry.push({stage:'largest-tall-source',...tall});
  await page.evaluate(()=>{const source=document.querySelector('#source-text'),bottom=source.getBoundingClientRect().bottom;window.scrollBy(0,bottom-innerHeight+32);});
  const bottom=await geometry();assert.ok(bottom.source.bottom<=bottom.viewport.height-24);assert.ok(bottom.source.bottom>bottom.toolbar.bottom+30,'Last Chinese line must be visible below the toolbar');assert.equal(bottom.overflow,false);
  await page.screenshot({path:path.join(evidence,'parallel-reading-tall-source-bottom.png')});
  // Height-only resize must update eligibility even if no observed box changes size.
  await resize(1100,1600);await page.waitForFunction(()=>getComputedStyle(document.querySelector('.story-passage.is-active .passage-source')).position==='sticky');
  await resize(1100,700);await page.waitForFunction(()=>getComputedStyle(document.querySelector('.story-passage.is-active .passage-source')).position!=='sticky');
  // Width and font changes alter line wrapping. Both keep the same source node.
  await resize(1440,1100);await page.waitForFunction(()=>getComputedStyle(document.querySelector('.story-passage.is-active .passage-source')).position==='sticky');
  await page.locator('#font-toggle').click();await page.waitForFunction(()=>document.body.dataset.font==='normal');
  assert.equal(await sourceColumn.evaluate(node=>node===tallSourceColumn),true);
  await page.locator('.story-passage[data-index="1"] .practice-here').click();
  await page.waitForFunction(()=>document.querySelector('.story-passage.is-active').dataset.index==='1');
  await page.waitForFunction(()=>document.querySelector('.story-passage.is-active .passage-source').classList.contains('source-can-stick'));
  assert.equal(await page.evaluate(()=>tallSourceColumn.classList.contains('source-can-stick')),false,'Inactive source must be unobserved and lose its sticky eligibility');
 });
 assert.equal(await app.evaluate(()=>parallelNetworkCalls),0);assert.deepEqual(report.errors,[]);report.passed=true;console.log(JSON.stringify({passed:report.checks.length,networkCalls:0}));
}finally{
 fs.writeFileSync(path.join(evidence,'parallel-layout-tests.json'),JSON.stringify(report,null,2));if(app)await app.close();
 const target=path.resolve(data);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('noveltype-parallel-layout-'));fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}})().catch(error=>{console.error(error);process.exitCode=1;});
