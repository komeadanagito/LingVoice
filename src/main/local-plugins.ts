import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import type {
  LocalEngineDownloadTarget,
  LocalModelDownloadProgress,
  LocalModelDownloadRequest,
  LocalModelsStatus,
  LocalPluginId,
  LocalPluginStatus,
  ModelDownloadSource,
} from '../shared/local-models';

interface PluginSpec {
  id: LocalPluginId;
  port: number;
  script: string;
  args: string[];
  modelLabel: string;
  startupTimeoutMs: number;
  tokenRelativePath?: string;
}

const SPECS: Record<LocalPluginId, PluginSpec> = {
  asr: {
    id: 'asr',
    port: 9871,
    script: 'server.py',
    args: ['--port', '9871'],
    modelLabel: 'Qwen3-ASR-1.7B + ForcedAligner-0.6B',
    startupTimeoutMs: 45_000,
  },
  translation: {
    id: 'translation',
    port: 9872,
    script: 'service.py',
    args: ['serve', '--port', '9872'],
    modelLabel: 'Gemma 4 E2B (NF4 4-bit)',
    startupTimeoutMs: 45_000,
    tokenRelativePath: path.join('.state', 'token'),
  },
  'voice-clone': {
    id: 'voice-clone',
    port: 9873,
    script: 'service.py',
    args: ['serve', '--device', 'cuda', '--variant', 'v5turbo', '--port', '9873'],
    modelLabel: 'GPT-SoVITS V5 (v5turbo)',
    startupTimeoutMs: 180_000,
    tokenRelativePath: path.join('state', 'server.token'),
  },
};

const ALL_IDS: LocalPluginId[] = ['asr', 'translation', 'voice-clone'];

function findPluginsDir(explicit?: string): string {
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  const resourcesPlugins = typeof proc.resourcesPath === 'string' && proc.resourcesPath
    ? path.join(proc.resourcesPath, 'plugins')
    : undefined;
  const candidates = [
    explicit,
    path.resolve(process.cwd(), 'plugins'),
    resourcesPlugins,
    path.resolve(__dirname, '../../plugins'),
    path.resolve(__dirname, '../../../plugins'),
    path.resolve(__dirname, '../../../../plugins'),
  ].filter((item): item is string => !!item);
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'manage.py'))) return dir;
  }
  return explicit ?? path.resolve(process.cwd(), 'plugins');
}

function pythonExecutable(serviceDir: string): string {
  return process.platform === 'win32'
    ? path.join(serviceDir, '.venv', 'Scripts', 'python.exe')
    : path.join(serviceDir, '.venv', 'bin', 'python');
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDir(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function hasVenvPackage(serviceDir: string, pkg: string): Promise<boolean> {
  if (process.platform === 'win32') {
    return await isDir(path.join(serviceDir, '.venv', 'Lib', 'site-packages', pkg));
  }
  const libDir = path.join(serviceDir, '.venv', 'lib');
  try {
    const entries = await fs.readdir(libDir);
    for (const entry of entries) {
      if (entry.startsWith('python') && await isDir(path.join(libDir, entry, 'site-packages', pkg))) {
        return true;
      }
    }
  } catch {}
  return false;
}

async function hasCudaTorch(serviceDir: string): Promise<boolean> {
  if (!await hasVenvPackage(serviceDir, 'torch')) return false;
  const versionPath = process.platform === 'win32'
    ? path.join(serviceDir, '.venv', 'Lib', 'site-packages', 'torch', 'version.py')
    : '';
  if (versionPath && await isFile(versionPath)) {
    try {
      const content = await fs.readFile(versionPath, 'utf8');
      if (content.includes('+cpu') || /cuda:\s*Optional\[str\]\s*=\s*None/.test(content)) return false;
    } catch {}
  }
  return true;
}

async function isServiceDepsReady(pluginsDir: string, id: LocalPluginId | 'installer'): Promise<boolean> {
  const dir = path.join(pluginsDir, id);
  if (!await isFile(pythonExecutable(dir))) return false;
  if (id === 'installer') {
    return (await hasVenvPackage(dir, 'huggingface_hub')) && (await hasVenvPackage(dir, 'psutil'));
  }
  if (id === 'asr' || id === 'translation') {
    return (await hasCudaTorch(dir)) && (await hasVenvPackage(dir, 'transformers'));
  }
  return (await hasCudaTorch(dir))
    && (await hasVenvPackage(dir, 'imageio_ffmpeg'))
    && (await hasVenvPackage(dir, 'fast_langdetect'))
    && (await isFile(path.join(dir, 'upstream', 'tools', 'uvr5', 'bsroformer.py')));
}

async function manifestFilesReady(directory: string, manifestName: string, requireComplete: boolean): Promise<boolean> {
  try {
    const data = JSON.parse(await fs.readFile(path.join(directory, manifestName), 'utf8'));
    if (requireComplete && data.complete !== true) return false;
    const entries = Array.isArray(data) ? data : data.files;
    if (!Array.isArray(entries) || !entries.length) return false;
    for (const entry of entries) {
      const name = entry.name ?? entry.destination;
      const size = entry.size ?? entry.bytes;
      if (typeof name !== 'string' || !Number.isSafeInteger(size) || size <= 0) return false;
      const file = path.resolve(directory, name);
      if (!file.startsWith(path.resolve(directory) + path.sep)) return false;
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size !== size) return false;
    }
    return true;
  } catch { return false; }
}

async function checkWeights(pluginsDir: string, id: LocalPluginId): Promise<boolean> {
  const dir = path.join(pluginsDir, id);
  if (id === 'asr') {
    return await manifestFilesReady(path.join(dir, 'models', 'qwen3-asr-1.7b'), 'download-manifest.json', true)
      && await manifestFilesReady(path.join(dir, 'models', 'qwen3-forced-aligner-0.6b'), 'download-manifest.json', true);
  }
  if (id === 'translation') {
    return manifestFilesReady(path.join(dir, 'models', 'gemma-4-e2b-it'), 'download-manifest.json', true);
  }
  return await manifestFilesReady(dir, 'models.verified.json', false)
    && await manifestFilesReady(dir, 'runtime.manifest.json', false);
}

function buildIsolatedEnv(pluginsDir: string, id: LocalPluginId): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  delete env.VIRTUAL_ENV;
  const cacheRoot = path.join(pluginsDir, id, 'cache');
  const dirMap: Record<string, string> = {
    HF_HOME: 'huggingface',
    HF_HUB_CACHE: path.join('huggingface', 'hub'),
    HUGGINGFACE_HUB_CACHE: path.join('huggingface', 'hub'),
    TORCH_HOME: 'torch',
    TEMP: 'tmp',
    TMP: 'tmp',
    XDG_CACHE_HOME: 'xdg',
    NLTK_DATA: 'nltk_data',
    NUMBA_CACHE_DIR: 'numba',
  };
  for (const [key, sub] of Object.entries(dirMap)) {
    env[key] = path.join(cacheRoot, sub);
  }
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.HF_HUB_OFFLINE = '1';
  env.TRANSFORMERS_OFFLINE = '1';
  env.HF_HUB_DISABLE_TELEMETRY = '1';
  env.DO_NOT_TRACK = '1';
  return env;
}

