import test from 'node:test';
import assert from 'node:assert/strict';
import { TypingSession } from '../app/typing.mjs';

test('unchanged typing snapshots reuse correctness without rescanning the text', () => {
  const target = 'The quiet river flows. 😊 İ ß\n'.repeat(250);
  const session = new TypingSession(target, target.slice(0, -10));
  const expected = session.snapshot(0);
  const original = String.prototype.toLowerCase;
  let comparisons = 0;
  try {
    String.prototype.toLowerCase = function () { comparisons++; return original.call(this); };
    for (let i = 0; i < 100; i++) assert.deepEqual(session.snapshot(i), expected);
  } finally {
    String.prototype.toLowerCase = original;
  }
  assert.equal(comparisons, 0, 'Timer redraws must not compare unchanged passage characters again');
});

// A full recount is deliberately independent of the incremental cache. The
// sequence includes middle insertions/deletions, Unicode, case changes and
// excess text, where equal suffix text can move to different target positions.
test('cached correctness agrees with a fresh recount through arbitrary edits', () => {
  const target = 'A😊 b\tİ ß\nZ!';
  const session = new TypingSession(target, 'a😊');
  const expected = Array.from(target);
  const values = [
    'a😊 b', 'aX😊 b', 'a😊 b', 'a😊 Xb', 'a😊 b',
    'a😊 b\tİ ß\n?', 'a😊 b\ti ß\n?', 'a😊 b\tİ ß\n?',
    'a😊 b\tİ SS\n?', 'a😊 b\tİ ß\n?', '', 'a', 'A😊 ',
  ];
  let seed = 0x1256abc;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = ['a', 'A', '😊', 'b', 'İ', 'i', '\u0307', 'ß', 'S', ' ', '\t', '\n', '?'];
  let value = values.at(-1);
  for (let i = 0; i < 300; i++) {
    const points = Array.from(value), start = random(points.length + 1);
    points.splice(start, random(3), ...Array.from({ length: random(3) }, () => alphabet[random(alphabet.length)]));
    value = points.join(''); values.push(value);
  }
  values.push(target.toLowerCase(), target);
  let previous = 'a😊', attempts = 0, errors = 0, now = 0;
  const matches = (a, b) => typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  for (const value of values) {
    const before = Array.from(previous), next = Array.from(value);
    let first = 0;
    while (first < before.length && first < next.length && before[first] === next[first]) first++;
    let oldEnd = before.length, newEnd = next.length;
    while (oldEnd > first && newEnd > first && before[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
    for (let i = first; i < newEnd; i++) { attempts++; if (!matches(next[i], expected[i])) errors++; }
    session.input(value, now += 25);
    const correct = next.reduce((sum, point, i) => sum + Number(matches(point, expected[i])), 0);
    const actual = session.snapshot(now);
    assert.equal(actual.correct, correct, JSON.stringify(value));
    assert.equal(session.correctCount(), correct);
    assert.equal(actual.characters, Math.max(0, correct - 2));
    assert.equal(actual.attempts, attempts);
    assert.equal(actual.errors, errors);
    assert.equal(actual.value, value);
    assert.equal(actual.complete, next.length === expected.length && correct === expected.length);
    previous = value;
    if (actual.complete) break;
  }
  assert.equal(session.complete, true);
  const completed = session.snapshot(now);
  session.input('ignored after completion', now + 1000);
  assert.deepEqual(session.snapshot(now + 1000), completed);
});
