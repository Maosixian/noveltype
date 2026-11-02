'use strict';
// Main-process save benchmark: synthetic content, fake encrypted session, no network.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {CloudWorkspace}=require('../app/cloud-workspace.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-input-pipeline-'));
const cipher={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
const synthetic={version:1,activeBookId:'fixture-0',books:Array.from({length:6},(_,b)=>({id:`fixture-${b}`,title:`Synthetic ${b}`,demo:false,position:0,draft:'',completed:[],stats:{sessions:0,characters:0,seconds:0},segments:Array.from({length:10000},()=>({source:'山'.repeat(225)+'。',translation:''}))}))};
function percentile(values,fraction){return values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))];}
async function run(mode,entityCount){
 const dir=path.join(root,mode);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'library.json'),JSON.stringify(synthetic));
 const w=new CloudWorkspace({directory:dir,cipher,fetchImpl:async()=>({ok:true,status:200,json:async()=>({user:{id:'fixture',username:'fixture',role:'user'},token:'synthetic-token'})})});w.open();
 if(entityCount){await w.client.login({serverUrl:'https://fixture.invalid',username:'fixture',password:'not-real'});fs.copyFileSync(path.join(dir,'library.json'),path.join(w.client.accountDirectory(),'library.json'));const applied={};for(let i=0;i<entityCount;i++)applied[`alignment/fixture-${i}:0`]=1;fs.writeFileSync(w.appliedFile(),JSON.stringify(applied));w.open();}
 const input={bookId:'fixture-0',position:0,draft:'warmup'};
 if(entityCount)w.changed('progress',input.bookId,()=>w.library.saveProgress(input));else w.library.saveProgress(input);
 const snapshot=fs.statSync(w.library.file);const durations=[];let readBytes=0,reads=0,syncs=0;
 const originalRead=fs.readFileSync,originalSync=fs.fsyncSync;
 fs.readFileSync=function(file,...args){const data=originalRead.call(this,file,...args);readBytes+=typeof data==='string'?Buffer.byteLength(data):data.byteLength;reads++;return data;};
 fs.fsyncSync=function(...args){syncs++;return originalSync.apply(this,args);};
 try{for(let n=0;n<40;n++){const t=performance.now(),payload={...input,draft:`draft ${n}`};const ack=entityCount?w.changed('progress',payload.bookId,()=>w.library.saveProgress(payload)):w.library.saveProgress(payload);durations.push(performance.now()-t);assert.equal(ack.draft,payload.draft);assert.ok(Buffer.byteLength(JSON.stringify(ack))<1000);}}finally{fs.readFileSync=originalRead;fs.fsyncSync=originalSync;}
 assert.equal(fs.statSync(w.library.file).mtimeMs,snapshot.mtimeMs);
 assert.equal(w.library._book('fixture-0').draft,'draft 39');
 return {mode,entityCount,saves:40,medianMs:percentile(durations,.5),p95Ms:percentile(durations,.95),maxMs:Math.max(...durations),diskReads:reads,diskReadBytes:readBytes,fsyncs:syncs,snapshotUnchanged:true};
}
(async()=>{try{const results=[];for(const [name,count]of [['local',0],['cloud-500',500],['cloud-60000',60000]])results.push(await run(name,count));const report={scope:'Synthetic 60000 segments; no user files, secrets, or network',results};console.log(JSON.stringify(report,null,2));if(process.env.NOVELTYPE_BENCHMARK_OUTPUT)fs.writeFileSync(process.env.NOVELTYPE_BENCHMARK_OUTPUT,JSON.stringify(report,null,2));}finally{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('noveltype-input-pipeline-'));fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
