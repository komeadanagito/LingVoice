import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServerVault } from '../src/main/server-vault';
import { ProviderService } from '../src/main/providers';

async function fixture(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-server-vault-'));
  try { await action(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('server vault roundtrips empty, Unicode, and multiline credentials after persisted reload', async () => {
  await fixture(async directory => {
    const dataDir = path.join(directory, 'nested', 'server');
    const vault = await createServerVault(dataDir);
    const key = await fs.readFile(path.join(dataDir, 'server-vault.key'));
    assert.equal(key.length, 32);
    const reloaded = await createServerVault(dataDir);
    for (const value of ['', 'sk-private-secret', '凭据 🔐\nsecond line\u0000']) {
      const encrypted = vault.encrypt(value);
      assert.equal(vault.decrypt(encrypted), value);
      assert.equal(reloaded.decrypt(encrypted), value);
      assert.equal(vault.decrypt(reloaded.encrypt(value)), value);
    }
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'server-vault.key')), key);
    assert.deepEqual(await fs.readdir(dataDir), ['server-vault.key']);
  });
});

test('server vault uses a fresh 96-bit IV and different ciphertext for every encryption', async () => {
  await fixture(async directory => {
    const vault = await createServerVault(directory);
    const ciphertexts = Array.from({ length: 64 }, () => vault.encrypt('same-credential'));
    const ivs = ciphertexts.map(value => Buffer.from(value.slice(4), 'base64url').subarray(0, 12).toString('hex'));
    assert.equal(new Set(ciphertexts).size, ciphertexts.length);
    assert.equal(new Set(ivs).size, ciphertexts.length);
    for (const ciphertext of ciphertexts) assert.equal(vault.decrypt(ciphertext), 'same-credential');
  });
});

test('server vault authenticates IV, tag, ciphertext, and rejects a different server key', async () => {
  await fixture(async directory => {
    const vault = await createServerVault(path.join(directory, 'one'));
    const other = await createServerVault(path.join(directory, 'two'));
    const encrypted = vault.encrypt('secret-not-for-errors');
    const payload = Buffer.from(encrypted.slice(4), 'base64url');
    for (const offset of [0, 11, 12, 27, 28, payload.length - 1]) {
      const tampered = Buffer.from(payload);
      tampered[offset] ^= 1;
      assert.throws(() => vault.decrypt(`lv1:${tampered.toString('base64url')}`), /^Error: Unable to decrypt server credential\.$/);
    }
    assert.throws(() => other.decrypt(encrypted), /Unable to decrypt server credential/);
  });
});

test('server vault rejects malformed, noncanonical, unsupported, and truncated ciphertext', async () => {
  await fixture(async directory => {
    const vault = await createServerVault(directory);
    const encrypted = vault.encrypt('private');
    const payload = Buffer.from(encrypted.slice(4), 'base64url');
    const invalid: unknown[] = [undefined, null, 42, {}, '', 'plaintext', 'lv2:' + encrypted.slice(4), 'lv1:',
      encrypted + '=', encrypted + '\n', 'lv1:!!!!', 'lv1:A', encrypted + 'A'];
    for (let length = 0; length < payload.length; length++) {
      invalid.push('lv1:' + payload.subarray(0, length).toString('base64url'));
    }
    // An empty-message envelope ends in four unused base64 bits; reject aliases.
    const empty = vault.encrypt('');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    invalid.push(empty.slice(0, -1) + alphabet[alphabet.indexOf(empty.at(-1)!) + 1]);
    for (const value of invalid) {
      assert.throws(() => vault.decrypt(value as string), /^Error: Unable to decrypt server credential\.$/);
    }
    assert.throws(() => vault.encrypt(null as unknown as string), /Unable to encrypt server credential/);
  });
});

test('server vault refuses invalid or truncated persisted master keys without overwriting them', async () => {
  await fixture(async directory => {
    const file = path.join(directory, 'server-vault.key');
    for (const length of [0, 1, 16, 31, 33, 64]) {
      const invalid = Buffer.alloc(length, 0x61);
      await fs.writeFile(file, invalid);
      await assert.rejects(createServerVault(directory), /Unable to initialize server credential vault/);
      assert.deepEqual(await fs.readFile(file), invalid);
      assert.deepEqual(await fs.readdir(directory), ['server-vault.key']);
    }
    await fs.rm(file);
    await fs.mkdir(file);
    await assert.rejects(createServerVault(directory), /Unable to initialize server credential vault/);
    assert.equal((await fs.stat(file)).isDirectory(), true);
  });
});

test('concurrent vault creation shares one complete persistent master key', async () => {
  await fixture(async directory => {
    const vaults = await Promise.all(Array.from({ length: 24 }, () => createServerVault(directory)));
    const ciphertext = vaults[0].encrypt('shared-key-secret');
    for (const vault of vaults) assert.equal(vault.decrypt(ciphertext), 'shared-key-secret');
    assert.equal((await fs.readFile(path.join(directory, 'server-vault.key'))).length, 32);
    assert.deepEqual(await fs.readdir(directory), ['server-vault.key']);
  });
});

test('provider persistence stores only encrypted credentials and resolves after vault reload', async () => {
  await fixture(async directory => {
    const secret = 'sk-test-plaintext-must-not-be-persisted-密钥';
    const file = path.join(directory, 'providers.json');
    const service = new ProviderService(file, await createServerVault(directory));
    const provider = await service.save({ name: 'Example', adapter: 'openai-compatible', baseUrl: 'https://example.com', apiKey: secret });
    assert.equal(provider.hasApiKey, true);
    const raw = await fs.readFile(file, 'utf8');
    const saved = JSON.parse(raw).providers[0];
    assert.match(saved.apiKey, /^lv1:/);
    for (const name of await fs.readdir(directory)) {
      const bytes = await fs.readFile(path.join(directory, name));
      assert.equal(bytes.includes(Buffer.from(secret)), false);
      assert.equal(bytes.includes(Buffer.from(Buffer.from(secret).toString('base64'))), false);
    }
    const reloaded = new ProviderService(file, await createServerVault(directory));
    assert.equal((await reloaded.resolve(provider.id, 'translation')).context.apiKey, secret);
  });
});

test('server vault restricts POSIX directory and master key permissions', { skip: process.platform === 'win32' }, async () => {
  await fixture(async directory => {
    await createServerVault(directory);
    const file = path.join(directory, 'server-vault.key');
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await fs.chmod(directory, 0o777);
    await fs.chmod(file, 0o666);
    await createServerVault(directory);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });
});
