/**
 * 名册 / 节目单文本解析 —— 现场零手打
 *
 * 赛程紧凑时没人有空一格一格敲名字，所以支持把秩序册、报名表、Excel 一列
 * 直接复制粘贴进来（Tab / 逗号 / 顿号 / 空格都认），一次填满整组道次。
 *
 * 名册文本（一行一人，道次可省）：
 *   3 张三 高一(2)班 1023 11.20 上届冠军
 *   4  李四  高一(3)班  1024  11.35
 *   王五                       ← 只写姓名，按顺序落到下一道
 *
 * 节目单文本（# / 【】 / == 开头的行分节，每节内含该节名册）：
 *   # 10:30 男子100米 预赛 第1组
 *   3 张三 高一2班 1023 11.20
 *   # 10:36 男子100米 预赛 第2组
 *   ...
 */

export const LANE_MAX = 24;

/** 单位/班级类字段的弱特征（出现在这里就不当姓名） */
const UNIT_RE = /(班|年级|学院|大学|学校|中学|小学|代表队|队|院|系|公司|集团|部门|俱乐部)/;
const NAME_RE = /^[\u4e00-\u9fa5·]{1,6}$|^[A-Za-z][A-Za-z.'-]{1,24}$/;
/** 11.20 / 1:02.34 / 7.85m / 12''34 */
const PB_RE = /^[+-]?\d{1,2}[:'’.]\d{1,2}(?:\.\d{1,2})?\s*(?:m|米|s|秒)?$/i;
/** 1023 / A1023 */
const BIB_RE = /^[A-Za-z]{0,3}\d{2,5}$/;
/** 3 / 第3道 */
const LANE_RE = /^(?:第)?(\d{1,2})(?:道|号)?$/;
/** 一节标题：时间 轮次 组次 */
const TIME_RE = /^(\d{1,2}[:：]\d{1,2})\s*/;
const ROUND_RE = /(资格赛|预赛|复赛|半决赛|决赛|第[一二三四五六七八九十\d]+轮)/;
const HEAT_RE = /(第[一二三四五六七八九十\d]+组|第[一二三四五六七八九十\d]+枪|第[一二三四五六七八九十\d]+次试跳|第[一二三四五六七八九十\d]+次试掷)/i;

const HEADER_FIELDS = [
  { key: 'lane', words: ['道次', '跑道', '道'] },
  { key: 'name', words: ['姓名', '名字', '运动员', '选手', 'name'] },
  { key: 'unit', words: ['单位', '班级', '代表队', '学校', '队名', 'unit', 'team'] },
  { key: 'bib', words: ['号码布', '号码', '编号', 'bib'] },
  { key: 'pb', words: ['报名成绩', '最好成绩', '个人最好', 'pb', '成绩'] },
  { key: 'note', words: ['备注', '亮点', 'note', 'remark'] },
];

/** 一行拆列：Tab / 逗号 / 顿号 / 分号 / 竖线 → 两个以上空格 → 单个空格 */
export function splitColumns(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return [];
  let parts = raw.split(/\t+|\s*[,，、;；|]\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) parts = raw.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) parts = raw.split(/\s+/).map(s => s.trim()).filter(Boolean);
  return parts;
}

/** 注释 / 分节标题行：名册解析时跳过 */
function isCommentLine(line) {
  return /^(#|\/\/|==+|-{2,}|\*|【|\[)/.test(String(line).trim());
}

/** 表头行：#≥2 个字段关键词命中，且不含成绩样式的数字 */
export function isHeaderRow(line) {
  const t = String(line ?? '');
  let hits = 0;
  for (const f of HEADER_FIELDS) if (f.words.some(w => t.includes(w))) hits += 1;
  return hits >= 2 && !/\d{1,2}[:.]\d{1,2}/.test(t);
}

/** 表头 → 列下标映射（命中不足 2 列视为不是表头） */
export function mapHeader(cells) {
  const map = {};
  cells.forEach((cell, i) => {
    const t = String(cell).toLowerCase().replace(/\s+/g, '');
    for (const f of HEADER_FIELDS) {
      if (map[f.key] !== undefined) continue;
      if (f.words.some(w => t.includes(w.toLowerCase()))) { map[f.key] = i; return; }
    }
  });
  return Object.keys(map).length >= 2 ? map : null;
}

function blank() {
  return { lane: 0, name: '', place: '', result: '', unit: '', bib: '', pb: '', note: '', photo: '' };
}

/** 有表头时按列下标取值 */
function fromColumns(cells, colMap) {
  const a = blank();
  for (const [key, idx] of Object.entries(colMap)) {
    if (key === 'lane') continue;
    const v = cells[idx];
    if (v !== undefined && v !== '') a[key] = String(v).trim();
  }
  const laneCell = colMap.lane !== undefined ? cells[colMap.lane] : '';
  const m = LANE_RE.exec(String(laneCell || '').trim());
  if (m && +m[1] >= 1 && +m[1] <= LANE_MAX) a.lane = +m[1];
  return a;
}

/**
 * 解析一行 → 一位选手（无表头时的启发式）
 * 判据优先级：道次（行首/“第N道”）→ 成绩 → 号码 → 单位 → 姓名 → 其余进备注
 */
export function parseAthleteLine(line, fallbackLane = 0) {
  const cells = splitColumns(line);
  if (!cells.length) return null;

  const a = blank();
  const rest = [];

  cells.forEach((tok, i) => {
    if (!a.lane) {
      const m = LANE_RE.exec(tok);
      if (m && +m[1] >= 1 && +m[1] <= LANE_MAX && (i === 0 || /道/.test(tok))) {
        a.lane = +m[1];
        return;
      }
    }
    if (!a.pb && PB_RE.test(tok) && /[.:'’]/.test(tok)) { a.pb = tok; return; }
    if (!a.bib && BIB_RE.test(tok)) { a.bib = tok; return; }
    if (!a.unit && tok.length <= 16 && UNIT_RE.test(tok)) { a.unit = tok; return; }
    if (!a.name && isNameLike(tok)) { a.name = tok; return; }
    rest.push(tok);
  });

  // 拉丁字母姓名被空格拆开时拼回去（John Smith）
  if (/^[A-Za-z]/.test(a.name) && rest.length && rest.every(t => /^[A-Za-z.'-]+$/.test(t))) {
    a.name = [a.name, ...rest.splice(0, rest.length)].join(' ');
  }

  if (!a.name && !a.bib && !a.pb) {
    // 整行就是一个词（纯姓名 / 纯号码）时兜底收下
    if (cells.length === 1) a.name = cells[0];
    else return null;
  }
  if (rest.length) a.note = rest.join(' ');
  if (!a.lane) a.lane = Math.max(0, Number(fallbackLane) || 0);
  return a;
}

function isNameLike(tok) {
  const t = String(tok || '').trim();
  if (!t || /\d/.test(t)) return false;
  if (UNIT_RE.test(t)) return false;
  return NAME_RE.test(t);
}

function clampLanes(n) {
  const v = Math.floor(Number(n) || 0);
  return v > 0 ? Math.min(LANE_MAX, Math.max(1, v)) : 0;
}

/** 落位：指定道次的占自己的道，没写道次的按顺序补空位 */
function placeIntoLanes(entries, lanes) {
  const slots = new Map();
  const pending = [];
  for (const a of entries) {
    const lane = Math.floor(Number(a.lane) || 0);
    if (lane >= 1 && lane <= LANE_MAX && !slots.has(lane)) slots.set(lane, a);
    else pending.push(a);
  }
  const size = Math.max(clampLanes(lanes), slots.size ? Math.max(...slots.keys()) : 0, 0);
  let cursor = 1;
  for (const a of pending) {
    while (slots.has(cursor)) cursor += 1;
    slots.set(cursor, a);
  }
  const total = Math.max(size, slots.size ? Math.max(...slots.keys()) : 0);
  const athletes = Array.from({ length: total }, (_, i) => {
    const hit = slots.get(i + 1);
    return hit ? { ...hit, lane: i + 1 } : blank();
  }).map((a, i) => ({ ...a, lane: i + 1 }));
  return { athletes, count: slots.size };
}

/**
 * 解析一段名册文本
 * @param {string} text
 * @param {{ lanes?: number, skipHeader?: boolean }} [opts] lanes = 目标道次数量（不够补空道）
 * @returns {{ athletes: object[], count: number, warnings: string[] }}
 */
export function parseRoster(text, opts = {}) {
  const entries = [];
  const warnings = [];
  let colMap = null;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isCommentLine(line)) continue;
    if (!colMap && isHeaderRow(line)) {
      colMap = mapHeader(splitColumns(line));
      if (colMap) continue;
    }
    const a = colMap ? fromColumns(splitColumns(line), colMap) : parseAthleteLine(line);
    if (!a || (!a.name && !a.bib && !a.pb)) {
      warnings.push(line);
      continue;
    }
    entries.push(a);
  }

  const { athletes, count } = placeIntoLanes(entries, opts.lanes);
  return { athletes, count, warnings };
}

/** 由项目名推断赛事类型（与 server TRACK_TEMPLATES 口径一致） */
export function inferEventKind(name) {
  const n = String(name || '');
  if (/接力/.test(n)) return 'relay';
  if (/(跳高|跳远|三级跳|撑竿|撑杆|铅球|实心球|铁饼|标枪|链球|全能)/.test(n)) return 'field';
  if (/(5000|10000|3000|马拉松|竞走|越野)/.test(n)) return 'long';
  if (/(800|1500|英里|mile)/i.test(n)) return 'middle';
  return 'sprint';
}

/** 分节标题：提取时间 / 项目 / 轮次 / 组次 */
export function parseEntryTitle(title) {
  let t = String(title ?? '').trim().replace(/^[#=*\-\s【[]+/, '').replace(/[】\]=\s]+$/, '');
  const timeM = TIME_RE.exec(t);
  const time = timeM ? timeM[1].replace('：', ':') : '';
  if (timeM) t = t.slice(timeM[0].length);

  const round = (ROUND_RE.exec(t) || [])[1] || '';
  const heat = (HEAT_RE.exec(t) || [])[1] || '';
  const category = /女子/.test(t) ? '女子' : /混合/.test(t) ? '混合' : '男子';

  let event = t;
  if (round) event = event.replace(round, ' ');
  if (heat) event = event.replace(heat, ' ');
  event = event.replace(/[·•|,，/、]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!event) event = t || '未命名项目';
  if (!event.includes(category)) event = `${category}${event}`;

  return {
    time,
    eventName: event,
    category,
    round: round || '预赛',
    heat: heat || '',
    eventKind: inferEventKind(event),
    label: [time, event, round, heat].filter(Boolean).join(' '),
  };
}

/**
 * 分节标题判定：带 # 【 == 等前缀，或「男子100米 预赛 第1组」这种项目行
 */
export function isProgramTitle(line) {
  const t = String(line ?? '').trim();
  if (!t) return false;
  if (/^(#|\/\/|==+|-{2,}|\*|【|\[)/.test(t)) return true;
  if (!/^(男子|女子|混合)/.test(t)) return false;
  if (/\d{1,2}[:.]\d{1,2}/.test(t)) return false;   // 含成绩 → 是数据行
  return /(米|接力|跳高|跳远|三级跳|撑竿|撑杆|铅球|实心球|铁饼|标枪|链球|全能|马拉松)/.test(t);
}

/**
 * 解析整场节目单：分节标题行 + 节内名册行（每节可自带一行表头）
 * @returns {{ entries: object[], warnings: string[] }}
 */
export function parseProgram(text) {
  const entries = [];
  const warnings = [];
  let current = null;
  let colMap = null;
  let fallbackLane = 1;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isProgramTitle(line)) {
      current = { ...parseEntryTitle(line), athletes: [] };
      entries.push(current);
      colMap = null;
      fallbackLane = 1;
      continue;
    }

    if (!colMap && isHeaderRow(line)) {
      colMap = mapHeader(splitColumns(line));
      if (colMap) continue;
    }

    const a = colMap
      ? fromColumns(splitColumns(line), colMap)
      : parseAthleteLine(line, fallbackLane);
    if (!a || (!a.name && !a.bib && !a.pb)) { warnings.push(line); continue; }

    if (!current) {
      current = { ...parseEntryTitle('未命名项目'), athletes: [] };
      entries.push(current);
    }
    fallbackLane = Math.max(1, (Number(a.lane) || fallbackLane) + 1);
    current.athletes.push(a);
  }

  // 每节内部按道次落位（保留空道），并给出人数
  const normalized = entries.map(e => {
    const { athletes, count } = placeIntoLanes(e.athletes, 0);
    return { ...e, athletes, count, laneCount: athletes.length };
  });

  return { entries: normalized, warnings };
}
