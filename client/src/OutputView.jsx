import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import flvjs from 'flv.js';
import { SOCKET_URL, apiUrl, flvUrl, localStreamUrl } from './config.js';
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
  const playerRef = useRef(null);
  const [streamKey, setStreamKey] = useState(null);
  const [streams, setStreams] = useState([]);
  const [error, setError] = useState(null);
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

  const isLive = streamKey && streams.some(s => s.streamKey === streamKey);
  const localItem = streams.find(s => s.streamKey === streamKey && s.type === 'local');

  const localUrl = localItem ? localStreamUrl(localItem) : null;

  // 只把「这一路实际的 FLV 地址」作为依赖：
  // 之前依赖整个 streams 数组，任何一路上下线都会重建播放器，导致 HDMI 画面闪一下。
  const liveStream = streams.find(s => s.streamKey === streamKey && s.type !== 'local');
  const liveFlvPath = streamKey ? (liveStream?.flvPath || `/${streamKey}.flv`) : null;

  // 选中流变化时,重建播放器
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
    if (!streamKey || !liveFlvPath || !videoRef.current || !flvjs.isSupported()) return;

    const url = flvUrl(liveFlvPath);

    const player = flvjs.createPlayer(
      { type: 'flv', url, isLive: true, hasAudio: withAudio, hasVideo: true },
      {
        enableWorker: false,
        enableStashBuffer: false,
        stashInitialSize: 32,  // 降低初始缓冲
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 2,  // 更激进地清理历史缓冲
        autoCleanupMinBackwardDuration: 1,
        // flv.js 1.6+ 内置追播:超过 maxLatency 自动加速到 minRemain
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 0.5,  // 降低最大延迟阈值
        liveBufferLatencyMinRemain: 0.1,   // 降低目标剩余缓冲
        lazyLoad: false,
        seekType: 'range'
      }
    );
    player.on(flvjs.Events.ERROR, (t, d) => setError(`${t}: ${d}`));
    player.attachMediaElement(videoRef.current);
    player.load();
    const v = videoRef.current;
    const tryPlay = () => v?.play?.().catch(() => {});
    v.addEventListener('loadeddata', tryPlay, { once: true });

    // 兜底追播:更频繁地检查并采用更激进的策略
    const catchUpTimer = setInterval(() => {
      if (!v || v.paused || !v.buffered.length) return;
      const liveEdge = v.buffered.end(v.buffered.length - 1);
      const lag = liveEdge - v.currentTime;
      // 更激进的追播策略
      if (lag > 0.8) {
        v.currentTime = liveEdge - 0.1;  // 直接跳到接近实时位置
      } else if (lag > 0.5) {
        v.playbackRate = 1.2;  // 轻微加速
      } else {
        v.playbackRate = 1.0;  // 恢复正常
      }
    }, 500);  // 更高频率检查

    playerRef.current = player;

    return () => {
      clearInterval(catchUpTimer);
      v?.removeEventListener('loadeddata', tryPlay);
      safeDestroy();
    };
  }, [streamKey, liveFlvPath, withAudio]);

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
          {!isLive && !localItem && (
            <div className="output-msg"><p>等待 {streamKey} 上线...</p></div>
          )}
          {error && <div className="output-msg error"><p>{error}</p></div>}
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
