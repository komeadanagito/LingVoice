import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { once } from 'node:events';
import type { DownloadEvent, DownloadResult, VideoInfo } from '../shared/contracts';
import { LocalizedError } from '../shared/i18n/translate';

const BILI_ORIGIN = 'https://www.bilibili.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

export const BILI_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Referer: `${BILI_ORIGIN}/`,
  Origin: BILI_ORIGIN,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

interface WbiCache { key: string; ts: number }
let wbiCache: WbiCache | null = null;

export function resetWbiCache(): void { wbiCache = null; }

export function canonicalizeBiliUrl(input: string): string {
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  const isShort = host === 'b23.tv' || host === 'www.b23.tv';
  const isVideo = (host === 'www.bilibili.com' || host === 'bilibili.com' || host === 'm.bilibili.com')
    && /^\/video\/(BV[a-zA-Z0-9]+|av\d+)\/?$/i.test(url.pathname);
  if (!isShort && !isVideo) throw new LocalizedError('errors.urlUnsupported');
  url.protocol = 'https:';
  url.hash = '';
  if (isShort) {
    url.hostname = 'b23.tv';
    url.search = '';
    return url.toString();
  }
  url.hostname = 'www.bilibili.com';
  const part = url.searchParams.get('p');
  url.search = '';
  if (part && /^\d+$/.test(part) && Number(part) > 0) url.searchParams.set('p', part);
  return url.toString();
}

export function parseBilibiliVideo(input: string): { bvid?: string; aid?: string; page: number } {
  const url = new URL(canonicalizeBiliUrl(input));
  if (url.hostname === 'b23.tv') return { page: 1 };
  const match = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]+|av\d+)\/?$/i);
  if (!match) throw new LocalizedError('errors.bilibiliExtract');
  const id = match[1];
  const pageValue = url.searchParams.get('p');
  const page = pageValue && /^\d+$/.test(pageValue) ? Number(pageValue) : 1;
  if (id.toLowerCase().startsWith('av')) return { aid: id.slice(2), page };
  return { bvid: id, page };
}

export function windowsFileName(name: string, max = 160): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim() || 'video';
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).replace(/[. ]+$/g, '') || 'video';
}

export function parseNetscapeCookies(text: string): string {
  const parts: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const httpOnly = rawLine.startsWith('#HttpOnly_');
    if (!rawLine || (rawLine.startsWith('#') && !httpOnly)) continue;
    const line = httpOnly ? rawLine.slice('#HttpOnly_'.length) : rawLine;
    const columns = line.split('\t');
    if (columns.length < 7) continue;
    const domain = columns[0].replace(/^\./, '').toLowerCase();
    if (!domain.endsWith('bilibili.com') && domain !== 'b23.tv') continue;
    const name = columns[5];
    const value = columns[6];
    if (!name) continue;
    parts.push(`${name}=${value}`);
  }
  return parts.join('; ');
}

