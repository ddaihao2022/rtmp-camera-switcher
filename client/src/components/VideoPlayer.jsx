import { useEffect, useRef, useState } from 'react';
import flvjs from 'flv.js';

const API = 'http://localhost:3001';

// ─── 本地文件播放器（原生 video / audio 标签） ────────────────────────────────
function LocalPlayer({ stream, compact, onVideoReady, onVideoUnmount }) {
  const mediaRef = useRef(null);
  const wrapperRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isAudio = stream.fileType === 'audio';

  // 构建可访问的 URL
  const mediaUrl = stream.filePath?.startsWith('blob:')
    ? stream.filePath
    : `${API}/api/local/stream/${encodeURIComponent(stream.streamKey.replace(/^local\//, ''))}`;

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  useEffect(() => {
    const el = mediaRef.current;
    if (el) onVideoReady?.(stream.streamKey, el);
    return () => onVideoUnmount?.(stream.streamKey);
  }, [stream.streamKey, onVideoReady, onVideoUnmount]);

  const toggleFullscreen = () => {
    const el = wrapperRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  };

  const displayName = stream.fileName || stream.streamKey;

  return (
    <div className={`video-player-container ${compact ? 'compact' : ''}`}>
      <div className="video-header">
        <h2 title={displayName}>{compact ? displayName.slice(0, 20) : displayName}</h2>
        <div className="video-header-actions">
          <span className="live-badge local-badge">{isAudio ? '🎵 音频' : '🎬 本地'}</span>
          {!isAudio && (
            <button className="fullscreen-btn" onClick={toggleFullscreen}>
              {isFullscreen ? '⤓ 退出全屏' : '⛶ 全屏'}
            </button>
          )}
        </div>
      </div>
      <div className="video-wrapper" ref={wrapperRef} onDoubleClick={!isAudio ? toggleFullscreen : undefined}>
        {isAudio ? (
          <audio ref={mediaRef} src={mediaUrl} controls className="local-audio" />
        ) : (
          <video ref={mediaRef} src={mediaUrl} className="video-player" controls playsInline />
        )}
      </div>
      {!compact && (
        <div className="video-info">
          <p>文件: {stream.fileName}</p>
          <p>类型: {isAudio ? '音频' : '视频'}</p>
        </div>
      )}
    </div>
  );
}

// ─── RTMP / FLV 直播播放器 ────────────────────────────────────────────────────
function LivePlayer({ stream, compact, onVideoReady, onVideoUnmount }) {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const wrapperRef = useRef(null);
  const [error, setError] = useState(null);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setHasInteracted(false);
    setError(null);
  }, [stream?.streamKey]);

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const toggleFullscreen = () => {
    const el = wrapperRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el).catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  };

  useEffect(() => {
    if (!videoRef.current) return;
    if (!flvjs.isSupported()) { setError('浏览器不支持FLV播放'); return; }

    const FLV_HOST = 'http://localhost:8000';
    const flvUrl = stream.flvPath
      ? `${FLV_HOST}${stream.flvPath}`
      : `${FLV_HOST}/${stream.streamKey}.flv`;

    const player = flvjs.createPlayer(
      { type: 'flv', url: flvUrl, isLive: true, hasAudio: true, hasVideo: true },
      { enableWorker: false, enableStashBuffer: false, stashInitialSize: 128,
        autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 3,
        autoCleanupMinBackwardDuration: 2, liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 1.0, liveBufferLatencyMinRemain: 0.3 }
    );

    const onError = (t, d) => { console.error('FLV错误:', t, d); setError(`${t}: ${d}`); };
    player.on(flvjs.Events.ERROR, onError);
    playerRef.current = player;
    player.attachMediaElement(videoRef.current);
    player.load();
    onVideoReady?.(stream.streamKey, videoRef.current);

    const v = videoRef.current;
    const tryPlay = () => v?.play?.().catch(e => console.warn('启播失败:', e.message));
    v.addEventListener('loadeddata', tryPlay, { once: true });
    v.addEventListener('canplay', tryPlay, { once: true });

    const catchUpTimer = setInterval(() => {
      if (!v || v.paused || !v.buffered.length) return;
      const edge = v.buffered.end(v.buffered.length - 1);
      if (edge - v.currentTime > 1.5) v.currentTime = edge - 0.2;
    }, 1000);

    return () => {
      onVideoUnmount?.(stream.streamKey);
      clearInterval(catchUpTimer);
      v?.removeEventListener('loadeddata', tryPlay);
      v?.removeEventListener('canplay', tryPlay);
      const p = playerRef.current; playerRef.current = null;
      if (!p) return;
      try { p.off?.(flvjs.Events.ERROR, onError); p.unload(); p.detachMediaElement(); p.destroy(); } catch {}
    };
  }, [stream, reloadKey, onVideoUnmount]);

  return (
    <div className={`video-player-container ${compact ? 'compact' : ''}`}>
      <div className="video-header">
        <h2>{stream.streamKey}</h2>
        <div className="video-header-actions">
          <span className="live-badge">🔴 直播中</span>
          <button className="fullscreen-btn" onClick={toggleFullscreen}>
            {isFullscreen ? '⤓ 退出全屏' : '⛶ 全屏'}
          </button>
        </div>
      </div>
      <div className="video-wrapper" ref={wrapperRef} onDoubleClick={toggleFullscreen}>
        <video ref={videoRef} key={reloadKey} className="video-player" controls playsInline />
        {!hasInteracted && !error && (
          <div className="play-overlay" onClick={() => { setHasInteracted(true); videoRef.current?.play?.().catch(() => {}); }}>
            <button className="play-button">{compact ? '▶' : '▶ 点击播放'}</button>
          </div>
        )}
        {error && (
          <div className="error-overlay">
            <p>{error}</p>
            <button className="reconnect-btn" onClick={() => { setError(null); setReloadKey(k => k+1); }}>↻ 重连</button>
          </div>
        )}
      </div>
      {!compact && (
        <div className="video-info">
          <p>开始时间: {new Date(stream.startTime).toLocaleString('zh-CN')}</p>
          <p>状态: {stream.status === 'online' ? '在线' : '离线'}</p>
          <p>流地址: {stream.flvPath ? `http://localhost:8000${stream.flvPath}` : `http://localhost:8000/${stream.streamKey}.flv`}</p>
        </div>
      )}
    </div>
  );
}

// ─── 统一入口 ─────────────────────────────────────────────────────────────────
function VideoPlayer({ stream, compact = false, onVideoReady, onVideoUnmount }) {
  if (stream?.type === 'local') {
    return <LocalPlayer stream={stream} compact={compact} onVideoReady={onVideoReady} onVideoUnmount={onVideoUnmount} />;
  }
  return <LivePlayer stream={stream} compact={compact} onVideoReady={onVideoReady} onVideoUnmount={onVideoUnmount} />;
}

export default VideoPlayer;
