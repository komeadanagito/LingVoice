import { useState, useRef, useEffect, type ChangeEvent, type DragEvent } from 'react';
import { useI18n } from '../i18n';
import { filePathToMediaUrl } from '../utils/media';
import { Icon } from './Icon';
import { useSubtitleTrack } from './SubtitleTrack';

interface Props {
  initialFile?: string;
  initialEmbed?: string;
  initialTitle?: string;
  recentDownloadedFile?: string;
  recentDownloadedTitle?: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (hours > 0) {
    return `${hours}:${String(remainingMins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function VideoPlayer({ initialFile, initialEmbed = '', initialTitle, recentDownloadedFile, recentDownloadedTitle }: Props) {
  const { t } = useI18n();
  const [embedSrc, setEmbedSrc] = useState(initialEmbed);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const objectUrl = useRef('');
  const [videoSrc, setVideoSrc] = useState<string>(initialFile ? filePathToMediaUrl(initialFile) : '');
  const [videoTitle, setVideoTitle] = useState<string>(initialTitle || '');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isDragging, setIsDragging] = useState(false);

  const [localPath, setLocalPath] = useState(initialFile && !/^https?:/i.test(initialFile) ? initialFile : '');
  const subtitles = useSubtitleTrack(videoSrc, embedSrc, currentTime, localPath);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEmbedSrc(initialEmbed);
    setFailed(false);
    setLoading(Boolean(initialFile || initialEmbed));
    setVideoSrc(initialFile ? filePathToMediaUrl(initialFile) : '');
    setLocalPath(initialFile && !/^https?:/i.test(initialFile) ? initialFile : '');
    setVideoTitle(initialTitle || '');
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
  }, [initialFile, initialEmbed]);

  useEffect(() => { setVideoTitle(initialTitle || ''); }, [initialTitle]);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      void videoRef.current.play().catch(() => setIsPlaying(false));
    } else {
      videoRef.current.pause();
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
      void videoRef.current.play().catch(() => {
        // Autoplay may be prevented until user interaction
      });
    }
  };

  const handleSeek = (event: ChangeEvent<HTMLInputElement>) => {
    const time = Number(event.target.value);
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  };

  const handleVolumeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const val = Number(event.target.value);
    setVolume(val);
    setIsMuted(val === 0);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    videoRef.current.muted = nextMuted;
    if (!nextMuted && volume === 0) {
      setVolume(0.5);
      videoRef.current.volume = 0.5;
    }
  };

  const handleSpeedChange = (speed: number) => {
    setPlaybackRate(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      void containerRef.current.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  };

  const handleFileSelect = (file: File) => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    setEmbedSrc('');
    setFailed(false);
    setLoading(true);
    setVideoSrc(url);
    try { setLocalPath(window.lingvoice.localFilePath(file)); } catch { setLocalPath(''); }
    setVideoTitle(file.name);
    setCurrentTime(0); setDuration(0); setIsPlaying(false);
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file && file.type.startsWith('video/')) {
      handleFileSelect(file);
    }
  };

  const loadRecentDownload = () => {
    if (recentDownloadedFile) {
      setEmbedSrc('');
      setFailed(false);
      setLoading(true);
      setVideoSrc(filePathToMediaUrl(recentDownloadedFile));
      setLocalPath(/^https?:/i.test(recentDownloadedFile) ? '' : recentDownloadedFile);
      setVideoTitle(recentDownloadedTitle || recentDownloadedFile.split(/[/\\]/).pop() || '');
      setCurrentTime(0); setDuration(0); setIsPlaying(false);
    }
  };

  return (
    <section className="card video-player-card" ref={containerRef}>
      <div className="player-header">
        <div className="player-title-info">
          <span className="player-icon"><Icon name="play" size={16} /></span>
          <h2>{t('player.title')}</h2>
          <span id="video-title" className="sr-only">{videoTitle}</span>
        </div>
        <div className="player-actions">
          <input
            type="file"
            ref={fileInputRef}
            accept="video/*"
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
          />
          <button
            className="choose-file-button"
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="folder" size={15} /> {t('player.openLocal')}
          </button>
        </div>
      </div>

      {subtitles.toolbar}
      <div
        className={`player-viewport ${isDragging ? 'dragging' : ''} ${!videoSrc ? 'is-empty' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {embedSrc ? (
          <iframe className="platform-player" src={embedSrc} title={videoTitle || t('player.title')} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" onLoad={() => setLoading(false)} />
        ) : videoSrc ? (
          <>
            <video
              ref={videoRef}
              src={videoSrc}
              onClick={togglePlay}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onWaiting={() => setLoading(true)}
              onCanPlay={() => setLoading(false)}
              onEnded={() => setIsPlaying(false)}
              onError={() => { setFailed(true); setLoading(false); }}
              playsInline
            />
            {subtitles.overlay}
            {!isPlaying && !loading && !failed && <button type="button" className="player-center-play" aria-label={t('player.play')} onClick={togglePlay}><Icon name="play" size={28} /></button>}
            <div className="player-controls">
              <button
                type="button"
                className="control-btn play-btn"
                onClick={togglePlay}
                title={isPlaying ? t('player.pause') : t('player.play')}
              >
                <Icon name={isPlaying ? 'pause' : 'play'} size={18} />
              </button>

              <div className="player-time">
                <span>{formatTime(currentTime)}</span>
                <span className="time-divider">/</span>
                <span>{formatTime(duration)}</span>
              </div>

              <div className="scrubber-box">
                <input
                  type="range"
                  className="scrubber"
                  min={0}
                  max={duration || 100}
                  step={0.1}
                  value={currentTime}
                  onChange={handleSeek}
                />
              </div>

              <div className="volume-control">
                <button
                  type="button"
                  className="control-btn mute-btn"
                  onClick={toggleMute}
                  title={t('player.volume')}
                >
                  <Icon name={isMuted || volume === 0 ? 'muted' : 'volume'} size={18} />
                </button>
                <input
                  type="range"
                  className="volume-slider"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                />
              </div>

              <div className="speed-selector">
                <select
                  value={playbackRate}
                  onChange={e => handleSpeedChange(Number(e.target.value))}
                  title={t('player.speed')}
                >
                  <option value={0.5}>0.5x</option>
                  <option value={0.75}>0.75x</option>
                  <option value={1}>1.0x</option>
                  <option value={1.25}>1.25x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2}>2.0x</option>
                </select>
              </div>

              <button
                type="button"
                className="control-btn fullscreen-btn"
                onClick={toggleFullscreen}
                title={t('player.fullscreen')}
              >
                <Icon name="fullscreen" size={18} />
              </button>
            </div>
          </>
        ) : (
          <div className="player-empty" onClick={() => fileInputRef.current?.click()}>
            <div className="empty-icon"><Icon name="video" size={42} /></div>
            {recentDownloadedFile && (
              <div className="recent-download-pill" onClick={e => { e.stopPropagation(); loadRecentDownload(); }}>
                <span>{t('player.recentDownloaded')}: {recentDownloadedTitle || recentDownloadedFile.split(/[/\\]/).pop()}</span>
                <span className="quick-play-tag"><Icon name="play" size={12} /> {t('player.playNow')}</span>
              </div>
            )}
          </div>
        )}
        {loading && <div className="player-feedback" role="status" aria-label={t('player.loading')}><span className="player-spinner" /></div>}
        {failed && <div className="player-feedback" role="alert">{t('player.loadFailed')}</div>}
      </div>
    </section>
  );
}
