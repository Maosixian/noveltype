'use strict';
// Synthetic books only; the installed/user profile is never opened by this test.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const {AlignmentCache}=require('../app/alignment.cjs');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-centered-typing-'));
const evidence=path.join(root,'evidence');fs.mkdirSync(evidence,{recursive:true});
const longText='Silver lanterns guide the traveler along a quiet river and past the sleeping houses. '.repeat(28).trim();
const segment=(translation,source='清晨，旅人沿着河岸走过安静的小镇。')=>({source,translation});
const book=(id,segments,options={})=>({id,title:'居中输入测试 · '+id,demo:false,position:0,draft:'',completed:[],stats:{sessions:0,characters:0,seconds:0},segments,...options});
const books=[
 book('restored',Array.from({length:30},(_,i)=>segment(i===14?longText:`The traveler continues along road ${i+1}.`)),{position:14,draft:longText.slice(0,600),completed:Array.from({length:14},(_,i)=>i)}),
 ...['chapter','chapter-browse','chapter-narrow'].map(id=>book(id,[segment('First light.','第一章 初见\n灯光照亮小路。'),segment(longText,'第二章 归途\n旅人沿河继续前行。'),segment('Home.','第三章 回家\n旅人到家。')],{draft:'First light'})),
 book('final',[segment('The road begins.'),segment('Home.')],{position:1,draft:'H',completed:[0]})
];
new Library(data).importData({version:1,books,activeBookId:'restored'});
const cache=new AlignmentCache(data);for(const b of books)for(const s of b.segments)cache.set(s.source,s.translation,{version:1,spans:[{englishStart:0,englishEnd:s.translation.length,sourceStart:0,sourceEnd:s.source.length}]});
const packagedExe=process.env.NOVELTYPE_PACKAGED_EXE;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NOVELTYPE_TEST_DATA;if(!packagedExe)env.NOVELTYPE_TEST_DATA=data;
const report={checks:[],geometry:[],errors:[],isolatedData:true,packaged:!!packagedExe,providerRequests:0,passed:false};
let app,page;
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function frames(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function resize(width,height){await app.evaluate(({BrowserWindow},{width,height})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(520,500);w.setContentSize(width,height);},{width,height});await page.waitForFunction(width=>innerWidth===width,width);await frames();}
// Exercise the real control without Playwright first scrolling its offscreen header
// into view, which would independently switch the app into manual browsing mode.
async function changeFont(){await page.locator('#font-toggle').evaluate(node=>node.click());await frames();}
async function geometry(){return page.evaluate(()=>{const caret=document.querySelector('#translation-text .caret')||document.querySelector('#translation-text .inline-end');const c=caret.getBoundingClientRect(),bar=document.querySelector('.stream-toolbar').getBoundingClientRect();const center=(c.top+c.bottom)/2,usableCenter=(Math.max(0,bar.bottom)+innerHeight)/2;return {center,usableCenter,offset:center-usableCenter,caretTop:c.top,caretBottom:c.bottom,toolbarBottom:bar.bottom,height:innerHeight,width:innerWidth,scrollY,overflow:document.documentElement.scrollWidth>innerWidth};});}
async function centered(stage){
 await frames();
 // ResizeObserver, the sticky toolbar, and the caret can settle on successive frames.
 await page.waitForFunction(()=>{const node=document.querySelector('#translation-text .caret')||document.querySelector('#translation-text .inline-end');if(!node)return false;const c=node.getBoundingClientRect(),bar=document.querySelector('.stream-toolbar').getBoundingClientRect();return Math.abs((c.top+c.bottom)/2-(Math.max(0,bar.bottom)+innerHeight)/2)<=24;},null,{timeout:2500}).catch(()=>{});
 const g=await geometry();report.geometry.push({stage,...g});if(process.env.CENTERED_TRACE&&Math.abs(g.offset)>24)report.trace=await page.evaluate(()=>globalThis.centeredTrace);assert.ok(Math.abs(g.offset)<=24,`${stage}: current line should be centered in the available reading viewport; offset=${g.offset.toFixed(1)}px`);assert.ok(g.caretTop>=g.toolbarBottom);assert.ok(g.caretBottom<g.height);assert.equal(g.overflow,false);return g;
}
async function select(id){await page.locator(`.book-button[title="居中输入测试 · ${id}"]`).click();await page.waitForFunction(title=>document.querySelector('#book-title').textContent===title,'居中输入测试 · '+id);await frames();}
async function progress(id){return page.evaluate(async id=>{const b=(await window.novel.getState()).books.find(b=>b.id===id);return {position:b.position,draft:b.draft,completed:b.completed};},id);}
async function durable(id,expected){const end=Date.now()+10000;while(Date.now()<end){const b=await progress(id);if(Object.entries(expected).every(([k,v])=>JSON.stringify(b[k])===JSON.stringify(v)))return b;await page.waitForTimeout(50);}assert.fail('Expected centered-typing draft was not saved');}
async function holdCompletion(){await app.evaluate(()=>{centeredHeld=false;centeredHoldSave=true;});}
async function awaitHeld(){const end=Date.now()+5000;while(Date.now()<end){if(await app.evaluate(()=>centeredHeld))return;await page.waitForTimeout(30);}assert.fail('Chapter completion did not reach the simulated delayed save');}
async function releaseCompletion(){await app.evaluate(()=>{centeredHoldSave=false;centeredReleaseSave?.();});}
async function typeNext(count){const input=page.locator('#typing-input'),value=await input.inputValue();await input.focus();await page.keyboard.type(longText.slice(value.length,value.length+count));}
async function nextVisualLine(stage){
 const count=await page.evaluate(()=>{const input=document.querySelector('#typing-input'),nodes=document.querySelectorAll('#translation-text>.target-char'),index=input.value.length,top=nodes[index].getBoundingClientRect().top;for(let i=index+1;i<nodes.length;i++)if(nodes[i].getBoundingClientRect().top>top+3)return i-index+1;return 1;});
 await typeNext(count);return centered(stage);
}
(async()=>{try{
 app=await _electron.launch(packagedExe?{executablePath:packagedExe,args:[`--user-data-dir=${data}`],env,timeout:30000}:{args:[root],env,timeout:30000});
 const actual=await app.evaluate(({app})=>({userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),packaged:app.isPackaged}));assert.equal(path.resolve(actual.userData).toLowerCase(),data.toLowerCase());assert.equal(path.resolve(actual.sessionData).toLowerCase(),data.toLowerCase());assert.equal(actual.packaged,!!packagedExe);
 await app.evaluate(({net,ipcMain})=>{globalThis.centeredProviderCalls=0;globalThis.centeredHoldSave=false;globalThis.centeredHeld=false;net.fetch=async()=>{centeredProviderCalls++;throw Error('No network in centered typing tests');};const save=ipcMain._invokeHandlers.get('novel:saveProgress');ipcMain._invokeHandlers.set('novel:saveProgress',async(event,payload)=>{if(payload.completed!==undefined&&payload.bookId.startsWith('chapter')&&centeredHoldSave){centeredHeld=true;await new Promise(resolve=>{globalThis.centeredReleaseSave=resolve;});}return save(event,payload);});});
 page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));await page.locator('.story-passage.is-active').waitFor();
 if(process.env.CENTERED_TRACE)await page.evaluate(()=>{
  globalThis.centeredTrace=[];const log=(kind,detail={})=>{const c=document.querySelector('#translation-text .caret')?.getBoundingClientRect();centeredTrace.push({kind,time:performance.now(),scrollY,caretY:c?.top,inputLength:document.querySelector('#typing-input')?.value.length,...detail});if(centeredTrace.length>60)centeredTrace.shift();};
  const native=window.scrollBy.bind(window);window.scrollBy=(...args)=>{log('scrollBy:before',{delta:typeof args[0]==='object'?args[0].top:args[1]});const value=native(...args);log('scrollBy:after');return value;};
  for(const kind of ['input','keydown','scroll','resize'])window.addEventListener(kind,event=>log(kind,{key:event.key,inputType:event.inputType}),true);
 });
 await check('restored mid-book input is centered below the sticky reading toolbar',async()=>{await resize(1380,900);assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'14');assert.equal(await page.locator('#typing-input').inputValue(),longText.slice(0,600));await centered('restored-desktop');});
 await check('typing on the same visual line does not repeatedly scroll the document',async()=>{
  await page.locator('#return-to-input').click();await centered('same-line-start');
  let available=await page.evaluate(()=>{const n=document.querySelector('#typing-input').value.length,nodes=document.querySelectorAll('#translation-text>.target-char'),y=nodes[n].getBoundingClientRect().top;let count=0;while(count<5&&nodes[n+count+1]&&Math.abs(nodes[n+count+1].getBoundingClientRect().top-y)<3)count++;return count;});
  if(!available){await typeNext(1);await centered('same-line-adjusted');available=3;}
  const before=await geometry();await typeNext(Math.min(3,available));await frames();const after=await centered('same-line-end');assert.ok(Math.abs(after.scrollY-before.scrollY)<=2,'Same-line typing must not make the page jitter');
 });
 await check('each wrapped line stays centered during long-paragraph typing',async()=>{
  await page.evaluate(()=>{globalThis.centeredOriginalInput=document.querySelector('#typing-input');globalThis.centeredOriginalChar=document.querySelector('#translation-text>.target-char');});
  for(let i=0;i<4;i++)await nextVisualLine('desktop-wrap-'+i);
  assert.equal(await page.evaluate(()=>document.activeElement===centeredOriginalInput&&document.querySelector('#translation-text>.target-char')===centeredOriginalChar),true);
  assert.equal(await page.locator('#translation-text .wrong').count(),0);await page.screenshot({path:path.join(evidence,'centered-typing-desktop.png')});
 });
 await check('manual browsing and resizing do not snap back or change progress',async()=>{
  const draft=await page.locator('#typing-input').inputValue();await durable('restored',{draft});const before=await progress('restored');
  await page.evaluate(()=>window.scrollBy(0,-400));await page.waitForTimeout(120);const browsing=await geometry();assert.ok(browsing.offset>150);
  await resize(1380,760);await page.waitForTimeout(120);const resized=await geometry();assert.ok(resized.offset>150,'Resizing while browsing must not re-enable following');assert.ok(Math.abs(resized.scrollY-browsing.scrollY)<=3);
  await changeFont();const fontChanged=await geometry();assert.ok(fontChanged.offset>100,'Font changes while browsing must not pull the user back to practice');assert.deepEqual(await progress('restored'),before);
 });
 await check('typing and the return button each restore centered following after manual browsing',async()=>{
  await typeNext(1);await centered('typing-resumes-follow');
  const draft=await page.locator('#typing-input').inputValue();await durable('restored',{draft});const before=await progress('restored');await page.evaluate(()=>window.scrollBy(0,-300));await frames();
  await page.locator('#return-to-input').click();await centered('return-resumes-follow');assert.deepEqual(await progress('restored'),before);assert.equal(await page.locator('#typing-input').inputValue(),draft);
 });
 await check('viewport and font changes recenter the active line while following',async()=>{
  await resize(1380,900);await centered('following-taller');await resize(1380,720);await centered('following-shorter');
  await changeFont();await centered('following-font-change');
 });
 await check('automatic chapter advance centers before and after delayed chapter-banner acknowledgement',async()=>{
  await select('chapter');await page.locator('#return-to-input').click();await centered('chapter-before');await holdCompletion();await page.keyboard.type('.S');await awaitHeld();
  assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'1');assert.equal(await page.locator('#typing-input').inputValue(),'S');assert.equal(await page.locator('#chapter-notice').isVisible(),false);const before=await centered('chapter-before-ack');
  await releaseCompletion();await page.locator('#chapter-notice').waitFor({state:'visible'});await durable('chapter',{position:1,draft:'S',completed:[0]});const after=await centered('chapter-after-ack');
  assert.ok(after.toolbarBottom>before.toolbarBottom+20,'This case must actually enlarge the sticky toolbar');assert.match(await page.locator('#chapter-notice-next').textContent(),/第二章/);assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
  await page.screenshot({path:path.join(evidence,'centered-typing-chapter.png')});await page.locator('#chapter-notice-dismiss').click();await centered('chapter-after-dismiss');
 });
 await check('a delayed chapter banner respects manual browsing until return is requested',async()=>{
  await select('chapter-browse');await page.locator('#return-to-input').click();await holdCompletion();await page.keyboard.type('.S');await awaitHeld();await centered('browse-chapter-before-ack');
  await page.evaluate(()=>window.scrollBy(0,-250));await frames();const before=await geometry();assert.ok(before.offset>100);await releaseCompletion();await page.locator('#chapter-notice').waitFor({state:'visible'});await page.waitForTimeout(150);
  const after=await geometry();assert.ok(after.offset>100,'Late acknowledgement must not override the user browsing position');await durable('chapter-browse',{position:1,draft:'S',completed:[0]});await page.locator('#return-to-input').click();await centered('browse-chapter-return');
 });
 await check('the final short paragraph has enough document space to center before and after completion',async()=>{
  await select('final');await page.locator('#return-to-input').click();await centered('short-eof-before');await page.keyboard.type('ome.');await durable('final',{position:1,draft:'Home.',completed:[0,1]});
  assert.equal(await page.locator('#typing-input').evaluate(n=>n.readOnly),true);await centered('short-eof-complete');
 });
 await check('880px layouts keep chapter transitions and wrapped lines centered below the larger toolbar',async()=>{
  await resize(880,780);await select('chapter-narrow');await page.locator('#return-to-input').click();await centered('narrow-before');await page.keyboard.type('.S');
  await page.locator('#chapter-notice').waitFor({state:'visible'});await durable('chapter-narrow',{position:1,draft:'S',completed:[0]});await centered('narrow-chapter-ack');
  for(let i=0;i<2;i++)await nextVisualLine('narrow-wrap-'+i);
  await resize(880,680);await centered('narrow-shorter');await changeFont();await centered('narrow-font');await page.screenshot({path:path.join(evidence,'centered-typing-narrow.png')});
 });
 report.providerRequests=await app.evaluate(()=>centeredProviderCalls);assert.equal(report.providerRequests,0);assert.deepEqual(report.errors,[]);report.passed=true;console.log(JSON.stringify({passed:report.checks.length,providerRequests:0}));
}finally{
 if(app){await app.evaluate(()=>{globalThis.centeredHoldSave=false;globalThis.centeredReleaseSave?.();}).catch(()=>{});await app.close().catch(()=>{});}
 fs.writeFileSync(path.join(evidence,packagedExe?'centered-typing-packaged-tests.json':'centered-typing-tests.json'),JSON.stringify(report,null,2));
 const safe=path.resolve(data);assert.equal(path.dirname(safe),path.resolve(os.tmpdir()));assert.ok(path.basename(safe).startsWith('noveltype-centered-typing-'));fs.rmSync(safe,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}})().catch(error=>{console.error(error);process.exitCode=1;});
