import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLocale, isLocale, languages, resolveLocale, type Locale } from '../src/shared/i18n/catalog';
import { translate, LocalizedError } from '../src/shared/i18n/translate';
import { bytes } from '../src/renderer/utils/format';

const placeholders = (value: string) => [...value.matchAll(/{{\s*(\w+)\s*}}/g)].map(match => match[1]).sort();

test('all registered languages contain the same nonempty keys and interpolation variables', () => {
  const reference = languages[defaultLocale].translation;
  for (const entry of Object.values(languages)) {
    assert.deepEqual(Object.keys(entry.translation).sort(), Object.keys(reference).sort());
    for (const key of Object.keys(reference) as (keyof typeof reference)[]) {
      assert.ok(entry.translation[key].trim(), key);
      assert.deepEqual(placeholders(entry.translation[key]), placeholders(reference[key]), key);
    }
  }
});

test('resolves system locales and uses a safe fallback', () => {
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('EN_gb'), 'en');
  assert.equal(resolveLocale('zh-HK'), 'zh-CN');
  assert.equal(resolveLocale('zh_CN'), 'zh-CN');
  assert.equal(resolveLocale('de-DE'), defaultLocale);
  assert.equal(resolveLocale(undefined), defaultLocale);
  assert.equal(isLocale('en'), true);
  for (const value of ['en-US', '__proto__', 'toString', null, 1]) assert.equal(isLocale(value), false);
});

test('translates application strings and variable values in both languages', () => {
  assert.equal(translate('en', 'task.cancel'), 'Cancel');
  assert.equal(translate('zh-CN', 'task.cancel'), '取消');
  assert.equal(translate('en', 'cookies.selected', { file: 'my&cookies.txt' }), 'Selected for this session: my&cookies.txt');
  assert.equal(translate('zh-CN', 'errors.processExit', { code: 7 }), '下载组件退出，代码：7');
  assert.equal(translate('en', 'errors.processExit', { code: 7 }), 'The download component exited with code: 7');
});

test('falls back for an unregistered runtime language and keeps error keys', () => {
  assert.equal(translate('unsupported' as Locale, 'task.cancel'), '取消');
  const error = new LocalizedError('errors.processExit', { code: 2 });
  assert.equal(error.key, 'errors.processExit');
  assert.equal(error.message, '下载组件退出，代码：2');
  assert.equal(translate('en', error.key, error.values), 'The download component exited with code: 2');
});

test('transfer size formatting accepts the active locale', () => {
  assert.equal(bytes(1536, 'en'), '1.5 KB');
  assert.equal(bytes(1536, 'zh-CN'), '1.5 KB');
  assert.equal(bytes(1536, 'de'), '1,5 KB');
});
