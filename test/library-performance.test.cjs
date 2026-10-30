'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Library}=require('../app/library.cjs');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-journal-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,library:new Library(dir)};}
function large(library){const data=library.exportData();data.books[0].segments=Array.from({length:8000},()=>({source:'合成测试。'.repeat(45),translation:''}));data.books[0].segments[0].translation='Synthetic.';library.importData(data);return data.books[0].id;}
test('typing saves and translations persist small changes without rewriting a large novel',t=>{
  const {dir,library}=setup(t);const id=large(library);
  library.saveProgress({bookId:id,position:0,draft:'S'});
  const original=fs.readFileSync(path.join(dir,'library.json'));
  let written=0;const write=fs.writeSync;const writeFile=fs.writeFileSync;
  t.mock.method(fs,'writeSync',function(fd,data,...args){written+=typeof data==='string'?Buffer.byteLength(data):data.byteLength;return write.call(this,fd,data,...args);});
  t.mock.method(fs,'writeFileSync',function(file,data,...args){written+=typeof data==='string'?Buffer.byteLength(data):data.byteLength;return writeFile.call(this,file,data,...args);});
  const progress=library.saveProgress({bookId:id,position:0,draft:'Sy'});
  const translation=library.setTranslation({bookId:id,index:1,translation:'Next.'});
  assert.equal(progress.bookId,id);assert.equal(progress.draft,'Sy');assert.equal('books' in progress,false);assert.equal('books' in translation,false);
  assert.ok(written<100000,`small changes wrote ${written} bytes`);
  assert.deepEqual(fs.readFileSync(path.join(dir,'library.json')),original);
  const reopened=new Library(dir);assert.equal(reopened.getState().books[0].draft,'Sy');assert.equal(reopened.getSegment(id,1).translation,'Next.');
});
test('unchanged draft, translation, and book selection do not write any file',t=>{
  const {library}=setup(t);const book=library.getState().books[0];let writes=0;
  for(const name of ['writeFileSync','writeSync','copyFileSync','renameSync']){const original=fs[name];t.mock.method(fs,name,function(...args){writes++;return original.apply(this,args);});}
  library.saveProgress({bookId:book.id,position:0,draft:''});library.setTranslation({bookId:book.id,index:0,translation:book.segments[0].translation});library.selectBook(book.id);
  assert.equal(writes,0);
});
test('crash after a partial final write keeps all acknowledged progress and accepts later saves',t=>{
  const {dir,library}=setup(t);const id=library.getState().activeBookId;library.saveProgress({bookId:id,position:0,draft:'Saved'});
  const journal=path.join(dir,'library.journal.jsonl');assert.ok(fs.existsSync(journal));fs.appendFileSync(journal,'{"incomplete":');
  const reopened=new Library(dir);assert.equal(reopened.getState().books[0].draft,'Saved');
  reopened.saveProgress({bookId:id,position:1,draft:'After restart'});assert.equal(new Library(dir).getState().books[0].draft,'After restart');
  assert.ok(fs.readdirSync(dir).some(f=>f.startsWith('library.journal.corrupt-')));
});
test('invalid complete journal records fail closed and preserve evidence',t=>{
  const {dir,library}=setup(t);const id=library.getState().activeBookId;library.saveProgress({bookId:id,position:0,draft:'Saved'});
  const journal=path.join(dir,'library.journal.jsonl');fs.appendFileSync(journal,'{"invalid":true}\n');const bytes=fs.readFileSync(journal);
  assert.throws(()=>new Library(dir),/日志|恢复|损坏/);assert.deepEqual(fs.readFileSync(journal),bytes);
});
test('write failure rolls back journal bytes and preserves memory until an explicit retry',t=>{
  const {dir,library}=setup(t);const id=library.getState().activeBookId;library.saveProgress({bookId:id,position:0,draft:'Saved'});
  const journal=path.join(dir,'library.journal.jsonl');const before=fs.readFileSync(journal);const original=fs.writeSync;let failed=false;
  const mocked=t.mock.method(fs,'writeSync',function(fd,data,...args){if(!failed&&typeof data==='string'&&data.includes('Not yet')){failed=true;original.call(this,fd,data.slice(0,12),...args);throw new Error('synthetic partial write');}return original.call(this,fd,data,...args);});
  assert.throws(()=>library.saveProgress({bookId:id,position:0,draft:'Not yet'}),/保存失败/);
  assert.equal(library.getState().books[0].draft,'Saved');assert.deepEqual(fs.readFileSync(journal),before);mocked.mock.restore();
  library.saveProgress({bookId:id,position:0,draft:'Not yet'});assert.equal(new Library(dir).getState().books[0].draft,'Not yet');
});
test('restore to the original snapshot cannot replay old progress or translations',t=>{
  const {dir,library}=setup(t);const original=library.exportData();const id=original.activeBookId;
  library.saveProgress({bookId:id,position:1,draft:'Discard on restore'});library.setTranslation({bookId:id,index:2,translation:'Discard this translation.'});library.importData(original);
  assert.deepEqual(new Library(dir).exportData(),original);
});
test('corrupt primary and old backup still recover journal-backed acknowledged books',t=>{
  const {dir,library}=setup(t);const state=library.importText({title:'新本',text:'新内容。'});const id=state.activeBookId;
  library.setTranslation({bookId:id,index:0,translation:'New.'});library.saveProgress({bookId:id,position:0,draft:'Ne'});const expected=library.exportData();
  fs.writeFileSync(path.join(dir,'library.json'),'{broken');
  assert.deepEqual(new Library(dir).exportData(),expected);
});
test('accumulated statistics cannot exceed format bounds on the hot save path',t=>{
  const {library}=setup(t);const data=library.exportData();data.books[0].stats.sessions=1000000000;library.importData(data);
  const before=library.exportData();assert.throws(()=>library.saveProgress({bookId:data.activeBookId,position:0,draft:'Done',completed:0,session:{characters:1,seconds:1,wpm:12,accuracy:100}}),/统计|限制|备份/);assert.deepEqual(library.exportData(),before);
});
for(const phase of ['backup','primary','journal-removal']) test(`interrupted checkpoint at ${phase} preserves acknowledged state and does not import the rejected book`,t=>{
  const {dir,library}=setup(t);const id=library.getState().activeBookId;library.saveProgress({bookId:id,position:1,draft:'Durable before import'});const expected=library.exportData();
  if(phase==='journal-removal'){
    const original=fs.unlinkSync;t.mock.method(fs,'unlinkSync',function(file){if(file===path.join(dir,'library.journal.jsonl'))throw new Error('interrupted removal');return original.call(this,file);});
  }else{
    const original=fs.renameSync;const destination=path.join(dir,phase==='backup'?'library.json.bak':'library.json');
    t.mock.method(fs,'renameSync',function(from,to){if(to===destination)throw new Error('interrupted snapshot');return original.call(this,from,to);});
  }
  assert.throws(()=>library.importText({title:'Should not import',text:'新书正文。'}),/保存失败/);assert.deepEqual(library.exportData(),expected);t.mock.restoreAll();
  const reopened=new Library(dir);assert.deepEqual(reopened.exportData(),expected);reopened.saveProgress({bookId:id,position:1,draft:'After recovery'});assert.equal(new Library(dir).getState().books[0].draft,'After recovery');
});
test('a failed rollback locks further writes until restart repairs the incomplete tail',t=>{
  const {dir,library}=setup(t);const id=library.getState().activeBookId;library.saveProgress({bookId:id,position:0,draft:'Committed'});
  const write=fs.writeSync;t.mock.method(fs,'writeSync',function(fd,data,...args){write.call(this,fd,data.slice(0,10),...args);throw new Error('partial');});
  t.mock.method(fs,'ftruncateSync',()=>{throw new Error('rollback unavailable');});
  assert.throws(()=>library.saveProgress({bookId:id,position:0,draft:'Failed'}),/保存失败/);assert.throws(()=>library.saveProgress({bookId:id,position:0,draft:'Do not append'}),/重启/);assert.equal(library.getState().books[0].draft,'Committed');t.mock.restoreAll();
  const reopened=new Library(dir);assert.equal(reopened.getState().books[0].draft,'Committed');reopened.saveProgress({bookId:id,position:0,draft:'Recovered'});assert.equal(new Library(dir).getState().books[0].draft,'Recovered');
});
test('bounded journal compaction keeps exported v1 content and latest progress across restart',t=>{
  const {dir,library}=setup(t);const id=library.getState().activeBookId;let last;
  for(let i=0;i<225;i++){last=String(i).padStart(3,'0')+'x'.repeat(9900);library.saveProgress({bookId:id,position:0,draft:last});}
  assert.ok(fs.statSync(path.join(dir,'library.journal.jsonl')).size<=2*1024*1024);
  assert.equal(new Library(dir).getState().books[0].draft,last);assert.equal(library.exportData().version,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'library.json'),'utf8')).version,1);
  const expected=library.exportData();fs.writeFileSync(path.join(dir,'library.json'),'{broken');assert.deepEqual(new Library(dir).exportData(),expected);
});
test('an uncertain failed write cannot acknowledge even a no-op mutation until restart',t=>{
  const {library}=setup(t);const id=library.getState().activeBookId;library.saveProgress({bookId:id,position:0,draft:'A'});
  t.mock.method(fs,'fsyncSync',()=>{throw new Error('flush unavailable');});t.mock.method(fs,'ftruncateSync',()=>{throw new Error('rollback unavailable');});
  assert.throws(()=>library.saveProgress({bookId:id,position:0,draft:'B'}),/保存失败/);t.mock.restoreAll();
  const current=library.exportData();
  for(const mutate of [()=>library.saveProgress({bookId:id,position:0,draft:'A'}),()=>library.setTranslation({bookId:id,index:0,translation:current.books[0].segments[0].translation}),()=>library.selectBook(id),()=>library.importData(current),()=>library.importText({title:'Should not write',text:'正文。'})]) assert.throws(mutate,/重启/);
  assert.deepEqual(library.exportData(),current);
});
test('failure closing a committed journal descriptor also locks no-op acknowledgements',t=>{
  const {library}=setup(t);const id=library.getState().activeBookId;library.saveProgress({bookId:id,position:0,draft:'A'});
  const close=fs.closeSync;let failed=false;t.mock.method(fs,'closeSync',function(fd){close.call(this,fd);if(!failed){failed=true;throw new Error('close result uncertain');}});
  assert.throws(()=>library.saveProgress({bookId:id,position:0,draft:'B'}));t.mock.restoreAll();
  assert.equal(library.getState().books[0].draft,'A');assert.throws(()=>library.saveProgress({bookId:id,position:0,draft:'A'}),/重启/);
});
