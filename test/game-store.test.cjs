'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {GameStore}=require('../app/game-store.cjs');
const {gameContent,GameContentRegistry}=require('../app/game-content.cjs');
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noveltype-game-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const result=(overrides={})=>({bookId:'book',runId:'test-run-1',mode:'race',levelId:1,passageId:'a'.repeat(64),stars:2,score:120,seconds:18,accuracy:98,wpm:40,won:true,...overrides});
test('game result survives restart without touching library, repeats are idempotent',t=>{
 const dir=temp(t);fs.writeFileSync(path.join(dir,'library.json'),'unchanged');const store=new GameStore(dir);
 const a=store.save(result());assert.equal(a.levels[1].stars,2);assert.equal(a.recent.length,1);
 assert.deepEqual(store.save(result()),a);assert.deepEqual(new GameStore(dir).get('book'),a);
 assert.equal(fs.readFileSync(path.join(dir,'library.json'),'utf8'),'unchanged');
});
test('stars never regress, best race only improves, locked levels and invalid values rejected',t=>{
 const store=new GameStore(temp(t));assert.throws(()=>store.save(result({levelId:2,mode:'defense',passageId:null})));
 store.save(result());const state=store.save(result({runId:'test-run-2',stars:1,seconds:22}));
 assert.equal(state.levels[1].stars,2);assert.equal(state.bestRaces['a'.repeat(64)].seconds,18);
 for(const edit of [{bookId:'__proto__'},{runId:'../path'},{score:Infinity},{accuracy:-1},{stars:4},{levelId:13},{mode:'magic'},{won:false,stars:1}])assert.throws(()=>store.save(result(edit)));
});
test('failed write never acknowledges or advances in-memory progress, explicit retry works',t=>{
 const dir=temp(t),store=new GameStore(dir);fs.mkdirSync(path.join(dir,'games.json'));
 assert.throws(()=>store.save(result()));assert.deepEqual(store.get('book').levels,{});
 fs.rmdirSync(path.join(dir,'games.json'));assert.equal(store.save(result()).levels[1].stars,2);
});
test('corrupt game file is preserved and cannot be silently overwritten',t=>{
 const dir=temp(t);fs.writeFileSync(path.join(dir,'games.json'),'{bad');assert.throws(()=>new GameStore(dir));
 assert.equal(fs.readFileSync(path.join(dir,'games.json'),'utf8'),'{bad');
});
test('library-compatible inherited names remain valid independent game books',t=>{
 const dir=temp(t),store=new GameStore(dir);
 for(const id of ['toString','constructor','valueOf','hasOwnProperty']){
   assert.deepEqual(store.get(id).levels,{});store.save(result({bookId:id,runId:'run-'+id}));
   assert.equal(new GameStore(dir).get(id).levels[1].stars,2);
 }
});
test('game content is bounded, uses merged cached translations and stable content ids',()=>{
 const segments=Array.from({length:60000},(_,i)=>({source:'测试'+i,translation:i%2?'A quiet road.':''}));
 const state={activeBookId:'book',books:[{id:'book',title:'book',position:59000,segments}]};
 const data=gameContent(state,'book');assert.ok(data.passages.length<=48);assert.equal(data.passages[0].source,'测试59001');
 assert.equal(JSON.stringify(data).includes('测试1"'),false);const old=data.passages[0].id;
 segments[59001].translation='A different road.';assert.notEqual(gameContent(state,'book').passages[0].id,old);
 assert.throws(()=>gameContent(state,'missing'));assert.ok(gameContent(state,'sample').passages.length>=5);
 assert.equal(gameContent({activeBookId:'empty',books:[{id:'empty',title:'empty',position:0,segments:[{source:'中文',translation:''}]}]},'empty').passages.length,0);
});
test('long and multiline translations become playable excerpts without modifying the book',()=>{
 const translation=Array.from({length:25},()=>"The traveler followed the quiet path beside the river.").join('\n');
 const state={books:[{id:'long',title:'long',position:0,segments:[{source:'故事原文',translation}]}]};
 const content=gameContent(state,'long');assert.ok(content.passages.length>1);
 for(const p of content.passages){assert.ok(p.translation.length<=260);assert.ok(!/[\n\r\t]/.test(p.translation));assert.equal(p.source,'故事原文');}
 assert.equal(state.books[0].segments[0].translation,translation);
 assert.equal(new Set(content.passages.map(p=>p.id)).size,content.passages.length);
});

