import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SOCKET_URL, apiUrl, flvUrl, localStreamUrl } from './config.js';
import { useLivePlayer } from './useLivePlayer.js';
import './OutputView.css';

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
  const [streamKey, setStreamKey] = useState(null);
  const [streams, setStreams] = useState([]);
  const [watermark, setWatermark] = useState(null);

  // ?audio=1 时输出窗口带声音；默认只有画面，避免与主窗口音频叠音。
  // 打开展示端扬声器出声时，建议在混音台把该路静音（主窗口静音，输出窗口仍出声）。
  const withAudio = (() => {
    try {
      return new URLSearchParams(window.location.search).get('audio') === '1';
    } catch {
      return false;
    }
  })();

  // 仅在输出视图下打开「全屏黑背景 + 隐藏鼠标」模式,卸载时复原
  useEffect(() => {
    document.body.classList.add('output-mode');
    return () => document.body.classList.remove('output-mode');
  }, []);

  // 拉取一次当前已选输出
  useEffect(() => {
    fetch(apiUrl('/api/output'))
      .then(r => r.json())
      .then(d => d.selectedStream && setStreamKey(d.selectedStream))
      .catch(() => {});
  }, []);

  // 接收实时事件
  useEffect(() => {
    const socket = io(SOCKET_URL);
    socket.on('streamUpdate', setStreams);
    socket.on('outputSelected', ({ streamKey }) => setStreamKey(streamKey || null));
    socket.on('watermark:update', setWatermark);
    return () => socket.disconnect();
  }, []);

  // 拉取初始水印配置
  useEffect(() => {
    fetch(apiUrl('/api/watermark')).then(r => r.json()).then(setWatermark).catch(() => {});
  }, []);

  const localItem = streams.find(s => s.streamKey === streamKey && s.type === 'local');
  const liveStream = streams.find(s => s.streamKey === streamKey && s.type !== 'local');
  // 只依赖这一路自己的 FLV 路径：否则任何一路流上下线都会重建播放器，HDMI 画面会闪
  const liveFlvPath = streamKey && !localItem
    ? (liveStream?.flvPath || `/${streamKey}.flv`)
    : null;
  const localUrl = localItem ? localStreamUrl(localItem) : null;
  const isLive = !!streamKey && streams.some(s => s.streamKey === streamKey);

  // 断流/重启自动重连，HDMI 画面不需要人工干预
  const { state, retryNow } = useLivePlayer({
    videoRef,
    url: liveFlvPath ? flvUrl(liveFlvPath) : null,
    hasAudio: withAudio,
    enabled: !!liveFlvPath,
  });

  const retrying = state.phase === 'retrying';
  const failed = state.phase === 'failed';

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
                  muted={!withAudio}
                  ref={el => { if (el) el.playbackRate = localItem.playbackRate ?? 1.0; }} />
              </div>
            ) : localItem.fileType === 'image' ? (
              <img src={localUrl} alt={localItem.fileName} className="output-video output-image" draggable={false} />
            ) : (
              <video src={localUrl} className="output-video"
                autoPlay={localItem.autoplay ?? true} playsInline controls={false}
                muted={!withAudio}
                loop={localItem.loop ?? false}
                ref={el => { if (el) el.playbackRate = localItem.playbackRate ?? 1.0; }} />
            )
          ) : (
            <video ref={videoRef} className="output-video" autoPlay muted={!withAudio} playsInline />
          )}
          <Watermark config={watermark} />
          {retrying && (
            <div className="output-msg">
              <p>画面中断，正在第 {state.attempt} 次重连…</p>
              <p className="hint">{Math.ceil(state.delay / 1000)} 秒后重试</p>
            </div>
          )}
          {failed && (
            <div className="output-msg error">
              <p>{state.message || '连接已断开'}</p>
              <button className="reconnect-btn" onClick={retryNow} style={{ marginTop: 12 }}>↻ 重新连接</button>
            </div>
          )}
          {!retrying && !failed && !isLive && !localItem && (
            <div className="output-msg"><p>等待 {streamKey} 上线...</p></div>
          )}
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
