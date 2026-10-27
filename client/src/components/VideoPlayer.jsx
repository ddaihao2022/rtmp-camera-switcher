import { useEffect, useRef, useState, useCallback } from 'react';
import { apiUrl, flvUrl, localStreamUrl } from '../config.js';
import { useLivePlayer } from '../useLivePlayer.js';

const RATE_CYCLE = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

async function patchLocalSettings(streamKey, patch) {
  const keyPart = streamKey.replace(/^local\//, '');
  await fetch(apiUrl(`/api/local/${encodeURIComponent(keyPart)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// ─── 本地文件播放器（原生 video / audio / img） ──────────────────────────────
function LocalPlayer({ stream, compact, onVideoReady, onVideoUnmount, onEnded }) {
  const mediaRef = useRef(null);
  const wrapperRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isAudio = stream.fileType === 'audio';
  const isImage = stream.fileType === 'image';
  const loop = stream.loop ?? false;
  const autoplay = stream.autoplay ?? true;
  const playbackRate = stream.playbackRate ?? 1.0;
  const duration = Number(stream.duration ?? (isImage ? 5 : 0));

  // 构建可访问的 URL
  const mediaUrl = localStreamUrl(stream);

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

  // 同步播放设置到 media 元素（图片无 playbackRate）
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || isImage) return;
    el.loop = loop;
    el.playbackRate = playbackRate;
  }, [loop, playbackRate, isImage]);

  // 播放结束回调（用于顺序播放）
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || loop || isImage) return;
    const handleEnded = () => onEnded?.(stream.streamKey);
    el.addEventListener('ended', handleEnded);
    return () => el.removeEventListener('ended', handleEnded);
  }, [stream.streamKey, loop, onEnded, isImage]);

  // 图片：非持续显示时，停留 duration 秒后切换下一条
  useEffect(() => {
    if (!isImage || loop || duration <= 0) return;
    const timer = setTimeout(() => onEnded?.(stream.streamKey), duration * 1000);
    return () => clearTimeout(timer);
  }, [isImage, loop, duration, stream.streamKey, onEnded]);

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
    if (mediaRef.current && !isImage) mediaRef.current.loop = next;
  }, [stream.streamKey, loop, isImage]);

  const handleCycleRate = useCallback(async (e) => {
    e.stopPropagation();
    const idx = RATE_CYCLE.indexOf(playbackRate);
    const next = RATE_CYCLE[(idx + 1) % RATE_CYCLE.length];
    await patchLocalSettings(stream.streamKey, { playbackRate: next });
    if (mediaRef.current) mediaRef.current.playbackRate = next;
  }, [stream.streamKey, playbackRate]);

  const displayName = stream.fileName || stream.streamKey;
  const typeLabel = isAudio ? '音频' : isImage ? '图片' : '视频';
  const typeIcon = isAudio ? '🎵' : isImage ? '🖼' : '🎬';

  return (
    <div className={`video-player-container ${compact ? 'compact' : ''}`}>
      <div className="video-header">
        <h2 title={displayName}>{compact ? displayName.slice(0, 20) : displayName}</h2>
        <div className="video-header-actions">
          {!isImage && (
            <button
              className={`player-ctrl-btn ${loop ? 'player-ctrl-btn--on' : ''}`}
              onClick={handleToggleLoop}
              title={loop ? '循环：开启（点击关闭）' : '循环：关闭（点击开启）'}
            >🔁</button>
          )}
          {isImage && (
            <button
              className={`player-ctrl-btn ${loop ? 'player-ctrl-btn--on' : ''}`}
              onClick={handleToggleLoop}
              title={loop ? '持续显示（点击关闭）' : '点击设为持续显示'}
            >🖼</button>
          )}
          {!isImage && (
            <button
              className={`player-ctrl-btn player-ctrl-btn--rate ${playbackRate !== 1.0 ? 'player-ctrl-btn--on' : ''}`}
              onClick={handleCycleRate}
              title={`播放速率 ${playbackRate}x（点击切换）`}
            >{playbackRate}x</button>
          )}
          <span className="live-badge local-badge">{typeIcon} {typeLabel}</span>
          {!isAudio && (
            <button className="fullscreen-btn" onClick={toggleFullscreen}>
              {isFullscreen ? '⤓ 退出全屏' : '⛶ 全屏'}
            </button>
          )}
        </div>
      </div>
      <div className="video-wrapper" ref={wrapperRef} onDoubleClick={!isAudio ? toggleFullscreen : undefined}>
        {isImage ? (
          <img
            ref={mediaRef}
            src={mediaUrl}
            alt={displayName}
            className="video-player local-image"
            draggable={false}
          />
        ) : isAudio ? (
          <audio ref={mediaRef} src={mediaUrl} controls className="local-audio"
            crossOrigin="anonymous"
            autoPlay={autoplay} loop={loop} />
        ) : (
          <video ref={mediaRef} src={mediaUrl} className="video-player" controls playsInline
            crossOrigin="anonymous"
            autoPlay={autoplay} loop={loop} />
        )}
      </div>
      {!compact && (
        <div className="video-info">
          <p>文件: {stream.fileName}</p>
          <p>类型: {typeLabel}</p>
          {isImage ? (
            <p>显示: {loop ? '持续' : duration > 0 ? `${duration} 秒后切换` : '常驻'}</p>
          ) : (
            <p>循环: {loop ? '开启' : '关闭'} | 自动播放: {autoplay ? '开启' : '关闭'} | 速率: {playbackRate}x</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── RTMP / FLV 直播播放器 ────────────────────────────────────────────────────
function LivePlayer({ stream, compact, onVideoReady, onVideoUnmount }) {
  const videoRef = useRef(null);
  const wrapperRef = useRef(null);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [stats, setStats] = useState({ latency: 0, bufferLength: 0, fps: 0, bitrate: 0 });

  const url = flvUrl(stream.flvPath || `/${stream.streamKey}.flv`);
  const { state, playerRef, retryNow } = useLivePlayer({ videoRef, url, hasAudio: true });

  useEffect(() => {
    setHasInteracted(false);
  }, [stream.streamKey]);

  // 把媒体元素交给主窗口音频图（混音台 / 录制都依赖它）
  useEffect(() => {
    const el = videoRef.current;
    if (el) onVideoReady?.(stream.streamKey, el);
    return () => onVideoUnmount?.(stream.streamKey);
  }, [stream.streamKey, onVideoReady, onVideoUnmount]);

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // 实时统计（延迟 / 缓冲 / 帧率 / 码率）
  // 几个坑：
  //  - flv.js 的 statisticsInfo 只有 speed(KB/s) 和 decodedFrames，没有 videoDataRate/audioDataRate
  //  - 而 video.getVideoPlaybackQuality().totalVideoFrames 在 Electron 31 的 MSE 播放链路上是死值，
  //    所以帧率改用 requestVideoFrameCallback 数「真正呈现的帧」
  useEffect(() => {
    const videoEl = videoRef.current;
    let presentedFrames = 0;
    let lastPresentedFrames = 0;
    let lastDecodedFrames = 0;
    let lastAt = Date.now();
    let frameHandle = null;

    const useRvfc = typeof videoEl?.requestVideoFrameCallback === 'function';
    const onFrame = () => {
      presentedFrames += 1;
      frameHandle = videoEl.requestVideoFrameCallback(onFrame);
    };
    if (useRvfc) frameHandle = videoEl.requestVideoFrameCallback(onFrame);

    const timer = setInterval(() => {
      const v = videoRef.current;
      const p = playerRef.current;
      if (!v || !p) return;
      const info = p.statisticsInfo;

      const now = Date.now();
      const dt = (now - lastAt) / 1000;
      if (dt <= 0) return;

      let fps = 0;
      if (useRvfc) {
        fps = Math.max(0, Math.round((presentedFrames - lastPresentedFrames) / dt));
        lastPresentedFrames = presentedFrames;
      } else if (info && typeof info.decodedFrames === 'number') {
        fps = Math.max(0, Math.round((info.decodedFrames - lastDecodedFrames) / dt));
        lastDecodedFrames = info.decodedFrames;
      }
      lastAt = now;

      const hasBuffer = v.buffered && v.buffered.length > 0;
      const latencyMs = hasBuffer
        ? Math.round((v.buffered.end(v.buffered.length - 1) - v.currentTime) * 1000)
        : 0;
      const bufferedMs = hasBuffer
        ? Math.round((v.buffered.end(v.buffered.length - 1) - v.buffered.start(0)) * 1000)
        : 0;
      // speed 单位是 KB/s
      const kbps = info && typeof info.speed === 'number' ? Math.round(info.speed * 8) : 0;

      setStats({
        latency: Math.max(0, latencyMs),
        bufferLength: Math.max(0, bufferedMs),
        fps,
        bitrate: Math.max(0, kbps),
      });
    }, 1000);

    return () => {
      clearInterval(timer);
      if (useRvfc && frameHandle != null) {
        try { videoEl.cancelVideoFrameCallback(frameHandle); } catch { /* ignore */ }
      }
    };
  }, [playerRef]);

  const toggleFullscreen = () => {
    const el = wrapperRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el).catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  };

  const retrying = state.phase === 'retrying';
  const failed = state.phase === 'failed';

  return (
    <div className={`video-player-container ${compact ? 'compact' : ''}`}>
      <div className="video-header">
        <h2>{stream.streamKey}</h2>
        <div className="video-header-actions">
          {retrying ? (
            <span className="live-badge reconnecting-badge">⏳ 重连中 {state.attempt}</span>
          ) : failed ? (
            <span className="live-badge reconnecting-badge">⚠ 已断开</span>
          ) : (
            <span className="live-badge">🔴 直播中</span>
          )}
          <button className="fullscreen-btn" onClick={toggleFullscreen}>
            {isFullscreen ? '⤓ 退出全屏' : '⛶ 全屏'}
          </button>
        </div>
      </div>
      <div className="video-wrapper" ref={wrapperRef} onDoubleClick={toggleFullscreen}>
        <video ref={videoRef} className="video-player" controls playsInline />

        {/* 实时统计信息 */}
        <div className="video-stats-overlay">
          <div className="stats-line">延迟: <span className={stats.latency > 1000 ? 'warn' : ''}>{stats.latency}ms</span></div>
          <div className="stats-line">缓冲: {stats.bufferLength}ms</div>
          <div className="stats-line">帧率: {stats.fps} fps</div>
          <div className="stats-line">码率: {stats.bitrate} kbps</div>
        </div>

        {!hasInteracted && state.phase === 'connecting' && (
          <div className="play-overlay" onClick={() => { setHasInteracted(true); videoRef.current?.play?.().catch(() => {}); }}>
            <button className="play-button">{compact ? '▶' : '▶ 点击播放'}</button>
          </div>
        )}
        {retrying && (
          <div className="reconnect-overlay">
            <p>连接中断，{Math.ceil(state.delay / 1000)} 秒后第 {state.attempt} 次重连</p>
            <button className="reconnect-btn" onClick={retryNow}>↻ 立即重连</button>
          </div>
        )}
        {failed && (
          <div className="error-overlay">
            <p>{state.message || '连接已断开'}</p>
            <button className="reconnect-btn" onClick={retryNow}>↻ 重新连接</button>
          </div>
        )}
      </div>
      {!compact && (
        <div className="video-info">
          <p>开始时间: {new Date(stream.startTime).toLocaleString('zh-CN')}</p>
          <p>状态: {stream.status === 'online' ? '在线' : '离线'}</p>
          <p>流地址: {url}</p>
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
