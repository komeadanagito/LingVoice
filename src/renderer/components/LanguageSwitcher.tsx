import { useState, useRef, useEffect } from 'react';
import { languages, isLocale } from '../../shared/i18n/catalog';
import type { DownloadController } from '../hooks/useDownloader';
import { useI18n } from '../i18n';

type Props = Pick<DownloadController, 'initialized' | 'savingLanguage' | 'changeLocale'>;

export function LanguageSwitcher({ initialized, savingLanguage, changeLocale }: Props) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const disabled = !initialized || savingLanguage;
  const currentLabel = languages[locale]?.label ?? locale;

  const handleSelect = (code: string) => {
    setOpen(false);
    if (isLocale(code) && code !== locale) {
      void changeLocale(code);
    }
  };

  return (
    <div className="language-switcher">
      <label id="language-label">{t('language.label')}</label>
      <div className={`custom-select-wrapper${open ? ' is-open' : ''}`} ref={containerRef}>
        <button
          id="language-trigger"
          type="button"
          className="custom-select-trigger"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby="language-label language-trigger"
          onClick={() => setOpen(prev => !prev)}
        >
          <span className="current-value">{currentLabel}</span>
          <svg
            className={`chevron-icon${open ? ' rotated' : ''}`}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {open && (
          <ul className="custom-select-dropdown" role="listbox" aria-labelledby="language-label">
            {Object.entries(languages).map(([code, entry]) => {
              const selected = code === locale;
              return (
                <li
                  key={code}
                  role="option"
                  aria-selected={selected}
                  className={`custom-select-option${selected ? ' selected' : ''}`}
                  onClick={() => handleSelect(code)}
                >
                  <span>{entry.label}</span>
                  {selected && (
                    <svg className="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Hidden native select for backward-compatibility or automated tests */}
        <select
          id="language"
          className="sr-only"
          value={locale}
          disabled={disabled}
          onChange={event => {
            if (isLocale(event.target.value)) void changeLocale(event.target.value);
          }}
          tabIndex={-1}
          aria-hidden="true"
        >
          {Object.entries(languages).map(([code, entry]) => (
            <option key={code} value={code}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
