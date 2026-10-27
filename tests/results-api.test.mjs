/**
 * 成绩公示 API · 服务端语义测试（不起 Electron，秒级）
 *
 * 覆盖：
 *   当前项目已出成绩 → /api/results 的 current / entries 字段
 *   切到下一项 → 上一项成绩自动归档，当前项目不再带旧名次
 *   按名次排序、只返回获奖所需字段（不泄漏照片等现场资料）
 *   公示页静态入口 /results/ 能随服务端一起发布
 *
 * 运行：node tests/results-api.test.mjs
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOREBOARD_FILE = path.join(ROOT, 'data', 'scoreboard.json');
const PORT = 3500 + Math.floor(Math.random() * 200);
const RTMP_PORT = 13500 + Math.floor(Math.random() * 200);
const FLV_PORT = 8500 + Math.floor(Math.random() * 200);
const API = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROGRAM = [
  {
    id: 'p1', time: '10:30', label: '10:30 男子100米 决赛', sessionLabel: '10月28日 上午',
    eventName: '男子100米', category: '男子', round: '决赛', heat: '', eventKind: 'sprint',
    athletes: [
      { lane: 3, name: '张三', unit: '高一2班', bib: '1023', pb: '11.20', photo: 'data:image/png;base64,AAAA' },
      { lane: 4, name: '李四', unit: '高一3班', bib: '1024' },
      { lane: 5, name: '王五', unit: '高二1班', bib: '1088' },
    ],
  },
  {
    id: 'p2', time: '10:50', label: '10:50 女子跳远 决赛', sessionLabel: '10月28日 上午',
    eventName: '女子跳远', category: '女子', round: '决赛', heat: '', eventKind: 'field',
    athletes: [
      { lane: 1, name: '王七', unit: '高三1班', bib: '2001' },
      { lane: 2, name: '孙八', unit: '高三2班', bib: '2002' },
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
const results = async (query = '') => {
  const r = await fetch(`${API}/api/results${query}`);
  assert.ok(r.ok, `GET /api/results 失败 ${r.status}`);
  return r.json();
};

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

  console.log('成绩公示 API');

  // 第 1 节：录入三名选手的名次和成绩
  await post({ program: PROGRAM, programIndex: 0, applyFirst: true, mode: 'track', enabled: true });
  await post({
    athletes: [
      { lane: 3, name: '张三', unit: '高一2班', bib: '1023', pb: '11.20', place: '2', result: '11.35', photo: 'data:image/png;base64,AAAA' },
      { lane: 4, name: '李四', unit: '高一3班', bib: '1024', place: '1', result: '11.20' },
      { lane: 5, name: '王五', unit: '高二1班', bib: '1088', place: '3', result: '11.48' },
      { lane: 6, name: '', unit: '', place: '', result: '' },
    ],
  });

  let data = await results();
  await ok('当前项目成绩进入 current，并按名次从 1 到 3 排序', () => {
    assert.equal(data.ok, true);
    assert.equal(data.current.index, 0);
    assert.equal(data.current.eventName, '男子100米');
    assert.equal(data.current.live, true);
    assert.equal(data.current.resultCount, 3);
    assert.deepEqual(data.current.athletes.map(a => a.place), ['1', '2', '3']);
    assert.deepEqual(data.current.athletes.map(a => a.name), ['李四', '张三', '王五']);
    assert.equal(data.current.athletes[0].result, '11.20');
  });

  await ok('entries 包含当前节成绩，未出成绩的下一节不出现', () => {
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].index, 0);
    assert.equal(data.entries[0].live, true);
    assert.equal(data.entries[0].resultCount, 3);
    assert.ok(data.entries.every(e => e.index !== 1));
  });

  await ok('公示数据不含照片 / 备注等大字段', () => {
    const a = data.current.athletes[0];
    assert.equal(a.photo, undefined);
    assert.equal(a.note, undefined);
  });

  await ok('附带赛程信息（校名 / 日期 / 场次）', () => {
    assert.equal(data.meet.id, '2026-yuhua');
    assert.equal(data.meet.school, '焦作市宇华实验学校');
    assert.ok(Array.isArray(data.meet.sessions) && data.meet.sessions.length === 4);
    assert.ok(data.title.includes('运动会'));
  });

  // 切到下一节：上一节成绩应归档，当前节清空
  await post({ programAction: 'next' });
  data = await results();
  await ok('切项后上一节成绩归档，当前节回到未出成绩状态', () => {
    assert.equal(data.current.index, 1);
    assert.equal(data.current.eventName, '女子跳远');
    assert.equal(data.current.resultCount, 0);
    assert.equal(data.current.athletes.length, 0);
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0].index, 0);
    assert.equal(data.entries[0].live, false);
    assert.deepEqual(data.entries[0].athletes.map(a => a.name), ['李四', '张三', '王五']);
  });

  // 第 2 节录入两人成绩
  await post({
    athletes: [
      { lane: 1, name: '王七', unit: '高三1班', bib: '2001', place: '2', result: '4.85m' },
      { lane: 2, name: '孙八', unit: '高三2班', bib: '2002', place: '1', result: '5.02m' },
    ],
  });
  data = await results();
  await ok('两节都有成绩时，entries 按赛程顺序返回、current 指向当前节', () => {
    assert.equal(data.current.index, 1);
    assert.equal(data.current.resultCount, 2);
    assert.deepEqual(data.current.athletes.map(a => a.place), ['1', '2']);
    assert.deepEqual(data.entries.map(e => e.index), [0, 1]);
    assert.equal(data.entries[1].live, true);
    assert.equal(data.entries[0].live, false);
  });

  // ── 全屏成绩：手动上屏 / 自动收起 / 切项自动上屏 ──────────────
  let shown = await post({ resultsAction: 'show' });
  await ok('手动「成绩全屏」把当前项目快照盖上输出画面', () => {
    assert.equal(shown.fullResultsVisible, true);
    assert.equal(shown.fullResultsSnapshot.eventName, '女子跳远');
    assert.equal(shown.fullResultsSnapshot.resultCount, 2);
    assert.deepEqual(shown.fullResultsSnapshot.athletes.map(a => a.name), ['孙八', '王七']);
    assert.deepEqual(shown.fullResultsSnapshot.athletes.map(a => a.place), ['1', '2']);
    assert.equal(shown.fullResultsSnapshot.athletes[0].photo, undefined);
    assert.equal(shown.fullResultsSnapshot.athletes[0].note, undefined);
  });

  const updated = await post({ athletePatch: { lane: 2, place: '1', result: '5.10m' } });
  await ok('公示显示中补录成绩，全屏板同步刷新', () => {
    assert.equal(updated.fullResultsVisible, true);
    assert.equal(updated.fullResultsSnapshot.athletes[0].name, '孙八');
    assert.equal(updated.fullResultsSnapshot.athletes[0].result, '5.10m');
  });

  let hidden = await post({ resultsAction: 'hide' });  await ok('手动收起后不再盖住画面', () => {
    assert.equal(hidden.fullResultsVisible, false);
    assert.equal(hidden.fullResultsHideAt, 0);
  });

  await post({ fullResultsDuration: 1 });
  await post({ resultsAction: 'show' });
  const extended = await post({ fullResultsDuration: 30 });
  await sleep(1600);
  let still = await fetch(`${API}/api/scoreboard`).then(r => r.json());
  await ok('公示中改「秒后收起」会按新时长重新计时', () => {
    assert.equal(extended.fullResultsVisible, true);
    assert.ok(extended.fullResultsHideAt > Date.now() + 20000);
    assert.equal(still.fullResultsVisible, true);
  });

  await post({ fullResultsDuration: 1 });
  await sleep(1600);
  let after = await fetch(`${API}/api/scoreboard`).then(r => r.json());
  await ok('到达设定秒数后服务端自动收起（HDMI / 监看 / 录像同时下屏）', () => {
    assert.equal(after.fullResultsVisible, false);
    assert.equal(after.fullResultsHideAt, 0);
  });

  await post({ fullResultsDuration: 0, fullResultsAuto: true });
  await post({ programAction: 'prev' });
  let auto = await fetch(`${API}/api/scoreboard`).then(r => r.json());
  await ok('按「上一项 / 下一项」时自动展示刚结束项目的成绩', () => {
    assert.equal(auto.fullResultsVisible, true);
    assert.equal(auto.fullResultsSnapshot.eventName, '女子跳远');
    assert.equal(auto.fullResultsSnapshot.index, 1);
    assert.equal(auto.fullResultsHideAt, 0);
  });

  const afterPatch = await post({ athletePatch: { lane: 1, place: '1', result: '4.80m' } });
  await ok('切走后的上一节成绩不会被下一节的补录覆盖', () => {
    assert.equal(afterPatch.fullResultsVisible, true);
    assert.equal(afterPatch.fullResultsSnapshot.eventName, '女子跳远');
    assert.equal(afterPatch.fullResultsSnapshot.athletes.find(a => a.lane === 2).result, '5.10m');
  });

  await post({ resultsAction: 'hide', fullResultsAuto: false });
  await post({ programAction: 'next' });
  const autoOff = await fetch(`${API}/api/scoreboard`).then(r => r.json());
  await ok('关掉自动展示后切项不再自动上屏', () => {
    assert.equal(autoOff.fullResultsVisible, false);
  });
  await post({ fullResultsAuto: true });

  const page = await fetch(`${API}/results/`);
  const html = await page.text();
  await ok('成绩公示页随服务端发布，入口可用', () => {
    assert.equal(page.status, 200);
    assert.ok(html.includes('成绩公示'));
    assert.ok(html.includes('/api/results'));
  });

  const fallback = await results('?meet=not-exist');
  await ok('未指定 / 不存在的赛程时回退到第一份赛程，不报错', () => {
    assert.equal(fallback.meet.id, '2026-yuhua');
    assert.equal(fallback.current.index, 1);
  });

  console.log(`\n✅ 成绩公示 API ${pass} 项全部通过`);
} finally {
  try { child?.kill(); } catch { /* 已退出 */ }
  await sleep(600);
  if (backup) writeFileSync(SCOREBOARD_FILE, backup);
}
