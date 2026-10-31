import test from 'node:test';
import assert from 'node:assert/strict';
import { targetOffset, alignmentAtCursor } from '../app/alignment.mjs';

const translation = 'He opened the door. Then he smiled.';
const spans = [
  { englishStart: 0, englishEnd: 2, sourceStart: 0, sourceEnd: 1 },
  { englishStart: 3, englishEnd: 9, sourceStart: 1, sourceEnd: 3 },
  { englishStart: 10, englishEnd: 19, sourceStart: 3, sourceEnd: 5 },
  { englishStart: 20, englishEnd: 24, sourceStart: 5, sourceEnd: 7 },
  { englishStart: 25, englishEnd: 27, sourceStart: 7, sourceEnd: 8 },
  { englishStart: 28, englishEnd: 35, sourceStart: 8, sourceEnd: 10 },
];
const alignment = { version: 1, spans };
const at = (input, cursor = input.length) => alignmentAtCursor(translation, input, cursor, alignment);

test('cursor follows target words, phrases, whitespace and punctuation', () => {
  assert.deepEqual(at('').span, spans[0]);
  assert.deepEqual(at('He ').span, spans[1]);
  assert.deepEqual(at('He op').span, spans[1]);
  assert.deepEqual(at('He opened ').span, spans[2]);
  assert.deepEqual(at('He opened the door').span, spans[2]);
  assert.deepEqual(at('He opened the door. ').span, spans[3]);
  assert.deepEqual(at(translation).span, spans.at(-1));
});

test('backspace, selection and incorrect casing/letters use expected position', () => {
  assert.deepEqual(at('hE OXXX').span, spans[1]);
  assert.deepEqual(at('He opened the door', 4).span, spans[1]);
  assert.deepEqual(at('He opened the door', 1).span, spans[0]);
  assert.deepEqual(at('He opened the door', 10).span, spans[2]);
  assert.deepEqual(at('He opened the door', 200).span, spans[2]);
});

test('UTF-16 cursor is translated through code-point positions without splitting emoji', () => {
  assert.equal(targetOffset('A😀B', 'A😀', 3), 3);
  assert.equal(targetOffset('A😀B', 'Ax', 2), 3);
  assert.equal(targetOffset('AxB', 'A😀', 3), 2);
  assert.equal(targetOffset('A😀B', 'A😀', 2), 1);
  const map = { version: 1, spans: [
    { englishStart: 0, englishEnd: 2, sourceStart: 0, sourceEnd: 1 },
    { englishStart: 3, englishEnd: 6, sourceStart: 1, sourceEnd: 3 },
  ] };
  const hit = alignmentAtCursor('Go 😀!', 'Go ', 3, map);
  assert.equal(hit.span.sourceEnd, 3);
});

test('source ranges may repeat, overlap or run in the opposite order', () => {
  const map = { version: 1, spans: [
    { englishStart: 0, englishEnd: 3, sourceStart: 5, sourceEnd: 6 },
    { englishStart: 4, englishEnd: 7, sourceStart: 1, sourceEnd: 3 },
    { englishStart: 8, englishEnd: 13, sourceStart: 1, sourceEnd: 3 },
  ] };
  assert.equal(alignmentAtCursor('One two three', 'One ', 4, map).span.sourceStart, 1);
  assert.equal(alignmentAtCursor('One two three', 'One two t', 9, map).span.sourceStart, 1);
});

test('missing maps do not manufacture a proportional Chinese highlight', () => {
  assert.equal(alignmentAtCursor('Words', 'Wo', 2, null), null);
  assert.equal(alignmentAtCursor('', '', 0, alignment), null);
  assert.equal(alignmentAtCursor('Words', '', 0, { version: 1, spans: [] }), null);
});

test('contractions, hyphenated words and non-ASCII letters remain complete words', () => {
  const text = "Don't re-enter café.";
  const map = { version: 1, spans: [{ englishStart: 0, englishEnd: text.length, sourceStart: 0, sourceEnd: 5 }] };
  assert.equal(text.slice(...Object.values(alignmentAtCursor(text, 'Don', 3, map).word)), "Don't");
  assert.deepEqual(alignmentAtCursor(text, "Don't re-", 9, map).word, { start: 6, end: 14 });
  assert.deepEqual(alignmentAtCursor(text, "Don't re-enter ca", 17, map).word, { start: 15, end: 19 });
});
