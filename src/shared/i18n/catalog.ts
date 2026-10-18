import { zhCN, type MessageKey } from './locales/zh-CN';
import { en } from './locales/en';

// Register new languages here after adding a complete MessageCatalog.
export const languages = {
  'zh-CN': { label: '简体中文', translation: zhCN },
  en: { label: 'English', translation: en },
} as const;
export type Locale = keyof typeof languages;
export type { MessageKey } from './locales/zh-CN';
export type MessageValues = Record<string, string | number>;
export interface LocalizedMessage { key: MessageKey; values?: MessageValues }
export type DisplayMessage = LocalizedMessage | { text: string };
export const defaultLocale: Locale = 'zh-CN';
export const resources = Object.fromEntries(Object.entries(languages).map(([locale, entry]) => [locale, { translation: entry.translation }]));

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(languages, value);
}
export function resolveLocale(value: unknown): Locale {
  if (typeof value !== 'string') return defaultLocale;
  const requested = value.replaceAll('_', '-').toLowerCase();
  const locales = Object.keys(languages) as Locale[];
  return locales.find(locale => locale.toLowerCase() === requested)
    ?? locales.find(locale => locale.split('-')[0].toLowerCase() === requested.split('-')[0])
    ?? defaultLocale;
}
