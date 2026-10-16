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
 * Props:
 *   outputStream  - 当前选为输出的 streamKey
 *   videoRefsMap  - Map<streamKey, HTMLVideoElement>，由 App 层维护
 *   grade         - 该路生效的调色参数；有调色时走 canvas 录制，保证成片与监看一致
 *   scoreboard    - /api/scoreboard 配置（App 经 socket 同步），供叠加层烧录
 */

const VARIANT_CLEAN = '无成绩条';
const VARIANT_SCORE = '有成绩条';

/** recording-20261014-203000 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export default function RecordPanel({
  outputStream,
  videoRefsMap,
  grade = null,
  scoreboard = null,
}) {
  const [status, setStatus] = useState('idle'); // idle | recording | saving
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [lastFiles, setLastFiles] = useState([]);

  const jobsRef = useRef([]); // [{ suffix, recorder, chunks }]
  const timerRef = useRef(null);
  const startTimeRef = useRef(0);
  const pipesRef = useRef([]); // 画布管线句柄 [{ raf, canvas, stream }]
  const audioRef = useRef([]); // 从 Web Audio 图分出的录制音频句柄 [{ stop }]
  const scoreRef = useRef(scoreboard);
  const taintedRef = useRef(false); // 录制期间画布是否被跨域素材污染

  // 录制中叠加层会实时变（改分 / 跑表 / 换项目），用 ref 让绘制循环读到最新配置
  useEffect(() => { scoreRef.current = scoreboard; }, [scoreboard]);

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
    for (const j of jobsRef.current) {
      try { if (j.recorder.state === 'recording') j.recorder.stop(); } catch {}
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

  const handleStart = () => {
    setError(null);
    setNote(null);
    setLastFiles([]);

    const videoEl = videoRefsMap?.get(outputStream);
    if (!videoEl) {
      setError('未找到输出视频元素，请先选择输出画面并开始播放');
      return;
    }

    stopPipelines();
    taintedRef.current = false;
    const notes = [];

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
    const plan = [{ suffix: VARIANT_CLEAN, stream: cleanStream }];
    if (scoreStream) plan.push({ suffix: VARIANT_SCORE, stream: scoreStream });

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
  };

  const handleStop = async () => {
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
        // Electron：选一次目录，两份文件一起落地（<base>_无成绩条.webm / <base>_有成绩条.webm）
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
        // 旧版 preload：没有批量接口，逐个弹保存框
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
  };

  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const canRecord = !!outputStream;
  // 有调色时成片走 canvas 管线，与监看画面保持一致
  const gradeActive = !!buildFilter(grade) || buildOverlays(grade).length > 0;
  const scoreOn = !!scoreboard?.enabled;

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
                : status === 'saving'
                  ? '保存中...'
                  : `准备录制 · ${outputStream}`}
            </span>
          </div>

          <div className="hdmi-actions" style={{ marginTop: 8 }}>
            {status === 'idle' ? (
              <button className="hdmi-btn primary" onClick={handleStart}>
                ⏺ 开始录制（同时导出 2 份）
              </button>
            ) : status === 'recording' ? (
              <button className="hdmi-btn danger" onClick={handleStop}>
                ⏹ 停止并保存
              </button>
            ) : (
              <button className="hdmi-btn" disabled>
                保存中...
              </button>
            )}
          </div>

          {error && <p className="hint" style={{ color: '#ef4444', marginTop: 6 }}>{error}</p>}
          {!error && note && (
            <p className="hint" style={{ color: '#f59e0b', marginTop: 6 }}>⚠ {note}</p>
          )}
          {lastFiles.length > 0 && (
            <div className="hint" style={{ marginTop: 6 }}>
              已保存 {lastFiles.length} 份：
              {lastFiles.map(p => (
                <div key={p} style={{ wordBreak: 'break-all' }}>· {p}</div>
              ))}
            </div>
          )}
          {status === 'idle' && !error && (
            <p className="hint" style={{ marginTop: 6 }}>
              停止后一次导出 2 份：<b>无成绩条</b>（原片{gradeActive ? '，含调色' : ''}）与<b>有成绩条</b>
              （成绩条烧进画面）。
              成绩条当前 {scoreOn ? '已启用' : '未启用'}，双路编码占用 CPU 较高。
            </p>
          )}
        </>
      )}
    </div>
  );
}