function httpRequest(
  port: number,
  method: 'GET' | 'POST',
  route: string,
  options: { body?: Buffer; token?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Request cancelled.'));
      return;
    }
    const headers: Record<string, string | number> = {
      Host: `127.0.0.1:${port}`,
      Connection: 'close',
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = options.body.byteLength;
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: route, headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          cleanup();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', err => {
          cleanup();
          reject(err);
        });
      },
    );
    const timeoutMs = options.timeoutMs ?? 600_000;
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Local plugin request timed out after ${Math.round(timeoutMs / 1000)}s.`));
    });
    const onAbort = () => {
      req.destroy(new Error('Request cancelled.'));
    };
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', err => {
      cleanup();
      reject(err);
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Operation cancelled.'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Operation cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class LocalPluginManager {
  readonly pluginsDir: string;
  private readonly children = new Map<LocalPluginId, ChildProcess>();
  private readonly logs = new Map<LocalPluginId, string[]>();
  private transition: Promise<void> = Promise.resolve();
  private downloadChild: ChildProcess | null = null;
  private downloadCancelRequested = false;
  private downloadTask: Promise<void> | null = null;
  private downloadLog: string | undefined;
  private onDownloadProgress?: (progress: LocalModelDownloadProgress) => void;
  private downloadState: LocalModelDownloadProgress = {
    active: false,
    target: null,
    source: 'modelscope',
    stage: 'idle',
    message: '',
    percent: null,
    completedFiles: 0,
    totalFiles: 0,
  };

  constructor(pluginsDir?: string, onDownloadProgress?: (progress: LocalModelDownloadProgress) => void) {
    this.pluginsDir = findPluginsDir(pluginsDir);
    this.onDownloadProgress = onDownloadProgress;
  }

  setDownloadProgressEmitter(emitter: (progress: LocalModelDownloadProgress) => void): void {
    this.onDownloadProgress = emitter;
  }

  private emitDownload(patch: Partial<LocalModelDownloadProgress>): void {
    this.downloadState = { ...this.downloadState, ...patch };
    this.onDownloadProgress?.({ ...this.downloadState });
  }

  serviceDir(id: LocalPluginId): string {
    return path.join(this.pluginsDir, id);
  }

  inputsDir(): string {
    return path.join(this.pluginsDir, 'asr', 'inputs');
  }

  referencesDir(): string {
    return path.join(this.pluginsDir, 'voice-clone', 'references');
  }

  private async probeHealth(id: LocalPluginId): Promise<boolean> {
    try {
      const res = await httpRequest(SPECS[id].port, 'GET', '/health', { timeoutMs: 1500 });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  private async readToken(id: LocalPluginId): Promise<string | undefined> {
    const rel = SPECS[id].tokenRelativePath;
    if (!rel) return undefined;
    const tokenPath = path.join(this.serviceDir(id), rel);
    try {
      const token = (await fs.readFile(tokenPath, 'utf8')).trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const op = this.transition.then(action);
    this.transition = op.then(() => {}, () => {});
    return op;
  }

  private pidFile(id: LocalPluginId): string {
    return path.join(this.pluginsDir, '.state', `${id}.pid`);
  }

  private async killPid(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    await new Promise<void>(resolve => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        killer.once('exit', () => setTimeout(finish, 200));
        killer.once('error', () => {
          try { process.kill(pid); } catch {}
          setTimeout(finish, 200);
        });
        setTimeout(finish, 5000);
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch {}
        setTimeout(() => {
          try { process.kill(pid, 'SIGKILL'); } catch {}
          resolve();
        }, 1500);
      }
    });
  }

  private async terminateChild(id: LocalPluginId): Promise<void> {
    const child = this.children.get(id);
    if (child) {
      if (child.exitCode === null && !child.killed) {
        await new Promise<void>(resolve => {
          let settled = false;
          const done = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          if (process.platform === 'win32' && child.pid) {
            let childExited = child.exitCode !== null;
            let killerExited = false;
            const maybeDone = () => {
              if (childExited && killerExited) setTimeout(done, 150);
            };
            child.once('exit', () => {
              childExited = true;
              maybeDone();
            });
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
            killer.once('exit', () => {
              killerExited = true;
              maybeDone();
            });
            killer.once('error', () => {
              try { child.kill('SIGTERM'); } catch {}
              killerExited = true;
              setTimeout(done, 1000);
            });
          } else {
            child.once('exit', done);
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => {
              try { if (child.exitCode === null) child.kill('SIGKILL'); } catch {}
              done();
            }, 5000);
          }
          setTimeout(done, 10000);
        });
      }
      this.children.delete(id);
    } else {
      try {
        const raw = (await fs.readFile(this.pidFile(id), 'utf8')).trim();
        const pid = Number(raw);
        if (Number.isSafeInteger(pid) && pid > 0) await this.killPid(pid);
      } catch {}
    }
    await fs.rm(this.pidFile(id), { force: true }).catch(() => {});
  }

  private async killStrayPluginProcesses(ids: LocalPluginId[]): Promise<void> {
    if (!ids.length) return;
    const markers = ids.map(id => {
      const scriptPath = path.resolve(this.serviceDir(id), SPECS[id].script);
      return {
        winBack: scriptPath.toLowerCase(),
        winFwd: scriptPath.replace(/\\/g, '/').toLowerCase(),
      };
    });
    if (process.platform === 'win32') {
      const pids = await new Promise<number[]>(resolve => {
        const psScript = [
          '$ErrorActionPreference = "SilentlyContinue"',
          'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "python*" -and $_.CommandLine } | ForEach-Object {',
          '  "$($_.ProcessId)`t$($_.CommandLine)"',
          '}',
        ].join('; ');
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const chunks: Buffer[] = [];
        proc.stdout?.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        const timer = setTimeout(() => {
          try { proc.kill(); } catch {}
          resolve([]);
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(timer);
          const out = Buffer.concat(chunks).toString('utf8');
          const found: number[] = [];
          for (const line of out.split(/\r?\n/)) {
            const tab = line.indexOf('\t');
            if (tab <= 0) continue;
            const pid = Number(line.slice(0, tab).trim());
            const cmd = line.slice(tab + 1).toLowerCase();
            if (Number.isSafeInteger(pid) && pid > 0 && markers.some(m => cmd.includes(m.winBack) || cmd.includes(m.winFwd))) {
              found.push(pid);
            }
          }
          resolve(found);
        });
        proc.once('error', () => { clearTimeout(timer); resolve([]); });
      });
      for (const pid of pids) {
        await this.killPid(pid);
      }
      return;
    }
    const pids = await new Promise<number[]>(resolve => {
      const proc = spawn('ps', ['-eo', 'pid=,args='], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      proc.stdout?.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        resolve([]);
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(timer);
        const out = Buffer.concat(chunks).toString('utf8');
        const found: number[] = [];
        for (const line of out.split(/\r?\n/)) {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          if (!match) continue;
          const pid = Number(match[1]);
          const cmd = match[2].toLowerCase();
          if (Number.isSafeInteger(pid) && pid > 0 && markers.some(m => cmd.includes(m.winBack) || cmd.includes(m.winFwd))) {
            found.push(pid);
          }
        }
        resolve(found);
      });
      proc.once('error', () => { clearTimeout(timer); resolve([]); });
    });
    for (const pid of pids) {
      await this.killPid(pid);
    }
  }

  private async waitForGpuLeaseFree(py: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const lockFile = path.join(this.pluginsDir, '.state', 'gpu.lock');
    const leasePy = path.join(this.pluginsDir, 'gpu_lease.py');
    if (!await isFile(lockFile) || !await isFile(leasePy)) return true;
    const deadlineSec = Math.max(0.1, timeoutMs / 1000);
    const code = [
      'import sys, time',
      `sys.path.insert(0, ${JSON.stringify(this.pluginsDir)})`,
      'from gpu_lease import gpu_lease',
      `deadline = time.monotonic() + ${deadlineSec}`,
      'while True:',
      '    try:',
      '        with gpu_lease():',
      '            sys.exit(0)',
      '    except RuntimeError:',
      '        if time.monotonic() >= deadline:',
      '            sys.exit(1)',
      '        time.sleep(0.05)',
    ].join('\n');
    return await new Promise<boolean>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Operation cancelled.'));
        return;
      }
      const proc = spawn(py, ['-s', '-c', code], {
        cwd: this.pluginsDir,
        windowsHide: true,
        stdio: 'ignore',
      });
      const onAbort = () => {
        try { proc.kill(); } catch {}
        reject(new Error('Operation cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        try { proc.kill(); } catch {}
        resolve(false);
      }, timeoutMs + 2000);
      proc.once('exit', exitCode => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(exitCode === 0);
      });
      proc.once('error', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      });
    });
  }

  private async stopExternalIfPresent(id: LocalPluginId): Promise<void> {
    const stateFile = path.join(this.pluginsDir, '.state', `${id}.json`);
    if (!await isFile(stateFile)) return;
    const installerPy = pythonExecutable(path.join(this.pluginsDir, 'installer'));
    const managePy = path.join(this.pluginsDir, 'manage.py');
    if (!await isFile(installerPy) || !await isFile(managePy)) return;
    await new Promise<void>(resolve => {
      const proc = spawn(installerPy, ['-s', managePy, 'stop', id], {
        cwd: this.pluginsDir,
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        resolve();
      }, 15_000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      proc.once('error', () => { clearTimeout(timer); resolve(); });
    });
  }

  private async stopOneInternal(id: LocalPluginId): Promise<void> {
    if (id === 'translation' && await this.probeHealth('translation')) {
      const token = await this.readToken('translation');
      if (token) {
        try {
          await httpRequest(SPECS.translation.port, 'POST', '/unload', {
            body: Buffer.from('{}'),
            token,
            timeoutMs: 5000,
          });
        } catch {}
      }
    }
    await this.terminateChild(id);
    await this.stopExternalIfPresent(id);
  }

  async status(): Promise<LocalModelsStatus> {
    const entries = await Promise.all(ALL_IDS.map(async id => {
      const spec = SPECS[id];
      const dir = this.serviceDir(id);
      const [depsReady, hasScript, healthy] = await Promise.all([
        isServiceDepsReady(this.pluginsDir, id),
        isFile(path.join(dir, spec.script)),
        this.probeHealth(id),
      ]);
      const installed = depsReady && hasScript;
      const weightsReady = installed ? await checkWeights(this.pluginsDir, id) : false;
      const child = this.children.get(id);
      const running = healthy || (!!child && child.exitCode === null);
      return {
        id,
        port: spec.port,
        installed,
        weightsReady,
        running,
        healthy,
        modelLabel: spec.modelLabel,
        ...(!installed ? { detail: 'Python virtual environment not installed.' } : !weightsReady ? { detail: 'Model weights missing or incomplete.' } : {}),
      } satisfies LocalPluginStatus;
    }));
    const services = {} as Record<LocalPluginId, LocalPluginStatus>;
    let activeService: LocalPluginId | null = null;
    for (const status of entries) {
      services[status.id] = status;
      if (status.running && !activeService) activeService = status.id;
    }
    return {
      available: existsSync(path.join(this.pluginsDir, 'manage.py')),
      pluginsDir: this.pluginsDir,
      activeService,
      services,
      download: { ...this.downloadState },
    };
  }

  private buildDownloadEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    delete env.VIRTUAL_ENV;
    delete env.HF_HUB_OFFLINE;
    delete env.TRANSFORMERS_OFFLINE;
    delete env.HF_DATASETS_OFFLINE;
    delete env.UV_DEFAULT_INDEX;
    delete env.UV_INDEX_URL;
    delete env.LINGVOICE_PYPI_INDEX;
    delete env.UV_PYTHON_INSTALL_MIRROR;
    env.PYTHONNOUSERSITE = '1';
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
    return env;
  }

  private runDownloadCommand(
    cmd: string,
    args: string[],
    cwd: string,
    onLine: (line: string) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.downloadCancelRequested) {
        reject(new Error('下载已取消。'));
        return;
      }
      const child = spawn(cmd, args, {
        cwd,
        env: this.buildDownloadEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.downloadChild = child;
      const tail: string[] = [];
      const remainders = { stdout: '', stderr: '' };
      let logQueue = Promise.resolve();
      const recordLine = (raw: string) => {
        const line = raw.trim().slice(0, 8000);
        if (!line) return;
        tail.push(line);
        if (tail.length > 150) tail.shift();
        if (this.downloadLog) {
          const file = this.downloadLog;
          logQueue = logQueue.then(() => fs.appendFile(file, `${line}\n`, 'utf8')).catch(() => {});
        }
        onLine(line);
      };
      const pushChunk = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
        const text = remainders[channel] + chunk.toString('utf8');
        const parts = text.split(/[\r\n]+/);
        remainders[channel] = (parts.pop() ?? '').slice(-16000);
        for (const raw of parts) recordLine(raw);
      };
      child.stdout?.on('data', chunk => pushChunk('stdout', chunk));
      child.stderr?.on('data', chunk => pushChunk('stderr', chunk));
      child.once('error', err => {
        if (this.downloadChild === child) this.downloadChild = null;
        reject(err);
      });
      child.once('close', async code => {
        recordLine(remainders.stdout);
        recordLine(remainders.stderr);
        await logQueue;
        if (this.downloadChild === child) this.downloadChild = null;
        if (this.downloadCancelRequested) {
          reject(new Error('下载已取消。'));
          return;
        }
        if (code === 0) resolve();
        else {
          const diagnostic = tail.filter(line => /error:|cause:|failed to|no solution|no space|access.*denied|timed? out|certificate|403|401|429/i.test(line) && !/^\s*\+/.test(line));
          const summary = (diagnostic.length ? diagnostic : tail.filter(line => !/^\+|CategoryInfo|FullyQualifiedErrorId|^At\s/i.test(line))).slice(-5).join(' | ');
          reject(new Error((summary || `下载命令退出码 ${code}`) + (this.downloadLog ? `\n完整日志：${this.downloadLog}` : '')));
        }
      });
    });
  }

  private async probeDownloadDependencies(id: LocalPluginId | 'installer'): Promise<boolean> {
    if (this.downloadCancelRequested) throw new Error('下载已取消。');
    if (!await isServiceDepsReady(this.pluginsDir, id)) return false;
    const imports = id === 'installer' ? 'import huggingface_hub, psutil'
      : id === 'asr' ? 'import torch, torchaudio, transformers, soundfile; from transformers import AutoModel'
      : id === 'translation' ? 'import torch, transformers, bitsandbytes, accelerate; from transformers import AutoModelForCausalLM'
      : 'import torch, torchaudio, imageio_ffmpeg, fast_langdetect, librosa, soundfile, onnxruntime; from transformers import BertModel';
    return new Promise(resolve => {
      const child = spawn(pythonExecutable(path.join(this.pluginsDir, id)), ['-I', '-c', imports], {
        windowsHide: true, stdio: 'ignore', env: { ...this.buildDownloadEnv(), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
      });
      this.downloadChild = child;
      const timer = setTimeout(() => { child.kill(); resolve(false); }, 60_000);
      child.once('error', () => { clearTimeout(timer); if (this.downloadChild === child) this.downloadChild = null; resolve(false); });
      child.once('close', code => { clearTimeout(timer); if (this.downloadChild === child) this.downloadChild = null; resolve(code === 0); });
    });
  }

  private async ensureDownloadEnvironment(target: LocalEngineDownloadTarget, source: ModelDownloadSource): Promise<void> {
    const servicesToInstall: LocalPluginId[] = [];
    if ((target === 'all' || target === 'asr') && !await this.probeDownloadDependencies('asr')) {
      servicesToInstall.push('asr');
    }
    if ((target === 'all' || target === 'translation') && !await this.probeDownloadDependencies('translation')) {
      servicesToInstall.push('translation');
    }
    // Separation runs Karaoke BS-RoFormer inside the voice-clone venv and upstream uvr5 package.
    if ((target === 'all' || target === 'voice-clone' || target === 'separation') && !await this.probeDownloadDependencies('voice-clone')) {
      servicesToInstall.push('voice-clone');
    }
    const needInstaller = !await this.probeDownloadDependencies('installer');
    if (!needInstaller && servicesToInstall.length === 0) return;

    const psScript = path.join(this.pluginsDir, 'plugins.ps1');
    if (!await isFile(psScript)) {
      throw new Error('缺少 plugins/plugins.ps1 安装脚本，无法初始化本地环境。');
    }
    if (needInstaller && servicesToInstall.length === 0) {
      this.emitDownload({ stage: 'bootstrap', message: '正在初始化内置 Python 下载环境…', percent: null });
      await this.runDownloadCommand(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Action', 'bootstrap', '-Source', source],
        this.pluginsDir,
        line => this.emitDownload({ message: line }),
      );
      return;
    }
    for (const svc of servicesToInstall) {
      this.emitDownload({ stage: 'bootstrap', message: `正在安装 ${svc} 本地运行环境…`, percent: null });
      await this.runDownloadCommand(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Action', 'install', '-Service', svc, '-Source', source, '-NoModels'],
        this.pluginsDir,
        line => this.emitDownload({ message: line }),
      );
    }
  }

  async downloadModels(request: LocalModelDownloadRequest): Promise<LocalModelsStatus> {
    const validTargets: LocalEngineDownloadTarget[] = ['asr', 'translation', 'voice-clone', 'separation', 'all'];
    const validSources: ModelDownloadSource[] = ['modelscope', 'huggingface'];
    if (!request || !validTargets.includes(request.target) || !validSources.includes(request.source)) {
      throw new Error('无效的模型下载参数。');
    }
    if (this.downloadState.active || this.downloadTask) {
      throw new Error('已有模型下载任务正在进行，请等待完成或先取消。');
    }
    if (!existsSync(path.join(this.pluginsDir, 'manage.py'))) {
      throw new Error('未找到 plugins 目录，无法下载本地模型。');
    }

    const sourceLabel = request.source === 'modelscope' ? '魔搭社区 (ModelScope)' : 'Hugging Face';
    this.downloadCancelRequested = false;
    this.emitDownload({
      active: true,
      target: request.target,
      source: request.source,
      stage: 'preparing',
      message: `正在准备从 ${sourceLabel} 下载模型…`,
      percent: 0,
      completedFiles: 0,
      totalFiles: 0,
      error: undefined,
    });

    this.downloadTask = (async () => {
      let installationLock: fs.FileHandle | undefined;
      const lockPath = path.join(this.pluginsDir, '.download.lock');
      try {
        try {
          installationLock = await fs.open(lockPath, 'wx');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          const pid = Number(await fs.readFile(lockPath, 'utf8'));
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('下载锁尚未初始化，请稍后重试。');
          let running = true;
          try { process.kill(pid, 0); } catch (error) { running = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
          if (running) throw new Error('另一个应用或浏览器后端正在安装模型，请等待或关闭该实例后重试。');
          await fs.unlink(lockPath);
          installationLock = await fs.open(lockPath, 'wx');
        }
        await installationLock.writeFile(String(process.pid));
        const logDir = path.join(this.pluginsDir, 'logs');
        await fs.mkdir(logDir, { recursive: true });
        this.downloadLog = path.join(logDir, `download-${Date.now()}.log`);
        await fs.writeFile(this.downloadLog, `target=${request.target} source=${request.source}\n`, 'utf8');
        const disk = await fs.statfs(this.pluginsDir);
        if (disk.bavail * disk.bsize < 5 * 1024 ** 3) {
          throw new Error('安装目录所在磁盘剩余空间不足 5 GiB，请释放空间后重试。完整安装通常需要数十 GB。');
        }
        await this.ensureDownloadEnvironment(request.target, request.source);
        const installerPy = pythonExecutable(path.join(this.pluginsDir, 'installer'));
        const downloadScript = path.join(this.pluginsDir, 'download_models.py');
        const modelSteps: Array<'qwen-asr' | 'qwen-aligner' | 'gemma-e2b' | 'separation'> = [];
        if (request.target === 'asr' || request.target === 'all') modelSteps.push('qwen-asr', 'qwen-aligner');
        if (request.target === 'translation' || request.target === 'all') modelSteps.push('gemma-e2b');
        if (request.target === 'separation' || request.target === 'all') modelSteps.push('separation');
        const includeVoiceClone = request.target === 'voice-clone' || request.target === 'all';
        const totalSteps = modelSteps.length + (includeVoiceClone ? 1 : 0);
        let stepIndex = 0;

        for (const modelId of modelSteps) {
          if (this.downloadCancelRequested) throw new Error('下载已取消。');
          const stepStart = stepIndex / Math.max(1, totalSteps);
          const stepSpan = 1 / Math.max(1, totalSteps);
          let stepFilesTotal = 0;
          let stepFilesDone = 0;
          this.emitDownload({
            stage: modelId,
            message: `正在从 ${sourceLabel} 下载 ${modelId}…`,
            percent: Math.round(stepStart * 100),
            completedFiles: 0,
            totalFiles: 0,
          });
          await this.runDownloadCommand(
            installerPy,
            ['-s', downloadScript, '--model', modelId, '--source', request.source],
            this.pluginsDir,
            line => {
              const dlMatch = line.match(/\bfiles=(\d+)/);
              if (dlMatch) {
                stepFilesTotal = Number(dlMatch[1]);
                this.emitDownload({ totalFiles: stepFilesTotal, completedFiles: stepFilesDone });
                return;
              }
              const fileMatch = line.match(/^FILE OK\s+\S+\s+(\S+)\s+(?:\d+\s+)?\((\d+)\/(\d+)\)/);
              if (fileMatch) {
                stepFilesDone = Number(fileMatch[2]);
                stepFilesTotal = Number(fileMatch[3]);
                const pct = Math.min(99, Math.round((stepStart + stepSpan * (stepFilesDone / Math.max(1, stepFilesTotal))) * 100));
                this.emitDownload({
                  completedFiles: stepFilesDone,
                  totalFiles: stepFilesTotal,
                  percent: pct,
                  message: `已下载 ${modelId}: ${fileMatch[1]} (${stepFilesDone}/${stepFilesTotal})`,
                });
              }
            },
          );
          stepIndex++;
        }

        if (includeVoiceClone) {
          if (this.downloadCancelRequested) throw new Error('下载已取消。');
          const voicePy = pythonExecutable(this.serviceDir('voice-clone'));
          const prepareScript = path.join(this.serviceDir('voice-clone'), 'prepare_models.py');
          const stepStart = stepIndex / Math.max(1, totalSteps);
          const stepSpan = 1 / Math.max(1, totalSteps);
          let verifiedCount = 0;
          const totalVoiceAssets = 15;
          this.emitDownload({
            stage: 'voice-clone',
            message: `正在从 ${sourceLabel} 下载 GPT-SoVITS V5 权重与运行时资产…`,
            percent: Math.round(stepStart * 100),
            completedFiles: 0,
            totalFiles: totalVoiceAssets,
          });
          await this.runDownloadCommand(
            voicePy,
            ['-s', prepareScript, '--source', request.source],
            this.serviceDir('voice-clone'),
            line => {
              if (line.startsWith('VERIFIED ')) {
                verifiedCount++;
                const pct = Math.min(99, Math.round((stepStart + stepSpan * Math.min(1, verifiedCount / totalVoiceAssets)) * 100));
                this.emitDownload({
                  completedFiles: verifiedCount,
                  totalFiles: Math.max(totalVoiceAssets, verifiedCount),
                  percent: pct,
                  message: `GPT-SoVITS V5 校验完成: ${line.slice(9).split(' ')[0]}`,
                });
              } else if (line.startsWith('DOWNLOAD ')) {
                this.emitDownload({ message: `正在下载 GPT-SoVITS V5: ${line.slice(9).split(' ')[0]}` });
              }
            },
          );
        }

        this.emitDownload({
          active: false,
          stage: 'complete',
          message: `${sourceLabel} 模型下载并校验完成。`,
          percent: 100,
          error: undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitDownload({
          active: false,
          stage: this.downloadCancelRequested ? 'cancelled' : 'error',
          message: msg,
          error: this.downloadCancelRequested ? undefined : msg,
        });
      } finally {
        if (installationLock) {
          await installationLock.close().catch(() => {});
          await fs.unlink(lockPath).catch(() => {});
        }
        this.downloadTask = null;
      }
    })();

    return this.status();
  }

  async cancelDownload(): Promise<LocalModelsStatus> {
    if (!this.downloadState.active && !this.downloadTask) return this.status();
    this.downloadCancelRequested = true;
    this.emitDownload({ stage: 'cancelling', message: '正在停止下载进程，保留已下载文件…' });
    const child = this.downloadChild;
    if (child?.pid) {
      await this.killPid(child.pid);
    }
    // Keep ownership until the old workflow has stopped; an immediate retry must
    // never reset its cancellation flag or allow two writers into the same model.
    await this.downloadTask;
    this.downloadChild = null;
    this.emitDownload({
      active: false,
      stage: 'cancelled',
      message: '已取消模型下载，已下载文件会在下次重试时复用。',
      error: undefined,
    });
    return this.status();
  }

  private async ensureOtherPluginsReleased(targetId: LocalPluginId, py: string, signal?: AbortSignal): Promise<void> {
    const others = ALL_IDS.filter(other => other !== targetId);
    let stoppedAny = false;
    for (const other of others) {
      const hasManaged = this.children.has(other);
      const hasPid = await isFile(this.pidFile(other));
      const hasState = await isFile(path.join(this.pluginsDir, '.state', `${other}.json`));
      const isHealthy = await this.probeHealth(other);
      if (hasManaged || hasPid || hasState || isHealthy) {
        stoppedAny = true;
        await this.stopOneInternal(other);
      }
    }
    const stillAlive: LocalPluginId[] = [];
    for (const other of others) {
      if (await this.probeHealth(other)) stillAlive.push(other);
    }
    if (stillAlive.length > 0) {
      stoppedAny = true;
      await this.killStrayPluginProcesses(stillAlive);
    }
    // Only wait on the cross-process gpu_lease if another service was running/stopped
    // and targetId itself is not already holding the lease (e.g. voice-clone serve).
    if (stoppedAny && !await this.probeHealth(targetId)) {
      if (!await this.waitForGpuLeaseFree(py, 2000, signal)) {
        await this.killStrayPluginProcesses(others);
        await this.waitForGpuLeaseFree(py, 2000, signal);
      }
    }
  }

  async stop(id?: LocalPluginId): Promise<LocalModelsStatus> {
    return this.serialized(async () => {
      const targets = id ? [id] : ALL_IDS;
      for (const target of targets) {
        await this.stopOneInternal(target);
      }
      const stillAlive: LocalPluginId[] = [];
      for (const target of targets) {
        if (await this.probeHealth(target)) stillAlive.push(target);
      }
      if (stillAlive.length > 0) {
        await this.killStrayPluginProcesses(stillAlive);
      }
      return this.status();
    });
  }

  async ensureRunning(id: LocalPluginId, signal?: AbortSignal): Promise<{ port: number; token?: string }> {
    return this.serialized(async () => {
      signal?.throwIfAborted();
      const spec = SPECS[id];
      const dir = this.serviceDir(id);
      const py = pythonExecutable(dir);
      const script = path.join(dir, spec.script);
      if (!await isFile(py) || !await isFile(script)) {
        throw new Error(`本地插件 ${id} 尚未安装，请先运行 plugins 安装脚本。 / Local plugin ${id} is not installed.`);
      }
      if (!await checkWeights(this.pluginsDir, id)) {
        throw new Error(`本地模型权重未就绪（${spec.modelLabel}），请先完成模型下载与校验。 / Local model weights for ${id} are missing or incomplete.`);
      }

      // Fast path: if the requested plugin is already healthy with a valid token and no
      // competing GPU plugin is running, reuse it immediately without spawning helper processes.
      const others = ALL_IDS.filter(other => other !== id);
      const [selfHealthy, ...otherHealthy] = await Promise.all([
        this.probeHealth(id),
        ...others.map(other => this.probeHealth(other)),
      ]);
      if (selfHealthy && !otherHealthy.some(Boolean) && !others.some(other => this.children.has(other))) {
        const token = await this.readToken(id);
        if (!spec.tokenRelativePath || token) {
          return { port: spec.port, token };
        }
      }

      // Stop all other GPU services first so gpu_lease and 8 GB VRAM are released.
      await this.ensureOtherPluginsReleased(id, py, signal);

      if (await this.probeHealth(id)) {
        const token = await this.readToken(id);
        if (!spec.tokenRelativePath || token) {
          return { port: spec.port, token };
        }
        // Orphan process without readable token: restart cleanly.
        await this.stopOneInternal(id);
      }

      // Ensure cache subdirs exist before launching.
      const env = buildIsolatedEnv(this.pluginsDir, id);
      for (const key of ['HF_HOME', 'HF_HUB_CACHE', 'TORCH_HOME', 'TEMP', 'XDG_CACHE_HOME', 'NLTK_DATA', 'NUMBA_CACHE_DIR']) {
        const dirPath = env[key];
        if (dirPath) await fs.mkdir(dirPath, { recursive: true });
      }

      const logBuffer: string[] = [];
      this.logs.set(id, logBuffer);
      const child = spawn(py, ['-s', script, ...spec.args], {
        cwd: dir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.children.set(id, child);
      if (child.pid) {
        await fs.mkdir(path.dirname(this.pidFile(id)), { recursive: true }).catch(() => {});
        await fs.writeFile(this.pidFile(id), String(child.pid), 'utf8').catch(() => {});
      }
      const appendLog = (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          logBuffer.push(trimmed);
          if (logBuffer.length > 30) logBuffer.shift();
        }
      };
      child.stdout?.on('data', appendLog);
      child.stderr?.on('data', appendLog);
      child.once('exit', () => {
        if (this.children.get(id) === child) this.children.delete(id);
      });

      const deadline = Date.now() + spec.startupTimeoutMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await this.terminateChild(id);
          throw new Error('Operation cancelled.');
        }
        if (child.exitCode !== null) {
          const tail = logBuffer.slice(-6).join(' | ');
          throw new Error(`本地服务 ${id} 启动失败（退出码 ${child.exitCode}）${tail ? `: ${tail}` : ''} / Local ${id} service exited unexpectedly.`);
        }
        if (await this.probeHealth(id)) {
          const token = await this.readToken(id);
          if (!spec.tokenRelativePath || token) {
            return { port: spec.port, token };
          }
        }
        await delay(300, signal);
      }
      await this.terminateChild(id);
      throw new Error(`本地服务 ${id} 启动超时。 / Timed out waiting for local ${id} service.`);
    });
  }

  private async resetGpuLeaseHolders(targetId: LocalPluginId, signal?: AbortSignal): Promise<void> {
    await this.serialized(async () => {
      signal?.throwIfAborted();
      for (const other of ALL_IDS) {
        await this.stopOneInternal(other);
      }
      await this.killStrayPluginProcesses(ALL_IDS);
      const py = pythonExecutable(this.serviceDir(targetId));
      if (await isFile(py)) {
        await this.waitForGpuLeaseFree(py, 3000, signal);
      }
    });
  }

  async requestJson<T = Record<string, unknown>>(
    id: LocalPluginId,
    route: string,
    payload: unknown,
    signal?: AbortSignal,
    timeoutMs = 1_200_000,
  ): Promise<T> {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { port, token } = await this.ensureRunning(id, signal);
      const res = await httpRequest(port, 'POST', route, { body, token, signal, timeoutMs });
      const text = res.body.toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`本地服务 ${id} 返回了无效的 JSON (HTTP ${res.status})。`);
      }
      if (res.status < 200 || res.status >= 300) {
        const errObj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
        const detail = typeof errObj.message === 'string' ? errObj.message
          : typeof errObj.detail === 'string' ? errObj.detail
            : typeof errObj.error === 'string' ? errObj.error
              : `HTTP ${res.status}`;
        const code = typeof errObj.error === 'string' ? errObj.error : '';
        if (attempt === 0 && res.status === 503 && (code === 'gpu_busy' || detail.includes('owns the GPU lease'))) {
          await this.resetGpuLeaseHolders(id, signal);
          continue;
        }
        const err = new Error(`本地服务 ${id} 请求失败 (${res.status}): ${detail}`) as Error & { code?: string };
        if (code) err.code = code;
        throw err;
      }
      return parsed as T;
    }
    throw new Error(`本地服务 ${id} 请求失败。`);
  }

  async requestAudio(
    id: 'voice-clone',
    route: string,
    payload: unknown,
    signal?: AbortSignal,
    timeoutMs = 300_000,
  ): Promise<Buffer> {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { port, token } = await this.ensureRunning(id, signal);
      const res = await httpRequest(port, 'POST', route, { body, token, signal, timeoutMs });
      if (res.status < 200 || res.status >= 300) {
        let detail = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
          if (typeof parsed.detail === 'string') detail = parsed.detail;
          else if (typeof parsed.error === 'string') detail = parsed.error;
        } catch {}
        if (attempt === 0 && res.status === 503 && detail.includes('owns the GPU lease')) {
          await this.resetGpuLeaseHolders(id, signal);
          continue;
        }
        throw new Error(`本地声音克隆服务请求失败 (${res.status}): ${detail}`);
      }
      if (!res.body.byteLength) {
        throw new Error('本地声音克隆服务返回了空音频。');
      }
      return res.body;
    }
    throw new Error('本地声音克隆服务请求失败。');
  }

  async dispose(): Promise<void> {
    if (this.downloadState.active) await this.cancelDownload().catch(() => {});
    await this.stop();
  }
}
