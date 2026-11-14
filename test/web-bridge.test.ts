import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWebMock } from '../src/renderer/web-mock';
import type {} from '../src/renderer/env';
import type { LingVoiceApi } from '../src/shared/contracts';

test('Web bridge distinguishes transport, proxy, malformed and provider errors without automatic retries', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const browser = {} as { lingvoice: LingVoiceApi };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  installWebMock();
  const cases = [
    { name: 'whitespace heartbeat JSON', response: () => new Response(' \n \n{"ok":true,"data":["你好"]}'), expected: { ok: true, data: ['你好'] } },
    { name: 'provider error', response: () => Response.json({ ok: false, error: 'Translation provider request failed: HTTP 401.' }), expected: { ok: false, error: 'Translation provider request failed: HTTP 401.' } },
    { name: 'localized server error', response: () => Response.json({ ok: false, error: 'Invalid URL', errorKey: 'errors.urlLength' }, { status: 403 }), expected: { ok: false, error: 'Invalid URL', errorKey: 'errors.urlLength' } },
    { name: 'proxy timeout HTML', response: () => new Response('<html>Gateway timeout</html>', { status: 504 }), pattern: /HTTP 504.*proxy/ },
    { name: 'truncated JSON', response: () => new Response(' \n{"ok":true,'), pattern: /incomplete or invalid/ },
    { name: 'wrong JSON envelope', response: () => Response.json({ message: 'proxy failed' }), pattern: /unexpected response/ },
    { name: 'null JSON envelope', response: () => Response.json(null), pattern: /unexpected response/ },
    { name: 'successful envelope with failing status', response: () => Response.json({ ok: true, data: [] }, { status: 502 }), pattern: /HTTP 502/ },
    { name: 'lost socket or server restart', response: () => { throw new TypeError('Failed to fetch'); }, pattern: /connection.*interrupted/ },
    { name: 'response body connection lost', response: () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } })), pattern: /incomplete or invalid/ },
  ];
  for (const item of cases) {
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(input, '/api/lingvoice/translation-run');
      assert.deepEqual(JSON.parse(init!.body as string), { texts: ['Hello'] });
      return item.response();
    };
    const result = await browser.lingvoice.translateSubtitles({ texts: ['Hello'] });
    if ('expected' in item) assert.deepEqual(result, item.expected, item.name);
    else {
      assert.equal(result.ok, false, item.name);
      if (result.ok) throw new Error('Expected a failure');
      assert.match(result.error, item.pattern!, item.name);
      assert.match(result.error, /avoid duplicate provider charges/, item.name);
      assert.equal(result.errorKey, undefined, 'do not relabel this as a proven service outage');
    }
    assert.equal(calls, 1, `${item.name}: never repeat a potentially billable request`);
  }
});

test('Web bridge preserves explicit cancellation instead of reporting a service outage', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const browser = {} as { lingvoice: LingVoiceApi };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  installWebMock();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async (input, init) => {
    if (input === '/api/lingvoice/asr-cancel') return Response.json({ ok: true });
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      started();
    });
  };
  const running = browser.lingvoice.transcribe({ file: 'upload:test' });
  await ready;
  await browser.lingvoice.cancelAsr();
  assert.deepEqual(await running, { ok: false, error: 'Task cancelled.' });
});
