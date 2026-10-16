/**
 * 打包产物冒烟验证 —— 「装出来的这个包到底有没有新功能」
 *
 * 直接运行 dist_electron/win-unpacked 里的成品 exe（不是源码）：
 *   1. 主进程起得来，渲染层加载的是 client/dist 成品前端（file:// + 打包后的 assets/index-*.js）
 *   2. 前端含全部分组：赛事信息条 / 节目单 / 基础调色 / HDMI / 水印 / 调试日志
 *   3. 包内服务端支持节目单 API：载入节目单 → 一键切项 → 名册按道次就位
 *
 * 两种模式（自动判断，安全优先）：
 *   完整模式：3001/1935/8000 空闲 → 用默认端口起包，UI + API 全量验证
 *   只读模式：默认端口被别的实例占用 → 用备用端口起包，只验证 UI 与只读接口，
 *             绝不去动 3001 上那台正在服务的实例（也不会往它写任何状态）
 *
 * 运行：node tests/package-smoke.mjs              （默认查 dist_electron/win-unpacked）
 *       node tests/package-smoke.mjs <exe路径>    （指定别的产物目录）
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'dist_electron', 'win-unpacked', 'RTMP Camera Switcher.exe');
const APP_DIR = path.dirname(EXE);
const DATA_DIR = path.join(APP_DIR, 'data');
const DEFAULT_PORTS = { api: 3001, rtmp: 1935, flv: 8000 };
const ALT_PORTS = { api: 3210, rtmp: 19351, flv: 8010 };
const DEBUG_PORT = 9700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

assert.ok(existsSync(EXE), `找不到打包产物：${EXE}`);

const PROGRAM = [{
  eventName: '男子跳远', category: '男子', round: '决赛', heat: '第1组', eventKind: 'field',
  athletes: [{ lane: 2, name: '打包冒烟选手', unit: '测试队', bib: '9001', pb: '6.80' }],
}, {
  eventName: '女子800米', category: '女子', round: '预赛', heat: '第2组', eventKind: 'middle',
  athletes: [{ lane: 3, name: '第二位选手', unit: '测试队' }],
}];

function portBusy(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port });
    probe.setTimeout(600);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('timeout', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => resolve(false));
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  const pending = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
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
      const mid = id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    async eval(expression) {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面内异常');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function waitTarget(pred, tries = 90) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (res.ok) {
        const hit = (await res.json()).find(t => t.type === 'page' && pred(t));
        if (hit) return hit;
      }
    } catch { /* 端口未就绪 */ }
    await sleep(500);
  }
  throw new Error('等不到渲染层 target（成品 exe 可能没起来，检查是否端口冲突）');
}

async function waitApi(base, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch { /* 还在起 */ }
    await sleep(500);
  }
  throw new Error('包内服务端未就绪');
}

const dataExistedBefore = existsSync(DATA_DIR);
let child = null;
let page = null;
let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

