/** Only construct trusted platform embeds, never load an arbitrary submitted page. */
export function platformPlaybackUrl(input: string, resolvedId?: string): string {
  try {
    const text = input.match(/https?:\/\/[^\s<>"，。]+/i)?.[0] ?? `https://${input.trim()}`;
    const url = new URL(text);
    if (url.username || url.password || url.port) return '';
    const host = url.hostname.toLowerCase();
    if (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'b23.tv', 'www.b23.tv'].includes(host)) {
      const id = url.pathname.match(/\/(BV[a-zA-Z0-9]+|av\d+)/)?.[1] ?? resolvedId ?? '';
      const params = new URLSearchParams({ autoplay: '1', high_quality: '1' });
      if (/^BV[a-zA-Z0-9]+$/.test(id)) params.set('bvid', id);
      else if (/^(av)?\d+$/.test(id)) params.set('aid', id.replace(/^av/, ''));
      else return '';
      const part = url.searchParams.get('p');
      if (part && /^\d+$/.test(part) && Number(part) > 0) params.set('page', part);
      return `https://player.bilibili.com/player.html?${params}`;
    }
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
      const id = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1] ?? resolvedId ?? '';
      if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return '';
      return `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`;
    }
  } catch { /* Invalid or unsupported links have no preview. */ }
  return '';
}