test('an issued race still saves when an in-flight translation pushes it out of the 48-candidate window',t=>{
 const segments=Array.from({length:54},(_,index)=>({source:'原文'+index,translation:index?'A quiet road number '+index+'.':''}));
 const state={activeBookId:'book',books:[{id:'book',title:'book',position:0,segments}]};
 const registry=new GameContentRegistry(),issued=registry.issue(state,'book'),last=issued.passages.at(-1);
 assert.equal(last.index,48);assert.equal(last.part,0);
 const unchanged=JSON.stringify(state.books[0].segments[48]);
 segments[0].translation='The pending translation has arrived.';
 assert.equal(gameContent(state,'book').passages.some(p=>p.id===last.id),false);
 const completion=result({passageId:last.id});
 assert.doesNotThrow(()=>registry.validate(state,completion));
 const store=new GameStore(temp(t));assert.equal(store.save(completion).levels[1].stars,2);
 assert.equal(JSON.stringify(state.books[0].segments[48]),unchanged);
 // A refresh or a different reading position cannot revoke this unchanged target.
 registry.issue(state,'book');state.books[0].position=52;
 assert.doesNotThrow(()=>registry.validate(state,completion));
});

test('issued target validation rejects real edits, invented or cross-book IDs and supports sample',()=>{
 const state={activeBookId:'book',books:[{id:'book',title:'book',position:0,segments:[{source:'原文',translation:'The original target.'}]},{id:'other',title:'other',position:0,segments:[{source:'原文',translation:'The original target.'}]}]};
 const registry=new GameContentRegistry(),passage=registry.issue(state,'book').passages[0];
 const completion=result({passageId:passage.id});
 assert.throws(()=>registry.validate(state,result({passageId:'f'.repeat(64)})));
 assert.throws(()=>registry.validate(state,{...completion,bookId:'other'}));
 state.books[0].segments[0].translation='An actually changed target.';
 assert.throws(()=>registry.validate(state,completion),/更改/);
 state.books[0].segments[0].translation='The original target.';state.books[0].segments[0].source='原文变更';
 assert.throws(()=>registry.validate(state,completion),/更改/);
 const sample=registry.issue(state,'sample');
 assert.doesNotThrow(()=>registry.validate(state,result({bookId:'sample',passageId:sample.passages[0].id})));
});

test('issued long-excerpt targets validate at their original part and returned metadata is not trusted',()=>{
 const translation=Array.from({length:20},(_,i)=>'The traveler follows the quiet road number '+i+'.').join(' ');
 const state={books:[{id:'book',title:'book',position:0,segments:[{source:'长故事',translation}]}]};
 const registry=new GameContentRegistry(),data=registry.issue(state,'book'),last=data.passages.at(-1);
 const completion=result({passageId:last.id});assert.ok(last.part>0);
 last.index=999;last.part=999;
 assert.doesNotThrow(()=>registry.validate(state,completion));
 state.books[0].segments[0].translation=translation.replace('road number 19','river number 19');
 assert.throws(()=>registry.validate(state,completion),/更改/);
});

test('issued candidate history remains bounded and validating one target never reads unrelated segments',()=>{
 const state={books:Array.from({length:11},(_,bookIndex)=>({id:'book'+bookIndex,title:'book',position:0,segments:Array.from({length:48},(_,index)=>({source:'原文'+index,translation:'A cached sentence '+index+'.'}))}))};
 const registry=new GameContentRegistry();let first,last;
 for(const book of state.books){const issued=registry.issue(state,book.id);first ||= {...issued.passages[0],bookId:book.id};last={...issued.passages.at(-1),bookId:book.id};}
 assert.throws(()=>registry.validate(state,result({bookId:first.bookId,passageId:first.id})),/过期/);
 const selected=state.books.at(-1),untouched=selected.segments[0];
 Object.defineProperty(selected.segments,0,{get(){throw new Error('unrelated segment was read');},configurable:true});
 assert.doesNotThrow(()=>registry.validate(state,result({bookId:last.bookId,passageId:last.id})));
 Object.defineProperty(selected.segments,0,{value:untouched,writable:true});
});
