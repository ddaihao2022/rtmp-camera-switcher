'use strict';
/**
 * 端到端冒烟测试：老师录入 → 去极值平均 → 回传叠加层（成绩+名次）
 * 前置：先启动服务 `npm run server`（或在另一个终端里 node server/index.js）
 * 运行：node tests/timing.e2e.js
 *
 * 注意：该脚本会真实写入 data/scoreboard.json（叠加层成绩）与 data/timing.json（录入数据），
 *       建议在测试机/彩排环境运行；正式数据请先备份。
 */
const assert = require('assert');

const BASE = process.env.TIMING_API || 'http://127.0.0.1:3001';

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

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return r;
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

(async function main() {
  console.log(`计时录入端到端测试 → ${BASE}\n`);

  // 0. 服务可见
  await step('服务在线 /api/health', async () => {
    const r = await api('/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'ok');
  });

  // 1. 录入状态与项目同步
  let judges = [];
  await step('GET /api/timing 返回裁判名单并已同步当前项目', async () => {
    const r = await api('/api/timing');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.judges) && r.json.judges.length >= 3, '裁判名单至少 3 人');
    judges = r.json.judges;
    assert.ok(r.json.event.eventName, 'eventName 应从 scoreboard 同步');
    assert.ok(r.json.urls && /\/timer\/$/.test(r.json.urls.entry), '应返回老师录入页地址');
  });

  // 2. 重置本轮，保证干净
  await step('POST /api/timing/reset 清空本轮', async () => {
    const r = await api('/api/timing/reset', { method: 'POST', body: { scope: 'round' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.state.entries, {});
  });

  // 3. 三位老师录入三道成绩
  const plan = {
    3: ['12.31', '12.45', '12.38'],   // 去极值 → 12.38
    4: ['12.80', '12.20', '12.55'],   // 去极值 → 12.55
    5: ['13.00', '13.10'],            // 仅两人 → 13.05
    6: ['13.50'],                     // 仅一人 → 13.50
  };
  await step('POST /api/timing/entry 多老师分头录入', async () => {
    for (const [lane, times] of Object.entries(plan)) {
      for (let i = 0; i < times.length; i += 1) {
        const r = await api('/api/timing/entry', {
          method: 'POST',
          body: { judge: judges[i].id, lane: Number(lane), time: times[i], src: 'stopwatch' },
        });
        assert.strictEqual(r.status, 200, `${lane} 道 ${times[i]} 提交失败：${r.text}`);
        assert.ok(r.json.ok);
        assert.strictEqual(r.json.text, times[i].endsWith('0') ? times[i] : r.json.text);
      }
    }
  });

  // 4. 合成结果校验
  await step('去极值平均：3 人 / 2 人 / 1 人三类情形', async () => {
    const r = await api('/api/timing');
    const lanes = r.json.lanes;
    assert.strictEqual(lanes['3'].avgText, '12.38', '3 人：去掉 12.31 与 12.45');
    assert.deepStrictEqual(lanes['3'].dropped, ['12.31', '12.45']);
    assert.strictEqual(lanes['4'].avgText, '12.55', '3 人：去掉 12.20 与 12.80');
    assert.strictEqual(lanes['5'].avgText, '13.05', '2 人：直接取平均');
    assert.strictEqual(lanes['5'].dropped.length, 0);
    assert.strictEqual(lanes['6'].avgText, '13.50', '1 人：直接采用');
    assert.strictEqual(lanes['3'].count, 3);
    assert.strictEqual(lanes['1'].avg, null, '未录入道次无平均');
  });

  await step('名次按最终成绩升序、并列同名次', async () => {
    const r = await api('/api/timing');
    assert.deepStrictEqual(r.json.places, { 3: 1, 4: 2, 5: 3, 6: 4 });
  });

  // 5. 裁判长手动修正
  await step('POST /api/timing/override 手动修正成绩', async () => {
    const r = await api('/api/timing/override', { method: 'POST', body: { lane: 5, time: '13.11', by: '裁判长' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.state.lanes['5'].finalText, '13.11');
    assert.strictEqual(r.json.state.lanes['5'].overrideText, '13.11');
  });

  // 6. 回传叠加层
  await step('POST /api/timing/apply 写入成绩与名次', async () => {
    const r = await api('/api/timing/apply', { method: 'POST', body: { by: '裁判长' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(
      r.json.written.appliedLanes.sort(),
      ['3', '4', '5', '6'],
      '应写入 4 个已合成道次',
    );
  });

  await step('GET /api/scoreboard 叠加层已收到成绩与名次', async () => {
    const r = await api('/api/scoreboard');
    const byLane = {};
    r.json.athletes.forEach((a) => { byLane[Number(a.lane)] = a; });
    assert.strictEqual(byLane[3].result, '12.38');
    assert.strictEqual(byLane[4].result, '12.55');
    assert.strictEqual(byLane[5].result, '13.11');
    assert.strictEqual(byLane[6].result, '13.50');
    assert.strictEqual(byLane[3].place, '1');
    assert.strictEqual(byLane[4].place, '2');
    assert.strictEqual(byLane[5].place, '3');
    assert.strictEqual(byLane[6].place, '4');
    assert.strictEqual(byLane[1].result, '', '未录入道次不应写入成绩');
    assert.strictEqual(r.json.showResults, true, '应自动开启成绩显示');
    assert.strictEqual(r.json.showPlaces, true, '应自动开启名次显示');
  });

  // 7. 表单校验
  await step('非法时间 / 非法裁判被拒绝（400）', async () => {
    const bad1 = await api('/api/timing/entry', { method: 'POST', body: { judge: judges[0].id, lane: 3, time: 'abc' } });
    assert.strictEqual(bad1.status, 400);
    assert.ok(bad1.json.error);
    const bad2 = await api('/api/timing/entry', { method: 'POST', body: { judge: 'nobody', lane: 3, time: '12.30' } });
    assert.strictEqual(bad2.status, 400);
    const bad3 = await api('/api/timing/entry', { method: 'POST', body: { judge: judges[0].id, lane: 99, time: '12.30' } });
    assert.strictEqual(bad3.status, 400);
  });

  // 8. 删除单条读数
  await step('POST /api/timing/entry/delete 删除某位老师读数', async () => {
    const r = await api('/api/timing/entry/delete', { method: 'POST', body: { judge: judges[2].id, lane: 3 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.state.lanes['3'].count, 2);
  });

  // 9. 自动写入
  await step('自动写入：全部道次达标即自动回传（autoApply）', async () => {
    await api('/api/timing/config', { method: 'POST', body: { trim: { autoApply: true, autoApplyMin: 1 } } });
    await api('/api/timing/reset', { method: 'POST', body: { scope: 'round' } });
    let last = null;
    for (let lane = 1; lane <= 8; lane += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await api('/api/timing/entry', {
        method: 'POST',
        body: { judge: judges[0].id, lane, time: (13 + lane / 10).toFixed(2), src: 'manual' },
      });
      assert.strictEqual(last.json.autoApplied, lane === 8, `${lane} 道 autoApplied 应仅在第 8 道为 true`);
    }
    const sb = await api('/api/scoreboard');
    const lane8 = sb.json.athletes.find((a) => Number(a.lane) === 8);
    assert.strictEqual(lane8.result, '13.80', '自动回传应写入第 8 道（最后一道）');
    assert.strictEqual(lane8.place, '8');
    await api('/api/timing/config', { method: 'POST', body: { trim: { autoApply: false } } });
  });

  // 10. 页面与导出
  await step('老师录入页 /timer/ 可访问', async () => {
    const r = await api('/timer/', { raw: true });
    const html = await r.text();
    assert.strictEqual(r.status, 200);
    assert.ok(/成绩录入/.test(html), '页面标题/品牌存在');
    assert.ok(/socket\.io\.js/.test(html), '引用 socket.io 客户端');
  });

  await step('裁判长监控页 /timer/monitor.html 可访问', async () => {
    const r = await api('/timer/monitor.html', { raw: true });
    const html = await r.text();
    assert.strictEqual(r.status, 200);
    assert.ok(/计时汇总台/.test(html));
  });

  await step('二维码 /api/timing/qr.svg 返回 SVG', async () => {
    const r = await api('/api/timing/qr.svg?size=200', { raw: true });
    const svg = await r.text();
    assert.strictEqual(r.status, 200);
    assert.ok(/<svg/.test(svg), '应为 svg 内容');
  });

  await step('导出 /api/timing/export.csv 含表头与去极值列', async () => {
    const r = await api('/api/timing/export.csv', { raw: true });
    const csv = await r.text();
    assert.strictEqual(r.status, 200);
    assert.ok(/道次/.test(csv) && /去掉最高/.test(csv) && /最终成绩/.test(csv));
  });

  console.log(`\n端到端测试：${pass}/${pass + failed} 通过${failed ? `，${failed} 失败` : ''}`);
  if (failed) fails.forEach((f) => console.error('  · ' + f));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(1);
});
