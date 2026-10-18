// Only construct trusted official player URLs, never embed user-supplied HTML.
export function videoEmbedUrl(input: string, id?: string): string {
  let url: URL;
  try { url = new URL(input.startsWith('http') ? input : `https://${input}`); } catch { return ''; }
  const host = url.hostname.toLowerCase();
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv') {
    const videoId = url.pathname.match(/\/video\/(BV[a-zA-Z0-9]+|av\d+)/)?.[1] || id || '';
    const params = new URLSearchParams({ autoplay: '1', high_quality: '1', danmaku: '0' });
    if (/^BV[a-zA-Z0-9]+$/.test(videoId)) params.set('bvid', videoId);
    else if (/^(av)?\d+$/.test(videoId)) params.set('aid', videoId.replace(/^av/, ''));
    else return '';
    const part = url.searchParams.get('p');
    if (part && /^\d+$/.test(part)) params.set('page', part);
    return `https://player.bilibili.com/player.html?${params}`;
  }
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const videoId = (host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed)\/([^/]+)/)?.[1]) || id || '';
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return '';
    return `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
  }
  return '';
}
