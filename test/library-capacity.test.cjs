'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Library}=require('../app/library.cjs');
const MIB=1024*1024,limit=128*MIB;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-capacity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,library:new Library(dir)};}
function fixture(count){return {version:1,activeBookId:'capacity',books:[{id:'capacity',title:'Synthetic capacity fixture',demo:false,position:0,draft:'',completed:[],stats:{sessions:0,characters:0,seconds:0},segments:Array.from({length:count},()=>({source:'合成测试。',translation:'a'.repeat(10000)}))}]};}

test('a synthetic library above 64 MiB imports, restarts and journals small saves without rewriting the book',t=>{
 const {dir,library}=setup(t),data=fixture(7200);
 const bytes=Buffer.byteLength(JSON.stringify(data));assert.ok(bytes>64*MIB&&bytes<limit);
 library.importData(data);
 const restored=new Library(dir),file=path.join(dir,'library.json'),before=hash(file);
 assert.equal(restored.state.books[0].segments.length,7200);
 assert.equal(restored.getSegment('capacity',7199).translation,'a'.repeat(10000));
 restored.setTranslation({bookId:'capacity',index:7199,translation:'The saved translation is retained.'});
 restored.saveProgress({bookId:'capacity',position:7199,draft:'The saved'});
 assert.equal(hash(file),before,'Routine updates must not rewrite the large base file');
 assert.ok(fs.statSync(path.join(dir,'library.journal.jsonl')).size<2048);
 const restarted=new Library(dir);
 assert.equal(restarted.getSegment('capacity',7199).translation,'The saved translation is retained.');
 assert.equal(restarted.state.books[0].position,7199);assert.equal(restarted.state.books[0].draft,'The saved');
});

test('an import above 128 MiB fails without changing the existing library',t=>{
 const {dir,library}=setup(t),before=library.exportData(),file=path.join(dir,'library.json'),beforeHash=hash(file);
 const data=fixture(13500);assert.ok(Buffer.byteLength(JSON.stringify(data))>limit);
 assert.throws(()=>library.importData(data),/备份|128 MB/);
 assert.deepEqual(library.exportData(),before);assert.equal(hash(file),beforeHash);
 assert.deepEqual(new Library(dir).exportData(),before);
});

test('a translation that would cross 128 MiB is rejected and the last acknowledged state survives restart',t=>{
 const {dir,library}=setup(t),data=fixture(13300),segments=data.books[0].segments;
 segments[0].translation='A';
 let bytes=Buffer.byteLength(JSON.stringify(data));
 const full={source:'合成测试。',translation:'a'.repeat(10000)},cost=Buffer.byteLength(JSON.stringify(full))+1;
 while(bytes+cost<limit-500){segments.push(full);bytes+=cost;}
 const tail={source:'合成测试。',translation:''},emptyCost=Buffer.byteLength(JSON.stringify(tail))+1;
 tail.translation='b'.repeat(limit-500-bytes-emptyCost);segments.push(tail);
 assert.ok(tail.translation.length<=10000);assert.equal(Buffer.byteLength(JSON.stringify(data)),limit-500);
 library.importData(data);const file=path.join(dir,'library.json'),beforeHash=hash(file);
 assert.throws(()=>library.setTranslation({bookId:'capacity',index:0,translation:'c'.repeat(1000)}),/128 MB/);
 assert.equal(library.getSegment('capacity',0).translation,'A');assert.equal(hash(file),beforeHash);
 assert.equal(new Library(dir).getSegment('capacity',0).translation,'A');
});
