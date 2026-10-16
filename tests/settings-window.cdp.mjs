/**
 * 设置独立窗口 · Electron 端到端验证（CDP 驱动，无需 puppeteer）
 *
 * 真机跑一遍完整链路：
 *   1. 起 server(3001) + vite(5173) + electron（带 --remote-debugging-port）
 *   2. 在主控窗口调用 window.electronAPI.openSettingsWindow()（等价于点顶栏「⧉ 独立窗口」）
 *   3. 断言新窗口 URL 带 ?view=settings，且独立设置视图渲染出全部分组
 *   4. 断言主控窗口收到 settings:changed → 顶栏按钮进入 is-on 状态
 *   5. 关闭独立窗口，断言 getSettingsWindowStatus() 回到 { open: false }
 *
 * 运行：node tests/settings-window.cdp.mjs
 * 截图产物：tests/artifacts/*.png
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { skipIfPortsBusy } from './port-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'tests', 'artifacts');
const DEBUG_PORT = 9500 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function track(child, name) {
  children.push({ child, name });
  child.on('exit', (code, signal) => {
    if (code && code !== 0) console.log(`[${name}] exit code=${code} signal=${signal}`);
  });
  return child;
}

function shutdown() {
  for (const { child } of children) {
    try { child.kill(); } catch { /* 进程可能已退出 */ }
  }
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

