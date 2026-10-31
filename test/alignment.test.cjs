'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let backend;
try { backend = require('../app/alignment.cjs'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const source = '雨停了。他看着雨。';
const translation = 'He watched the rain. It had stopped.';
const response = () => ({ translation, groups: [
  { english: 'He', chinese: '他', occurrence: 0 },
  { english: 'watched', chinese: '看着', occurrence: 0 },
  { english: 'the rain.', chinese: '雨', occurrence: 1 },
  { english: 'It had stopped.', chinese: '雨停了。', occurrence: 0 },
] });
const parsed = () => { assert.equal(typeof backend?.parseAlignedResponse, 'function'); return backend.parseAlignedResponse(source, JSON.stringify(response())); };
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltype-alignment-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, cache: new backend.AlignmentCache(directory) };
}

test('semantic spans preserve reordered source, duplicate occurrences, and many-to-one phrases', () => {
  const result = parsed();
  assert.equal(result.translation, translation);
  assert.deepEqual(result.alignment, { version: 1, spans: [
    { englishStart: 0, englishEnd: 2, sourceStart: 4, sourceEnd: 5 },
    { englishStart: 3, englishEnd: 10, sourceStart: 5, sourceEnd: 7 },
    { englishStart: 11, englishEnd: 20, sourceStart: 7, sourceEnd: 8 },
    { englishStart: 21, englishEnd: 36, sourceStart: 0, sourceEnd: 4 },
  ] });
});

test('existing translation is retained byte for byte and any changed response is refused', () => {
  parsed();
  const original = '  He\nwatched  the rain. It had stopped.  ';
  const raw = { ...response(), translation: original };
  assert.equal(backend.parseAlignedResponse(source, JSON.stringify(raw), original).translation, original);
  assert.throws(() => backend.parseAlignedResponse(source, JSON.stringify(response()), original), /对照/);
});

test('missing English text or punctuation, invented Chinese, repeated English, and unknown fields are rejected', () => {
  parsed();
  const invalid = [
    { ...response(), groups: response().groups.slice(1) },
    { ...response(), groups: response().groups.map((group, i) => i === 2 ? { ...group, english: 'the rain' } : group) },
    { ...response(), groups: response().groups.map((group, i) => i === 2 ? { ...group, chinese: '天空' } : group) },
    { ...response(), groups: response().groups.map((group, i) => i === 2 ? { ...group, occurrence: 2 } : group) },
    { ...response(), groups: [...response().groups, response().groups[0]] },
    { ...response(), extra: 'private text' },
    { ...response(), groups: response().groups.map(group => ({ ...group, note: 'private text' })) },
  ];
  for (const value of invalid) assert.throws(() => backend.parseAlignedResponse(source, JSON.stringify(value)), error => /对照/.test(error.message) && !/private|天空/.test(error.message));
});

test('alignment validation rejects gaps, overlaps, empty spans, bad Unicode and split surrogate pairs', () => {
  const valid = parsed().alignment;
  const invalid = [
    { ...valid, spans: [{ ...valid.spans[0], englishStart: 1 }, ...valid.spans.slice(1)] },
    { ...valid, spans: [{ ...valid.spans[0], englishEnd: 5 }, ...valid.spans.slice(1)] },
    { ...valid, spans: valid.spans.map(span => ({ ...span, sourceStart: 3, sourceEnd: 3 })) },
    { ...valid, spans: valid.spans.map(span => ({ ...span, sourceEnd: 999 })) },
  ];
  for (const value of invalid) assert.throws(() => backend.validateAlignment(source, translation, value), /对照/);
  assert.throws(() => backend.validateAlignment('\ud800', translation, valid), /对照/);
  const emoji = { version: 1, spans: [{ englishStart: 0, englishEnd: 3, sourceStart: 0, sourceEnd: 2 }] };
  assert.deepEqual(backend.validateAlignment('😀', '😀!', emoji), emoji);
  assert.throws(() => backend.validateAlignment('😀', '😀!', { ...emoji, spans: [{ ...emoji.spans[0], sourceStart: 1 }] }), /对照/);
  assert.throws(() => backend.validateAlignment('😀', '😀!', { ...emoji, spans: [{ ...emoji.spans[0], englishEnd: 1 }] }), /对照/);
});

