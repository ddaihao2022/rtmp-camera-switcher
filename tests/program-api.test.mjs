/**
 * 节目单 API · 服务端语义测试（不起 Electron，秒级）
 *
 * 覆盖「一键切项」的服务端契约：
 *   载入 → next / prev / apply / goto → 项目字段与名册同步就位（名次成绩清空、跑表归零）
 *   切换前把当前道次名册快照回该节（现场补录的照片/改名不丢）
 *   整表替换时不快照（旧节目单已换掉，避免污染新载入的那一节）
 *   空节目单时 next/prev 不炸；programIndex 始终被夹在合法范围内
 *
 * 运行：node tests/program-api.test.mjs
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOREBOARD_FILE = path.join(ROOT, 'data', 'scoreboard.json');
const PORT = 3200 + Math.floor(Math.random() * 300);
const RTMP_PORT = 13300 + Math.floor(Math.random() * 300);
const FLV_PORT = 8300 + Math.floor(Math.random() * 300);
const API = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROGRAM = [
  {
    id: 'p1', time: '10:30', label: '10:30 男子100米 预赛 第1组',
    eventName: '男子100米', category: '男子', round: '预赛', heat: '第1组', eventKind: 'sprint',
    athletes: [
      { lane: 1, name: '', unit: '' },
      { lane: 2, name: '', unit: '' },
      { lane: 3, name: '张三', unit: '高一2班', bib: '1023', pb: '11.20' },
      { lane: 4, name: '李四', unit: '高一3班', bib: '1024', pb: '11.35' },
    ],
  },
  {
    id: 'p2', time: '10:36', label: '10:36 男子100米 预赛 第2组',
    eventName: '男子100米', category: '男子', round: '预赛', heat: '第2组', eventKind: 'sprint',
    athletes: [
      { lane: 3, name: '王五', unit: '高二1班', bib: '1088', pb: '10.98' },
      { lane: 4, name: '赵六', unit: '高二2班', bib: '1089', pb: '11.45' },
    ],
  },
  {
    id: 'p3', time: '10:50', label: '10:50 女子跳远 决赛',
    eventName: '女子跳远', category: '女子', round: '决赛', heat: '', eventKind: 'field',
    athletes: [
      { lane: 1, name: '王七', unit: '高三1班' },
      { lane: 2, name: '孙八', unit: '高三2班' },
    ],
  },
];

const post = async (patch) => {
  const r = await fetch(`${API}/api/scoreboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  assert.ok(r.ok, `POST 失败 ${r.status}`);
  return r.json();
};
const get = async () => (await fetch(`${API}/api/scoreboard`)).json();
const names = (cfg) => (cfg.athletes || []).filter(a => a.name).map(a => a.name);
const entryNames = (cfg, i) => (cfg.program[i].athletes || []).filter(a => a.name).map(a => a.name);

const backup = existsSync(SCOREBOARD_FILE) ? readFileSync(SCOREBOARD_FILE) : null;
let child = null;
let pass = 0;
function ok(name, fn) {
  fn();
  pass += 1;
  console.log(`  ✓ ${name}`);
}

try {
  // 三端口都换掉：本机可能装着自己那份成品在跑（占着 3001/1935/8000）
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

  console.log('节目单 API');

  let cfg = await post({ program: PROGRAM, programIndex: 0, applyFirst: true, mode: 'track', enabled: true, wind: 'x' });

  await ok('载入节目单：落到第 1 节，项目/轮次/组次就位', () => {
    assert.equal(cfg.program.length, 3);
    assert.equal(cfg.programIndex, 0);
    assert.equal(cfg.eventName, '男子100米');
    assert.equal(cfg.round, '预赛');
    assert.equal(cfg.heat, '第1组');
    assert.equal(cfg.eventKind, 'sprint');
    assert.equal(cfg.wind, '', '换项清空风速');
    assert.deepEqual(names(cfg), ['张三', '李四']);
    assert.equal(cfg.athletes[2].pb, '11.20');
    assert.equal(cfg.athletes[2].unit, '高一2班');
    assert.equal(cfg.program[0].count, 2, '节目单节人数按有姓名的道次计');
  });

  await ok('名册落位保留空道次（道次=行号）', () => {
    assert.equal(cfg.athletes.length, 4);
    assert.equal(cfg.athletes[0].name, '');
    assert.equal(cfg.athletes[0].lane, 1);
    assert.equal(cfg.athletes[3].lane, 4);
  });

  cfg = await post({ programAction: 'apply', programIndex: 1 });
  await ok('节目单只写道次 3/4 时服务端补齐空道（手机直接 POST 也不串道）', () => {
    assert.deepEqual(names(cfg), ['王五', '赵六']);
    assert.equal(cfg.athletes.length, 4);
    assert.equal(cfg.athletes[2].name, '王五');
    assert.equal(cfg.athletes[2].lane, 3);
  });

  // 回到第 1 节，后面按「现场切项」的流程继续
  cfg = await post({ programAction: 'apply', programIndex: 0 });
  await ok('回到第 1 节：现场改动已快照回上一节', () => {
    assert.equal(cfg.programIndex, 0);
    assert.deepEqual(names(cfg), ['张三', '李四']);
    assert.deepEqual(entryNames(cfg, 1), ['王五', '赵六']);
  });

  // 现场改一格 + 给出名次成绩，然后切下一项
  await post({ athletePatch: { i: 3, name: '李四（现场改）', photo: 'data:image/png;base64,AAA' } });
  await post({ finishOrder: [4, 3] });
  cfg = await post({ programAction: 'next' });

  await ok('下一项：项目/名册一次到位，名次成绩清空、跑表归零', () => {
    assert.equal(cfg.programIndex, 1);
    assert.equal(cfg.heat, '第2组');
    assert.deepEqual(names(cfg), ['王五', '赵六']);
    assert.ok(cfg.athletes.every(a => !a.place && !a.result), '新一节不应带旧名次');
    assert.equal(cfg.clockRunning, false);
    assert.equal(cfg.clockOffsetMs, 0);
  });

  await ok('切走时把现场改动快照回上一节（改名 + 照片）', () => {
    assert.deepEqual(entryNames(cfg, 0), ['张三', '李四（现场改）']);
    assert.equal(cfg.program[0].athletes[3].photo, 'data:image/png;base64,AAA');
  });

  cfg = await post({ programAction: 'next' });

  await ok('再按下一项到末节：田赛字段正确', () => {
    assert.equal(cfg.programIndex, 2);
    assert.equal(cfg.eventName, '女子跳远');
    assert.equal(cfg.eventKind, 'field');
    assert.deepEqual(names(cfg), ['王七', '孙八']);
    assert.deepEqual(entryNames(cfg, 1), ['王五', '赵六']);
  });

  cfg = await post({ programAction: 'next' });
  await ok('末节 next 停在末节，不绕回第 1 节（避免现场静默清跑表）', () => {
    assert.equal(cfg.programIndex, 2);
    assert.equal(cfg.eventName, '女子跳远');
    assert.deepEqual(names(cfg), ['王七', '孙八']);
    assert.deepEqual(entryNames(cfg, 2), ['王七', '孙八']);
  });

  cfg = await post({ programAction: 'prev' });
  await ok('prev 从末节回到第 2 节', () => {
    assert.equal(cfg.programIndex, 1);
    assert.deepEqual(names(cfg), ['王五', '赵六']);
  });

  cfg = await post({ programAction: 'apply', programIndex: 1 });
  await ok('apply 直接跳到指定节', () => {
    assert.equal(cfg.programIndex, 1);
    assert.equal(cfg.heat, '第2组');
    assert.deepEqual(names(cfg), ['王五', '赵六']);
  });

  cfg = await post({ programAction: 'apply', programIndex: 99 });
  await ok('越界索引被夹到合法范围', () => {
    assert.equal(cfg.programIndex, 2);
  });

  cfg = await post({ programAction: 'next' });
  await ok('team 模式切项自动回到田径板', () => {
    assert.equal(cfg.mode, 'track');
  });

  // 选手介绍模式切项：名册换人、索引归零、仍在上屏
  await post({ mode: 'intro', introVisible: true, enabled: true, introIndex: 1 });
  cfg = await post({ programAction: 'apply', programIndex: 0 });
  await ok('选手介绍模式下切项：仍在上屏、索引归零', () => {
    assert.equal(cfg.mode, 'intro');
    assert.equal(cfg.introVisible, true);
    assert.equal(cfg.introIndex, 0);
    assert.deepEqual(names(cfg), ['张三', '李四（现场改）']);
  });

  cfg = await post({ programAction: 'prev' });
  await ok('首节 prev 停在首节，不绕回末节', () => {
    assert.equal(cfg.programIndex, 0);
    assert.deepEqual(names(cfg), ['张三', '李四（现场改）']);
  });

  // 整表替换：不把当前比赛信息污染进新载入的第 1 节
  await post({ programAction: 'apply', programIndex: 2 });
  cfg = await post({ program: [PROGRAM[0]], programIndex: 0, applyFirst: true });
  await ok('整表替换不做快照，新节目单第 1 节保持原样', () => {
    assert.equal(cfg.program.length, 1);
    assert.equal(cfg.programIndex, 0);
    assert.equal(cfg.eventName, '男子100米');
    assert.equal(cfg.heat, '第1组');
    assert.deepEqual(entryNames(cfg, 0), ['张三', '李四'], '不应被当前比赛（女子跳远）污染');
  });

  // 只载入、不切项：当前叠加层仍是旧项目，第一次「应用」不能把旧项目快照进第 1 节
  cfg = await post({ program: PROGRAM, programIndex: 2, applyFirst: true });
  assert.equal(cfg.eventName, '女子跳远');
  cfg = await post({ program: [PROGRAM[0], PROGRAM[2]], programIndex: 0, applyFirst: false });
  cfg = await post({ programAction: 'apply', programIndex: 0 });
  await ok('只载入不应用时，第一次应用不会污染第 1 节', () => {
    assert.equal(cfg.eventName, '男子100米');
    assert.equal(cfg.program[0].eventName, '男子100米');
    assert.equal(cfg.program[0].heat, '第1组');
    assert.deepEqual(entryNames(cfg, 0), ['张三', '李四']);
  });

  // 清空节目单：当前名册保留
  const before = names(cfg);
  cfg = await post({ program: [], applyFirst: false });
  await ok('清空节目单：program 置空，当前名册与项目不动', () => {
    assert.equal(cfg.program.length, 0);
    assert.equal(cfg.programIndex, 0);
    assert.deepEqual(names(cfg), before);
    assert.equal(cfg.eventName, '男子100米');
  });

  cfg = await post({ programAction: 'next' });
  await ok('空节目单时 next/prev 安全无操作', () => {
    assert.equal(cfg.program.length, 0);
    assert.equal(cfg.eventName, '男子100米');
    assert.deepEqual(names(cfg), before);
  });

  cfg = await post({ programAction: 'prev' });
  await ok('空节目单时 prev 同样安全', () => {
    assert.equal(cfg.program.length, 0);
    assert.equal(cfg.programIndex, 0);
  });

  // 落盘：重启后节目单还在
  assert.ok(existsSync(SCOREBOARD_FILE), '应落盘 data/scoreboard.json');
  const saved = JSON.parse(readFileSync(SCOREBOARD_FILE, 'utf8'));
  await ok('节目单随 scoreboard 落盘（重启不丢）', () => {
    assert.equal(saved.program.length, 0);
    assert.equal(saved.programIndex, 0);
    assert.ok(Array.isArray(saved.athletes));
  });

  console.log(`\n✅ 节目单 API ${pass} 项全部通过`);
} finally {
  try { child?.kill(); } catch { /* 已退出 */ }
  await sleep(600);
  if (backup) writeFileSync(SCOREBOARD_FILE, backup);
}
