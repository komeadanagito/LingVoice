import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalPluginManager } from '../src/main/local-plugins';

test('download cancellation retains ownership until installer cleanup finishes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-cancel-'));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const manager = new LocalPluginManager(dir);
  const hooks = manager as unknown as { ensureDownloadEnvironment: () => Promise<void> };
  hooks.ensureDownloadEnvironment = async () => { entered(); await gate; };
  try {
    await fs.writeFile(path.join(dir, 'manage.py'), '# fixture');
    await manager.downloadModels({ target: 'translation', source: 'modelscope' });
    await started;
    const stopping = manager.cancelDownload();
    assert.equal((await manager.status()).download?.active, true);
    await assert.rejects(manager.downloadModels({ target: 'translation', source: 'huggingface' }), /下载任务正在进行/);
    release();
    await stopping;
    const status = await manager.status();
    assert.equal(status.download?.active, false);
    assert.equal(status.download?.stage, 'cancelled');
  } finally {
    release?.();
    await manager.cancelDownload();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('download subprocess errors retain original diagnostic and persistent log', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-logs-'));
  const manager = new LocalPluginManager(dir);
  const hooks = manager as unknown as {
    downloadLog: string;
    runDownloadCommand: (cmd: string, args: string[], cwd: string, cb: (line: string) => void) => Promise<void>;
  };
  hooks.downloadLog = path.join(dir, 'download.log');
  try {
    const script = "console.error('error: TLS certificate verification failed'); for(let i=0;i<30;i++) console.error('+ CategoryInfo : RuntimeException'); process.exit(1)";
    await assert.rejects(hooks.runDownloadCommand(process.execPath, ['-e', script], dir, () => {}), /TLS certificate verification failed[\s\S]*完整日志/);
    const log = await fs.readFile(hooks.downloadLog, 'utf8');
    assert.ok(log.includes('TLS certificate verification failed'));
    assert.ok(log.includes('CategoryInfo'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('download rejects invalid source before creating any installation files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-args-'));
  try {
    const manager = new LocalPluginManager(dir);
    await assert.rejects(manager.downloadModels({ target: 'all', source: 'bad' as never }), /无效/);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
