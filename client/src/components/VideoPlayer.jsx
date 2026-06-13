import { useEffect, useRef, useState, useCallback } from 'react';
import flvjs from 'flv.js';

const API = 'http://localhost:3001';

const RATE_CYCLE = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

async function patchLocalSettings(streamKey, patch) {
  const keyPart = streamKey.replace(/^local\//, '');
  await fetch(`${API}/api/local/${encodeURIComponent(keyPart)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// ─── 本地文件播放器（原生 video / audio 标签） ────────────────────────────────
function LocalPlayer({ stream, compact, onVideoReady, onVideoUnmount, onEnded }) {
  const mediaRef = useRef(null);
  const wrapperRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isAudio = stream.fileType === 'audio';
  const loop = stream.loop ?? false;
  const autoplay = stream.autoplay ?? true;
  const playbackRate = stream.playbackRate ?? 1.0;

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

  // 同步播放设置到 media 元素
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.loop = loop;
    el.playbackRate = playbackRate;
  }, [loop, playbackRate]);

  // 播放结束回调（用于顺序播放）
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || loop) return;
    const handleEnded = () => onEnded?.(stream.streamKey);
    el.addEventListener('ended', handleEnded);
    return () => el.removeEventListener('ended', handleEnded);
  }, [stream.streamKey, loop, onEnded]);

  const toggleFullscreen = () => {
    const el = wrapperRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  };

  const handleToggleLoop = useCallback(async (e) => {
    e.stopPropagation();
    const next = !loop;
    await patchLocalSettings(stream.streamKey, { loop: next });
    if (mediaRef.current) mediaRef.current.loop = next;
  }, [stream.streamKey, loop]);

  const handleCycleRate = useCallback(async (e) => {
    e.stopPropagation();
    const idx = RATE_CYCLE.indexOf(playbackRate);
    const next = RATE_CYCLE[(idx + 1) % RATE_CYCLE.length];
    await patchLocalSettings(stream.streamKey, { playbackRate: next });
    if (mediaRef.current) mediaRef.current.playbackRate = next;
  }, [stream.streamKey, playbackRate]);

  const displayName = stream.fileName || stream.streamKey;

  return (
    <div className={`video-player-container ${compact ? 'compact' : ''}`}>
      <div className="video-header">
        <h2 title={displayName}>{compact ? displayName.slice(0, 20) : displayName}</h2>
        <div className="video-header-actions">
          {/* 循环切换按钮 */}
          <button
            className={`player-ctrl-btn ${loop ? 'player-ctrl-btn--on' : ''}`}
            onClick={handleToggleLoop}
            title={loop ? '循环：开启（点击关闭）' : '循环：关闭（点击开启）'}
          >🔁</button>
          {/* 速率循环按钮 */}
          <button
            className={`player-ctrl-btn player-ctrl-btn--rate ${playbackRate !== 1.0 ? 'player-ctrl-btn--on' : ''}`}
            onClick={handleCycleRate}
            title={`播放速率 ${playbackRate}x（点击切换）`}
          >{playbackRate}x</button>
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
          <audio ref={mediaRef} src={mediaUrl} controls className="local-audio"
            autoPlay={autoplay} loop={loop} />
        ) : (
          <video ref={mediaRef} src={mediaUrl} className="video-player" controls playsInline
            autoPlay={autoplay} loop={loop} />
        )}
      </div>
      {!compact && (
        <div className="video-info">
          <p>文件: {stream.fileName}</p>
          <p>类型: {isAudio ? '音频' : '视频'}</p>
          <p>循环: {loop ? '开启' : '关闭'} | 自动播放: {autoplay ? '开启' : '关闭'} | 速率: {playbackRate}x</p>
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
  const [stats, setStats] = useState({ latency: 0, bufferLength: 0, fps: 0, bitrate: 0 });

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
      { 
        enableWorker: false, 
        enableStashBuffer: false, 
        stashInitialSize: 32,  // 降低初始缓冲大小
        autoCleanupSourceBuffer: true, 
        autoCleanupMaxBackwardDuration: 2,  // 更激进地清理历史缓冲
        autoCleanupMinBackwardDuration: 1, 
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 0.5,  // 降低最大延迟阈值,更快触发追赶
        liveBufferLatencyMinRemain: 0.1,   // 降低目标剩余缓冲,贴近实时
        lazyLoad: false,  // 禁用懒加载
        seekType: 'range'  // 使用 range 模式 seek
      }
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
      const lag = edge - v.currentTime;
      // 更激进的追播策略
      if (lag > 0.8) {
        v.currentTime = edge - 0.1;  // 追到更接近实时的位置
      } else if (lag > 0.5) {
        v.playbackRate = 1.2;  // 轻微加速追赶
      } else {
        v.playbackRate = 1.0;  // 恢复正常速度
      }
    }, 500);  // 更频繁地检查

    // 统计信息更新
    let lastDecodedFrames = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    
    const statsTimer = setInterval(() => {
      if (!v || !playerRef.current) return;
      
      const stats = playerRef.current.statisticsInfo;
      const currentTime = Date.now();
      const deltaTime = (currentTime - lastTime) / 1000;
      
      if (stats && deltaTime > 0) {
        // 计算 FPS
        const currentFrames = stats.decodedFrames || 0;
        const fps = Math.round((currentFrames - lastDecodedFrames) / deltaTime);
        lastDecodedFrames = currentFrames;
        
        // 计算比特率 (kbps)
        const currentBytes = (stats.videoDataRate || 0) + (stats.audioDataRate || 0);
        const bitrate = Math.round(((currentBytes - lastBytes) * 8) / (deltaTime * 1000));
        lastBytes = currentBytes;
        
        lastTime = currentTime;
        
        // 计算延迟和缓冲长度
        const latency = v.buffered.length > 0 
          ? Math.round((v.buffered.end(v.buffered.length - 1) - v.currentTime) * 1000) 
          : 0;
        const bufferLength = v.buffered.length > 0 
          ? Math.round((v.buffered.end(v.buffered.length - 1) - v.buffered.start(0)) * 1000)
          : 0;
        
        setStats({
          latency: Math.max(0, latency),
          bufferLength: Math.max(0, bufferLength),
          fps: fps > 0 ? fps : stats.currentFps || 0,
          bitrate: bitrate > 0 ? bitrate : Math.round((stats.speed || 0) / 1024)
        });
      }
    }, 1000);

    return () => {
      clearInterval(statsTimer);
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
        
        {/* 实时统计信息 */}
        <div className="video-stats-overlay">
          <div className="stats-line">延迟: <span className={stats.latency > 1000 ? 'warn' : ''}>{stats.latency}ms</span></div>
          <div className="stats-line">缓冲: {stats.bufferLength}ms</div>
          <div className="stats-line">帧率: {stats.fps} fps</div>
          <div className="stats-line">码率: {stats.bitrate} kbps</div>
        </div>
        
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
function VideoPlayer({ stream, compact = false, onVideoReady, onVideoUnmount, onEnded }) {
  if (stream?.type === 'local') {
    return <LocalPlayer stream={stream} compact={compact} onVideoReady={onVideoReady} onVideoUnmount={onVideoUnmount} onEnded={onEnded} />;
  }
  return <LivePlayer stream={stream} compact={compact} onVideoReady={onVideoReady} onVideoUnmount={onVideoUnmount} />;
}

export default VideoPlayer;
