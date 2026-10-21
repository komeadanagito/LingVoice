import { languages, isLocale } from '../../shared/i18n/catalog';
import type { DownloadController } from '../hooks/useDownloader';
import { Select, type SelectOption } from './Select';
import { useI18n } from '../i18n';

type Props = Pick<DownloadController, 'initialized' | 'savingLanguage' | 'changeLocale'>;

export function LanguageSwitcher({ initialized, savingLanguage, changeLocale }: Props) {
  const { t, locale } = useI18n();

  const disabled = !initialized || savingLanguage;

  const handleSelect = (code: string) => {
    if (isLocale(code) && code !== locale) {
      void changeLocale(code);
    }
  };

  const options: SelectOption[] = Object.entries(languages).map(([code, entry]) => ({
    value: code,
    label: entry.label,
  }));

  return (
    <div className="language-switcher">
      <label id="language-label">{t('language.label')}</label>
      <Select
        id="language"
        value={locale}
        options={options}
        onChange={handleSelect}
        disabled={disabled}
        aria-label={t('language.label')}
      />
    </div>
  );
}
