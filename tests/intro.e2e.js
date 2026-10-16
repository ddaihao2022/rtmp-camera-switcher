'use strict';
/**
 * 端到端冒烟测试：选手介绍模式（名册增量更新 → 上/下一位 → 上屏/隐藏 → 参数收敛）
 * 前置：先启动服务 `npm run server`（或在另一个终端里 node server/index.js）
 * 运行：node tests/intro.e2e.js   （或 npm run test:intro）
 *
 * 脚本会把 data/scoreboard.json 先备份为 data/scoreboard.json.pre-intro-e2e，
 * 测试结束后自动还原；中途崩溃可用备份手动恢复。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE = process.env.INTRO_API || 'http://127.0.0.1:3001';
const CONFIG = path.join(process.cwd(), 'data', 'scoreboard.json');
const BACKUP = path.join(process.cwd(), 'data', 'scoreboard.json.pre-intro-e2e');

let pass = 0;
let failed = 0;
const fails = [];

async function step(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    fails.push(`${name} → ${e.message}`);
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}

async function api(route, { method = 'GET', body } = {}) {
  const r = await fetch(BASE + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

(async function main() {
  console.log(`选手介绍模式端到端测试 → ${BASE}\n`);

  if (fs.existsSync(CONFIG)) {
    fs.copyFileSync(CONFIG, BACKUP);
    console.log(`  · 已备份 ${path.relative(process.cwd(), CONFIG)} → ${path.basename(BACKUP)}\n`);
  }

  let original = null;

  await step('服务在线 /api/health', async () => {
    const r = await api('/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'ok');
  });

  await step('GET /api/scoreboard 带出选手介绍字段', async () => {
    const r = await api('/api/scoreboard');
    assert.strictEqual(r.status, 200);
    original = r.json;
    assert.ok(['card', 'lower', 'roster'].includes(r.json.introStyle), `introStyle=${r.json.introStyle}`);
    assert.strictEqual(typeof r.json.introIndex, 'number');
    assert.strictEqual(typeof r.json.introVisible, 'boolean');
    assert.ok(Array.isArray(r.json.athletes), 'athletes 应为数组');
  });

  const laneCount = (original?.athletes || []).length || 8;
  const probeName = '测试选手A';
  const probe = { name: probeName, unit: '测试单位', bib: '9999', pb: '10.23', note: '冒烟测试用' };

  await step('新增选手照片（athletePatch 增量写）', async () => {
    // 1x1 透明 PNG，仅验证 photo 字段能落库并回传
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+1Z2FAAAAAElFTkSuQmCC';
    const r = await api('/api/scoreboard', { method: 'POST', body: { athletePatch: { i: 0, photo: png } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.athletes[0].photo, png);
  });

  await step('athletePatch 写姓名/单位/号码/PB/亮点，且不影响其他道次', async () => {
    const r = await api('/api/scoreboard', { method: 'POST', body: { athletePatch: { i: 0, ...probe } } });
    assert.strictEqual(r.status, 200);
    const a0 = r.json.athletes[0];
    assert.strictEqual(a0.name, probeName);
    assert.strictEqual(a0.unit, probe.unit);
    assert.strictEqual(a0.bib, probe.bib);
    assert.strictEqual(a0.pb, probe.pb);
    assert.strictEqual(a0.lane, 1);
    assert.ok(a0.photo.startsWith('data:image/png'), '照片应保留');
    if (laneCount > 1) {
      assert.notStrictEqual(r.json.athletes[1].name, probeName, '第二道不应被误写');
    }
  });

  await step('athletePatch 支持按 lane 定位', async () => {
    const r = await api('/api/scoreboard', { method: 'POST', body: { athletePatch: { lane: 1, note: '按道次写入' } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.athletes[0].note, '按道次写入');
  });

  await step('切到选手介绍模式并上屏', async () => {
    const r = await api('/api/scoreboard', {
      method: 'POST',
      body: { mode: 'intro', enabled: true, introVisible: true, introStyle: 'card', introTitle: '选手介绍' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.mode, 'intro');
    assert.strictEqual(r.json.introVisible, true);
    const i = await api('/api/intro');
    assert.strictEqual(i.json.mode, 'intro');
    assert.strictEqual(i.json.visible, true);
    assert.ok(i.json.total >= 1, '名册至少 1 人');
    assert.strictEqual(i.json.current.name, probeName);
  });

  await step('POST /api/intro 下一位 / 上一位（循环）', async () => {
    const before = (await api('/api/intro')).json.index;
    let r = await api('/api/intro', { method: 'POST', body: { action: 'next' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.index, (before + 1) % r.json.total);
    r = await api('/api/intro', { method: 'POST', body: { action: 'prev' } });
    assert.strictEqual(r.json.index, before);
  });

  await step('空道次自动跳过（名册口径 = 有姓名或照片）', async () => {
    await api('/api/scoreboard', { method: 'POST', body: { athletePatch: { i: 2, name: '测试选手C', unit: '测试单位' } } });
    const info = (await api('/api/intro')).json;
    assert.strictEqual(info.total, 2, `只有 2 位已录入选手参与轮播（实际 ${info.total}）`);
    let r = await api('/api/intro', { method: 'POST', body: { action: 'next' } });
    assert.strictEqual(r.json.index, 1);
    r = await api('/api/intro', { method: 'POST', body: { action: 'next' } });
    assert.strictEqual(r.json.index, 0, '第 2 位之后回到第 1 位');
    await api('/api/scoreboard', { method: 'POST', body: { athletePatch: { i: 2, name: '', unit: '' } } });
  });

  await step('POST /api/intro 定位 index=0 与隐藏上屏', async () => {
    let r = await api('/api/intro', { method: 'POST', body: { action: 'goto', index: 0 } });
    assert.strictEqual(r.json.index, 0);
    r = await api('/api/intro', { method: 'POST', body: { action: 'hide' } });
    assert.strictEqual(r.json.visible, false);
    r = await api('/api/scoreboard', { method: 'POST', body: { introAction: 'show' } });
    assert.strictEqual(r.json.introVisible, true);
    assert.strictEqual(r.json.mode, 'intro');
  });

  await step('样式与参数收敛（每屏 1–8、间隔 ≥2s、自动隐藏 0–600s）', async () => {
    let r = await api('/api/scoreboard', {
      method: 'POST',
      body: { introStyle: 'roster', introPerScreen: 99, introAutoMs: 1, introHold: -5 },
    });
    assert.strictEqual(r.json.introPerScreen, 8);
    assert.strictEqual(r.json.introAutoMs, 2000);
    assert.strictEqual(r.json.introHold, 0);
    r = await api('/api/scoreboard', { method: 'POST', body: { introStyle: 'lower', introHold: 10, introPerScreen: 3 } });
    assert.strictEqual(r.json.introStyle, 'lower');
    assert.strictEqual(r.json.introHold, 10);
  });

  await step('田径模式切换后仍保留选手介绍配置', async () => {
    await api('/api/scoreboard', { method: 'POST', body: { mode: 'track' } });
    const r = await api('/api/scoreboard');
    assert.strictEqual(r.json.mode, 'track');
    assert.strictEqual(r.json.introHold, 10);
    assert.strictEqual(r.json.athletes[0].name, probeName);
  });

  await step('自动轮播：服务端按间隔推进（HDMI / 监看同一份状态）', async () => {
    await api('/api/scoreboard', {
      method: 'POST',
      body: { mode: 'intro', enabled: true, introVisible: true, introAuto: true, introAutoMs: 2000, introHold: 0, introIndex: 0 },
    });
    await new Promise(r => setTimeout(r, 1500));
    const a = (await api('/api/intro')).json;
    await new Promise(r => setTimeout(r, 2600));
    const b = (await api('/api/intro')).json;
    assert.ok(b.index !== a.index || b.total < 2, `轮播应推进（${a.index} → ${b.index}, total ${b.total}）`);
    const off = await api('/api/scoreboard', { method: 'POST', body: { introAuto: false } });
    assert.strictEqual(off.json.introAuto, false);
  });

  await step('自动隐藏：超过设定秒数后自动下屏', async () => {
    await api('/api/scoreboard', { method: 'POST', body: { mode: 'intro', enabled: true, introHold: 3 } });
    await api('/api/scoreboard', { method: 'POST', body: { introAction: 'show' } });
    assert.strictEqual((await api('/api/intro')).json.visible, true);
    await new Promise(r => setTimeout(r, 3600));
    assert.strictEqual((await api('/api/intro')).json.visible, false);
  });

  // ── 还原现场配置 ────────────────────────────────────────────────
  if (fs.existsSync(BACKUP)) {
    await step('还原 data/scoreboard.json', async () => {
      const saved = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
      await api('/api/scoreboard', { method: 'POST', body: { ...saved, clockAction: 'reset' } });
      fs.unlinkSync(BACKUP);
      const now = await api('/api/scoreboard');
      assert.strictEqual(now.json.mode, saved.mode || 'track');
      assert.strictEqual(now.json.introHold, saved.introHold ?? 0);
    });
  }

  console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
  if (failed) {
    console.log(fails.map(f => `  - ${f}`).join('\n'));
    process.exitCode = 1;
  }
})();
