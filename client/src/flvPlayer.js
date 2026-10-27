import flvjs from 'flv.js';

/**
 * 低延迟直播播放参数集中管理。
 *
 * 之前 VideoPlayer / OutputView / OutputMonitor 各写一份 createPlayer 配置，
 * 参数还互不一致（stashInitialSize 32 vs 128、maxLatency 0.5 vs 1.0 …），
 * 想调整追播策略要同步改三处，很容易漏。现在只有这一份。
 */
export const LIVE_PLAYER_CONFIG = {
  // 解封装是否放进 Web Worker。
  // ⚠️ 已实测：flv.js 1.6.2 的 dist 用 webworkify-webpack 起 worker，依赖 webpack 运行时。
  // 在 Vite 下开 true 会抛 `TypeError: Cannot read properties of undefined (reading 'call')`，
  // transmuxer 永远拿不到数据（画面黑、readyState 一直 0）。所以这里保持 false。
  // 想真正用上 worker，需要换成 mpegts.js（flv.js 的活跃分支，原生支持 Worker/ESM），
  // 那是一次播放库替换，必须重测追播与重连行为。
  enableWorker: false,
  enableStashBuffer: false,
  // 初始缓冲别太小：32 在抖动的局域网里容易反复起播
  stashInitialSize: 128,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 2,
  autoCleanupMinBackwardDuration: 1,
  // flv.js 内置追播：超过 maxLatency 就加速播到只剩 minRemain
  liveBufferLatencyChasing: true,
  liveBufferLatencyMaxLatency: 0.5,
  liveBufferLatencyMinRemain: 0.1,
  lazyLoad: false,
  seekType: 'range',
};

export function isLivePlaybackSupported() {
  try {
    return flvjs.isSupported();
  } catch {
    return false;
  }
}

/**
 * 建一个低延迟直播播放器。
 * 返回的 destroy() 会把事件、媒体元素、transmuxer 一次性拆干净，
 * 避免切换输出时留下野播放器继续拉流。
 */
export function buildLivePlayer(url, videoEl, { hasAudio = false, onError } = {}) {
  const player = flvjs.createPlayer(
    { type: 'flv', url, isLive: true, hasAudio, hasVideo: true },
    { ...LIVE_PLAYER_CONFIG }
  );

  const handleError = (type, detail) => {
    if (onError) onError(type, detail);
  };
  player.on(flvjs.Events.ERROR, handleError);
  player.attachMediaElement(videoEl);
  player.load();

  return {
    player,
    /** 尝试启播。Electron 默认允许无手势自动播放，浏览器里可能被拦，失败忽略即可 */
    play() {
      const attempt = videoEl.play?.();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    },
    destroy() {
      try {
        player.off(flvjs.Events.ERROR, handleError);
        player.unload();
        player.detachMediaElement();
        player.destroy();
      } catch {
        // 已经卸载/销毁过就忽略
      }
    },
  };
}

/**
 * 兜底追播。
 * flv.js 自带的追播只处理「缓冲超过 maxLatency」的情况，网络抖动后仍可能越积越多，
 * 这里按 lag 手动跳帧或轻微加速，和库内策略形成双保险。
 * 返回停止函数。
 */
export function attachLatencyCatchUp(videoEl, {
  jumpThreshold = 0.8,
  rateThreshold = 0.5,
  targetRemain = 0.1,
  boostRate = 1.2,
  intervalMs = 500,
} = {}) {
  const timer = setInterval(() => {
    const v = videoEl;
    if (!v || v.paused) return;
    if (!v.buffered || !v.buffered.length) return;

    const edge = v.buffered.end(v.buffered.length - 1);
    const lag = edge - v.currentTime;

    if (lag > jumpThreshold) {
      // 落后太多，直接跳到接近实时位置
      v.currentTime = Math.max(0, edge - targetRemain);
      v.playbackRate = 1;
    } else if (lag > rateThreshold) {
      v.playbackRate = boostRate;
    } else if (v.playbackRate !== 1) {
      v.playbackRate = 1;
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
