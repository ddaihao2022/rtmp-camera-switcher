import { getVideoCodecLabel, isBrowserPlayableStream } from '../utils/stream';

function StreamList({ streams, selectedStream, outputStream, onStreamSelect, onSelectOutput, indexOffset = 0 }) {
  if (streams.length === 0) {
    return (
      <div className="stream-list stream-list--compact">
        <p className="empty-state-inline">暂无设备 · 等待推流…</p>
      </div>
    );
  }

  return (
    <div className="stream-list">
      {streams.map((stream, i) => {
        const hotkey = indexOffset + i + 1;
        const codecLabel = getVideoCodecLabel(stream);
        const codecHint = codecLabel !== 'unknown' ? `编码: ${codecLabel}` : null;

        // 编码兼容徽标：转码就绪 / 转码中 / 转码失败 / 不兼容
        let codecTag = null;
        if (stream.type !== 'local') {
          if (stream.transcodeStatus === 'ready') {
            codecTag = { text: '已转码 H.264', color: '#22c55e', border: 'rgba(34,197,94,0.4)', bg: 'rgba(34,197,94,0.12)' };
          } else if (!isBrowserPlayableStream(stream)) {
            if (stream.transcodeStatus === 'pending') {
              codecTag = { text: '转码中…', color: '#3b82f6', border: 'rgba(59,130,246,0.4)', bg: 'rgba(59,130,246,0.12)' };
            } else if (stream.transcodeStatus === 'error') {
              codecTag = { text: '转码失败', color: '#ef4444', border: 'rgba(239,68,68,0.4)', bg: 'rgba(239,68,68,0.12)' };
            } else {
              codecTag = { text: '编码不兼容', color: '#f59e0b', border: 'rgba(245,158,11,0.35)', bg: 'rgba(245,158,11,0.12)' };
            }
          }
        }

        return (
          <div
            key={stream.streamKey}
            className={`stream-item ${selectedStream?.streamKey === stream.streamKey ? 'active' : ''} ${outputStream === stream.streamKey ? 'output' : ''}`}
          >
            {hotkey <= 9 && (
              <span className="stream-hotkey" title={`导播台：按 ${hotkey} 设为预览(PVW)，Shift+${hotkey} 直接切输出(PGM)`}>
                {hotkey}
              </span>
            )}

            <div className="stream-icon">📹</div>

            <div className="stream-details" onClick={() => onStreamSelect(stream)}>
              <h3>{stream.streamKey}</h3>
              <p className="stream-time">{new Date(stream.startTime).toLocaleTimeString('zh-CN')}</p>
              {codecHint && <p className="stream-time">{codecHint}</p>}
              <span className="stream-status online">在线</span>
              {outputStream === stream.streamKey && <span className="output-badge">📡 输出中</span>}
              {codecTag && (
                <span
                  className="stream-status"
                  style={{ color: codecTag.color, borderColor: codecTag.border, background: codecTag.bg }}
                >
                  {codecTag.text}
                </span>
              )}
            </div>

            <button
              className="select-output-btn"
              onClick={(e) => {
                e.stopPropagation();
                onSelectOutput(stream.streamKey);
              }}
              title="选择此画面作为输出"
            >
              {outputStream === stream.streamKey ? '✓' : '📡'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default StreamList;
