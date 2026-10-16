/**
 * 名册 / 节目单解析器测试
 *
 * 现场是把秩序册、报名表、Excel 一列直接粘进来的，格式千奇百怪，
 * 所以这里覆盖各种真实粘贴形态（Tab 表格、空格、逗号、带表头、只有姓名…），
 * 确保「道次 / 姓名 / 单位 / 号码 / 最好成绩 / 备注」都能落到正确的格子里。
 *
 * 运行：node tests/roster-parse.test.mjs
 */
import assert from 'node:assert';
import {
  LANE_MAX, parseAthleteLine, parseRoster, parseProgram, parseEntryTitle,
  inferEventKind, isHeaderRow, splitColumns,
} from '../client/src/utils/roster.js';

let pass = 0;
function ok(name, fn) {
  fn();
  pass += 1;
  console.log(`  ✓ ${name}`);
}

console.log('名册解析');

ok('空格分隔：道次 姓名 单位 号码 成绩 备注', () => {
  const a = parseAthleteLine('3 张三 高一(2)班 1023 11.20 上届冠军');
  assert.deepEqual(
    { lane: a.lane, name: a.name, unit: a.unit, bib: a.bib, pb: a.pb, note: a.note },
    { lane: 3, name: '张三', unit: '高一(2)班', bib: '1023', pb: '11.20', note: '上届冠军' },
  );
});

ok('多个空格 / 全角逗号 / 顿号 都能拆列', () => {
  assert.deepEqual(splitColumns('4   李四    高一3班'), ['4', '李四', '高一3班']);
  assert.deepEqual(splitColumns('4，李四、高一3班'), ['4', '李四', '高一3班']);
  assert.deepEqual(splitColumns('4\t李四\t高一3班'), ['4', '李四', '高一3班']);
});

ok('Excel 粘贴（Tab + 表头）按列名对齐', () => {
  const text = [
    '道次\t姓名\t单位\t号码\t最好成绩',
    '5\t王五\t高二1班\t1088\t10.98',
    '6\t赵六\t高二2班\t1089\t11.45',
  ].join('\n');
  const { athletes, count } = parseRoster(text);
  assert.equal(count, 2);
  assert.equal(athletes.length, 6, '道次 5/6 → 前面补空道到第 6 道');
  assert.equal(athletes[4].name, '王五');
  assert.equal(athletes[4].unit, '高二1班');
  assert.equal(athletes[4].bib, '1088');
  assert.equal(athletes[4].pb, '10.98');
  assert.equal(athletes[5].name, '赵六');
  assert.equal(athletes[0].name, '', '空道次留空');
});

ok('表头行不会被当成选手', () => {
  assert.equal(isHeaderRow('道次 姓名 单位'), true);
  assert.equal(isHeaderRow('3 张三 高一2班'), false);
  const { count } = parseRoster('道次 姓名\n1 张三');
  assert.equal(count, 1);
});

ok('只写姓名：按顺序落道', () => {
  const { athletes, count } = parseRoster('张三\n李四\n王五');
  assert.equal(count, 3);
  assert.deepEqual(athletes.map(a => a.name), ['张三', '李四', '王五']);
  assert.deepEqual(athletes.map(a => a.lane), [1, 2, 3]);
});

ok('道次可指定且跳号（保留空道）', () => {
  const { athletes, count } = parseRoster('3 张三\n5 李四');
  assert.equal(count, 2);
  assert.equal(athletes.length, 5);
  assert.equal(athletes[2].name, '张三');
  assert.equal(athletes[4].name, '李四');
  assert.equal(athletes[0].name, '');
  assert.equal(athletes[1].name, '');
  assert.equal(athletes[3].name, '');
});

ok('“第3道”写法与「姓名+单位」混合都认', () => {
  const a = parseAthleteLine('第3道 陈七 高三4班');
  assert.equal(a.lane, 3);
  assert.equal(a.name, '陈七');
  assert.equal(a.unit, '高三4班');
});

ok('号码 / 成绩 / 道次 不混淆', () => {
  const a = parseAthleteLine('1023 孙八 11.20');
  assert.equal(a.name, '孙八');
  assert.equal(a.bib, '1023');
  assert.equal(a.pb, '11.20');
  assert.equal(a.lane, 0, '1023 不是道次');
  assert.equal(parseAthleteLine('1:02.34 周九').pb, '1:02.34');
  assert.equal(parseAthleteLine('7.85m 吴十').pb, '7.85m');
});

