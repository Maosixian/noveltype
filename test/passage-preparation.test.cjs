const test = require('node:test');
const assert = require('node:assert/strict');
let preparePassage;
try { ({ preparePassage } = require('../app/practice.cjs')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const source = '他开门。', translation = 'He opens the door.';
const alignment = {version:1,spans:[{englishStart:0,englishEnd:2,sourceStart:0,sourceEnd:1},{englishStart:3,englishEnd:translation.length,sourceStart:1,sourceEnd:3}]};
function fixture(initial = '') {
  let segment = {source, translation:initial}, stored = null, calls = 0, keys = 0;
  const args = {
    library:{getSegment:()=>({...segment}),setTranslation:({translation})=>{segment.translation=translation;}},
    cache:{get:()=>stored,set:(_s,_t,a)=>{stored=a;return a;}},bookId:'fixture',index:0,
    getCredentials:()=>{keys++;return {settings:{},apiKey:'synthetic'};},
    translate:async()=>{calls++;return {translation,alignment};},
    align:async opts=>{calls++;assert.equal(opts.translation,translation);return {translation,alignment};}
  };
  return {args,get segment(){return segment;},get calls(){return calls;},get keys(){return keys;},setStored:a=>{stored=a;}};
}
test('new passage saves translation and semantic map, cache hit does not access credentials',async()=>{
  assert.equal(typeof preparePassage,'function');const f=fixture();
  assert.deepEqual(await preparePassage(f.args),{translation,alignment,cached:false});
  assert.equal(f.segment.translation,translation);assert.equal(f.calls,1);
  assert.deepEqual(await preparePassage(f.args),{translation,alignment,cached:true});
  assert.equal(f.calls,1);assert.equal(f.keys,1);
});
test('existing translation is aligned without rewriting the book or translating again',async()=>{
  const f=fixture(translation);f.args.library.setTranslation=()=>assert.fail('cached translation must stay untouched');f.args.translate=()=>assert.fail('no retranslation');
  assert.equal((await preparePassage(f.args)).translation,translation);assert.equal(f.calls,1);
});
test('stale result cannot replace a translation edited while the request was pending',async()=>{
  const f=fixture(translation);f.args.align=async()=>{f.args.library.setTranslation({translation:'Edited.'});return {translation,alignment};};
  await assert.rejects(preparePassage(f.args),/更改/);assert.equal(f.segment.translation,'Edited.');assert.equal(f.args.cache.get(),null);
});
test('failed response is not retried and does not change the book',async()=>{
  const f=fixture();let n=0;f.args.translate=async()=>{n++;throw new Error('synthetic failure');};
  await assert.rejects(preparePassage(f.args),/failure/);assert.equal(n,1);assert.equal(f.segment.translation,'');
});
test('invalid alignment is rejected before saving a new translation',async()=>{
  const f=fixture();f.args.translate=async()=>({translation,alignment:{version:1,spans:[]}});
  await assert.rejects(preparePassage(f.args));assert.equal(f.segment.translation,'');
});
test('cache write failure preserves an acknowledged translation for an alignment-only retry',async()=>{
  const f=fixture();f.args.cache.set=()=>{throw new Error('disk full');};
  await assert.rejects(preparePassage(f.args),/disk full/);assert.equal(f.segment.translation,translation);
});
