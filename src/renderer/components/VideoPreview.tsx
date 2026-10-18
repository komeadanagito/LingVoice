import { useState } from 'react';
import type { VideoInfo } from '../../shared/contracts';
import { duration } from '../utils/format';
import { useI18n } from '../i18n';

export function VideoPreview({ video }: { video: VideoInfo }) {
  const { t } = useI18n();
  const [failedImage, setFailedImage] = useState('');
  return <section className="card video-card" id="video-card">
    <div className="thumbnail">
      {video.thumbnail && failedImage !== video.thumbnail && <img id="thumbnail" src={video.thumbnail} alt={t('video.thumbnail')} referrerPolicy="no-referrer" onError={() => setFailedImage(video.thumbnail)} />}
      <span id="duration">{duration(video.duration)}</span>
    </div>
    <div className="video-info"><span className="video-label">{t('video.ready')}</span><h3 id="video-title">{video.titleKey ? t(video.titleKey) : video.title}</h3><p id="uploader">{t('video.uploader', { name: video.uploaderKey ? t(video.uploaderKey) : video.uploader })}</p><span className="part-note">{t('video.partHint')}</span></div>
  </section>;
}
