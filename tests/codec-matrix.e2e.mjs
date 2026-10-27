/**
 * 编码矩阵端到端测试
 *
 * 用 ffmpeg 生成不同编码/分辨率/音频的 RTMP 流，验证：
 *   1) 服务端能识别编码（H.264 / HEVC / VP9 / AV1 / 10-bit）
 *   2) 浏览器能播的直接播；不能播的自动转 H.264
 *   3) 转码/直出的 HTTP-FLV 真的能解出视频帧
 *
 * 运行：node tests/codec-matrix.e2e.mjs
 * 依赖：ffmpeg 在 PATH（与现场转码用的是同一个）
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3500 + Math.floor(Math.random() * 200);
const RTMP_PORT = 14500 + Math.floor(Math.random() * 200);
const FLV_PORT = 8600 + Math.floor(Math.random() * 200);
const API = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
const results = [];

function ffmpegPush(key, args) {
  return spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-re',
    ...args,
    '-f', 'flv', `rtmp://127.0.0.1:${RTMP_PORT}/live/${key}`,
  ], { stdio: 'ignore', windowsHide: true });
}

const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');
mkdirSync(ARTIFACTS, { recursive: true });

function runToFile(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(cmd, args, { stdio: 'ignore', windowsHide: true }); } catch (e) {
      resolve({ code: -1, error: e.message });
      return;
    }
    let done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
      resolve({ code, error });
    };
    const timer = setTimeout(() => finish(-2, 'timeout'), timeoutMs);
    proc.once('error', (e) => { clearTimeout(timer); finish(-1, e.message); });
    proc.once('exit', (code) => { clearTimeout(timer); finish(code ?? -1); });
  });
}

/**
 * 用 curl 抓 4 秒 FLV 到文件，再用 ffprobe 数视频帧。
 * 不用 ffmpeg 直接拉直播：直播 FLV 没有 EOF，-frames:v 在部分版本上会一直等。
 */
async function capturePlayback(playPath, key) {
  const file = path.join(ARTIFACTS, `codec-${key}-${Date.now()}.flv`);
  try {
    await runToFile('curl', ['--max-time', '4', '-s', '-o', file, `http://127.0.0.1:${FLV_PORT}${playPath}`], 6000);
    if (!existsSync(file)) return { ok: false, reason: '没有抓到 FLV 数据' };
    const probe = await runToFile('ffprobe', [
      '-v', 'error', '-select_streams', 'v', '-count_frames',
      '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', file,
    ], 8000);
    if (probe.code !== 0) return { ok: false, reason: `ffprobe exit ${probe.code}` };
    // runToFile 不收集 stdout，这里再同步读一次
    const { execFileSync } = await import('node:child_process');
    const raw = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v', '-count_frames',
      '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', file,
    ], { encoding: 'utf8' });
    const stream = JSON.parse(raw)?.streams?.[0] || {};
    const frames = Number(stream.nb_read_frames) || 0;
    if (stream.codec_name !== 'h264') {
      return { ok: false, reason: `实际编码 ${stream.codec_name || '未知'}` };
    }
    if (frames < 5) return { ok: false, reason: `只解出 ${frames} 帧` };
    return { ok: true, reason: `H.264 / ${frames} 帧` };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

function waitPort(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() - start > timeoutMs) return resolve(false);
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); setTimeout(tick, 250); });
    };
    tick();
  });
}

async function waitStream(key, predicate, timeoutMs = 16000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await (await fetch(`${API}/api/streams`)).json();
      last = list.find((s) => s.streamKey === `live/${key}`) || null;
      if (last && predicate(last)) return last;
    } catch { /* 服务端还没起 */ }
    await sleep(400);
  }
  return last;
}

const AUDIO_IN = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const AUDIO_OUT = ['-c:a', 'aac', '-b:a', '96k'];