test('overlapping repeated Chinese substrings have deterministic zero-based occurrence positions', () => {
  parsed();
  const result = backend.parseAlignedResponse('哈哈哈', JSON.stringify({ translation: 'Ha!', groups: [{ english: 'Ha!', chinese: '哈哈', occurrence: 1 }] }));
  assert.deepEqual(result.alignment.spans[0], { englishStart: 0, englishEnd: 3, sourceStart: 1, sourceEnd: 3 });
});

test('groups never split English words, contractions or hyphenated words into misleading letter highlights', () => {
  parsed();
  for (const [text, parts] of [['window', ['win', 'dow']], ["don't", ['don', "'t"]], ['café', ['caf', 'é']], ['re-enter', ['re-', 'enter']], ['mother-in-law', ['mother', '-in-law']]]) {
    const raw = { translation: text, groups: parts.map(english => ({ english, chinese: '雨', occurrence: 0 })) };
    assert.throws(() => backend.parseAlignedResponse('雨', JSON.stringify(raw)), /对照/);
  }
});

test('cache is content bound, survives reopen, and returns independent validated copies', t => {
  const alignment = parsed().alignment, { directory, cache } = setup(t);
  assert.equal(cache.get(source, translation), null);
  cache.set(source, translation, alignment);
  alignment.spans[0].sourceStart = 0;
  const loaded = new backend.AlignmentCache(directory).get(source, translation);
  assert.equal(loaded.spans[0].sourceStart, 4);
  loaded.spans[0].sourceStart = 0;
  assert.equal(cache.get(source, translation).spans[0].sourceStart, 4);
  assert.equal(cache.get(source + '。', translation), null);
  assert.equal(cache.get(source, translation + '!'), null);
  assert.equal(fs.readdirSync(directory).length, 1);
});

test('corrupt, oversized, malformed and wrong-pair cache files are cache misses', t => {
  const alignment = parsed().alignment, { directory, cache } = setup(t);
  cache.set(source, translation, alignment);
  const cacheDir = path.join(directory, 'alignment-cache'), file = path.join(cacheDir, fs.readdirSync(cacheDir)[0]);
  const original = fs.readFileSync(file, 'utf8');
  for (const value of ['{private', 'x'.repeat(256 * 1024 + 1), JSON.stringify({ version: 999 }), original.replace(/"sourceStart":4/, '"sourceStart":999')]) {
    fs.writeFileSync(file, value);
    assert.equal(cache.get(source, translation), null);
  }
  cache.set(source, translation, alignment);
  const originalBytes = fs.readFileSync(file);
  cache.set('他在看雨。', translation, alignment.spans.length ? { version: 1, spans: [{ englishStart: 0, englishEnd: translation.length, sourceStart: 0, sourceEnd: 5 }] } : alignment);
  const other = fs.readdirSync(cacheDir).find(name => name !== path.basename(file));
  fs.writeFileSync(path.join(cacheDir, other), originalBytes);
  assert.equal(cache.get('他在看雨。', translation), null);
});

test('failed durable cache writes preserve the prior valid result and remove temporary files', t => {
  const alignment = parsed().alignment, { directory, cache } = setup(t);
  cache.set(source, translation, alignment);
  const replacement = { version: 1, spans: [{ englishStart: 0, englishEnd: translation.length, sourceStart: 0, sourceEnd: source.length }] };
  t.mock.method(fs, 'fsyncSync', () => { throw new Error('synthetic write failure'); });
  assert.throws(() => cache.set(source, translation, replacement));
  assert.deepEqual(cache.get(source, translation), alignment);
  assert.equal(fs.readdirSync(path.join(directory, 'alignment-cache')).length, 1);
});

test('model content and schema limits fail without exposing private payloads', () => {
  parsed();
  for (const raw of ['private text', '```json\n{}\n```', JSON.stringify({ translation: '', groups: [] }), 'x'.repeat(128 * 1024 + 1)]) {
    assert.throws(() => backend.parseAlignedResponse(source, raw), error => /对照/.test(error.message) && !/private/.test(error.message));
  }
});
