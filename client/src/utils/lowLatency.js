/**
 * 共享低延迟播放配置（体育赛事转播）
 * 所有 flv.js 播放器统一走这里，避免各处参数漂移。
 */

/** 主控预览 / 多画面：略宽松，减少多路同时解码时的卡顿 */
export const FLV_PREVIEW_OPTIONS = {
  enableWorker: false,
  enableStashBuffer: false,
  stashInitialSize: 64,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 3,
  autoCleanupMinBackwardDuration: 1.5,
  liveBufferLatencyChasing: true,
  liveBufferLatencyMaxLatency: 0.6,
  liveBufferLatencyMinRemain: 0.2,
  lazyLoad: false,
  seekType: 'range',
};

/** PROGRAM 输出 / 主监看：最激进追播 */
export const FLV_PROGRAM_OPTIONS = {
  enableWorker: false,
  enableStashBuffer: false,
  stashInitialSize: 32,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 2,
  autoCleanupMinBackwardDuration: 1,
  liveBufferLatencyChasing: true,
  liveBufferLatencyMaxLatency: 0.35,
  liveBufferLatencyMinRemain: 0.1,
  lazyLoad: false,
  seekType: 'range',
};

/**
 * 启动兜底追播定时器。
 * @param {HTMLVideoElement|null} video
 * @param {{ jumpLag?: number, softLag?: number, intervalMs?: number, softRate?: number }} [cfg]
 * @returns {() => void} stop
 */
export function startCatchUp(video, cfg = {}) {
  const {
    jumpLag = 0.7,
    softLag = 0.4,
    intervalMs = 400,
    softRate = 1.25,
  } = cfg;

  const timer = setInterval(() => {
    const v = video;
    if (!v || v.paused || !v.buffered.length) return;
    const edge = v.buffered.end(v.buffered.length - 1);
    const lag = edge - v.currentTime;
    if (lag > jumpLag) {
      v.currentTime = Math.max(0, edge - 0.05);
      v.playbackRate = 1;
    } else if (lag > softLag) {
      v.playbackRate = softRate;
    } else if (v.playbackRate !== 1) {
      v.playbackRate = 1;
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

/** 尝试自动播放（忽略自动播放策略拒绝） */
export function tryPlay(video) {
  const p = video?.play?.();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}
