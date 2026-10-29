import test from 'node:test';
import assert from 'node:assert/strict';
import { TypingSession } from '../app/typing.mjs';

test('initial state does not run a timer or claim empty-text completion', () => {
  const session = new TypingSession('Hello');
  assert.equal(session.snapshot(5000).seconds, 0);
  assert.equal(session.snapshot(5000).accuracy, 100);
  assert.equal(new TypingSession('').snapshot(5000).complete, false);
});

test('wrong characters remain errors after correction and deletion is not a keystroke', () => {
  const session = new TypingSession('cat');
  session.input('c', 1000);
  session.input('cx', 2000);
  assert.equal(session.snapshot(2000).errors, 1);
  session.input('c', 2500);
  session.input('ca', 3000);
  session.input('cat', 4000);
  const result = session.snapshot(9000);
  assert.equal(result.attempts, 4);
  assert.equal(result.accuracy, 75);
  assert.equal(result.correct, 3);
  assert.equal(result.seconds, 3);
  assert.equal(result.wpm, 12);
  assert.equal(result.complete, true);
});

test('a full-length wrong answer is not complete, and replacement is counted', () => {
  const session = new TypingSession('cat');
  session.input('car', 1000);
  assert.equal(session.snapshot(1000).complete, false);
  session.input('cat', 2000);
  assert.equal(session.snapshot(2000).attempts, 4);
  assert.equal(session.snapshot(2000).errors, 1);
  assert.equal(session.claimCompletion(2000).characters, 3);
  assert.equal(session.claimCompletion(2000), null);
});

test('pause excludes inactive time and completion freezes elapsed time', () => {
  const session = new TypingSession('abc');
  session.input('a', 1000);
  session.pause(2000);
  assert.equal(session.snapshot(12000).seconds, 1);
  session.resume(12000);
  session.input('ab', 13000);
  session.input('abc', 14000);
  assert.equal(session.snapshot(99999).seconds, 3);
  assert.equal(session.snapshot(99999).wpm, 12);
});

test('restored draft is visible but does not inflate this session speed or characters', () => {
  const session = new TypingSession('hello', 'hell');
  assert.equal(session.snapshot(8000).correct, 4);
  assert.equal(session.snapshot(8000).wpm, 0);
  session.input('hello', 9000);
  assert.equal(session.claimCompletion(10000).characters, 1);
  assert.equal(session.claimCompletion(10000), null);
  assert.equal(new TypingSession('hello', 'hello').claimCompletion(10000), null);
});

test('comparison and error positions support Unicode and excess input', () => {
  const session = new TypingSession('A😊');
  session.input('A😊x', 1000);
  assert.equal(session.snapshot(2000).correct, 2);
  assert.equal(session.snapshot(2000).errors, 1);
  assert.equal(session.snapshot(2000).complete, false);
  session.input('A😊', 3000);
  assert.equal(session.snapshot(3000).complete, true);
  assert.equal(session.snapshot(3000).accuracy, 67);
});

test('letter case does not affect correctness, accuracy, speed or completion', () => {
  const session = new TypingSession('Hello, World!');
  session.input('h', 1000);
  assert.equal(session.snapshot(1000).correct, 1);
  assert.equal(session.snapshot(1000).errors, 0);
  session.input('hELLO, wORLD!', 3000);
  const result = session.snapshot(9000);
  assert.equal(result.correct, 13);
  assert.equal(result.errors, 0);
  assert.equal(result.accuracy, 100);
  assert.equal(result.wpm, 78);
  assert.equal(result.complete, true);
  assert.equal(result.value, 'hELLO, wORLD!');
  assert.equal(session.target, 'Hello, World!');
  assert.equal(session.claimCompletion(9000).characters, 13);
});

test('mixed-case restored drafts retain their baseline and completed state', () => {
  const session = new TypingSession('Hello, World!', 'HELLO, ');
  assert.equal(session.snapshot(8000).correct, 7);
  assert.equal(session.snapshot(8000).characters, 0);
  session.input('HELLO, world!', 9000);
  assert.equal(session.claimCompletion(10000).characters, 6);
  const completed = new TypingSession('Hello, World!', 'hello, world!');
  assert.equal(completed.complete, true);
  assert.equal(completed.claimCompletion(10000), null);
});

test('case-insensitive practice still checks letters, whitespace, punctuation and length', () => {
  for (const input of ['hi  there.', 'hithere.', 'hi there!', 'hi thers.', 'hi there. ']) {
    const session = new TypingSession('Hi there.');
    session.input(input, 1000);
    assert.equal(session.complete, false, input);
    assert.ok(session.snapshot(1000).errors > 0, input);
  }
});
