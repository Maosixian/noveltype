'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {CloudClient}=require('../app/cloud-client.cjs');
const cipher={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from([...s].reverse().join('')),decryptString:b=>[...b.toString()].reverse().join('')};
function setup(t,handler){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-cloud-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(await handler(url,options)),{headers:{'Content-Type':'application/json'}});};return {directory,calls,client:new CloudClient({directory,cipher,fetchImpl}),fetchImpl};}
const user={id:'user-one',username:'tester',role:'admin'};
const login=client=>client.login({serverUrl:'https://sync.example.test',username:'tester',password:'test-password-only'});
const auth={token:'test-token-not-a-real-secret',user};
function reply(mutations=[],changes=[],more=false,cursor=1){return {acknowledged:mutations.map(m=>m.mutationId),accepted:mutations.map(m=>({mutationId:m.mutationId,kind:m.kind,key:m.key,revision:cursor})),conflicts:[],changes,cursor,hasMore:more};}

test('login stores only encrypted token; reload identity is isolated and logout is local even offline',async t=>{let offline=false;const {client,directory,fetchImpl}=setup(t,()=>{if(offline)throw Error('secret network detail');return auth;});await login(client);assert.equal(client.public().user.username,'tester');assert.ok(!JSON.stringify(client.public()).includes(auth.token));assert.ok(!fs.readFileSync(path.join(directory,'cloud-session.json'),'utf8').includes(auth.token));const second=new CloudClient({directory,cipher,fetchImpl});assert.equal(second.accountDirectory(),client.accountDirectory());offline=true;await second.logout();assert.equal(second.public().connected,false);assert.equal(new CloudClient({directory,cipher,fetchImpl}).public().connected,false);});

test('rejects plaintext and credential-bearing endpoints before sending password; fails closed without OS encryption',async t=>{const {client,calls,directory,fetchImpl}=setup(t,()=>auth);for(const serverUrl of ['http://example.test','https://u:p@example.test','https://example.test/?key=x','https://example.test/#x'])await assert.rejects(client.login({serverUrl,username:'tester',password:'example'}));assert.equal(calls.length,0);const locked=new CloudClient({directory,cipher:{isEncryptionAvailable:()=>false},fetchImpl});await assert.rejects(login(locked),/加密/);assert.equal(calls.length,0);});

test('outbox is durable and unattempted updates coalesce without rewriting other entity files',async t=>{const {client,directory,fetchImpl}=setup(t,()=>auth);await login(client);const id=client.enqueue('progress','book-1',{position:1,draft:'a'});assert.equal(client.enqueue('progress','book-1',{position:1,draft:'ab'}),id);client.enqueue('book','book-1',{id:'book-1',title:'Test',demo:false,segmentCount:1});const reopened=new CloudClient({directory,cipher,fetchImpl});assert.equal(reopened.public().pending,2);assert.equal(reopened.hasPending('progress','book-1'),true);assert.equal(reopened.outbox().find(x=>x.kind==='progress').value.draft,'ab');});

test('changes persist before callback; cursor and mutation acknowledgement wait for successful apply and survive restart',async t=>{let syncCalls=0;const {client,directory,fetchImpl}=setup(t,(url,options)=>{if(url.endsWith('/login'))return auth;syncCalls++;const m=JSON.parse(options.body).mutations;return reply(m,[{kind:'book',key:'b',revision:1,value:{id:'b',title:'Book',demo:false,segmentCount:1}}]);});await login(client);client.enqueue('book','b',{id:'b',title:'Book',demo:false,segmentCount:1});await assert.rejects(client.sync(async()=>{assert.equal(client.getEntity('book','b').value.title,'Book');throw Error('disk apply failed');}),/disk apply/);assert.equal(client.public().cursor,0);assert.equal(client.public().pending,1);const reopened=new CloudClient({directory,cipher,fetchImpl});await reopened.sync(async response=>assert.equal(response.changes.length,1));assert.equal(syncCalls,1);assert.equal(reopened.public().pending,0);assert.equal(reopened.public().cursor,1);});

test('an attempted update keeps id and payload; following local changes use only own accepted revision',async t=>{let sent;const {client}=setup(t,(url,options)=>{if(url.endsWith('/login'))return auth;sent=JSON.parse(options.body).mutations;return reply(sent,[],false,7);});await login(client);const first=client.enqueue('progress','b',{position:1,draft:'a'});await client.sync(async()=>client.enqueue('progress','b',{position:1,draft:'ab'}));assert.equal(sent[0].mutationId,first);assert.equal(sent[0].value.draft,'a');const next=client.outbox()[0];assert.notEqual(next.mutationId,first);assert.equal(next.baseRevision,7);assert.equal(next.value.draft,'ab');});

