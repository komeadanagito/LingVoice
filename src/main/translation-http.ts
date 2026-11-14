const MAX_RESPONSE_BYTES = 2_000_000;
const TIMEOUT_MS = 600_000;

class RequestFailure extends Error {
  constructor(message: string, readonly retryable = false, readonly delay = 1000) {
    super(`Translation provider request failed: ${message}`);
  }
}

function networkFailure(error: unknown): RequestFailure {
  // Expose only known transport codes, never raw messages, URLs, headers or response bodies.
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string') codes.push(value.code);
    current = value.cause;
  }
  if (codes.includes('ENOTFOUND')) return new RequestFailure('DNS lookup failed (ENOTFOUND). Check the provider hostname.');
  if (codes.includes('ECONNREFUSED')) return new RequestFailure('Connection refused (ECONNREFUSED). Check the provider address and service.');
  if (codes.some(code => ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code))) {
    return new RequestFailure('TLS certificate verification failed. Check the provider certificate; certificate verification remains enabled.');
  }
  const transient = codes.find(code => ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code));
  return transient
    ? new RequestFailure(`Connection interrupted or upstream response timed out (${transient}). Retry with a smaller subtitle batch if this persists.`, true)
    : new RequestFailure('Network connection or response transfer failed. Check the provider connection and try again.');
}

function wait(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(new Error('Aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function streamJson(body: string): unknown {
  let content = '';
  let complete = false;
  let result: unknown;
  for (const event of body.replace(/\r\n/g, '\n').split(/\n\n/)) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data.trim() === '[DONE]') { complete = true; continue; }
    let value: any;
    try { value = JSON.parse(data); }
    catch { throw new RequestFailure('The provider returned a malformed streaming response.'); }
    if (value.error || value.type === 'error' || value.type === 'response.failed') throw new RequestFailure('The provider reported a streaming generation error.');
    const choice = value.choices?.find((item: any) => item.index === 0 || item.index === undefined);
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (typeof choice?.message?.content === 'string') content = choice.message.content;
    if (choice?.finish_reason === 'length') throw new RequestFailure('The model output was truncated by its token limit. Reduce subtitle batch size or increase the provider output limit.');
    if (choice?.finish_reason === 'stop') complete = true;
    if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') content += value.delta;
    if (value.type === 'response.completed') { complete = true; result = value.response; }
  }
  if (!complete) throw new RequestFailure('The provider streaming response ended before completion.', true);
  if (result) return result;
  if (!content.trim()) throw new RequestFailure('The provider returned no translated text in its streaming response.');
  return { choices: [{ message: { content } }] };
}

async function once(address: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetch(address, { ...init, signal, redirect: 'error' }); }
  catch (error) { throw networkFailure(error); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    const guidance = status === 401 || status === 403 ? 'Check the API key and model permissions.'
      : status === 404 ? 'Check the endpoint path and selected model availability.'
      : status === 429 ? 'The provider rate or quota limit was reached.'
      : status === 400 || status === 422 ? 'The provider rejected the model or request parameters.'
      : 'The upstream service is unavailable.';
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
    // Honor long Retry-After periods by failing visibly rather than retrying too early.
    throw new RequestFailure(`HTTP ${status}. ${guidance}`, [429, 500, 502, 503, 504].includes(status) && delay <= 5000, delay);
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new RequestFailure('The provider response exceeded the 2 MB size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RequestFailure('The provider returned an empty response.', true);
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new RequestFailure('The provider response exceeded the 2 MB size limit.');
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    throw error instanceof RequestFailure ? error : networkFailure(error);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!body.trim()) throw new RequestFailure('The provider returned an empty response.', true);
  const contentType = response.headers.get('content-type') || '';
  if (/text\/event-stream/i.test(contentType) || /^\s*(?:data:|event:|:)/.test(body)) return streamJson(body);
  if (/text\/html/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(body)) {
    throw new RequestFailure('The endpoint returned an HTML page instead of JSON. Check the API address or upstream proxy.');
  }
  try { return JSON.parse(body) as unknown; }
  catch { throw new RequestFailure('The provider returned invalid or incomplete JSON. Check the API format and upstream proxy.'); }
}

/** One bounded retry for recoverable transport/upstream failures; cancellation never retries. */
export async function requestTranslationJson(address: string, init: RequestInit, externalSignal?: AbortSignal): Promise<unknown> {
  externalSignal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  externalSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await once(address, init, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        if (!(error instanceof RequestFailure) || !error.retryable || attempt >= 1) throw error;
        // A retry can incur a second upstream charge; keep it to one attempt.
        await wait(error.delay, controller.signal);
      }
    }
  } catch (error) {
    if (externalSignal?.aborted) throw new Error('Translation request cancelled.');
    if (controller.signal.aborted) throw new Error('Translation request timed out.');
    if (error instanceof RequestFailure) throw error;
    throw networkFailure(error);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', cancel);
  }
}
