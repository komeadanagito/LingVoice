import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestTranslationJson } from '../src/main/translation-http';

const address = 'https://provider.example/v1/chat/completions';
const init = { method: 'POST', headers: { Authorization: 'Bearer private-key' }, body: '{"model":"test"}' };
const completion = { choices: [{ message: { content: '["你好"]' } }] };

test('transient socket interruption retries once and preserves request body', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.body, init.body);
    assert.equal(options.redirect, 'error');
    if (++calls === 1) throw new TypeError('private-key', { cause: Object.assign(new Error('private response'), { code: 'ECONNRESET' }) });
    return Response.json(completion);
  });
  assert.deepEqual(await requestTranslationJson(address, init), completion);
  assert.equal(calls, 2);
});

test('retryable upstream status retries once while authentication failure is immediate and sanitized', async t => {
  let status = 503;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('private-key private response', { status, headers: { 'retry-after': '0' } });
  });
  await assert.rejects(requestTranslationJson(address, init), /HTTP 503/);
  assert.equal(calls, 2);
  status = 401;
  calls = 0;
  await assert.rejects(requestTranslationJson(address, init), error => {
    assert.match((error as Error).message, /HTTP 401.*API key/);
    assert.doesNotMatch((error as Error).message, /private-key|private response/);
    return true;
  });
  assert.equal(calls, 1);
});

test('long retry-after and permanent DNS failure avoid automatic retry', async t => {
  let calls = 0;
  let dns = false;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (dns) throw new TypeError('private hostname', { cause: { code: 'ENOTFOUND' } });
    return new Response('', { status: 429, headers: { 'retry-after': '60' } });
  });
  await assert.rejects(requestTranslationJson(address, init), /HTTP 429/);
  assert.equal(calls, 1);
  dns = true;
  await assert.rejects(requestTranslationJson(address, init), /ENOTFOUND/);
  assert.equal(calls, 2);
});

test('empty response retries once; HTML, malformed JSON and oversized replies have distinct safe errors', async t => {
  let kind = 'empty';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (kind === 'empty') return new Response('');
    if (kind === 'html') return new Response('<html>private-key</html>', { headers: { 'content-type': 'text/html' } });
    if (kind === 'large') return new Response('private-key', { headers: { 'content-length': '2000001' } });
    return new Response('private-key private response');
  });
  for (const [type, pattern] of [['empty', /empty response/], ['html', /HTML page/], ['json', /incomplete JSON/], ['large', /size limit/]] as const) {
    kind = type;
    await assert.rejects(requestTranslationJson(address, init), error => {
      assert.match((error as Error).message, pattern);
      assert.doesNotMatch((error as Error).message, /private-key|private response/);
      return true;
    });
  }
  assert.equal(calls, 5);
});

test('OpenAI SSE deltas, Unicode and reasoning fields convert into a compatible completion', async t => {
  const raw = [
    ': keepalive\n\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'ignore' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '["你' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '好"]' }, finish_reason: 'stop' }] }) + '\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const encoded = new TextEncoder().encode(raw);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } }));
  assert.deepEqual(await requestTranslationJson(address, init), completion);
});

test('Responses SSE uses the completed response; truncated streams fail instead of accepting partial translations', async t => {
  let body = 'data: ' + JSON.stringify({ type: 'response.completed', response: { output_text: '["你好"]' } }) + '\n\n';
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  assert.deepEqual(await requestTranslationJson(address, init), { output_text: '["你好"]' });
  body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '["你' }, finish_reason: 'length' }] }) + '\n\n';
  await assert.rejects(requestTranslationJson(address, init), /token limit/);
});

test('cancellation during retry backoff prevents another charged request', async t => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } });
  });
  await assert.rejects(requestTranslationJson(address, init, controller.signal), /cancelled/);
  assert.equal(calls, 1);
});
