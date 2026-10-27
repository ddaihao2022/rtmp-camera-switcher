import { useEffect, useRef } from 'react';
import flvjs from 'flv.js';
import { buildFlvUrl, canPlayWithTranscode, getUnsupportedCodecMessage } from '../utils/stream';
import { FLV_PROGRAM_OPTIONS, startCatchUp, tryPlay } from '../utils/lowLatency';

const API = 'http://localhost:3001';
const FLV_HOST = 'http://127.0.0.1:8000';

/**
 * 录制专用隐藏源
 *
 * 单屏视图只挂载「预览」那一路，输出是另一路时录制面板拿不到 <video>。
 * 这里始终为输出流挂一个 1×1 的隐藏源（直播走 flv.js，本地素材走原生标签），
 * 录制时直接从这里取画面，不用把导播的预览切走。
 */
export default function RecordSource({ streamKey, stream, onReady, onUnmount }) {
  const mediaRef = useRef(null);
  const playerRef = useRef(null);

  const isLocal = stream?.type === 'local';
  const fileType = stream?.fileType || 'video';
  const keyPart = String(streamKey || '').replace(/^local\//, '');
  const localUrl = isLocal
    ? (String(stream?.filePath || '').startsWith('blob:')
        ? stream.filePath
        : `${API}/api/local/stream/${encodeURIComponent(keyPart)}`)
    : '';
  const flvUrl = (!isLocal && streamKey) ? buildFlvUrl(stream || { streamKey }, FLV_HOST) : '';
  const unsupportedMessage = (!isLocal && stream && !canPlayWithTranscode(stream))
    ? getUnsupportedCodecMessage(stream)
    : '';

  useEffect(() => {
    if (!streamKey || !mediaRef.current) return undefined;
    const el = mediaRef.current;
    onReady?.(streamKey, el);

    if (isLocal) {
      tryPlay(el);
      return () => onUnmount?.(streamKey);
    }

    if (!flvjs.isSupported() || unsupportedMessage) {
      return () => onUnmount?.(streamKey);
    }

    const player = flvjs.createPlayer(
      { type: 'flv', url: flvUrl, isLive: true, hasAudio: false, hasVideo: true },
      FLV_PROGRAM_OPTIONS
    );
    player.attachMediaElement(el);
    player.load();
    playerRef.current = player;

    const onLoaded = () => tryPlay(el);
    el.addEventListener('loadeddata', onLoaded, { once: true });
    const stopCatchUp = startCatchUp(el, {
      jumpLag: 0.4,
      softLag: 0.2,
      intervalMs: 300,
      softRate: 1.3,
    });

    return () => {
      stopCatchUp();
      el.removeEventListener('loadeddata', onLoaded);
      try {
        player.unload();
        player.detachMediaElement();
        player.destroy();
      } catch {}
      playerRef.current = null;
      onUnmount?.(streamKey);
    };
  }, [streamKey, isLocal, fileType, localUrl, flvUrl, unsupportedMessage, onReady, onUnmount]);

  if (!streamKey) return null;

  // 不用 display:none：部分浏览器会停止解码，drawImage 就取不到帧。
  // 放到屏幕外并压到 1×1，既不影响布局也能持续出帧。
  const style = {
    position: 'fixed',
    left: '-4px',
    bottom: '-4px',
    width: 1,
    height: 1,
    opacity: 0,
    pointerEvents: 'none',
    zIndex: -1,
  };

  if (isLocal && fileType === 'image') {
    return <img ref={mediaRef} src={localUrl} alt="" crossOrigin="anonymous" style={style} />;
  }
  if (isLocal && fileType === 'audio') {
    return <audio ref={mediaRef} src={localUrl} autoPlay loop={stream?.loop ?? false} muted style={style} />;
  }
  return (
    <video
      ref={mediaRef}
      src={isLocal ? localUrl : undefined}
      crossOrigin={isLocal ? 'anonymous' : undefined}
      autoPlay={isLocal ? (stream?.autoplay ?? true) : true}
      loop={isLocal ? (stream?.loop ?? false) : false}
      muted
      playsInline
      style={style}
    />
  );
}
