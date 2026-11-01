'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Library}=require('../app/library.cjs');
const {GameStore}=require('../app/game-store.cjs');
const {libraryEntities,hydrateLibrary,applyChanges}=require('../app/cloud-library.cjs');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-sync-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('bootstrap preserves merged progress and text through entities',t=>{
 const a=new Library(temp(t));a.saveProgress({bookId:a.state.activeBookId,position:1,draft:'The'});
 const entities=libraryEntities(a.exportData(),new GameStore(a.dataDir));
 const b=new Library(temp(t));hydrateLibrary(b,new GameStore(b.dataDir),{set(){}},entities);
 assert.deepEqual(b.exportData(),a.exportData());
});
test('remote progress is absolute, restart durable, and does not rewrite library snapshot',t=>{
 const a=new Library(temp(t));const before=fs.readFileSync(a.file);const id=a.state.activeBookId;
 const p={position:2,draft:'An',completed:[0,1],stats:{sessions:2,characters:30,seconds:12}};
 a.applySyncedProgress({bookId:id,...p});a.applySyncedProgress({bookId:id,...p});
 assert.deepEqual(fs.readFileSync(a.file),before);assert.deepEqual(new Library(a.dataDir)._progressResult(a.state.books[0]),{bookId:id,...p});
 assert.throws(()=>a.applySyncedProgress({bookId:id,...p,position:999}));
});
test('partial chunks cannot replace a library; changed source is rejected',t=>{
 const a=new Library(temp(t));const entities=libraryEntities(a.exportData(),new GameStore(a.dataDir));
 assert.throws(()=>hydrateLibrary(a,new GameStore(a.dataDir),{set(){}},entities.filter(x=>x.kind!=='chunk')));
 const chunk=structuredClone(entities.find(x=>x.kind==='chunk'));chunk.value.segments[0].source='changed';
 assert.throws(()=>applyChanges(a,new GameStore(a.dataDir),{set(){}},[chunk]));
});
test('game records can be restored and survive restart',t=>{
 const s=new GameStore(temp(t));const p={levels:{1:{stars:2,score:20,seconds:10,accuracy:100}},bestRaces:{},recent:[]};
 s.importProgress('demo-lighthouse',p);assert.deepEqual(new GameStore(path.dirname(s.file)).get('demo-lighthouse'),p);
 assert.throws(()=>s.importProgress('../invalid',p));
});
