import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeSpeechForLocalV5, preserveRejectedSpeech } from '../src/main/dubbing';
import { SpeechContentError, validateSynthesizedTranscript } from '../src/main/speech-validation';

test('local speech speaks Roman model versions as numbers without changing ordinary English', () => {
  assert.equal(normalizeSpeechForLocalV5('GTA VI first release.', 'en'), 'GTA six first release.');
  assert.equal(normalizeSpeechForLocalV5('GTA V and GTA IV.', 'en'), 'GTA five and GTA four.');
  assert.equal(normalizeSpeechForLocalV5('I love this. This is chapter VI.', 'en'), 'I love this. This is chapter VI.');
  assert.equal(normalizeSpeechForLocalV5('FINAL FANTASY VII.', 'en'), 'FINAL FANTASY seven.');
});
test('content failure retains the actual transcript and strict unrelated/CJK/repetition gates', () => {
  for (const actual of ['GTA V, I first release.', '这是中文 GTA six first release.', 'GTA six first release GTA six first release GTA six first release']) {
    assert.throws(() => validateSynthesizedTranscript('GTA six first release.', actual, 'en'), error => {
      assert.ok(error instanceof SpeechContentError);
      assert.equal(error.transcript, actual);
      assert.equal(error.expected, 'GTA six first release.');
      return true;
    });
  }
});
test('rejected waveform diagnostics rotate at twelve records and never become reusable cache entries', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-rejections-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 15; i++) {
    const file = path.join(dir, `speech-${i}.wav`);
    await fs.writeFile(file, `wave-${i}`);
    await preserveRejectedSpeech(file, { expected: 'GTA six first release.', transcript: 'GTA V I first release.', seed: i });
    await assert.rejects(fs.access(file));
  }
  const records = await fs.readdir(path.join(dir, 'rejected-speech'));
  assert.equal(records.filter(n => n.endsWith('.json')).length, 12);
  assert.equal(records.filter(n => n.endsWith('.wav')).length, 12);
  for (const name of records.filter(n => n.endsWith('.json'))) {
    const proof = JSON.parse(await fs.readFile(path.join(dir, 'rejected-speech', name), 'utf8'));
    assert.equal(proof.transcript, 'GTA V I first release.');
    assert.equal(proof.audioRetained, true);
  }
});
