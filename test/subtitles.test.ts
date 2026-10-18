import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSubtitles, exportSubtitles, parseSubtitles, subtitleBatches } from '../src/renderer/utils/subtitles';

test('parses SRT with BOM, CRLF, multiple lines and strips markup', () => {
  const cues = parseSubtitles('\uFEFF1\r\n00:00:01,200 --> 00:00:03,000\r\n<b>Hello</b> &amp; welcome\r\nNext line\r\n');
  assert.deepEqual(cues, [{ id: 1, start: 1.2, end: 3, text: 'Hello & welcome\nNext line' }]);
});
test('parses VTT identifiers, cue settings, comments and minute timestamps', () => {
  const cues = parseSubtitles('WEBVTT\n\nNOTE ignored\ncomment\n\nfirst\n00:01.000 --> 00:04.500 align:start\n<c.red>Hello</c>\n\n00:02.000 --> 00:05.000\nWorld');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(activeSubtitles(cues, 2).length, 2);
  assert.equal(activeSubtitles(cues, 5).length, 0);
});
test('rejects empty, malformed, oversized and reversed subtitle files', () => {
  for (const value of ['', 'not subtitles', '1\n00:70:00,000 --> 00:71:00,000\nx', '1\n00:00:05,000 --> 00:00:01,000\nx', 'x'.repeat(5 * 1024 * 1024 + 1)]) assert.throws(() => parseSubtitles(value));
});
test('sorts cues and exports bilingual, original and translated SRT', () => {
  const cues = parseSubtitles('2\n00:01:02,345 --> 00:01:03,000\nLater\n\n1\n00:00:01,000 --> 00:00:02,000\nHello');
  cues[0].translated = '你好';
  assert.equal(cues[0].text, 'Hello');
  assert.match(exportSubtitles(cues, 'bilingual'), /你好\nHello/);
  assert.doesNotMatch(exportSubtitles(cues, 'original'), /你好/);
  assert.match(exportSubtitles(cues, 'translated'), /你好/);
  assert.match(exportSubtitles(cues, 'bilingual'), /00:01:02,345/);
});
test('translation batches respect count and character limits', () => {
  const cues = Array.from({ length: 65 }, (_, i) => ({ id: i, start: i, end: i + 1, text: 'x'.repeat(1000) }));
  const batches = subtitleBatches(cues);
  assert.equal(batches.flat().length, 65);
  for (const batch of batches) { assert.ok(batch.length <= 30); assert.ok(batch.reduce((sum, cue) => sum + cue.text.length, 0) <= 20000); }
  assert.throws(() => subtitleBatches([{ id: 1, start: 0, end: 1, text: 'x'.repeat(20001) }]));
});
