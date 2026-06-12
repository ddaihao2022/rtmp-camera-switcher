import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './AudioView.css';

const API_HOST = 'http://localhost:3001';

// ─── 单路音频条（仅控制，不拉流） ─────────────────────────────────────────────
function Channel({ streamKey, type, fileType, outputStream, socket, initVol, initMuted, vuData }) {
  const peakRef = useRef(0);
  const peakHoldRef = useRef(0);
  const [volume, setVolume] = useState(initVol ?? 1);
  const [muted, setMuted] = useState(initMuted ?? false);

  const isOutput = outputStream === streamKey;
  const isLocal = type === 'local';
  const linked = !!vuData;
  const rms = vuData?.rms ?? 0;
  const bars = vuData?.bars ? new Uint8Array(vuData.bars) : new Uint8Array(32);

  // 外部状态同步（来自主窗口或其他客户端）
  useEffect(() => {
    if (initVol != null) setVolume(initVol);
    if (initMuted != null) setMuted(initMuted);
  }, [initVol, initMuted]);

  // VU 峰值保持
  useEffect(() => {
    if (rms > peakRef.current) {
      peakRef.current = rms;
      peakHoldRef.current = 55;
    } else if (peakHoldRef.current > 0) {
      peakHoldRef.current--;
    } else {
      peakRef.current = Math.max(0, peakRef.current - 0.004);
    }
  }, [rms]);

  const handleVolume = (e) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    socket?.emit('audio:setState', { streamKey, volume: v, muted });
  };

  const handleMute = () => {
    const next = !muted;
    setMuted(next);
    socket?.emit('audio:setState', { streamKey, volume, muted: next });
  };

  const vuPct = Math.min(rms * 7, 1) * 100;
  const peakPct = Math.min(peakRef.current * 7, 1) * 100;
  const vuColor = vuPct > 85 ? '#ef4444' : vuPct > 60 ? '#f59e0b' : '#10b981';
  const dbLabel = rms > 0 ? `${(20 * Math.log10(rms + 1e-9)).toFixed(1)} dB` : '-∞ dB';

  return (
    <div className={`ch ${isOutput ? 'ch--out' : ''} ${muted ? 'ch--muted' : ''}`}>
      <div className="ch-title">
        {isOutput && <span className="ch-out-dot" />}
        <span className="ch-name" title={streamKey}>
          {isLocal ? (fileType === 'audio' ? '🎵 ' : '🎬 ') : ''}
          {isLocal ? streamKey.replace(/^local\//, '') : streamKey}
        </span>
        {!linked && <span className="ch-loading" title="主窗口未播放此路">○</span>}
      </div>

      <div className="ch-spectrum">
        {Array.from(bars).map((v, i) => (
          <div
            key={i}
            className="ch-spec-bar"
            style={{ height: `${(v / 255) * 100}%`, opacity: muted ? 0.25 : 1 }}
          />
        ))}
      </div>

      <div className="ch-vu">
        <div className="ch-vu-fill" style={{ width: `${vuPct}%`, background: vuColor }} />
        <div className="ch-vu-peak" style={{ left: `${peakPct}%` }} />
      </div>
      <div className="ch-db">{dbLabel}</div>

      <div className="ch-fader-wrap">
        <input
          type="range"
          className="ch-fader"
          orient="vertical"
          min="0" max="1.5" step="0.01"
          value={muted ? 0 : volume}
          onChange={handleVolume}
          disabled={muted}
          title={`${Math.round(volume * 100)}%`}
        />
        <div className="ch-fader-marks">
          <span>150</span><span>100</span><span>50</span><span>0</span>
        </div>
      </div>

      <div className="ch-vol-val">{muted ? 'MUTE' : `${Math.round(volume * 100)}%`}</div>

      <button
        className={`ch-mute ${muted ? 'ch-mute--on' : ''}`}
        onClick={handleMute}
      >
        {muted ? '🔇 取消静音' : '🔊 静音'}
      </button>
    </div>
  );
}

// ─── 主视图 ───────────────────────────────────────────────────────────────────
function AudioView() {
  const [streams, setStreams] = useState([]);
  const [outputStream, setOutputStream] = useState(null);
  const [audioState, setAudioState] = useState({});
  const [vuData, setVuData] = useState({});
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(API_HOST);
    socketRef.current = socket;

    socket.on('streamUpdate', setStreams);
    socket.on('outputSelected', ({ streamKey }) => setOutputStream(streamKey || null));
    socket.on('audio:stateUpdate', (state) => setAudioState(state));
    socket.on('audio:vuData', (data) => setVuData(data));

    fetch(`${API_HOST}/api/output`).then(r => r.json())
      .then(d => d.selectedStream && setOutputStream(d.selectedStream)).catch(() => {});
    fetch(`${API_HOST}/api/audio/state`).then(r => r.json())
      .then(d => setAudioState(d)).catch(() => {});

    return () => socket.disconnect();
  }, []);

  return (
    <div className="audio-view">
      <div className="av-header">
        <span className="av-title">🎚 音频混音台</span>
        <span className="av-sub">{streams.length} 路活跃</span>
      </div>

      <div className="av-channels">
        {streams.length === 0 ? (
          <div className="av-empty">
            <p>暂无推流</p>
            <p className="av-hint">等待设备推流到 RTMP 服务器...</p>
          </div>
        ) : (
          streams.map(s => (
            <Channel
              key={s.streamKey}
              streamKey={s.streamKey}
              type={s.type}
              fileType={s.fileType}
              outputStream={outputStream}
              socket={socketRef.current}
              initVol={audioState[s.streamKey]?.volume ?? 1}
              initMuted={audioState[s.streamKey]?.muted ?? false}
              vuData={vuData[s.streamKey]}
            />
          ))
        )}
      </div>

      {outputStream && (
        <div className="av-footer">
          <span className="av-out-label">PROGRAM OUT →</span>
          <span className="av-out-key">{outputStream}</span>
        </div>
      )}
    </div>
  );
}

export default AudioView;
