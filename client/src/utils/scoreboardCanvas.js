/**
 * 叠加层 canvas 渲染入口
 *
 * 叠加层（田径信息条 / 球队比分条 / 选手介绍）在页面上是 DOM，MediaRecorder 只能抓到
 * <video> 本身，抓不到 DOM。录制「有成绩条」那份时必须把叠加层画进 canvas —— 这里就是
 * 分发与绘制逻辑：布局与 ScoreboardOverlay.jsx / AthleteIntro.jsx 及其 CSS 对齐，
 * 按画面尺寸等比缩放（默认以 1280 宽为基准，选手介绍用 cqh/cqw 百分比）。
 *
 * 原子操作在 canvasKit.js，选手介绍在 introCanvas.js。
 */
import {
  fontOf, roundRect, panel, boxShadow, clearShadow,
  chipWidth, drawChip, layoutChips,
} from './canvasKit.js';
import { drawIntro } from './introCanvas.js';

/** 与 ScoreboardOverlay.jsx 的 formatMs 保持一致 */
export function formatMs(ms) {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  if (m > 0) {
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
  return `${s}.${String(cs).padStart(2, '0')}`;
}

/** 与 ScoreboardOverlay 的 useLiveClock 同源：跑表中走真实时间，否则用静态读数 */
export function clockText(config, now = Date.now()) {
  const running = !!config?.clockRunning;
  const startAt = Number(config?.clockStartAt) || 0;
  const offset = Number(config?.clockOffsetMs) || 0;
  if (running && startAt) return formatMs(offset + (now - startAt));
  return config?.clock || formatMs(offset);
}

const f = fontOf;

// ─── 田径信息条 ───────────────────────────────────────────────────────────────

function trackPodiumList(config) {
  if (!config.showPodium) return [];
  return (config.athletes || [])
    .filter(a => a?.place && a?.name)
    .sort((a, b) => (Number(a.place) || 99) - (Number(b.place) || 99))
    .slice(0, 3);
}

function laneChipWidth(ctx, a, s, showPlaces, showResults) {
  const nameFont = f(14 * s, 600);
  const unitFont = f(10 * s, 500);
  const metaFont = f(12 * s, 700);
  const padX = 8 * s;
  const gap = 6 * s;
  let w = padX * 2 + 18 * s; // 道次方块
  w += gap;
  ctx.font = nameFont;
  w += ctx.measureText(a.name || '—').width;
  if (a.unit) {
    ctx.font = unitFont;
    w += 6 * s + ctx.measureText(a.unit).width;
  }
  if (showPlaces && a.place) {
    ctx.font = metaFont;
    w += gap + Math.max(ctx.measureText(String(a.place)).width, 14 * s);
  }
  if (showResults && a.result) {
    ctx.font = metaFont;
    w += gap + ctx.measureText(String(a.result)).width;
  }
  return w;
}

function drawLaneChip(ctx, a, x, y, s, showPlaces, showResults, h) {
  const w = laneChipWidth(ctx, a, s, showPlaces, showResults);
  const rank = String(a.place || '');
  const accent = rank === '1'
    ? 'rgba(251,191,36,0.7)'
    : rank === '2'
      ? 'rgba(203,213,225,0.7)'
      : rank === '3'
        ? 'rgba(217,119,6,0.7)'
        : 'rgba(255,255,255,0.12)';

  panel(ctx, x, y, w, h, 6 * s, 'rgba(255,255,255,0.06)', accent, 1);

  const gap = 6 * s;
  const box = 18 * s;
  let cx = x + 8 * s;
  // 道次号码块
  panel(ctx, cx, y + (h - box) / 2, box, box, 4 * s, '#f59e0b');
  ctx.font = f(11 * s, 800);
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(a.lane ?? ''), cx + box / 2, y + h / 2 + 0.5);
  cx += box + gap;

  ctx.textAlign = 'left';
  ctx.font = f(14 * s, 600);
  ctx.fillStyle = '#f5f5f7';
  const name = a.name || '—';
  ctx.fillText(name, cx, y + h / 2 + 0.5);
  cx += ctx.measureText(name).width;

  if (a.unit) {
    ctx.font = f(10 * s, 500);
    ctx.fillStyle = '#9ca3af';
    ctx.fillText(a.unit, cx + 6 * s, y + h / 2 + 0.5);
    cx += 6 * s + ctx.measureText(a.unit).width;
  }
  if (showPlaces && a.place) {
    ctx.font = f(12 * s, 800);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(String(a.place), cx + gap, y + h / 2 + 0.5);
    cx += gap + Math.max(ctx.measureText(String(a.place)).width, 14 * s);
  }
  if (showResults && a.result) {
    ctx.font = f(12 * s, 700);
    ctx.fillStyle = '#7dd3fc';
    ctx.fillText(String(a.result), cx + gap, y + h / 2 + 0.5);
  }
  return w;
}

