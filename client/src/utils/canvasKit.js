/**
 * 叠加层 canvas 绘制基础件
 *
 * 成绩条（田径 / 比分条）与选手介绍叠加层在页面上都是 DOM，
 * 录制成片时抓不到，必须逐帧画进 canvas —— 这里放两套渲染共用的原子操作：
 * 字体、圆角矩形、文本截断、胶囊芯片、头像、进度条。
 * 度量单位与 CSS 对齐：文字用「画面宽/高的百分比」（≈ CSS 的 cqw/cqh）。
 */

export const SANS = `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Segoe UI', 'Microsoft YaHei', sans-serif`;
export const MONO = `'SF Mono', Consolas, Menlo, monospace`;

export const fontOf = (size, weight = 600, mono = false) =>
  `${weight} ${Math.max(5, size).toFixed(1)}px ${mono ? MONO : SANS}`;

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** 填充 + 描边一个圆角矩形 */
export function panel(ctx, x, y, w, h, r, fill, stroke, lineWidth = 1) {
  roundRect(ctx, x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

export function boxShadow(ctx, scale, blur = 20, alpha = 0.5) {
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = blur * scale;
  ctx.shadowOffsetY = 4 * scale;
}

export function clearShadow(ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/** 是否可设置字距（Chromium 支持 ctx.letterSpacing） */
export function setLetterSpacing(ctx, px) {
  if (!ctx) return;
  try {
    ctx.letterSpacing = `${Math.max(0, px).toFixed(2)}px`;
  } catch { /* 老引擎忽略 */ }
}

/** 超出宽度时截断成省略号（对应 CSS text-overflow: ellipsis） */
export function fitText(ctx, text, maxW) {
  const s = String(text ?? '');
  if (maxW <= 0) return '';
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, Math.max(1, lo))}…`;
}

/** 折行（最多 maxLines 行，末行截断），对应 -webkit-line-clamp */
export function wrapText(ctx, text, maxW, maxLines = 2) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  const lines = [];
  let line = '';
  for (const ch of s) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    const joined = lines.join('');
    if (joined.length < s.length) lines[maxLines - 1] = fitText(ctx, `${lines[maxLines - 1]}…`, maxW);
  }
  return lines;
}

// ─── 胶囊芯片 ────────────────────────────────────────────────────────────────

/** 量一个胶囊的宽度（文案 + 左右内边距） */
export function chipWidth(ctx, label, spec) {
  ctx.font = spec.font;
  return ctx.measureText(String(label)).width + spec.padX * 2;
}

/** 画一个胶囊；返回它的宽度，方便按行布局 */
export function drawChip(ctx, label, x, y, spec) {
  const w = chipWidth(ctx, label, spec);
  const h = spec.h;
  if (spec.bg || spec.border) {
    panel(ctx, x, y, w, h, spec.radius ?? h / 2, spec.bg, spec.border, spec.borderWidth ?? 1);
  }
  ctx.font = spec.font;
  ctx.fillStyle = spec.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(label), x + spec.padX, y + h / 2 + 0.5);
  return w;
}

/** 一行胶囊按可用宽度折行；返回占用高度。draw=false 时只量不画 */
export function layoutChips(ctx, items, x0, y0, maxW, gap, draw = true) {
  let x = x0;
  let y = y0;
  let rowH = 0;
  let rows = 1;
  for (const it of items) {
    const w = chipWidth(ctx, it.label, it.spec);
    if (x > x0 && x + w > x0 + maxW) {
      x = x0;
      y += rowH + gap;
      rowH = 0;
      rows += 1;
    }
    if (draw) drawChip(ctx, it.label, x, y, it.spec);
    x += w + gap;
    rowH = Math.max(rowH, it.spec.h);
  }
  return rows * rowH + (rows - 1) * gap;
}

// ─── 选手照片 ────────────────────────────────────────────────────────────────

const photoCache = new Map(); // src → { img, ready }

/**
 * 默认队徽。由 athleteDefault.js 在模块加载时注册 —— 不在这里直接 import，
 * 既避免循环依赖，也让本模块在 Node 测试环境（无 DOM、无图片）下能独立跑。
 */
let defaultPhotoSrc = '';
export function setDefaultPhoto(src) {
  defaultPhotoSrc = String(src || '');
}
export function getDefaultPhoto() {
  return defaultPhotoSrc;
}

/** 懒加载 data URL 头像；未就绪时返回 null，由调用方画占位块 */
export function getPhotoImage(src) {
  if (!src) return null;
  let entry = photoCache.get(src);
  if (!entry) {
    entry = { img: null, ready: false };
    try {
      const img = new Image();
      img.onload = () => { entry.ready = true; };
      img.onerror = () => { entry.ready = false; };
      img.src = String(src);
      entry.img = img;
    } catch {
      entry.img = null;
    }
    photoCache.set(src, entry);
  }
  return entry.ready ? entry.img : null;
}

/** 等比铺满裁剪（object-fit: cover） */
export function drawCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

/** 等比完整放入（object-fit: contain），多余部分留空 —— 给方形队徽用 */
export function drawContain(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const scale = Math.min(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

export function shortName(name) {
  const n = String(name || '').trim();
  if (!n) return '待录入';
  return n.length <= 2 ? n : n.slice(0, 2);
}

/** 头像：有照片按 cover 画（可圆角/圆形），没有就用默认队徽，队徽也没有才画姓名缩写 */
export function drawPhoto(ctx, athlete, x, y, w, h, radius = 0, fontSize = 16) {
  const personal = String(athlete?.photo || '').trim();
  const img = getPhotoImage(personal) || getPhotoImage(defaultPhotoSrc);
  if (img) {
    ctx.save();
    roundRect(ctx, x, y, w, h, radius);
    ctx.clip();
    // 队徽是方形图案，按 contain 整幅显示；个人照片按 cover 铺满
    if (personal) drawCover(ctx, img, x, y, w, h);
    else drawContain(ctx, img, x, y, w, h);
    ctx.restore();
    return;
  }
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#2b3446');
  g.addColorStop(1, '#171d29');
  panel(ctx, x, y, w, h, radius, g);
  ctx.font = fontOf(fontSize, 800);
  ctx.fillStyle = 'rgba(255,255,255,0.70)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(shortName(athlete?.name), x + w / 2, y + h / 2 + 0.5);
  ctx.textAlign = 'left';
}

// ─── 进度条 ──────────────────────────────────────────────────────────────────

/** 自动轮播 / 自动隐藏进度：底槽 + 橙色填充（左起） */
export function drawProgressBar(ctx, x, y, w, h, progress) {
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(x, y, w, h);
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  if (p <= 0) return;
  const g = ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, '#f59e0b');
  g.addColorStop(1, '#fbbf24');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w * p, h);
}
