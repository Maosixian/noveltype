'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const {CloudWorkspace}=require('../app/cloud-workspace.cjs');
const {createService}=require('../server/service.cjs');
const cipher={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from([...s].reverse().join('')),decryptString:b=>[...b.toString()].reverse().join('')};
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-workspace-'));
 const service=createService({directory:path.join(root,'server'),masterKey:randomBytes(32),allowedBaseUrls:['https://api.example.test/v1']});
 await service.store.createUser({username:'workspace-a',password:'fixture-password-a',role:'admin'});
 await service.store.createUser({username:'workspace-b',password:'fixture-password-b',role:'user'});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const serverUrl=`http://127.0.0.1:${service.server.address().port}`;
 const workspace=(name,options={})=>{const w=new CloudWorkspace({directory:path.join(root,name),cipher,onSwitch:()=>{},allowHttpForTests:true,...options});w.open();return w;};
 const login=w=>w.login({serverUrl,username:'workspace-a',password:'fixture-password-a'});
 t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,service,serverUrl,workspace,login};
}

test('initial login migrates merged journal state and second machine hydrates novels, drafts, translations, and games',async t=>{
 const f=await fixture(t),a=f.workspace('one');
 a.library.importText({title:'Only fixture novel',text:'山。海。'});const book=a.library.state.books.at(-1);
 a.library.setTranslation({bookId:book.id,index:0,translation:'Mountain. Sea.'});
 const alignment={version:1,spans:[{englishStart:0,englishEnd:14,sourceStart:0,sourceEnd:4}]};
 a.cache.set('山。海。','Mountain. Sea.',alignment);
 a.library.saveProgress({bookId:book.id,position:0,draft:'mountain'});
 a.games.save({bookId:book.id,runId:'fixture-run',mode:'defense',levelId:null,passageId:null,stars:0,score:20,seconds:2,accuracy:100,wpm:0,won:false});
 a.games.save({bookId:'sample',runId:'fixture-sample-run',mode:'defense',levelId:null,passageId:null,stars:0,score:30,seconds:2,accuracy:100,wpm:0,won:false});
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'one','library.json'))).books.at(-1).draft,'');
 await f.login(a);const b=f.workspace('two');await f.login(b);
 assert.equal(b.library._book(book.id).draft,'mountain');assert.equal(b.library.getSegment(book.id,0).translation,'Mountain. Sea.');
 assert.equal(b.games.get(book.id).recent[0].score,20);
 assert.equal(b.games.get('sample').recent[0].score,30);
 assert.deepEqual(b.cache.get('山。海。','Mountain. Sea.'),alignment);
 assert.equal(a.client.public().pending,0);
});

test('incremental saves survive restart and sync without rewriting a large local book snapshot',async t=>{
 const f=await fixture(t),a=f.workspace('one');a.library.importText({title:'Large synthetic only',text:'山间有光。'.repeat(30000)});
 const book=a.library.state.books.at(-1);await f.login(a);
 const snapshot=fs.readFileSync(path.join(a.directory(),'library.json'));
 a.changed('progress',book.id,()=>a.library.saveProgress({bookId:book.id,position:2,draft:'local draft'}));
 const restarted=f.workspace('one');assert.equal(restarted.client.public().pending,1);
 await restarted.sync({apply:true});
 assert.deepEqual(fs.readFileSync(path.join(restarted.directory(),'library.json')),snapshot);
 const b=f.workspace('two');await f.login(b);assert.equal(b.library._book(book.id).draft,'local draft');assert.equal(b.library._book(book.id).position,2);
});

test('stale offline progress remains a visible conflict until user chooses remote',async t=>{
 const f=await fixture(t),a=f.workspace('one');await f.login(a);const b=f.workspace('two');await f.login(b);const id=a.library.state.activeBookId;
 b.changed('progress',id,()=>b.library.saveProgress({bookId:id,position:0,draft:'old offline'}));
 a.changed('progress',id,()=>a.library.saveProgress({bookId:id,position:0,draft:'new online'}));await a.sync();await b.sync({apply:true});
 assert.equal(b.library._book(id).draft,'old offline');assert.equal(b.status().conflicts.length,1);
 b.resolve({mutationId:b.status().conflicts[0].mutationId,choice:'remote'});await b.sync({apply:true});
 assert.equal(b.library._book(id).draft,'new online');
});

