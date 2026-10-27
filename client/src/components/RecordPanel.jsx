import { useEffect, useRef, useState } from 'react';
import { buildFilter, buildOverlays, hexToRgba } from '../utils/color';
import { drawScoreboard } from '../utils/scoreboardCanvas';
import { createRecordAudio } from '../audio';
// 显式引入：模块加载时会把默认队徽注册给 canvasKit，
// 保证「带成绩条」这份成片里没上传照片的选手也画得出队徽
import '../utils/athleteDefault';

/**
 * 录制面板 · 双版本导出
 *
 * 一次录制输出两份成片：
 *   · 无成绩条 —— 原片（若开了调色则与监看一致的调色成片）
 *   · 有成绩条 —— 叠加层烧进画面（田径信息条 / 比分条 / 选手介绍），与 PGM 监看逐帧同源
 *
 * 两条成片都走 canvas 合成管线，原因有两个：
 *   ① 叠加层是 DOM（ScoreboardOverlay / AthleteIntro），MediaRecorder 抓不到 DOM；
 *   ② HTMLMediaElement.captureStream 在本运行时靠不住 —— 实测（Electron 31 / Chromium 126）：
 *      · 图片素材的 <img> 根本没有 captureStream（调用即 undefined）；
 *      · flv.js 直播的 MSE <video> 虽然返回轨道，录出来却是 0 字节空片。
 * 所以每帧把画面画进 canvas → 叠加调色 → 用 scoreboardCanvas 画叠加层 → canvas.captureStream 录制；
 * 音频不从元素取，而是从 audio.js 的 Web Audio 图（gain → MediaStreamDestination）分出一路。
 * 两条管线并行录制，成片时间轴一致。
 *
 * Electron 下走「边录边写 + 分段」：
 *   MediaRecorder 每 1 秒吐一个分片，主进程用文件流直接 append 到移动磁盘；
 *   到分段时长就停掉当前 MediaRecorder、收尾当前文件，再用同一条画布流开下一段。
 *   这样长时录制不再把整段成片堆在内存里，异常退出最多丢当前段最后一秒左右。
 *
 * Props:
 *   outputStream  - 当前选为输出的 streamKey
 *   videoRefsMap  - Map<streamKey, HTMLVideoElement>，由 App 层维护
 *   grade         - 该路生效的调色参数；有调色时走 canvas 录制，保证成片与监看一致
 *   scoreboard    - /api/scoreboard 配置（App 经 socket 同步），供叠加层烧录
 */

const VARIANT_CLEAN = '无成绩条';
const VARIANT_SCORE = '有成绩条';
const SEGMENT_OPTIONS = [5, 10, 15, 20, 30, 60];
const MIN_FREE_BYTES = 300 * 1024 * 1024; // 低于 300 MB 不允许开始，避免录到一半写满
const WARN_FREE_BYTES = 1024 * 1024 * 1024; // 录制中低于 1 GB 提醒换盘
const STOP_FREE_BYTES = 200 * 1024 * 1024; // 录制中低于 200 MB 自动收尾，保住已录内容
const SLOW_QUEUE_BYTES = 32 * 1024 * 1024; // 磁盘写入排队超过这个量就提醒
const MAX_QUEUE_BYTES = 128 * 1024 * 1024; // 排队再涨就停止，避免把内存吃光

