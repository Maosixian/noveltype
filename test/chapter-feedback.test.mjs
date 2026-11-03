import test from 'node:test';
import assert from 'node:assert/strict';
import {chapterMessage, createChapterFeedback} from '../app/chapter-feedback.mjs';

const first={id:'chapter-0',label:'第一章 起点',start:0,end:1};
const second={id:'chapter-2',label:'第二章 归来',start:2,end:3};
const transition={completed:first,next:second,bookEnd:false};

test('chapter acknowledgement identifies the completed and next chapter',()=>{
  assert.deepEqual(chapterMessage(transition,[0,1],4),{
    title:'本章已完成',chapter:'第一章 起点',next:'下一章：第二章 归来',complete:true,
  });
});

test('jumping to a chapter ending does not claim its skipped passages were completed',()=>{
  assert.deepEqual(chapterMessage(transition,[1],4),{
    title:'已到本章末尾',chapter:'第一章 起点',next:'下一章：第二章 归来',complete:false,
  });
});

test('Bible names and book endings use accurate labels without inventing a next chapter',()=>{
  const ending={completed:{id:'chapter-2',label:'启示录 第 22 章',start:2,end:3},next:null,bookEnd:true};
  assert.equal(chapterMessage(ending,[0,1,2,3],4).title,'全书已完成');
  assert.equal(chapterMessage(ending,[2,3],4).title,'本书已到结尾');
  assert.equal(chapterMessage(ending,[2,3],4).next,'');
  assert.equal(chapterMessage({...transition,next:null},[0,1],4).next,'');
  assert.equal(chapterMessage(null,[0],4),null);
});

test('unknown, duplicated and out-of-range completion entries never imply a completed book',()=>{
  const ending={completed:second,next:null,bookEnd:true};
  assert.equal(chapterMessage(ending,[2,3,3,99],4).title,'本书已到结尾');
});

test('new input can be acknowledged once; retry and repeated async responses are idempotent',()=>{
  const feedback=createChapterFeedback();feedback.reset('book-a');
  const receipt=feedback.capture({bookId:'book-a',transition,total:4,token:{}});
  assert.ok(receipt);
  assert.equal(feedback.confirm(receipt,[0,1]).title,'本章已完成');
  assert.equal(feedback.confirm(receipt,[0,1]),null);
  const replay=feedback.capture({bookId:'book-a',transition,total:4,token:{}});
  assert.equal(feedback.confirm(replay,[0,1]).title,'本章已完成');
});

test('restored drafts and non-boundary completions produce no receipt',()=>{
  const feedback=createChapterFeedback();feedback.reset('book-a');
  assert.equal(feedback.capture({bookId:'book-a',transition,total:4,token:null}),null);
  assert.equal(feedback.capture({bookId:'book-a',transition:null,total:4,token:{}}),null);
});

test('changing book or choosing another paragraph invalidates delayed acknowledgements',()=>{
  const feedback=createChapterFeedback();feedback.reset('book-a');
  const receipt=feedback.capture({bookId:'book-a',transition,total:4,token:{}});
  feedback.reset('book-b');assert.equal(feedback.confirm(receipt,[0,1]),null);
  assert.equal(feedback.capture({bookId:'book-a',transition,total:4,token:{}}),null);
  feedback.reset('book-a');assert.equal(feedback.confirm(receipt,[0,1]),null);
  const another=feedback.capture({bookId:'book-a',transition,total:4,token:{}});
  feedback.reset('book-a');assert.equal(feedback.confirm(another,[0,1]),null);
});

test('a pending acknowledgement can be confirmed after a failed save is explicitly retried',()=>{
  const feedback=createChapterFeedback();feedback.reset('book-a');
  const receipt=feedback.capture({bookId:'book-a',transition,total:4,token:{}});
  // No confirm call is made on failure; the same receipt is retained in the save queue.
  assert.equal(feedback.confirm(receipt,[0,1]).title,'本章已完成');
});