test('logout restores untouched local library and direct account switch never copies private novels',async t=>{
 const f=await fixture(t),a=f.workspace('one');a.library.importText({title:'Private account A',text:'甲的小说。'});const id=a.library.state.activeBookId;
 const local=fs.readFileSync(path.join(f.root,'one','library.json'));await f.login(a);
 await a.login({serverUrl:f.serverUrl,username:'workspace-b',password:'fixture-password-b'});
 assert.equal(a.library.state.books.some(book=>book.id===id),false);
 await a.logout();assert.equal(a.status().loggedIn,false);assert.equal(a.library.state.books.some(book=>book.id===id),true);
 assert.deepEqual(fs.readFileSync(path.join(f.root,'one','library.json')),local);
});

test('dirty marker recovers acknowledged local journal changes before next sync',async t=>{
 const f=await fixture(t),a=f.workspace('one');await f.login(a);const id=a.library.state.activeBookId;
 a.mark('progress',id);a.library.saveProgress({bookId:id,position:0,draft:'recovered after crash'});
 const restarted=f.workspace('one');assert.equal(restarted.client.public().pending,1);await restarted.sync();
 const b=f.workspace('two');await f.login(b);assert.equal(b.library._book(id).draft,'recovered after crash');
});

test('background pull cannot promote an unapplied remote revision into the baseline of a later local edit',async t=>{
 const f=await fixture(t),a=f.workspace('one');await f.login(a);const b=f.workspace('two');await f.login(b);const id=a.library.state.activeBookId;
 a.changed('progress',id,()=>a.library.saveProgress({bookId:id,position:0,draft:'remote new draft'}));await a.sync();
 await b.sync();assert.equal(b.library._book(id).draft,'');assert.equal(b.client.getEntity('progress',id).value.draft,'remote new draft');
 b.changed('progress',id,()=>b.library.saveProgress({bookId:id,position:0,draft:'later local draft'}));await b.sync();
 assert.equal(b.status().conflicts.length,1);assert.equal(b.client.getEntity('progress',id).value.draft,'remote new draft');
});

test('import publishes only the new book and selection, preserving cached remote progress for existing books',async t=>{
 const f=await fixture(t),a=f.workspace('one');await f.login(a);const b=f.workspace('two');await f.login(b);const oldId=a.library.state.activeBookId;
 a.changed('progress',oldId,()=>a.library.saveProgress({bookId:oldId,position:0,draft:'remote wins'}));await a.sync();await b.sync();
 b.library.importText({title:'Another new book',text:'新书。'});const newId=b.library.state.activeBookId;b.publishBook(newId);
 assert.ok(b.client.outbox().every(op=>op.key===newId||op.key.startsWith(newId+':')||op.kind==='selection'));
 await b.sync();assert.equal(b.client.getEntity('progress',oldId).value.draft,'remote wins');
});

test('failed login synchronization restores the original account and library while preserving candidate cache',async t=>{
 const f=await fixture(t);let failSync=false;
 const a=f.workspace('one',{fetchImpl:(url,options)=>{if(failSync&&url.endsWith('/v1/sync'))throw Error('simulated network failure');return fetch(url,options);}});
 a.library.importText({title:'Account A private',text:'仅限甲。'});const id=a.library.state.activeBookId;await f.login(a);
 const previousDirectory=a.directory();failSync=true;
 await assert.rejects(a.login({serverUrl:f.serverUrl,username:'workspace-b',password:'fixture-password-b'}));
 assert.equal(a.status().user.username,'workspace-a');assert.equal(a.directory(),previousDirectory);assert.equal(a.library.state.activeBookId,id);
 const reopened=f.workspace('one');assert.equal(reopened.status().user.username,'workspace-a');assert.equal(reopened.library.state.activeBookId,id);
 assert.equal(fs.readdirSync(path.join(f.root,'one','cloud-account','accounts')).length,2);
});