ok('拉丁姓名拼回完整', () => {
  const a = parseAthleteLine('7 John Smith 高二5班');
  assert.equal(a.lane, 7);
  assert.equal(a.name, 'John Smith');
  assert.equal(a.unit, '高二5班');
});

ok('注释行 / 分节行在名册解析中被跳过', () => {
  const { count } = parseRoster('# 男子100米 预赛 第1组\n3 张三\n// 备注行');
  assert.equal(count, 1);
});

ok('道次上限保护', () => {
  const { athletes } = parseRoster(`30 超人\n1 张三`);
  assert.equal(athletes.length, 1 + 1, '30 超出道次上限 → 顺延到空道');
  assert.equal(athletes[0].name, '张三');
  assert.equal(athletes[1].name, '超人');
  assert.ok(athletes.length <= LANE_MAX);
});

ok('目标道次不足时补空道（lanes 选项）', () => {
  const { athletes, count } = parseRoster('1 张三', { lanes: 8 });
  assert.equal(count, 1);
  assert.equal(athletes.length, 8);
  assert.equal(athletes[7].name, '');
});

console.log('节目单解析');

ok('分节标题：时间 / 项目 / 轮次 / 组次', () => {
  const e = parseEntryTitle('# 10:30 男子100米 预赛 第1组');
  assert.equal(e.time, '10:30');
  assert.equal(e.eventName, '男子100米');
  assert.equal(e.category, '男子');
  assert.equal(e.round, '预赛');
  assert.equal(e.heat, '第1组');
  assert.equal(e.label, '10:30 男子100米 预赛 第1组');
});

ok('无 # 前缀的项目行也分节，并推断类别', () => {
  assert.equal(parseEntryTitle('女子跳远 决赛').eventName, '女子跳远');
  assert.equal(parseEntryTitle('女子跳远 决赛').category, '女子');
  assert.equal(parseEntryTitle('女子跳远 决赛').round, '决赛');
  assert.equal(inferEventKind('女子跳远'), 'field');
  assert.equal(inferEventKind('男子4×400米接力'), 'relay');
  assert.equal(inferEventKind('男子1500米'), 'middle');
  assert.equal(inferEventKind('男子5000米'), 'long');
  assert.equal(inferEventKind('男子110米栏'), 'sprint');
});

ok('整套节目单：每节名册独立，人数与道次正确', () => {
  const text = [
    '# 10:30 男子100米 预赛 第1组',
    '3 张三 高一2班 1023 11.20',
    '4 李四 高一3班 1024 11.35',
    '# 10:36 男子100米 预赛 第2组',
    '道次\t姓名\t单位',
    '2\t王五\t高二1班',
    '5\t赵六\t高二2班',
    '# 10:50 女子跳远 决赛',
    '王七',
    '孙八',
  ].join('\n');

  const { entries, warnings } = parseProgram(text);
  assert.equal(entries.length, 3);
  assert.equal(warnings.length, 0);

  assert.equal(entries[0].label, '10:30 男子100米 预赛 第1组');
  assert.equal(entries[0].count, 2);
  assert.equal(entries[0].laneCount, 4);
  assert.equal(entries[0].athletes[2].name, '张三');
  assert.equal(entries[0].athletes[2].pb, '11.20');

  assert.equal(entries[1].label, '10:36 男子100米 预赛 第2组');
  assert.equal(entries[1].count, 2);
  assert.equal(entries[1].athletes[1].name, '王五', '每节的表头按列名对齐');
  assert.equal(entries[1].athletes[4].name, '赵六');

  assert.equal(entries[2].eventName, '女子跳远');
  assert.equal(entries[2].eventKind, 'field');
  assert.deepEqual(entries[2].athletes.map(a => a.name), ['王七', '孙八']);
  assert.deepEqual(entries[2].athletes.map(a => a.lane), [1, 2]);

  // 每节名册互不串号
  assert.equal(entries[0].athletes.some(a => a.name === '王五'), false);
});

ok('节目单可容忍多余空行与全角冒号时间', () => {
  const { entries } = parseProgram('\n\n【09：15 男子400米 预赛 第3组】\n\n1 周九\n\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].time, '09:15');
  assert.equal(entries[0].round, '预赛');
  assert.equal(entries[0].heat, '第3组');
  assert.equal(entries[0].athletes[0].name, '周九');
});

console.log(`\n✅ 名册/节目单解析 ${pass} 项全部通过`);
