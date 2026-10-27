import { useEffect, useRef, useState, useCallback } from 'react';
import flvjs from 'flv.js';
import {
  buildFlvUrl, canPlayWithTranscode, getUnsupportedCodecMessage, getVideoCodecLabel,
} from '../utils/stream';
import { FLV_PREVIEW_OPTIONS, FLV_PROGRAM_OPTIONS, startCatchUp, tryPlay } from '../utils/lowLatency';
import { buildFilter } from '../utils/color';
import GradeVeil from './GradeVeil';

const API = 'http://localhost:3001';

const RATE_CYCLE = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

/** 调色参数 → 视频元素内联 filter */
function gradeFilterStyle(grade) {
  const f = buildFilter(grade);
  return f ? { filter: f } : undefined;
}

async function patchLocalSettings(streamKey, patch) {
  const keyPart = streamKey.replace(/^local\//, '');
  const r = await fetch(`${API}/api/local/${encodeURIComponent(keyPart)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  // 以前不检查 r.ok：服务端没存上，界面却按新设置播，切走再切回来又变回去
  if (!r.ok) {
    let d = {};
    try { d = await r.json(); } catch { d = {}; }
    throw new Error(d?.error || `保存失败（HTTP ${r.status}）`);
  }
}

// ─── 本地文件播放器（原生 video / audio / img） ──────────────────────────────
function LocalPlayer({ stream, compact, grade, onVideoReady, onVideoUnmount, onEnded, preload = false }) {
  const mediaRef = useRef(null);
  const wrapperRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [ctrlError, setCtrlError] = useState('');
  const ctrlErrorTimer = useRef(null);
  // 父组件每次渲染都会传新的 onEnded，用 ref 保存，避免图片定时器被反复重置
  const onEndedRef = useRef(onEnded);
  useEffect(() => { onEndedRef.current = onEnded; }, [onEnded]);

  useEffect(() => () => clearTimeout(ctrlErrorTimer.current), []);

  const showCtrlError = useCallback((err) => {
    setCtrlError(err?.message || String(err));
    clearTimeout(ctrlErrorTimer.current);
    ctrlErrorTimer.current = setTimeout(() => setCtrlError(''), 4000);
  }, []);

  const isAudio = stream.fileType === 'audio';
  const isImage = stream.fileType === 'image';
  const loop = stream.loop ?? false;
  const autoplay = stream.autoplay ?? true;
  const playbackRate = stream.playbackRate ?? 1.0;
  const duration = Number(stream.duration ?? (isImage ? 5 : 0));

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

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || isImage) return;
    el.loop = loop;
    el.playbackRate = playbackRate;
  }, [loop, playbackRate, isImage]);

  // 视频/音频：播放结束切换下一条
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || loop || isImage) return;
    const handleEnded = () => onEndedRef.current?.(stream.streamKey);
    el.addEventListener('ended', handleEnded);
    return () => el.removeEventListener('ended', handleEnded);
  }, [stream.streamKey, loop, isImage]);

  // 图片：非持续显示时，停留 duration 秒后通知切换下一条
  useEffect(() => {
    if (!isImage || loop || duration <= 0) return;
    const timer = setTimeout(() => onEndedRef.current?.(stream.streamKey), duration * 1000);
    return () => clearTimeout(timer);
  }, [isImage, loop, duration, stream.streamKey]);

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
    try {
      await patchLocalSettings(stream.streamKey, { loop: next });
      if (mediaRef.current && !isImage) mediaRef.current.loop = next;
    } catch (err) {
      showCtrlError(err);
    }
  }, [stream.streamKey, loop, isImage, showCtrlError]);

  const handleCycleRate = useCallback(async (e) => {
    e.stopPropagation();
    const idx = RATE_CYCLE.indexOf(playbackRate);
    const next = RATE_CYCLE[(idx + 1) % RATE_CYCLE.length];
    try {
      await patchLocalSettings(stream.streamKey, { playbackRate: next });
      if (mediaRef.current) mediaRef.current.playbackRate = next;
    } catch (err) {
      showCtrlError(err);
    }
  }, [stream.streamKey, playbackRate, showCtrlError]);

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
          /* crossOrigin 同上：图片也要进画布合成录制，跨域会污染画布 */
          <img
            ref={mediaRef}
            src={mediaUrl}
            alt={displayName}
            className="video-player local-image"
            crossOrigin="anonymous"
            draggable={false}
          />
        ) : isAudio ? (
          <audio ref={mediaRef} src={mediaUrl} controls className="local-audio"
            autoPlay={autoplay} loop={loop} />
        ) : (
          /* crossOrigin：本地素材走服务端 HTTP，带 CORS 才不算跨域污染画布（带调色录制需要） */
          <video ref={mediaRef} src={mediaUrl} className="video-player" controls playsInline muted={preload}
            crossOrigin="anonymous" autoPlay={autoplay} loop={loop} style={gradeFilterStyle(grade)} />
        )}
        {/* 本地视频同样走调色；图片/音频素材不调色 */}
        {!isImage && !isAudio && <GradeVeil grade={grade} />}
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
function LivePlayer({ stream, compact, program, grade, onVideoReady, onVideoUnmount, onSelectPreview, onTake, preload = false }) {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const wrapperRef = useRef(null);
  const [error, setError] = useState(null);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [stats, setStats] = useState({ latency: 0, bufferLength: 0, fps: 0, bitrate: 0 });
  const [waitingKeyframe, setWaitingKeyframe] = useState(false);

  // 只把"真正影响起播"的字段算成字符串/布尔：流列表每秒都可能推送新的 stream 对象，
  // 直接把 stream 放进 effect 依赖会让播放器被反复销毁重建（黑屏、卡顿、音频重连）
  // 多机位时 Chromium 对同一 origin 的 HTTP/1.1 并发上限只有 6：把机位墙和
  // PROGRAM/预览/输出拆到 localhost 与 127.0.0.1 两个源，避免第 7 路一直连不上。
  const FLV_HOST = compact ? 'http://localhost:8000' : 'http://127.0.0.1:8000';
  const streamKey = stream?.streamKey;
  const flvUrl = buildFlvUrl(stream, FLV_HOST);
  const playable = canPlayWithTranscode(stream);
  const unsupportedMessage = playable ? '' : getUnsupportedCodecMessage(stream);
  // 收到不支持编码 → 服务端会拉 ffmpeg 实时转码成 H.264，就绪后 buildFlvUrl 自动指向子流。
  // 转码期间先显示"转码中"，不要把用户推到红框上（也避免红框残留）。
  const transcoding = !playable && stream?.transcodeStatus === 'pending';
  const transcodeFailed = !playable
    && (stream?.transcodeStatus === 'error' || stream?.transcodeStatus === 'stopped');

  useEffect(() => {
    setHasInteracted(false);
    setError(null);
  }, [streamKey]);

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

    // 每次重新起播都先清掉上一次的错误：转码就绪后会改播 H.264 子流，
    // 之前那条"编码不支持"的红框必须跟着消失，否则会一直挂在新画面上
    setError(null);
    // 指标也一起清零，别在"转码中"显示上一路流残留的延迟/帧率
    setStats({ latency: 0, bufferLength: 0, fps: 0, bitrate: 0 });
    setWaitingKeyframe(false);

    if (!flvjs.isSupported()) { setError('浏览器不支持FLV播放'); return; }

    // 转码中：什么都不播，等 transcodeStatus 变 ready（flvUrl 变化）再自动起播
    if (transcoding) return;
    if (unsupportedMessage) {
      // 服务端要等 2 秒嗅探编码才拉起转码，这中间状态还是 null，
      // 先给个宽限期再报红框，别让正常转码的流闪一下"编码不支持"
      if (transcodeFailed) { setError(unsupportedMessage); return; }
      const timer = setTimeout(() => setError(unsupportedMessage), 1800);
      return () => clearTimeout(timer);
    }

    // PROGRAM / 主监看用更激进配置；多画面预览略宽松
    const options = program ? FLV_PROGRAM_OPTIONS : FLV_PREVIEW_OPTIONS;

    const player = flvjs.createPlayer(
      { type: 'flv', url: flvUrl, isLive: true, hasAudio: !compact, hasVideo: true },
      options
    );

    const onError = (t, d) => { console.error('FLV错误:', t, d); setError(`${t}: ${d}`); };
    player.on(flvjs.Events.ERROR, onError);
    playerRef.current = player;
    player.attachMediaElement(videoRef.current);
    player.load();
    onVideoReady?.(streamKey, videoRef.current);

    const v = videoRef.current;
    const tryPlayOnce = () => tryPlay(v);
    v.addEventListener('loadeddata', tryPlayOnce, { once: true });
    v.addEventListener('canplay', tryPlayOnce, { once: true });

    // 只要真的开始播放，就收起"点击播放"遮罩：
    // 自动播放被策略放行、或用户点了原生控件时，遮罩不能继续挡在画面上。
    const markPlaying = () => setHasInteracted(true);
    v.addEventListener('playing', markPlaying);
    v.addEventListener('play', markPlaying);
    if (!v.paused && v.readyState >= 2) setHasInteracted(true);

    const stopCatchUp = startCatchUp(v, program
      ? { jumpLag: 0.55, softLag: 0.3, intervalMs: 300, softRate: 1.3 }
      : { jumpLag: 0.8, softLag: 0.45, intervalMs: 500, softRate: 1.2 });

    // 5 秒还没有解出第一帧：多半是推流端关键帧间隔太长，或子流刚切过来。
    // 给一个明确提示，别让操作员对着 0 fps 的黑屏猜。
    const waitTimer = setTimeout(() => setWaitingKeyframe(true), 5000);

    let lastDecodedFrames = 0;
    let lastTime = Date.now();

    const statsTimer = setInterval(() => {
      if (!v || !playerRef.current) return;

      const info = playerRef.current.statisticsInfo;
      const currentTime = Date.now();
      const deltaTime = (currentTime - lastTime) / 1000;

      if (info && deltaTime > 0) {
        const currentFrames = info.decodedFrames || 0;
        const fps = Math.round((currentFrames - lastDecodedFrames) / deltaTime);
        lastDecodedFrames = currentFrames;
        lastTime = currentTime;
        if (currentFrames > 0 || (v && v.readyState >= 2 && v.currentTime > 0)) {
          setWaitingKeyframe(false);
        }

        // flv.js: 码率在 mediaInfo（来自 onMetaData，单位 kbps）里；
        // statisticsInfo.speed 是实时下载速度且单位是 KB/s（不是累计字节），换算要 ×8
        const mediaInfo = playerRef.current.mediaInfo || {};
        const metaBitrate = (mediaInfo.videoDataRate || 0) + (mediaInfo.audioDataRate || 0);
        const bitrate = metaBitrate > 0
          ? Math.round(metaBitrate)
          : Math.round((info.speed || 0) * 8);

        const latency = v.buffered.length > 0
          ? Math.round((v.buffered.end(v.buffered.length - 1) - v.currentTime) * 1000)
          : 0;
        const bufferLength = v.buffered.length > 0
          ? Math.round((v.buffered.end(v.buffered.length - 1) - v.buffered.start(0)) * 1000)
          : 0;

        setStats({
          latency: Math.max(0, latency),
          bufferLength: Math.max(0, bufferLength),
          fps: fps > 0 ? fps : info.currentFps || 0,
          bitrate,
        });
      }
    }, 1000);

    return () => {
      clearTimeout(waitTimer);
      clearInterval(statsTimer);
      onVideoUnmount?.(streamKey);
      stopCatchUp();
      v?.removeEventListener('loadeddata', tryPlayOnce);
      v?.removeEventListener('canplay', tryPlayOnce);
      v?.removeEventListener('playing', markPlaying);
      v?.removeEventListener('play', markPlaying);
      const p = playerRef.current; playerRef.current = null;
      if (!p) return;
      try { p.off?.(flvjs.Events.ERROR, onError); p.unload(); p.detachMediaElement(); p.destroy(); } catch {}
    };
  }, [streamKey, flvUrl, unsupportedMessage, transcoding, transcodeFailed, reloadKey, program, compact, onVideoUnmount]);

  return (
    <div
      className={`video-player-container ${compact ? 'compact' : ''} ${program ? 'is-program' : ''}`}
      onClick={compact && onSelectPreview ? (e) => { e.stopPropagation(); onSelectPreview(stream); } : undefined}
      onDoubleClick={compact && onTake ? (e) => { e.stopPropagation(); onTake(stream); } : undefined}
      title={compact ? '单击设为预览 · 双击切换至输出' : undefined}
      role={compact && onSelectPreview ? 'button' : undefined}
    >
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
        <video ref={videoRef} key={reloadKey} className="video-player" controls={!compact} playsInline muted={compact || preload}
          style={gradeFilterStyle(grade)} />

        <GradeVeil grade={grade} />

        <div className="video-stats-overlay">
          <div className="stats-line">延迟: <span className={stats.latency > 1000 ? 'warn' : ''}>{stats.latency}ms</span></div>
          <div className="stats-line">缓冲: {stats.bufferLength}ms</div>
          <div className="stats-line">帧率: {stats.fps} fps</div>
          <div className="stats-line">码率: {stats.bitrate} kbps</div>
        </div>

        {transcoding && (
          <div className="transcode-overlay">
            <span className="transcode-spinner" aria-hidden="true" />
            <p>
              当前流为 {getVideoCodecLabel(stream)}，服务端正在实时转码 H.264…
              <br />
              <span className="transcode-hint">就绪后自动播放，无需点重连</span>
            </p>
          </div>
        )}
        {waitingKeyframe && !transcoding && !error && (
          <div className="transcode-overlay">
            <span className="transcode-spinner" aria-hidden="true" />
            <p>
              {stream.status === 'stalled' ? '推流端没有画面数据' : '等待关键帧…'}
              <br />
              <span className="transcode-hint">
                {stream.status === 'stalled'
                  ? '摄像头可能切到后台/锁屏，或编码器已停止；重新推流即可'
                  : '推流端关键帧间隔过长时会黑屏几秒；持续不出画面请改用 H.264'}
              </span>
            </p>
          </div>
        )}
        {!hasInteracted && !error && !compact && !transcoding && !waitingKeyframe && (
          <div className="play-overlay" onClick={() => { setHasInteracted(true); videoRef.current?.play?.().catch(() => {}); }}>
            <button className="play-button">▶ 点击播放</button>
          </div>
        )}
        {error && !transcoding && (
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
          <p>流地址: {flvUrl}</p>
        </div>
      )}
    </div>
  );
}

// ─── 统一入口 ─────────────────────────────────────────────────────────────────
function VideoPlayer({ stream, compact = false, program = false, grade = null, onVideoReady, onVideoUnmount, onEnded, onSelectPreview, onTake, preload = false }) {
  if (stream?.type === 'local') {
    return <LocalPlayer stream={stream} compact={compact} grade={grade} onVideoReady={onVideoReady} onVideoUnmount={onVideoUnmount} onEnded={onEnded} preload={preload} />;
  }
  return (
    <LivePlayer
      stream={stream}
      compact={compact}
      program={program}
      grade={grade}
      onVideoReady={onVideoReady}
      onVideoUnmount={onVideoUnmount}
      onSelectPreview={onSelectPreview}
      onTake={onTake}
      preload={preload}
    />
  );
}

export default VideoPlayer;
