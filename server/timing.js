'use strict';
/**
 * 田径手动计时 · 多位老师成绩录入与合成模块
 * ---------------------------------------------------------------
 * 现场流程：
 *   多位计时老师各自用手机打开 /timer/ → 选自己的名字 → 每道结束后录入（或按跑表抓取）时间
 *   → 服务器按道次汇总 → 去掉一个最高值、一个最低值 → 其余取平均
 *   → 一键（或自动）回传主系统叠加层，同时自动排定名次
 *
 * 数据落盘：data/timing.json
 * 实时通道：socket.io 事件 timing:update
 *
 * 该模块自身只做“计时录入 + 合成”，真正写入叠加层由主服务通过
 * register({ applyResults }) 注入的回调完成，避免与 scoreboard 逻辑耦合。
 */

const path = require('path');
const fs = require('fs');

const MS_MIN = 1000;                 // 有效成绩下限 1s
const MS_MAX = 60 * 60 * 1000;       // 有效成绩上限 1h
const MAX_LANES = 16;
const HISTORY_LIMIT = 30;

// ─── 纯函数：时间文本 ⇄ 毫秒 ────────────────────────────────────────────────

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** 毫秒 → 秒表文本："9.83" / "1:02.34" / "1:02:03.45" */
function formatTime(ms, opts = {}) {
  const decimals = Math.min(3, Math.max(0, opts.decimals ?? 2));
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const unit = 10 ** (3 - decimals);
  const total = Math.max(0, Math.round(Number(ms) / unit) * unit);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const frac = pad(Math.round((total % 1000) / unit), decimals);
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}.${frac}`;
  if (m > 0) return `${m}:${pad(s)}.${frac}`;
  return `${s}.${frac}`;
}

function normalizeTimeText(input) {
  return String(input)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/[．。]/g, '.')
    .replace(/[，,]/g, '.')
    .replace(/[′’'"]/g, ':')
    .replace(/\s+/g, '')
    .replace(/[sS]$/, '')   // 9.83s → 9.83
    .trim();
}

/**
 * 解析老师输入的时间文本 → 毫秒
 * 支持：12 / 12.3 / 12.34 / 1:02.3 / 1:02.34 / 1:02:03.4 / 1分2秒34 / 2秒34
 * 返回 null 表示无法识别。
 */
function parseTimeInput(input) {
  if (input == null) return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input) : null;
  }
  const s = normalizeTimeText(input);
  if (!s) return null;

  // 中文：1分02秒34 → 62.34 / 1分20秒 → 80 / 1分 → 60
  let m = /^(\d+(?:\.\d+)?)\s*分(?:(\d+(?:\.\d+)?)(?:\s*秒\s*(\d{1,3}))?)?\s*秒?$/.exec(s);
  if (m) {
    const minutes = Number(m[1]);
    const sec = m[2] === undefined ? 0 : Number(m[2]);
    const centi = m[3] ? Number(m[3].padEnd(2, '0').slice(0, 2)) / 100 : 0;
    const ms = Math.round((minutes * 60 + sec + centi) * 1000);
    return Number.isFinite(ms) ? ms : null;
  }
  // 中文：2秒34 → 2.34
  m = /^(\d+)\s*秒(?:(\d{1,3}))?$/.exec(s);
  if (m) {
    const sec = Number(m[1]);
    const centi = m[2] ? Number(m[2].padEnd(2, '0').slice(0, 2)) : 0;
    return Math.round((sec + centi / 100) * 1000);
  }

  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || !/^\d+(?:\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  let sec = 0;
  if (nums.length === 1) sec = nums[0];
  else if (nums.length === 2) sec = nums[0] * 60 + nums[1];
  else sec = nums[0] * 3600 + nums[1] * 60 + nums[2];
  return Math.round(sec * 1000);
}

// ─── 纯函数：去极值平均 ────────────────────────────────────────────────────

/**
 * 去极值平均：
 *   人数 ≥ minJudges（默认 3）且开启去极值 → 去掉 dropCount 个最高 + dropCount 个最低，其余取算术平均
 *   人数 <  minJudges                     → 无法去极值，全部取平均（2 人取两人平均，1 人直接采用）
 * 结果按 roundTo（默认 10ms）四舍五入，对应秒表 0.01s 精度。
 */
function aggregate(values, trim = {}) {
  const t = {
    enabled: true,
    dropCount: 1,
    minJudges: 3,
    roundTo: 10,
    warnSpreadMs: 300,
    ...trim,
  };
  const nums = (values || [])
    .map((v) => Number(v && typeof v === 'object' ? v.ms : v))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  const n = nums.length;
  const out = {
    count: n,
    values: nums,
    drops: 0,
    dropped: [],
    used: [],
    avg: null,
    rawAvg: null,
    spread: n ? nums[n - 1] - nums[0] : 0,
    stdev: null,
    warned: false,
    reason: '',
  };
  if (!n) return out;

  let drops = Math.max(0, Math.floor(Number(t.dropCount)) || 0);
  const minJudges = Math.max(3, Math.floor(Number(t.minJudges)) || 3);
  if (!t.enabled || n < minJudges) drops = 0;
  while (drops > 0 && n - 2 * drops < 1) drops -= 1;

  out.drops = drops;
  out.dropped = drops
    ? [...nums.slice(0, drops), ...nums.slice(n - drops)]
    : [];
  out.used = nums.slice(drops, n - drops);

  const mean = out.used.reduce((a, b) => a + b, 0) / out.used.length;
  const unit = Math.max(1, Number(t.roundTo) || 1);
  out.rawAvg = mean;
  out.avg = Math.round(mean / unit) * unit;

  if (n >= 2) {
    const m = nums.reduce((a, b) => a + b, 0) / n;
    out.stdev = Math.sqrt(nums.reduce((acc, v) => acc + (v - m) ** 2, 0) / n);
  }
  if (out.spread > (Number(t.warnSpreadMs) || 300)) {
    out.warned = true;
    out.reason = `老师读数最大相差 ${formatTime(out.spread)}，建议复核`;
  }
  return out;
}

/** 名次：标准竞技排名（并列同名次，后续名次跳号） */
function rankLanes(laneValues) {
  const items = Object.entries(laneValues || {})
    .filter(([, v]) => Number.isFinite(Number(v)))
    .map(([lane, v]) => ({ lane: Number(lane), value: Number(v) }))
    .sort((a, b) => a.value - b.value);
  const places = {};
  let lastValue = null;
  let lastPlace = 0;
  items.forEach((it, idx) => {
    const place = lastValue !== null && it.value === lastValue ? lastPlace : idx + 1;
    lastValue = it.value;
    lastPlace = place;
    places[String(it.lane)] = place;
  });
  return places;
}

// ─── 模块状态 ──────────────────────────────────────────────────────────────

let dataFile = null;
let hooked = false;
let saveTimer = null;

let state = null;

function defaultJudges() {
  return ['1号计时', '2号计时', '3号计时'].map((name, i) => ({
    id: `j${i + 1}`,
    name,
    active: true,
  }));
}

function createDefaultState() {
  return {
    enabled: true,
    judges: defaultJudges(),
    trim: {
      enabled: true,
      dropCount: 1,
      minJudges: 3,
      roundTo: 10,
      warnSpreadMs: 300,
      autoApply: true,
      autoApplyMin: 3,
    },
    ui: {
      hideOthersOnEntry: true,   // 老师页面默认不显示其他老师的具体读数，避免互相影响
      stopwatch: true,           // 老师页面提供本地跑表抓取
      followSystemClock: true,   // 允许跟随主控台跑表
    },
    event: { eventName: '', category: '', round: '', heat: '', lanes: 8 },
    roundKey: '',
    entries: {},      // { lane: { judgeId: { ms, src, at, raw } } }
    overrides: {},    // { lane: { ms, by, at, note } }
    appliedAt: null,
    appliedRecord: null,
    history: [],
    updatedAt: Date.now(),
  };
}

function resolveDataFile() {
  const dirs = [path.join(process.cwd(), 'data'), path.join(__dirname, '..', 'data')];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, 'timing.json');
    } catch {
      /* try next */
    }
  }
  return null;
}

function ensureState() {
  if (state) return state;
  state = createDefaultState();
  dataFile = resolveDataFile();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      state = {
        ...state,
        ...raw,
        trim: { ...state.trim, ...(raw.trim || {}) },
        ui: { ...state.ui, ...(raw.ui || {}) },
        event: { ...state.event, ...(raw.event || {}) },
        entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {},
        overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
        judges: Array.isArray(raw.judges) && raw.judges.length ? raw.judges : defaultJudges(),
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    } catch {
      /* 使用默认值 */
    }
  }
  return state;
}

function persist() {
  ensureState();
  if (!dataFile) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(dataFile, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      /* 忽略写盘失败 */
    }
  }, 120);
}

function eventKeyOf(cfg) {
  if (!cfg) return '';
  return [cfg.eventName, cfg.category, cfg.round, cfg.heat].map((v) => String(v ?? '').trim()).join('|');
}

// ─── 合成 ──────────────────────────────────────────────────────────────────

/** 当前轮次各道次的完整合成结果 */
function computeLanes() {
  ensureState();
  const lanes = Math.max(1, Math.min(MAX_LANES, Number(state.event.lanes) || 8));
  const out = {};
  for (let lane = 1; lane <= lanes; lane += 1) {
    const raw = state.entries[String(lane)] || {};
    const values = Object.entries(raw)
      .map(([judgeId, v]) => ({
        judgeId,
        judge: state.judges.find((j) => j.id === judgeId)?.name || judgeId,
        ms: Number(v?.ms),
        src: v?.src || 'manual',
        at: v?.at || 0,
      }))
      .filter((v) => Number.isFinite(v.ms) && v.ms > 0)
      .sort((a, b) => a.ms - b.ms);

    const agg = aggregate(values.map((v) => v.ms), state.trim);
    const droppedSet = new Set();
    if (agg.drops) {
      const low = values.slice(0, agg.drops).map((v) => v.judgeId + '@' + v.ms);
      const high = values.slice(values.length - agg.drops).map((v) => v.judgeId + '@' + v.ms);
      [...low, ...high].forEach((k) => droppedSet.add(k));
    }
    const override = state.overrides[String(lane)];
    const finalMs = Number.isFinite(Number(override?.ms)) ? Number(override.ms) : agg.avg;

    out[String(lane)] = {
      lane,
      values: values.map((v) => ({
        ...v,
        text: formatTime(v.ms),
        dropped: droppedSet.has(v.judgeId + '@' + v.ms),
      })),
      count: agg.count,
      dropped: agg.dropped.map((ms) => formatTime(ms)),
      used: agg.used.map((ms) => formatTime(ms)),
      avg: agg.avg,
      avgText: formatTime(agg.avg),
      spread: agg.spread,
      spreadText: formatTime(agg.spread),
      warned: agg.warned,
      reason: agg.reason,
      overrideMs: Number.isFinite(Number(override?.ms)) ? Number(override.ms) : null,
      overrideText: Number.isFinite(Number(override?.ms)) ? formatTime(override.ms) : '',
      overrideBy: override?.by || '',
      finalMs,
      finalText: formatTime(finalMs),
      ready: agg.avg != null && agg.count >= (Number(state.trim.autoApplyMin) || 3),
    };
  }
  return out;
}

function buildSnapshot() {
  ensureState();
  const lanes = computeLanes();
  const filled = Object.values(lanes).filter((l) => l.finalMs != null);
  return {
    ...state,
    lanes,
    judges: state.judges,
    stats: {
      lanes: Number(state.event.lanes) || 8,
      submittedLanes: filled.length,
      judgeCount: state.judges.filter((j) => j.active !== false).length,
      readyLanes: Object.values(lanes).filter((l) => l.ready).length,
      completed: state.appliedAt != null,
    },
    places: rankLanes(Object.fromEntries(filled.map((l) => [l.lane, l.finalMs]))),
  };
}

// ─── 注册（挂载到主服务） ──────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {import('express').Express} opts.app
 * @param {import('socket.io').Server} opts.io
 * @param {object} opts.logger
 * @param {(payload: object) => object} opts.applyResults 写入叠加层成绩+名次
 * @param {() => object} [opts.getScoreboard] 读取当前叠加层配置
 */
function register(opts = {}) {
  const { app, io, logger = console } = opts;
  ensureState();

  const emit = () => {
    const snap = buildSnapshot();
    if (io) io.emit('timing:update', snap);
    persist();
    return snap;
  };

  // 每个新连接同步一次（页面打开即拿到全量状态）
  if (io && !hooked) {
    hooked = true;
    io.on('connection', (socket) => {
      try {
        socket.emit('timing:update', buildSnapshot());
      } catch {
        /* 忽略 */
      }
    });
  }

  /** 主控台换项目 / 换组次 → 自动换轮（旧数据入历史） */
  function syncEvent(cfg) {
    ensureState();
    if (!cfg) return false;
    const nextKey = eventKeyOf(cfg);
    const nextLanes = Math.max(1, Math.min(MAX_LANES, (cfg.athletes || []).length || 8));
    const changedKey = nextKey && nextKey !== state.roundKey;
    const changedLanes = nextLanes !== Number(state.event.lanes);

    if (changedKey) {
      const hadData = Object.keys(state.entries).length > 0;
      if (hadData) {
        state.history = [
          {
            roundKey: state.roundKey,
            event: state.event,
            at: Date.now(),
            lanes: computeLanes(),
            appliedAt: state.appliedAt,
          },
          ...state.history,
        ].slice(0, HISTORY_LIMIT);
      }
      state.roundKey = nextKey;
      state.entries = {};
      state.overrides = {};
      state.appliedAt = null;
      state.appliedRecord = null;
    }
    if (changedKey || changedLanes) {
      state.event = {
        eventName: cfg.eventName || '',
        category: cfg.category || '',
        round: cfg.round || '',
        heat: cfg.heat || '',
        lanes: nextLanes,
      };
      state.updatedAt = Date.now();
      emit();
      logger.info?.(`[计时] 当前项目 → ${state.event.category}${state.event.eventName} ${state.event.round} ${state.event.heat}`);
      return true;
    }
    return false;
  }

  /** 写入叠加层：成绩 + 名次 */
  function applyResults({ lanes: laneList, by = '主裁判', withEvent = false } = {}) {
    ensureState();
    const computed = computeLanes();
    const targets = (Array.isArray(laneList) && laneList.length
      ? laneList.map(Number)
      : Object.values(computed).filter((l) => l.finalMs != null).map((l) => l.lane)
    ).filter((n) => Number.isFinite(n));

    const resultsByLane = {};
    for (const lane of targets) {
      const l = computed[String(lane)];
      if (l && l.finalMs != null) resultsByLane[String(lane)] = l.finalText;
    }
    const placesByLane = rankLanes(
      Object.fromEntries(
        Object.values(computed)
          .filter((l) => l.finalMs != null)
          .map((l) => [l.lane, l.finalMs]),
      ),
    );
    const payload = {
      resultsByLane,
      placesByLane,
      meta: withEvent ? state.event : undefined,
      by,
      source: 'timing',
    };
    const written = typeof opts.applyResults === 'function' ? opts.applyResults(payload) : payload;
    state.appliedAt = Date.now();
    state.appliedRecord = {
      at: state.appliedAt,
      by,
      resultsByLane,
      placesByLane,
      event: state.event,
    };
    emit();
    return written;
  }

  function laneIsAutoReady(l, min) {
    return l.count >= min;
  }

  function maybeAutoApply() {
    ensureState();
    if (!state.trim.autoApply) return false;
    const min = Math.max(1, Number(state.trim.autoApplyMin) || 3);
    const computed = computeLanes();
    const all = Object.values(computed);
    if (!all.length) return false;
    // 严格判定：每一道都达到人数要求（比赛完整结束）才自动回传，
    // 避免大屏在运动员还没跑完时就显示半截成绩。
    const allReady = all.every((l) => laneIsAutoReady(l, min));
    if (!allReady) return false;
    applyResults({ by: '自动合成（全部道次达标）' });
    return true;
  }

  // ── API ────────────────────────────────────────────────────────────────

  const hostOf = (req) => `${req.protocol}://${req.headers.host || `localhost:3001`}`;
  const entryUrlOf = (req) => `${hostOf(req)}/timer/`;
  const monitorUrlOf = (req) => `${hostOf(req)}/timer/monitor.html`;

  function withUrls(req) {
    return {
      ...buildSnapshot(),
      urls: {
        entry: entryUrlOf(req),
        monitor: monitorUrlOf(req),
        api: hostOf(req),
      },
    };
  }

  app.get('/api/timing', (req, res) => res.json(withUrls(req)));
  app.get('/api/timing/state', (req, res) => res.json(withUrls(req)));

  // 老师录入 / 覆盖 / 删除
  app.post('/api/timing/entry', (req, res) => {
    ensureState();
    const { judge, lane, time, ms, src = 'manual', raw } = req.body || {};
    const judgeId = String(judge || '').trim();
    const laneNo = Number(lane);
    const judgeObj = state.judges.find((j) => j.id === judgeId);
    if (!judgeObj) return res.status(400).json({ ok: false, error: '裁判不存在，请重新选择姓名' });
    if (judgeObj.active === false) return res.status(403).json({ ok: false, error: '该裁判已被停用' });
    const lanes = Math.max(1, Math.min(MAX_LANES, Number(state.event.lanes) || 8));
    if (!Number.isFinite(laneNo) || laneNo < 1 || laneNo > MAX_LANES) {
      return res.status(400).json({ ok: false, error: '道次不合法' });
    }
    if (laneNo > lanes) return res.status(400).json({ ok: false, error: `本场仅 ${lanes} 道` });

    // 空值 = 清除该老师这条记录
    if (time === null || time === undefined || time === '' || ms === null) {
      if (state.entries[String(laneNo)]) delete state.entries[String(laneNo)][judgeId];
      const snap = emit();
      return res.json({ ok: true, deleted: true, lane: laneNo, state: snap });
    }

    const value = Number.isFinite(Number(ms)) && ms !== undefined ? Math.round(Number(ms)) : parseTimeInput(time);
    if (!Number.isFinite(value) || value == null) {
      return res.status(400).json({ ok: false, error: '时间格式无法识别，例：12.34 / 1:02.34' });
    }
    if (value < MS_MIN || value > MS_MAX) {
      return res.status(400).json({ ok: false, error: `时间超出范围（${formatTime(MS_MIN)} ~ 1:00:00）` });
    }
    if (!state.entries[String(laneNo)]) state.entries[String(laneNo)] = {};
    const prev = state.entries[String(laneNo)][judgeId];
    state.entries[String(laneNo)][judgeId] = {
      ms: value,
      src: String(src || 'manual'),
      at: Date.now(),
      raw: raw !== undefined ? String(raw) : formatTime(value),
      revision: (prev?.revision || 0) + 1,
    };

    const autoApplied = maybeAutoApply();
    const snap = emit();
    res.json({
      ok: true,
      lane: laneNo,
      judge: judgeObj.name,
      ms: value,
      text: formatTime(value),
      autoApplied,
      state: snap,
    });
  });

  app.post('/api/timing/entry/delete', (req, res) => {
    ensureState();
    const { judge, lane } = req.body || {};
    const judgeId = String(judge || '').trim();
    const laneNo = Number(lane);
    if (state.entries[String(laneNo)]) delete state.entries[String(laneNo)][judgeId];
    const snap = emit();
    res.json({ ok: true, state: snap });
  });

  // 裁判长手动修正某道最终成绩
  app.post('/api/timing/override', (req, res) => {
    ensureState();
    const { lane, time, by = '主裁判', note = '' } = req.body || {};
    const laneNo = String(Number(lane));
    if (time === null || time === undefined || time === '') {
      delete state.overrides[laneNo];
    } else {
      const value = parseTimeInput(time);
      if (!Number.isFinite(value) || value == null) {
        return res.status(400).json({ ok: false, error: '时间格式无法识别' });
      }
      state.overrides[laneNo] = { ms: value, by: String(by), note: String(note), at: Date.now() };
    }
    const snap = emit();
    res.json({ ok: true, state: snap });
  });

  // 配置：裁判名单 / 去极值规则 / 页面开关
  app.post('/api/timing/config', (req, res) => {
    ensureState();
    const body = req.body || {};
    if (Array.isArray(body.judges)) {
      state.judges = body.judges
        .map((j, i) => ({
          id: String(j?.id || `j${i + 1}`),
          name: String(j?.name || `计时${i + 1}`).slice(0, 20),
          active: j?.active !== false,
        }))
        .filter((j) => j.id);
    }
    if (body.trim && typeof body.trim === 'object') {
      const t = body.trim;
      state.trim = {
        ...state.trim,
        ...(t.enabled !== undefined ? { enabled: !!t.enabled } : {}),
        ...(t.dropCount !== undefined ? { dropCount: Math.max(0, Math.min(3, Math.floor(Number(t.dropCount) || 0))) } : {}),
        ...(t.minJudges !== undefined ? { minJudges: Math.max(3, Math.floor(Number(t.minJudges) || 3)) } : {}),
        ...(t.roundTo !== undefined ? { roundTo: [1, 10, 100].includes(Number(t.roundTo)) ? Number(t.roundTo) : 10 } : {}),
        ...(t.warnSpreadMs !== undefined ? { warnSpreadMs: Math.max(0, Number(t.warnSpreadMs) || 0) } : {}),
        ...(t.autoApply !== undefined ? { autoApply: !!t.autoApply } : {}),
        ...(t.autoApplyMin !== undefined ? { autoApplyMin: Math.max(1, Math.floor(Number(t.autoApplyMin) || 3)) } : {}),
      };
    }
    if (body.ui && typeof body.ui === 'object') {
      state.ui = {
        ...state.ui,
        ...(body.ui.hideOthersOnEntry !== undefined ? { hideOthersOnEntry: !!body.ui.hideOthersOnEntry } : {}),
        ...(body.ui.stopwatch !== undefined ? { stopwatch: !!body.ui.stopwatch } : {}),
        ...(body.ui.followSystemClock !== undefined ? { followSystemClock: !!body.ui.followSystemClock } : {}),
      };
    }
    if (body.enabled !== undefined) state.enabled = !!body.enabled;
    if (body.event && typeof body.event === 'object') {
      state.event = {
        ...state.event,
        ...['eventName', 'category', 'round', 'heat'].reduce((acc, k) => {
          if (body.event[k] !== undefined) acc[k] = String(body.event[k]);
          return acc;
        }, {}),
        ...(body.event.lanes !== undefined
          ? { lanes: Math.max(1, Math.min(MAX_LANES, Number(body.event.lanes) || 8)) }
          : {}),
      };
      state.roundKey = eventKeyOf(state.event);
    }
    state.updatedAt = Date.now();
    const snap = emit();
    res.json({ ok: true, state: snap });
  });

  // 写入叠加层
  app.post('/api/timing/apply', (req, res) => {
    ensureState();
    const { lanes: laneList, by = '主裁判', withEvent = false } = req.body || {};
    const written = applyResults({ lanes: laneList, by, withEvent });
    res.json({ ok: true, written, state: withUrls(req) });
  });

  // 重置本轮 / 清空某道
  app.post('/api/timing/reset', (req, res) => {
    ensureState();
    const { scope = 'round', lane } = req.body || {};
    if (scope === 'lane') {
      const key = String(Number(lane));
      delete state.entries[key];
      delete state.overrides[key];
    } else if (scope === 'overrides') {
      state.overrides = {};
      state.appliedAt = null;
    } else {
      state.entries = {};
      state.overrides = {};
      state.appliedAt = null;
      state.appliedRecord = null;
    }
    state.updatedAt = Date.now();
    const snap = emit();
    res.json({ ok: true, state: snap });
  });

  // 导出本轮 CSV（Excel 可直接打开）
  app.get('/api/timing/export.csv', (req, res) => {
    ensureState();
    const snap = buildSnapshot();
    const judges = state.judges;
    const header = [
      '道次', '姓名',
      ...judges.map((j) => j.name),
      '去掉最高/最低', '平均成绩', '手动修正', '最终成绩', '名次', '备注',
    ];
    const rows = Object.values(snap.lanes).map((l) => {
      const byJudge = {};
      l.values.forEach((v) => { byJudge[v.judgeId] = v; });
      return [
        l.lane,
        opts.getLaneName?.(l.lane) || '',
        ...judges.map((j) => {
          const v = byJudge[j.id];
          if (!v) return '';
          return v.dropped ? `${v.text}(删)` : v.text;
        }),
        l.dropped.join(' / '),
        l.avgText,
        l.overrideText,
        l.finalText,
        snap.places[String(l.lane)] || '',
        l.reason || '',
      ];
    });
    const csv = [header, ...rows]
      .map((r) => r.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const eventName = `${state.event.category || ''}${state.event.eventName || ''}`.trim() || '成绩';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(`${eventName}_${state.event.round || ''}_${state.event.heat || ''}_计时汇总.csv`)}"`,
    );
    res.send('\ufeff' + csv);
  });

  // 二维码：老师扫码进入录入页
  app.get('/api/timing/qr.svg', async (req, res) => {
    const data = String(req.query.data || entryUrlOf(req));
    const size = Math.max(120, Math.min(1024, Number(req.query.size) || 240));
    try {
      // eslint-disable-next-line global-require
      const QRCode = require('qrcode');
      const svg = await QRCode.toString(data, {
        type: 'svg', margin: 1, width: size, errorCorrectionLevel: 'M',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.type('image/svg+xml').send(svg);
    } catch (e) {
      res.status(500).json({ ok: false, error: '二维码生成失败', detail: String(e?.message || e) });
    }
  });

  // 主控台一键广播“发令/开始”（可选，方便老师页面本地跑表对齐）
  app.post('/api/timing/gun', (req, res) => {
    const at = Date.now();
    if (io) io.emit('timing:gun', { at });
    res.json({ ok: true, at });
  });

  logger.info?.('[计时] 录入模块已挂载：/timer/（老师录入页） /timer/monitor.html（裁判长页）');
  return {
    syncEvent,
    applyResults,
    buildSnapshot,
    computeLanes,
    getState: () => state,
    emit,
  };
}

module.exports = {
  register,
  formatTime,
  parseTimeInput,
  aggregate,
  rankLanes,
  eventKeyOf,
  MAX_LANES,
  MS_MIN,
  MS_MAX,
};
