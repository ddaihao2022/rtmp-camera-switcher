import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import flvjs from 'flv.js';
import './OutputView.css';

const API_HOST = 'http://localhost:3001';
const FLV_HOST = 'http://localhost:8000';

const POSITION_STYLE = {
  'top-left':     { top: 0,    left: 0,    bottom: 'auto', right: 'auto' },
  'top-right':    { top: 0,    right: 0,   bottom: 'auto', left: 'auto' },
  'bottom-left':  { bottom: 0, left: 0,    top: 'auto',    right: 'auto' },
  'bottom-right': { bottom: 0, right: 0,   top: 'auto',    left: 'auto' },
  'center':       { top: '50%', left: '50%', transform: 'translate(-50%,-50%)', bottom: 'auto', right: 'auto' },
};

function Watermark({ config }) {
  if (!config?.enabled) return null;
  const { type, text, imageUrl, position, opacity, fontSize, color, padding } = config;
  const posStyle = POSITION_STYLE[position] || POSITION_STYLE['bottom-right'];

  return (
    <div
      className="wm-layer"
      style={{
        position: 'absolute',
        opacity,
        padding,
        pointerEvents: 'none',
        zIndex: 10,
        mixBlendMode: 'screen',
        ...posStyle,
      }}
    >
      {type === 'text' ? (
        <span style={{
          fontSize,
          color,
          fontWeight: 'bold',
          textShadow: '0 0 8px rgba(0,0,0,0.9), 0 2px 4px rgba(0,0,0,0.8)',
          whiteSpace: 'pre',
          letterSpacing: '0.03em',
        }}>
          {text}
        </span>
      ) : imageUrl ? (
        <img src={imageUrl} alt="watermark"
          style={{ maxHeight: fontSize * 3, maxWidth: 320, objectFit: 'contain', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.6))' }} />
      ) : null}
    </div>
  );
}

function OutputView() {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const [streamKey, setStreamKey] = useState(null);
  const [streams, setStreams] = useState([]);
  const [error, setError] = useState(null);
  const [watermark, setWatermark] = useState(null);

  // 仅在输出视图下打开「全屏黑背景 + 隐藏鼠标」模式,卸载时复原
  useEffect(() => {
    document.body.classList.add('output-mode');
    return () => document.body.classList.remove('output-mode');
  }, []);

  // 拉取一次当前已选输出
  useEffect(() => {
    fetch(`${API_HOST}/api/output`)
      .then(r => r.json())
      .then(d => d.selectedStream && setStreamKey(d.selectedStream))
      .catch(() => {});
  }, []);

  // 接收实时事件
  useEffect(() => {
    const socket = io(API_HOST);
    socket.on('streamUpdate', setStreams);
    socket.on('outputSelected', ({ streamKey }) => setStreamKey(streamKey || null));
    socket.on('watermark:update', setWatermark);
    return () => socket.disconnect();
  }, []);

  // 拉取初始水印配置
  useEffect(() => {
    fetch(`${API_HOST}/api/watermark`).then(r => r.json()).then(setWatermark).catch(() => {});
  }, []);

  // 选中流变化时,重建播放器
  useEffect(() => {
    const safeDestroy = () => {
      if (playerRef.current) {
        try {
          playerRef.current.unload();
          playerRef.current.detachMediaElement();
          playerRef.current.destroy();
        } catch (_) {}
        playerRef.current = null;
      }
    };

    safeDestroy();
    setError(null);
    if (!streamKey || !videoRef.current || !flvjs.isSupported()) return;

    const matched = streams.find(s => s.streamKey === streamKey);
    const url = matched?.flvPath
      ? `${FLV_HOST}${matched.flvPath}`
      : `${FLV_HOST}/${streamKey}.flv`;

    const player = flvjs.createPlayer(
      { type: 'flv', url, isLive: true, hasAudio: false, hasVideo: true },
      {
        enableWorker: false,
        enableStashBuffer: false,
        stashInitialSize: 128,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 3,
        autoCleanupMinBackwardDuration: 2,
        // flv.js 1.6+ 内置追播:超过 maxLatency 自动加速到 minRemain
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 1.0,
        liveBufferLatencyMinRemain: 0.3
      }
    );
    player.on(flvjs.Events.ERROR, (t, d) => setError(`${t}: ${d}`));
    player.attachMediaElement(videoRef.current);
    player.load();
    const v = videoRef.current;
    const tryPlay = () => v?.play?.().catch(() => {});
    v.addEventListener('loadeddata', tryPlay, { once: true });

    // 兜底追播:每秒检查 buffered 末端与 currentTime 差距,>1.5s 直接 seek 到末端
    // flv.js 内置追播仅靠 playbackRate,极端抖动下会失效;seek 更硬核
    const catchUpTimer = setInterval(() => {
      if (!v || v.paused || !v.buffered.length) return;
      const liveEdge = v.buffered.end(v.buffered.length - 1);
      if (liveEdge - v.currentTime > 1.5) {
        v.currentTime = liveEdge - 0.2;
      }
    }, 1000);

    playerRef.current = player;

    return () => {
      clearInterval(catchUpTimer);
      v?.removeEventListener('loadeddata', tryPlay);
      safeDestroy();
    };
  }, [streamKey, streams]);

  const isLive = streamKey && streams.some(s => s.streamKey === streamKey);
  const localItem = streams.find(s => s.streamKey === streamKey && s.type === 'local');

  const localUrl = localItem
    ? (localItem.filePath?.startsWith('blob:')
        ? localItem.filePath
        : `http://localhost:3001/api/local/stream/${encodeURIComponent(localItem.streamKey.replace(/^local\//, ''))}`)
    : null;

  return (
    <div className="output-root">
      {streamKey ? (
        <>
          {localItem ? (
            localItem.fileType === 'audio' ? (
              <div className="output-audio-wrap">
                <p className="output-audio-label">🎵 {localItem.fileName}</p>
                <audio src={localUrl} autoPlay={localItem.autoplay ?? true}
                  loop={localItem.loop ?? false} controls className="output-audio"
                  ref={el => { if (el) el.playbackRate = localItem.playbackRate ?? 1.0; }} />
              </div>
            ) : (
              <video src={localUrl} className="output-video"
                autoPlay={localItem.autoplay ?? true} playsInline controls={false}
                loop={localItem.loop ?? false}
                ref={el => { if (el) el.playbackRate = localItem.playbackRate ?? 1.0; }} />
            )
          ) : (
            <video ref={videoRef} className="output-video" autoPlay muted playsInline />
          )}
          <Watermark config={watermark} />
          {!isLive && !localItem && (
            <div className="output-msg"><p>等待 {streamKey} 上线...</p></div>
          )}
          {error && <div className="output-msg error"><p>{error}</p></div>}
        </>
      ) : (
        <div className="output-msg">
          <p>未选择输出画面</p>
          <p className="hint">请在主控端选择一路画面</p>
        </div>
      )}
    </div>
  );
}

export default OutputView;
