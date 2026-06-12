import { useEffect, useRef, useState } from 'react';
import flvjs from 'flv.js';

const FLV_HOST = 'http://localhost:8000';

/**
 * 主控窗口里的「PROGRAM 监视」浮窗
 * 实时回放当前选为输出的流,和 OutputView 走同一份低延迟配置
 *
 * Props:
 * - streamKey: 当前选为输出的流 key (null 时不渲染)
 * - streams:   活跃流列表,用于拿对应的 flvPath
 */
function OutputMonitor({ streamKey, streams }) {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState(null);

  // 用户主动关掉之后,如果输出流换成另一路,自动重开
  useEffect(() => {
    if (streamKey) setHidden(false);
  }, [streamKey]);

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

    // 兜底追播,防止局部抖动后越积越长
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
  }, [streamKey, streams, hidden, collapsed]);

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
        <div className="output-monitor-body">
          <video
            ref={videoRef}
            className="output-monitor-video"
            autoPlay
            muted
            playsInline
          />
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
