'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {createService}=require('../server/service.cjs');
const book={id:'book-one',title:'测试故事',demo:false,segmentCount:1};
const chunk={bookId:book.id,start:0,segments:[{source:'光。',translation:''}]};
const mutation=(kind,key,value,id=crypto.randomUUID(),baseRevision=0)=>({mutationId:id,kind,key,baseRevision,value});
async function fixture(t,options={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-server-'));
  const masterKey=randomBytes(32);const service=createService({directory,masterKey,allowedBaseUrls:['https://api.example.test/v1'],...options});
  await service.store.createUser({username:'alice',password:'test-password-a',role:'admin'});
  await service.store.createUser({username:'bob',password:'test-password-b',role:'user'});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const call=async(route,body,token,method=body?'POST':'GET')=>{const res=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
  const alice=(await call('/v1/auth/login',{username:'alice',password:'test-password-a'})).data.token;
  const bob=(await call('/v1/auth/login',{username:'bob',password:'test-password-b'})).data.token;
  t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true});});
  const sync=(mutations,token=alice,cursor=0,limit=50)=>call('/v1/sync',{deviceId:'test-device',cursor,mutations,limit},token);
  return {service,directory,masterKey,call,alice,bob,sync};
}
test('accounts authenticate, isolate tenants, revoke sessions, and never store plaintext credentials',async t=>{
  const f=await fixture(t);assert.equal((await f.call('/v1/auth/me',null)).status,401);
  assert.equal((await f.call('/v1/auth/login',{username:'alice',password:'bad'})).status,401);
  assert.equal((await f.call('/v1/auth/me',null,f.alice)).data.user.username,'alice');
  await f.sync([mutation('book',book.id,book)]);
  assert.equal((await f.sync([],f.bob)).data.changes.length,0);
  assert.equal((await f.call('/v1/settings',{provider:'custom',baseUrl:'https://api.example.test/v1',model:'test',apiKey:'secret-provider-key'},f.bob,'PUT')).status,403);
  assert.equal((await f.call('/v1/auth/logout',{},f.alice)).status,200);
  assert.equal((await f.call('/v1/auth/me',null,f.alice)).status,401);
  const dump=Buffer.concat(fs.readdirSync(f.directory).filter(n=>n.startsWith('cloud.sqlite')).map(n=>fs.readFileSync(path.join(f.directory,n)))).toString();
  assert.ok(!dump.includes('test-password-a'));assert.ok(!dump.includes(f.alice));
});
test('transactional sync is permanently idempotent, CAS conflicts retain authoritative values, and pagination advances',async t=>{
  const f=await fixture(t);const initial=mutation('book',book.id,book,'initial');
  let r=await f.sync([initial]);assert.equal(r.status,200);assert.deepEqual(r.data.acknowledged,['initial']);assert.equal(r.data.accepted[0].mutationId,'initial');
  const revision=r.data.changes[0].revision;
  r=await f.sync([initial]);assert.deepEqual(r.data.acknowledged,['initial']);assert.equal(r.data.changes[0].revision,revision);
  assert.equal((await f.sync([{...initial,value:{...book,title:'changed'}}])).status,409);
  r=await f.sync([mutation('book',book.id,{...book,title:'stale'},'stale')]);assert.equal(r.data.conflicts.length,1);assert.equal(r.data.conflicts[0].current.value.title,book.title);
  r=await f.sync([mutation('chunk',`${book.id}:0`,chunk),mutation('selection','active',{bookId:book.id})],f.alice,0,1);assert.equal(r.data.changes.length,1);assert.equal(r.data.hasMore,true);
  const next=await f.sync([],f.alice,r.data.cursor,1);assert.ok(next.data.cursor>r.data.cursor);assert.equal(next.data.changes.length,1);
});
test('validation rolls back whole mutation batch and blocks source replacement or oversized entities',async t=>{
  const f=await fixture(t);const r=await f.sync([mutation('book',book.id,book),mutation('chunk',`${book.id}:0`,{...chunk,start:-1})]);assert.equal(r.status,400);assert.equal((await f.sync([])).data.changes.length,0);
  await f.sync([mutation('book',book.id,book),mutation('chunk',`${book.id}:0`,chunk)]);
  const entity=(await f.sync([])).data.changes.find(e=>e.kind==='chunk');
  assert.equal((await f.sync([mutation('chunk',`${book.id}:0`,{...chunk,segments:[{source:'别的。',translation:''}]},'changed-source',entity.revision)])).status,409);
  assert.equal((await f.sync([mutation('progress',book.id,{position:999,draft:'',completed:[],stats:{sessions:0,characters:0,seconds:0}})])).status,400);
});
test('provider secrets are encrypted, public settings are redacted and endpoint changes require replacement key',async t=>{
  const f=await fixture(t);let r=await f.call('/v1/settings',{provider:'custom',baseUrl:'https://api.example.test/v1',model:'test',apiKey:'secret-provider-key'},f.alice,'PUT');assert.equal(r.status,200);assert.equal(r.data.hasKey,true);assert.ok(!JSON.stringify(r.data).includes('secret-provider-key'));
  assert.equal((await f.call('/v1/settings',{provider:'custom',baseUrl:'https://127.0.0.1/v1',model:'test',apiKey:'key'},f.alice,'PUT')).status,400);
  const dump=Buffer.concat(fs.readdirSync(f.directory).filter(n=>n.startsWith('cloud.sqlite')).map(n=>fs.readFileSync(path.join(f.directory,n)))).toString();assert.ok(!dump.includes('secret-provider-key'));
});
test('remote preparation coalesces simultaneous devices and persists translation and semantic alignment without retry',async t=>{
  let calls=0;const fetchImpl=async()=>{calls++;await new Promise(r=>setTimeout(r,25));return {ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translation:'Light.',groups:[{english:'Light.',chinese:'光。',occurrence:0}]})}}]})};};
  const f=await fixture(t,{fetchImpl});await f.sync([mutation('book',book.id,book),mutation('chunk',`${book.id}:0`,chunk)]);
  await f.call('/v1/settings',{provider:'custom',baseUrl:'https://api.example.test/v1',model:'test',apiKey:'fake-key'},f.alice,'PUT');
  const [a,b]=await Promise.all(['request-one','request-two'].map(requestId=>f.call('/v1/prepare',{bookId:book.id,index:0,requestId},f.alice)));
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(calls,1);assert.equal(a.data.translation,'Light.');
  assert.equal((await f.call('/v1/prepare',{bookId:book.id,index:0,requestId:'request-one'},f.alice)).status,200);assert.equal(calls,1);
  const changes=(await f.sync([])).data.changes;assert.equal(changes.find(e=>e.kind==='alignment').value.translation,'Light.');
  assert.equal(changes.filter(e=>e.kind==='chunk').at(-1).value.segments[0].translation,'Light.');
});
test('failed provider request is not retried by reusing requestId and errors never disclose provider body',async t=>{
  let calls=0;const f=await fixture(t,{fetchImpl:async()=>{calls++;throw Error('sensitive-key-in-provider-error');}});
  await f.sync([mutation('book',book.id,book),mutation('chunk',`${book.id}:0`,chunk)]);
  await f.call('/v1/settings',{provider:'custom',baseUrl:'https://api.example.test/v1',model:'test',apiKey:'fake-key'},f.alice,'PUT');
  for(let i=0;i<2;i++){const r=await f.call('/v1/prepare',{bookId:book.id,index:0,requestId:'failed-request'},f.alice);assert.equal(r.status,409);assert.ok(!JSON.stringify(r.data).includes('sensitive'));}
  assert.equal(calls,1);
});
test('server restart preserves sessions, settings, changes and dedup; abandoned job remains stopped',async t=>{
  const f=await fixture(t);const m=mutation('book',book.id,book,'durable');
  await f.sync([m,mutation('chunk',`${book.id}:0`,chunk)]);
  await f.call('/v1/settings',{provider:'custom',baseUrl:'https://api.example.test/v1',model:'test',apiKey:'persisted-private-value'},f.alice,'PUT');
  const user=f.service.store.authenticate(f.alice);
  f.service.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,NULL)').run(user.id,'interrupted',book.id,0,'running');
  await f.service.close();
  const resumed=createService({directory:f.directory,masterKey:f.masterKey,allowedBaseUrls:['https://api.example.test/v1'],fetchImpl:()=>{throw Error('must not request');}});
  try{
    assert.equal(resumed.store.authenticate(f.alice).username,'alice');
    assert.equal(resumed.store.settings(user.id,true).apiKey,'persisted-private-value');
    assert.deepEqual(resumed.store.sync(user.id,{deviceId:'other-device',cursor:0,limit:10,mutations:[m]}).acknowledged,['durable']);
    await assert.rejects(()=>resumed.prepare(user,{bookId:book.id,index:0,requestId:'interrupted'}),e=>e.code==='TRANSLATION_STOPPED');
  }finally{await resumed.close();}
});
test('expired sessions fail closed and untrusted browser origins are rejected',async t=>{
  let now=1800000000000;const f=await fixture(t,{clock:()=>now});
  now+=8*86400000;
  assert.equal((await f.call('/v1/auth/me',null,f.alice)).status,401);
  const origin=await fetch(`http://127.0.0.1:${f.service.server.address().port}/health`,{headers:{Origin:'https://untrusted.example'}});
  assert.equal(origin.status,403);
});
test('only the configured socket peer can supply a client IP for rate limiting',async t=>{
  for(const trusted of [false,true]){
    const f=await fixture(t,{trustedProxy:trusted?'127.0.0.1':'192.0.2.99'});
    let status;
    for(let i=0;i<31;i++){
      const response=await fetch(`http://127.0.0.1:${f.service.server.address().port}/v1/auth/login`,{method:'POST',headers:{'content-type':'application/json','x-noveltype-client-ip':`192.0.2.${i+1}`},body:JSON.stringify({username:`test-${i}-${'a'.repeat(50)}`,password:'invalid-test'})});
      status=response.status;await response.json();
    }
    assert.equal(status,trusted?400:429);
  }
});
test('built-in sample game progress syncs without creating a fake library book',async t=>{
  const f=await fixture(t);const game={levels:{'1':{stars:2,score:20,seconds:20,accuracy:98}},bestRaces:{},recent:[]};
  assert.equal((await f.sync([mutation('games','sample',game)])).status,200);
  const changes=(await f.sync([])).data.changes;assert.equal(changes.length,1);assert.equal(changes[0].kind,'games');assert.equal(changes[0].key,'sample');
  assert.equal((await f.sync([mutation('games','missing-book',game)])).status,400);
});

