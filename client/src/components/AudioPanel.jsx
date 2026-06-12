import { useEffect, useRef, useState, useCallback } from 'react';
import {
  connectStream, disconnectStream,
  setVolume, getVolume,
  setMute, isMuted,
  getRms
} from '../audio.js';

/**
 * 单路音频条
 */
function AudioChannel({ streamKey, videoEl, outputStream }) {
  const [volume, setVolumeState] = useState(1);
  const [muted, setMutedState] = useState(false);
  const [rms, setRms] = useState(0);
  const rafRef = useRef(null);
  const peakRef = useRef(0);
  const peakHoldRef = useRef(0); // peak 保持帧计数

  // 接入 Web Audio
  useEffect(() => {
    if (!videoEl) return;
    connectStream(streamKey, videoEl);
    const savedVol = getVolume(streamKey);
    setVolumeState(savedVol);
    setMutedState(isMuted(streamKey));
    return () => disconnectStream(streamKey);
  }, [streamKey, videoEl]);

  // VU 表动画
  useEffect(() => {
    const tick = () => {
      const r = getRms(streamKey);
      setRms(r);
      if (r > peakRef.current) {
        peakRef.current = r;
        peakHoldRef.current = 60; // 保持 ~1s
      } else if (peakHoldRef.current > 0) {
        peakHoldRef.current--;
      } else {
        peakRef.current = Math.max(0, peakRef.current - 0.005);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [streamKey]);

  const handleVolume = (e) => {
    const v = parseFloat(e.target.value);
    setVolumeState(v);
    if (!muted) setVolume(streamKey, v);
  };

  const handleMute = () => {
    const next = !muted;
    setMutedState(next);
    setMute(streamKey, next);
  };

  const isOutput = outputStream === streamKey;

  // VU 颜色分段：绿 → 黄 → 红
  const vuPercent = Math.min(rms * 6, 1) * 100;
  const peakPercent = Math.min(peakRef.current * 6, 1) * 100;
  const vuColor = vuPercent > 85 ? '#ef4444' : vuPercent > 65 ? '#f59e0b' : '#10b981';

  return (
    <div className={`audio-channel ${isOutput ? 'audio-channel--output' : ''} ${muted ? 'audio-channel--muted' : ''}`}>
      <div className="audio-channel-label" title={streamKey}>
        {isOutput && <span className="audio-out-dot" />}
        <span className="audio-channel-name">{streamKey}</span>
      </div>

      {/* VU 表 */}
      <div className="vu-meter">
        <div className="vu-bar" style={{ width: `${vuPercent}%`, background: vuColor }} />
        <div className="vu-peak" style={{ left: `${peakPercent}%` }} />
      </div>

      {/* 音量滑块 */}
      <div className="audio-fader-row">
        <button
          className={`mute-btn ${muted ? 'muted' : ''}`}
          onClick={handleMute}
          title={muted ? '取消静音' : '静音'}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          className="audio-fader"
          min="0" max="1.5" step="0.01"
          value={muted ? 0 : volume}
          onChange={handleVolume}
          disabled={muted}
        />
        <span className="audio-vol-label">
          {muted ? 'M' : `${Math.round(volume * 100)}%`}
        </span>
      </div>
    </div>
  );
}

/**
 * 音频面板 - 显示所有活跃流的音频控制
 * Props:
 *   streams      - 活跃流列表
 *   outputStream - 当前输出流 key
 *   videoRefs    - Map<streamKey, HTMLVideoElement>，由 App 层维护
 */
function AudioPanel({ streams, outputStream, videoRefs }) {
  const [collapsed, setCollapsed] = useState(false);

  if (streams.length === 0) return null;

  return (
    <div className={`audio-panel ${collapsed ? 'audio-panel--collapsed' : ''}`}>
      <div className="audio-panel-head">
        <span className="audio-panel-title">🎚 音频混音</span>
        <button
          className="audio-panel-toggle"
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▲' : '▼'}
        </button>
      </div>

      {!collapsed && (
        <div className="audio-channels-list">
          {streams.map(s => (
            <AudioChannel
              key={s.streamKey}
              streamKey={s.streamKey}
              videoEl={videoRefs?.get(s.streamKey) ?? null}
              outputStream={outputStream}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default AudioPanel;
