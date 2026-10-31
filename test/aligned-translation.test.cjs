'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const backend = require('../app/translation.cjs');
const source = '他推开了门。';
const translation = 'He opened the door.';
const settings = { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' };
const raw = () => ({ translation, groups: [
  { english: 'He', chinese: '他', occurrence: 0 },
  { english: 'opened', chinese: '推开了', occurrence: 0 },
  { english: 'the door.', chinese: '门', occurrence: 0 },
] });
const success = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }), { status: 200 });
const options = fetchImpl => ({ source, settings, apiKey: 'fixture-alignment-key', fetchImpl });

test('new passage uses one safe GLM request for translation and semantic phrase alignment', async () => {
  assert.equal(typeof backend.translateAlignedText, 'function');
  let calls = 0;
  const result = await backend.translateAlignedText(options(async (url, request) => {
    calls++;
    assert.equal(url, settings.baseUrl + '/chat/completions');
    assert.equal(request.redirect, 'error');
    const body = JSON.parse(request.body);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.reasoning_effort, 'low');
    assert.match(body.messages[0].content, /untrusted/);
    assert.match(body.messages[0].content, /occurrence/);
    assert.equal(JSON.parse(body.messages[1].content).source, source);
    return success(raw());
  }));
  assert.equal(result.translation, translation);
  assert.equal(result.alignment.spans.length, 3);
  assert.equal(calls, 1);
});

test('existing text is sent as data and preserved; a rewritten translation is rejected without retry', async () => {
  assert.equal(typeof backend.alignExistingText, 'function');
  let calls = 0;
  const result = await backend.alignExistingText({ ...options(async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    assert.deepEqual(JSON.parse(body.messages[1].content), { source, translation });
    return success(raw());
  }), translation });
  assert.equal(result.translation, translation);
  assert.equal(calls, 1);
  await assert.rejects(backend.alignExistingText({ ...options(async () => { calls++; return success({ ...raw(), translation: 'Different.' }); }), translation }), /对照/);
  assert.equal(calls, 2);
});

test('invalid existing text is rejected before sending any request', async () => {
  assert.equal(typeof backend.alignExistingText, 'function');
  let calls = 0;
  for (const translation of ['', ' ', 'x'.repeat(10001), '\ud800', 'private\u0000text']) {
    await assert.rejects(backend.alignExistingText({ ...options(async () => { calls++; return success(raw()); }), translation }), /译文/);
  }
  assert.equal(calls, 0);
});

test('new translation normalizes keyboard typography before resolving English ranges', async () => {
  assert.equal(typeof backend.translateAlignedText, 'function');
  const result = await backend.translateAlignedText({ ...options(async () => success({ translation: '“Hello…”', groups: [{ english: '“Hello…”', chinese: '你好', occurrence: 0 }] })), source: '你好。' });
  assert.equal(result.translation, '"Hello..."');
  assert.equal(result.alignment.spans[0].englishEnd, result.translation.length);
});

test('invalid alignment and provider errors are safe failures with no hidden retry', async () => {
  assert.equal(typeof backend.translateAlignedText, 'function');
  let calls = 0;
  for (const reply of [success('private fixture-alignment-key malformed'), success({ ...raw(), groups: raw().groups.slice(1) }), new Response('private fixture-alignment-key', { status: 500 })]) {
    await assert.rejects(backend.translateAlignedText(options(async () => { calls++; return reply; })), error => /对照|500/.test(error.message) && !/private|fixture-alignment-key/.test(error.message));
  }
  assert.equal(calls, 3);
});

test('existing alignment timeout remains bounded to one request', async t => {
  assert.equal(typeof backend.alignExistingText, 'function');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const promise = backend.alignExistingText({ ...options(async (_url, request) => {
    calls++;
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }), translation });
  const assertion = assert.rejects(promise, /超时/);
  t.mock.timers.tick(90000);
  await assertion;
  assert.equal(calls, 1);
});
