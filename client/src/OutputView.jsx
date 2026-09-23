import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import flvjs from 'flv.js';
import './OutputView.css';
import './components/ScoreboardOverlay.css';
import { buildFlvUrl, getUnsupportedCodecMessage, isBrowserPlayableStream } from './utils/stream';
import { FLV_PROGRAM_OPTIONS, startCatchUp, tryPlay } from './utils/lowLatency';
import ScoreboardOverlay from './components/ScoreboardOverlay';

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
  // URL 固定信号源（多路 HDMI 分发时 pin 到某一路）；空则跟随全局 PROGRAM
  const [pinnedSource] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('source') || null;
    } catch {
      return null;
    }
  });
  const [streamKey, setStreamKey] = useState(pinnedSource);
  const [streams, setStreams] = useState([]);
  const [error, setError] = useState(null);
  const [watermark, setWatermark] = useState(null);
  const [scoreboard, setScoreboard] = useState(null);

  // 仅在输出视图下打开「全屏黑背景 + 隐藏鼠标」模式,卸载时复原
  useEffect(() => {
    document.body.classList.add('output-mode');
    return () => document.body.classList.remove('output-mode');
  }, []);

  // 固定源模式：streamKey 始终为 pinned；否则跟随全局输出
  useEffect(() => {
    if (pinnedSource) {
      setStreamKey(pinnedSource);
      return;
    }
    fetch(`${API_HOST}/api/output`)
      .then(r => r.json())
      .then(d => setStreamKey(d.selectedStream || null))
      .catch(() => {});
  }, [pinnedSource]);

  // 接收实时事件
  useEffect(() => {
    const socket = io(API_HOST);
    socket.on('streamUpdate', setStreams);
    socket.on('outputSelected', ({ streamKey: key }) => {
      if (!pinnedSource) setStreamKey(key || null);
    });
    socket.on('watermark:update', setWatermark);
    socket.on('scoreboard:update', setScoreboard);
    return () => socket.disconnect();
  }, [pinnedSource]);

  // 拉取初始水印 / 比分条
  useEffect(() => {
    fetch(`${API_HOST}/api/watermark`).then(r => r.json()).then(setWatermark).catch(() => {});
    fetch(`${API_HOST}/api/scoreboard`).then(r => r.json()).then(setScoreboard).catch(() => {});
  }, []);

  // 选中流变化时,重建播放器（PROGRAM 级低延迟配置）
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

    const matched = streams.find(s => s.streamKey === streamKey) || { streamKey };
    if (!isBrowserPlayableStream(matched)) {
      setError(getUnsupportedCodecMessage(matched));
      return;
    }
    const url = buildFlvUrl(matched, FLV_HOST);

    const player = flvjs.createPlayer(
      { type: 'flv', url, isLive: true, hasAudio: false, hasVideo: true },
      FLV_PROGRAM_OPTIONS
    );
    player.on(flvjs.Events.ERROR, (t, d) => setError(`${t}: ${d}`));
    player.attachMediaElement(videoRef.current);
    player.load();
    const v = videoRef.current;
    const onLoaded = () => tryPlay(v);
    v.addEventListener('loadeddata', onLoaded, { once: true });

    // 兜底追播：更激进，适合赛事直播
    const stopCatchUp = startCatchUp(v, {
      jumpLag: 0.55,
      softLag: 0.3,
      intervalMs: 300,
      softRate: 1.3,
    });

    playerRef.current = player;

    return () => {
      stopCatchUp();
      v?.removeEventListener('loadeddata', onLoaded);
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
            ) : localItem.fileType === 'image' ? (
              <img src={localUrl} alt={localItem.fileName} className="output-video output-image" draggable={false} />
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
          <ScoreboardOverlay config={scoreboard} />
          {pinnedSource && (
            <div className="output-pin-badge">固定源 · {pinnedSource}</div>
          )}
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
