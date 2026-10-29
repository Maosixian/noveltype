const test = require('node:test');
const assert = require('node:assert/strict');
let backend;
try { backend = require('../app/translation.cjs'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const settings = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
const success = content => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) });
const options = fetchImpl => ({ source: '河水缓缓流过村庄。', settings, apiKey: 'fixture-key', fetchImpl });
function ready() { assert.equal(typeof backend?.translateText, 'function', 'Translation backend must be implemented'); }
test('settings require HTTPS and refuse credentials, query, hash, provider and model injection', () => {
  ready();
  assert.deepEqual(backend.validateSettings(settings), settings);
  for (const baseUrl of ['http://api.example.com', 'https://user:pass@example.com', 'https://example.com?key=bad', 'https://example.com#bad', 'file:///test', '']) {
    assert.throws(() => backend.validateSettings({ ...settings, baseUrl }), /地址|HTTPS/);
  }
  assert.throws(() => backend.validateSettings({ ...settings, model: '\nwrong' }), /模型/);
  assert.throws(() => backend.validateSettings({ ...settings, provider: 'unknown' }), /服务商/);
});
test('one current passage request uses DeepSeek non-thinking, safe prompt and keyboard punctuation', async () => {
  ready(); let calls = 0;
  const translation = await backend.translateText(options(async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 1800);
    assert.equal(body.messages.length, 2);
    assert.match(body.messages[0].content, /untrusted|instructions/i);
    assert.equal(body.messages[1].content, options().source);
    return success('“Don’t hurry,” she said—“wait…”');
  }));
  assert.equal(translation, '"Don\'t hurry," she said-"wait..."');
  assert.equal(calls, 1);
});
test('OpenAI uses max_completion_tokens and endpoint suffix is appended only once', async () => {
  ready();
  await backend.translateText({ ...options(async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(request.body);
    assert.equal(body.max_completion_tokens, 1800);
    assert.equal('max_tokens' in body, false);
    assert.equal('thinking' in body, false);
    return success('The river flowed past the village.');
  }), settings: { provider: 'openai', baseUrl: 'https://api.openai.com/v1/chat/completions/', model: 'gpt-4.1-mini' } });
});
test('missing key and empty source fail before request', async () => {
  ready(); let calls = 0;
  const args = options(async () => { calls++; return success('Text'); });
  await assert.rejects(backend.translateText({ ...args, apiKey: '' }), /API Key/);
  await assert.rejects(backend.translateText({ ...args, source: '' }), /原文/);
  assert.equal(calls, 0);
});
test('upstream HTTP failures and network details are redacted and never retried', async () => {
  ready(); let calls = 0;
  await assert.rejects(backend.translateText(options(async () => {
    calls++; return { ok: false, status: 401, json: async () => ({ error: 'fixture-key private text' }) };
  })), error => /401/.test(error.message) && !/fixture-key|private text/.test(error.message));
  assert.equal(calls, 1);
  await assert.rejects(backend.translateText(options(async () => { throw new Error('network fixture-key private text'); })), error => /连接|网络/.test(error.message) && !/fixture-key|private text/.test(error.message));
});
test('empty, truncated, refused, malformed, redirected and huge output are rejected', async () => {
  ready();
  const results = [
    { choices: [] }, { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
    { choices: [{ finish_reason: 'length', message: { content: 'Partial' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'No', refusal: 'policy' } }] },
    { choices: [{ finish_reason: 'content_filter', message: { content: 'No' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'x'.repeat(10001) } }] }
  ];
  for (const result of results) await assert.rejects(backend.translateText(options(async () => ({ ok: true, status: 200, json: async () => result }))), /译文|翻译|响应/);
  await assert.rejects(backend.translateText(options(async () => ({ ...success('Hello'), redirected: true }))), /重定向/);
  await assert.rejects(backend.translateText(options(async () => ({ ok: true, status: 200, json: async () => { throw new Error('secret body'); } }))), /响应/);
});
test('connection check sends only minimal fixed text and returns honest success', async () => {
  ready();
  const result = await backend.testConnection(options(async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.ok(body.messages[1].content.length < 10);
    assert.ok(body.max_tokens <= 64);
    return success('Hello.');
  }));
  assert.equal(result.ok, true);
  assert.match(result.message, /成功/);
});
test('timeout aborts at 90 seconds without sending another request', async t => {
  ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const promise = backend.translateText(options(async (_url, request) => {
    calls++;
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }));
  const assertion = assert.rejects(promise, /超时/);
  t.mock.timers.tick(90000);
  await assertion;
  assert.equal(calls, 1);
});
test('GLM 4.7 uses non-thinking while GLM 5.3 uses its supported low reasoning mode', async () => {
  ready();
  for (const model of ['glm-4.7-flash', 'glm-5.3-flash']) {
    await backend.translateText({ ...options(async (url, request) => {
      assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
      const body = JSON.parse(request.body);
      if (model.startsWith('glm-5.3')) {
        assert.equal(body.max_tokens, 4096);
        assert.deepEqual(body.thinking, { type: 'enabled' });
        assert.equal(body.reasoning_effort, 'low');
      } else {
        assert.equal(body.max_tokens, 2048);
        assert.deepEqual(body.thinking, { type: 'disabled' });
      }
      return success('The river flows.');
    }), settings: { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model } });
  }
});
test('real response streams are bounded and malformed JSON does not leak response contents', async () => {
  ready();
  await assert.rejects(backend.translateText(options(async () => new Response('x'.repeat(129 * 1024), { status: 200 }))), /响应过大/);
  await assert.rejects(backend.translateText(options(async () => new Response('private fixture-key body', { status: 200 }))), error => /响应/.test(error.message) && !/fixture-key|private/.test(error.message));
});
test('GLM 5.3 connection check has enough room for compulsory reasoning', async () => {
  ready();
  await backend.testConnection({ ...options(async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.messages[1].content, '你好。');
    return success('Hello.');
  }), settings: { provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' } });
});
test('OpenAI connection check leaves room for reasoning before the visible response', async () => {
  ready();
  let body;
  await backend.testConnection({ ...options(async (_url, request) => {
    body = JSON.parse(request.body);
    return success('Hello.');
  }), settings: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' } });
  assert.equal(body.max_completion_tokens, 2048);
  assert.equal(body.messages[1].content, '你好。');
  assert.equal('max_tokens' in body, false);
});