function drawTrackBug(ctx, config, w, h, s, now) {
  const {
    eventName = '',
    category = '',
    round = '',
    heat = '',
    wind = '',
    mr = '',
    sb = '',
    eventKind = 'sprint',
    showPlaces = true,
    showResults = true,
    showClock = true,
    attempt = 1,
    attemptsTotal = 6,
    bestMark = '',
    laps = [],
  } = config;

  const isField = eventKind === 'field';
  const vw = w / 100; // CSS clamp(...vw) 在成片里按画面宽度近似
  const px = (lo, frac, hi) => Math.max(lo, Math.min(vw * frac, hi)) * s;

  const headPadX = 14 * s;
  const headH = 40 * s;
  const gap = 10 * s;
  const chipH = 22 * s;
  const chipFont = f(px(10, 1.1, 12), 700);
  const chipPadX = 8 * s;

  const title = category && eventName && !eventName.startsWith(category)
    ? `${category} ${eventName}`
    : eventName;

  // head 左区元素（title 无底色，其余是胶囊）
  const headItems = [];
  if (title) {
    headItems.push({
      label: title,
      spec: { font: f(px(14, 1.7, 18), 700), color: '#ffffff', h: chipH, padX: 0 },
    });
  }
  if (round) {
    headItems.push({
      label: round,
      spec: {
        font: chipFont, color: '#fde68a', padX: chipPadX, h: chipH,
        bg: 'rgba(0,0,0,0.35)', border: 'rgba(253,230,138,0.35)',
      },
    });
  }
  if (heat && !isField) {
    headItems.push({
      label: heat,
      spec: {
        font: chipFont, color: '#e5e7eb', padX: chipPadX, h: chipH,
        bg: 'rgba(255,255,255,0.10)', border: 'rgba(255,255,255,0.18)',
      },
    });
  }
  if (wind) {
    const num = Number(String(wind).replace('m/s', '').trim());
    const neg = Number.isFinite(num) && num < 0;
    headItems.push({
      label: `风速 ${wind}`,
      spec: {
        font: chipFont, color: neg ? '#fde68a' : '#bae6fd', padX: chipPadX, h: chipH,
        bg: neg ? 'rgba(253,230,138,0.12)' : 'rgba(14,165,233,0.18)',
        border: neg ? 'rgba(253,230,138,0.35)' : 'rgba(14,165,233,0.35)',
      },
    });
  }
  if (mr) {
    headItems.push({
      label: `MR ${mr}`,
      spec: {
        font: chipFont, color: '#fca5a5', padX: chipPadX, h: chipH,
        bg: 'rgba(239,68,68,0.18)', border: 'rgba(239,68,68,0.40)',
      },
    });
  }
  if (sb) {
    headItems.push({
      label: `SB ${sb}`,
      spec: {
        font: chipFont, color: '#c4b5fd', padX: chipPadX, h: chipH,
        bg: 'rgba(167,139,250,0.15)', border: 'rgba(167,139,250,0.40)',
      },
    });
  }
  if (isField) {
    headItems.push({
      label: `第 ${attempt}/${attemptsTotal} 试${bestMark ? `   最佳 ${bestMark}` : ''}`,
      spec: {
        font: chipFont, color: '#fde68a', padX: chipPadX, h: chipH,
        bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.40)',
      },
    });
  }

  const clock = showClock ? clockText(config, now) : '';
  const clockFont = f(px(16, 2, 22), 700, true);
  ctx.font = clockFont;
  const clockW = clock ? ctx.measureText(clock).width : 0;

  const headContentW = headItems.reduce((acc, it, i) =>
    acc + chipWidth(ctx, it.label, it.spec) + (i ? gap : 0), 0);
  const headRowW = headContentW + (clockW ? clockW + gap * 2 : 0);

  // ── 罗列道次 / 成绩榜 / 分圈 的高度，用来定框体尺寸 ──
  const laneH = 26 * s;
  const laneGap = 6 * s;
  const lanesPadX = 10 * s;
  const podium = trackPodiumList(config);
  const list = (config.athletes || []).filter(a => a?.name || a?.place || a?.result);

  const minBoxW = Math.min(w * 0.88, 720 * s);
  const maxBoxW = Math.min(w * 0.96, 900 * s);
  const boxW = Math.max(minBoxW, Math.min(maxBoxW, headRowW + headPadX * 2));
  const innerW = boxW - lanesPadX * 2;

  let bodyH = 0;
  if (podium.length) {
    const rowH = 34 * s;
    bodyH += 8 * s + podium.length * rowH + (podium.length - 1) * 4 * s + 10 * s;
  } else if (list.length) {
    const rows = layoutChips(
      ctx,
      list.map(a => ({ label: a.name || '—', spec: { font: f(14 * s, 600), color: '#fff', padX: 0, h: laneH } })),
      lanesPadX, 0, innerW, laneGap, false,
    );
    bodyH += 8 * s + rows + 10 * s;
  }
  bodyH += (laps?.length ? 20 * s + 8 * s : 0);

  const boxH = headH + bodyH;
  const top = (config.position || 'bottom') === 'top';
  const x = (w - boxW) / 2;
  // 内容超高时贴顶兜底，避免整条跑出画面
  const y = top ? h * 0.035 : Math.max(h * 0.01, h - h * 0.045 - boxH);

  // ── 框体 ──
  ctx.save();
  boxShadow(ctx, s, 24, 0.5);
  roundRect(ctx, x, y, boxW, boxH, 8 * s);
  ctx.fillStyle = 'rgba(8,10,16,0.92)';
  ctx.fill();
  clearShadow(ctx);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.stroke();

  // 头部渐变底 + 分隔线（裁剪在圆角内）
  ctx.save();
  roundRect(ctx, x, y, boxW, boxH, 8 * s);
  ctx.clip();
  const grad = ctx.createLinearGradient(x, y, x + boxW, y);
  grad.addColorStop(0, 'rgba(239,68,68,0.35)');
  grad.addColorStop(0.4, 'rgba(15,23,42,0.90)');
  grad.addColorStop(1, 'rgba(15,23,42,0.90)');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, boxW, headH);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(x, y + headH, boxW, Math.max(1, 1 * s));
  ctx.restore();

  // ── 头部：左侧元素 + 右侧时钟 ──
  let cx = x + headPadX;
  const cy = y + (headH - chipH) / 2;
  const leftMax = boxW - headPadX * 2 - (clockW ? clockW + gap : 0);
  let rowX = 0;
  for (const it of headItems) {
    const iw = chipWidth(ctx, it.label, it.spec);
    if (rowX && rowX + iw > leftMax) break; // 放不下就省略，避免压到时钟
    drawChip(ctx, it.label, cx, cy, it.spec);
    cx += iw + gap;
    rowX += iw + gap;
  }
  if (clock) {
    ctx.font = clockFont;
    ctx.fillStyle = config.clockRunning ? '#4ade80' : '#ffffff';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(clock, x + boxW - headPadX, y + headH / 2 + 0.5);
  }

  // ── 主体 ──
  let by = y + headH;
  if (podium.length) {
    by += 8 * s;
    const rowH = 34 * s;
    for (const a of podium) {
      const rankColor = a.place === '1' ? '#fbbf24' : a.place === '2' ? '#cbd5e1' : '#d97706';
      panel(ctx, x + 12 * s, by, boxW - 24 * s, rowH, 6 * s,
        a.place === '1' ? 'rgba(251,191,36,0.12)' : 'rgba(255,255,255,0.05)');
      ctx.fillStyle = rankColor;
      ctx.fillRect(x + 12 * s, by, 3 * s, rowH);

      let px2 = x + 12 * s + 10 * s;
      ctx.textAlign = 'center';
      ctx.font = f(18 * s, 800);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(a.place), px2 + 10 * s, by + rowH / 2 + 0.5);
      px2 += 24 * s;

      ctx.textAlign = 'left';
      ctx.font = f(px(14, 1.5, 18), 700);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(a.name, px2 + 10 * s, by + rowH / 2 + 0.5);
      px2 += 10 * s + ctx.measureText(a.name).width;
      if (a.unit) {
        ctx.font = f(12 * s, 500);
        ctx.fillStyle = '#9ca3af';
        ctx.fillText(a.unit, px2 + 10 * s, by + rowH / 2 + 0.5);
      }
      if (a.result) {
        ctx.textAlign = 'right';
        ctx.font = f(16 * s, 800);
        ctx.fillStyle = '#7dd3fc';
        ctx.fillText(String(a.result), x + boxW - 22 * s, by + rowH / 2 + 0.5);
        ctx.textAlign = 'left';
      }
      by += rowH + 4 * s;
    }
    by += 6 * s; // 补足底部内边距（循环里每行已多加 4px）
  } else if (list.length) {
    by += 8 * s;
    let lx = x + lanesPadX;
    let rowTop = by;
    for (const a of list) {
      const cw = laneChipWidth(ctx, a, s, showPlaces, showResults);
      if (lx > x + lanesPadX && lx + cw > x + boxW - lanesPadX) {
        lx = x + lanesPadX;
        rowTop += laneH + laneGap;
      }
      drawLaneChip(ctx, a, lx, rowTop, s, showPlaces, showResults, laneH);
      lx += cw + laneGap;
    }
    by = rowTop + laneH + 10 * s;
  }

  if (laps?.length) {
    let lx = x + lanesPadX;
    ctx.textAlign = 'left';
    ctx.font = f(10 * s, 600);
    ctx.fillStyle = '#9ca3af';
    ctx.fillText('分圈', lx, by + 10 * s + 0.5);
    lx += ctx.measureText('分圈').width + 6 * s;
    for (const L of laps) {
      const spec = {
        label: String(L), font: f(11 * s, 600, true), color: '#e5e7eb',
        bg: 'rgba(255,255,255,0.08)', padX: 6 * s, h: 18 * s, radius: 4 * s,
      };
      drawChip(ctx, String(L), lx, by + 1 * s, spec);
      lx += chipWidth(ctx, String(L), spec) + 4 * s;
    }
  }

  ctx.restore();
}

