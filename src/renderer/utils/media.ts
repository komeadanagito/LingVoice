export function filePathToMediaUrl(filePath: string): string {
  if (!filePath) return '';
  if (/^(blob:|https?:\/\/)/.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  // Encode each path component: #, ? and % in titles must not become URL syntax.
  return `media://local/${normalized.split('/').map(encodeURIComponent).join('/')}`;
}
