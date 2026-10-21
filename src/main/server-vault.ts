import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProviderVault } from './providers';

const KEY_FILE = 'server-vault.key';
const PREFIX = 'lv1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

async function restrictPermissions(file: string, mode: number): Promise<void> {
  try { await fs.chmod(file, mode); }
  catch (error) {
    // Windows chmod does not provide POSIX ACL guarantees.
    if (process.platform !== 'win32') throw error;
  }
}

async function readKey(file: string): Promise<Buffer> {
  // Refuse directories, symlinks, and malformed keys rather than replacing them.
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size !== KEY_BYTES) throw new Error('Invalid server vault master key.');
  const key = await fs.readFile(file);
  if (key.length !== KEY_BYTES) throw new Error('Invalid server vault master key.');
  await restrictPermissions(file, 0o600);
  return key;
}

async function loadKey(dataDir: string): Promise<Buffer> {
  const file = path.join(dataDir, KEY_FILE);
  try { return await readKey(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = path.join(dataDir, `.${KEY_FILE}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(randomBytes(KEY_BYTES));
      await handle.sync();
    } finally { await handle.close(); }
    // Publish a complete key atomically, without replacing another creator's key.
    // Unlike opening the final path with wx, this never exposes a partial write.
    try { await fs.link(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return await readKey(file);
  } finally { await fs.rm(temporary, { force: true }); }
}

/**
 * Node-only encryption for server credentials. The key lives on the same server:
 * this is not OS keychain storage and does not protect against server compromise.
 * Back up the key with the encrypted provider configuration; never regenerate it
 * to recover existing ciphertext.
 */
export async function createServerVault(dataDir: string): Promise<ProviderVault> {
  let key: Buffer;
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await restrictPermissions(dataDir, 0o700);
    key = await loadKey(dataDir);
  } catch { throw new Error('Unable to initialize server credential vault; check the data directory and master key.'); }

  return {
    encrypt(value: string): string {
      try {
        if (typeof value !== 'string') throw new Error();
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
      } catch { throw new Error('Unable to encrypt server credential.'); }
    },
    decrypt(value: string): string {
      try {
        if (typeof value !== 'string' || !value.startsWith(PREFIX)) throw new Error();
        const encoded = value.slice(PREFIX.length);
        if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
        const payload = Buffer.from(encoded, 'base64url');
        if (payload.length < IV_BYTES + TAG_BYTES || payload.toString('base64url') !== encoded) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
        decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
      } catch { throw new Error('Unable to decrypt server credential.'); }
    },
  };
}
