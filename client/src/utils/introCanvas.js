/**
 * 选手介绍叠加层 → canvas 渲染
 *
 * 对应组件 AthleteIntro.jsx + AthleteIntro.css 的三种样式：
 *   card   单人卡（居中大卡）
 *   lower  底部字幕条
 *   roster 名册（每屏 N 位 + 页码点）
 *
 * 尺寸单位与 CSS 一致：cqh = 画面高 / 100，cqw = 画面宽 / 100；
 * CSS 里 `font-size: 14px; font-size: 3cqh;` 这类兜底在容器查询生效时以 cqh 为准，
 * 所以这里只用 cqh/cqw，只有 min-width/min-height 这类硬下限按 px 保留。
 */
import {
  fontOf, panel, roundRect, setLetterSpacing,
  fitText, wrapText, chipWidth, drawChip, layoutChips, drawPhoto, drawProgressBar,
} from './canvasKit.js';

const AMBER = '#f59e0b';
const AMBER_DARK = '#14171d';

/** 自动轮播 / 自动隐藏进度：DOM 靠元素重挂载触发的 CSS 动画，这里用 key 变化近似 */
let progressClock = { key: '', startedAt: 0 };

function introProgress(config, now) {
  const auto = config.introAuto && Number(config.introAutoMs) > 0;
  const hold = Number(config.introHold) > 0;
  if (!auto && !hold) return null;
  const ms = auto ? Math.max(2000, Number(config.introAutoMs)) : Number(config.introHold) * 1000;
  const key = [config.introIndex, config.introStyle, config.eventName, config.introVisible, ms].join('|');
  if (progressClock.key !== key) progressClock = { key, startedAt: now };
  return Math.max(0, Math.min(1, (now - progressClock.startedAt) / ms));
}

function eventLine(config) {
  const name = String(config.eventName || '').trim();
  const cat = String(config.category || '').trim();
  const title = cat && name && !name.startsWith(cat) ? `${cat} ${name}` : name;
  return [title, config.round, config.heat].filter(Boolean).join(' · ');
}

/** 信息芯片：号码 / 道次 / 最好成绩（尺寸随样式传入，card 与 lower 的间距不同） */
function statChips(athlete, config, size, cqh, cqw, opt = {}) {
  const padX = opt.padX != null ? opt.padX : size * 0.34;
  const padY = opt.padY != null ? opt.padY : 0.5 * cqh;
  const spec = {
    font: fontOf(size, 700),
    padX,
    h: size + padY * 2,
    radius: 999,
  };
  const items = [];
  if (athlete?.bib) {
    items.push({
      label: `No.${athlete.bib}`,
      spec: { ...spec, color: '#cbd5e1', bg: 'rgba(255,255,255,0.08)', border: 'rgba(255,255,255,0.16)' },
    });
  }
  if (athlete?.lane != null && athlete.lane !== '') {
    items.push({
      label: `${athlete.lane} 道`,
      spec: { ...spec, color: '#fde68a', bg: 'rgba(245,158,11,0.16)', border: 'rgba(245,158,11,0.42)' },
    });
  }
  if (config.introShowPb !== false && athlete?.pb) {
    items.push({
      label: `PB ${athlete.pb}`,
      spec: { ...spec, color: '#bfdbfe', bg: 'rgba(59,130,246,0.16)', border: 'rgba(96,165,250,0.40)' },
    });
  }
  // gap 取自 CSS `.intro-stats { gap: 0.8cqh 0.9cqw }`
  return { items, gapX: 0.9 * cqw, gapY: 0.8 * cqh };
}

function drawChipRow(ctx, chipBox, x, y, maxW) {
  if (!chipBox.items.length) return 0;
  return layoutChips(ctx, chipBox.items, x, y, maxW, chipBox.gapX, true);
}

