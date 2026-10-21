// Structural option type keeps this data-only module usable in Node tests.
interface SelectOption { value: string; label: string; disabled?: boolean }

const languages: ReadonlyArray<readonly [string, string, string]> = [
  ['zh', '中文', 'Chinese'],
  ['en', '英语', 'English'],
  ['ja', '日语', 'Japanese'],
  ['ko', '韩语', 'Korean'],
];

/** Map older regional codes to the four supported languages; otherwise use the field's default. */
export function normalizeLanguageSelection(value: string | undefined, fallback: 'zh' | 'auto' | ''): string {
  if (value === fallback) return fallback;
  const code = value?.trim().replaceAll('_', '-').toLowerCase().split('-')[0];
  return languages.some(([supported]) => supported === code) ? code! : fallback;
}

/** Task language menus expose only Chinese, English, Japanese and Korean. */
export function languageOptions(
  zh: boolean,
  automaticValue: 'auto' | '',
  _current?: string,
  includeAutomatic = true,
): SelectOption[] {
  const options: SelectOption[] = includeAutomatic
    ? [{ value: automaticValue, label: zh ? '自动检测' : 'Auto detect' }]
    : [];
  options.push(...languages.map(([value, chinese, english]) => ({ value, label: zh ? chinese : english })));
  return options;
}
