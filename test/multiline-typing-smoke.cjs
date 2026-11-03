'use strict';
// Real keyboard regression for imported bilingual passages containing line breaks.
// Every book, draft and alignment is synthetic and uses an isolated profile.
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const {AlignmentCache}=require('../app/alignment.cjs');
const root=path.resolve(__dirname,'..');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-multiline-'));
const evidence=path.join(root,'evidence');
const segment=(source,translation)=>({source,translation});
const book=(id,segments,options={})=>({id,title:'多行输入测试 · '+id,demo:false,position:0,draft:'',completed:[],stats:{sessions:0,characters:0,seconds:0},segments,...options});
const books=[
  book('multiline',[
    segment('第一章 合成测试\n河边灯亮了。\n小船归来。\n院门打开。','The lamps shine.\nA boat returns.\nThe gate opens.'),
    segment('沿着小路继续前进。','We continue.'),
    segment('第二章 合成测试\n新的旅途开始。','Another journey.')
  ]),
  book('restored-punctuation',[
    segment('第一章 合成测试\n这是晴朗的一天。','A bright day.'),
    segment('第二章 合成测试\n继续。','Go on.')
  ],{draft:'a BRIGHT DAY!'}),
  book('restored-newline',[
    segment('第一章 合成测试\n第一行。\n第二行。','First line.\nSecond line.'),
    segment('第二章 合成测试\n下一行。','Next line.')
  ],{draft:'fIRST LINE.xsECOND LINE.'}),
  book('restored-space',[
    segment('第一章 合成测试\n银色的河。','Silver river.'),
    segment('第二章 合成测试\n家。','Home.')
  ],{draft:'sILVER_rIVER.'}),
  book('tab',[
    segment('第一章 合成测试\n名称和值。','Name\tValue.'),
    segment('第二章 合成测试\n继续。','Go on.')
  ]),
  book('unicode-offset',[
    segment('第一章 合成测试\n星星发光。','A 🌟 shines.'),
    segment('第二章 合成测试\n继续。','Go on.')
  ],{draft:'a 🌟 SHINES!'}),
  book('unicode-length',[
    segment('第一章 合成测试\n星星发光。','A 🌟 shines.'),
    segment('第二章 合成测试\n继续。','Go on.')
  ],{draft:'a 🌙 SHINES.'}),
  book('omitted-newline',[
    segment('第一章 合成测试\n第一行。\n第二行。','First line.\nSecond line.'),
    segment('第二章 合成测试\n下一行。','Next line.')
  ],{draft:'fIRST LINE.sECOND LINE.'})
];
new Library(data).importData({version:1,books,activeBookId:'multiline'});
const cache=new AlignmentCache(data);
for(const b of books)for(const {source,translation}of b.segments)cache.set(source,translation,{version:1,spans:[{englishStart:0,englishEnd:translation.length,sourceStart:0,sourceEnd:source.length}]});
const packagedExe=process.env.NOVELTYPE_PACKAGED_EXE;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NOVELTYPE_TEST_DATA;
if(!packagedExe)env.NOVELTYPE_TEST_DATA=data;
const report={checks:[],errors:[],isolatedData:true,packaged:!!packagedExe,providerRequests:0,passed:false};
let app,page,totalRequests=0;
const fixture=id=>books.find(b=>b.id===id);
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function launch(){
  app=await _electron.launch(packagedExe?{executablePath:packagedExe,args:[`--user-data-dir=${data}`],env,timeout:30000}:{args:[root],env,timeout:30000});
  const paths=await app.evaluate(({app})=>({userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),packaged:app.isPackaged,version:app.getVersion()}));
  assert.equal(path.resolve(paths.userData).toLowerCase(),path.resolve(data).toLowerCase());
  assert.equal(path.resolve(paths.sessionData).toLowerCase(),path.resolve(data).toLowerCase());
  assert.equal(paths.packaged,!!packagedExe);if(packagedExe)assert.equal(paths.version,require('../package.json').version);
  await app.evaluate(({net})=>{globalThis.multilineProviderCalls=0;net.fetch=async()=>{multilineProviderCalls++;throw new Error('Multiline fixtures must not call an AI provider');};});
  page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.locator('.story-passage.is-active').waitFor();
}
async function close(){
  totalRequests+=await app.evaluate(()=>multilineProviderCalls);
  const closed=app.waitForEvent('close',{timeout:15000});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;app=null;
}
async function select(id){
  await page.locator(`.book-button[title="${fixture(id).title}"]`).click();
  await page.waitForFunction(title=>document.querySelector('#book-title')?.textContent===title,fixture(id).title);
}
async function saved(id,expected){
  await page.waitForFunction(()=>document.querySelector('#save-state')?.textContent.startsWith('✓'));
  // An earlier completion ACK may briefly precede the next draft's debounce.
  // Durability checks must observe the actual Library value, not that old ACK.
  if(id){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      const b=await progress(id);
      if(Object.entries(expected).every(([key,value])=>b[key]===value))return;
      await page.waitForTimeout(50);
    }
    assert.fail('The expected draft did not become durable');
  }
}
async function progress(id){return page.evaluate(async id=>{const b=(await window.novel.getState()).books.find(b=>b.id===id);return {position:b.position,draft:b.draft,completed:b.completed,stats:b.stats,translations:b.segments.map(s=>s.translation)};},id);}
async function position(index){assert.equal(await page.locator('.story-passage.is-active').getAttribute('data-index'),String(index));}
async function selectInput(start,end){await page.locator('#typing-input').evaluate((input,{start,end})=>{input.focus({preventScroll:true});input.setSelectionRange(start,end);},{start,end});}
(async()=>{try{
  await launch();
  await check('real Enter inserts required line breaks and continuous typing crosses two paragraphs',async()=>{
    const input=page.locator('#typing-input');await input.click();
    await input.pressSequentially('tHE LAMPS SHINE.',{delay:5});await input.press('Enter');
    assert.equal(await input.inputValue(),'tHE LAMPS SHINE.\n','Enter must insert the required newline instead of silently discarding it');
    assert.equal(await page.locator('.story-passage.is-active .target-char.wrong').count(),0);
    assert.equal(await page.locator('#translation-text .target-char.newline').count(),2);
    assert.equal(await page.locator('#translation-text').textContent(),fixture('multiline').segments[0].translation);
    await input.pressSequentially('a BOAT RETURNS.',{delay:5});await input.press('Enter');
    await input.pressSequentially('tHE GATE OPENS.wE CONTINUE.a',{delay:5});
    await position(2);assert.equal(await input.inputValue(),'a');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
    await saved('multiline',{position:2,draft:'a'});const current=await progress('multiline');
    assert.deepEqual(current.completed,[0,1]);assert.equal(current.draft,'a');
    assert.deepEqual(current.translations,fixture('multiline').segments.map(s=>s.translation));
  });
  await check('restart preserves the multiline completion and the following exact draft',async()=>{
    const before=await progress('multiline');await close();await launch();await position(2);
    assert.equal(await page.locator('#typing-input').inputValue(),'a');assert.deepEqual(await progress('multiline'),before);
  });
  await check('restored same-length punctuation mismatch waits for correction then advances once',async()=>{
    await select('restored-punctuation');const input=page.locator('#typing-input');
    await position(0);assert.equal(await input.inputValue(),fixture('restored-punctuation').draft);
    assert.equal(await page.locator('.story-passage.is-active .target-char.wrong').count(),1);
    assert.deepEqual((await progress('restored-punctuation')).completed,[]);
    await page.locator('#typing-correction').waitFor({state:'visible'});
    await page.locator('#first-error').click();
    assert.equal(await input.inputValue(),fixture('restored-punctuation').draft,'Finding an error must not silently correct the saved input');
    assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),[12,13]);
    await input.pressSequentially('.');
    await position(1);assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
    assert.equal(await page.locator('#typing-error-text').textContent(),'','Clean input must not describe an old error to assistive technology');
    assert.equal(await page.locator('#first-error').getAttribute('data-offset'),null);
    await saved();assert.deepEqual((await progress('restored-punctuation')).completed,[0]);
  });
  await check('a restored newline replaced with another character can be repaired without resetting',async()=>{
    await select('restored-newline');const input=page.locator('#typing-input');
    await position(0);assert.equal(await input.inputValue(),fixture('restored-newline').draft);
    assert.equal(await page.locator('.story-passage.is-active .target-char.wrong').count(),1);
    await page.locator('#typing-correction').waitFor({state:'visible'});
    assert.ok((await page.locator('#typing-error-text').textContent()).length>0);
    const before=await progress('restored-newline');
    const offset='First line.'.length;await page.locator('#first-error').click();
    assert.equal(await input.inputValue(),fixture('restored-newline').draft);
    assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),[offset,offset+1]);
    assert.deepEqual(await progress('restored-newline'),before);
    await input.press('Enter');
    await position(1);assert.equal(await input.inputValue(),'');await saved();
    const current=await progress('restored-newline');assert.deepEqual(current.completed,[0]);
    assert.equal(current.translations[0],'First line.\nSecond line.');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
  });
  await check('space mismatches remain significant and correcting a middle character completes uppercase input',async()=>{
    await select('restored-space');await position(0);
    assert.equal(await page.locator('.story-passage.is-active .target-char.wrong').count(),1);
    assert.deepEqual((await progress('restored-space')).completed,[]);
    await selectInput(6,7);await page.locator('#typing-input').pressSequentially(' ');
    await position(1);await saved();assert.deepEqual((await progress('restored-space')).completed,[0]);
  });
  await check('required Tab can be typed while Shift+Tab still navigates out of the input',async()=>{
    await select('tab');const input=page.locator('#typing-input');await input.click();
    await input.pressSequentially('nAME');await input.press('Shift+Tab');
    assert.notEqual(await page.evaluate(()=>document.activeElement.id),'typing-input');
    assert.equal(await input.inputValue(),'nAME');
    await input.focus();await input.press('End');await input.press('Tab');
    assert.equal(await input.inputValue(),'nAME\t');
    assert.equal(await page.locator('#translation-text .target-char.tab').count(),1);
    assert.equal(await page.locator('#translation-text').textContent(),'Name\tValue.');
    await input.pressSequentially('vALUE.');await position(1);await saved();
    assert.deepEqual((await progress('tab')).completed,[0]);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
  });
  await check('first-error uses UTF16 selection offsets after an astral character',async()=>{
    await select('unicode-offset');const input=page.locator('#typing-input');await page.locator('#first-error').click();
    const offset=fixture('unicode-offset').draft.length-1;
    assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),[offset,offset+1]);
    assert.equal(await input.inputValue(),fixture('unicode-offset').draft);
    await input.pressSequentially('.');await position(1);await saved();
    assert.deepEqual((await progress('unicode-offset')).completed,[0]);
  });
  await check('first-error selects the complete astral character without splitting its surrogate pair',async()=>{
    await select('unicode-length');const input=page.locator('#typing-input');await page.locator('#first-error').click();
    assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),[2,4]);
    assert.equal(await input.inputValue(),fixture('unicode-length').draft);
    await input.pressSequentially('🌟');await position(1);await saved();
    assert.deepEqual((await progress('unicode-length')).completed,[0]);
  });
  await check('an omitted newline can be inserted before the next letter without losing the existing draft',async()=>{
    await select('omitted-newline');const input=page.locator('#typing-input');await page.locator('#first-error').click();
    assert.equal(await input.inputValue(),fixture('omitted-newline').draft);
    const offset='First line.'.length;
    assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),[offset,offset+1]);
    await input.press('ArrowLeft');await input.press('Enter');await position(1);await saved();
    assert.deepEqual((await progress('omitted-newline')).completed,[0]);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
  });
  await check('no provider requests or renderer errors occur',async()=>{
    report.providerRequests=totalRequests+await app.evaluate(()=>multilineProviderCalls);
    assert.equal(report.providerRequests,0);assert.deepEqual(report.errors,[]);
  });
  report.passed=true;console.log(JSON.stringify({passed:report.checks.length,providerRequests:report.providerRequests}));
}finally{
  if(app)await close().catch(()=>{});
  fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,packagedExe?'multiline-typing-packaged-tests.json':'multiline-typing-tests.json'),JSON.stringify(report,null,2));
}})().catch(error=>{console.error(error);process.exitCode=1;});
