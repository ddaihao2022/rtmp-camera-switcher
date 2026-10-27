import { useCallback, useEffect, useRef, useState } from 'react';
import { buildLivePlayer, attachLatencyCatchUp, isLivePlaybackSupported } from './flvPlayer.js';

/**
 * 直播播放器 hook：建流 + 追播 + 自动重连。
 *
 * 为什么需要自动重连：摄像机重启、交换机抖动、OBS 换场景都会让 HTTP-FLV 连接断掉。
 * 旧实现只会弹一个「↻ 重连」按钮，现场得有人盯着点。这里改成指数退避自动重试，
 * 连续失败到一定次数才转交人工。
 *
 * state.phase:
 *   idle      没开始（未选流 / 未启用）
 *   connecting 首次建流
 *   playing   正常播放
 *   retrying  等下一次重连（带 attempt / delay）
 *   failed    自动重连已放弃，需手动重试（或环境不支持）
 */

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 15000;
// 2+4+8+15+15+15+15+15 ≈ 90 秒后转人工
const RETRY_MAX_ATTEMPTS = 8;
// 画面连续多久完全不推进就判定为静默断流
const STALL_TIMEOUT_MS = 12000;

export function useLivePlayer({ videoRef, url, hasAudio = false, enabled = true, stallTimeoutMs = STALL_TIMEOUT_MS }) {
  const [state, setState] = useState({ phase: 'idle', attempt: 0, delay: 0, message: null });
  const [reloadKey, setReloadKey] = useState(0);
  const playerRef = useRef(null);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef(null);

  /** 手动重连：清零退避重来 */
  const retryNow = useCallback(() => {
    clearTimeout(retryTimerRef.current);
    attemptRef.current = 0;
    setState({ phase: 'connecting', attempt: 0, delay: 0, message: null });
    setReloadKey(k => k + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ phase: 'idle', attempt: 0, delay: 0, message: null });
      return;
    }
    if (!url) {
      setState({ phase: 'idle', attempt: 0, delay: 0, message: null });
      return;
    }

    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (!isLivePlaybackSupported()) {
      setState({ phase: 'failed', attempt: 0, delay: 0, message: '当前环境不支持 FLV 播放' });
      return;
    }

    let disposed = false;
    let lastProgressAt = Date.now();
    let lastCurrentTime = videoEl.currentTime;

    setState(prev => (prev.phase === 'retrying' ? prev : { phase: 'connecting', attempt: 0, delay: 0, message: null }));

    const scheduleRetry = (message) => {
      if (disposed) return;
      attemptRef.current += 1;
      const attempt = attemptRef.current;
      if (attempt > RETRY_MAX_ATTEMPTS) {
        setState({ phase: 'failed', attempt, delay: 0, message: message || '重连失败' });
        return;
      }
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      setState({ phase: 'retrying', attempt, delay, message });
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        if (!disposed) setReloadKey(k => k + 1);
      }, delay);
    };

    const handle = buildLivePlayer(url, videoEl, {
      hasAudio,
      onError: (type, detail) => {
        // 断流时 flv.js 会抛 error，直接进重连流程
        console.warn('[flv] 播放错误:', type, detail);
        scheduleRetry(`${type}${detail ? ': ' + detail : ''}`);
      },
    });
    playerRef.current = handle.player;
    handle.play();

    const markPlaying = () => {
      if (disposed) return;
      lastProgressAt = Date.now();
      attemptRef.current = 0; // 播起来就重置退避
      setState(prev => (prev.phase === 'playing' ? prev : { phase: 'playing', attempt: 0, delay: 0, message: null }));
      handle.play();
    };
    videoEl.addEventListener('playing', markPlaying);
    videoEl.addEventListener('loadeddata', markPlaying);

    const stopCatchUp = attachLatencyCatchUp(videoEl);

    // 静默断流看门狗：连接不断但画面不再推进时，flv.js 不一定报错
    const watchdog = setInterval(() => {
      if (disposed) return;
      const now = Date.now();
      if (videoEl.currentTime !== lastCurrentTime) {
        lastCurrentTime = videoEl.currentTime;
        lastProgressAt = now;
        return;
      }
      if (videoEl.paused) {
        lastProgressAt = now;
        return;
      }
      if (now - lastProgressAt > stallTimeoutMs) {
        lastProgressAt = now;
        console.warn('[flv] 画面长时间未推进，主动重连');
        scheduleRetry('画面卡住，正在重连');
      }
    }, 2000);

    return () => {
      disposed = true;
      clearInterval(watchdog);
      clearTimeout(retryTimerRef.current);
      stopCatchUp();
      videoEl.removeEventListener('playing', markPlaying);
      videoEl.removeEventListener('loadeddata', markPlaying);
      playerRef.current = null;
      handle.destroy();
    };
  }, [url, hasAudio, enabled, reloadKey, videoRef, stallTimeoutMs]);

  return { state, playerRef, retryNow };
}
