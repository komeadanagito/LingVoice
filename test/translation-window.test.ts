import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceTranslationMemory, translationWindow, type TranslationMemoryRequest, type TranslationMemoryState } from '../src/shared/translation';
import { subtitleBatches } from '../src/renderer/utils/subtitles';

const cues = (count: number) => Array.from({ length: count }, (_, id) => ({ id, start: id, end: id + 1, text: `Source ${id}`, translated: `Translation ${id}` }));
const empty = (): TranslationMemoryState => ({ memory: { summary: '', terms: [] }, through: 0 });

test('short subtitles now translate in batches of thirty', () => {
  assert.deepEqual(subtitleBatches(cues(65)).map(batch => batch.length), [30, 30, 5]);
});

test('only expired pairs enter incremental memory and earlier summaries feed subsequent updates', async () => {
  const all = cues(95);
  const calls: TranslationMemoryRequest[] = [];
  const summarize = async (request: TranslationMemoryRequest) => {
    calls.push(request);
    return { summary: `${request.memory.summary}|${request.pairs.at(-1)!.source}`, terms: [{ source: 'Alice', translated: '爱丽丝' }] };
  };
  let state = await advanceTranslationMemory(all, 0, empty(), summarize);
  assert.equal(calls.length, 0);
  state = await advanceTranslationMemory(all, 30, state, summarize);
  assert.equal(state.through, 18);
  assert.deepEqual(calls[0].pairs.map(pair => pair.source), all.slice(0, 18).map(cue => cue.text));
  assert.deepEqual(translationWindow(all, 30, 60).context.map(pair => pair.source), all.slice(18, 30).map(cue => cue.text));
  state = await advanceTranslationMemory(all, 60, state, summarize);
  assert.equal(calls[1].memory.summary, '|Source 17');
  assert.deepEqual(calls[1].memory.terms, [{ source: 'Alice', translated: '爱丽丝' }]);
  assert.deepEqual(calls[1].pairs.map(pair => pair.source), all.slice(18, 48).map(cue => cue.text));
  await advanceTranslationMemory(all, 60, state, summarize);
  assert.equal(calls.length, 2, 'same boundary must not re-summarize history');
});

test('summary errors leave caller state unchanged, allowing a retry', async () => {
  const state = empty();
  await assert.rejects(advanceTranslationMemory(cues(40), 30, state, async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(state, empty());
});

test('long context and lookahead respect request budgets and overflow enters summary', async () => {
  const all = cues(40).map(cue => ({ ...cue, text: 'a'.repeat(3000), translated: 'b'.repeat(3000) }));
  const window = translationWindow(all, 30, 31);
  assert.equal(window.context.length, 1);
  assert.equal(window.lookahead.length, 1);
  const calls: TranslationMemoryRequest[] = [];
  const result = await advanceTranslationMemory(all, 30, empty(), async request => {
    calls.push(request);
    assert.ok(request.pairs.reduce((n, pair) => n + pair.source.length + pair.translated.length, 0) <= 20000);
    return request.memory;
  });
  assert.equal(result.through, 29);
  assert.equal(calls.flatMap(call => call.pairs).length, 29);
});

test('large cursor jumps are compacted in bounded groups and untranslated cues are skipped', async () => {
  const all = cues(95);
  all[2].translated = '';
  const sizes: number[] = [];
  const result = await advanceTranslationMemory(all, 95, empty(), async request => {
    sizes.push(request.pairs.length);
    return request.memory;
  });
  assert.equal(result.through, 83);
  assert.deepEqual(sizes, [40, 40, 2]);
});
