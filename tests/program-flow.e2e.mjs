/**
 * 节目单 / 名册批量导入 · 端到端验证（CDP 驱动，无需 puppeteer）
 *
 * 复刻现场最省事的流程，全部走真实 UI：
 *   1. 设置 → 节目单：粘贴整天节目单 → 点「生成节目单」
 *   2. 侧栏「田径直播」出现节目单控制条 → 点「下一项 ▶」一次到位（项目/轮次/组次/名册）
 *   3. 键盘 PageDown / PageUp 切项
 *   4. 选手介绍模式下切项：名册换人、索引归零、仍在上屏
 *   5. 现场改过的姓名在切走再切回后仍保留（切换前快照回写该节）
 *   6. 设置 → 选手介绍：粘贴名册 → 点「导入」直接填满道次
 *
 * 运行：node tests/program-flow.e2e.mjs
 * 截图产物：tests/artifacts/*.png
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { skipIfPortsBusy } from './port-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'tests', 'artifacts');
const SCOREBOARD_FILE = path.join(ROOT, 'data', 'scoreboard.json');
const API = 'http://localhost:3001';
const DEBUG_PORT = 9500 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROGRAM_TEXT = [
  '# 10:30 男子100米 预赛 第1组',
  '3 张三 高一2班 1023 11.20',
  '4 李四 高一3班 1024 11.35',
  '# 10:36 男子100米 预赛 第2组',
  '3 王五 高二1班 1088 10.98',
  '4 赵六 高二2班 1089 11.45',
  '# 10:50 女子跳远 决赛',
  '王七 高三1班',
  '孙八 高三2班',
].join('\n');

const ROSTER_TEXT = [
  '5 钱九 高二4班 1099 11.02',
  '6 周十 高二5班 1100 11.12',
].join('\n');

const children = [];
function track(child, name) {
  children.push({ child, name });
  child.on('exit', (code) => { if (code) console.log(`[${name}] exit code=${code}`); });
  return child;
}
function shutdown() {
  for (const { child } of children) { try { child.kill(); } catch { /* 已退出 */ } }
}

async function getJson(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error(`无法访问 ${url}`);
}

async function waitHttp(url, label, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try { const res = await fetch(url); if (res.ok) return true; } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error(`等不到 ${label}`);
}

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
    async eval(expression) {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面内异常');
      return r.result?.value;
    },
    async key(keyName, code, vk) {
      for (const type of ['keyDown', 'keyUp']) {
        await this.send('Input.dispatchKeyEvent', {
          type, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        });
      }
    },
    async screenshot(file) {
      await this.send('Page.enable');
      const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

const CONTROL_PRED = (t) => t.url.startsWith('http://localhost:5173') && !t.url.includes('view=');

async function waitTarget(pred, label, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (res.ok) {
        const hit = (await res.json()).find((t) => t.type === 'page' && pred(t));
        if (hit) return hit;
      }
    } catch { /* 端口未就绪 */ }
    await sleep(500);
  }
  throw new Error(`等不到 target：${label}`);
}

/** React 受控输入：必须走原生 setter + input 事件 */
const REACT_SET_VALUE = `(sel, value) => {
  const el = document.querySelector(sel);
  const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value.length;
}`;

let page = null;

async function connectControl() {
  const t = await waitTarget(CONTROL_PRED, '主控窗口');
  const p = connect(t.webSocketDebuggerUrl);
  await p.ready;
  return p;
}

/** Vite 首次启动会做依赖预构建并强制刷新页面，刷新会销毁执行上下文 → 自动重连重试 */
async function ev(expression, tries = 10) {
  for (let i = 0; i < tries; i += 1) {
    try { return await page.eval(expression); } catch (e) {
      const m = String(e?.message || '');
      if (!/context|destroyed|closed|not found/i.test(m)) throw e;
      await sleep(1000);
      page = await connectControl();
    }
  }
  throw new Error(`页面求值反复失败：${String(expression).slice(0, 60)}`);
}

async function key(k, code, vk, tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    try { await page.key(k, code, vk); return; } catch (e) {
      const m = String(e?.message || '');
      if (!/context|destroyed|closed|not found/i.test(m)) throw e;
      await sleep(1000);
      page = await connectControl();
    }
  }
  throw new Error(`按键反复失败：${k}`);
}

/** 等页面稳定：两次采样的 performance.timeOrigin 一致，说明期间没有刷新 */
async function waitStable(label) {
  for (let i = 0; i < 40; i += 1) {
    const probe = `({ t: performance.timeOrigin, ready: document.readyState, btn: !!document.querySelector('.settings-btn') })`;
    const a = await ev(probe);
    await sleep(1200);
    const b = await ev(probe);
    if (a.t === b.t && b.ready === 'complete' && b.btn) return true;
  }
  throw new Error(`页面始终未稳定：${label}`);
}

const board = () => getJson(`${API}/api/scoreboard`);
const names = (cfg) => (cfg.athletes || []).filter(a => a.name).map(a => a.name);
const clickByText = (selector, text) => `(() => {
  const hit = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(el => el.textContent.includes(${JSON.stringify(text)}));
  if (!hit) throw new Error('找不到按钮：' + ${JSON.stringify(text)});
  hit.click();
  return hit.textContent.trim();
})()`;

