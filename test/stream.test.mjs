import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRange, extendRange, nextPosition, translationCandidate } from '../app/stream.mjs';

test('large novels start with a bounded range around saved position', () => {
  assert.deepEqual(initialRange(100000, 50000), {start:49996,end:50008});
  assert.deepEqual(initialRange(5,0),{start:0,end:5});
});
test('loading previous or later paragraphs preserves position and bounds', () => {
  const range=initialRange(100,50);
  assert.deepEqual(extendRange(range,-1,100),{start:34,end:58});
  assert.deepEqual(extendRange(range,1,100),{start:46,end:70});
  assert.deepEqual(extendRange({start:0,end:5},-1,5),{start:0,end:5});
});
test('completion continues once and ends at last paragraph',()=>{
  assert.equal(nextPosition(0,3,true),1);assert.equal(nextPosition(0,3,false),0);assert.equal(nextPosition(2,3,true),2);
});
test('translation prefetch fills current plus three following paragraphs and stops while inactive',()=>{
  const segments=[{translation:'A'},{translation:''},{translation:''},{translation:''},{translation:''}];
  assert.equal(translationCandidate(segments,0,true),1);
  assert.equal(translationCandidate(segments,0,false),null);
  segments[1].translation='B';assert.equal(translationCandidate(segments,0,true),2);
  segments[2].translation='C';assert.equal(translationCandidate(segments,0,true),3);
  segments[3].translation='D';assert.equal(translationCandidate(segments,0,true),null);
  assert.equal(translationCandidate(segments,1,true),4);
  assert.equal(translationCandidate(segments,4,true),4);
  assert.equal(translationCandidate(segments,5,true),null);
  segments[0].translation='';assert.equal(translationCandidate(segments,0,true),0);
});
