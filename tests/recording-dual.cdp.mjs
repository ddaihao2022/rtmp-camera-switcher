/**
 * 录制双版本导出 · 真浏览器端到端验证（CDP 驱动，无需安装 puppeteer）
 *
 * 用无头 Chrome 的假摄像头拿到一个真实的 <video>，复刻 RecordPanel 的两条画布管线：
 *   ① 无成绩条：视频 → 画布 → captureStream
 *   ② 有成绩条：视频 → 画布 → 叠加条 → captureStream
 * 两个 MediaRecorder 同时录 2.5 秒，验证：
 *   1. 两路并发录制互不影响，都能拿到非空 WebM
 *   2. 叠加层确实被合成进 ②（底栏像素为红），而 ① 没有
 *   3. 画布不被假摄像头素材污染（getImageData 探测通过）
 *
 * 运行：node tests/recording-dual.cdp.mjs
 * 可用 CHROME_PATH 指定浏览器；找不到浏览器时跳过（退出码 0）。
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 8791;
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 400); // 随机端口，避免旧实例占用
const PAGE_URL = `http://127.0.0.1:${PORT}/`;
const UTILS_DIR = path.resolve('client/src/utils');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find(p => existsSync(p)) || null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* 浏览器还没起来 */ }
    await sleep(250);
  }
  throw new Error(`无法访问 ${url}`);
}

/** 极简 CDP 客户端 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  const pending = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
  return {
    ready,
    send(method, params = {}) {
      id += 1;
      const msgId = id;
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

/** 页面内跑的真实管线（与 RecordPanel 的两条管线同构） */
const PAGE_SCRIPT = `(async () => {
  const out = { errors: [] };
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const cam = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
    video.srcObject = cam;
    await video.play();
    await new Promise((res) => {
      if (video.readyState >= 2) return res();
      video.addEventListener('loadeddata', res, { once: true });
    });

    const w = video.videoWidth || 640;
    const h = video.videoHeight || 360;
    out.dims = [w, h];

    const makePipe = (withBar) => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      const pipe = { raf: null, tainted: false, probed: false, drawFailed: false };
      const paint = () => {
        try {
          ctx.drawImage(video, 0, 0, w, h);
        } catch (e) { pipe.drawFailed = true; }
        if (!pipe.probed) {
          pipe.probed = true;
          try { ctx.getImageData(0, 0, 1, 1); } catch (e) { pipe.tainted = true; }
        }
        if (withBar) { // 相当于 drawScoreboard()
          ctx.fillStyle = 'rgb(255,0,0)';
          ctx.fillRect(0, h - 60, w, 60);
        }
      };
      const loop = () => { if (video.readyState >= 2) paint(); pipe.raf = requestAnimationFrame(loop); };
      loop();
      const stream = canvas.captureStream(30);
      try {
        const src = video.captureStream();
        src.getAudioTracks().forEach(t => stream.addTrack(t));
      } catch (e) {}
      return { canvas, ctx, stream, pipe, stop: () => cancelAnimationFrame(pipe.raf), withBar };
    };

    const pipes = [makePipe(false), makePipe(true)];
    if (pipes.some(p => p.pipe.tainted)) out.errors.push('画布被跨域素材污染');
    if (pipes.some(p => p.pipe.drawFailed)) out.errors.push('drawImage 失败');

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus' : 'video/webm';
    const jobs = pipes.map(p => {
      const rec = new MediaRecorder(p.stream, { mimeType: mime });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      return { p, rec, chunks };
    });

    jobs.forEach(j => j.rec.start(500));
    await new Promise(r => setTimeout(r, 2500));
    await Promise.all(jobs.map(j => new Promise((res) => {
      j.rec.onstop = res;
      j.rec.stop();
    })));
    pipes.forEach(p => p.stop());

    const sample = (p) => Array.from(p.ctx.getImageData(Math.floor(w / 2), h - 30, 1, 1).data);
    out.jobs = jobs.map(j => ({
      withBar: j.p.withBar,
      mime: j.rec.mimeType,
      bytes: j.chunks.reduce((a, b) => a + b.size, 0),
      type: j.chunks[0] ? j.chunks[0].type : null,
    }));
    out.bar = { clean: sample(pipes[0]), scored: sample(pipes[1]) };
    cam.getTracks().forEach(t => t.stop());
  } catch (e) {
    out.errors.push(String(e && e.message || e));
  }
  return out;
})()`;