try {
  // ─── 选端口 / 定模式 ──────────────────────────────────────────────────────
  const [apiBusy, rtmpBusy, flvBusy] = await Promise.all([
    portBusy(DEFAULT_PORTS.api), portBusy(DEFAULT_PORTS.rtmp), portBusy(DEFAULT_PORTS.flv),
  ]);
  const fullMode = !apiBusy && !rtmpBusy && !flvBusy;
  const ports = fullMode ? DEFAULT_PORTS : ALT_PORTS;
  const apiBase = `http://localhost:${ports.api}`;

  if (!fullMode) {
    console.log('⚠ 默认端口已被占用（本机有另一个实例在跑）：'
      + `api=${apiBusy ? '忙' : '空'} rtmp=${rtmpBusy ? '忙' : '空'} flv=${flvBusy ? '忙' : '空'}`);
    console.log(`  → 改用备用端口 ${ports.api}/${ports.rtmp}/${ports.flv} 做只读验证，不去动正在运行的实例`);
  }
  console.log(`打包产物：${EXE}`);
  console.log(`模式：${fullMode ? '完整（UI + API）' : '只读（仅 UI + 只读接口）'}`);

  const appEnv = {
    ...process.env,
    PORT: String(ports.api),
    RTMP_PORT: String(ports.rtmp),
    FLV_PORT: String(ports.flv),
  };
  delete appEnv.ELECTRON_RUN_AS_NODE;   // 带着它成品 exe 会退化成纯 node 并立刻退出

  child = spawn(EXE, [`--remote-debugging-port=${DEBUG_PORT}`], { cwd: APP_DIR, stdio: 'ignore', env: appEnv });
  assert.ok(child.pid, '成品 exe 起不来');

  const target = await waitTarget(t => t.url.startsWith('file://') && !t.url.includes('view='));
  ok('主进程启动并加载成品前端（file://）', () => {
    assert.match(target.url, /client\/dist\/index\.html|app\.asar/i, `实际载入：${target.url}`);
  });

  page = connect(target.webSocketDebuggerUrl);
  await page.ready;
  await sleep(2000);

  const shell = await page.eval(`({
    scripts: [...document.scripts].map(s => s.src).filter(Boolean),
    hasElectronApi: typeof window.electronAPI?.openSettingsWindow === 'function',
    title: document.title,
  })`);
  ok('渲染层用的是打包后的 assets 产物（不是 vite dev server）', () => {
    assert.ok(shell.scripts.some(s => /assets\/index-[\w-]+\.js$/.test(s)), `脚本：${shell.scripts.join(', ')}`);
    assert.equal(shell.scripts.some(s => s.includes('5173')), false, '不应连 dev server');
    assert.equal(shell.hasElectronApi, true, '预加载脚本应注入 electronAPI');
  });

  await page.eval(`document.querySelector('.settings-btn').click()`);
  await sleep(1000);
  const view = await page.eval(`[...document.querySelectorAll('.settings-section-title')].map(e => e.textContent.trim())`);
  ok('设置面板六个分组齐全，含节目单', () => {
    assert.equal(view.length, 6, `实际 ${view.length} 组：${view.join(' / ')}`);
    for (const key of ['赛事信息条', '节目单', '基础调色', 'HDMI', '水印', '调试日志']) {
      assert.ok(view.some(s => s.includes(key)), `缺少分组：${key}`);
    }
  });
  await page.eval(`document.querySelector('.settings-modal .settings-close').click()`);
  await sleep(400);

  await waitApi(apiBase);
  const readBack = await (await fetch(`${apiBase}/api/scoreboard`)).json();
  ok('包内服务端可用，且已带节目单字段', () => {
    assert.ok(Array.isArray(readBack.program), `GET /api/scoreboard 应返回 program 数组，实际 ${typeof readBack.program}`);
    assert.equal(typeof readBack.programIndex, 'number');
  });

  if (!fullMode) {
    console.log('\n⚠ 只读模式：跳过写状态与界面联动断言（避免影响正在运行的实例）');
    console.log(`   如需完整验证：先退出正在运行的 RTMP Camera Switcher，再跑一次本脚本。`);
    await page.eval(`new Promise(r => setTimeout(r, 200))`);
    console.log(`\n✅ 打包产物冒烟通过（只读模式，${pass} 项）`);
  } else {
    const post = async (patch) => {
      const r = await fetch(`${apiBase}/api/scoreboard`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      assert.ok(r.ok, `POST 失败 ${r.status}`);
      return r.json();
    };
    const names = (cfg) => (cfg.athletes || []).filter(a => a.name).map(a => a.name);

    let cfg = await post({ program: PROGRAM, programIndex: 0, applyFirst: true, mode: 'track', enabled: true });
    ok('包内服务端支持节目单：载入后落到第 1 节', () => {
      assert.equal(cfg.program.length, 2, `实际 ${cfg.program.length} 节`);
      assert.equal(cfg.programIndex, 0);
      assert.equal(cfg.eventName, '男子跳远');
      assert.equal(cfg.eventKind, 'field');
      assert.equal(cfg.heat, '第1组');
      assert.deepEqual(names(cfg), ['打包冒烟选手']);
      assert.equal(cfg.athletes.length, 2, '道次 2 的选手应落在第 2 行，第 1 行留空');
      assert.equal(cfg.athletes[0].name, '');
      assert.equal(cfg.athletes[1].lane, 2);
      assert.equal(cfg.athletes[1].pb, '6.80');
      assert.equal(cfg.athletes[1].unit, '测试队');
    });

    await post({ finishOrder: [2] });
    cfg = await post({ programAction: 'next' });
    ok('一键切项：项目/轮次/组次/名册就位，名次清空', () => {
      assert.equal(cfg.programIndex, 1);
      assert.equal(cfg.eventName, '女子800米');
      assert.equal(cfg.eventKind, 'middle');
      assert.equal(cfg.heat, '第2组');
      assert.deepEqual(names(cfg), ['第二位选手']);
      assert.equal(cfg.athletes[2].lane, 3, '只写道次 3 时服务端补齐空道');
      assert.ok(cfg.athletes.every(a => !a.place && !a.result), '换项应清空名次成绩');
    });

    await sleep(600);
    const bar = await page.eval(`(() => {
      const box = document.querySelector('.tp-program');
      return box ? { text: box.querySelector('.tp-program-head').textContent,
        buttons: [...box.querySelectorAll('.tp-program-btns button')].map(b => b.textContent.trim()) } : null;
    })()`);
    ok('界面出现「节目单」控制条（◀ 上一项 / 下一项 ▶ / 全部 ▾）', () => {
      assert.ok(bar, '成品界面应出现节目单控制条');
      assert.match(bar.text, /女子800米/);
      assert.match(bar.text, /2\/2/);
      assert.deepEqual(bar.buttons, ['◀ 上一项', '下一项 ▶', '全部 ▾']);
    });

    cfg = await post({ programAction: 'prev' });
    ok('上一项：现场改动快照回该节后仍能取回', () => {
      assert.equal(cfg.programIndex, 0);
      assert.deepEqual(names(cfg), ['打包冒烟选手']);
      assert.equal(cfg.program[0].count, 1);
    });

    console.log(`\n✅ 打包产物冒烟通过（完整模式，${pass} 项）`);
  }
} finally {
  try { page?.close(); } catch { /* ignore */ }
  if (child?.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(1800);
  if (!dataExistedBefore && existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
}
