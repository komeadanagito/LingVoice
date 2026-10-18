import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isLocale, type Locale } from '../shared/i18n/catalog';

export interface Preferences { folder: string; locale: Locale }

/** Serializes atomic writes and only publishes preferences after they reach disk. */
export class Settings {
  private preferences: Preferences;
  private pending: Promise<void> = Promise.resolve();

  private constructor(readonly file: string, initial: Preferences) {
    this.preferences = { ...initial };
  }

  get current(): Readonly<Preferences> { return { ...this.preferences }; }

  static async load(file: string, defaults: Preferences): Promise<Settings> {
    const initial = { ...defaults };
    try {
      const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('folder' in value && typeof value.folder === 'string' && path.isAbsolute(value.folder)) initial.folder = value.folder;
        if ('locale' in value && isLocale(value.locale)) initial.locale = value.locale;
      }
    } catch { /* Missing or unreadable preferences use the supplied defaults. */ }
    return new Settings(file, initial);
  }

  update(changes: Partial<Preferences>): Promise<void> {
    const patch = { ...changes };
    const operation = this.pending.then(async () => {
      const next = { ...this.preferences, ...patch };
      const temporary = `${this.file}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(next), 'utf8');
        await fs.rename(temporary, this.file);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      this.preferences = next;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
