/**
 * 单路媒体层：RTMP/FLV 或本地音视频/图片
 * 供 OutputView 转场双层叠加使用
 */
import { useEffect, useRef } from 'react';
import flvjs from 'flv.js';
import { buildFlvUrl, canPlayWithTranscode, getUnsupportedCodecMessage } from '../utils/stream';
import { FLV_PROGRAM_OPTIONS, startCatchUp, tryPlay } from '../utils/lowLatency';
import { buildFilter } from '../utils/color';

const API = 'http://localhost:3001';
// 输出/HDMI 窗口与主窗口的机位墙分开走 127.0.0.1，避免撞上 6 连接的并发上限
const FLV_HOST = 'http://127.0.0.1:8000';

/** 调色 → 内联 filter（叠加层由外层 GradeVeil 负责） */
function gradeStyle(grade) {
  const f = buildFilter(grade);
  return f ? { filter: f } : undefined;
}

export default function MediaLayer({ streamKey, streams = [], grade = null, onError }) {
  const videoRef = useRef(null);
  const playerRef = useRef(null);

  const localItem = streams.find(s => s.streamKey === streamKey && s.type === 'local');
  const liveItem = streams.find(s => s.streamKey === streamKey);

  const localUrl = localItem
    ? (localItem.filePath?.startsWith('blob:')
        ? localItem.filePath
        : `${API}/api/local/stream/${encodeURIComponent(String(localItem.streamKey).replace(/^local\//, ''))}`)
    : null;

  // streams 每次 streamUpdate 都是新数组/新对象（服务端每秒都可能推一次），
  // 不能直接进 effect 依赖，否则 HDMI 输出画面每秒被销毁重建一次
  const isLocal = Boolean(localItem);
  // 流还没进列表（刚切过去/刚上线）也照常拼地址，交给 flv.js 去连，
  // 别因为暂时查不到诊断信息就不播
  const flvUrl = (!isLocal && streamKey) ? buildFlvUrl(liveItem || { streamKey }, FLV_HOST) : '';
  const unsupportedMessage = (!isLocal && liveItem && !canPlayWithTranscode(liveItem))
    ? getUnsupportedCodecMessage(liveItem)
    : '';

  // 回调放 ref：OutputView 里 onError 有内联箭头函数，进依赖会让 effect 无谓重跑
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; });

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
    onErrorRef.current?.(null);

    // 本地素材走原生标签
    if (isLocal || !streamKey) return () => {};

    if (!videoRef.current || !flvjs.isSupported()) {
      if (!flvjs.isSupported()) onErrorRef.current?.('浏览器不支持FLV播放');
      return () => {};
    }
    // 原流编码浏览器放不了，但服务端已实时转码出 H.264 版本且就绪 → 改用转码流播放
    if (unsupportedMessage) {
      onErrorRef.current?.(unsupportedMessage);
      return () => {};
    }

    const player = flvjs.createPlayer(
      { type: 'flv', url: flvUrl, isLive: true, hasAudio: false, hasVideo: true },
      FLV_PROGRAM_OPTIONS
    );
    const onErr = (t, d) => onErrorRef.current?.(`${t}: ${d}`);
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
  }, [streamKey, isLocal, flvUrl, unsupportedMessage]);

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
        style={gradeStyle(grade)}
        ref={el => { if (el) el.playbackRate = localItem.playbackRate ?? 1.0; }} />
    );
  }

  return (
    <video ref={videoRef} className="output-video media-layer"
      autoPlay muted playsInline style={gradeStyle(grade)} />
  );
}
