import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import flvjs from 'flv.js';
import './OutputView.css';

const API_HOST = 'http://localhost:3001';
const FLV_HOST = 'http://localhost:8000';

function OutputView() {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const [streamKey, setStreamKey] = useState(null);
  const [streams, setStreams] = useState([]);
  const [error, setError] = useState(null);

  // 拉取一次当前已选输出
  useEffect(() => {
    fetch(`${API_HOST}/api/output`)
      .then(r => r.json())
      .then(d => d.selectedStream && setStreamKey(d.selectedStream))
      .catch(() => {});
  }, []);

  // 接收实时事件
  useEffect(() => {
    const socket = io(API_HOST);
    socket.on('streamUpdate', setStreams);
    socket.on('outputSelected', ({ streamKey }) => setStreamKey(streamKey || null));
    return () => socket.disconnect();
  }, []);

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
    if (!streamKey || !videoRef.current || !flvjs.isSupported()) return;

    const matched = streams.find(s => s.streamKey === streamKey);
    const url = matched?.flvPath
      ? `${FLV_HOST}${matched.flvPath}`
      : `${FLV_HOST}/${streamKey}.flv`;

    const player = flvjs.createPlayer(
      { type: 'flv', url, isLive: true, hasAudio: false, hasVideo: true },
      { enableWorker: false, enableStashBuffer: false, autoCleanupSourceBuffer: true }
    );
    player.on(flvjs.Events.ERROR, (t, d) => setError(`${t}: ${d}`));
    player.attachMediaElement(videoRef.current);
    player.load();
    const v = videoRef.current;
    const tryPlay = () => v?.play?.().catch(() => {});
    v.addEventListener('loadeddata', tryPlay, { once: true });
    playerRef.current = player;

    return () => {
      v?.removeEventListener('loadeddata', tryPlay);
      safeDestroy();
    };
  }, [streamKey, streams]);

  const isLive = streamKey && streams.some(s => s.streamKey === streamKey);

  return (
    <div className="output-root">
      {streamKey ? (
        <>
          <video
            ref={videoRef}
            className="output-video"
            autoPlay
            muted
            playsInline
          />
          {!isLive && (
            <div className="output-msg">
              <p>等待 {streamKey} 上线...</p>
            </div>
          )}
          {error && (
            <div className="output-msg error">
              <p>{error}</p>
            </div>
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
