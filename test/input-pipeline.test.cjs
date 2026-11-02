'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CloudWorkspace}=require('../app/cloud-workspace.cjs');
const cipher={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
async function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-pipeline-test-'));
 t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('noveltype-pipeline-test-'));fs.rmSync(directory,{recursive:true,force:true});});
 const fetchImpl=async(url,options)=>{
  const body=options.body&&JSON.parse(options.body);
  if(url.endsWith('/v1/auth/login'))return Response.json({user:{id:body.username,username:body.username,role:'user'},token:'synthetic-only'});
  if(url.endsWith('/v1/sync'))return Response.json({acknowledged:body.mutations.map(m=>m.mutationId),accepted:body.mutations.map(m=>({mutationId:m.mutationId,kind:m.kind,key:m.key,revision:7})),changes:[],conflicts:[],cursor:7,hasMore:false});
  if(url.endsWith('/v1/settings'))return Response.json({provider:'glm',baseUrl:'https://example.invalid',model:'fixture',hasKey:false});
  throw Error('Unexpected test route');
 };
 const w=new CloudWorkspace({directory,cipher,fetchImpl});w.open();
 const login=async user=>w.client.login({serverUrl:'https://example.invalid',username:user,password:'test-only'});
 await login('fixture-a');
 const applied={'progress/demo-lighthouse':3};
 for(let i=0;i<60000;i++)applied[`alignment/fixture:${i}`]=1;
 fs.writeFileSync(path.join(w.client.accountDirectory(),'cloud-applied.json'),JSON.stringify(applied));w.open();
 return {w,login};
}

test('routine draft saves reuse the account revision index instead of reparsing every synced entity',async t=>{
 const {w}=await fixture(t),file=w.appliedFile(),original=fs.readFileSync;let reads=0;
 fs.readFileSync=function(target,...args){if(String(target)===file)reads++;return original.call(this,target,...args);};
 try{for(let n=0;n<5;n++)w.changed('progress','demo-lighthouse',()=>w.library.saveProgress({bookId:'demo-lighthouse',position:0,draft:`Draft ${n}`}));}finally{fs.readFileSync=original;}
 assert.equal(reads,0,'Saved revisions should be loaded when opening the account, not during typing saves');
 assert.equal(w.client.outbox().length,1);assert.equal(w.client.outbox()[0].baseRevision,3);
 assert.equal(w.client.outbox()[0].value.draft,'Draft 4');
});

test('failed revision persistence cannot advance the in-memory CAS baseline; incoming acknowledgement replays',async t=>{
 const {w}=await fixture(t),id='demo-lighthouse';
 w.changed('progress',id,()=>w.library.saveProgress({bookId:id,position:0,draft:'Before sync'}));
 const original=fs.renameSync;
 fs.renameSync=function(source,destination){if(String(destination)===w.appliedFile())throw Error('Simulated disk failure');return original.call(this,source,destination);};
 try{await assert.rejects(w.sync(),/Simulated disk failure/);}finally{fs.renameSync=original;}
 assert.equal(w.applied()[`progress/${id}`],3,'A failed disk write must leave the old local baseline intact');
 assert.equal(w.client.outbox().length,1);
 await w.sync();assert.equal(w.applied()[`progress/${id}`],7);assert.equal(w.client.outbox().length,0);
 w.changed('progress',id,()=>w.library.saveProgress({bookId:id,position:0,draft:'After sync'}));
 assert.equal(w.client.outbox()[0].baseRevision,7);
});

test('reopening another account replaces the cached revisions and restores the original on return',async t=>{
 const {w,login}=await fixture(t),id='demo-lighthouse';
 assert.equal(w.applied()[`progress/${id}`],3);
 await login('fixture-b');w.open();assert.equal(w.applied()[`progress/${id}`],undefined);
 w.changed('progress',id,()=>w.library.saveProgress({bookId:id,position:0,draft:'B'}));assert.equal(w.client.outbox()[0].baseRevision,0);
 await login('fixture-a');w.open();assert.equal(w.applied()[`progress/${id}`],3);
 w.changed('progress',id,()=>w.library.saveProgress({bookId:id,position:0,draft:'A'}));assert.equal(w.client.outbox()[0].baseRevision,3);
});

test('connected checks account presence without constructing the full pending/conflict status',async t=>{
 const {w}=await fixture(t);w.client.public=()=>{throw Error('Status generation is unnecessary for presence checks');};
 assert.equal(w.connected(),true);w.client.session=null;assert.equal(w.connected(),false);
});
