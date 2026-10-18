import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { VideoInfo, DownloadProgress, DownloadEvent, DownloadResult } from '../shared/contracts';
import { LocalizedError } from '../shared/i18n/translate';

interface YtDlpFormat { vcodec?: unknown; height?: unknown }
interface YtDlpInfo {
  _type?: unknown;
  id?: unknown;
  title?: unknown;
  uploader?: unknown;
  duration?: unknown;
  thumbnail?: unknown;
  playlist_count?: unknown;
  formats?: unknown;
}
interface YtDlpProgress {
  status?: unknown;
  total_bytes?: unknown;
  total_bytes_estimate?: unknown;
  downloaded_bytes?: unknown;
  speed?: unknown;
  eta?: unknown;
  filename?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function numberValue(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value ? value : fallback;
}

export function normalizeUrl(input: unknown): string {
  const text = String(input || '').trim();
  const match = text.match(/https?:\/\/[^\s<>"，。]+/i);
  if (!match) throw new LocalizedError('errors.urlMissing');
  let url: URL;
  try { url = new URL(match[0]); } catch { throw new LocalizedError('errors.urlFormat'); }
  if (url.username || url.password || url.port) throw new LocalizedError('errors.urlAuth');
  const host = url.hostname.toLowerCase();
  const isBiliShort = (host === 'b23.tv' || host === 'www.b23.tv') && /^\/[a-zA-Z0-9]+\/?$/.test(url.pathname);
  const isBiliVideo = (host === 'www.bilibili.com' || host === 'bilibili.com' || host === 'm.bilibili.com') && /^\/video\/(BV[a-zA-Z0-9]+|av\d+)\/?$/.test(url.pathname);
  const isYtShort = (host === 'youtu.be' || host === 'www.youtu.be') && /^\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname);
  const isYtHost = host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com';
  const isYtWatch = isYtHost && url.pathname === '/watch' && Boolean(url.searchParams.get('v'));
  const isYtShorts = isYtHost && /^\/shorts\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname);
  const isYtEmbed = isYtHost && /^\/embed\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname);

  if (!isBiliShort && !isBiliVideo && !isYtShort && !isYtWatch && !isYtShorts && !isYtEmbed) {
    throw new LocalizedError('errors.urlUnsupported');
  }

  url.protocol = 'https:';

  if (isBiliShort || isBiliVideo) {
    url.hostname = isBiliVideo ? 'www.bilibili.com' : 'b23.tv';
    url.hash = '';
    const part = url.searchParams.get('p');
    url.search = '';
    if (isBiliVideo && part && /^\d+$/.test(part) && Number(part) > 0) url.searchParams.set('p', part);
    return url.toString();
  }