/** 测试会改到 data/scoreboard.json（服务端每次广播都会落盘），跑完原样还原 */
let boardBackup = null;

try {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  boardBackup = existsSync(SCOREBOARD_FILE) ? readFileSync(SCOREBOARD_FILE) : null;

  // 本机若跑着成品实例（占 3001/1935/8000），渲染层那套写死 3001 的接口就插不进去 → 跳过
  await skipIfPortsBusy([3001, 1935, 8000, 5173], '节目单 / 名册导入 端到端');

  // ─── 依赖进程 ─────────────────────────────────────────────────────────────
  track(spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, stdio: 'ignore' }), 'server');
  track(spawn(process.execPath, [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
    '--port', '5173', '--strictPort'], { cwd: path.join(ROOT, 'client'), stdio: 'ignore' }), 'vite');
  await getJson(`${API}/api/health`);
  await waitHttp('http://localhost:5173/', 'vite dev server');

  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  assert.ok(existsSync(electronBin), '找不到 electron 可执行文件');
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;   // 否则 electron.exe 退化成纯 node
  const logFd = openSync(path.join(ARTIFACT_DIR, 'electron-program.log'), 'w');
  track(spawn(electronBin, [`--remote-debugging-port=${DEBUG_PORT}`, '.'], {
    cwd: ROOT, stdio: ['ignore', logFd, logFd], env: electronEnv,
  }), 'electron');

  page = await connectControl();
  await waitStable('主控窗口');

  // 清空起始状态，避免上一次运行残留
  await fetch(`${API}/api/scoreboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ program: [], applyFirst: false, mode: 'track', enabled: true, athletes: [] }),
  });
  await sleep(400);

  // ─── 1. 设置 → 节目单 → 粘贴 → 生成 ──────────────────────────────────────
  await ev(`document.querySelector('.settings-btn').click()`);
  await sleep(700);
  const hasProgramSection = await ev(
    `[...document.querySelectorAll('.settings-section-title')].some(e => e.textContent.includes('节目单'))`);
  assert.equal(hasProgramSection, true, '设置里应出现「节目单（一键切项）」分组');

  const typed = await ev(`(${REACT_SET_VALUE})('.roster-import-text, .settings-section textarea', ${JSON.stringify(PROGRAM_TEXT)})`);
  assert.ok(typed > 100, '节目单文本应写入粘贴框');

  await ev(clickByText('.settings-section button', '生成节目单'));
  await sleep(1000);

  let cfg = await board();
  assert.equal(cfg.program.length, 3, `应生成 3 节节目单，实际 ${cfg.program.length}`);
  assert.equal(cfg.programIndex, 0);
  assert.equal(cfg.eventName, '男子100米');
  assert.equal(cfg.heat, '第1组');
  assert.deepEqual(names(cfg), ['张三', '李四']);
  assert.equal(cfg.athletes[2].pb, '11.20', '号码/PB 应随名册就位');
  assert.equal(cfg.athletes[2].unit, '高一2班');
  assert.equal(cfg.program[2].eventKind, 'field', '女子跳远应识别为田赛');

  await page.screenshot(path.join(ARTIFACT_DIR, 'program-settings.png'));

  // 关掉设置弹窗，回到侧栏
  await ev(`document.querySelector('.settings-modal .settings-close').click()`);
  await sleep(500);

  // ─── 2. 侧栏控制条：点「下一项 ▶」 ───────────────────────────────────────
  const bar = await ev(`(() => {
    const box = document.querySelector('.tp-program');
    if (!box) return null;
    return {
      text: box.querySelector('.tp-program-head').textContent,
      buttons: [...box.querySelectorAll('.tp-program-btns button')].map(b => b.textContent.trim()),
    };
  })()`);
  assert.ok(bar, '侧栏「田径直播」应出现节目单控制条');
  assert.match(bar.text, /男子100米/, '控制条显示当前节');
  assert.match(bar.text, /1\/3/, '控制条显示进度');
  assert.deepEqual(bar.buttons, ['◀ 上一项', '下一项 ▶', '全部 ▾']);

  await ev(`(() => {
    [...document.querySelectorAll('.tp-program-btns button')]
      .find(b => b.textContent.includes('下一项')).click();
  })()`);
  await sleep(800);
  cfg = await board();
  assert.equal(cfg.programIndex, 1, '点「下一项」应切到第 2 节');
  assert.equal(cfg.heat, '第2组');
  assert.deepEqual(names(cfg), ['王五', '赵六'], '第 2 节名册就位');
  assert.equal(cfg.clockRunning, false);
  assert.equal(cfg.clockOffsetMs, 0, '换项应顺手清零跑表');
  assert.ok((cfg.athletes || []).every(a => !a.place && !a.result), '换项应清空名次成绩');

  await page.screenshot(path.join(ARTIFACT_DIR, 'program-sidebar.png'));

  // ─── 3. 键盘 PageDown / PageUp ───────────────────────────────────────────
  await ev(`document.body.focus()`);
  await key('PageDown', 'PageDown', 34);
  await sleep(800);
  cfg = await board();
  assert.equal(cfg.programIndex, 2, 'PageDown 应切到第 3 节');
  assert.equal(cfg.eventName, '女子跳远');
  assert.deepEqual(names(cfg), ['王七', '孙八']);

  await key('PageUp', 'PageUp', 33);
  await sleep(800);
  cfg = await board();
  assert.equal(cfg.programIndex, 1, 'PageUp 应退回第 2 节');
  assert.deepEqual(names(cfg), ['王五', '赵六']);

  // ─── 4. 选手介绍模式下切项 ───────────────────────────────────────────────
  // 关掉自动轮播与自动隐藏，单独验证「切项」本身（否则轮播计时会把索引推进）
  await fetch(`${API}/api/scoreboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'intro', introVisible: true, enabled: true, introIndex: 1, introAuto: false, introHold: 0,
    }),
  });
  await sleep(400);
  await key('PageDown', 'PageDown', 34);
  await sleep(800);
  cfg = await board();
  assert.equal(cfg.mode, 'intro', '切项后仍保持在选手介绍模式');
  assert.equal(cfg.introVisible, true, '切项后仍在上屏');
  assert.equal(cfg.introIndex, 0, '切项后回到该节第一位选手');
  assert.deepEqual(names(cfg), ['王七', '孙八']);

  // ─── 5. 现场改过的姓名，切走再切回仍在（快照回写） ────────────────────────
  await fetch(`${API}/api/scoreboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ athletePatch: { i: 0, name: '王七（现场改）' } }),
  });
  await sleep(300);
  await key('PageUp', 'PageUp', 33);
  await sleep(800);
  cfg = await board();
  assert.equal(cfg.programIndex, 1);
  assert.equal(cfg.program[2].athletes[0].name, '王七（现场改）',
    '切走时当前名册应快照回该节，切回来不丢现场改动');

  await key('PageDown', 'PageDown', 34);
  await sleep(800);
  cfg = await board();
  assert.deepEqual(names(cfg), ['王七（现场改）', '孙八'], '切回第 3 节，现场改动保留');

  // 展开全部节目单，直接跳回第 1 节
  await ev(`(() => {
    [...document.querySelectorAll('.tp-program-btns button')]
      .find(b => b.textContent.includes('全部')).click();
  })()`);
  await sleep(500);
  const listed = await ev(`[...document.querySelectorAll('.tp-program .tp-tpl')].map(b => b.textContent.trim())`);
  assert.equal(listed.length, 3, '展开节目单应列出全部 3 节');
  await ev(`document.querySelectorAll('.tp-program .tp-tpl')[0].click()`);
  await sleep(800);
  cfg = await board();
  assert.equal(cfg.programIndex, 0);
  assert.deepEqual(names(cfg), ['张三', '李四']);

  // ─── 6. 设置 → 选手介绍：名册批量导入 ────────────────────────────────────
  await fetch(`${API}/api/scoreboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'intro', athletes: Array.from({ length: 8 }, (_, i) => ({ lane: i + 1, name: '' })) }),
  });
  await ev(`document.querySelector('.settings-btn').click()`);
  await sleep(700);
  await ev(clickByText('.settings-section .settings-pill', '选手介绍'));
  await sleep(700);

  const typedRoster = await ev(`(${REACT_SET_VALUE})('.roster-import .roster-import-text', ${JSON.stringify(ROSTER_TEXT)})`);
  assert.ok(typedRoster > 10, '名册文本应写入粘贴框');
  await sleep(400);
  const preview = await ev(`[...document.querySelectorAll('.roster-import-chip')].map(c => c.textContent.trim())`);
  assert.equal(preview.length, 2, '导入前应有识别预览');
  assert.match(preview[0], /钱九/);

  await ev(clickByText('.roster-import button', '导入'));
  await sleep(1000);
  cfg = await board();
  assert.deepEqual(names(cfg), ['钱九', '周十'], '批量导入应填进 5、6 道');
  assert.equal(cfg.athletes[4].name, '钱九', '道次 5 → 第 5 行');
  assert.equal(cfg.athletes[4].bib, '1099');
  assert.equal(cfg.athletes.length, 8, '不足的道次保留空行');
  await page.screenshot(path.join(ARTIFACT_DIR, 'roster-import.png'));

  console.log('✅ 节目单 / 名册导入 端到端验证通过');
  console.log(`   节目单 3 节 · 换项 6 次 · 名册批量导入 ${names(cfg).length} 人`);
  console.log('   截图：tests\\artifacts\\program-settings.png , program-sidebar.png , roster-import.png');
} finally {
  try { page?.close(); } catch { /* ignore */ }
  shutdown();
  await sleep(600);
  // 服务端已退出，此时还原不会被再次覆盖
  if (boardBackup) {
    writeFileSync(SCOREBOARD_FILE, boardBackup);
    console.log('   已还原 data/scoreboard.json 原状');
  }
}
