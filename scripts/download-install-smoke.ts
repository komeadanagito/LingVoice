// Clean-directory installer smoke: real Python bootstrap + installer dependencies,
// then full locked dependency resolution without downloading multi-GB CUDA wheels.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function main() {
  const source = path.resolve(process.argv[2] || 'release/win-unpacked/resources/plugins');
  const tempBase = path.resolve('artifacts/install-tests');
  await fs.mkdir(tempBase, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempBase, 'LingVoice clean 安装 '));
  const env = { ...process.env };
  for (const key of ['VIRTUAL_ENV', 'PYTHONPATH', 'PYTHONHOME', 'UV_DEFAULT_INDEX', 'UV_INDEX_URL', 'UV_INDEX', 'UV_EXTRA_INDEX_URL', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE']) delete env[key];
  try {
    // Recreate only shipped files, never use the developer's .venv or model directory.
    await fs.cp(source, root, { recursive: true, filter: file => {
      const relative = path.relative(source, file).replaceAll('\\', '/');
      if (relative.startsWith('runtime/') && relative !== 'runtime/tools' && !relative.startsWith('runtime/tools/')) return false;
      return !/(^|\/)(\.venv|models|cache|tmp|logs|upstream|downloads|state|\.state)(\/|$)/.test(relative);
    } });
    console.log(`ISOLATED ${root}`);
    const boot = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'plugins.ps1'), '-Action', 'bootstrap', '-Source', 'modelscope'], { cwd: root, env, timeout: 900_000, maxBuffer: 8 * 1024 ** 2, windowsHide: true });
    console.log(boot.stdout);
    console.log('PASS: clean unicode/space directory bootstraps real Python and installer dependencies');
    const uv = path.join(root, 'runtime/tools/uv.exe');
    for (const [service, lock, channel] of [['asr', 'requirements.lock.txt', 'cu128'], ['translation', 'requirements.lock.txt', 'cu128'], ['voice-clone', 'requirements.lock', 'cu126']]) {
      const result = await exec(uv, ['pip', 'install', '--dry-run', '--python', path.join(root, service, '.venv/Scripts/python.exe'), '--index-url', 'https://mirrors.aliyun.com/pypi/simple/', '--extra-index-url', `https://download.pytorch.org/whl/${channel}`, '--index-strategy', 'unsafe-best-match', '-r', path.join(root, service, lock)], { cwd: root, env: { ...env, UV_NO_CONFIG: '1', UV_HTTP_TIMEOUT: '60' }, timeout: 600_000, maxBuffer: 8 * 1024 ** 2, windowsHide: true });
      const output = result.stdout + result.stderr;
      assert.match(output, new RegExp(`torch==[^\\s]+\\+${channel}`));
      assert.ok(!output.includes('+cpu'));
      console.log(`PASS: clean ${service} locked dependency resolution selects CUDA ${channel} (dry-run)`);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.stdout || '', error.stderr || '', error); process.exitCode = 1; });
