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
  const path = normalizeFlvPath(stream?.flvPath, streamKey);
  return path ? `${host}${path}` : '';
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
  // 只按"能确认的编码"来拦：编码未知时放行，让 flv.js 自己试（试不了它会抛真实错误），
  // 不能因为推流端没上报 metadata 就判定不能播
  const codec = getVideoCodecLabel(stream);
  return codec === 'unknown' || codec === 'H.264';
}

export function getUnsupportedCodecMessage(stream) {
  const codec = getVideoCodecLabel(stream);
  if (codec === 'unknown' || codec === 'H.264') return '';
  return `当前流编码为 ${codec}，内置 FLV 播放器仅稳定支持 H.264，建议把推流编码改为 H.264。`;
}
