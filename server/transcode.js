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
 * 防递归：以 _h264 结尾的子流在 postPublish 里被直接忽略，不会再次触发转码。
 */
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');

const TRANSCODE_SUFFIX = '_h264';

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

class TranscodeManager extends EventEmitter {
  constructor({ rtmpHost = '127.0.0.1', rtmpPort = 1935 } = {}) {
    super();
    this.rtmpHost = rtmpHost;
    this.rtmpPort = rtmpPort;
    this.ffmpeg = resolveFfmpeg();
    this.jobs = new Map(); // parentKey -> job
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

  /**
   * 决定是否需要并启动转码。
   * @param {string} parentKey 原始机位的 streamKey
   * @param {{ browserPlayable?: boolean }} [opts]
   */
  maybeStart(parentKey, { browserPlayable = false } = {}) {
    if (this.jobs.has(parentKey)) return;
    if (browserPlayable) return; // 本身就是 H.264，无需转码

    const childKey = this.childKeyOf(parentKey);
    // parentKey 已是完整 streamKey（如 live/thevc），直接拼进 URL，
    // 不要再额外加 /live/ 前缀，否则会变成 /live/live/thevc_h264 这种错误路径
    const input = `rtmp://${this.rtmpHost}:${this.rtmpPort}/${parentKey}`;
    const output = `rtmp://${this.rtmpHost}:${this.rtmpPort}/${childKey}`;

    const args = [
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '500000',
      '-analyzeduration', '1000000',
      '-i', input,
      '-map', '0:v:0',
      '-map', '0:a?',            // 有音频就带，没有就不带（? 表示可选）
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',    // 直播低延迟
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-g', '30',
      '-x264-params', 'keyint=30:scenecut=0',
      '-threads', '2',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '44100',
      '-f', 'flv',
      output,
    ];

    let proc;
    try {
      proc = spawn(this.ffmpeg, args, { windowsHide: true });
    } catch (e) {
      this.emit('update', parentKey, { status: 'error', childKey, error: e.message });
      return;
    }

    const job = { parentKey, childKey, proc, status: 'pending', startedAt: Date.now() };
    this.jobs.set(parentKey, job);

    let stderr = '';
    if (proc.stderr) {
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 2000) stderr = stderr.slice(-2000);
      });
    }
    proc.on('error', (e) => {
      this.jobs.delete(parentKey);
      this.emit('update', parentKey, { status: 'error', childKey, error: e.message });
    });
    proc.on('exit', (code, signal) => {
      this.jobs.delete(parentKey);
      if (code === 0 || signal) {
        // 源流断开导致 ffmpeg 自然退出 —— 视为已停止，不报错误
        this.emit('update', parentKey, { status: 'stopped', childKey });
      } else {
        this.emit('update', parentKey, {
          status: 'error', childKey,
          error: `ffmpeg 异常退出(code=${code}): ${stderr.slice(-300)}`,
        });
      }
    });

    this.emit('update', parentKey, { status: 'pending', childKey });
  }

  /** 转码子流已成功 publish（第一帧已推回）→ 标记就绪 */
  onOutputReady(parentKey, childKey) {
    const job = this.jobs.get(parentKey);
    if (job) job.status = 'ready';
    this.emit('update', parentKey, { status: 'ready', childKey });
  }

  /** 源流停止 → 杀掉转码进程 */
  stop(parentKey) {
    const job = this.jobs.get(parentKey);
    if (!job) return;
    this.jobs.delete(parentKey);
    try { job.proc.kill('SIGTERM'); } catch { /* 已退出 */ }
  }

  list() {
    return [...this.jobs.entries()].map(([k, j]) => ({
      parentKey: k, childKey: j.childKey, status: j.status,
      uptimeMs: Date.now() - j.startedAt,
    }));
  }
}

module.exports = { TranscodeManager, TRANSCODE_SUFFIX, resolveFfmpeg };
