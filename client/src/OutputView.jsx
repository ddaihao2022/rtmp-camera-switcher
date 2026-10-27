import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './OutputView.css';
import './components/ScoreboardOverlay.css';
import ScoreboardOverlay from './components/ScoreboardOverlay';
import MediaLayer from './components/MediaLayer';
import GradeVeil from './components/GradeVeil';
import { normalizeGrade, resolveGrade } from './utils/color';

const API_HOST = 'http://localhost:3001';

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
  const [pinnedSource] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('source') || null;
    } catch {
      return null;
    }
  });
  const [streamKey, setStreamKey] = useState(pinnedSource);
  const [outgoingKey, setOutgoingKey] = useState(null);
  const [previewKey, setPreviewKey] = useState(null);
  const [fx, setFx] = useState(null); // { type, duration, direction, id }
  const [streams, setStreams] = useState([]);
  const [error, setError] = useState(null);
  const [watermark, setWatermark] = useState(null);
  const [scoreboard, setScoreboard] = useState(null);
  const [colorGrade, setColorGrade] = useState(null);
  const fxTimer = useRef(null);
  const lastTransitionAt = useRef(0);
  const inTransition = useRef(false);

  useEffect(() => {
    document.body.classList.add('output-mode');
    return () => document.body.classList.remove('output-mode');
  }, []);

  useEffect(() => () => clearTimeout(fxTimer.current), []);

  const clearFx = useCallback(() => {
    clearTimeout(fxTimer.current);
    setFx(null);
    setOutgoingKey(null);
    inTransition.current = false;
  }, []);

  const beginTransition = useCallback((payload) => {
    if (pinnedSource) return;
    const { from, to, type, duration, direction, at } = payload || {};
    if (!to || !from || from === to || type === 'cut') return;
    if (at && at === lastTransitionAt.current) return;
    if (at) lastTransitionAt.current = at;

    clearTimeout(fxTimer.current);
    inTransition.current = true;
    setOutgoingKey(from);
    setStreamKey(to);
    const d = Math.max(120, Math.min(3000, Number(duration) || 500));
    setFx({ type, duration: d, direction: direction || 'left', id: at || Date.now() });
    fxTimer.current = setTimeout(clearFx, d + 80);
  }, [pinnedSource, clearFx]);

  useEffect(() => {
    if (pinnedSource) {
      setStreamKey(pinnedSource);
      return;
    }
    fetch(`${API_HOST}/api/output`)
      .then(r => r.json())
      .then(d => {
        setStreamKey(d.selectedStream || null);
        setPreviewKey(d.previewStream || null);
      })
      .catch(() => {});
  }, [pinnedSource]);

  useEffect(() => {
    const socket = io(API_HOST);
    socket.on('streamUpdate', setStreams);
    socket.on('outputTransition', beginTransition);
    socket.on('previewSelected', ({ streamKey: key } = {}) => setPreviewKey(key || null));
    socket.on('outputSelected', ({ streamKey: key }) => {
      if (pinnedSource) return;
      // 转场进行中由 outputTransition 接管；硬切直接切换
      if (!inTransition.current) setStreamKey(key || null);
    });
    socket.on('watermark:update', setWatermark);
    socket.on('scoreboard:update', setScoreboard);
    socket.on('color:update', setColorGrade);
    return () => socket.disconnect();
  }, [pinnedSource, beginTransition]);

  useEffect(() => {
    fetch(`${API_HOST}/api/watermark`).then(r => r.json()).then(setWatermark).catch(() => {});
    fetch(`${API_HOST}/api/scoreboard`).then(r => r.json()).then(setScoreboard).catch(() => {});
    fetch(`${API_HOST}/api/color`).then(r => r.json()).then(d => setColorGrade(normalizeGrade(d))).catch(() => {});
  }, []);

  // 转场结束后强制回到单层（防 timer 丢失）
  useEffect(() => {
    if (!fx) return undefined;
    const t = setTimeout(clearFx, fx.duration + 120);
    return () => clearTimeout(t);
  }, [fx, clearFx]);

  const handleError = useCallback((msg) => setError(msg), []);
  const isLive = streamKey && streams.some(s => s.streamKey === streamKey);
  const localItem = streams.find(s => s.streamKey === streamKey && s.type === 'local');
  const showOutgoing = !!fx && !!outgoingKey && outgoingKey !== streamKey;

  // 预加载池：当前输出、转场中的旧画面、主控预览(PVW) 三路常驻。
  // TAKE 时只是把它从“隐藏/预热”改成“当前”，播放器不重建 → 不会等关键帧黑屏。
  const layerKeys = [];
  if (streamKey) layerKeys.push(streamKey);
  if (showOutgoing && outgoingKey && !layerKeys.includes(outgoingKey)) layerKeys.push(outgoingKey);
  if (previewKey && streams.some(s => s.streamKey === previewKey) && !layerKeys.includes(previewKey)) layerKeys.push(previewKey);

  // 调色：每一层各自取自己的参数（全局 / 机位覆盖），在渲染时按 streamKey 解析

  const fxClass = fx
    ? `fx fx-${fx.type}${fx.type === 'wipe' || fx.type === 'slide' ? ` fx-dir-${fx.direction}` : ''}`
    : '';

  const fxStyle = fx
    ? { '--fx-duration': `${fx.duration}ms` }
    : undefined;

  return (
    <div className={`output-root ${fxClass}`} style={fxStyle}>
      {layerKeys.length ? (
        <div className="output-stage">
          {layerKeys.map((k) => {
            const isCurrent = k === streamKey;
            const isOutgoing = showOutgoing && k === outgoingKey;
            const role = isCurrent ? 'layer-current' : (isOutgoing ? 'layer-outgoing' : 'layer-preload');
            const g = resolveGrade(colorGrade, k);
            return (
              <div
                key={`layer-${k}`}
                className={`media-layer ${role} ${isCurrent && showOutgoing ? 'layer-animating' : ''}`}
              >
                <MediaLayer streamKey={k} streams={streams} grade={g} onError={isCurrent ? handleError : undefined} />
                <GradeVeil grade={g} />
              </div>
            );
          })}
          {(fx?.type === 'dip' || fx?.type === 'mix') && showOutgoing && (
            <div className="fx-veil" aria-hidden="true" />
          )}
          <Watermark config={watermark} />
          <ScoreboardOverlay config={scoreboard} />
          {pinnedSource && (
            <div className="output-pin-badge">固定源 · {pinnedSource}</div>
          )}
          {streamKey && !isLive && !localItem && (
            <div className="output-msg"><p>等待 {streamKey} 上线...</p></div>
          )}
          {error && <div className="output-msg error"><p>{error}</p></div>}
        </div>
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