const CASES = [
  {
    id: 'h264-720p30', label: 'H.264 720p30', expect: 'H.264', transcode: false,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', ...AUDIO_IN, '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high', '-g', '30', '-pix_fmt', 'yuv420p', ...AUDIO_OUT],
  },
  {
    id: 'h264-1080p60', label: 'H.264 1080p60', expect: 'H.264', transcode: false,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high', '-g', '60', '-pix_fmt', 'yuv420p'],
  },
  {
    id: 'h264-baseline', label: 'H.264 Baseline', expect: 'H.264', transcode: false,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline', '-g', '30', '-pix_fmt', 'yuv420p'],
  },
  {
    id: 'h264-10bit', label: 'H.264 High10（10-bit）', expect: 'H.264 10-bit', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le', '-g', '30'],
  },
  {
    id: 'hevc-720p', label: 'HEVC Main 720p', expect: 'H.265/HEVC', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', ...AUDIO_IN, '-t', '12',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=30', '-pix_fmt', 'yuv420p', ...AUDIO_OUT],
  },
  {
    id: 'hevc-10bit', label: 'HEVC Main10（10-bit）', expect: 'H.265/HEVC', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '12',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=30', '-pix_fmt', 'yuv420p10le'],
  },
  {
    id: 'vp9', label: 'VP9', expect: 'VP9', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '12',
      '-c:v', 'libvpx-vp9', '-b:v', '800k', '-g', '30', '-pix_fmt', 'yuv420p'],
  },
  {
    id: 'av1', label: 'AV1', expect: 'AV1', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '12',
      '-c:v', 'libsvtav1', '-preset', '12', '-g', '30', '-pix_fmt', 'yuv420p'],
  },
  {
    id: 'h264-422', label: 'H.264 4:2:2', expect: 'H.264', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high422', '-pix_fmt', 'yuv422p', '-g', '30'],
  },
  {
    id: 'h264-444', label: 'H.264 4:4:4', expect: 'H.264', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high444', '-pix_fmt', 'yuv444p', '-g', '30'],
  },
  {
    id: 'hevc-422', label: 'HEVC 4:2:2', expect: 'H.265/HEVC', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '12',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=30', '-pix_fmt', 'yuv422p'],
  },
  {
    id: 'hevc-444', label: 'HEVC 4:4:4', expect: 'H.265/HEVC', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '12',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=30', '-pix_fmt', 'yuv444p'],
  },
  {
    id: 'vp9-10bit', label: 'VP9 10-bit', expect: 'VP9', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '12',
      '-c:v', 'libvpx-vp9', '-b:v', '500k', '-g', '30', '-pix_fmt', 'yuv420p10le'],
  },
  {
    id: 'av1-10bit', label: 'AV1 10-bit', expect: 'AV1', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '12',
      '-c:v', 'libsvtav1', '-preset', '12', '-g', '30', '-pix_fmt', 'yuv420p10le'],
  },
  {
    id: 'h264-opus', label: 'H.264 + Opus 音频', expect: 'H.264', transcode: true,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-b:a', '96k'],
  },
  {
    id: 'h264-noaudio', label: 'H.264 无音频', expect: 'H.264', transcode: false,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-an'],
  },
  {
    id: 'h264-mp3', label: 'H.264 + MP3 音频', expect: 'H.264', transcode: false,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'libmp3lame', '-b:a', '96k'],
  },
  {
    id: 'h264-odd', label: 'H.264 奇数分辨率 641x361', expect: 'H.264', transcode: false,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=641x361:rate=30', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p'],
  },
  {
    id: 'h264-vertical', label: 'H.264 竖屏 720x1280', expect: 'H.264', transcode: false,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p'],
  },
  {
    id: 'h264-lowbitrate', label: 'H.264 低码率 200k', expect: 'H.264', transcode: false,
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '200k', '-g', '30', '-pix_fmt', 'yuv420p'],
  },
];

const SERVER_LOG = path.join(ARTIFACTS, 'codec-matrix-server.log');

try {
  try { rmSync(SERVER_LOG, { force: true }); } catch { /* ignore */ }
  const logStream = createWriteStream(SERVER_LOG, { flags: 'a' });
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), RTMP_PORT: String(RTMP_PORT), FLV_PORT: String(FLV_PORT) },
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  let up = false;
  for (let i = 0; i < 80 && !up; i += 1) {
    try { up = (await fetch(`${API}/api/health`)).ok; } catch { await sleep(200); }
  }
  assert.ok(up, '服务端未启动');
  assert.ok(await waitPort(RTMP_PORT), 'RTMP 端口未监听');
  assert.ok(await waitPort(FLV_PORT), 'HTTP-FLV 端口未监听');
  console.log(`编码矩阵测试 · API=${PORT} RTMP=${RTMP_PORT} FLV=${FLV_PORT}\n`);

  for (const c of CASES) {
    const started = Date.now();
    let pushError = '';
    const push = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-re',
      ...c.args,
      '-f', 'flv', `rtmp://127.0.0.1:${RTMP_PORT}/live/${c.id}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    push.stderr?.on('data', (d) => { pushError += d.toString(); });

    const stream = await waitStream(c.id, (s) => {
      if (!s.videoCodec || Number(s.videoFramerate) <= 0) return false;
      if (c.transcode && s.transcodeStatus !== 'ready' && s.transcodeStatus !== 'error') return false;
      return true;
    });
    let status = 'FAIL';
    let detail = '';
    let playPath = '';

    if (!stream) {
      detail = pushError.slice(-160) || '服务端没有该流';
    } else if (stream.videoCodecLabel !== c.expect) {
      detail = `编码识别为 ${stream.videoCodecLabel}，期望 ${c.expect}`;
    } else if (c.transcode && stream.transcodeStatus === 'error') {
      detail = `转码失败：${stream.transcodeError || '未知错误'}`;
    } else if (c.transcode && stream.transcodeStatus !== 'ready') {
      detail = `转码状态 ${stream.transcodeStatus || 'null'}`;
    } else {
      playPath = c.transcode ? stream.transcodedFlvPath : stream.flvPath;
      if (!playPath) {
        detail = '没有可播放路径';
      } else {
        const pull = await capturePlayback(playPath, c.id);
        if (pull.ok) {
          status = 'PASS';
          detail = c.transcode
            ? `${stream.transcodeMode === 'hw' ? 'GPU' : stream.transcodeMode === 'audio' ? '音频转 AAC' : 'SW'} 转码 → ${pull.reason}`
            : `直出 → ${pull.reason}`;
        } else {
          detail = pull.reason;
        }
      }
    }

    try { push.kill('SIGTERM'); } catch { /* 已退出 */ }
    await sleep(900);

    results.push({ ...c, status, detail, stream, elapsed: Date.now() - started });
    console.log(`${status === 'PASS' ? '✓' : '✗'} ${c.label.padEnd(22)} ${detail}`);
    if (status !== 'PASS') {
      console.log(`    stream=${JSON.stringify(stream && {
        codec: stream.videoCodec, label: stream.videoCodecLabel,
        status: stream.transcodeStatus, mode: stream.transcodeMode,
        path: stream.transcodedFlvPath, err: stream.transcodeError,
        w: stream.videoWidth, h: stream.videoHeight, fps: stream.videoFramerate,
      })}`);
    }
  }

  const failed = results.filter((r) => r.status !== 'PASS');
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.label).join('、'));
    process.exitCode = 1;
  } else {
    console.log('✅ 编码矩阵全部通过');
  }
} finally {
  try { child?.kill(); } catch { /* 已退出 */ }
  await sleep(800);
}