test('account quota accepts content above 128 MiB up to 256 MiB and rejects growth without losing acknowledged data',async t=>{
  const f=await fixture(t),store=f.service.store,user=store.authenticate(f.alice),limit=256*1024*1024;
  // Simulate prior accounted content without allocating a huge test database.
  const setUsage=bytes=>store.db.prepare('INSERT OR REPLACE INTO usage VALUES(?,?)').run(user.id,bytes);
  const usage=()=>store.db.prepare('SELECT bytes FROM usage WHERE user_id=?').get(user.id).bytes;
  const bytes=value=>Buffer.byteLength(JSON.stringify(value));
  setUsage(128*1024*1024+1);
  let response=await f.sync([mutation('book',book.id,book)]);
  assert.equal(response.status,200);assert.equal(usage(),128*1024*1024+1+bytes(book));
  const second={...book,id:'second-book',title:'Synthetic quota boundary'};
  setUsage(limit-bytes(second));
  response=await f.sync([mutation('book',second.id,second)]);
  assert.equal(response.status,200);assert.equal(usage(),limit);
  const saved=store.entity(user.id,'book',second.id);
  response=await f.sync([mutation('book',second.id,second,crypto.randomUUID(),saved.revision)]);
  assert.equal(response.status,200);assert.equal(usage(),limit,'Replacing equal content does not double-count it');
  const before=store.entity(user.id,'book',second.id),mutations=store.db.prepare('SELECT COUNT(*) n FROM mutations WHERE user_id=?').get(user.id).n;
  response=await f.sync([mutation('book',second.id,{...second,title:second.title+'x'},crypto.randomUUID(),before.revision)]);
  assert.equal(response.status,413);assert.equal(response.data.code,'ACCOUNT_QUOTA');
  assert.match(response.data.error,/256 MB/);assert.deepEqual(store.entity(user.id,'book',second.id),before);assert.equal(usage(),limit);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM mutations WHERE user_id=?').get(user.id).n,mutations);
  response=await f.sync([mutation('book',second.id,{...second,title:'x'},crypto.randomUUID(),before.revision)]);
  assert.equal(response.status,200);assert.equal(usage(),limit-bytes(second)+bytes({...second,title:'x'}));
  assert.equal((await f.sync([mutation('book',book.id,book)],f.bob)).status,200,'Another account keeps its independent quota');
});
