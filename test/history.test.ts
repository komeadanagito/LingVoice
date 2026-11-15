import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryService, validateHistoryTask } from '../src/main/history';
import type { HistoryTask } from '../src/shared/history';

const task = (): HistoryTask => ({ id: 'legacy-task-1', title: 'Video', createdAt: 1, updatedAt: 2, file: '/trusted/desktop/video.mp4', embed: '', subtitles: {
  cues: [{ id: 1, start: 0, end: 1, text: 'Original', translated: 'Translation' }], offset: -1, fontSize: 24, mode: 'bilingual', name: 'Subtitles', result: null, translationFingerprint: '',
} });

test('SQLite history persists upserts and selection, rejects missing selection, and atomically clears deleted selection', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lingvoice-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'history.sqlite');
  let service = new HistoryService(file);
  assert.deepEqual(service.list(), { tasks: [], activeId: '' });
  service.save(task()); service.select(task().id);
  service.save({ ...task(), title: 'Edited', updatedAt: 3 });
  assert.equal(service.list().tasks.length, 1);
  assert.throws(() => service.select('missing'), /does not exist/);
  assert.equal(service.list().activeId, task().id);
  service.close();
  assert.throws(() => service.list(), /not open|closed/i);
  for (const suffix of ['-wal', '-shm']) assert.equal(fs.existsSync(file + suffix), false, 'closing releases SQLite WAL/shared-memory files');
  service = new HistoryService(file);
  assert.equal(service.list().tasks[0].title, 'Edited');
  assert.equal(service.list().activeId, task().id);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    for (const suffix of ['', '-wal', '-shm']) assert.equal(fs.statSync(file + suffix).mode & 0o777, 0o600);
  }
  service.select(''); assert.equal(service.list().activeId, '');
  service.select(task().id); service.delete(task().id); service.close();
  service = new HistoryService(file);
  assert.deepEqual(service.list(), { tasks: [], activeId: '' });
  service.delete('missing'); service.close();
});

test('history validates structured subtitle data, embed URLs and size before storing', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lingvoice-history-'));
  const service = new HistoryService(path.join(directory, 'history.sqlite'));
  t.after(() => {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const value of [null, {}, { ...task(), id: '../secret' }, { ...task(), createdAt: NaN }, { ...task(), updatedAt: -1 },
    { ...task(), embed: 'javascript:alert(1)' }, { ...task(), embed: 'https://evil.example/embed/test' },
    { ...task(), subtitles: { ...task().subtitles, cues: [{ id: 1, start: 2, end: 1, text: '' }] } },
    { ...task(), subtitles: { ...task().subtitles, cues: Array.from({ length: 20001 }, () => ({ id: 1, start: 0, end: 1, text: '' })) } },
    { ...task(), subtitles: { ...task().subtitles, translationFingerprint: 'x'.repeat(16 * 1024 * 1024) } },
  ]) assert.throws(() => service.save(value), /Invalid task history/);
  assert.deepEqual(service.list().tasks, []);
  assert.ok(validateHistoryTask({ ...task(), embed: 'https://www.youtube.com/embed/abcdefghijk?autoplay=1' }));
  assert.ok(validateHistoryTask({ ...task(), embed: 'https://player.bilibili.com/player.html?bvid=BV123' }));
  const many = { ...task(), subtitles: { ...task().subtitles!, cues: Array.from({ length: 20000 }, (_, i) => ({ id: i, start: i, end: i + 1, text: 'Text' })) } };
  service.save(many);
  assert.equal(service.list().tasks[0].subtitles!.cues.length, 20000);
});