// ─── 球队比分条 ───────────────────────────────────────────────────────────────

function drawTeamBar(ctx, config, w, h, s) {
  const {
    homeName = '主队',
    awayName = '客队',
    homeScore = 0,
    awayScore = 0,
    period = '',
    showClock = false,
    homeColor = '#2563eb',
    awayColor = '#dc2626',
  } = config;

  const vw = w / 100;
  const px = (lo, frac, hi) => Math.max(lo, Math.min(vw * frac, hi)) * s;

  const nameFont = f(px(13, 1.6, 18), 600);
  const scoreFont = f(px(18, 2.2, 26), 700);
  const periodFont = f(px(10, 1.1, 12), 600);
  const clockFont = f(px(13, 1.5, 16), 700, true);

  const sidePadX = 14 * s;
  const sideGap = 10 * s;
  const midPadX = 16 * s;

  // 比分数字宽度按「两位数字」保底，避免 0:0 与 12:9 时框体宽度跳动
  ctx.font = scoreFont;
  const scoreMinW = ctx.measureText('00').width;

  const measureSide = (name, score) => {
    ctx.font = nameFont;
    const nw = ctx.measureText(String(name)).width;
    ctx.font = scoreFont;
    const sw = Math.max(ctx.measureText(String(score)).width, scoreMinW);
    return sidePadX * 2 + nw + sw + sideGap;
  };

  ctx.font = periodFont;
  const periodW = period ? ctx.measureText(period).width : 0;
  ctx.font = clockFont;
  const clockW = showClock && config.clock ? ctx.measureText(config.clock).width : 0;
  const midW = Math.max(72 * s, Math.max(periodW, clockW) + midPadX * 2);

  const homeW = measureSide(homeName, homeScore);
  const awayW = measureSide(awayName, awayScore);
  const boxW = homeW + midW + awayW;
  const boxH = Math.max(42 * s, 42 * s);
  const x = (w - boxW) / 2;
  const top = (config.position || 'bottom') === 'top';
  const y = top ? h * 0.035 : Math.max(h * 0.01, h - h * 0.045 - boxH);

  ctx.save();
  boxShadow(ctx, s, 20, 0.45);
  roundRect(ctx, x, y, boxW, boxH, 6 * s);
  ctx.fillStyle = 'rgba(8,10,16,0.88)';
  ctx.fill();
  clearShadow(ctx);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.stroke();

  ctx.save();
  roundRect(ctx, x, y, boxW, boxH, 6 * s);
  ctx.clip();

  // 队色底边 + 顶部浅色渐变
  const homeGrad = ctx.createLinearGradient(0, y, 0, y + boxH);
  homeGrad.addColorStop(0, 'rgba(255,255,255,0.06)');
  homeGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = homeGrad;
  ctx.fillRect(x, y, homeW, boxH);
  ctx.fillStyle = homeColor;
  ctx.fillRect(x, y + boxH - 3 * s, homeW, 3 * s);

  ctx.fillStyle = homeGrad;
  ctx.fillRect(x + homeW + midW, y, awayW, boxH);
  ctx.fillStyle = awayColor;
  ctx.fillRect(x + homeW + midW, y + boxH - 3 * s, awayW, 3 * s);

  // 中段
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(x + homeW, y, midW, boxH);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(x + homeW, y, Math.max(1, 1 * s), boxH);
  ctx.fillRect(x + homeW + midW - 1, y, Math.max(1, 1 * s), boxH);
  ctx.restore();

  // 文字
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  let cx = x + sidePadX;
  ctx.font = nameFont;
  ctx.fillStyle = '#f5f5f7';
  ctx.fillText(homeName, cx, y + boxH / 2 + 0.5);
  cx += ctx.measureText(homeName).width + sideGap;
  ctx.font = scoreFont;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(String(homeScore), cx, y + boxH / 2 + 0.5);

  const awayX = x + homeW + midW;
  cx = awayX + sidePadX;
  ctx.font = scoreFont;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(String(awayScore), cx, y + boxH / 2 + 0.5);
  cx += ctx.measureText(String(awayScore)).width + sideGap;
  ctx.font = nameFont;
  ctx.fillStyle = '#f5f5f7';
  ctx.fillText(awayName, cx, y + boxH / 2 + 0.5);

  const midCx = x + homeW + midW / 2;
  const hasClock = showClock && config.clock;
  if (period) {
    ctx.font = periodFont;
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'center';
    ctx.fillText(period, midCx, hasClock ? y + boxH / 2 - 8 * s : y + boxH / 2 + 0.5);
  }
  if (hasClock) {
    ctx.font = clockFont;
    ctx.fillStyle = '#e5e7eb';
    ctx.textAlign = 'center';
    ctx.fillText(config.clock, midCx, y + boxH / 2 + 9 * s);
  }
  ctx.restore();
}

/**
 * 把当前叠加层配置画到录制画布上（成片与 PGM 监看一致）
 * @param {CanvasRenderingContext2D} ctx
 * @param {object|null} config /api/scoreboard 返回的配置（含 mode: track | team | intro）
 * @param {number} w 画布宽
 * @param {number} h 画布高
 * @param {number} [now] 仅供测试注入时间
 */
export function drawScoreboard(ctx, config, w, h, now = Date.now()) {
  if (!ctx || !config?.enabled || !w || !h) return;

  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  try {
    const mode = config.mode || 'track';
    if (mode === 'intro') {
      if (config.introVisible === false) return; // 已隐藏，不上屏
      drawIntro(ctx, config, w, h, now);
      return;
    }
    const s = Math.max(0.35, w / 1280);
    if (mode === 'team') drawTeamBar(ctx, config, w, h, s);
    else drawTrackBug(ctx, config, w, h, s, now);
  } finally {
    ctx.restore();
  }
}

/** 别名：drawScoreboard 现在同时覆盖比分条与选手介绍 */
export const drawOverlay = drawScoreboard;