/** 真实 CanvasRenderingContext2D 上跑一遍 drawScoreboard，验证叠加层确实落在画面底部 */
const CANVAS_SCRIPT = `(async () => {
  const out = { errors: [] };
  try {
    const mod = await import('/utils/scoreboardCanvas.js');
    const W = 1280, H = 720;
    const cfg = {
      enabled: true, mode: 'track', eventKind: 'sprint', position: 'bottom',
      category: '男子', eventName: '100米', round: '预赛', heat: '第1组', wind: '+0.8',
      mr: '10.23', sb: '10.55',
      athletes: [
        { lane: 1, name: '张三', unit: '高一3班', place: '1', result: '11.42' },
        { lane: 2, name: '李四', unit: '高一5班', place: '2', result: '11.58' },
      ],
      showPlaces: true, showResults: true, showClock: true,
      clockRunning: true, clockStartAt: Date.now() - 1500, clockOffsetMs: 0,
      laps: ['13.20', '13.01'],
    };
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    mod.drawScoreboard(ctx, cfg, W, H, Date.now());
    const clockNow = mod.clockText(cfg, Date.now()); // 跑表读数随时间走，取首帧那一刻的值
    const inside = Array.from(ctx.getImageData(W / 2, H - 0.045 * H - 20, 1, 1).data);
    const outside = Array.from(ctx.getImageData(8, 8, 1, 1).data);

    const top = document.createElement('canvas');
    top.width = W; top.height = H;
    const tctx = top.getContext('2d');
    mod.drawScoreboard(tctx, { ...cfg, position: 'top' }, W, H, Date.now());
    const topBand = Array.from(tctx.getImageData(W / 2, 30, 1, 1).data);
    const topBottom = Array.from(tctx.getImageData(W / 2, H - 40, 1, 1).data);

    const team = document.createElement('canvas');
    team.width = W; team.height = H;
    const mctx = team.getContext('2d');
    mod.drawScoreboard(mctx, {
      enabled: true, mode: 'team', position: 'bottom',
      homeName: '一中', awayName: '三中', homeScore: 3, awayScore: 2,
      period: '第2节', showClock: true, clock: '07:21',
    }, W, H, Date.now());
    const teamBar = Array.from(mctx.getImageData(W / 2, H - 0.045 * H - 20, 1, 1).data);

    // ── 选手介绍三种样式 ──
    const introBase = {
      enabled: true, mode: 'intro', introVisible: true, introTitle: '选手介绍',
      introIndex: 0, category: '男子', eventName: '100米', round: '预赛', heat: '第1组',
      introShowPb: true, introShowNote: true, introAuto: true, introAutoMs: 8000,
      athletes: [
        { lane: 1, name: '张三', unit: '高一3班', bib: '0731', pb: '11.20', note: '校运会卫冕冠军，起跑反应快' },
        { lane: 2, name: '李四', unit: '高一5班', bib: '0732', pb: '11.35', note: '本赛季进步明显' },
        { lane: 3, name: '王五', unit: '高二1班', bib: '0733', pb: '11.48', note: '' },
      ],
    };
    const render = (cfg) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      mod.drawScoreboard(x, cfg, W, H, Date.now());
      return { c, x };
    };
    // 网格采样最大不透明度：叠加层画在哪不重要，关键是「画上去了」
    const maxAlpha = (x, step = 16) => {
      let m = 0;
      for (let ay = step; ay < H - step; ay += step) {
        for (let ax = step; ax < W - step; ax += step) {
          const a = x.getImageData(ax, ay, 1, 1).data[3];
          if (a > m) m = a;
        }
      }
      return m;
    };
    const cornerAlpha = (x) => x.getImageData(8, 8, 1, 1).data[3];
    const card = render(introBase);
    const lower = render({ ...introBase, introStyle: 'lower' });
    const roster = render({ ...introBase, introStyle: 'roster', introPerScreen: 3 });
    const hidden = render({ ...introBase, introVisible: false });

    out.pixels = {
      trackInside: inside, trackOutside: outside,
      topBand, topBottom, teamBar,
      clock: clockNow,
      formatMs: mod.formatMs(65432),
    };
    out.intro = {
      card: maxAlpha(card.x), cardCorner: cornerAlpha(card.x),
      lower: maxAlpha(lower.x), lowerCorner: cornerAlpha(lower.x),
      roster: maxAlpha(roster.x),
      hidden: maxAlpha(hidden.x),
      cardBlock: card.c.toDataURL().length,
      rosterBlock: roster.c.toDataURL().length,
    };
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  return out;
})()`;

