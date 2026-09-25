/**
 * 单路媒体层：RTMP/FLV 或本地音视频/图片
 * 供 OutputView 转场双层叠加使用
 */
import { useEffect, useRef } from 'react';
import flvjs from 'flv.js';
import { buildFlvUrl, getUnsupportedCodecMessage, isBrowserPlayableStream } from '../utils/stream';
import { FLV_PROGRAM_OPTIONS, startCatchUp, tryPlay } from '../utils/lowLatency';

const API = 'http://localhost:3001';
const FLV_HOST = 'http://localhost:8000';

export default function MediaLayer({ streamKey, streams = [], onError }) {
  const videoRef = useRef(null);
  const playerRef = useRef(null);

  const localItem = streams.find(s => s.streamKey === streamKey && s.type === 'local');
  const liveItem = streams.find(s => s.streamKey === streamKey);

  const localUrl = localItem
    ? (localItem.filePath?.startsWith('blob:')
        ? localItem.filePath
        : `${API}/api/local/stream/${encodeURIComponent(String(localItem.streamKey).replace(/^local\//, ''))}`)
    : null;

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
    onError?.(null);

    // 本地素材走原生标签
    if (localItem || !streamKey) return () => {};

    if (!videoRef.current || !flvjs.isSupported()) {
      if (!flvjs.isSupported()) onError?.('浏览器不支持FLV播放');
      return () => {};
    }
    if (!isBrowserPlayableStream(liveItem || { streamKey })) {
      onError?.(getUnsupportedCodecMessage(liveItem || { streamKey }));
      return () => {};
    }

    const url = buildFlvUrl(liveItem || { streamKey }, FLV_HOST);
    const player = flvjs.createPlayer(
      { type: 'flv', url, isLive: true, hasAudio: false, hasVideo: true },
      FLV_PROGRAM_OPTIONS
    );
    const onErr = (t, d) => onError?.(`${t}: ${d}`);
    player.on(flvjs.Events.ERROR, onErr);
    player.attachMediaElement(videoRef.current);
    player.load();
    playerRef.current = player;

    const v = videoRef.current;
    const onLoaded = () => tryPlay(v);
    v.addEventListener('loadeddata', onLoaded, { once: true });
    const stop = startCatchUp(v, { jumpLag: 0.55, softLag: 0.3, intervalMs: 300, softRate: 1.3 });

    return () => {
      stop();
      v?.removeEventListener('loadeddata', onLoaded);
      try { player.off?.(flvjs.Events.ERROR, onErr); } catch {}
      safeDestroy();
    };
  }, [streamKey, streams, localItem, liveItem, onError]);

  if (!streamKey) return null;

  if (localItem) {
    if (localItem.fileType === 'audio') {
      return (
        <div className="output-audio-wrap media-layer">
          <p className="output-audio-label">🎵 {localItem.fileName}</p>
          <audio src={localUrl} autoPlay={localItem.autoplay ?? true}
            loop={localItem.loop ?? false} controls className="output-audio"
            ref={el => { if (el) el.playbackRate = localItem.playbackRate ?? 1.0; }} />
        </div>
      );
    }
    if (localItem.fileType === 'image') {
      return (
        <img src={localUrl} alt={localItem.fileName}
          className="output-video output-image media-layer" draggable={false} />
      );
    }
    return (
      <video src={localUrl} className="output-video media-layer"
        autoPlay={localItem.autoplay ?? true} playsInline controls={false}
        loop={localItem.loop ?? false}
        ref={el => { if (el) el.playbackRate = localItem.playbackRate ?? 1.0; }} />
    );
  }

  return (
    <video ref={videoRef} className="output-video media-layer"
      autoPlay muted playsInline />
  );
}
