const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const tempRoot=path.resolve(os.tmpdir());
const data=fs.mkdtempSync(path.join(tempRoot,'noveltype-packaged-test-'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NOVELTYPE_TEST_DATA;
(async()=>{let app;try{
  const executablePath=process.env.NOVELTYPE_PACKAGED_EXE||path.join(root,'dist/win-unpacked/NovelType.exe');
  // Electron applies this native switch before app code and the single-instance lock.
  // Do not add a packaged-app environment override or launch against a user's profile.
  app=await _electron.launch({executablePath,args:[`--user-data-dir=${data}`],env,timeout:30000});
  const paths=await app.evaluate(({app})=>({userData:app.getPath('userData'),sessionData:app.getPath('sessionData')}));
  assert.equal(path.resolve(paths.userData).toLowerCase(),path.resolve(data).toLowerCase(),'Packaged test must use its temporary userData directory');
  assert.equal(path.resolve(paths.sessionData).toLowerCase(),path.resolve(data).toLowerCase(),'Browser storage must stay in the temporary profile');
  const page=await app.firstWindow();await page.locator('#book-title').waitFor({state:'visible'});
  await page.locator('#story-stream').waitFor({state:'visible'});
  assert.ok(await page.locator('.story-passage').count()>0);
  assert.equal(await page.locator('#completion-next,#next,#previous').count(),0);
  const state=await page.evaluate(()=>window.novel.getState());
  assert.equal(state.settings.hasKey,false);
  assert.equal(state.books.length,1);assert.equal(state.books[0].demo,true);
  await page.waitForFunction(()=>document.querySelector('#source-text .source-highlight')?.textContent==='清晨');
  await page.locator('#typing-input').click();await page.locator('#typing-input').pressSequentially('at dawn, L');
  await page.waitForFunction(()=>document.querySelector('#source-text .source-highlight')?.textContent==='林舟');
  assert.equal(await page.locator('#source-text').textContent(),state.books[0].segments[0].source);
  assert.equal(await page.locator('.target-char.wrong').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'typing-input');
  assert.equal(fs.existsSync(path.join(data,'library.json')),true);
  const encryption=await app.evaluate(({safeStorage,app})=>({available:safeStorage.isEncryptionAvailable(),packaged:app.isPackaged,version:app.getVersion()}));
  assert.equal(encryption.available,true);assert.equal(encryption.packaged,true);
  assert.equal(encryption.version,require('../package.json').version);
  const typing=await page.evaluate(async()=>{const {TypingSession}=await import('./typing.mjs');const session=new TypingSession('Ab');session.input('aB',0);return {complete:session.complete,accuracy:session.snapshot(0).accuracy};});
  assert.deepEqual(typing,{complete:true,accuracy:100});
  const network={tested:false,reason:'Fresh isolated profile; no API credentials configured or requests sent'};
  fs.mkdirSync(path.join(root,'evidence'),{recursive:true});
  await page.screenshot({path:path.join(root,'evidence/packaged-desktop.png'),fullPage:true});
  fs.writeFileSync(path.join(root,'evidence/packaged-tests.json'),JSON.stringify({at:new Date().toISOString(),launch:true,isolatedUserData:true,continuousUI:true,caseInsensitive:true,chineseHighlight:true,encryption,network,realTranslationVerified:false},null,2));
  console.log(JSON.stringify({packagedLaunch:true,isolatedUserData:true,continuousUI:true,caseInsensitive:true,chineseHighlight:true,encryption,network,realTranslationVerified:false}));
}finally{
  if(app)await app.close();
  const cleanupPath=path.resolve(data);
  assert.equal(path.dirname(cleanupPath),tempRoot,'Only the generated temporary profile can be removed');
  assert.ok(path.basename(cleanupPath).startsWith('noveltype-packaged-test-'));
  fs.rmSync(cleanupPath,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}})().catch(e=>{console.error(e);process.exitCode=1;});