/** 页眉：标签 + 项目行 + 序号；返回高度 */
function drawIntroHead(ctx, config, index, total, x, y, maxW, cqh, cqw) {
  const tagSize = 2.6 * cqh;
  const eventSize = 2.9 * cqh;
  const countSize = 3 * cqh;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = fontOf(tagSize, 800);
  setLetterSpacing(ctx, tagSize * 0.16);
  const tagText = String(config.introTitle || '选手介绍').toUpperCase();
  const tagW = ctx.measureText(tagText).width + 2.4 * cqw;
  const tagH = tagSize + 1.2 * cqh;
  panel(ctx, x, y, tagW, tagH, 0.6 * cqh, AMBER);
  ctx.fillStyle = '#111111';
  ctx.fillText(tagText, x + 1.2 * cqw, y + tagH / 2 + 0.5);
  setLetterSpacing(ctx, 0);

  let cx = x + tagW + 1.4 * cqw;
  const line = eventLine(config);
  ctx.font = fontOf(eventSize, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  if (line) {
    const t = fitText(ctx, line, Math.max(0, x + maxW - cx - 8 * cqw));
    ctx.fillText(t, cx, y + tagH / 2 + 0.5);
  }

  if (total > 1) {
    ctx.font = fontOf(countSize, 800);
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'right';
    ctx.fillText(`${index + 1} / ${total}`, x + maxW, y + tagH / 2 + 0.5);
    ctx.textAlign = 'left';
  }
  return tagH;
}

// ─── 样式一：单人卡 ──────────────────────────────────────────────────────────

function drawIntroCard(ctx, config, athlete, index, total, w, h, cqh, cqw, now) {
  const cardW = Math.min(76 * cqw, 1180);
  const photoW = Math.max(26 * cqw, 90);
  const photoH = Math.max(38 * cqh, 130);
  const accentW = 0.6 * cqh;
  const gap = 2.2 * cqw;
  const padR = 2.4 * cqw;
  const padY = 3 * cqh;

  const nameSize = 9 * cqh;
  const laneBox = Math.max(6 * cqh, 26);
  const unitSize = 3.8 * cqh;
  const chipSize = 3 * cqh;
  const noteSize = 3.1 * cqh;
  const rowGap = 1.2 * cqh;

  const contentW = Math.max(40, cardW - accentW - photoW - gap - padR);
  const note = config.introShowNote !== false && athlete.note ? String(athlete.note) : '';
  ctx.font = fontOf(noteSize, 400);
  const noteLines = note ? wrapText(ctx, note, contentW, 2) : [];

  const chipBox = statChips(athlete, config, chipSize, cqh, cqw);
  const rows = [];
  rows.push(Math.max(nameSize * 1.05, laneBox));
  if (athlete.unit) rows.push(unitSize * 1.25);
  if (chipBox.items.length) rows.push(chipSize + cqh);
  if (noteLines.length) rows.push(noteLines.length * noteSize * 1.35);
  const headH = Math.max(2.6 * cqh + 1.2 * cqh, 2.9 * cqh, 3 * cqh);

  const bodyH = rows.reduce((a, b) => a + b, 0) + rowGap * Math.max(0, rows.length - 1)
    + 0.6 * cqh + 1.6 * cqh + 1 + headH + padY * 2; // 页眉的上边距/上内边距/分隔线
  const cardH = Math.max(photoH, bodyH);
  const x = (w - cardW) / 2;
  const y = (h - cardH) / 2;

  ctx.save();
  const g = ctx.createLinearGradient(x, y, x + cardW, y + cardH);
  g.addColorStop(0, 'rgba(11,14,20,0.94)');
  g.addColorStop(1, 'rgba(20,26,38,0.90)');
  panel(ctx, x, y, cardW, cardH, 1.2 * cqh, g, 'rgba(255,255,255,0.16)', 1);

  ctx.save();
  roundRect(ctx, x, y, cardW, cardH, 1.2 * cqh);
  ctx.clip();

  // 左侧橙色竖条
  ctx.fillStyle = AMBER;
  ctx.fillRect(x, y, accentW, cardH);

  // 头像（卡片内为矩形，直角）
  drawPhoto(ctx, athlete, x + accentW, y, photoW, cardH, 0, 8 * cqh);

  const bodyX = x + accentW + photoW + gap;
  let by = y + (cardH - (bodyH - padY * 2)) / 2;

  // 姓名行：道次徽标 + 姓名
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let nameX = bodyX;
  if (athlete.lane != null && athlete.lane !== '') {
    panel(ctx, bodyX, by + (rows[0] - laneBox) / 2, laneBox, laneBox, 1 * cqh, 'rgba(245,158,11,0.90)');
    ctx.font = fontOf(3.4 * cqh, 900);
    ctx.fillStyle = AMBER_DARK;
    ctx.textAlign = 'center';
    ctx.fillText(String(athlete.lane), bodyX + laneBox / 2, by + rows[0] / 2 + 0.5);
    ctx.textAlign = 'left';
    nameX = bodyX + laneBox + 1.4 * cqw;
  }
  ctx.font = fontOf(nameSize, 800);
  setLetterSpacing(ctx, nameSize * 0.05);
  ctx.fillStyle = '#f5f5f7';
  ctx.fillText(fitText(ctx, athlete.name || '待录入姓名', bodyX + contentW - (nameX - bodyX)),
    nameX, by + rows[0] / 2 + 0.5);
  setLetterSpacing(ctx, 0);
  by += rows[0] + rowGap;

  if (athlete.unit) {
    ctx.font = fontOf(unitSize, 600);
    setLetterSpacing(ctx, unitSize * 0.04);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillText(fitText(ctx, athlete.unit, contentW), bodyX, by + rows[1] / 2 + 0.5);
    setLetterSpacing(ctx, 0);
    by += rows[1] + rowGap;
  }

  if (chipBox.items.length) {
    drawChipRow(ctx, chipBox, bodyX, by, contentW);
    by += chipSize + cqh + rowGap;
  }

  if (noteLines.length) {
    ctx.font = fontOf(noteSize, 400);
    ctx.fillStyle = 'rgba(226,232,240,0.78)';
    noteLines.forEach((ln, i) => {
      ctx.fillText(ln, bodyX, by + noteSize * 1.35 * (i + 0.5));
    });
    by += noteLines.length * noteSize * 1.35 + rowGap;
  }

  // 页眉（顶部分隔线）
  by += 0.6 * cqh;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(bodyX, by, contentW, 1);
  by += 1.6 * cqh;
  drawIntroHead(ctx, config, index, total, bodyX, by, contentW, cqh, cqw);

  const progress = introProgress(config, now);
  if (progress != null) drawProgressBar(ctx, x, y + cardH - 0.6 * cqh, cardW, 0.6 * cqh, progress);

  ctx.restore();
  ctx.restore();
}

// ─── 样式二：底部字幕条 ──────────────────────────────────────────────────────

function drawIntroLower(ctx, config, athlete, index, total, w, h, cqh, cqw, now) {
  const barW = Math.min(84 * cqw, 1400);
  const padY = 1.8 * cqh;
  const padR = 2.4 * cqw;
  const gap = 1.6 * cqw;
  const accentW = 0.7 * cqh;
  const accentH = Math.max(9 * cqh, 40);
  const photoS = Math.max(9 * cqh, 40);
  const nameSize = 6 * cqh;
  const unitSize = 3.2 * cqh;
  const chipSize = 2.6 * cqh;
  const noteSize = 2.9 * cqh;
  const titleSize = 2.2 * cqh;
  const countSize = 2.8 * cqh;

  const note = config.introShowNote !== false && athlete.note ? String(athlete.note) : '';
  const chipBox = statChips(athlete, config, chipSize, cqh, cqw, { padX: 0.8 * cqw, padY: 0.35 * cqh });

  ctx.font = fontOf(titleSize, 800);
  setLetterSpacing(ctx, titleSize * 0.18);
  const titleW = ctx.measureText(String(config.introTitle || '选手介绍').toUpperCase()).width;
  setLetterSpacing(ctx, 0);
  ctx.font = fontOf(countSize, 700);
  const countW = total > 1 ? ctx.measureText(`${index + 1}/${total}`).width : 0;
  const tailW = Math.max(titleW, countW);

  const bodyH = nameSize * 1.1 + 0.6 * cqh + Math.max(unitSize * 1.2, chipBox.items.length ? chipSize + 0.7 * cqh : 0);
  const contentH = Math.max(photoS, accentH, bodyH, note ? noteSize * 2.7 : 0);
  const barH = contentH + padY * 2;
  const x = (w - barW) / 2;
  const y = h - 6 * cqh - barH;

  const fixedW = accentW + photoS + tailW + padR + gap * (note ? 4 : 3);
  const noteW = note ? Math.min(26 * cqw, Math.max(60, barW - fixedW - 120)) : 0;
  const bodyW = Math.max(60, barW - fixedW - noteW);

  ctx.save();
  const g = ctx.createLinearGradient(x, y, x + barW, y);
  g.addColorStop(0, 'rgba(9,12,18,0.95)');
  g.addColorStop(1, 'rgba(16,21,31,0.88)');
  panel(ctx, x, y, barW, barH, 1 * cqh, g, 'rgba(255,255,255,0.14)', 1);

  ctx.save();
  roundRect(ctx, x, y, barW, barH, 1 * cqh);
  ctx.clip();

  let cx = x;
  // 左侧橙色竖条
  const accentGrad = ctx.createLinearGradient(0, y, 0, y + accentH);
  accentGrad.addColorStop(0, '#fbbf24');
  accentGrad.addColorStop(1, AMBER);
  panel(ctx, cx, y + (barH - accentH) / 2, accentW, accentH, 999, accentGrad);
  cx += accentW + gap;

  // 圆形头像 + 橙色描边
  const photoY = y + (barH - photoS) / 2;
  ctx.beginPath();
  ctx.arc(cx + photoS / 2, photoY + photoS / 2, photoS / 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fill();
  const ringR = photoS / 2 - 0.2 * cqh;
  drawPhoto(ctx, athlete, cx + 0.2 * cqh, photoY + 0.2 * cqh, photoS - 0.4 * cqh, photoS - 0.4 * cqh,
    (photoS - 0.4 * cqh) / 2, 3.4 * cqh);
  ctx.beginPath();
  ctx.arc(cx + photoS / 2, photoY + photoS / 2, ringR, 0, Math.PI * 2);
  ctx.lineWidth = 0.4 * cqh;
  ctx.strokeStyle = 'rgba(245,158,11,0.65)';
  ctx.stroke();
  cx += photoS + gap;

  // 姓名 + 单位 / 芯片
  let ty = photoY + (photoS - bodyH) / 2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = fontOf(nameSize, 800);
  setLetterSpacing(ctx, nameSize * 0.05);
  ctx.fillStyle = '#f5f5f7';
  ctx.fillText(fitText(ctx, athlete.name || '待录入姓名', bodyW), cx, ty + nameSize * 0.55);
  setLetterSpacing(ctx, 0);
  ty += nameSize * 1.1 + 0.6 * cqh;

  let subX = cx;
  if (athlete.unit) {
    ctx.font = fontOf(unitSize, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.80)';
    const subW = Math.min(bodyW * 0.5, ctx.measureText(athlete.unit).width);
    ctx.fillText(fitText(ctx, athlete.unit, subW), subX, ty + Math.max(unitSize, chipSize) * 0.6);
    subX += subW + 1 * cqw;
  }
  if (chipBox.items.length) {
    const chipH = chipSize + 0.7 * cqh;
    const avail = Math.max(0, cx + bodyW - subX);
    layoutChips(ctx, chipBox.items, subX, ty + Math.max(unitSize, chipH) * 0.6 - chipH / 2, avail, chipBox.gapX, true);
  }
  cx += bodyW + gap;

  // 亮点（左分隔线 + 最多两行）
  if (note) {
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(cx, y + (barH - noteSize * 2.7) / 2, 1, noteSize * 2.7);
    ctx.font = fontOf(noteSize, 400);
    ctx.fillStyle = 'rgba(226,232,240,0.72)';
    const lines = wrapText(ctx, note, noteW - 1.4 * cqw, 2);
    lines.forEach((ln, i) => {
      ctx.fillText(ln, cx + 1.4 * cqw, y + barH / 2 - (lines.length * noteSize * 1.3) / 2 + noteSize * 1.3 * (i + 0.5));
    });
    cx += noteW + gap;
  }

  // 尾标：标题 + 序号（右对齐）
  ctx.textAlign = 'right';
  ctx.font = fontOf(titleSize, 800);
  setLetterSpacing(ctx, titleSize * 0.18);
  ctx.fillStyle = AMBER;
  ctx.fillText(String(config.introTitle || '选手介绍').toUpperCase(), x + barW - padR, y + barH / 2 - 0.5 * cqh);
  setLetterSpacing(ctx, 0);
  if (total > 1) {
    ctx.font = fontOf(countSize, 700);
    ctx.fillStyle = 'rgba(255,255,255,0.60)';
    ctx.fillText(`${index + 1}/${total}`, x + barW - padR, y + barH / 2 + 1.4 * cqh);
  }
  ctx.textAlign = 'left';

  const progress = introProgress(config, now);
  if (progress != null) drawProgressBar(ctx, x, y + barH - 0.6 * cqh, barW, 0.6 * cqh, progress);

  ctx.restore();
  ctx.restore();
}

// ─── 样式三：名册 ────────────────────────────────────────────────────────────

function drawIntroRoster(ctx, config, list, index, w, h, cqh, cqw, now) {
  const perScreen = Math.max(1, Math.min(8, Number(config.introPerScreen) || 3));
  const pages = Math.max(1, Math.ceil(list.length / perScreen));
  const page = Math.min(pages - 1, Math.floor(index / perScreen));
  const slice = list.slice(page * perScreen, page * perScreen + perScreen);

  const panelW = Math.min(88 * cqw, 1500);
  const padX = 2.6 * cqw;
  const padTop = 2.6 * cqh;
  const padBottom = 2 * cqh;
  const gapX = 1.6 * cqw;
  const cellW = (panelW - padX * 2 - gapX * (perScreen - 1)) / perScreen;
  const cardPadX = 1.4 * cqw;
  const cardPadY = 1.6 * cqh;
  const photoS = Math.max(7.4 * cqh, 34);
  const nameSize = 4.4 * cqh;
  const unitSize = 2.6 * cqh;
  const metaSize = 2.3 * cqh;

  const bodyW = cellW - cardPadX * 2 - photoS - 1.2 * cqw;
  let bodyH = nameSize * 1.1;
  if (slice.some(a => a.unit)) bodyH += unitSize * 1.2 + 0.4 * cqh;
  bodyH += metaSize * 1.2 + 0.4 * cqh;
  const cardH = Math.max(photoS, bodyH) + cardPadY * 2;

  const headH = Math.max(2.6 * cqh + 1.2 * cqh, 2.9 * cqh, 3 * cqh);
  const dotS = Math.max(1 * cqh, 6);
  const panelH = padTop + headH + 2.2 * cqh + cardH + 2 * cqh + dotS + padBottom;
  const x = (w - panelW) / 2;
  const y = (h - panelH) / 2;

  ctx.save();
  const g = ctx.createLinearGradient(x, y, x, y + panelH);
  g.addColorStop(0, 'rgba(10,13,19,0.94)');
  g.addColorStop(1, 'rgba(17,22,32,0.90)');
  panel(ctx, x, y, panelW, panelH, 1.2 * cqh, g, 'rgba(255,255,255,0.14)', 1);

  ctx.save();
  roundRect(ctx, x, y, panelW, panelH, 1.2 * cqh);
  ctx.clip();

  drawIntroHead(ctx, config, index, list.length, x + padX, y + padTop, panelW - padX * 2, cqh, cqw);

  const gridY = y + padTop + headH + 2.2 * cqh;
  slice.forEach((a, i) => {
    const abs = page * perScreen + i;
    const on = abs === index;
    const cx = x + padX + i * (cellW + gapX);
    panel(ctx, cx, gridY, cellW, cardH, 1 * cqh,
      on ? 'rgba(245,158,11,0.14)' : 'rgba(255,255,255,0.04)',
      on ? 'rgba(245,158,11,0.60)' : 'rgba(255,255,255,0.10)', 1);

    // 道次徽标（左上角外挑）
    if (a.lane != null && a.lane !== '') {
      ctx.font = fontOf(2.1 * cqh, 900);
      const badgeW = Math.max(22, ctx.measureText(String(a.lane)).width + 0.8 * cqw);
      const badgeH = Math.max(22, 2.1 * cqh + 0.6 * cqh);
      const bx = Math.max(x, cx - 0.4 * cqw);
      const by = Math.max(y, gridY - 1 * cqh);
      panel(ctx, bx, by, badgeW, badgeH, 999, AMBER);
      ctx.fillStyle = AMBER_DARK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(a.lane), bx + badgeW / 2, by + badgeH / 2 + 0.5);
      ctx.textAlign = 'left';
    }

    const photoY = gridY + (cardH - photoS) / 2;
    drawPhoto(ctx, a, cx + cardPadX, photoY, photoS, photoS, photoS / 2, 2.8 * cqh);

    const tx = cx + cardPadX + photoS + 1.2 * cqw;
    let ty = gridY + (cardH - (bodyH - (slice.some(s => s.unit) ? 0 : unitSize * 1.2 + 0.4 * cqh))) / 2;
    ctx.textBaseline = 'middle';
    ctx.font = fontOf(nameSize, 800);
    setLetterSpacing(ctx, nameSize * 0.04);
    ctx.fillStyle = '#f5f5f7';
    ctx.fillText(fitText(ctx, a.name || '待录入', bodyW), tx, ty + nameSize * 0.55);
    setLetterSpacing(ctx, 0);
    ty += nameSize * 1.1 + 0.4 * cqh;

    if (a.unit) {
      ctx.font = fontOf(unitSize, 400);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(fitText(ctx, a.unit, bodyW), tx, ty + unitSize * 0.6);
      ty += unitSize * 1.2 + 0.4 * cqh;
    }

    const meta = [];
    if (a.bib) meta.push(`No.${a.bib}`);
    if (config.introShowPb !== false && a.pb) meta.push(`PB ${a.pb}`);
    if (meta.length) {
      ctx.font = fontOf(metaSize, 400);
      ctx.fillStyle = 'rgba(203,213,225,0.80)';
      let mx = tx;
      for (const m of meta) {
        const t = fitText(ctx, m, Math.max(0, tx + bodyW - mx));
        ctx.fillText(t, mx, ty + metaSize * 0.6);
        mx += ctx.measureText(t).width + 0.8 * cqw;
      }
    }
  });

  // 页码点
  const dotsY = gridY + cardH + 2 * cqh + dotS / 2;
  const totalDotsW = pages * dotS + (pages - 1) * 0.6 * cqw;
  let dx = x + panelW / 2 - totalDotsW / 2;
  for (let p = 0; p < pages; p += 1) {
    const on = p === page;
    const s = on ? dotS * 1.25 : dotS;
    ctx.beginPath();
    ctx.arc(dx + dotS / 2, dotsY, s / 2, 0, Math.PI * 2);
    ctx.fillStyle = on ? AMBER : 'rgba(255,255,255,0.22)';
    ctx.fill();
    dx += dotS + 0.6 * cqw;
  }

  const progress = introProgress(config, now);
  if (progress != null) drawProgressBar(ctx, x, y + panelH - 0.6 * cqh, panelW, 0.6 * cqh, progress);

  ctx.restore();
  ctx.restore();
}

// ─── 空名册 ──────────────────────────────────────────────────────────────────

function drawIntroEmpty(ctx, config, w, h, cqh, cqw) {
  const tagSize = 2.6 * cqh;
  const textSize = 3 * cqh;
  const padX = 3 * cqw;
  const padY = 2.6 * cqh;
  const gap = 1.2 * cqh;

  ctx.font = fontOf(tagSize, 800);
  setLetterSpacing(ctx, tagSize * 0.18);
  const tagW = ctx.measureText(String(config.introTitle || '选手介绍').toUpperCase()).width;
  setLetterSpacing(ctx, 0);
  ctx.font = fontOf(textSize, 400);
  const textW = ctx.measureText('选手介绍已上屏 · 请在设置或侧栏录入选手').width;

  const boxW = Math.max(tagW, textW) + padX * 2;
  const boxH = tagSize + textSize + gap + padY * 2;
  const x = (w - boxW) / 2;
  const y = (h - boxH) / 2;

  panel(ctx, x, y, boxW, boxH, 1 * cqh, 'rgba(10,13,19,0.90)');
  ctx.save();
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(245,158,11,0.5)';
  roundRect(ctx, x, y, boxW, boxH, 1 * cqh);
  ctx.stroke();
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = fontOf(tagSize, 800);
  setLetterSpacing(ctx, tagSize * 0.18);
  ctx.fillStyle = AMBER;
  ctx.fillText(String(config.introTitle || '选手介绍').toUpperCase(), x + boxW / 2, y + padY + tagSize / 2);
  setLetterSpacing(ctx, 0);
  ctx.font = fontOf(textSize, 400);
  ctx.fillStyle = 'rgba(255,255,255,0.66)';
  ctx.fillText('选手介绍已上屏 · 请在设置或侧栏录入选手', x + boxW / 2, y + padY + tagSize + gap + textSize / 2);
  ctx.textAlign = 'left';
}

/**
 * 画选手介绍叠加层
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} config /api/scoreboard 配置（mode === 'intro'）
 * @param {number} w 画布宽
 * @param {number} h 画布高
 * @param {number} now 当前时间（毫秒），用于自动轮播进度
 */
export function drawIntro(ctx, config, w, h, now = Date.now()) {
  const cqh = h / 100;
  const cqw = w / 100;
  const list = (config.athletes || []).filter(a => String(a?.name || '').trim() || a?.photo);
  const style = config.introStyle || 'card';

  if (!list.length) {
    drawIntroEmpty(ctx, config, w, h, cqh, cqw);
    return;
  }

  const index = Math.max(0, Math.min(list.length - 1, Math.floor(Number(config.introIndex) || 0)));

  if (style === 'roster') drawIntroRoster(ctx, config, list, index, w, h, cqh, cqw, now);
  else if (style === 'lower') drawIntroLower(ctx, config, list[index], index, list.length, w, h, cqh, cqw, now);
  else drawIntroCard(ctx, config, list[index], index, list.length, w, h, cqh, cqw, now);
}

export default drawIntro;
