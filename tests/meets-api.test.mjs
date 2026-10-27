/**
 * 赛事预设 API · 秩序册赛程一键载入
 *
 * 运行：node tests/meets-api.test.mjs
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOREBOARD_FILE = path.join(ROOT, 'data', 'scoreboard.json');
const PORT = 3400 + Math.floor(Math.random() * 200);
const RTMP_PORT = 13400 + Math.floor(Math.random() * 200);
const FLV_PORT = 8400 + Math.floor(Math.random() * 200);
const API = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const backup = existsSync(SCOREBOARD_FILE) ? readFileSync(SCOREBOARD_FILE) : null;
let child = null;
let pass = 0;
function ok(name, fn) {
  fn();
  pass += 1;
  console.log(`  ✓ ${name}`);
}

try {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(PORT),
      RTMP_PORT: String(RTMP_PORT),
      FLV_PORT: String(FLV_PORT),
    },
  });

  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try { up = (await fetch(`${API}/api/health`)).ok; } catch { await sleep(150); }
  }
  assert.ok(up, '服务端未启动');

  console.log('赛事预设 API');

  const listRes = await fetch(`${API}/api/meets`);
  const list = await listRes.json();
  await ok('列表返回本届赛程与统计', () => {
    assert.ok(Array.isArray(list));
    const meet = list.find(m => m.id === '2026-yuhua');
    assert.ok(meet, '应包含 2026-yuhua');
    assert.equal(meet.sessions.length, 4);
    assert.ok(meet.stats.programEntries > 200, '节目单应超过旧上限 200');
  });

  const meetRes = await fetch(`${API}/api/meets/2026-yuhua`);
  const meet = await meetRes.json();
  await ok('详情包含节目单文件名与秩序册说明', () => {
    assert.equal(meet.id, '2026-yuhua');
    assert.equal(meet.programFile, '2026-yuhua-program.json');
    assert.ok(Array.isArray(meet.notes) && meet.notes.length > 0);
    assert.ok(Array.isArray(meet.events) && meet.events.length > 100);
  });

  const progRes = await fetch(`${API}/api/meets/2026-yuhua/program`);
  const prog = await progRes.json();
  await ok('节目单接口返回完整 239 节并保留大赛道数', () => {
    assert.equal(prog.program.length, 239);
    assert.equal(prog.program[0].eventName, '小四、五女子100米');
    assert.equal(prog.program[0].athletes.length, 5, '空道次应被补齐');
    const big = prog.program.find(e => e.athletes.length >= 40);
    assert.ok(big, '应保留 40 人以上的田赛名册');
  });

  const missing = await fetch(`${API}/api/meets/not-exist/program`);
  await ok('不存在的赛程返回 404', () => {
    assert.equal(missing.status, 404);
  });

  console.log(`\n✅ 赛事预设 API ${pass} 项全部通过`);
} finally {
  try { child?.kill(); } catch { /* 已退出 */ }
  await sleep(600);
  if (backup) writeFileSync(SCOREBOARD_FILE, backup);
}
