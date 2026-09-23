import { getVideoCodecLabel, isBrowserPlayableStream } from '../utils/stream';

function StreamList({ streams, selectedStream, outputStream, onStreamSelect, onSelectOutput, indexOffset = 0 }) {
  return (
    <div className="stream-list">
      {streams.length === 0 ? (
        <div className="empty-state">
          <p>暂无活跃设备</p>
          <p className="hint">等待设备推流...</p>
        </div>
      ) : (
        streams.map((stream, i) => {
          const hotkey = indexOffset + i + 1;
          const codecLabel = getVideoCodecLabel(stream);
          const codecHint = codecLabel !== 'unknown' ? `编码: ${codecLabel}` : null;
          const unsupportedHint = stream.type !== 'local' && !isBrowserPlayableStream(stream);

          return (
            <div
              key={stream.streamKey}
              className={`stream-item ${selectedStream?.streamKey === stream.streamKey ? 'active' : ''} ${outputStream === stream.streamKey ? 'output' : ''}`}
            >
              {hotkey <= 9 && (
                <span className="stream-hotkey" title={`按 ${hotkey} 切换输出，Shift+${hotkey} 仅预览`}>
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
                {unsupportedHint && (
                  <span
                    className="stream-status"
                    style={{
                      color: '#f59e0b',
                      borderColor: 'rgba(245, 158, 11, 0.35)',
                      background: 'rgba(245, 158, 11, 0.12)',
                    }}
                  >
                    编码不兼容
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
        })
      )}
    </div>
  );
}

export default StreamList;
