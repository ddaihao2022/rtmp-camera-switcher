/**
 * 录制素材源覆盖 · 回归验证（Electron 真实运行时）
 *
 * 背景：RecordPanel 原先依赖 HTMLMediaElement.captureStream 取流，实测在 Electron 31
 * (Chromium 126) 上有两条路走不通，会报「此浏览器不支持 captureStream」或录出空片：
 *   ① 图片素材的 <img> 根本没有 captureStream 方法（typeof undefined）；
 *   ② flv.js 直播的 MSE <video> 有方法、有轨道，但录出来是 0 字节。
 * 修复后两条成片一律走 canvas 合成，音频改从 audio.js 的 Web Audio 图取。
 * 本测试在 Electron 里复刻这两条素材源 + 音频链路，验证修法确实录得出成片。
 *
 * 运行：node tests/recording-sources.e2e.mjs
 * 找不到 electron 时跳过（退出码 0）。
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ELECTRON = [
  path.resolve('node_modules/electron/dist/electron.exe'),
  path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  path.resolve('node_modules/electron/dist/electron'),
].find(p => existsSync(p));
const INSTALLER = path.resolve('node_modules/electron/index.js');

if (!ELECTRON || !existsSync(INSTALLER)) {
  console.log('未找到 Electron，跳过录制素材源回归验证');
  process.exit(0);
}

const PAGE_SCRIPT = `(async () => {
  const out = { errors: [] };
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = new AC();
  const raf = () => new Promise(r => requestAnimationFrame(() => r()));
  const recBytes = async (stream, ms) => {
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(200);
    await new Promise(r => setTimeout(r, ms));
    await new Promise(r => { rec.onstop = r; rec.stop(); });
    return { bytes: chunks.reduce((a, b) => a + b.size, 0), mime: rec.mimeType };
  };

  try {
    // ── 0. 记录原始行为，作为「为什么必须改」的证据 ──
    const probeImg = document.createElement('img');
    out.imgCaptureStreamType = typeof probeImg.captureStream;

    // ── 1. 图片素材 → 画布 → 录制（原 bug：<img> 没有 captureStream） ──
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAI0lEQVR42u3OQQ0AAAgDIF/eNvBnFQK5VQAAAAAAAAAAAAAAAPBnAW3QAAHfPZ0OAAAAAElFTkSuQmCC';
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.src = src;
    await img.decode();
    out.imgDims = [img.naturalWidth, img.naturalHeight];
    const ci = document.createElement('canvas');
    ci.width = 320; ci.height = 180;
    const cxi = ci.getContext('2d');
    // 图片当底 + 一条移动的条（真实场景里成绩条跑表会动），画面逐帧变化才录得出非空成片
    let barX = 0;
    const drawImg = () => {
      cxi.fillStyle = '#101418'; cxi.fillRect(0, 0, ci.width, ci.height);
      cxi.drawImage(img, 0, 0, 160, 90);
      cxi.fillStyle = '#f59e0b';
      cxi.fillRect(barX % ci.width, ci.height - 30, 60, 20);
      barX += 7;
      requestAnimationFrame(drawImg);
    };
    drawImg();
    await new Promise(r => setTimeout(r, 200));
    let imgTainted = false;
    try { cxi.getImageData(0, 0, 1, 1); } catch { imgTainted = true; }
    out.imgTainted = imgTainted;
    const imgRec = await recBytes(ci.captureStream(30), 1600);
    out.imgBytes = imgRec.bytes;

    // ── 2. MSE 直播视频 → 画布 → 录制（原 bug：MSE <video> 元素直录 0 字节） ──
    // 先造一段 webm 素材
    const cs = document.createElement('canvas'); cs.width = 320; cs.height = 180;
    const cxs = cs.getContext('2d'); let t = 0;
    const paints = () => { cxs.fillStyle = 'hsl(' + ((t++) % 360) + ',80%,50%)'; cxs.fillRect(0, 0, 320, 180); requestAnimationFrame(paints); };
    paints();
    const srcStream = cs.captureStream(30);
    const osc0 = actx.createOscillator(); const od0 = actx.createMediaStreamDestination();
    osc0.connect(od0); osc0.start(); srcStream.addTrack(od0.stream.getAudioTracks()[0]);
    const madeRec = new MediaRecorder(srcStream, { mimeType: 'video/webm;codecs=vp8,opus' });
    const madeChunks = []; madeRec.ondataavailable = (e) => { if (e.data && e.data.size) madeChunks.push(e.data); };
    madeRec.start(200); await new Promise(r => setTimeout(r, 1200));
    await new Promise(r => { madeRec.onstop = r; madeRec.stop(); });
    const blob = new Blob(madeChunks, { type: 'video/webm' });
    out.mseBlobSize = blob.size;

    const ms = new MediaSource();
    const mv = document.createElement('video');
    mv.muted = true; mv.playsInline = true; mv.src = URL.createObjectURL(ms);
    await new Promise(r => ms.addEventListener('sourceopen', r, { once: true }));
    const sb = ms.addSourceBuffer('video/webm;codecs=vp8,opus');
    sb.appendBuffer(new Uint8Array(await blob.arrayBuffer()));
    await new Promise(r => sb.addEventListener('updateend', r, { once: true }));
    mv.play().catch(() => {});
    for (let i = 0; i < 300 && mv.readyState < 2; i += 1) await raf();
    out.mseReadyState = mv.readyState;

    // 记录旧路径的实际后果：元素 captureStream 直录
    let mseElementBytes = 0;
    try { mseElementBytes = (await recBytes(mv.captureStream(), 1600)).bytes; } catch (e) { mseElementBytes = 'ERR:' + e.name; }
    out.mseElementBytes = mseElementBytes;

    // 新路径：MSE 视频画进 canvas 再录
    const cm = document.createElement('canvas'); cm.width = 320; cm.height = 180;
    const cxm = cm.getContext('2d');
    let drew = 0;
    const drawMse = () => { try { cxm.drawImage(mv, 0, 0, 320, 180); drew += 1; } catch {} requestAnimationFrame(drawMse); };
    drawMse();
    await new Promise(r => setTimeout(r, 300));
    out.mseDrew = drew;
    out.mseCanvasBytes = (await recBytes(cm.captureStream(30), 1600)).bytes;

    // ── 3. 音频：从 Web Audio 图取声并轨（audio.js 的链路） ──
    const el = document.createElement('video');
    el.muted = true; el.playsInline = true; el.srcObject = srcStream;
    el.play().catch(() => {});
    for (let i = 0; i < 300 && el.readyState < 2; i += 1) await raf();
    const mes = actx.createMediaElementSource(el);
    const gain = actx.createGain();
    mes.connect(gain); gain.connect(actx.destination);
    const dest = actx.createMediaStreamDestination();
    gain.connect(dest);
    const audioTrack = dest.stream.getAudioTracks()[0] || null;
    out.audioTrack = !!audioTrack;

    const cf = document.createElement('canvas'); cf.width = 320; cf.height = 180;
    const cxf = cf.getContext('2d');
    const drawF = () => { cxf.fillStyle = 'hsl(' + (Date.now() / 20 % 360) + ',80%,50%)'; cxf.fillRect(0, 0, 320, 180); requestAnimationFrame(drawF); };
    drawF();
    const finalStream = cf.captureStream(30);
    if (audioTrack) finalStream.addTrack(audioTrack);
    out.finalTracks = { video: finalStream.getVideoTracks().length, audio: finalStream.getAudioTracks().length };
    out.finalBytes = (await recBytes(finalStream, 2000)).bytes;
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  return out;
})()`;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rec-src-'));
const mainFile = path.join(tmp, 'main.cjs');
writeFileSync(mainFile, `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  // 关掉后台节流：隐藏窗口默认会把 requestAnimationFrame 压到 ~1fps，
  // 画布就画不出帧，录制测试会误判成空片（真实应用窗口是可见的，不受影响）
  const win = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadURL('data:text/html,<html><body></body></html>');
  try {
    const res = await win.webContents.executeJavaScript(${JSON.stringify(PAGE_SCRIPT)});
    console.log('RESULT ' + JSON.stringify(res));
  } catch (e) {
    console.log('RESULT ' + JSON.stringify({ errors: [String((e && e.message) || e)] }));
  }
  app.exit(0);
}).catch((e) => { console.log('RESULT ' + JSON.stringify({ errors: [String(e)] })); app.exit(1); });
`);

let raw = '';
try {
  const r = spawnSync(ELECTRON, [mainFile], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  raw = `${r.stdout || ''}\n${r.stderr || ''}`;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

const line = raw.split(/\r?\n/).find(l => l.startsWith('RESULT '));
if (!line) {
  console.error('录制素材源回归：未取得结果');
  console.error(raw.slice(-1500));
  process.exit(1);
}

const out = JSON.parse(line.slice('RESULT '.length));
let failed = 0;
try {
  assert.deepStrictEqual(out.errors, [], `页面内错误: ${(out.errors || []).join(' | ')}`);

  // 文档化原始缺陷：图片元素没有 captureStream（这正是报错文案的来源）
  assert.strictEqual(out.imgCaptureStreamType, 'undefined',
    `预期 <img> 无 captureStream，实际 ${out.imgCaptureStreamType}`);
  console.log(`  ✓ <img>.captureStream = ${out.imgCaptureStreamType}（原始 bug 成因）`);

  // 修复后：图片素材经画布能录出成片
  // 静态图 VP8 压缩后只有几百字节（无帧间变化），阈值取「非空且是合法 webm」即可
  assert.strictEqual(out.imgTainted, false, '图片画布被污染');
  assert.ok(out.imgBytes > 200, `图片素材成片过小: ${out.imgBytes} 字节`);
  console.log(`  ✓ 图片素材 → 画布 → 录制：${out.imgBytes} 字节（${out.imgDims[0]}x${out.imgDims[1]}）`);

  // 文档化原始缺陷：MSE 元素直录为空
  assert.ok(out.mseReadyState >= 2, `MSE 视频未就绪: readyState=${out.mseReadyState}`);
  assert.strictEqual(out.mseElementBytes, 0,
    `预期 MSE 元素直录 0 字节，实际 ${out.mseElementBytes}`);
  console.log(`  ✓ MSE <video>.captureStream() 直录 = ${out.mseElementBytes} 字节（原始 bug 成因）`);

  // 修复后：MSE 视频经画布能录出成片
  assert.ok(out.mseDrew > 0, 'MSE 视频未画进画布');
  assert.ok(out.mseCanvasBytes > 1000, `MSE 素材成片过小: ${out.mseCanvasBytes} 字节`);
  console.log(`  ✓ MSE 直播视频 → 画布 → 录制：${out.mseCanvasBytes} 字节（画 ${out.mseDrew} 帧）`);

  // 修复后：音频从 Web Audio 图取到，双轨成片正常
  assert.ok(out.audioTrack, '未从 Web Audio 图取到音频轨');
  assert.deepStrictEqual(out.finalTracks, { video: 1, audio: 1 },
    `成片轨道数异常: ${JSON.stringify(out.finalTracks)}`);
  assert.ok(out.finalBytes > 1000, `音视频成片过小: ${out.finalBytes} 字节`);
  console.log(`  ✓ Web Audio 取声 + 画布合成：轨道 ${JSON.stringify(out.finalTracks)}，${out.finalBytes} 字节`);

  console.log('\n录制素材源回归：验证通过');
} catch (e) {
  failed = 1;
  console.error('\n录制素材源回归：验证失败');
  console.error('  ' + (e?.stack || e));
}
process.exit(failed);
