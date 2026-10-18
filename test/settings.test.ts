import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Settings, type Preferences } from '../src/main/settings';
import { resolveLocale } from '../src/shared/i18n/catalog';

async function fixture(action: (file: string, defaults: Preferences) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-settings-'));
  try { await action(path.join(directory, 'settings.json'), { folder: path.join(directory, 'downloads'), locale: 'en' }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('settings default to the resolved system locale when missing or malformed', async () => {
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('zh_CN'), 'zh-CN');
  assert.equal(resolveLocale('unsupported'), 'zh-CN');
  await fixture(async (file, defaults) => {
    assert.deepEqual((await Settings.load(file, defaults)).current, defaults);
    for (const raw of ['not-json', 'null', '[]', '{"folder":"relative","locale":"fr"}']) {
      await fs.writeFile(file, raw);
      assert.deepEqual((await Settings.load(file, defaults)).current, defaults);
    }
  });
});

test('legacy folder settings keep their folder and use the system locale', async () => {
  await fixture(async (file, defaults) => {
    const folder = path.join(path.dirname(file), 'legacy');
    await fs.writeFile(file, JSON.stringify({ folder }));
    assert.deepEqual((await Settings.load(file, defaults)).current, { folder, locale: 'en' });
    await fs.writeFile(file, JSON.stringify({ folder: 'relative', locale: 'zh-CN' }));
    assert.deepEqual((await Settings.load(file, defaults)).current, { folder: defaults.folder, locale: 'zh-CN' });
  });
});

test('locale and folder updates survive reload without replacing one another', async () => {
  await fixture(async (file, defaults) => {
    const settings = await Settings.load(file, defaults);
    await settings.update({ locale: 'zh-CN' });
    const folder = path.join(path.dirname(file), 'chosen');
    await settings.update({ folder });
    const expected = { folder, locale: 'zh-CN' };
    assert.deepEqual(settings.current, expected);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), expected);
    assert.deepEqual((await Settings.load(file, defaults)).current, expected);
  });
});

test('concurrent writes serialize against the last committed preferences', async () => {
  await fixture(async (file, defaults) => {
    const settings = await Settings.load(file, defaults);
    const folder = path.join(path.dirname(file), 'concurrent');
    await Promise.all([
      settings.update({ folder }), settings.update({ locale: 'zh-CN' }),
      settings.update({ locale: 'en' }), settings.update({ locale: 'zh-CN' }),
    ]);
    assert.deepEqual(settings.current, { folder, locale: 'zh-CN' });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), settings.current);
  });
});

test('failed atomic writes retain memory and disk preferences and allow recovery', async () => {
  await fixture(async (file, defaults) => {
    const settings = await Settings.load(file, defaults);
    await settings.update({});
    // A directory at the temporary-file path causes a deterministic write failure.
    await fs.mkdir(`${file}.tmp`);
    await assert.rejects(settings.update({ locale: 'zh-CN' }));
    assert.deepEqual(settings.current, defaults);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), defaults);
    await fs.rm(`${file}.tmp`, { recursive: true });
    await settings.update({ folder: path.join(path.dirname(file), 'recovered') });
    assert.equal(settings.current.locale, 'en');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), settings.current);
  });
});

test('failed rename leaves the prior in-memory preferences unchanged', async () => {
  await fixture(async (file, defaults) => {
    const settings = await Settings.load(file, defaults);
    await fs.mkdir(file);
    await assert.rejects(settings.update({ locale: 'zh-CN' }));
    assert.deepEqual(settings.current, defaults);
    assert.ok((await fs.stat(file)).isDirectory());
    await assert.rejects(fs.access(`${file}.tmp`));
  });
});
