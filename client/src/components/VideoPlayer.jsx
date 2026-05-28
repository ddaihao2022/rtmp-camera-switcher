import { useEffect, useRef, useState } from 'react';
import flvjs from 'flv.js';

function VideoPlayer({ stream, compact = false }) {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const wrapperRef = useRef(null);
  const [error, setError] = useState(null);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 切换流时,重置交互状态
  useEffect(() => {
    setHasInteracted(false);
    setError(null);
  }, [stream?.streamKey]);

  // 重连触发器,error 状态出现时点按钮 +1 触发重新连接
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const toggleFullscreen = () => {
    const el = wrapperRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
      req?.call(el).catch(err => console.error('全屏失败:', err));
    } else {
      document.exitFullscreen?.();
    }
  };

  useEffect(() => {
    if (!videoRef.current) return;
    if (!flvjs.isSupported()) {
      setError('您的浏览器不支持FLV播放');
      return;
    }

    const FLV_HOST = 'http://localhost:8000';
    const flvUrl = stream.flvPath
      ? `${FLV_HOST}${stream.flvPath}`
      : `${FLV_HOST}/${stream.streamKey}.flv`;

    console.log('加载FLV:', flvUrl);

    // 摄影机推流的 GOP 不规律时, stash buffer 给 flv.js 一些缓冲余地;
    // hasAudio: false 跳过 HE-AAC 兼容性问题
    const player = flvjs.createPlayer(
      { type: 'flv', url: flvUrl, isLive: true, hasAudio: false, hasVideo: true },
      {
        enableWorker: false,
        enableStashBuffer: true,
        stashInitialSize: 128,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 10,
        autoCleanupMinBackwardDuration: 5
      }
    );

    const onError = (errorType, errorDetail) => {
      console.error('FLV播放器错误:', errorType, errorDetail);
      setError(`${errorType}: ${errorDetail}`);
    };
    player.on(flvjs.Events.ERROR, onError);

    playerRef.current = player;
    player.attachMediaElement(videoRef.current);
    player.load();

    // 调试:观察 video 元素状态机,定位卡在哪一步
    const v = videoRef.current;
    const log = (e) => console.log(`[video] ${e.type} readyState=${v.readyState} currentTime=${v.currentTime.toFixed(2)} buffered=${v.buffered.length ? `${v.buffered.start(0).toFixed(2)}-${v.buffered.end(0).toFixed(2)}` : '-'}`);
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'waiting', 'stalled', 'progress'];
    events.forEach(ev => v.addEventListener(ev, log));

    const tryPlay = () => {
      v?.play?.().catch(err => console.warn('启播失败:', err.message));
    };
    v.addEventListener('loadeddata', tryPlay, { once: true });
    v.addEventListener('canplay', tryPlay, { once: true });

    return () => {
      events.forEach(ev => v.removeEventListener(ev, log));
      v?.removeEventListener('loadeddata', tryPlay);
      v?.removeEventListener('canplay', tryPlay);
      const p = playerRef.current;
      playerRef.current = null;
      if (!p) return;
      try {
        p.off && p.off(flvjs.Events.ERROR, onError);
        p.unload();
        p.detachMediaElement();
        p.destroy();
      } catch (_) {}
    };
  }, [stream, reloadKey]);

  const handlePlay = () => {
    setHasInteracted(true);
    setError(null);
    const v = videoRef.current;
    v?.play?.().catch(err => {
      console.warn('手动播放被中断:', err.message);
    });
  };

  const handleReconnect = () => {
    setError(null);
    setReloadKey(k => k + 1);
  };

  return (
    <div className={`video-player-container ${compact ? 'compact' : ''}`}>
      <div className="video-header">
        <h2>{stream.streamKey}</h2>
        <div className="video-header-actions">
          <span className="live-badge">🔴 直播中</span>
          <button
            className="fullscreen-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? '退出全屏' : '全屏播放'}
          >
            {isFullscreen ? '⤓ 退出全屏' : '⛶ 全屏'}
          </button>
        </div>
      </div>
      <div className="video-wrapper" ref={wrapperRef} onDoubleClick={toggleFullscreen}>
        <video
          ref={videoRef}
          className="video-player"
          controls
          muted
          playsInline
        />
        {!hasInteracted && !error && (
          <div className="play-overlay" onClick={handlePlay}>
            <button className="play-button">{compact ? '▶' : '▶ 点击播放'}</button>
          </div>
        )}
        {error && (
          <div className="error-overlay">
            <p>{error}</p>
            <button className="reconnect-btn" onClick={handleReconnect}>↻ 重连</button>
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

export default VideoPlayer;
