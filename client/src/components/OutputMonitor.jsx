import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import flvjs from 'flv.js';
import { buildFlvUrl, canPlayWithTranscode, getUnsupportedCodecMessage } from '../utils/stream';
import { FLV_PREVIEW_OPTIONS, startCatchUp, tryPlay } from '../utils/lowLatency';
import { buildFilter } from '../utils/color';
import GradeVeil from './GradeVeil';
import ScoreboardOverlay from './ScoreboardOverlay';

const FLV_HOST = 'http://127.0.0.1:8000';

/**
 * 主控窗口里的「PROGRAM 监视」浮窗
 * 实时回放当前选为输出的流,和 OutputView 走同一份低延迟配置
 *
 * Props:
 * - streamKey: 当前选为输出的流 key (null 时不渲染)
 * - streams:   活跃流列表,用于拿对应的 flvPath
 * - grade:     该路生效的调色参数（与 HDMI 输出保持一致）
 */
function OutputMonitor({ streamKey, streams, grade = null }) {
  const gradeStyle = (() => {
    const f = buildFilter(grade);
    return f ? { filter: f } : undefined;
  })();
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const bodyRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState(null);
  const [scoreboard, setScoreboard] = useState(null);
  const [fx, setFx] = useState(null);
  const [stageScale, setStageScale] = useState(0);

  // streams 每次 streamUpdate 都是新数组/新对象（服务端每秒都可能推一次），
  // 不能直接进 effect 依赖，否则播放器每秒被销毁重建一次（画面一直黑）
  const matched = streams.find(s => s.streamKey === streamKey) || { streamKey };
  const flvUrl = streamKey ? buildFlvUrl(matched, FLV_HOST) : '';
  const unsupportedMessage = streamKey && !canPlayWithTranscode(matched)
    ? getUnsupportedCodecMessage(matched)
    : '';

  useEffect(() => {
    fetch('http://localhost:3001/api/scoreboard')
      .then(r => r.json())
      .then(setScoreboard)
      .catch(() => {});
    const socket = io('http://localhost:3001');
    socket.on('scoreboard:update', setScoreboard);
    socket.on('outputTransition', (p) => {
      if (!p || p.type === 'cut') return;
      setFx({ ...p, id: p.at || Date.now() });
      setTimeout(() => setFx(null), (p.duration || 500) + 80);
    });
    return () => socket.disconnect();
  }, []);

  // 用户主动关掉之后,如果输出流换成另一路,自动重开
  useEffect(() => {
    if (streamKey) setHidden(false);
  }, [streamKey]);

  // 叠加层按 1280×720 设计稿绘制，再整体缩放进 360px 的小监看：
  // 否则 scoreboard 的 vw/px 尺寸会按主窗口算，信息条会比浮窗还宽、被裁掉。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const apply = () => setStageScale(el.clientWidth / 1280);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [streamKey, hidden, collapsed]);

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

    if (!streamKey || hidden || collapsed) return;
    if (!videoRef.current || !flvjs.isSupported()) return;

    if (unsupportedMessage) {
      setError(unsupportedMessage);
      return;
    }

    const player = flvjs.createPlayer(
      { type: 'flv', url: flvUrl, isLive: true, hasAudio: false, hasVideo: true },
      FLV_PREVIEW_OPTIONS
    );
    player.on(flvjs.Events.ERROR, (t, d) => setError(`${t}: ${d}`));
    player.attachMediaElement(videoRef.current);
    player.load();

    const v = videoRef.current;
    const tryPlayOnce = () => tryPlay(v);
    v.addEventListener('loadeddata', tryPlayOnce, { once: true });

    const stopCatchUp = startCatchUp(v, {
      jumpLag: 0.6,
      softLag: 0.35,
      intervalMs: 400,
      softRate: 1.25,
    });

    playerRef.current = player;

    return () => {
      stopCatchUp();
      v?.removeEventListener('loadeddata', tryPlayOnce);
      safeDestroy();
    };
  }, [streamKey, flvUrl, unsupportedMessage, hidden, collapsed]);

  if (!streamKey || hidden) return null;

  const isLive = streams.some(s => s.streamKey === streamKey);

  return (
    <div className={`output-monitor ${collapsed ? 'collapsed' : ''}`}>
      <div className="output-monitor-head">
        <span className="output-monitor-label">
          <span className="rec-dot" />
          PROGRAM · {streamKey}
        </span>
        <div className="output-monitor-actions">
          <button
            className="output-monitor-btn"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? '展开' : '折叠'}
          >
            {collapsed ? '▢' : '—'}
          </button>
          <button
            className="output-monitor-btn"
            onClick={() => setHidden(true)}
            title="关闭"
          >
            ×
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="output-monitor-body" ref={bodyRef}>
          <video
            ref={videoRef}
            className="output-monitor-video"
            autoPlay
            muted
            playsInline
            style={gradeStyle}
          />
          <GradeVeil grade={grade} />
          {fx && (
            <div
              className={`pgm-fx pgm-fx-${fx.type} pgm-fx-dir-${fx.direction || 'left'}`}
              style={{ '--fx-duration': `${fx.duration || 500}ms` }}
              aria-hidden="true"
            />
          )}
          <div
            className="output-monitor-stage"
            style={{ transform: `scale(${stageScale})`, opacity: stageScale ? 1 : 0 }}
          >
            <ScoreboardOverlay config={scoreboard} />
          </div>
          {!isLive && (
            <div className="output-monitor-msg">等待 {streamKey} 上线…</div>
          )}
          {error && (
            <div className="output-monitor-msg error">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default OutputMonitor;
