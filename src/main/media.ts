import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

export function byteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { start, end };
}

export async function mediaResponse(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== 'local' || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 400 });
  let file = decodeURIComponent(url.pathname);
  if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(file)) file = file.slice(1);
  if (!path.isAbsolute(file)) return new Response(null, { status: 400 });
  try {
    const info = await stat(file);
    if (!info.isFile()) return new Response(null, { status: 404 });
    const types: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo' };
    const headers = new Headers({ 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' });
    const rangeHeader = request.headers.get('range');
    const range = rangeHeader ? byteRange(rangeHeader, info.size) : null;
    if (rangeHeader && !range) {
      headers.set('Content-Range', `bytes */${info.size}`);
      return new Response(null, { status: 416, headers });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
    const stream = request.method === 'HEAD' || !info.size ? null : Readable.toWeb(createReadStream(file, { start, end, signal: request.signal })) as ReadableStream<Uint8Array>;
    return new Response(stream, { status: range ? 206 : 200, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}