const chrome = findChrome();
if (!chrome) {
  console.log('未找到 Chrome / Edge，跳过录制双版本端到端验证（可用 CHROME_PATH 指定）');
  process.exit(0);
}

// 本地 http 源：127.0.0.1 属于可信来源，getUserMedia 才可用
const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // /utils/<module>.js → client/src/utils/<module>.js（叠加层渲染器按 ES module 现取现用）
  if (pathname.startsWith('/utils/')) {
    const target = path.resolve(UTILS_DIR, pathname.slice('/utils/'.length));
    if (target.startsWith(UTILS_DIR) && existsSync(target)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(readFileSync(target));
      return;
    }
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>record-pipe-test</title>');
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const profile = mkdtempSync(path.join(os.tmpdir(), 'dsh-chrome-'));
const child = spawn(chrome, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

let failed = 0;
try {
  const targets = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  // 必须挑到我们那份 http://127.0.0.1 页面：about:blank 不是可信来源，getUserMedia 会缺失
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl && String(t.url).startsWith(PAGE_URL))
    || targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  assert.ok(page, '未找到可调试的页面目标');

  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.navigate', { url: PAGE_URL });
  // 等页面就绪，避免在空白文档上下文里取不到 navigator.mediaDevices
  for (let i = 0; i < 40; i += 1) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `({ href: location.href, ready: document.readyState, md: !!navigator.mediaDevices, secure: window.isSecureContext })`,
      returnByValue: true,
    });
    const v = probe.result?.value || {};
    if (v.href && v.href.startsWith(PAGE_URL) && v.ready === 'complete' && v.md) break;
    await sleep(200);
  }

  const result = await cdp.send('Runtime.evaluate', {
    expression: PAGE_SCRIPT,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
  });
  cdp.close();

  const out = result.result?.value;
  assert.ok(out, `页面未返回结果: ${JSON.stringify(result).slice(0, 300)}`);
  assert.deepStrictEqual(out.errors, [], `页面内错误: ${out.errors.join(' | ')}`);
  assert.strictEqual(out.jobs.length, 2, '应有两路录制任务');

  const [clean, scored] = out.jobs;
  for (const j of out.jobs) {
    assert.ok(j.bytes > 10_000, `成片过小（${j.withBar ? '有' : '无'}成绩条 ${j.bytes} 字节），可能录到空轨道`);
  }
  assert.ok(String(clean.type).startsWith('video/webm'), `无成绩条成片类型异常: ${clean.type}`);
  assert.ok(String(scored.type).startsWith('video/webm'), `有成绩条成片类型异常: ${scored.type}`);

  const isRed = (px) => px[0] > 200 && px[1] < 60 && px[2] < 60;
  assert.ok(isRed(out.bar.scored), `叠加条没画进画布: ${out.bar.scored}`);
  assert.ok(!isRed(out.bar.clean), `无成绩条那份不应有叠加条: ${out.bar.clean}`);

  console.log(`  ✓ 假摄像头画面 ${out.dims[0]}x${out.dims[1]}，两路并发录制`);
  console.log(`  ✓ 无成绩条 ${clean.bytes} 字节 / 有成绩条 ${scored.bytes} 字节，均为 ${clean.mime}`);
  console.log(`  ✓ 叠加条只出现在「有成绩条」那份（clean=${out.bar.clean}, scored=${out.bar.scored}）`);

  // ── 阶段二：真实 CanvasRenderingContext2D 上跑 scoreboardCanvas ──
  const cdp2 = connect(page.webSocketDebuggerUrl);
  await cdp2.ready;
  const canvasResult = await cdp2.send('Runtime.evaluate', {
    expression: CANVAS_SCRIPT,
    awaitPromise: true,
    returnByValue: true,
    timeout: 20000,
  });
  cdp2.close();

  const cv = canvasResult.result?.value;
  assert.ok(cv, `成绩条渲染未返回结果: ${JSON.stringify(canvasResult).slice(0, 300)}`);
  assert.deepStrictEqual(cv.errors, [], `成绩条渲染报错: ${cv.errors.join(' | ')}`);

  const { trackInside, trackOutside, topBand, topBottom, teamBar } = cv.pixels;
  assert.ok(trackInside[3] > 180, `底部成绩条没画上（alpha=${trackInside[3]}）`);
  assert.strictEqual(trackOutside[3], 0, `bottom 档位不应画到画面顶部（alpha=${trackOutside[3]}）`);
  assert.ok(topBand[3] > 180, `top 档位成绩条没画到顶部（alpha=${topBand[3]}）`);
  assert.strictEqual(topBottom[3], 0, `top 档位不应画到画面底部（alpha=${topBottom[3]}）`);
  assert.ok(teamBar[3] > 180, `球队比分条没画上（alpha=${teamBar[3]}）`);
  assert.strictEqual(cv.pixels.formatMs, '01:05.43', `格式化异常: ${cv.pixels.formatMs}`);
  assert.ok(/^1\.[4-9]\d$/.test(cv.pixels.clock), `跑表读数异常: ${cv.pixels.clock}`);

  console.log(`  ✓ 真实 canvas 成绩条：bottom alpha=${trackInside[3]} / top alpha=${topBand[3]} / 比分条 alpha=${teamBar[3]}`);
  console.log(`  ✓ 跑表读数 ${cv.pixels.clock}，格式化 ${cv.pixels.formatMs}`);

  // ── 选手介绍叠加层 ──
  const it = cv.intro;
  assert.ok(it.card > 180, `选手介绍·单人卡没画上（maxAlpha=${it.card}）`);
  assert.strictEqual(it.cardCorner, 0, `选手介绍·单人卡不应铺满整屏（corner=${it.cardCorner}）`);
  assert.ok(it.lower > 180, `选手介绍·字幕条没画上（maxAlpha=${it.lower}）`);
  assert.strictEqual(it.lowerCorner, 0, `选手介绍·字幕条不应铺满整屏（corner=${it.lowerCorner}）`);
  assert.ok(it.roster > 180, `选手介绍·名册没画上（maxAlpha=${it.roster}）`);
  assert.strictEqual(it.hidden, 0, `选手介绍隐藏时不应绘制（maxAlpha=${it.hidden}）`);
  assert.ok(it.cardBlock > 1000 && it.rosterBlock > 1000, '选手介绍渲染结果为空');
  console.log(`  ✓ 选手介绍：单人卡 a=${it.card} / 字幕条 a=${it.lower} / 名册 a=${it.roster}，隐藏时 a=${it.hidden}`);
  console.log('\n录制双版本导出：端到端验证通过');
} catch (e) {
  failed = 1;
  console.error('\n录制双版本导出：端到端验证失败');
  console.error('  ' + (e?.stack || e));
} finally {
  try { child.kill(); } catch {}
  server.close();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(failed);
