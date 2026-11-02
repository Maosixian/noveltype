'use strict';
// Regression for global navigation disappearing when a saved book resumes midstream.
// All content, progress and credentials are isolated from the real user profile.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-navigation-scroll-'));
const evidence=path.join(root,'evidence');
fs.mkdirSync(evidence,{recursive:true});
const book={id:'navigation-fixture',title:'中段恢复与导航 · 合成测试',demo:false,position:60,draft:'tHE ',completed:[],stats:{sessions:0,characters:0,seconds:0},segments:Array.from({length:120},(_,index)=>({source:'这是用于验证滚动导航的原创测试文字。'.repeat(1+index%3),translation:'The quiet path leads toward the harbor. '.repeat(1+index%5)}))};
fs.writeFileSync(path.join(data,'library.json'),JSON.stringify({version:1,books:[book],activeBookId:book.id}));
const env={...process.env,NOVELTYPE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
const report={scope:'120 synthetic cached passages; isolated Electron profile; no real API',checks:[],geometry:[],errors:[],passed:false};
let app,page;
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function assertNavigation(stage){
 const sample=await page.evaluate(()=>{
  const box=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
  const nav=['nav-games','nav-map','nav-reading'].map(id=>{const node=document.getElementById(id),rect=box(node),x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2,hit=document.elementFromPoint(x,y);return {id,...rect,inViewport:rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth,hit:!!hit&&(hit===node||node.contains(hit)),point:{x,y}};});
  return {scrollY,width:innerWidth,height:innerHeight,nav,appbar:box(document.querySelector('.appbar')),toolbar:document.querySelector('#reading-area').hidden?null:box(document.querySelector('.stream-toolbar')),overflow:document.documentElement.scrollWidth>innerWidth};
 });
 report.geometry.push({stage,...sample});
 for(const item of sample.nav){assert.equal(item.inViewport,true,`${stage}: ${item.id} is outside the viewport (top ${item.top}, scroll ${sample.scrollY})`);assert.equal(item.hit,true,`${stage}: ${item.id} is obscured by another element`);}
 if(sample.toolbar&&sample.scrollY>500)assert.ok(sample.toolbar.top>=sample.appbar.bottom-1,`${stage}: sticky reading toolbar overlaps global navigation`);
 assert.equal(sample.overflow,false,`${stage}: horizontal page overflow`);
 return sample;
}
async function clickVisibleNav(id,stage){const sample=await assertNavigation(stage),item=sample.nav.find(node=>node.id===id);await page.mouse.click(item.point.x,item.point.y);await page.waitForFunction(id=>document.getElementById(id).getAttribute('aria-current')==='page',id);}
async function assertReadingTarget(stage){
 const geometry=await page.evaluate(()=>{
  const toolbar=document.querySelector('.stream-toolbar').getBoundingClientRect(),heading=document.querySelector('.story-passage.is-active .story-passage-heading').getBoundingClientRect(),input=document.getElementById('typing-input').getBoundingClientRect();
  const controls=['open-settings','export-backup','import-backup','open-folder'].map(id=>{const node=document.getElementById(id),r=node.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return {id,inViewport:r.top>=0&&r.bottom<=innerHeight,hit:!!hit&&(hit===node||node.contains(hit))};});
  return {toolbarBottom:toolbar.bottom,headingTop:heading.top,inputTop:input.top,inputBottom:input.bottom,viewportHeight:innerHeight,controls};
 });
 report.geometry.push({stage,...geometry});
 assert.ok(geometry.headingTop>=geometry.toolbarBottom-1,`${stage}: active paragraph heading is hidden behind sticky controls`);
 assert.ok(geometry.inputTop>=geometry.toolbarBottom-1&&geometry.inputBottom<=geometry.viewportHeight,`${stage}: current input is obscured or outside the viewport`);
 for(const control of geometry.controls){assert.equal(control.inViewport,true,`${stage}: sidebar ${control.id} is below the window`);assert.equal(control.hit,true,`${stage}: sidebar ${control.id} is obscured`);}
}
async function readingProgress(){return page.evaluate(async()=>{const state=await window.novel.getState(),b=state.books.find(item=>item.id===state.activeBookId);return {position:b.position,draft:b.draft,completed:b.completed,stats:b.stats};});}
(async()=>{try{
 app=await _electron.launch({args:[root],env,timeout:30000});
 assert.equal(path.resolve(await app.evaluate(({app})=>app.getPath('userData'))),path.resolve(data));
 await app.evaluate(({net})=>{globalThis.navigationNetworkCalls=0;net.fetch=async()=>{navigationNetworkCalls++;throw Error('Navigation test must never request AI or a remote service');};});
 page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.locator('.story-passage.is-active').waitFor();
 for(const [width,height]of [[960,760],[880,680]]){
  await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height});
  await page.reload();await page.locator('.story-passage.is-active').waitFor();await page.waitForFunction(()=>window.scrollY>500);await page.waitForTimeout(150);
  await check(`${width}px: restored mid-book navigation stays visible and clear of the reading toolbar`,async()=>{
   assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'60');
   await page.screenshot({path:path.join(evidence,`navigation-scroll-${width}.png`)});
   await assertNavigation(`${width}-restored`);
   await assertReadingTarget(`${width}-restored-content`);
   await page.evaluate(()=>window.scrollBy(0,750));await page.waitForTimeout(120);await assertNavigation(`${width}-further-scroll`);
  });
  await check(`${width}px: games and map are clickable without scrolling to the top; reading draft survives`,async()=>{
   const before=await readingProgress();
   await clickVisibleNav('nav-games',`${width}-click-games`);await page.locator('#game-map-open').waitFor();
   await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(80);
   await clickVisibleNav('nav-map',`${width}-games-scrolled-click-map`);await page.locator('.game-map-node').first().waitFor();
   assert.equal(await page.locator('.game-map-node').count(),12);
   await clickVisibleNav('nav-reading',`${width}-map-click-reading`);await page.locator('#typing-input').waitFor();
   assert.equal(await page.locator('#typing-input').inputValue(),before.draft);
   assert.deepEqual(await readingProgress(),before);
   await page.locator('#return-to-input').click();
   if(await page.locator('#typing-input').evaluate(node=>node.readOnly))await page.locator('#pause').click();
   await page.waitForFunction(()=>document.activeElement.id==='typing-input');
   assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'60');
   await assertNavigation(`${width}-return-to-input`);
   await assertReadingTarget(`${width}-return-to-input-content`);
  });
 }
 assert.equal(await app.evaluate(()=>navigationNetworkCalls),0);assert.deepEqual(report.errors,[]);report.networkCalls=0;report.passed=true;
 console.log(JSON.stringify({passed:report.checks.length,networkCalls:0}));
}finally{
 fs.writeFileSync(path.join(evidence,'navigation-scroll-tests.json'),JSON.stringify(report,null,2));
 if(app)await app.close();
 const target=path.resolve(data);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('noveltype-navigation-scroll-'));fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}})().catch(error=>{console.error(error);process.exitCode=1;});