  if (isYtShort) {
    const videoId = url.pathname.replace(/^\/|\/$/g, '');
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (isYtWatch) {
    const videoId = url.searchParams.get('v')!;
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (isYtShorts) {
    const videoId = url.pathname.replace(/^\/shorts\/|\/$/g, '');
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (isYtEmbed) {
    const videoId = url.pathname.replace(/^\/embed\/|\/$/g, '');
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  return url.toString();
}

export function summarize(value: unknown): VideoInfo {
  if (!isRecord(value)) throw new LocalizedError('errors.videoInfo');
  const info: YtDlpInfo = value;
  const formats: YtDlpFormat[] = Array.isArray(info.formats) ? info.formats.filter(isRecord) : [];
  const heights = [...new Set(formats.filter(f => typeof f.vcodec === 'string' && f.vcodec && f.vcodec !== 'none' && numberValue(f.height) > 0).map(f => numberValue(f.height)))].sort((a, b) => b - a);
  return {
    id: typeof info.id === 'string' ? info.id : undefined,
    title: textValue(info.title, '未命名视频'), uploader: textValue(info.uploader, '未知 UP 主'),
    ...(!textValue(info.title) ? { titleKey: 'video.untitled' as const } : {}),
    ...(!textValue(info.uploader) ? { uploaderKey: 'video.unknownUploader' as const } : {}),
    duration: numberValue(info.duration),
    thumbnail: typeof info.thumbnail === 'string' && info.thumbnail.startsWith('https://') ? info.thumbnail : '',
    heights, partCount: numberValue(info.playlist_count) || 1,
  };
}

export function formatSelector(height: unknown): string {
  if (height === 'best') return 'bv*+ba/b';
  const n = typeof height === 'string' || typeof height === 'number' ? Number(height) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 4320) throw new LocalizedError('errors.quality');
  return `bv*[height<=${n}]+ba/b[height<=${n}]`;
}

export function parseProgress(line: string): DownloadProgress | null {
  const prefix = 'LINGVOICE_PROGRESS:';
  const index = line.indexOf(prefix);
  if (index < 0) return null;
  try {
    const value: unknown = JSON.parse(line.slice(index + prefix.length));
    if (!isRecord(value)) return null;
    const p: YtDlpProgress = value;
    const total = numberValue(p.total_bytes) || numberValue(p.total_bytes_estimate);
    const downloaded = numberValue(p.downloaded_bytes);
    return {
      status: typeof p.status === 'string' ? p.status : undefined,
      percent: total ? Math.min(100, downloaded / total * 100) : null,
      downloaded, total,
      speed: numberValue(p.speed), eta: numberValue(p.eta),
      filename: path.basename(textValue(p.filename)),
    };
  } catch { return null; }
}

interface DownloaderOptions {
  dataDir: string;
  ffmpegPath?: string;
  emit: (event: DownloadEvent) => void;
}
interface DownloadOptions {
  url: string;
  folder: string;
  height: string;
  cookieFile?: string;
}

export class Downloader {
  readonly dataDir: string;
  readonly ffmpegPath: string;
  readonly emit: (event: DownloadEvent) => void;
  child: ChildProcess | null = null;
  busy = false;
  cancelled = false;
  private preparePromise: Promise<string> | null = null;

  constructor({ dataDir, ffmpegPath = '', emit }: DownloaderOptions) {
    this.dataDir = dataDir;
    this.ffmpegPath = ffmpegPath;
    this.emit = emit;
  }

  async ensureBinary(): Promise<string> {
    const binary = path.join(this.dataDir, 'tools', 'yt-dlp.exe');
    try { await fs.access(binary); return binary; } catch { /* First launch. */ }
    if (process.platform !== 'win32') throw new LocalizedError('errors.platform');
    if (!this.preparePromise) {
      this.preparePromise = (async () => {
        this.emit({ type: 'status', message: '首次使用：正在下载并校验下载组件，请稍候…', messageKey: 'status.preparingTools' });
        await fs.mkdir(path.dirname(binary), { recursive: true });
        const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
        const [response, checksums] = await Promise.all([
          fetch(`${base}yt-dlp.exe`, { signal: AbortSignal.timeout(180000) }),
          fetch(`${base}SHA2-256SUMS`, { signal: AbortSignal.timeout(60000) }),
        ]);
        if (!response.ok || !checksums.ok) throw new LocalizedError('errors.toolsFetch');
        const sums = await checksums.text();
        const expected = sums.match(/^([a-fA-F0-9]{64})\s+\*?yt-dlp\.exe\s*$/m)?.[1];
        if (!expected) throw new LocalizedError('errors.toolsChecksumInfo');
        if (!response.body) throw new LocalizedError('errors.toolsEmpty');
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 150 * 1024 * 1024) {
              await reader.cancel();
              throw new LocalizedError('errors.toolsSize');
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = Buffer.concat(chunks);
        const actual = crypto.createHash('sha256').update(bytes).digest('hex');
        if (actual !== expected.toLowerCase()) throw new LocalizedError('errors.toolsChecksum');
        await fs.writeFile(`${binary}.tmp`, bytes);
        await fs.rename(`${binary}.tmp`, binary);
        return binary;
      })().finally(() => { this.preparePromise = null; });
    }
    return this.preparePromise;
  }

  async run(args: string[], onLine?: (line: string) => void): Promise<string> {
    const binary = await this.ensureBinary();
    if (this.cancelled) throw new LocalizedError('errors.cancelled');
    return new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { windowsHide: true, shell: false });
      this.child = child;
      const output: string[] = [];
      const errors: string[] = [];
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (onLine) onLine(line); else output.push(line);
        }
      });
      child.stderr.on('data', (chunk: string) => {
        errors.push(chunk);
        if (errors.length > 40) errors.shift();
      });
      child.once('error', error => { this.child = null; reject(error); });
      child.once('close', code => {
        this.child = null;
        if (buffer.trim()) { if (onLine) onLine(buffer.trim()); else output.push(buffer.trim()); }
        if (this.cancelled) return reject(new LocalizedError('errors.cancelledPartial'));
        if (code !== 0) {
          const detail = errors.join('').trim().slice(-1800);
          return reject(detail ? new Error(detail) : new LocalizedError('errors.processExit', { code: String(code) }));
        }
        resolve(output.join('\n'));
      });
    });
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new LocalizedError('errors.busy');
    this.busy = true;
    this.cancelled = false;
    try { return await action(); } finally { this.busy = false; }
  }

  commonArgs(url: string, cookieFile?: string): string[] {
    return ['--ignore-config', '--no-playlist', '--encoding', 'utf-8', '--socket-timeout', '25', '--retries', '3',
      ...(cookieFile ? ['--cookies', cookieFile] : []), '--', normalizeUrl(url)];
  }

  async inspect(url: string, cookieFile?: string): Promise<VideoInfo> {
    return this.exclusive(async () => {
      const raw = await this.run(['--dump-single-json', '--skip-download', ...this.commonArgs(url, cookieFile)]);
      const info: unknown = JSON.parse(raw);
      if (isRecord(info) && info._type === 'playlist') throw new LocalizedError('errors.playlist');
      return summarize(info);
    });
  }

  async download({ url, folder, height, cookieFile }: DownloadOptions): Promise<DownloadResult> {
    return this.exclusive(async () => {
      if (!this.ffmpegPath) throw new LocalizedError('errors.ffmpegConfig');
      await fs.access(this.ffmpegPath);
      await fs.mkdir(folder, { recursive: true });
      let file = '';
      const args = ['--newline', '--no-colors', '--progress', '--progress-delta', '0.4',
        '--progress-template', 'download:LINGVOICE_PROGRESS:%(progress)j',
        '--print', 'after_move:LINGVOICE_FILE:%(filepath)s', '--no-simulate',
        '--write-thumbnail',
        '--ffmpeg-location', this.ffmpegPath,
        '--format', formatSelector(height), '--merge-output-format', 'mp4/mkv',
        '--windows-filenames', '--trim-filenames', '160',
        '--output', path.join(folder, '%(title)s [%(id)s].%(ext)s'),
        ...this.commonArgs(url, cookieFile)];
      await this.run(args, line => {
        const progress = parseProgress(line);
        if (progress) this.emit({ type: 'progress', ...progress });
        else if (line.startsWith('LINGVOICE_FILE:')) file = line.slice('LINGVOICE_FILE:'.length);
        else if (line) this.emit({ type: 'status', message: line });
      });
      if (!file) throw new LocalizedError('errors.outputMissing');
      const resolved = path.resolve(file);
      const relative = path.relative(path.resolve(folder), resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new LocalizedError('errors.outputPath');
      await fs.access(resolved);
      return { file: resolved };
    });
  }

  cancel(): void {
    this.cancelled = true;
    if (this.child) {
      if (process.platform === 'win32' && this.child.pid) {
        // Terminate the entire process tree, including any active FFmpeg merge.
        const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, shell: false });
        killer.once('error', () => this.child?.kill());
      } else this.child.kill();
    }
  }
}
