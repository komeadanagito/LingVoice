import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSynthesizedTranscript } from '../src/main/speech-validation';

test('speech verification equates spoken number words with digits, including model names', () => {
  assert.doesNotThrow(() => validateSynthesizedTranscript('GTA six first release.', 'GTA 6 first release.', 'en'));
  assert.doesNotThrow(() => validateSynthesizedTranscript('GTA six first release.', 'GTA6 first release.', 'en'));
  assert.doesNotThrow(() => validateSynthesizedTranscript('What about 4K at sixty?', 'What about for k at 60?', 'en'));
  assert.doesNotThrow(() => validateSynthesizedTranscript('Twenty four frames.', '24 frames.', 'en'));
  assert.throws(() => validateSynthesizedTranscript('GTA six first release.', 'GTA V I first release.', 'en'), /match/);
});

test('speech verification tolerates single-word non-lexical filler interjections while rejecting CJK sentence leakage', () => {
  assert.doesNotThrow(() => validateSynthesizedTranscript('Uh.', '啊。', 'en'));
  assert.doesNotThrow(() => validateSynthesizedTranscript('Uh.', '哇。', 'en'));
  assert.throws(() => validateSynthesizedTranscript('Uh.', '你好世界', 'en'), /CJK/);
});

test('speech verification tolerates punctuation and a minor recognition error', () => {
  assert.doesNotThrow(() => validateSynthesizedTranscript("I don't paint well, but I enjoy it every day.", 'I dont paint well but I enjoy this every day', 'en'));
  assert.doesNotThrow(() => validateSynthesizedTranscript('每天都画得特别开心。', '每天都画得特别开心', 'zh'));
});
test('speech verification rejects embedded source Chinese and empty output', () => {
  assert.throws(() => validateSynthesizedTranscript('I love painting.', '他画的还是很烂 I love painting', 'en'), /CJK/);
  assert.throws(() => validateSynthesizedTranscript('Hello.', '', 'en'), /empty/);
});
test('speech verification rejects repeated English and unrelated or omitted speech', () => {
  assert.throws(() => validateSynthesizedTranscript('I love painting.', 'I love painting I love painting I love painting', 'en'), /match/);
  assert.throws(() => validateSynthesizedTranscript('I love painting every day with my friends.', 'I love painting', 'en'), /match/);
  assert.throws(() => validateSynthesizedTranscript('Who are you?', 'Good morning everyone', 'en'), /match/);
});
