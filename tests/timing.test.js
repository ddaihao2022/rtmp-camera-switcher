'use strict';
/**
 * 计时模块自测：时间解析 / 秒表格式化 / 去极值平均 / 名次并列
 * 运行：node tests/timing.test.js
 */
const assert = require('assert');
const { formatTime, parseTimeInput, aggregate, rankLanes } = require('../server/timing');

let pass = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// ─── 时间文本解析 ────────────────────────────────────────────────────────────
test('纯秒：12 / 12.3 / 12.34', () => {
  assert.strictEqual(parseTimeInput('12'), 12000);
  assert.strictEqual(parseTimeInput('12.3'), 12300);
  assert.strictEqual(parseTimeInput('12.34'), 12340);
  assert.strictEqual(parseTimeInput(' 9.83s '), 9830);
});

test('分:秒：1:02.34', () => {
  assert.strictEqual(parseTimeInput('1:02.34'), 62340);
  assert.strictEqual(parseTimeInput('1:2.3'), 62300);
  assert.strictEqual(parseTimeInput('2:00'), 120000);
});

test('时:分:秒：1:02:03.4', () => {
  assert.strictEqual(parseTimeInput('1:02:03.4'), 3723400);
});

test('中文写法：1分2秒34 / 2秒34 / 1分20秒', () => {
  assert.strictEqual(parseTimeInput('1分2秒34'), 62340);
  assert.strictEqual(parseTimeInput('2秒34'), 2340);
  assert.strictEqual(parseTimeInput('1分20秒'), 80000);
});

test('全角与非法输入', () => {
  assert.strictEqual(parseTimeInput('１２．３４'), 12340);
  assert.strictEqual(parseTimeInput(''), null);
  assert.strictEqual(parseTimeInput('abc'), null);
  assert.strictEqual(parseTimeInput('1:2:3:4'), null);
  assert.strictEqual(parseTimeInput('12:'), null);
});

// ─── 格式化 ─────────────────────────────────────────────────────────────────
test('格式化：秒 / 分 / 时', () => {
  assert.strictEqual(formatTime(9830), '9.83');
  assert.strictEqual(formatTime(62340), '1:02.34');
  assert.strictEqual(formatTime(3723400), '1:02:03.40');
  assert.strictEqual(formatTime(3661000 * 0 + 59990), '59.99');
  assert.strictEqual(formatTime(60000), '1:00.00');
  assert.strictEqual(formatTime(1), '0.00');
  assert.strictEqual(formatTime(null), '');
});

// ─── 去极值平均 ─────────────────────────────────────────────────────────────
const TRIM = { enabled: true, dropCount: 1, minJudges: 3, roundTo: 10, warnSpreadMs: 300 };

test('单人：直接采用', () => {
  const r = aggregate([12310], TRIM);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.drops, 0);
  assert.strictEqual(r.avg, 12310);
});

test('两人：无法去极值，取两人平均', () => {
  const r = aggregate([12300, 12400], TRIM);
  assert.strictEqual(r.drops, 0);
  assert.strictEqual(r.avg, 12350);
});

test('三人：去掉最高最低，取中间那个', () => {
  const r = aggregate([12310, 12450, 12380], TRIM);
  assert.strictEqual(r.drops, 1);
  assert.deepStrictEqual(r.dropped, [12310, 12450]);
  assert.deepStrictEqual(r.used, [12380]);
  assert.strictEqual(r.avg, 12380);
});

test('五人：去掉最高最低后取三个平均', () => {
  const r = aggregate([12100, 12300, 12400, 12500, 12900], TRIM);
  assert.strictEqual(r.drops, 1);
  assert.deepStrictEqual(r.dropped, [12100, 12900]);
  assert.deepStrictEqual(r.used, [12300, 12400, 12500]);
  assert.strictEqual(r.avg, 12400);
  assert.strictEqual(r.spread, 800);
});

test('三人：干脆的 12.31 / 12.45 / 12.38 → 12.38', () => {
  const r = aggregate(['12.31', '12.45', '12.38'].map(parseTimeInput), TRIM);
  assert.strictEqual(formatTime(r.avg), '12.38');
  assert.deepStrictEqual(r.dropped.map(formatTime), ['12.31', '12.45']);
});

test('八人：去掉一个最高一个最低，其余六个平均（0.01s 精度）', () => {
  const raw = [12100, 12150, 12200, 12220, 12240, 12260, 12300, 13000];
  const r = aggregate(raw, TRIM);
  assert.strictEqual(r.drops, 1);
  assert.deepStrictEqual(r.dropped, [12100, 13000]);
  assert.strictEqual(r.used.length, 6);
  assert.strictEqual(r.avg, Math.round(((12150 + 12200 + 12220 + 12240 + 12260 + 12300) / 6) / 10) * 10);
});

test('去掉两高一低：dropCount=2', () => {
  const r = aggregate([12100, 12200, 12300, 12400, 12500], { ...TRIM, dropCount: 2 });
  assert.strictEqual(r.drops, 2);
  assert.deepStrictEqual(r.dropped, [12100, 12200, 12400, 12500]);
  assert.strictEqual(r.avg, 12300);
});

test('极端情况：dropCount 过大时自动收缩，至少保留 1 个', () => {
  const r = aggregate([12100, 12200], { ...TRIM, dropCount: 3 });
  assert.strictEqual(r.drops, 0);
  assert.strictEqual(r.avg, 12150);
});

test('关闭去极值：全部取平均', () => {
  const r = aggregate([12100, 12200, 13000], { ...TRIM, enabled: false });
  assert.strictEqual(r.drops, 0);
  assert.strictEqual(r.avg, Math.round(((12100 + 12200 + 13000) / 3) / 10) * 10);
});

test('minJudges=4 时三人不去极值', () => {
  const r = aggregate([12100, 12200, 12300], { ...TRIM, minJudges: 4 });
  assert.strictEqual(r.drops, 0);
  assert.strictEqual(r.avg, 12200);
});

test('重复值：最高最低重复也按个数去掉', () => {
  const r = aggregate([12300, 12300, 12300, 12400], TRIM);
  assert.strictEqual(r.drops, 1);
  assert.deepStrictEqual(r.dropped, [12300, 12400]);
  assert.strictEqual(r.avg, 12300);
});

test('空值/非法值被忽略，偏差与告警正确', () => {
  const r = aggregate([null, '', 0, 12300, 12900], TRIM);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.warned, true);
  assert.ok(/建议复核/.test(r.reason));
});

// ─── 名次 ───────────────────────────────────────────────────────────────────
test('名次：按成绩升序，并列同名次、后续跳号', () => {
  const places = rankLanes({ 1: 12340, 2: 12100, 3: 12100, 4: 12500 });
  assert.deepStrictEqual(places, { '2': 1, '3': 1, '1': 3, '4': 4 });
});

test('名次：未完成道次不占名次', () => {
  const places = rankLanes({ 1: 12340, 5: 12100 });
  assert.deepStrictEqual(places, { '5': 1, '1': 2 });
});

// ─── 执行 ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n     ${e.message}`);
  }
}
console.log(`\n计时模块自测：${pass}/${cases.length} 通过${failed ? `，${failed} 失败` : ''}`);
process.exit(failed ? 1 : 0);
