import { useEffect, useRef, useState } from 'react';
import { flvUrl } from '../config.js';
import { useLivePlayer } from '../useLivePlayer.js';

/**
 * 主控窗口里的「PROGRAM 监视」浮窗
 * 实时回放当前选为输出的流,和 OutputView 走同一套低延迟配置与自动重连
 *
 * Props:
 * - streamKey: 当前选为输出的流 key (null 时不渲染)
 * - streams:   活跃流列表,用于拿对应的 flvPath
 */
function OutputMonitor({ streamKey, streams }) {
  const videoRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState(false);

  // 用户主动关掉之后,如果输出流换成另一路,自动重开
  useEffect(() => {
    if (streamKey) setHidden(false);
  }, [streamKey]);

  // 只依赖这一路自己的 FLV 地址：否则任何一路流上下线都会重建监视窗，画面会闪
  const liveStream = streams.find(s => s.streamKey === streamKey && s.type !== 'local');
  const liveFlvPath = streamKey ? (liveStream?.flvPath || `/${streamKey}.flv`) : null;

  const { state, retryNow } = useLivePlayer({
    videoRef,
    url: liveFlvPath ? flvUrl(liveFlvPath) : null,
    hasAudio: false,
    enabled: !!liveFlvPath && !hidden && !collapsed,
  });

  if (!streamKey || hidden) return null;

  const isLive = streams.some(s => s.streamKey === streamKey);
  const retrying = state.phase === 'retrying';
  const failed = state.phase === 'failed';

  return (
    <div className={`output-monitor ${collapsed ? 'collapsed' : ''}`}>
      <div className="output-monitor-head">
        <span className="output-monitor-label">
          <span className="rec-dot" />
          PROGRAM · {streamKey}
          {retrying && <span className="reconnecting-inline"> · 重连中 {state.attempt}</span>}
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
          {retrying && (
            <div className="output-monitor-msg">画面中断，{Math.ceil(state.delay / 1000)}s 后第 {state.attempt} 次重连…</div>
          )}
          {failed && (
            <div className="output-monitor-msg error">
              {state.message || '连接已断开'}
              <button className="reconnect-btn" onClick={retryNow} style={{ marginLeft: 8 }}>↻ 重连</button>
            </div>
          )}
          {!retrying && !failed && !isLive && (
            <div className="output-monitor-msg">等待 {streamKey} 上线…</div>
          )}
        </div>
      )}
    </div>
  );
}

export default OutputMonitor;