export function selectHeight(streams: Array<{ height: number }>, height: unknown): number {
  const unique = [...new Set(streams.map(stream => stream.height).filter(value => value > 0))].sort((a, b) => b - a);
  if (!unique.length) throw new LocalizedError('errors.bilibiliStream');
  if (height === 'best') return unique[0];
  const cap = typeof height === 'string' || typeof height === 'number' ? Number(height) : NaN;
  if (!Number.isInteger(cap) || cap < 1 || cap > 4320) throw new LocalizedError('errors.quality');
  return unique.find(value => value <= cap) ?? unique[unique.length - 1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function numberValue(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
function throwIfAborted(signal?: AbortSignal, partial = false): void {
  if (signal?.aborted) throw new LocalizedError(partial ? 'errors.cancelledPartial' : 'errors.cancelled');
}
function fileKey(url: string): string {
  const name = url.split('/').pop()?.split('?')[0] ?? '';
  return name.replace(/\.[^.]+$/, '') || 'wbi';
}
function mixinKey(imgKey: string, subKey: string): string {
  const lookup = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map(index => lookup[index] ?? '').join('').slice(0, 32);
}
function encodeQuery(params: Record<string, string>): string {
  return Object.keys(params).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key]).replace(/%20/g, '+')}`).join('&');
}
export function signWbi(params: Record<string, string | number>, key: string, timestamp: number): Record<string, string> {
  const signed: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...params, wts: timestamp })) {
    signed[name] = [...String(value)].filter(char => !"!'()*".includes(char)).join('');
  }
  const query = encodeQuery(signed);
  signed.w_rid = crypto.createHash('md5').update(`${query}${key}`).digest('hex');
  return signed;
}
function randomPrintable(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function dmParams(): Record<string, string> {
  const encode = (value: string) => Buffer.from(value).toString('base64').slice(0, -2);
  const width = 1920;
  const height = 1080;
  const rnd = Math.floor(114 * Math.random());
  const ofRnd = Math.floor(514 * Math.random());
  return {
    dm_img_list: '[]',
    dm_img_str: encode(randomPrintable(16 + Math.floor(Math.random() * 48))),
    dm_cover_img_str: encode(randomPrintable(32 + Math.floor(Math.random() * 96))),
    dm_img_inter: JSON.stringify({
      ds: [],
      wh: [2 * width + 2 * height + 3 * rnd, 4 * width - height + rnd, rnd],
      of: [3 * 10 + 2 * 10 + ofRnd, 4 * 10 - 4 * 10 + 2 * ofRnd, ofRnd],
    }),
  };
}

async function readCookieHeader(cookieFile?: string): Promise<string> {
  const generated = `buvid3=${crypto.randomUUID()}infoc; b_nut=${Math.floor(Date.now() / 1000)}`;
  if (!cookieFile) return generated;
  const text = await fs.readFile(cookieFile, 'utf8');
  const parsed = parseNetscapeCookies(text);
  return parsed ? `${parsed}; ${generated}` : generated;
}

function requestHeaders(cookieHeader: string): Record<string, string> {
  return { ...BILI_HEADERS, Cookie: cookieHeader };
}

async function fetchJson(url: string, cookieHeader: string, signal?: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  const response = await fetch(url, { headers: requestHeaders(cookieHeader), signal: signal ?? AbortSignal.timeout(25000) });
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalizedError('errors.bilibiliExtract');
  }
}

async function getWbiKey(cookieHeader: string, signal?: AbortSignal): Promise<string> {
  if (wbiCache && Date.now() < wbiCache.ts + 30_000) return wbiCache.key;
  const value = await fetchJson('https://api.bilibili.com/x/web-interface/nav', cookieHeader, signal);
  const img = isRecord(value) && isRecord(value.data) && isRecord(value.data.wbi_img) ? value.data.wbi_img : null;
  const imgUrl = textValue(img?.img_url);
  const subUrl = textValue(img?.sub_url);
  if (!imgUrl || !subUrl) throw new LocalizedError('errors.bilibiliExtract');
  const key = mixinKey(fileKey(imgUrl), fileKey(subUrl));
  wbiCache = { key, ts: Date.now() };
  return key;
}

async function signedUrl(base: string, params: Record<string, string | number>, cookieHeader: string, signal?: AbortSignal): Promise<string> {
  const key = await getWbiKey(cookieHeader, signal);
  const query = new URLSearchParams(signWbi(params, key, Math.round(Date.now() / 1000)));
  return `${base}?${query.toString()}`;
}

export async function resolveBilibiliUrl(input: string, signal?: AbortSignal): Promise<string> {
  const url = canonicalizeBiliUrl(input);
  if (new URL(url).hostname !== 'b23.tv') return url;
  let current = url;
  for (let index = 0; index < 8; index += 1) {
    throwIfAborted(signal);
    const response = await fetch(current, { method: 'GET', redirect: 'manual', headers: BILI_HEADERS, signal: signal ?? AbortSignal.timeout(15000) });
    await response.body?.cancel();
    if (response.status < 300 || response.status >= 400) return canonicalizeBiliUrl(response.url || current);
    const location = response.headers.get('location');
    if (!location) return canonicalizeBiliUrl(current);
    current = new URL(location, current).toString();
  }
  return canonicalizeBiliUrl(current);
}

interface BiliPage { cid: number; page: number; part: string; duration: number }
interface BiliView {
  bvid: string;
  aid: number;
  title: string;
  uploader: string;
  thumbnail: string;
  duration: number;
  pages: BiliPage[];
}
interface BiliStream { url: string; backups: string[]; height: number; bandwidth: number; isAudio: boolean }

interface PlayurlCacheEntry { streams: BiliStream[]; ts: number }
const PLAYURL_CACHE_MS = 5 * 60_000;
const playurlCache = new Map<string, PlayurlCacheEntry>();

export function resetPlayurlCache(): void { playurlCache.clear(); }

function asPages(value: unknown): BiliPage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item)) return [];
    const cid = numberValue(item.cid);
    const page = numberValue(item.page) || 1;
    if (!cid) return [];
    return [{ cid, page, part: textValue(item.part), duration: numberValue(item.duration) }];
  });
}

function viewFromPayload(value: unknown): BiliView {
  if (!isRecord(value) || numberValue(value.code) !== 0 || !isRecord(value.data)) throw new LocalizedError('errors.bilibiliExtract');
  const data = value.data;
  const pages = asPages(data.pages);
  const bvid = textValue(data.bvid);
  if (!bvid || !pages.length) throw new LocalizedError('errors.bilibiliExtract');
  const owner = isRecord(data.owner) ? data.owner : {};
  const pic = textValue(data.pic).replace(/^http:\/\//i, 'https://');
  return {
    bvid,
    aid: numberValue(data.aid),
    title: textValue(data.title),
    uploader: textValue(owner.name),
    thumbnail: pic.startsWith('https://') ? pic : '',
    duration: numberValue(data.duration),
    pages,
  };
}

function streamUrls(value: Record<string, unknown>): { url: string; backups: string[] } {
  const backup = Array.isArray(value.backupUrl) ? value.backupUrl : Array.isArray(value.backup_url) ? value.backup_url : [];
  const isHttp = (item: string) => item.startsWith('https://') || item.startsWith('http://');
  const primary = [value.baseUrl, value.base_url, value.url].map(textValue).find(isHttp) ?? '';
  const backups = backup.map(textValue).filter(isHttp);
  return { url: primary || backups[0] || '', backups };
}

function playurlError(value: unknown): LocalizedError {
  const code = isRecord(value) ? numberValue(value.code) : 0;
  const message = isRecord(value) ? textValue(value.message) : '';
  return new LocalizedError('errors.bilibiliStreamDetail', { code: String(code || 'http'), message: (message || 'empty response').slice(0, 120) });
}

function extractStreams(value: unknown): BiliStream[] {
  if (!isRecord(value) || numberValue(value.code) !== 0 || !isRecord(value.data)) throw playurlError(value);
  const data = value.data;
  const streams: BiliStream[] = [];
  const dash = isRecord(data.dash) ? data.dash : null;
  const videos = dash && Array.isArray(dash.video) ? dash.video : [];
  const audios = dash && Array.isArray(dash.audio) ? dash.audio : [];
  const dolby = dash && isRecord(dash.dolby) && Array.isArray(dash.dolby.audio) ? dash.dolby.audio : [];
  const flac = dash && isRecord(dash.flac) && isRecord(dash.flac.audio) ? [dash.flac.audio] : [];
  for (const item of videos) {
    if (!isRecord(item)) continue;
    const { url, backups } = streamUrls(item);
    const height = numberValue(item.height);
    if (!url || height <= 0) continue;
    streams.push({ url, backups, height, bandwidth: numberValue(item.bandwidth), isAudio: false });
  }
  for (const item of [...audios, ...dolby, ...flac]) {
    if (!isRecord(item)) continue;
    const { url, backups } = streamUrls(item);
    if (!url) continue;
    streams.push({ url, backups, height: 0, bandwidth: numberValue(item.bandwidth), isAudio: true });
  }
  const fragments = Array.isArray(data.durl) ? data.durl : [];
  if (!streams.length && fragments.length && isRecord(fragments[0])) {
    const { url, backups } = streamUrls(fragments[0]);
    if (url) streams.push({ url, backups, height: numberValue(data.quality) || 720, bandwidth: numberValue(fragments[0].size), isAudio: false });
  }
  if (!streams.length) throw playurlError(value);
  return streams;
}

async function fetchView(target: { bvid?: string; aid?: string }, cookieHeader: string, signal?: AbortSignal): Promise<BiliView> {
  const params: Record<string, string> = target.bvid ? { bvid: target.bvid } : { aid: target.aid! };
  try {
    const signed = await signedUrl('https://api.bilibili.com/x/web-interface/wbi/view', params, cookieHeader, signal);
    return viewFromPayload(await fetchJson(signed, cookieHeader, signal));
  } catch {
    const unsigned = `https://api.bilibili.com/x/web-interface/view?${new URLSearchParams(params).toString()}`;
    return viewFromPayload(await fetchJson(unsigned, cookieHeader, signal));
  }
}

