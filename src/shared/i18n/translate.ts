import { createInstance } from 'i18next';
import { defaultLocale, resources, type Locale, type MessageKey, type MessageValues } from './catalog';

// This instance is local to the importing process; the renderer uses its own React-bound instance.
const translator = createInstance();
void translator.init({
  resources, lng: defaultLocale, fallbackLng: defaultLocale,
  keySeparator: false, initImmediate: false, showSupportNotice: false,
  interpolation: { escapeValue: false },
});

export function translate(locale: Locale, key: MessageKey, values?: MessageValues): string {
  return translator.getFixedT(locale)(key, values ?? {});
}

export class LocalizedError extends Error {
  constructor(readonly key: MessageKey, readonly values?: MessageValues) {
    super(translate(defaultLocale, key, values));
    this.name = 'LocalizedError';
  }
}
