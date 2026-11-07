'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CloudWorkspace}=require('../app/cloud-workspace.cjs');
const cipher={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
const defaults={provider:'glm',baseUrl:'https://open.bigmodel.cn/api/paas/v4',model:'glm-5.3',hasKey:false};

function fixture(t,fetchImpl){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-cloud-efficiency-'));
 t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('noveltype-cloud-efficiency-'));fs.rmSync(root,{recursive:true,force:true});});
 const workspace=new CloudWorkspace({directory:root,cipher,fetchImpl});workspace.open();
 return {root,workspace};
}
function trackSettingsWrites(t,file){
 const rename=fs.renameSync;const counter={writes:0,fail:false};
 t.mock.method(fs,'renameSync',function(from,to){
  if(path.resolve(to)===path.resolve(file)){if(counter.fail)throw new Error('simulated settings commit failure');counter.writes++;}
  return rename.call(this,from,to);
 });
 return counter;
}

test('default public settings are persisted once and identical saves cause no further disk commits',t=>{
 const {workspace:w}=fixture(t);const writes=trackSettingsWrites(t,w.settingsFile);
 assert.equal(fs.existsSync(w.settingsFile),false);
 for(let i=0;i<5;i++)assert.deepEqual(w.savePublic({...defaults}),defaults);
 assert.deepEqual(JSON.parse(fs.readFileSync(w.settingsFile,'utf8')),defaults);
 assert.equal(writes.writes,1,'five identical saves need only the first durable write');
});

test('changed public settings commit once; failed commits retain old state and retry durably',t=>{
 const {workspace:w}=fixture(t);w.savePublic(defaults);
 const writes=trackSettingsWrites(t,w.settingsFile);const changed={...defaults,model:'fixture-model',hasKey:true};
 writes.fail=true;
 assert.throws(()=>w.savePublic(changed),/simulated settings commit failure/);
 assert.deepEqual(w.settings,defaults);
 assert.deepEqual(JSON.parse(fs.readFileSync(w.settingsFile,'utf8')),defaults);
 writes.fail=false;
 assert.deepEqual(w.savePublic(changed),changed);
 w.savePublic({...changed});
 assert.equal(writes.writes,1);
 assert.deepEqual(JSON.parse(fs.readFileSync(w.settingsFile,'utf8')),changed);
 // Returned public objects must not stand in for the last durable disk value.
 w.settings.model='mutated-public-object';
 w.savePublic({...changed,model:'mutated-public-object'});
 assert.equal(writes.writes,2);
 assert.equal(JSON.parse(fs.readFileSync(w.settingsFile,'utf8')).model,'mutated-public-object');
});

test('failed initial save can retry; reopening skips equal writes and a missing file is recreated',t=>{
 const {root,workspace:w}=fixture(t);const writes=trackSettingsWrites(t,w.settingsFile);
 writes.fail=true;
 assert.throws(()=>w.savePublic(defaults),/simulated settings commit failure/);
 assert.equal(fs.existsSync(w.settingsFile),false);
 writes.fail=false;w.savePublic(defaults);
 const reopened=new CloudWorkspace({directory:root,cipher});reopened.open();reopened.savePublic(defaults);
 assert.equal(writes.writes,1,'reopened durable settings do not need to be written again');
 fs.unlinkSync(reopened.settingsFile);reopened.savePublic(defaults);
 assert.equal(writes.writes,2);
 assert.deepEqual(JSON.parse(fs.readFileSync(reopened.settingsFile,'utf8')),defaults);
});

test('paged background sync retains every durable entity without rewriting unchanged settings',async t=>{
 let cursor=0,syncCalls=0,settingsCalls=0;
 const entities=Array.from({length:67},(_,i)=>({kind:'book',key:`fixture-book-${i}`,revision:i+1,value:{id:`fixture-book-${i}`,title:`Synthetic ${i}`,demo:false,segmentCount:1}}));
 const fetchImpl=async(url,options)=>{
  let value;
  if(url.endsWith('/v1/auth/login'))value={token:'synthetic-token',user:{id:'fixture-user',username:'fixture',role:'user'}};
  else if(url.endsWith('/v1/settings')){settingsCalls++;value=defaults;}
  else{
   assert.ok(url.endsWith('/v1/sync'));const input=JSON.parse(options.body);assert.deepEqual(input.mutations,[]);syncCalls++;
   const changes=entities.slice(input.cursor,input.cursor+32);cursor+=changes.length;
   value={acknowledged:[],accepted:[],conflicts:[],changes,cursor,hasMore:cursor<entities.length};
  }
  return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 };
 const {root,workspace:w}=fixture(t,fetchImpl);
 await w.client.login({serverUrl:'https://synthetic.invalid',username:'fixture',password:'fixture-password'});w.open();
 const writes=trackSettingsWrites(t,w.settingsFile);
 for(let i=0;i<4;i++)await w.sync();
 assert.equal(syncCalls,6);assert.equal(settingsCalls,4);
 assert.equal(writes.writes,1,'background polling must not repeatedly fsync unchanged provider settings');
 assert.equal(w.client.public().cursor,67);
 assert.equal(w.client.entities().length,67);
 const reopened=new CloudWorkspace({directory:root,cipher,fetchImpl});reopened.open();
 for(const entity of entities)assert.deepEqual(reopened.client.getEntity(entity.kind,entity.key),entity);
 assert.deepEqual(reopened.settings,defaults);
});
