export function normalizeFlvPath(flvPath = '', streamKey = '') {
  const fallbackPath = flvPath || (streamKey ? `/${streamKey}.flv` : '');
  const normalized = String(fallbackPath)
    .replace(/\\/g, '/')
    .replace(/\/+\.flv$/i, '.flv')
    .split('/')
    .filter(Boolean)
    .join('/');

  if (!normalized) return '';
  return normalized.toLowerCase().endsWith('.flv') ? `/${normalized}` : `/${normalized}.flv`;
}

export function buildFlvUrl(stream, host = 'http://localhost:8000') {
  const streamKey = String(stream?.streamKey || '').replace(/^\/+|\/+$/g, '');
  // 服务端已为该流实时转码出 H.264 版本且就绪 → 优先播转码流（兼容 HEVC/VP9/AV1）
  const path = (stream?.transcodeStatus === 'ready' && stream?.transcodedFlvPath)
    ? stream.transcodedFlvPath
    : stream?.flvPath;
  const normalized = normalizeFlvPath(path, streamKey);
  return normalized ? `${host}${normalized}` : '';
}

export function getVideoCodecLabel(stream) {
  const rawCodec = stream?.videoCodecLabel || stream?.videoCodec;
  // 0 / '0' 是 node-media-server 的"未上报"初值（推流端没发 metadata 时就是它），
  // 不等于编码不支持，当作 unknown 处理，交给播放器自己试
  if (rawCodec == null || rawCodec === '' || rawCodec === 0 || rawCodec === '0') return 'unknown';

  const value = String(rawCodec).toLowerCase();
  if (value === '7' || value.includes('h264') || value.includes('avc')) return 'H.264';
  if (value === '12') return 'H.265/HEVC'; // FLV 传统 HEVC codec id
  if (value.includes('h265') || value.includes('hevc') || value.includes('hvc1')) return 'H.265/HEVC';
  if (value.includes('vp9') || value.includes('vp09')) return 'VP9';
  if (value.includes('av1') || value.includes('av01')) return 'AV1';
  return String(rawCodec);
}

export function isBrowserPlayableStream(stream) {
  // 服务端已经按 SPS 判断过 8-bit / 4:2:0（H.264 High10、4:2:2 也必须转码）
  if (stream?.browserPlayable === false) return false;
  // 视频是 H.264，但音频是 Opus/FLAC 等 enhanced 格式 → flv.js 也放不了
  if (stream?.audioPlayable === false) return false;
  if (stream?.browserPlayable === true) return true;
  // 只按"能确认的编码"来拦：编码未知时放行，让 flv.js 自己试（试不了它会抛真实错误），
  // 不能因为推流端没上报 metadata 就判定不能播
  const codec = getVideoCodecLabel(stream);
  return codec === 'unknown' || codec === 'H.264';
}

/**
 * 能不能播这条流（含转码兜底）：
 * 原流编码浏览器放不了，但服务端已实时转码出 H.264 版本且就绪 → 改播转码流，不该拦
 */
export function canPlayWithTranscode(stream) {
  if (isBrowserPlayableStream(stream)) return true;
  return stream?.transcodeStatus === 'ready' && Boolean(stream?.transcodedFlvPath);
}

export function getUnsupportedCodecMessage(stream) {
  const codec = getVideoCodecLabel(stream);
  const label = stream?.videoCodecLabel || codec;
  // 推流端会话还在、但已经很久没有媒体包（或转码因此被收摊）：
  // 先说明“没有画面”，别甩锅给转码器 —— 现场看到“转码失败”会去折腾编码设置。
  if (stream?.status === 'stalled' || stream?.transcodeStatus === 'stopped') {
    return '推流端没有画面数据：摄像头可能切到后台/锁屏，或编码器已停止；重新推流即可。';
  }
  if (stream?.audioPlayable === false && stream?.browserPlayable !== false) {
    return `当前流音频为 ${stream?.audioCodecLabel || '不兼容格式'}，内置播放器仅稳定支持 AAC / MP3；服务端可转 AAC，失败时请把音频编码改为 AAC。`;
  }
  if (stream?.browserPlayable !== false && (codec === 'unknown' || codec === 'H.264')) return '';
  if (stream?.transcodeStatus === 'error') {
    const detail = String(stream?.transcodeError || '').trim();
    return detail
      ? `当前流编码为 ${label}，服务端转码失败：${detail}`
      : `当前流编码为 ${label}，服务端转码 H.264 失败，建议把推流编码改为 H.264。`;
  }
  return `当前流编码为 ${label}，内置 FLV 播放器仅稳定支持 8-bit H.264，建议把推流编码改为 H.264。`;
}
