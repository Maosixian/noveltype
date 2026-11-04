'use strict';
// Only synthetic books and a disposable profile. Never opens the user's library.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const {AlignmentCache}=require('../app/alignment.cjs');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-inline-typing-'));
const evidence=path.join(root,'evidence');fs.mkdirSync(evidence,{recursive:true});
const source='清晨，旅人走过石桥。她看见水面上的灯光，继续向前。';
const segment=translation=>({source,translation});
const fixture=(id,segments,draft='')=>({id,title:'原文输入测试 · '+id,demo:false,position:0,draft,completed:[],stats:{sessions:0,characters:0,seconds:0},segments:segments.map(segment)});
const longText=Array.from({length:40},(_,i)=>`The traveler follows the silver river past quiet houses on morning ${i+1}.`).join('\n');
const wrappedText='The quiet river carries silver light past the sleeping town. '.repeat(15);
const books=[fixture('basic',['The lamps shine.\nA boat returns.','Name\tValue.','The next story begins.']),fixture('long',[longText,'A new road.']),fixture('correction',['A bright day.','Keep walking.'],'a BRIGHT DAY!'),fixture('overflow',['abc','Keep going.'],'abXq'),fixture('composition',['abc','Keep going.']),fixture('wrapped',[wrappedText,'Next.'],wrappedText.slice(0,189)),fixture('finished',[longText],longText.slice(0,-1)),fixture('navigation',['First line.\nSecond line.'],'First line.\nSecond li')];
new Library(data).importData({version:1,books,activeBookId:'basic'});
const cache=new AlignmentCache(data);for(const b of books)for(const s of b.segments)cache.set(s.source,s.translation,{version:1,spans:[{englishStart:0,englishEnd:s.translation.length,sourceStart:0,sourceEnd:s.source.length}]});
const packagedExe=process.env.NOVELTYPE_PACKAGED_EXE;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NOVELTYPE_TEST_DATA;if(!packagedExe)env.NOVELTYPE_TEST_DATA=data;
const report={checks:[],geometry:[],errors:[],isolatedData:true,packaged:!!packagedExe,providerRequests:0,passed:false};
let app,page,requests=0;
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function launch(){
 app=await _electron.launch(packagedExe?{executablePath:packagedExe,args:[`--user-data-dir=${data}`],env,timeout:30000}:{args:[root],env,timeout:30000});
 const actual=await app.evaluate(({app})=>({userData:app.getPath('userData'),packaged:app.isPackaged}));assert.equal(path.resolve(actual.userData).toLowerCase(),data.toLowerCase());assert.equal(actual.packaged,!!packagedExe);
 await app.evaluate(({net})=>{globalThis.inlineProviderCalls=0;net.fetch=async()=>{inlineProviderCalls++;throw Error('No provider calls in inline typing tests');};});
 page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));await page.locator('.story-passage.is-active').waitFor();
}
async function close(){requests+=await app.evaluate(()=>inlineProviderCalls);const closed=app.waitForEvent('close',{timeout:15000});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;app=null;}
async function select(id){await page.locator(`.book-button[title="原文输入测试 · ${id}"]`).click();await page.waitForFunction(title=>document.querySelector('#book-title').textContent===title,'原文输入测试 · '+id);}
async function progress(id){return page.evaluate(async id=>{const b=(await window.novel.getState()).books.find(b=>b.id===id);return {position:b.position,draft:b.draft,completed:b.completed};},id);}
async function durable(id,expected){const end=Date.now()+10000;while(Date.now()<end){const b=await progress(id);if(Object.entries(expected).every(([k,v])=>JSON.stringify(b[k])===JSON.stringify(v)))return b;await page.waitForTimeout(50);}assert.fail('Expected inline draft did not become durable');}
async function resize(width,height){await app.evaluate(({BrowserWindow},{width,height})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(520,500);w.setContentSize(width,height);},{width,height});await page.waitForFunction(width=>innerWidth===width,width);}
async function caretGeometry(){return page.evaluate(()=>{const c=document.querySelector('#translation-text .caret'),input=document.getElementById('typing-input'),target=document.getElementById('translation-text'),bar=document.querySelector('.stream-toolbar');const rect=node=>{const r=node?.getBoundingClientRect();return r?{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null;};return {caret:rect(c),input:rect(input),target:rect(target),toolbar:rect(bar),viewport:{width:innerWidth,height:innerHeight},scrollY,overflow:document.documentElement.scrollWidth>innerWidth};});}
async function visibleCaret(){await page.waitForFunction(()=>{const c=document.querySelector('#translation-text .caret');if(!c)return false;const r=c.getBoundingClientRect(),b=document.querySelector('.stream-toolbar').getBoundingClientRect();return r.top>=Math.max(0,b.bottom)-1&&r.bottom<=innerHeight-8;});}
async function clickTarget(selector='#translation-text .target-char'){const target=page.locator(selector).first();await target.scrollIntoViewIfNeeded();const r=await target.boundingBox();assert.ok(r);await page.mouse.click(r.x+Math.max(1,r.width/2),r.y+r.height/2);}
(async()=>{try{
 await launch();
 await check('English text itself accepts typing without a duplicate lower text area',async()=>{
  await resize(1380,800);await clickTarget();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input','Clicking the English text must focus native typing');
  const g=await caretGeometry();report.geometry.push({stage:'initial',...g});
  assert.ok(g.input.y>=g.target.y-2&&g.input.bottom<=g.target.bottom+2,'The input proxy must occupy the English text, not a separate area below it');
  assert.ok(g.input.height<60,'The native input must not reserve a second paragraph-sized box');
  await page.keyboard.type('tHE ');assert.equal(await page.locator('#typing-input').inputValue(),'tHE ');assert.equal(await page.locator('#translation-text .wrong').count(),0);
  await page.locator('#source-text .source-highlight').waitFor();
  await page.screenshot({path:path.join(evidence,'inline-typing-desktop.png')});
 });
 await check('wrong keys remain visible, Backspace repairs them, selection replacement stays native',async()=>{
  await page.keyboard.type('x');assert.equal(await page.locator('#translation-text .wrong').count(),1);
  await page.keyboard.press('Backspace');await page.keyboard.type('l');assert.equal(await page.locator('#translation-text .wrong').count(),0);
  await page.keyboard.press('Shift+ArrowLeft');assert.deepEqual(await page.locator('#typing-input').evaluate(n=>[n.selectionStart,n.selectionEnd]),[4,5]);
  assert.equal(await page.locator('#translation-text .selected').count(),1,'Native selection must remain visible on the original English text');
  await page.keyboard.type('L');assert.equal(await page.locator('#typing-input').inputValue(),'tHE L');assert.equal(await page.locator('#translation-text .wrong').count(),0);
  await page.keyboard.type('AMPS SHINE.');await page.keyboard.press('Enter');await page.keyboard.type('a BOAT RETURNS.nAME');
  await page.waitForFunction(()=>document.querySelector('.story-passage.is-active').dataset.index==='1');assert.equal(await page.locator('#typing-input').inputValue(),'nAME');
  await page.keyboard.press('Tab');await page.keyboard.type('vALUE.t');
  await page.waitForFunction(()=>document.querySelector('.story-passage.is-active').dataset.index==='2');assert.equal(await page.locator('#typing-input').inputValue(),'t');assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
  await durable('basic',{position:2,draft:'t',completed:[0,1]});
 });
 await check('direct typing draft and completed paragraphs survive a normal restart',async()=>{
  const before=await progress('basic');await close();await launch();assert.deepEqual(await progress('basic'),before);assert.equal(await page.locator('#typing-input').inputValue(),'t');
 });
 await check('finding the first error returns the caret to the text and replaces only that character',async()=>{
  await select('correction');await page.locator('#first-error').click();
  assert.deepEqual(await page.locator('#typing-input').evaluate(n=>[n.selectionStart,n.selectionEnd]),[12,13]);
  await page.keyboard.type('.');await page.waitForFunction(()=>document.querySelector('.story-passage.is-active').dataset.index==='1');await durable('correction',{position:1,draft:'',completed:[0]});
 });
 await check('deleting and retyping the same overflow shows it again without false completion',async()=>{
  await select('overflow');await page.locator('#return-to-input').click();const input=page.locator('#typing-input');
  assert.equal(await page.locator('#translation-text .typing-overflow').textContent(),'q');
  await page.keyboard.press('Backspace');assert.equal(await input.inputValue(),'abX');assert.equal(await page.locator('#translation-text .typing-overflow').count(),0);
  await page.keyboard.type('q');assert.equal(await input.inputValue(),'abXq');assert.equal(await page.locator('#translation-text .typing-overflow').textContent(),'q');assert.equal(await page.locator('#translation-text .wrong').count(),2);
  assert.equal(await page.locator('#translation-text .inline-end.caret').count(),1);await durable('overflow',{position:0,draft:'abXq',completed:[]});
  await page.locator('#first-error').click();await page.keyboard.type('c');assert.equal(await input.inputValue(),'abcq');assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'0');
  await page.keyboard.press('Control+End');await page.keyboard.press('Backspace');await page.waitForFunction(()=>document.querySelector('.story-passage.is-active').dataset.index==='1');await durable('overflow',{position:1,draft:'',completed:[0]});
 });
 await check('composition matching a complete paragraph does not advance before commit',async()=>{
  await select('composition');await page.locator('#return-to-input').click();const cdp=await page.context().newCDPSession(page);
  try{
   await cdp.send('Input.imeSetComposition',{text:'abc',selectionStart:3,selectionEnd:3});await page.waitForTimeout(500);
   assert.equal(await page.locator('#typing-input').inputValue(),'abc');assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'0','Uncommitted composition must not complete a paragraph');assert.deepEqual(await progress('composition'),{position:0,draft:'',completed:[]});
   await cdp.send('Input.insertText',{text:'abc'});await page.waitForFunction(()=>document.querySelector('.story-passage.is-active').dataset.index==='1');await durable('composition',{position:1,draft:'',completed:[0]});assert.equal(await page.locator('#typing-input').inputValue(),'');
  }finally{await cdp.detach();}
 });
 await check('ArrowUp and ArrowDown follow wrapped English lines rather than the tiny native proxy',async()=>{
  await select('wrapped');await resize(1100,700);await page.locator('#return-to-input').click();await visibleCaret();const input=page.locator('#typing-input');
  assert.deepEqual(await input.evaluate(n=>[n.selectionStart,n.selectionEnd]),[189,189]);const before=await input.inputValue();
  const line=()=>page.evaluate(()=>{const c=document.querySelector('#translation-text .caret').getBoundingClientRect(),t=document.querySelector('#translation-text').getBoundingClientRect();return {x:c.x-t.x,y:c.y-t.y};});
  const initial=await line();await page.keyboard.press('ArrowUp');const offset=await input.evaluate(n=>n.selectionStart),above=await line();
  assert.ok(offset>0&&offset<189,'Up moves to the preceding visual line, not the start of the logical line');assert.ok(above.y<initial.y-10);assert.ok(Math.abs(above.x-initial.x)<16,'Vertical navigation preserves the displayed column');
  await page.keyboard.press('ArrowDown');assert.deepEqual(await input.evaluate(n=>[n.selectionStart,n.selectionEnd]),[189,189]);assert.equal(await input.inputValue(),before);assert.equal(await page.locator('#translation-text .wrong').count(),0);
  await input.evaluate(n=>{n.setSelectionRange(90,90);n.dispatchEvent(new Event('select',{bubbles:true}));});
  const row=await page.evaluate(()=>{const nodes=Array.from(document.querySelectorAll('#translation-text>.target-char')),y=nodes[90].getBoundingClientRect().top;const positions=nodes.map((n,i)=>({i,y:n.getBoundingClientRect().top})).filter(p=>Math.abs(p.y-y)<3);return {start:positions[0].i,end:positions.at(-1).i+1};});
  await page.keyboard.press('Home');assert.deepEqual(await input.evaluate(n=>[n.selectionStart,n.selectionEnd]),[row.start,row.start]);
  await page.keyboard.press('End');assert.deepEqual(await input.evaluate(n=>[n.selectionStart,n.selectionEnd]),[row.end,row.end]);assert.equal(await input.inputValue(),before);
 });
 await check('Home and End stop before literal newlines and preserve native Shift selection',async()=>{
  await select('navigation');await page.locator('#return-to-input').click();const input=page.locator('#typing-input'),before=await input.inputValue();
  await page.keyboard.press('Home');assert.deepEqual(await input.evaluate(n=>[n.selectionStart,n.selectionEnd]),[12,12]);
  await page.keyboard.press('ArrowUp');assert.deepEqual(await input.evaluate(n=>[n.selectionStart,n.selectionEnd]),[0,0]);
  await page.keyboard.press('End');assert.deepEqual(await input.evaluate(n=>[n.selectionStart,n.selectionEnd]),[11,11],'End stops before the explicit newline');
  await page.keyboard.press('Home');await page.keyboard.press('Shift+End');assert.deepEqual(await input.evaluate(n=>[n.selectionStart,n.selectionEnd]),[0,11]);assert.equal(await page.locator('#translation-text .selected').count(),11);assert.equal(await input.inputValue(),before);
 });
 await check('long paragraphs follow the current typed line without scrolling to a duplicate input',async()=>{
  await select('long');await resize(1100,700);await clickTarget();
  await page.evaluate(()=>{globalThis.inlineOriginalInput=document.getElementById('typing-input');globalThis.inlineOriginalChar=document.querySelector('#translation-text .target-char');});
  for(const line of longText.split('\n').slice(0,18)){await page.keyboard.type(line.toUpperCase());await page.keyboard.press('Enter');}
  await visibleCaret();const g=await caretGeometry();report.geometry.push({stage:'long',...g});assert.ok(g.scrollY>250,'Typing many lines should bring the active line into view');assert.equal(g.overflow,false);
  assert.equal(await page.evaluate(()=>document.activeElement===inlineOriginalInput&&inlineOriginalChar===document.querySelector('#translation-text .target-char')),true,'Caret follow must retain input and existing text nodes');
  assert.equal(await page.locator('#translation-text .wrong').count(),0);await page.screenshot({path:path.join(evidence,'inline-typing-long.png')});
 });
 await check('manual browsing does not move practice or request translation; return resumes the current caret',async()=>{
  const draft=await page.locator('#typing-input').inputValue();await durable('long',{draft});const before=await progress('long');
  await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(250);assert.ok(await page.evaluate(()=>scrollY)<20,'Manual browsing must not be pulled back by background renders');assert.deepEqual(await progress('long'),before);
  await page.locator('#return-to-input').click();await visibleCaret();assert.equal(await page.locator('#typing-input').inputValue(),draft);
  await clickTarget('#translation-text .caret');assert.equal(await page.locator('#typing-input').inputValue(),draft,'Clicking target resumes without resetting draft');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
 });
 await check('narrow, enlarged and dark layouts keep the active English line and input usable',async()=>{
  for(const width of [880,620]){await resize(width,800);await page.locator('#return-to-input').click();await visibleCaret();assert.equal((await caretGeometry()).overflow,false);}
  await page.locator('#font-toggle').click();await page.locator('#font-toggle').click();await page.locator('#return-to-input').click();await visibleCaret();
  await page.locator('#theme-toggle').click();await page.locator('#return-to-input').click();await visibleCaret();
  const input=page.locator('#typing-input'),before=await input.inputValue();await page.keyboard.type('T');assert.equal(await input.inputValue(),before+'T');await page.keyboard.press('Backspace');assert.equal(await input.inputValue(),before);
  await page.screenshot({path:path.join(evidence,'inline-typing-narrow-dark.png')});
 });
 await check('paste and replacement input cannot bypass practice',async()=>{
  const before=await page.locator('#typing-input').inputValue();const prevented=await page.locator('#typing-input').evaluate(n=>{const e=new InputEvent('beforeinput',{inputType:'insertFromPaste',data:'injected',bubbles:true,cancelable:true});n.dispatchEvent(e);return e.defaultPrevented;});assert.equal(prevented,true);assert.equal(await page.locator('#typing-input').inputValue(),before);
 });
 await check('native IME composition retains focus and commits once in the English surface',async()=>{
  await page.locator('#return-to-input').click();const input=page.locator('#typing-input'),before=await input.inputValue();
  const cdp=await page.context().newCDPSession(page);
  try{await cdp.send('Input.imeSetComposition',{text:'T',selectionStart:1,selectionEnd:1});assert.equal(await input.inputValue(),before+'T');assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');await cdp.send('Input.insertText',{text:'T'});assert.equal(await input.inputValue(),before+'T','IME commit must not duplicate composed text');}
  finally{await cdp.detach();}
  await page.keyboard.press('Backspace');assert.equal(await input.inputValue(),before);await durable('long',{draft:before});
 });
 await check('finishing the final long paragraph keeps the compact input at the final English line',async()=>{
  await select('finished');await resize(1100,700);await page.locator('#return-to-input').click();await visibleCaret();
  await page.keyboard.type(longText.at(-1));await durable('finished',{position:0,draft:longText,completed:[0]});
  await page.waitForFunction(()=>{const input=document.querySelector('#typing-input').getBoundingClientRect(),last=document.querySelector('#translation-text .inline-end').getBoundingClientRect();return input.height<60&&Math.abs(input.top-last.top)<2;});
  assert.equal(await page.locator('#typing-input').evaluate(n=>n.readOnly),true);assert.equal(await page.locator('#translation-text .caret').count(),0);assert.equal(await page.locator('#translation-text .wrong').count(),0);
  const g=await caretGeometry();report.geometry.push({stage:'finished-long',...g});assert.ok(g.input.y>g.target.y+300,'Completing the book must not send the input back to the start of its long paragraph');assert.ok(g.input.bottom<=g.viewport.height-8);assert.equal(g.overflow,false);
 });
 report.providerRequests=requests+await app.evaluate(()=>inlineProviderCalls);assert.equal(report.providerRequests,0);assert.deepEqual(report.errors,[]);report.passed=true;console.log(JSON.stringify({passed:report.checks.length,providerRequests:0}));
}finally{
 if(app)await close().catch(()=>{});fs.writeFileSync(path.join(evidence,packagedExe?'inline-typing-packaged-tests.json':'inline-typing-tests.json'),JSON.stringify(report,null,2));
 const safe=path.resolve(data);assert.equal(path.dirname(safe),path.resolve(os.tmpdir()));assert.ok(path.basename(safe).startsWith('noveltype-inline-typing-'));fs.rmSync(safe,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}})().catch(error=>{console.error(error);process.exitCode=1;});
