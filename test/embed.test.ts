import test from 'node:test';
import assert from 'node:assert/strict';
import { videoEmbedUrl } from '../src/renderer/utils/embed';

test('embeds the selected Bilibili video and selected part, never a sample', () => {
  const url = new URL(videoEmbedUrl('https://www.bilibili.com/video/BV1dHpg67E76/?p=2'));
  assert.equal(url.origin, 'https://player.bilibili.com');
  assert.equal(url.searchParams.get('bvid'), 'BV1dHpg67E76');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(new URL(videoEmbedUrl('https://b23.tv/abc', 'BV1xx411c7mD')).searchParams.get('bvid'), 'BV1xx411c7mD');
});
test('embeds YouTube watch and short links for the selected video', () => {
  for (const link of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ']) {
    assert.equal(new URL(videoEmbedUrl(link)).pathname, '/embed/dQw4w9WgXcQ');
  }
});
test('rejects unknown sites and invalid video ids instead of substituting media', () => {
  for (const link of ['https://bilibili.com.evil.test/video/BV123', 'javascript:alert(1)', 'https://youtube.com/watch?v=<script>', 'https://example.com/test.mp4']) assert.equal(videoEmbedUrl(link), '');
});
