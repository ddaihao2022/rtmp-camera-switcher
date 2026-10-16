/**
 * 全局音频管理器（主窗口）
 * 每路流对应一个 AudioChannel，包含 GainNode + AnalyserNode
 * 音频实际输出在这里，音频窗口只发控制指令，不自己拉流。
 */

let ctx = null;

function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Map<streamKey, { source, gain, analyser, mediaEl, _muted, _savedGain }>
const channels = new Map();

// VU 订阅回调列表（供 IPC bridge 使用）
const vuListeners = new Set();
let vuTimer = null;

function startVuBroadcast() {
  if (vuTimer) return;
  vuTimer = setInterval(() => {
    if (vuListeners.size === 0) return;
    const data = {};
    for (const [key] of channels) {
      data[key] = { rms: getRms(key), bars: Array.from(getFreqBars(key, 32)) };
    }
    for (const fn of vuListeners) fn(data);
  }, 50); // ~20fps
}

export function onVuData(fn) {
  vuListeners.add(fn);
  startVuBroadcast();
  return () => vuListeners.delete(fn);
}

export function connectStream(streamKey, videoEl) {
  if (channels.has(streamKey)) return;
  const audioCtx = getCtx();
  let source;
  try {
    source = audioCtx.createMediaElementSource(videoEl);
  } catch {
    return;
  }
  const gain = audioCtx.createGain();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(gain);
  gain.connect(analyser);
  analyser.connect(audioCtx.destination);
  channels.set(streamKey, { source, gain, analyser, mediaEl: videoEl, _muted: false, _savedGain: 1 });
}

export function disconnectStream(streamKey) {
  const ch = channels.get(streamKey);
  if (!ch) return;
  try { ch.gain.disconnect(); ch.analyser.disconnect(); ch.source.disconnect(); } catch {}
  channels.delete(streamKey);
}

export function setVolume(streamKey, value) {
  const ch = channels.get(streamKey);
  if (!ch) return;
  if (!ch._muted) ch._savedGain = value;
  ch.gain.gain.setTargetAtTime(ch._muted ? 0 : value, getCtx().currentTime, 0.01);
}

export function getVolume(streamKey) {
  const ch = channels.get(streamKey);
  return ch ? ch.gain.gain.value : 1;
}

export function setMute(streamKey, muted) {
  const ch = channels.get(streamKey);
  if (!ch) return;
  const target = muted ? 0 : (ch._savedGain ?? 1);
  if (!muted) ch._savedGain = ch.gain.gain.value || 1;
  ch.gain.gain.setTargetAtTime(target, getCtx().currentTime, 0.01);
  ch._muted = muted;
}

export function isMuted(streamKey) {
  const ch = channels.get(streamKey);
  return ch ? !!ch._muted : false;
}

export function getRms(streamKey) {
  const ch = channels.get(streamKey);
  if (!ch) return 0;
  const buf = new Uint8Array(ch.analyser.frequencyBinCount);
  ch.analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

export function getFreqBars(streamKey, bins = 32) {
  const ch = channels.get(streamKey);
  if (!ch) return new Uint8Array(bins);
  const buf = new Uint8Array(ch.analyser.frequencyBinCount);
  ch.analyser.getByteFrequencyData(buf);
  const step = Math.floor(buf.length / bins);
  const out = new Uint8Array(bins);
  for (let i = 0; i < bins; i++) out[i] = buf[i * step];
  return out;
}

export function getChannelKeys() {
  return Array.from(channels.keys());
}

/**
 * 为录制导出一路音频轨。
 *
 * 不从媒体元素取声（HTMLMediaElement.captureStream 在本运行时靠不住：
 * 图片素材的 <img> 没有这个方法，flv.js 直播的 MSE <video> 录出来是 0 字节空片）。
 * 改从既有 Web Audio 图里取：在 MediaElementSource → gain 链路后挂一个
 * MediaStreamAudioDestinationNode，录到的音量自然跟随音频面板的推子 / 静音。
 * 每次调用新建独立 destination，好让「无成绩条 / 有成绩条」两份成片各拿一条轨道。
 *
 * 返回 { track, stop }；stop() 断开该 destination，录制结束后必须调用。
 */
export function createRecordAudio(streamKey) {
  const ch = channels.get(streamKey);
  if (!ch) return null;
  let dest;
  try {
    dest = getCtx().createMediaStreamDestination();
    ch.gain.connect(dest);
  } catch {
    return null;
  }
  return {
    track: dest.stream.getAudioTracks()[0] || null,
    stop() { try { ch.gain.disconnect(dest); } catch {} },
  };
}

/** 返回所有频道当前增益状态，供音频窗口初始化用 */
export function getAllState() {
  const result = {};
  for (const [key, ch] of channels) {
    result[key] = { volume: ch._muted ? 0 : (ch._savedGain ?? ch.gain.gain.value), muted: ch._muted };
  }
  return result;
}