async function fetchPlayurl(bvid: string, cid: number, cookieHeader: string, signal?: AbortSignal): Promise<BiliStream[]> {
  const cacheKey = `${bvid}:${cid}`;
  const cached = playurlCache.get(cacheKey);
  if (cached && Date.now() < cached.ts + PLAYURL_CACHE_MS) return cached.streams;

  const attempts: Array<{ label: string; run: () => Promise<unknown> }> = [
    {
      label: 'wbi-dash',
      run: async () => {
        const signed = await signedUrl('https://api.bilibili.com/x/player/wbi/playurl', {
          bvid, cid, fnval: 4048, fourk: 1, platform: 'web', ...dmParams(),
        }, cookieHeader, signal);
        return fetchJson(signed, cookieHeader, signal);
      },
    },
    {
      label: 'wbi-minimal',
      run: async () => {
        const signed = await signedUrl('https://api.bilibili.com/x/player/wbi/playurl', {
          bvid, cid, fnval: 4048, platform: 'web',
        }, cookieHeader, signal);
        return fetchJson(signed, cookieHeader, signal);
      },
    },
    {
      label: 'legacy-dash',
      run: async () => {
        const query = new URLSearchParams({ bvid, cid: String(cid), fnval: '4048', platform: 'web' });
        return fetchJson(`https://api.bilibili.com/x/player/playurl?${query.toString()}`, cookieHeader, signal);
      },
    },
    {
      label: 'legacy-durl',
      run: async () => {
        const query = new URLSearchParams({ bvid, cid: String(cid), fnval: '16', platform: 'html5' });
        return fetchJson(`https://api.bilibili.com/x/player/playurl?${query.toString()}`, cookieHeader, signal);
      },
    },
  ];

  let lastError: unknown = new LocalizedError('errors.bilibiliStream');
  for (const attempt of attempts) {
    throwIfAborted(signal);
    try {
      const streams = extractStreams(await attempt.run());
      playurlCache.set(cacheKey, { streams, ts: Date.now() });
      return streams;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function pickPage(view: BiliView, page: number): BiliPage {
  return view.pages.find(item => item.page === page) ?? view.pages[0];
}

export async function inspectBilibili(input: string, cookieFile?: string, signal?: AbortSignal): Promise<VideoInfo> {
  const resolved = await resolveBilibiliUrl(input, signal);
  const parsed = parseBilibiliVideo(resolved);
  if (!parsed.bvid && !parsed.aid) throw new LocalizedError('errors.bilibiliExtract');
  const cookieHeader = await readCookieHeader(cookieFile);
  const view = await fetchView(parsed, cookieHeader, signal);
  const page = pickPage(view, parsed.page);
  let heights: number[] = [];
  try {
    const streams = await fetchPlayurl(view.bvid, page.cid, cookieHeader, signal);
    heights = [...new Set(streams.filter(stream => !stream.isAudio && stream.height > 0).map(stream => stream.height))].sort((a, b) => b - a);
  } catch (error) {
    if (signal?.aborted) throw error;
    // Keep title and cover available even when playback streams are gated.
  }
  const id = view.pages.length > 1 ? `${view.bvid}_p${page.page}` : view.bvid;
  return {
    id,
    title: view.title || '未命名视频',
    uploader: view.uploader || '未知 UP 主',
    ...(!view.title ? { titleKey: 'video.untitled' as const } : {}),
    ...(!view.uploader ? { uploaderKey: 'video.unknownUploader' as const } : {}),
    duration: page.duration || view.duration,
    thumbnail: view.thumbnail,
    heights,
    partCount: view.pages.length,
  };
}

async function downloadStream(
  candidates: string[],
  destination: string,
  cookieHeader: string,
  signal: AbortSignal | undefined,
  onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
  let lastError: unknown = new LocalizedError('errors.bilibiliStream');
  for (const url of candidates) {
    throwIfAborted(signal);
    try {
      await downloadSingle(url, destination, cookieHeader, signal, onProgress);
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      await fs.rm(destination, { force: true });
    }
  }
  throw lastError;
}

async function downloadSingle(
  url: string,
  destination: string,
  cookieHeader: string,
  signal: AbortSignal | undefined,
  onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
  const response = await fetch(url, { headers: requestHeaders(cookieHeader), signal: signal ?? AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new LocalizedError('errors.bilibiliStreamDetail', { code: String(response.status), message: 'CDN rejected the media request' });
  const total = numberValue(response.headers.get('content-length'));
  const file = createWriteStream(destination);
  let downloaded = 0;
  try {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        throwIfAborted(signal, true);
        const buffer = Buffer.from(value);
        downloaded += buffer.length;
        onProgress(downloaded, total);
        if (!file.write(buffer)) await once(file, 'drain');
      }
    } finally {
      reader.releaseLock();
    }
    file.end();
    await once(file, 'finish');
  } catch (error) {
    file.destroy();
    await fs.rm(destination, { force: true });
    throw error;
  }
}

function mergeArgs(video: string, audio: string | null, output: string): string[] {
  if (audio) {
    return ['-hide_banner', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', output];
  }
  return ['-hide_banner', '-y', '-i', video, '-c', 'copy', '-movflags', '+faststart', output];
}

export interface BilibiliDownloadRequest {
  url: string;
  folder: string;
  height: string;
  ffmpegPath: string;
  cookieFile?: string;
  signal?: AbortSignal;
  emit: (event: DownloadEvent) => void;
  bindProcess: (child: ChildProcess | null) => void;
}

export async function downloadBilibili(request: BilibiliDownloadRequest): Promise<DownloadResult> {
  const resolved = await resolveBilibiliUrl(request.url, request.signal);
  const parsed = parseBilibiliVideo(resolved);
  if (!parsed.bvid && !parsed.aid) throw new LocalizedError('errors.bilibiliExtract');
  const cookieHeader = await readCookieHeader(request.cookieFile);
  const view = await fetchView(parsed, cookieHeader, request.signal);
  const page = pickPage(view, parsed.page);
  const streams = await fetchPlayurl(view.bvid, page.cid, cookieHeader, request.signal);
  const videos = streams.filter(stream => !stream.isAudio);
  const audios = streams.filter(stream => stream.isAudio);
  if (!videos.length) throw new LocalizedError('errors.bilibiliStream');
  const height = selectHeight(videos, request.height);
  const video = videos.filter(stream => stream.height === height).sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const audio = audios.sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;
  if (!video) throw new LocalizedError('errors.bilibiliStream');

  const id = view.pages.length > 1 ? `${view.bvid}_p${page.page}` : view.bvid;
  const output = path.join(request.folder, `${windowsFileName(view.title || '未命名视频')} [${id}].mp4`);
  const videoPart = `${output}.video.m4s`;
  const audioPart = audio ? `${output}.audio.m4s` : null;
  let videoBytes = 0;
  let audioBytes = 0;
  let videoTotal = 0;
  let audioTotal = 0;
  const emitProgress = () => {
    const downloaded = videoBytes + audioBytes;
    const total = videoTotal + audioTotal;
    request.emit({
      type: 'progress',
      status: 'downloading',
      percent: total ? Math.min(100, downloaded / total * 100) : null,
      downloaded, total, speed: 0, eta: 0, filename: path.basename(output),
    });
  };

  try {
    request.emit({ type: 'status', message: '正在下载视频流…' });
    await downloadStream([video.url, ...video.backups], videoPart, cookieHeader, request.signal, (downloaded, total) => {
      videoBytes = downloaded; videoTotal = total; emitProgress();
    });
    if (audio && audioPart) {
      request.emit({ type: 'status', message: '正在下载音频流…' });
      await downloadStream([audio.url, ...audio.backups], audioPart, cookieHeader, request.signal, (downloaded, total) => {
        audioBytes = downloaded; audioTotal = total; emitProgress();
      });
    }
    throwIfAborted(request.signal, true);
    request.emit({ type: 'status', message: '正在合并音视频…', messageKey: 'status.mergeTitle' });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(request.ffmpegPath, mergeArgs(videoPart, audioPart, output), {
        windowsHide: true, shell: false, detached: process.platform !== 'win32',
      });
      request.bindProcess(child);
      const errors: string[] = [];
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => {
        errors.push(String(chunk));
        if (errors.length > 40) errors.shift();
      });
      child.once('error', error => { request.bindProcess(null); reject(error); });
      child.once('close', code => {
        request.bindProcess(null);
        if (request.signal?.aborted) return reject(new LocalizedError('errors.cancelledPartial'));
        if (code !== 0) return reject(new LocalizedError('errors.processExit', { code: String(code) }));
        resolve();
      });
    });
    await fs.access(output);
    return { file: output };
  } finally {
    await fs.rm(videoPart, { force: true });
    if (audioPart) await fs.rm(audioPart, { force: true });
  }
}