/** 等到某个 URL 返回 2xx（用于 vite dev server 这种返回 HTML 的服务） */
async function waitHttp(url, label, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error(`等不到 ${label} (${url})`);
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
      const r = await this.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面内异常');
      return r.result?.value;
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

/** 等到出现满足条件的 CDP target（最多 ~30s，失败时打印当前 target 列表） */
async function waitTarget(pred, label, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const hit = list.find((t) => t.type === 'page' && pred(t));
        if (hit) return hit;
      }
    } catch { /* 调试端口还没起来 */ }
    await sleep(500);
  }
  const seen = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`, 2)
    .then((l) => l.map((t) => t.url).join('\n     ')).catch(() => '(调试端口不可用)');
  throw new Error(`等不到 target：${label}\n   当前 target:\n     ${seen}`);
}

let mainWin;
let settingsTarget;

try {
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  // 本机若跑着成品实例（占 3001/1935/8000），这套写死 3001 的接口插不进去 → 跳过
  await skipIfPortsBusy([3001, 1935, 8000, 5173], '设置独立窗口');

  // ─── 起依赖进程 ────────────────────────────────────────────────────────────
  track(spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT, stdio: 'ignore',
  }), 'server');

  track(spawn(process.execPath, [path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
    '--port', '5173', '--strictPort'], { cwd: path.join(ROOT, 'client'), stdio: 'ignore' }), 'vite');

  await getJson('http://localhost:3001/api/health');
  await waitHttp('http://localhost:5173/', 'vite dev server');

  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  assert.ok(existsSync(electronBin), '找不到 electron 可执行文件');
  // 注意：某些终端（如 IDE/Agent 宿主）会带 ELECTRON_RUN_AS_NODE=1，
  // 那样 electron.exe 会退化成纯 node，连 --remote-debugging-port 都不认。
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const electronLog = path.join(ARTIFACT_DIR, 'electron.log');
  const electronFd = openSync(electronLog, 'w');
  track(spawn(electronBin, [`--remote-debugging-port=${DEBUG_PORT}`, '.'], {
    cwd: ROOT, stdio: ['ignore', electronFd, electronFd], env: electronEnv,
  }), 'electron');

  // ─── 主控窗口 ──────────────────────────────────────────────────────────────
  const controlTarget = await waitTarget(
    (t) => t.url.startsWith('http://localhost:5173') && !t.url.includes('view='),
    '主控窗口');
  mainWin = connect(controlTarget.webSocketDebuggerUrl);
  await mainWin.ready;

  // 等 React 挂载完（顶栏按钮出现）
  for (let i = 0; i < 40; i += 1) {
    if (await mainWin.eval(`!!document.querySelector('.settings-popout-btn')`)) break;
    await sleep(250);
  }
  const mainSetup = await mainWin.eval(`({
    hasApi: typeof window.electronAPI?.openSettingsWindow === 'function',
    popoutLabel: document.querySelector('.settings-popout-btn')?.textContent.trim(),
    settingsLabel: document.querySelector('.settings-btn')?.textContent.trim(),
    isOn: document.querySelector('.settings-popout-btn')?.classList.contains('is-on'),
  })`);
  assert.equal(mainSetup.hasApi, true, '主窗口应拿到 openSettingsWindow');
  assert.equal(mainSetup.popoutLabel, '⧉ 独立窗口', '顶栏应有「⧉ 独立窗口」按钮');
  assert.equal(mainSetup.settingsLabel, '⚙️ 设置', '顶栏保留原「⚙️ 设置」弹窗入口');
  await mainWin.screenshot(path.join(ARTIFACT_DIR, 'control-window.png'));

  // ─── 拉出独立设置窗口（走真实 preload → IPC → 新 BrowserWindow） ───────────
  await mainWin.eval(`window.electronAPI.openSettingsWindow()`);

  settingsTarget = await waitTarget((t) => t.url.includes('view=settings'), '独立设置窗口');
  assert.match(settingsTarget.url, /view=settings/, '设置窗口 URL 应带 ?view=settings');

  const settingsWin = connect(settingsTarget.webSocketDebuggerUrl);
  await settingsWin.ready;

  for (let i = 0; i < 40; i += 1) {
    if (await settingsWin.eval(`!!document.querySelector('.settings-window')`)) break;
    await sleep(250);
  }

  const view = await settingsWin.eval(`(() => {
    const body = document.querySelector('.settings-window-body');
    const sections = [...document.querySelectorAll('.settings-section-title')].map(e => e.textContent.trim());
    const modal = document.querySelector('.settings-modal').getBoundingClientRect();
    return {
      isStandalone: !!document.querySelector('.settings-window'),
      hasElectronApi: typeof window.electronAPI?.closeSettingsWindow === 'function',
      sectionCount: sections.length,
      sections,
      title: document.title,
      hint: document.querySelector('.settings-window-hint')?.textContent.trim(),
      columnCount: getComputedStyle(body).columnCount,
      fillsWindow: Math.round(modal.width) === window.innerWidth && Math.round(modal.height) === window.innerHeight,
      overflow: getComputedStyle(body).overflowY,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      groupLefts: [...document.querySelectorAll('.settings-section')].map(e => Math.round(e.getBoundingClientRect().left)),
    };
  })()`);

  assert.equal(view.isStandalone, true, '应渲染 SettingsView 独立视图');
  assert.equal(view.hasElectronApi, true, '设置窗口应能用 electronAPI 关闭自己');
  // 赛事信息条 / 节目单 / 画面配色 / HDMI 输出 / 水印 / 操作日志
  assert.equal(view.sectionCount, 6, `应渲染 6 个设置分组，实际 ${view.sectionCount}`);
  assert.ok(view.sections.some(s => s.includes('节目单')), '设置里应包含「节目单（一键切项）」分组');
  assert.equal(view.fillsWindow, true, '独立窗口里设置面板应铺满窗口');
  assert.match(view.title, /设置/, '窗口标题应含「设置」');
  assert.equal(view.overflow, 'auto', '内容区应可滚动');
  assert.equal(view.noHorizontalOverflow, true, '设置内容不应横向溢出窗口');
  assert.ok(new Set(view.groupLefts).size > 1, '宽窗口下分组应分栏排布');
  await settingsWin.screenshot(path.join(ARTIFACT_DIR, 'settings-window.png'));

  // ─── 主窗口状态同步：顶栏按钮点亮 ─────────────────────────────────────────
  let isOn = false;
  for (let i = 0; i < 20; i += 1) {
    isOn = await mainWin.eval(`document.querySelector('.settings-popout-btn').classList.contains('is-on')`);
    if (isOn) break;
    await sleep(200);
  }
  assert.equal(isOn, true, '独立窗口打开后主窗口按钮应进入 is-on 状态');

  const statusOpen = await mainWin.eval(`window.electronAPI.getSettingsWindowStatus()`);
  assert.equal(statusOpen.open, true, '主进程应报告设置窗口已打开');

  // ─── 独立窗口内点「收回主界面」→ 窗口关闭 + 主窗口弹窗重新打开 ──────────────
  const restoreBtn = await settingsWin.eval(
    `document.querySelector('.settings-popout')?.textContent.trim()`);
  assert.equal(restoreBtn, '⤵ 收回主界面', '独立窗口头部应有「收回主界面」按钮');
  await settingsWin.eval(`window.electronAPI.restoreSettingsWindow()`);

  let modalBack = false;
  for (let i = 0; i < 25; i += 1) {
    modalBack = await mainWin.eval(`!!document.querySelector('.settings-modal')`);
    if (modalBack) break;
    await sleep(200);
  }
  assert.equal(modalBack, true, '收回后主窗口应重新弹出设置弹窗');
  const afterRestore = await mainWin.eval(`window.electronAPI.getSettingsWindowStatus()`);
  assert.equal(afterRestore.open, false, '收回后独立窗口应已关闭');
  await mainWin.screenshot(path.join(ARTIFACT_DIR, 'control-window-modal.png'));
  // 关掉弹窗，继续后面的重复打开/关闭验证
  await mainWin.eval(
    `document.querySelector('.settings-modal .settings-close').click()`);
  await sleep(400);

  // 再拉出一次
  await mainWin.eval(`window.electronAPI.openSettingsWindow()`);
  settingsTarget = await waitTarget((t) => t.url.includes('view=settings'), '独立设置窗口(第二次)');

  // 重复点开只聚焦，不产生第二个窗口
  await mainWin.eval(`window.electronAPI.openSettingsWindow()`);
  await sleep(600);
  const pagesAfterReopen = (await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`))
    .filter((t) => t.type === 'page' && t.url.includes('view=settings')).length;
  assert.equal(pagesAfterReopen, 1, '重复打开应复用同一个设置窗口');

  // ─── 关闭 → 状态回落 ──────────────────────────────────────────────────────
  await mainWin.eval(`window.electronAPI.closeSettingsWindow()`);
  let statusClosed = { open: true };
  for (let i = 0; i < 20; i += 1) {
    statusClosed = await mainWin.eval(`window.electronAPI.getSettingsWindowStatus()`);
    if (!statusClosed.open) break;
    await sleep(200);
  }
  assert.equal(statusClosed.open, false, '关闭后状态应回到 open:false');
  for (let i = 0; i < 20; i += 1) {
    isOn = await mainWin.eval(`document.querySelector('.settings-popout-btn').classList.contains('is-on')`);
    if (!isOn) break;
    await sleep(200);
  }
  assert.equal(isOn, false, '关闭后主窗口按钮应恢复未点亮');

  settingsWin.close();

  console.log('✅ 设置独立窗口验证通过');
  console.log(`   分组：${view.sections.join(' / ')}`);
  console.log(`   列数：${view.columnCount} · 提示：${view.hint}`);
  console.log(`   截图：${path.relative(ROOT, path.join(ARTIFACT_DIR, 'control-window.png'))} , ${path.relative(ROOT, path.join(ARTIFACT_DIR, 'settings-window.png'))}`);
} finally {
  mainWin?.close();
  shutdown();
  await sleep(300);
}
