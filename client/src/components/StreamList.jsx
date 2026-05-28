function StreamList({ streams, selectedStream, outputStream, onStreamSelect, onSelectOutput }) {
  return (
    <div className="stream-list">
      {streams.length === 0 ? (
        <div className="empty-state">
          <p>暂无活跃设备</p>
          <p className="hint">等待设备推流...</p>
        </div>
      ) : (
        streams.map((stream) => (
          <div
            key={stream.streamKey}
            className={`stream-item ${selectedStream?.streamKey === stream.streamKey ? 'active' : ''} ${outputStream === stream.streamKey ? 'output' : ''}`}
          >
            <div className="stream-icon">📹</div>
            <div className="stream-details" onClick={() => onStreamSelect(stream)}>
              <h3>{stream.streamKey}</h3>
              <p className="stream-time">
                {new Date(stream.startTime).toLocaleTimeString('zh-CN')}
              </p>
              <span className="stream-status online">在线</span>
              {outputStream === stream.streamKey && (
                <span className="output-badge">📡 输出中</span>
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
        ))
      )}
    </div>
  );
}

export default StreamList;