/** recording-20261014-203000 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(0, Math.round(n / (1024 ** 2)))} MB`;
}

export default function RecordPanel({
  outputStream,
  videoRefsMap,
  recordVideoRefsMap = null,
  grade = null,
  scoreboard = null,
  onRequestProgram = null,
}) {
  const [status, setStatus] = useState('idle'); // idle | starting | recording | saving
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [lastFiles, setLastFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dir, setDir] = useState('');
  const [segmentMinutes, setSegmentMinutes] = useState(10);
  const [diskFree, setDiskFree] = useState(null);
  const [segments, setSegments] = useState(0);

  const jobsRef = useRef([]); // 旧路径（浏览器）：[{ suffix, recorder, chunks }]
  const timerRef = useRef(null);
  const segmentTimerRef = useRef(null);
  const diskTimerRef = useRef(null);
  const diskFailRef = useRef(0);
  const startTimeRef = useRef(0);
  const pipesRef = useRef([]); // 画布管线句柄 [{ raf, canvas, stream }]
  const audioRef = useRef([]); // 从 Web Audio 图分出的录制音频句柄 [{ stop }]
  const scoreRef = useRef(scoreboard);
  const taintedRef = useRef(false); // 录制期间画布是否被跨域素材污染
  const streamSessionRef = useRef(null); // 边录边写会话 { base, dir, lanes, paths, segment, mime, ext }
  const modeRef = useRef('memory'); // 'stream' | 'memory'
  const rotatingRef = useRef(false);
  const finishingRef = useRef(false);
  const busyRef = useRef(false);
  const dirRef = useRef('');
  const failRef = useRef(null);

  // 录制中叠加层会实时变（改分 / 跑表 / 换项目），用 ref 让绘制循环读到最新配置
  useEffect(() => { scoreRef.current = scoreboard; }, [scoreboard]);

  // 读取上次选择的保存目录 / 分段时长
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getRecordingSettings) return;
    api.getRecordingSettings().then((s) => {
      if (!s) return;
      const d = s.dir || '';
      setDir(d);
      dirRef.current = d;
      const m = Number(s.segmentMinutes);
      setSegmentMinutes(Number.isFinite(m) ? m : 10);
    }).catch(() => {});
  }, []);

  useEffect(() => { failRef.current = failStreaming; });

  // 主进程写入磁盘出错（最常见：移动磁盘被拔出 / 写满）
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onRecordingError) return undefined;
    return api.onRecordingError((data) => {
      failRef.current?.('写入磁盘失败：' + (data?.message || '磁盘可能已拔出或已写满'));
    });
  }, []);

  const stopPipelines = () => {
    for (const p of pipesRef.current) {
      if (p.raf) cancelAnimationFrame(p.raf);
      try { p.stream?.getVideoTracks().forEach(t => t.stop()); } catch {}
    }
    pipesRef.current = [];
    for (const a of audioRef.current) {
      try { a.stop(); } catch {}
    }
    audioRef.current = [];
  };

  // 清理
  useEffect(() => () => {
    clearInterval(timerRef.current);
    clearInterval(segmentTimerRef.current);
    clearInterval(diskTimerRef.current);
    for (const j of jobsRef.current) {
      try { if (j.recorder.state === 'recording') j.recorder.stop(); } catch {}
    }
    for (const lane of streamSessionRef.current?.lanes || []) {
      try { if (lane.recorder?.state === 'recording') lane.recorder.stop(); } catch {}
    }
    stopPipelines();
  }, []);

  const getSupportedMime = () => {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    return candidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
  };

  /**
   * 画布合成管线：把画面（`<video>` / `<img>`，纯音频素材铺黑底）逐帧画进 canvas，
   * ctx.filter 处理亮度/对比度/饱和度/色相，soft-light 罩层处理色温/色调，径向渐变处理暗角，
   * withScoreboard 为真时再把成绩条画上去。音频另从 audio.js 的 Web Audio 图分一路并入。
   * 素材若为跨域加载（画布被污染）无法合成，返回 null。
   */
  const createCanvasStream = (videoEl, { withScoreboard }) => {
    const w = videoEl.videoWidth || videoEl.naturalWidth || 1280;
    const h = videoEl.videoHeight || videoEl.naturalHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') return null;

    const filter = buildFilter(grade);
    const overlays = buildOverlays(grade);
    const tints = overlays.filter(o => o.kind === 'tint');
    const vig = overlays.find(o => o.kind === 'vignette');
    let vigGradient = null;
    if (vig) {
      vigGradient = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.62);
      vigGradient.addColorStop(0, 'rgba(0,0,0,0)');
      vigGradient.addColorStop(1, `rgba(0,0,0,${(vig.strength * 0.85).toFixed(3)})`);
    }

    const pipe = { raf: null, canvas, stream: null, probed: false, tainted: false };
    // 图片素材是静态 <img>，没有 readyState；视频要等起到帧才好画
    const isImage = videoEl.tagName === 'IMG';
    const hasFrame = () => isImage ? (videoEl.naturalWidth > 0) : (videoEl.readyState >= 2);

    // 一帧：画面 → 调色 → 成绩条。绘制单独 try，跨域被拒时不影响后面的探测与叠加层
    const paintFrame = () => {
      try {
        ctx.globalCompositeOperation = 'source-over';
        ctx.filter = filter || 'none';
        if (videoEl.tagName === 'AUDIO') {
          // 纯音频素材没有画面，铺黑底保证视频轨有效（部分播放器不接受纯音频 webm 成片）
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, h);
        } else {
          ctx.drawImage(videoEl, 0, 0, w, h);
        }
        ctx.filter = 'none';
        for (const t of tints) {
          ctx.globalCompositeOperation = 'soft-light';
          ctx.fillStyle = hexToRgba(t.color, t.opacity);
          ctx.fillRect(0, 0, w, h);
        }
        ctx.globalCompositeOperation = 'source-over';
        if (vigGradient) {
          ctx.fillStyle = vigGradient;
          ctx.fillRect(0, 0, w, h);
        }
      } catch {
        pipe.drawFailed = true; // 跨域素材：画布只会有叠加层/纯色
      }
      if (!pipe.probed) {
        pipe.probed = true;
        try {
          ctx.getImageData(0, 0, 1, 1); // 探画布是否被跨域素材污染
        } catch {
          pipe.tainted = true;
          taintedRef.current = true;
        }
      }
      if (withScoreboard) {
        try {
          drawScoreboard(ctx, scoreRef.current, w, h);
        } catch {
          // 叠加层绘制失败不应中断录像
        }
      }
    };

    const draw = () => {
      if (hasFrame()) paintFrame();
      pipe.raf = requestAnimationFrame(draw);
    };
    draw();

    // 首帧就判定污染时直接放弃这条管线，避免录出黑场
    if (pipe.tainted) {
      cancelAnimationFrame(pipe.raf);
      return null;
    }

    let stream;
    try {
      stream = canvas.captureStream(30);
    } catch {
      // Canvas is not origin-clean → 放弃画布管线
      cancelAnimationFrame(pipe.raf);
      return null;
    }

    // 音频：从 audio.js 的 Web Audio 图分一路（元素 captureStream 在本运行时不可靠）
    const recAudio = createRecordAudio(outputStream);
    if (recAudio?.track) {
      stream.addTrack(recAudio.track);
      audioRef.current.push(recAudio);
    }

    pipe.stream = stream;
    pipesRef.current.push(pipe);
    return stream;
  };

  const refreshDisk = async (target = dirRef.current) => {
    const api = window.electronAPI;
    if (!target || !api?.getRecordingDiskInfo) { setDiskFree(null); return null; }
    const info = await api.getRecordingDiskInfo(target).catch(() => null);
    setDiskFree(info?.success ? info.free : null);
    return info;
  };

  const chooseDir = async () => {
    const api = window.electronAPI;
    if (!api?.pickRecordingDir) return;
    const r = await api.pickRecordingDir();
    if (r?.success) {
      setDir(r.dir);
      dirRef.current = r.dir;
      setError(null);
      refreshDisk(r.dir);
    }
  };

  const changeSegment = (value) => {
    const n = Math.max(0, Number(value) || 0);
    setSegmentMinutes(n);
    window.electronAPI?.setRecordingSettings?.({ segmentMinutes: n });
  };

  // ─── 边录边写 ──────────────────────────────────────────────────────────────

  function stopLaneRecorder(lane) {
    return new Promise((resolve) => {
      const recorder = lane.recorder;
      lane.recorder = null;
      if (!recorder || recorder.state === 'inactive') return resolve();
      recorder.onstop = () => resolve();
      try { recorder.stop(); } catch { resolve(); }
    });
  }

  async function endLaneFiles(session) {
    await Promise.all(session.lanes.map(stopLaneRecorder));
    // 停止后不再接收迟到的分片，避免收尾结束后又 append 到已关闭的文件
    for (const lane of session.lanes) lane.closed = true;
    // 最后一两个分片可能还在 Blob → ArrayBuffer 的路上，先等它们写完
    await Promise.all(session.lanes.map(l => l.writeChain.catch(() => {})));
    return Promise.all(session.lanes.map(async (lane) => {
      const token = lane.token;
      lane.token = null; // 先摘掉 token，避免并发收尾把同一文件 end 两次
      if (!token) return null;
      try {
        return await window.electronAPI.endRecording(token);
      } catch (e) {
        return { success: false, filePath: lane.filePath, error: e.message };
      }
    }));
  }

  function collectPaths(session, results) {
    for (const r of results) {
      if (r?.filePath && !session.paths.includes(r.filePath)) session.paths.push(r.filePath);
    }
    setLastFiles([...session.paths]);
  }

  async function beginLanes(session, segment) {
    const api = window.electronAPI;
    const res = await api.beginRecording({
      dir: session.dir,
      base: session.base,
      files: session.lanes.map(l => ({ suffix: l.suffix, ext: session.ext, segment })),
    });
    if (!res?.success) {
      const err = new Error(res?.error || '无法创建录制文件');
      err.code = res?.code;
      throw err;
    }
    res.files.forEach((f, i) => {
      const lane = session.lanes[i];
      lane.token = f.token;
      lane.filePath = f.filePath;
      lane.closed = false;
      lane.pendingBytes = 0;
      lane.writeChain = Promise.resolve();
    });
    session.segment = segment;
  }

  function attachLaneRecorder(lane, mime) {
    const api = window.electronAPI;
    let recorder;
    try {
      recorder = new MediaRecorder(lane.stream, mime ? { mimeType: mime } : {});
    } catch (e) {
      throw new Error('无法创建录制器：' + e.message);
    }
    lane.recorder = recorder;

    recorder.ondataavailable = (e) => {
      if (!e.data?.size || lane.closed) return;
      const blob = e.data;
      lane.pendingBytes += blob.size;
      if (lane.pendingBytes > MAX_QUEUE_BYTES) {
        lane.pendingBytes -= blob.size;
        failRef.current?.('磁盘写入持续过慢，已停止录制以保护内存');
        return;
      }
      lane.writeChain = lane.writeChain.then(async () => {
        if (lane.closed || !lane.token) { lane.pendingBytes -= blob.size; return; }
        const buf = await blob.arrayBuffer();
        await api.appendRecording(lane.token, buf);
        lane.pendingBytes -= blob.size;
        if (lane.pendingBytes > SLOW_QUEUE_BYTES) {
          setNote(prev => prev || '磁盘写入较慢，录制数据正在排队；请检查移动磁盘速度');
        }
      }).catch((err) => {
        lane.pendingBytes = Math.max(0, lane.pendingBytes - blob.size);
        failRef.current?.('写入磁盘失败：' + (err?.message || err));
      });
    };
    recorder.onerror = (e) => {
      failRef.current?.('录制器出错：' + (e?.error?.message || e?.type || '未知错误'));
    };
    recorder.start(1000); // 每 1 秒一个分片，边录边写
  }

  async function finishStreaming() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    clearInterval(timerRef.current);
    clearInterval(segmentTimerRef.current);
    clearInterval(diskTimerRef.current);
    // 正在分段时先等它收尾，避免两个流程同时 stop/end 同一批文件
    for (let i = 0; i < 200 && rotatingRef.current; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const session = streamSessionRef.current;
    streamSessionRef.current = null;
    setStatus('saving');
    if (session) {
      try {
        const results = await endLaneFiles(session);
        collectPaths(session, results);
        const bad = results.find(r => r && !r.success);
        if (bad) setError(prev => prev || ('保存失败：' + (bad.error || '未知错误')));
        setSegments(session.segment + 1);
      } catch (e) {
        setError(prev => prev || ('保存失败：' + (e?.message || e)));
      }
    }
    stopPipelines();
    setStatus('idle');
    finishingRef.current = false;
  }

  function failStreaming(message) {
    if (finishingRef.current) return;
    setError(message);
    setNote(null);
    void finishStreaming();
  }

  async function rotateSegments() {
    const session = streamSessionRef.current;
    if (!session || rotatingRef.current || finishingRef.current) return;
    rotatingRef.current = true;
    setNote('正在分段…');
    try {
      const results = await endLaneFiles(session);
      collectPaths(session, results);
      const bad = results.find(r => r && !r.success);
      if (bad) throw new Error(bad.error || '上一段收尾失败');

      // 收尾过程中用户点了停止：不要再开新一段，直接让 finishStreaming 接走
      if (finishingRef.current || streamSessionRef.current !== session) return;

      await beginLanes(session, session.segment + 1);
      for (const lane of session.lanes) attachLaneRecorder(lane, session.mime);
      setSegments(session.segment + 1);
      setNote(null);
      // 分段耗时可能吃掉一部分间隔，重新起算下一段，保证每段时长稳定
      clearInterval(segmentTimerRef.current);
      if (segmentMinutes > 0) {
        segmentTimerRef.current = setInterval(() => { void rotateSegments(); }, segmentMinutes * 60_000);
      }
    } catch (e) {
      failStreaming('分段失败：' + (e?.message || e));
    } finally {
      rotatingRef.current = false;
    }
  }

  async function startStreaming(plan, mime, ext) {
    const api = window.electronAPI;
    let targetDir = dirRef.current;

    // 第一次录制 / 换盘：让用户明确选一次目录，避免默默录到 C 盘
    if (!targetDir) {
      const picked = await api.pickRecordingDir();
      if (!picked?.success) {
        setError('未选择保存目录，已取消录制');
        return false;
      }
      targetDir = picked.dir;
      setDir(targetDir);
      dirRef.current = targetDir;
    }

    let info = await api.getRecordingDiskInfo(targetDir).catch(() => null);
    if (!info?.success) {
      // 上次选的移动磁盘没插 / 盘符变了
      const picked = await api.pickRecordingDir();
      if (!picked?.success) {
        setError('保存目录不可用，请重新选择移动磁盘');
        return false;
      }
      targetDir = picked.dir;
      setDir(targetDir);
      dirRef.current = targetDir;
      info = await api.getRecordingDiskInfo(targetDir).catch(() => null);
    }
    setDiskFree(info?.success ? info.free : null);
    if (info?.success && info.free < MIN_FREE_BYTES) {
      setError(`保存目录剩余空间不足 ${fmtBytes(MIN_FREE_BYTES)}，请清理或换一个磁盘`);
      return false;
    }

    const session = {
      base: stamp(),
      dir: targetDir,
      mime,
      ext,
      segment: 0,
      paths: [],
      lanes: plan.map(p => ({
        suffix: p.suffix,
        stream: p.stream,
        token: null,
        filePath: null,
        recorder: null,
        writeChain: Promise.resolve(),
        pendingBytes: 0,
        closed: true,
      })),
    };

    streamSessionRef.current = session;
    modeRef.current = 'stream';
    try {
      await beginLanes(session, 0);
      for (const lane of session.lanes) attachLaneRecorder(lane, mime);
    } catch (e) {
      await finishStreaming();
      throw e;
    }

    setSegments(1);
    setStatus('recording');
    setDuration(0);
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 500);
    if (segmentMinutes > 0) {
      segmentTimerRef.current = setInterval(() => { void rotateSegments(); }, segmentMinutes * 60_000);
    }
    // 移动磁盘：定期看剩余空间和目录是否还在，别等写满/拔盘才报错
    diskFailRef.current = 0;
    diskTimerRef.current = setInterval(async () => {
      if (finishingRef.current) return;
      const info = await api.getRecordingDiskInfo(dirRef.current).catch(() => null);
      if (!info?.success) {
        diskFailRef.current += 1;
        if (diskFailRef.current >= 2) {
          failRef.current?.('保存目录不可用：移动磁盘可能已拔出');
        }
        return;
      }
      diskFailRef.current = 0;
      setDiskFree(info.free);
      if (info.free < STOP_FREE_BYTES) {
        failRef.current?.('磁盘剩余空间不足，已自动停止录制并保存已录内容');
      } else if (info.free < WARN_FREE_BYTES) {
        setNote(prev => prev || `磁盘剩余空间不足 ${fmtBytes(WARN_FREE_BYTES)}，请准备更换磁盘`);
      }
    }, 30_000);
    return true;
  }

  // ─── 开始 / 停止 ──────────────────────────────────────────────────────────

  const handleStart = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      setError(null);
      setNote(null);
      setLastFiles([]);
      setSegments(0);

      const notes = [];
      // 优先用隐藏录制源（始终挂载输出流，不打断导播预览），再退回可见播放器
      let videoEl = recordVideoRefsMap?.get(outputStream) || videoRefsMap?.get(outputStream);
      // 兜底：极端情况下隐藏源还没挂上（刚切输出/本地素材未注册），再请求把预览切到输出
      if (!videoEl && typeof onRequestProgram === 'function') {
        onRequestProgram(outputStream);
        for (let i = 0; i < 30 && !videoEl; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
          videoEl = recordVideoRefsMap?.get(outputStream) || videoRefsMap?.get(outputStream);
        }
        if (videoEl) notes.push('已把预览切到输出画面（录制需要这一路在播）');
      }
      if (!videoEl) {
        setError('输出画面尚未挂载：请切到导播台/网格视图，或重新选择输出后再录制');
        return;
      }

      // 隐藏录制源可能刚挂上、还没拿到首帧元数据：等一小会儿，避免按 1280×720 兜底录成低分辨率
      for (let i = 0; i < 30; i += 1) {
        const ready = videoEl.tagName === 'IMG'
          ? videoEl.naturalWidth > 0
          : (videoEl.videoWidth > 0 || videoEl.readyState >= 1);
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      stopPipelines();
      taintedRef.current = false;

      // ① 无成绩条：走画布管线（元素 captureStream 在本运行时不可靠，见文件头说明）
      const cleanStream = createCanvasStream(videoEl, { withScoreboard: false });
      if (!cleanStream) {
        setError('无法合成录制画面：素材跨域受限或当前浏览器不支持画布捕获');
        stopPipelines();
        return;
      }

      // ② 有成绩条：DOM 叠加层抓不到，必须画布合成
      const scoreStream = createCanvasStream(videoEl, { withScoreboard: true });
      const overlayCfg = scoreRef.current;
      // 选手介绍模式下 introVisible=false 表示已下屏，此时成片里不会出现任何叠加层
      const overlayOnAir = !!overlayCfg?.enabled
        && !(overlayCfg.mode === 'intro' && overlayCfg.introVisible === false);
      if (!scoreStream) {
        notes.push('叠加层合成管线不可用，本次只导出「无成绩条」一份');
      } else if (!overlayOnAir) {
        notes.push(overlayCfg?.mode === 'intro'
          ? '选手介绍当前已隐藏，两份成片内容相同'
          : '当前成绩条未启用，两份成片内容相同');
      }

      const mime = getSupportedMime();
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const plan = [{ suffix: VARIANT_CLEAN, stream: cleanStream }];
      if (scoreStream) plan.push({ suffix: VARIANT_SCORE, stream: scoreStream });

      const api = window.electronAPI;
      if (api?.beginRecording) {
        setStatus('starting');
        const ok = await startStreaming(plan, mime, ext);
        if (!ok) {
          stopPipelines();
          setStatus('idle');
          return;
        }
        if (notes.length) setNote(notes.join('；'));
        return;
      }

      // 浏览器 / 旧版 preload：仍然在内存里攒 Blob，停止后下载
      modeRef.current = 'memory';
      const jobs = [];
      for (const p of plan) {
        let recorder;
        try {
          recorder = new MediaRecorder(p.stream, mime ? { mimeType: mime } : {});
        } catch (e) {
          setError('无法创建录制器：' + e.message);
          jobs.forEach(j => { try { j.recorder.stop(); } catch {} });
          stopPipelines();
          return;
        }
        const job = { suffix: p.suffix, recorder, chunks: [] };
        recorder.ondataavailable = (e) => {
          if (e.data?.size > 0) job.chunks.push(e.data);
        };
        recorder.onerror = (e) => {
          setError('录制出错：' + (e.error?.message || e.type || '未知错误'));
        };
        jobs.push(job);
      }

      for (const j of jobs) j.recorder.start(500); // 每 500ms 收一次数据
      jobsRef.current = jobs;
      startTimeRef.current = Date.now();
      setStatus('recording');
      setDuration(0);
      if (notes.length) setNote(notes.join('；'));

      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 500);
    } catch (e) {
      setError('开始录制失败：' + (e?.message || e));
      stopPipelines();
      setStatus('idle');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleStop = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (modeRef.current === 'stream') {
        await finishStreaming();
        return;
      }

      const jobs = jobsRef.current;
      if (!jobs.length) return;
      clearInterval(timerRef.current);
      setStatus('saving');

      // 两份同时收尾，保证时间轴一致
      await Promise.all(jobs.map(j => new Promise(resolve => {
        if (j.recorder.state === 'inactive') return resolve();
        j.recorder.onstop = resolve;
        try { j.recorder.stop(); } catch { resolve(); }
      })));

      stopPipelines();

      const mime = jobs[0].recorder.mimeType || 'video/webm';
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const files = jobs.map(j => ({
        suffix: j.suffix,
        ext,
        blob: new Blob(j.chunks, { type: mime }),
      }));
      jobsRef.current = [];

      const base = stamp();
      const api = window.electronAPI;
      try {
        if (api?.saveRecordings) {
          // 旧版 Electron 路径：选一次目录，两份文件一起落地
          const payload = await Promise.all(files.map(async f => ({
            buffer: await f.blob.arrayBuffer(),
            suffix: f.suffix,
            ext: f.ext,
            base,
          })));
          const result = await api.saveRecordings(payload);
          if (result?.success) setLastFiles(result.filePaths || []);
          else setError('保存已取消');
        } else if (api?.saveRecording) {
          // 更旧版 preload：没有批量接口，逐个弹保存框
          const paths = [];
          for (const f of files) {
            const buf = await f.blob.arrayBuffer();
            const r = await api.saveRecording(buf, f.ext);
            if (r?.success) paths.push(r.filePath);
          }
          setLastFiles(paths);
        } else {
          // 浏览器：两次下载
          for (const f of files) {
            const url = URL.createObjectURL(f.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${base}_${f.suffix}.${f.ext}`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
          }
          setLastFiles(files.map(f => `${base}_${f.suffix}.${f.ext}`));
        }
      } catch (e) {
        setError('保存失败：' + (e?.message || e));
      }

      if (taintedRef.current) {
        setNote(prev => [prev, '此素材跨域受限，成片可能不含原始画面'].filter(Boolean).join('；'));
      }

      setStatus('idle');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const canRecord = !!outputStream;
  const canStream = typeof window.electronAPI?.beginRecording === 'function';
  // 有调色时成片走 canvas 管线，与监看画面保持一致
  const gradeActive = !!buildFilter(grade) || buildOverlays(grade).length > 0;
  const scoreOn = !!scoreboard?.enabled;
  const idle = status === 'idle';

  return (
    <div className="hdmi-panel record-panel">
      <h3>⏺ 录制输出</h3>

      {!canRecord && (
        <p className="hint">请先在流列表中选择一路画面作为输出</p>
      )}

      {canRecord && (
        <>
          <div className="record-source">
            <span className="record-dot" data-state={status} />
            <span className="hint" style={{ flex: 1 }}>
              {status === 'recording'
                ? `录制中 ${fmt(duration)}`
                : status === 'starting'
                  ? '准备录制…'
                  : status === 'saving'
                    ? '收尾保存中...'
                    : `准备录制 · ${outputStream}`}
            </span>
          </div>

          {canStream && idle && (
            <div className="record-target">
              <div className="record-target-row">
                <span className="hint">保存到</span>
                <span className="record-dir" title={dir || '首次录制时选择'}>
                  {dir || '未选择（首次录制时选择）'}
                </span>
                <button type="button" className="hdmi-btn" onClick={chooseDir} disabled={busy}>
                  选择目录
                </button>
              </div>
              <div className="record-target-row">
                <span className="hint">分段</span>
                <select
                  className="record-seg-select"
                  value={segmentMinutes}
                  onChange={e => changeSegment(e.target.value)}
                  disabled={busy}
                >
                  <option value={0}>不分段（单文件）</option>
                  {SEGMENT_OPTIONS.map(m => (
                    <option key={m} value={m}>每 {m} 分钟</option>
                  ))}
                </select>
                {diskFree != null && <span className="hint">剩余 {fmtBytes(diskFree)}</span>}
                {dir && (
                  <button type="button" className="record-link"
                    onClick={() => window.electronAPI?.openRecordingDir?.(dir)}>
                    打开目录
                  </button>
                )}
              </div>
              <p className="hint">边录边写入磁盘；每段独立成片，异常退出最多丢当前段最后约 1 秒。</p>
            </div>
          )}

          {canStream && status === 'recording' && (
            <p className="hint" style={{ marginTop: 6 }}>
              保存到 {dir} · 第 {segments} 段
              {segmentMinutes ? ` · 每 ${segmentMinutes} 分钟自动分段` : ' · 不分段'}
            </p>
          )}

          <div className="hdmi-actions" style={{ marginTop: 8 }}>
            {status === 'idle' ? (
              <button className="hdmi-btn primary" onClick={handleStart} disabled={busy}>
                ⏺ 开始录制{canStream ? '（边录边写）' : '（同时导出 2 份）'}
              </button>
            ) : status === 'recording' ? (
              <button className="hdmi-btn danger" onClick={handleStop} disabled={busy}>
                ⏹ 停止并保存
              </button>
            ) : (
              <button className="hdmi-btn" disabled>
                {status === 'starting' ? '准备中...' : '保存中...'}
              </button>
            )}
          </div>

          {error && <p className="hint" style={{ color: '#ef4444', marginTop: 6 }}>{error}</p>}
          {!error && note && (
            <p className="hint" style={{ color: '#f59e0b', marginTop: 6 }}>⚠ {note}</p>
          )}
          {lastFiles.length > 0 && (
            <div className="hint record-files" style={{ marginTop: 6 }}>
              <div className="record-files-head">
                <span>已保存 {lastFiles.length} 个文件{canStream && segments ? `（${segments} 段）` : ''}：</span>
                {canStream && (
                  <button type="button" className="record-link"
                    onClick={() => window.electronAPI?.revealRecording?.(lastFiles[0])}>
                    在文件夹中显示
                  </button>
                )}
              </div>
              {lastFiles.map(p => (
                <div key={p} style={{ wordBreak: 'break-all' }}>· {p}</div>
              ))}
            </div>
          )}
          {idle && !error && (
            <p className="hint" style={{ marginTop: 6 }}>
              {canStream
                ? '开始后每 1 秒把录制数据写入磁盘；停止时只做收尾，不会把整段录制读进内存。'
                : '浏览器模式暂不支持边录边写；停止后一次导出 2 份。'}
              成绩条当前 {scoreOn ? '已启用' : '未启用'}，双路编码占用 CPU 较高。
              {gradeActive ? ' 当前有调色，成片与监看一致。' : ''}
            </p>
          )}
        </>
      )}
    </div>
  );
}