test('CAS conflicts retain local content and require explicit resolution',async t=>{const {client}=setup(t,(url,options)=>{if(url.endsWith('/login'))return auth;const [m]=JSON.parse(options.body).mutations;return {acknowledged:[],accepted:[],conflicts:[{mutationId:m.mutationId,current:{kind:m.kind,key:m.key,revision:4,value:{position:9,draft:'remote'}}}],changes:[],cursor:4,hasMore:false};});await login(client);const id=client.enqueue('progress','b',{position:1,draft:'local'});await client.sync(async()=>{});assert.equal(client.public().conflicts.length,1);assert.equal(client.hasPending('progress','b'),true);const next=client.resolveLocal(id);assert.notEqual(next,id);assert.equal(client.outbox()[0].value.draft,'local');assert.equal(client.outbox()[0].baseRevision,4);});

test('network failures are redacted, never silently retried, and preserve exact mutation for later retry',async t=>{let count=0;const {client}=setup(t,url=>{if(url.endsWith('/login'))return auth;count++;throw Error('Bearer do-not-leak');});await login(client);const id=client.enqueue('progress','b',{position:1,draft:'a'});await assert.rejects(client.sync(async()=>{}),e=>!e.message.includes('do-not-leak'));assert.equal(count,1);assert.equal(client.outbox()[0].mutationId,id);assert.equal(client.outbox()[0].attempted,true);});

test('unknown prepare outcome reuses durable requestId rather than issuing new paid job',async t=>{const ids=[];const {client,directory,fetchImpl}=setup(t,(url,options)=>{if(url.endsWith('/login'))return auth;ids.push(JSON.parse(options.body).requestId);if(ids.length===1)throw Error('lost response');return {translation:'Hello',alignment:{version:1,spans:[]},cached:false};});await login(client);await assert.rejects(client.prepare({bookId:'b',index:1}));const reopened=new CloudClient({directory,cipher,fetchImpl});await reopened.prepare({bookId:'b',index:1});assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);});

test('routine progress enqueue does not reread every pending book chunk',async t=>{const {client}=setup(t,()=>auth);await login(client);for(let i=0;i<30;i++)client.enqueue('chunk',`b:${i}`,{bookId:'b',start:i*128,segments:[{source:'原文',translation:'Example '.repeat(300)}]});const original=fs.readFileSync;let reads=0;fs.readFileSync=function(...args){reads++;return original.apply(this,args);};try{client.enqueue('progress','b',{position:1,draft:'a'});assert.ok(reads<5,`read ${reads} files for one draft`);}finally{fs.readFileSync=original;}});

test('two real clients synchronize through the real server and stale offline cursor cannot overwrite a newer draft',async t=>{
  const {createService}=require('../server/service.cjs');const {randomBytes}=require('node:crypto');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-cloud-integration-'));
  const service=createService({directory:path.join(root,'server'),masterKey:randomBytes(32),allowedBaseUrls:['https://api.example.test/v1']});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  await service.store.createUser({username:'integration',password:'only-a-test-password',role:'admin'});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const serverUrl=`http://127.0.0.1:${service.server.address().port}`;
  const a=new CloudClient({directory:path.join(root,'a'),cipher,allowHttpForTests:true});
  const b=new CloudClient({directory:path.join(root,'b'),cipher,allowHttpForTests:true});
  await a.login({serverUrl,username:'integration',password:'only-a-test-password'});await b.login({serverUrl,username:'integration',password:'only-a-test-password'});
  a.enqueue('book','story',{id:'story',title:'Story',demo:false,segmentCount:1});
  a.enqueue('chunk','story:0',{bookId:'story',start:0,segments:[{source:'光。',translation:'Light.'}]});
  const progress={position:0,draft:'L',completed:[],stats:{sessions:0,characters:0,seconds:0}};
  a.enqueue('progress','story',progress);await a.sync();await b.sync();assert.equal(b.getEntity('progress','story').value.draft,'L');
  b.enqueue('progress','story',{...progress,draft:'Li'});a.enqueue('progress','story',{...progress,draft:'Light'});await a.sync();await b.sync();
  assert.equal(b.public().conflicts.length,1);assert.equal(b.conflicts()[0].value.draft,'Li');assert.equal(b.getEntity('progress','story').value.draft,'Light');
  const remote=b.resolveRemote(b.public().conflicts[0].mutationId);assert.equal(remote.value.draft,'Light');assert.equal(b.public().pending,0);
});
