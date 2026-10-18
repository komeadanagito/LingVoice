import { useCallback } from 'react';
import { createInstance } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { defaultLocale, resources, resolveLocale, type DisplayMessage, type MessageKey, type MessageValues } from '../shared/i18n/catalog';

export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources, lng: defaultLocale, fallbackLng: defaultLocale,
  keySeparator: false, initImmediate: false, showSupportNotice: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export function useI18n() {
  const { t, i18n: instance } = useTranslation(undefined, { i18n });
  const translate = useCallback((key: MessageKey, values?: MessageValues): string => t(key, values ?? {}), [t]);
  return {
    t: translate,
    locale: resolveLocale(instance.resolvedLanguage ?? instance.language),
    message: (value: DisplayMessage): string => 'key' in value ? translate(value.key, value.values) : value.text,
  };
}
