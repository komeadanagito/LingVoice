import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageOptions, normalizeLanguageSelection } from '../src/renderer/utils/languages';

test('language menus expose exactly the four supported languages in localized order', () => {
  const english = languageOptions(false, 'auto');
  const chinese = languageOptions(true, 'auto');
  assert.deepEqual(english.map(option => option.value), ['auto', 'zh', 'en', 'ja', 'ko']);
  assert.deepEqual(chinese.map(option => option.value), ['auto', 'zh', 'en', 'ja', 'ko']);
  assert.deepEqual(chinese.map(option => option.label), ['自动检测', '中文', '英语', '日语', '韩语']);
  assert.deepEqual(english.map(option => option.label), ['Auto detect', 'Chinese', 'English', 'Japanese', 'Korean']);
});

test('automatic detection option uses the caller’s exact representation', () => {
  assert.deepEqual(languageOptions(false, '')[0], { value: '', label: 'Auto detect' });
  assert.equal(languageOptions(true, '').some(option => option.value === 'auto'), false);
  assert.deepEqual(languageOptions(false, 'auto', undefined, false).map(option => option.value), ['zh', 'en', 'ja', 'ko']);
  assert.deepEqual(languageOptions(false, '', undefined, false).map(option => option.value), ['zh', 'en', 'ja', 'ko']);
});

test('unsupported or regional codes normalize safely to supported choices or fallback', () => {
  assert.equal(normalizeLanguageSelection('zh-CN', 'auto'), 'zh');
  assert.equal(normalizeLanguageSelection('zh_TW', 'auto'), 'zh');
  assert.equal(normalizeLanguageSelection('en-US', 'auto'), 'en');
  assert.equal(normalizeLanguageSelection('ja-JP', 'auto'), 'ja');
  assert.equal(normalizeLanguageSelection('ko-KR', 'auto'), 'ko');
  assert.equal(normalizeLanguageSelection('fr', 'auto'), 'auto');
  assert.equal(normalizeLanguageSelection('de', 'zh'), 'zh');
  assert.equal(normalizeLanguageSelection('', ''), '');
  assert.equal(normalizeLanguageSelection(undefined, 'auto'), 'auto');
});

test('each language option call returns independently mutable options without duplicates', () => {
  for (const automatic of ['auto', ''] as const) {
    for (const includeAutomatic of [true, false]) {
      const values = languageOptions(false, automatic, undefined, includeAutomatic).map(option => option.value);
      assert.equal(new Set(values).size, values.length);
    }
  }
  const first = languageOptions(false, 'auto');
  first[1].label = 'Mutated';
  assert.equal(languageOptions(false, 'auto')[1].label, 'Chinese');
});
