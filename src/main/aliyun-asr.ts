/** Alibaba Cloud Qwen ASR uses JSON Chat Completions, not multipart transcription. */
export function aliyunAsrEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  let prefix = url.pathname.replace(/\/+$/, '');
  // Accept saved native endpoints and migrate them to the documented compatible API.
  prefix = prefix.replace(/\/api\/v1(?:\/services\/aigc\/multimodal-generation\/generation)?$/, '/compatible-mode/v1');
  prefix = prefix.replace(/\/(?:chat\/completions|audio\/transcriptions)$/, '');
  if (!prefix) prefix = '/compatible-mode/v1';
  else if (!/\/v\d+$/.test(prefix)) prefix += '/compatible-mode/v1';
  url.pathname = `${prefix}/chat/completions`;
  return url.toString();
}
