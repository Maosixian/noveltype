const {_electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const {AlignmentCache,parseAlignedResponse}=require('../app/alignment.cjs');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-alignment-'));
const library=new Library(data),cache=new AlignmentCache(data);
const first={source:'清晨，林推开门。他看见灯塔。',translation:'At dawn, Lin opened the door. He saw the lighthouse.'};
const second={source:'夜晚，风吹过河面。',translation:'At night, wind crossed the river.'};
const groups=[
  [['At dawn,','清晨'],['Lin','林'],['opened','推开'],['the door.','门'],['He','他'],['saw','看见'],['the lighthouse.','灯塔']],
  [['At night,','夜晚'],['wind','风'],['crossed','吹过'],['the river.','河面']]
];
const book=library.getState().books[0];Object.assign(book,{id:'alignment-fixture',title:'词句同步对照测试',demo:false,segments:[first,second]});
library.importData({version:1,books:[book],activeBookId:book.id});
for(const [i,segment] of [first,second].entries())cache.set(segment.source,segment.translation,parseAlignedResponse(segment.source,JSON.stringify({translation:segment.translation,groups:groups[i].map(([english,chinese])=>({english,chinese,occurrence:0}))})).alignment);
const env={...process.env,NOVELTYPE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const checks=[],errors=[];
async function launch(){app=await _electron.launch({args:[root],env});await app.evaluate(({net})=>{globalThis.mapRequests=[];net.fetch=async()=>{throw new Error('No network without start');};});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.locator('#guide-status').waitFor();}
const mark=()=>page.locator('#source-text .source-highlight');
async function highlight(text){await page.waitForFunction(text=>document.querySelector('#source-text .source-highlight')?.textContent===text,text);}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
async function close(){const closed=app.waitForEvent('close');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;app=null;}
(async()=>{try{
  await launch();
  await check('cached semantic map highlights the initial phrase without a key',async()=>{await highlight('清晨');assert.equal(await page.locator('#source-text').textContent(),first.source);assert.equal((await page.evaluate(()=>window.novel.getState())).settings.hasKey,false);});
  await check('typed word, backspace, and cursor movement update the exact Chinese phrase',async()=>{
    const input=page.locator('#typing-input');await input.click();await input.pressSequentially('at dawn, L');await highlight('林');
    assert.equal(await input.inputValue(),'at dawn, L');assert.equal(await page.locator('.target-char.wrong').count(),0);
    await input.press('Home');await highlight('清晨');await input.press('End');await highlight('林');
    await input.pressSequentially('in o');await highlight('推开');await input.press('Backspace');await highlight('推开');
    await input.press('Backspace');await highlight('推开');
    await input.press('Backspace');await highlight('林');
    assert.equal(await page.locator('#source-text').textContent(),first.source);
  });
  await check('selection and wrong letters track the target position without losing input',async()=>{
    const input=page.locator('#typing-input');await input.evaluate(el=>{el.setSelectionRange(0,2);el.dispatchEvent(new Event('select'));});await highlight('清晨');
    await input.press('End');await input.pressSequentially(' x');await highlight('推开');assert.ok(await page.locator('.target-char.wrong').count()>0);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
  });
  await check('automatic advance carries focus and highlights the new source only',async()=>{
    await page.locator('#reset').click();await page.locator('#typing-input').pressSequentially(first.translation+'At n',{delay:8});
    await highlight('夜晚');assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),'1');
    assert.equal(await page.locator('#typing-input').inputValue(),'At n');assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
    assert.equal(await page.locator('.story-passage:not(.is-active) .source-highlight').count(),0);
    assert.equal(await page.locator('#source-text').textContent(),second.source);
  });
  await check('restart restores input and cached highlight without API requests',async()=>{await close();await launch();await highlight('夜晚');assert.equal(await page.locator('#typing-input').inputValue(),'At n');});
  await check('editing translation invalidates its old map without fetching automatically',async()=>{
    await page.locator('#edit-translation').click();await page.locator('#edit-text').fill('The wind moves.');await page.locator('#edit-submit').click();await page.locator('#edit-dialog').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('#translation-text').textContent==='The wind moves.');
    assert.equal(await mark().count(),0);assert.match(await page.locator('#guide-status').textContent(),/准备/);
    assert.equal(await page.locator('#source-text').textContent(),second.source);
  });
  await check('explicit start aligns an existing translation once and reuses the cache',async()=>{
    await page.locator('#open-settings').click();await page.locator('#api-key').fill('alignment-synthetic-key');await page.locator('#save-settings').click();await page.waitForFunction(()=>document.querySelector('#api-key').value==='');await page.locator('#settings-dialog .close-dialog').click();
    await app.evaluate(({net})=>{net.fetch=async(_url,request)=>{const input=JSON.parse(JSON.parse(request.body).messages[1].content);globalThis.mapRequests.push(input);const content=JSON.stringify({translation:input.translation,groups:[{english:input.translation,chinese:input.source,occurrence:0}]});return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}),{status:200});};});
    await page.locator('#translate').click();await highlight(second.source);assert.equal((await app.evaluate(()=>globalThis.mapRequests)).length,1);
    assert.equal((await app.evaluate(()=>globalThis.mapRequests))[0].translation,'The wind moves.');
    await page.locator('#pause').click();await page.locator('#pause').click();await page.waitForTimeout(200);assert.equal((await app.evaluate(()=>globalThis.mapRequests)).length,1);
    assert.equal(await page.locator('#translation-text').textContent(),'The wind moves.');
  });
  await check('compact rendering preserves text, highlights and focus without overflow',async()=>{
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,760));await page.locator('#typing-input').click();await page.locator('#typing-input').pressSequentially('t');await highlight(second.source);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
  });
  await page.evaluate(()=>window.novel.saveProgress({bookId:'alignment-fixture',position:0,draft:'At dawn, Lin op'}));await page.reload();await highlight('推开');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1380,930));await page.locator('#return-to-input').click();
  fs.mkdirSync(path.join(root,'evidence'),{recursive:true});await page.screenshot({path:path.join(root,'evidence/alignment-desktop.png')});
  fs.writeFileSync(path.join(root,'evidence/alignment-tests.json'),JSON.stringify({at:new Date().toISOString(),scope:'Isolated synthetic books and simulated API only',checks,passed:true},null,2));console.log(JSON.stringify({passed:checks.length}));
}finally{if(app)await app.close();assert.equal(path.dirname(data),path.resolve(os.tmpdir()));assert.ok(path.basename(data).startsWith('noveltype-alignment-'));fs.rmSync(data,{recursive:true,force:true,maxRetries:5,retryDelay:100});}})().catch(e=>{console.error(e);process.exitCode=1;});
