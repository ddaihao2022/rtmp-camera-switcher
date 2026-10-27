/**
 * 服务端实时转码管理器
 *
 * 背景：导播台内置播放器(flv.js)只能稳定解 H.264。部分机位推的是 HEVC/VP9/AV1
 * （比如某些手机摄像头 App、硬件编码器、中转转码），这类流浏览器放不了，
 * 导播台会一直弹红框。
 *
 * 这里在服务端拉一路 ffmpeg，把不支持的编码实时转成 H.264 并推回同一台
 * node-media-server（streamKey 追加 _h264 后缀）。前端检测到原流不可播但转码
 * 已就绪时，自动改播转码后的 <名>_h264.flv。
 *
 * 优先用 GPU：启动时探测 NVENC / QSV / AMF，硬件编码不可用或转码失败会自动回退
 * 到 libx264 软编。GPU 只影响“能不能更快”，不改变输出仍是 H.264 的事实。
 *
 * 防递归：以 _h264 结尾的子流在 postPublish 里被直接忽略，不会再次触发转码。
 */
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');

const TRANSCODE_SUFFIX = '_h264';
const HW_PROBE_TIMEOUT_MS = 4000;
const READY_TIMEOUT_MS = 12000;

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const candidates = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe'];
  for (const c of candidates) {
    try { fs.accessSync(c); return c; } catch { /* 不存在 */ }
  }
  return 'ffmpeg'; // 退而求其次：走 PATH
}

/**
 * 硬件编码候选：默认只把「编码」放到 GPU，HEVC 解码仍走 CPU。
 * 这样最稳：720p/1080p 的 HEVC 软解压力不大，而 libx264 编码才是 CPU 大头；
 * 同时避免 d3d11va/cuda 在部分驱动上解 HEVC 直接报 -22。
 */
const HW_CANDIDATES = [
  {
    id: 'nvenc',
    label: 'NVIDIA NVENC',
    dec: [],
    enc: 'h264_nvenc',
    encArgs: [
      '-preset', 'p1', '-tune', 'll', '-profile:v', 'high',
      '-pix_fmt', 'yuv420p', '-g', '30',
      '-rc', 'cbr', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '4M',
    ],
  },
  {
    id: 'qsv',
    label: 'Intel Quick Sync',
    dec: [],
    enc: 'h264_qsv',
    encArgs: [
      '-preset', 'veryfast', '-profile:v', 'high',
      '-pix_fmt', 'nv12', '-g', '30',
      '-b:v', '4M', '-maxrate', '4M', '-bufsize', '4M',
    ],
  },
  {
    id: 'amf',
    label: 'AMD AMF',
    dec: [],
    enc: 'h264_amf',
    encArgs: [
      '-quality', 'speed', '-rc', 'cbr',
      '-pix_fmt', 'yuv420p', '-g', '30',
      '-b:v', '4M', '-maxrate', '4M', '-bufsize', '4M',
    ],
  },
];

const SW_ENCODE_ARGS = [
  '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high',
  '-pix_fmt', 'yuv420p', '-g', '30',
  '-x264-params', 'keyint=30:scenecut=0', '-threads', '2',
  '-b:v', '4M', '-maxrate', '4M', '-bufsize', '4M',
];

class TranscodeManager extends EventEmitter {
  constructor({ rtmpHost = '127.0.0.1', rtmpPort = 1935 } = {}) {
    super();
    this.rtmpHost = rtmpHost;
    this.rtmpPort = rtmpPort;
    this.ffmpeg = resolveFfmpeg();
    this.jobs = new Map(); // parentKey -> job
    this.retryTimers = new Map(); // parentKey -> 硬件失败后延迟回退软编的定时器
    this.hw = undefined;   // undefined=未探测, null=无可用, object=候选
    this.hwProbe = null;
  }

  isTranscodeOutput(streamKey) {
    return typeof streamKey === 'string' && streamKey.endsWith(TRANSCODE_SUFFIX);
  }
  parentKeyOf(streamKey) {
    return streamKey.slice(0, -TRANSCODE_SUFFIX.length);
  }
  childKeyOf(parentKey) {
    return parentKey + TRANSCODE_SUFFIX;
  }

  /** 探测一次硬件编码器；结果缓存，避免每次推流都跑 ffmpeg */
  async probeHw() {
    if (this.hw !== undefined) return this.hw;
    if (this.hwProbe) return this.hwProbe;
    this.hwProbe = (async () => {
      for (const c of HW_CANDIDATES) {
        const ok = await this.probeEncoder(c);
        if (ok) {
          this.hw = c;
          console.log(`[转码] GPU 加速可用：${c.label}（${c.enc}）`);
          return c;
        }
      }
      this.hw = null;
      console.log('[转码] 未检测到可用 GPU 编码器，使用 libx264 软编');
      return null;
    })();
    return this.hwProbe;
  }

