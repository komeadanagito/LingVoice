export function duration(seconds: number): string {
  const n = Math.floor(Math.max(0, seconds || 0));
  return [Math.floor(n / 3600), Math.floor(n % 3600 / 60), n % 60]
    .slice(n >= 3600 ? 0 : 1).map((v, i) => i ? String(v).padStart(2, '0') : String(v)).join(':');
}

export function bytes(value: number, locale = 'en'): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.max(0, Math.min(3, Math.floor(Math.log(value) / Math.log(1024))));
  const amount = new Intl.NumberFormat(locale, { minimumFractionDigits: unit ? 1 : 0, maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit);
  return `${amount} ${units[unit]}`;
}
