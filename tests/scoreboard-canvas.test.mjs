/**
 * 成绩条 canvas 渲染器冒烟测试
 *
 * 录制导出「有成绩条」那份依赖 drawScoreboard 把叠加层画进 canvas，
 * 这里用一个假的 2D context 跑一遍各模式布局，验证：
 *   1. 不抛异常（无未定义引用 / TDZ）
 *   2. 所有绘制坐标都是有限数字（无 NaN）
 *   3. 绘制范围落在画布内（不跑出画面）
 *
 * 运行：node tests/scoreboard-canvas.test.mjs
 */
import assert from 'node:assert';
import { drawScoreboard, clockText, formatMs } from '../client/src/utils/scoreboardCanvas.js';

function makeCtx(W, H) {
  const ops = [];
  const num = (...xs) => {
    for (const x of xs) {
      assert.ok(typeof x === 'number' && Number.isFinite(x), `非有限坐标: ${JSON.stringify(xs)}`);
      // 所有落笔坐标都必须落在画布内（留 2px 描边余量），否则成片里会跑出画面
      assert.ok(x >= -2 && x <= Math.max(W, H) + 2, `坐标跑出画布 ${W}x${H}: ${x}`);
      ops.push(x);
    }
  };
  return {
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalCompositeOperation: 'source-over',
    filter: 'none',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetY: 0,
    save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {},
    moveTo: (x, y) => num(x, y),
    lineTo: (x, y) => num(x, y),
    quadraticCurveTo: (a, b, c, d) => num(a, b, c, d),
    arc: (cx, cy, r) => num(cx, cy, r),
    setLineDash() {},
    letterSpacing: '',
    fill() {}, stroke() {},
    fillRect: (x, y, w, h) => num(x, y, w, h),
    fillText: (t, x, y) => num(x, y),
    measureText: (t) => ({ width: String(t).length * 7 + 4 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    drawImage() {},
    ops,
  };
}

const baseAthletes = [
  { lane: 1, name: '张三', unit: '高一3班', place: '1', result: '11.42' },
  { lane: 2, name: '李四', unit: '高一5班', place: '2', result: '11.58' },
  { lane: 3, name: '王五', unit: '高二1班', place: '', result: '' },
];

const fullField = Array.from({ length: 8 }, (_, i) => ({
  lane: i + 1,
  name: `选手${i + 1}号`,
  unit: `高二${i + 1}班`,
  place: String(i + 1),
  result: `12.${10 + i}`,
}));

const cases = [
  {
    name: '田径径赛 · 底部 + 跑表',
    config: {
      enabled: true, mode: 'track', eventKind: 'sprint', position: 'bottom',
      category: '男子', eventName: '100米', round: '预赛', heat: '第1组', wind: '+0.8',
      mr: '10.23', sb: '10.55', athletes: baseAthletes,
      showPlaces: true, showResults: true, showClock: true,
      clockRunning: true, clockStartAt: Date.now() - 12345, clockOffsetMs: 0,
      laps: ['13.20', '13.01'],
    },
  },
  {
    name: '田径田赛 · 顶部 + 成绩榜',
    config: {
      enabled: true, mode: 'track', eventKind: 'field', position: 'top',
      category: '女子', eventName: '跳远', round: '决赛', attempt: 3, attemptsTotal: 6,
      bestMark: '5.42', athletes: baseAthletes, showPodium: true,
      showPlaces: true, showResults: true, showClock: false, clock: '5.42',
    },
  },
  {
    name: '球队比分条',
    config: {
      enabled: true, mode: 'team', position: 'bottom',
      homeName: '一中', awayName: '三中', homeScore: 12, awayScore: 9,
      period: '第3节', showClock: true, clock: '07:21',
      homeColor: '#2563eb', awayColor: '#dc2626',
    },
  },
  {
    name: '8 道满编 · 底部长名单换行',
    config: {
      enabled: true, mode: 'track', eventKind: 'sprint', position: 'bottom',
      category: '男子', eventName: '200米', round: '决赛', heat: '第1组', wind: '-1.2',
      athletes: fullField, showPlaces: true, showResults: true,
      showClock: true, clock: '24.88', laps: ['11.80', '12.01', '12.20', '24.88'],
    },
  },
  {
    name: '选手介绍 · 单人卡',
    config: {
      enabled: true, mode: 'intro', introStyle: 'card', introVisible: true,
      introTitle: '选手介绍', introIndex: 1, introShowPb: true, introShowNote: true,
      introAuto: true, introAutoMs: 8000,
      category: '男子', eventName: '100米', round: '预赛', heat: '第1组',
      athletes: [
        { lane: 1, name: '张三', unit: '高一3班', bib: '0731', pb: '11.20', note: '校运会卫冕冠军，起跑反应快' },
        { lane: 2, name: '李四', unit: '高一5班', bib: '0732', pb: '11.35', note: '本赛季进步明显' },
      ],
    },
  },
  {
    name: '选手介绍 · 底部字幕条',
    config: {
      enabled: true, mode: 'intro', introStyle: 'lower', introVisible: true,
      introTitle: '选手介绍', introIndex: 0, introShowNote: true, introHold: 6,
      category: '女子', eventName: '跳远', round: '决赛',
      athletes: [{ lane: 4, name: '王五', unit: '高二1班', bib: '1120', pb: '5.42', note: '校纪录保持者 · 上一站冠军' }],
    },
  },
  {
    name: '选手介绍 · 名册（每屏 4 位）',
    config: {
      enabled: true, mode: 'intro', introStyle: 'roster', introVisible: true,
      introTitle: '选手介绍', introIndex: 5, introPerScreen: 4, introShowPb: true,
      introAuto: true, introAutoMs: 8000,
      category: '男子', eventName: '100米', round: '预赛',
      athletes: fullField.map((a, i) => ({ ...a, bib: `07${30 + i}`, pb: `11.${20 + i}` })),
    },
  },
  {
    name: '选手介绍 · 空名册提示',
    config: {
      enabled: true, mode: 'intro', introStyle: 'card', introVisible: true,
      introTitle: '选手介绍', athletes: [{ lane: 1, name: '', place: '', result: '' }],
    },
  },
];

const sizes = [
  [1920, 1080],
  [1280, 720],
  [854, 480],
];

let checked = 0;
for (const [W, H] of sizes) {
  for (const c of cases) {
    const ctx = makeCtx(W, H);
    assert.doesNotThrow(() => drawScoreboard(ctx, c.config, W, H, Date.now()), `${c.name} 绘制抛异常`);
    assert.ok(ctx.ops.length > 0, `${c.name} 没有产生任何绘制调用`);
    checked += 1;
    if (W === 1920) console.log(`  ✓ ${c.name}（${ctx.ops.length} 个坐标）`);
  }
  console.log(`  ✓ ${W}x${H} 全部布局不跑出画面`);
}

// 未启用 / 隐藏 / 空配置时不应产生任何绘制
{
  const ctx = makeCtx(1920, 1080);
  drawScoreboard(ctx, { enabled: false }, 1920, 1080);
  assert.strictEqual(ctx.ops.length, 0, '成绩条未启用时不应绘制');
  assert.strictEqual(drawScoreboard(ctx, null, 1920, 1080), undefined);
  drawScoreboard(ctx, { enabled: true, mode: 'intro', introVisible: false, athletes: [{ name: '张三' }] }, 1920, 1080);
  assert.strictEqual(ctx.ops.length, 0, '选手介绍已隐藏时不应绘制');
  console.log('  ✓ 未启用 / 已隐藏 / 空配置时不绘制');
}

// 时钟读数
{
  assert.strictEqual(formatMs(0), '0.00');
  assert.strictEqual(formatMs(65432), '01:05.43');
  assert.strictEqual(clockText({ clockRunning: false, clock: '5.42' }), '5.42');
  const live = clockText({ clockRunning: true, clockStartAt: Date.now() - 1000, clockOffsetMs: 500 });
  assert.ok(/^1\.[45]\d$/.test(live), `跑表读数异常: ${live}`);
  console.log('  ✓ 时钟格式化 / 跑表读数');
}

console.log(`\n成绩条 canvas 渲染器：${checked} 个布局用例通过`);