  probeEncoder(candidate) {
    return new Promise((resolve) => {
      let done = false;
      let proc;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { proc?.kill('SIGTERM'); } catch { /* 已退出 */ }
        resolve(ok);
      };
      try {
        proc = spawn(this.ffmpeg, [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc=size=256x144:rate=30',
          '-frames:v', '8',
          '-c:v', candidate.enc, ...candidate.encArgs,
          '-f', 'null', '-',
        ], { windowsHide: true });
      } catch {
        finish(false);
        return;
      }
      const timer = setTimeout(() => finish(false), HW_PROBE_TIMEOUT_MS);
      proc.once('error', () => { clearTimeout(timer); finish(false); });
      proc.once('exit', (code) => { clearTimeout(timer); finish(code === 0); });
    });
  }

  /**
   * 决定是否需要并启动转码。
   * @param {string} parentKey 原始机位的 streamKey
   * @param {{ browserPlayable?: boolean }} [opts]
   */
  async maybeStart(parentKey, { browserPlayable = false, audioOnly = false } = {}) {
    if (this.jobs.has(parentKey)) return;
    // 视频本身可播、只是音频不兼容（Opus/FLAC）→ 只转音频，视频直接 copy
    if (audioOnly) {
      this.startJob(parentKey, 'audio', null);
      return;
    }
    if (browserPlayable) return; // 本身就是 H.264，无需转码
    const hw = await this.probeHw();
    if (this.jobs.has(parentKey)) return; // 探测期间已经有人启动
    this.startJob(parentKey, hw ? 'hw' : 'sw', hw);
  }

  buildArgs(input, output, mode, hw) {
    const base = [
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '500000',
      '-analyzeduration', '1000000',
    ];
    const audioOut = ['-c:a', 'aac', '-b:a', '96k', '-ar', '44100'];

    if (mode === 'audio') {
      // 视频已经是浏览器能播的 H.264，只把 Opus/FLAC 等音频转成 AAC
      return [
        ...base,
        '-i', input,
        '-map', '0:v:0',
        '-map', '0:a?',
        '-c:v', 'copy',
        ...audioOut,
        '-f', 'flv',
        output,
      ];
    }

    const dec = mode === 'hw' && hw ? hw.dec : [];
    const enc = mode === 'hw' && hw ? hw.enc : 'libx264';
    const encArgs = mode === 'hw' && hw ? hw.encArgs : SW_ENCODE_ARGS;
    return [
      ...base,
      ...dec,
      '-i', input,
      '-map', '0:v:0',
      '-map', '0:a?',            // 有音频就带，没有就不带
      '-c:v', enc,
      ...encArgs,
      ...audioOut,
      '-f', 'flv',
      output,
    ];
  }

  startJob(parentKey, mode, hw) {
    if (this.jobs.has(parentKey)) return;
    // 显式启动时清掉待执行的软编回退，避免重复拉起
    const pendingRetry = this.retryTimers.get(parentKey);
    if (pendingRetry) {
      clearTimeout(pendingRetry);
      this.retryTimers.delete(parentKey);
    }
    const childKey = this.childKeyOf(parentKey);
    // parentKey 已是完整 streamKey（如 live/thevc），直接拼进 URL，
    // 不要再额外加 /live/ 前缀，否则会变成 /live/live/thevc_h264 这种错误路径
    const input = `rtmp://${this.rtmpHost}:${this.rtmpPort}/${parentKey}`;
    const output = `rtmp://${this.rtmpHost}:${this.rtmpPort}/${childKey}`;
    const args = this.buildArgs(input, output, mode, hw);

    let proc;
    try {
      proc = spawn(this.ffmpeg, args, { windowsHide: true });
    } catch (e) {
      this.emit('update', parentKey, { status: 'error', childKey, error: e.message });
      return;
    }

    const job = {
      parentKey, childKey, proc, mode,
      status: 'pending', startedAt: Date.now(),
      ready: false, readyTimer: null,
      stopped: false,   // 主动 kill（源流下线 / 无数据看门狗）
      timedOut: false,  // 看门狗超时：源流根本没有可解码的视频帧
    };
    this.jobs.set(parentKey, job);
    console.log(`[转码] ${parentKey} → ${childKey}（${
      mode === 'audio' ? '音频转 AAC，视频 copy' : mode === 'hw' && hw ? hw.label : 'libx264 软编'
    }）`);

    let stderr = '';
    if (proc.stderr) {
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 2000) stderr = stderr.slice(-2000);
      });
    }
    proc.on('error', (e) => {
      if (job.readyTimer) clearTimeout(job.readyTimer);
      this.jobs.delete(parentKey);
      this.emit('update', parentKey, { status: 'error', childKey, error: e.message });
    });
    proc.on('exit', (code, signal) => {
      if (job.readyTimer) clearTimeout(job.readyTimer);
      this.jobs.delete(parentKey);
      if (job.ready) {
        // 源流断开导致 ffmpeg 自然退出 —— 视为已停止，不报错误
        this.emit('update', parentKey, { status: 'stopped', childKey });
        return;
      }
      // 主动停止（源流下线 / 看门狗清理）：这不是转码故障。
      // 以前这里会显示 "ffmpeg 异常退出(code=null): "（SIGTERM 被杀、stderr 为空），
      // 现场看起来像转码器坏了，实际只是我们在收摊。
      if (job.stopped) {
        this.emit('update', parentKey, { status: 'stopped', childKey });
        return;
      }
      // 看门狗超时 = 12 秒没有一帧输出。可能是源流没画面，也可能是硬编码器
      // 在这条流上卡住；先回退一次软编再报告，别让硬件路径把本来能转的流判死。
      if (mode === 'hw') {
        const why = job.timedOut
          ? '12 秒未出帧'
          : (stderr.slice(-160) || `code=${code} signal=${signal ?? '-'}`);
        console.log(`[转码] ${parentKey} GPU 转码失败，回退 libx264（${why}）`);
        // 等旧子流在 NMS 里彻底下线再拉起软编：否则新 ffmpeg 推同一个
        // <key>_h264 会被 “already has a publisher” 顶掉。
        const t = setTimeout(() => {
          this.retryTimers.delete(parentKey);
          if (!this.jobs.has(parentKey)) this.startJob(parentKey, 'sw', null);
        }, 500);
        this.retryTimers.set(parentKey, t);
        return;
      }
      if (job.timedOut) {
        // 软编也 12 秒出不了帧 → 源流确实没有可解码的视频
        this.emit('update', parentKey, {
          status: 'error', childKey,
          error: '硬编/软编都没能在 12 秒内输出视频帧（推流端无画面，或码流损坏、缺关键帧）',
        });
        return;
      }
      this.emit('update', parentKey, {
        status: 'error', childKey,
        error: `ffmpeg 异常退出(code=${code}): ${stderr.slice(-300)}`,
      });
    });

    // 看门狗：ffmpeg 连上子流不代表有画面（源流 NAL 损坏时会一直空转）。
    job.readyTimer = setTimeout(() => {
      if (job.ready || job.stopped) return;
      job.timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
      // exit 事件里决定回退软编还是报错
    }, READY_TIMEOUT_MS);

    this.emit('update', parentKey, { status: 'pending', childKey, mode });
  }

  /** 转码子流关键帧到达 → 标记就绪。返回是否发生了 pending→ready 的翻转 */
  onOutputReady(parentKey, childKey) {
    const job = this.jobs.get(parentKey);
    if (!job || job.ready) return false; // 没有任务 / 已经 ready，忽略重复关键帧
    job.status = 'ready';
    job.ready = true;
    if (job.readyTimer) clearTimeout(job.readyTimer);
    this.emit('update', parentKey, { status: 'ready', childKey, mode: job.mode });
    return true;
  }

  /** 源流停止 → 杀掉转码进程 */
  stop(parentKey) {
    const pendingRetry = this.retryTimers.get(parentKey);
    if (pendingRetry) {
      clearTimeout(pendingRetry);
      this.retryTimers.delete(parentKey);
    }
    const job = this.jobs.get(parentKey);
    if (!job) return;
    if (job.readyTimer) clearTimeout(job.readyTimer);
    job.stopped = true;
    this.jobs.delete(parentKey);
    try { job.proc.kill('SIGTERM'); } catch { /* 已退出 */ }
  }

  list() {
    return [...this.jobs.entries()].map(([k, j]) => ({
      parentKey: k, childKey: j.childKey, status: j.status,
      mode: j.mode,
      uptimeMs: Date.now() - j.startedAt,
    }));
  }

  /** 某路机位当前是否已有转码进程（供恢复逻辑判断） */
  isRunning(parentKey) {
    return this.jobs.has(parentKey);
  }
}

module.exports = { TranscodeManager, TRANSCODE_SUFFIX, resolveFfmpeg };
