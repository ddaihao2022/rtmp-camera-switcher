/**
 * 基础调色（Color Grading）模型
 *
 * 一套参数同时驱动：主控预览 / PGM 监看 / HDMI 输出 / 录制文件
 * 参数分两层：
 *   - 全局 grade          → 整个节目（PROGRAM）统一风格
 *   - sources[streamKey]  → 单机位覆盖（跟拍某路画面偏色时用）
 *
 * 亮度/对比度/饱和度/色相 走 CSS filter；
 * 色温/色调（soft-light 罩层）与暗角（径向渐变）走叠加层，
 * 因为 CSS filter 无法表达白平衡与暗角。
 */

/** 全部可调参数 + 取值范围 */
export const GRADE_RANGES = {
  brightness: [-100, 100],  // 亮度
  contrast: [-100, 100],    // 对比度
  saturation: [-100, 100],  // 饱和度
  hue: [-180, 180],         // 色相（度）
  temperature: [-100, 100], // 色温 负=冷/蓝 正=暖/橙
  tint: [-100, 100],        // 色调 负=绿 正=洋红
  vignette: [0, 100],       // 暗角
};

export const GRADE_KEYS = Object.keys(GRADE_RANGES);

/** 参数中文名（面板/提示共用） */
export const GRADE_LABELS = {
  brightness: '亮度',
  contrast: '对比度',
  saturation: '饱和度',
  hue: '色相',
  temperature: '色温',
  tint: '色调',
  vignette: '暗角',
};

export const GRADE_DEFAULTS = {
  enabled: false,
  preset: 'neutral',
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  temperature: 0,
  tint: 0,
  vignette: 0,
};

/** 内置预设（一键风格） */
export const GRADE_PRESETS = [
  { id: 'neutral', label: '原片', icon: '⚪', values: {} },
  { id: 'sport',   label: '赛场', icon: '🏟', values: { brightness: 8, contrast: 22, saturation: 18 } },
  { id: 'bright',  label: '明亮', icon: '🔆', values: { brightness: 16, contrast: 8, saturation: 6 } },
  { id: 'punch',   label: '浓郁', icon: '🎯', values: { brightness: 4, contrast: 26, saturation: 30 } },
  { id: 'soft',    label: '柔和', icon: '🌫', values: { brightness: 8, contrast: -14, saturation: -10 } },
  { id: 'warm',    label: '暖阳', icon: '🌅', values: { brightness: 6, temperature: 45, saturation: 12 } },
  { id: 'cool',    label: '冷调', icon: '❄️', values: { brightness: 2, temperature: -45, saturation: 4 } },
  { id: 'film',    label: '电影', icon: '🎬', values: { brightness: -4, contrast: 18, saturation: -12, temperature: -8, vignette: 35 } },
  { id: 'night',   label: '夜景', icon: '🌙', values: { brightness: 18, contrast: 10, saturation: -18, temperature: -30, vignette: 20 } },
  { id: 'mono',    label: '黑白', icon: '⬛', values: { brightness: 4, contrast: 16, saturation: -100 } },
];

export function getPreset(id) {
  return GRADE_PRESETS.find(p => p.id === id) || GRADE_PRESETS[0];
}

export function clampGradeValue(key, value) {
  const [min, max] = GRADE_RANGES[key] || [-100, 100];
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, Math.round(n * 100) / 100));
}

/**
 * 规整一份调色参数；缺省字段从 fallback 继承。
 * @param {object|null} raw
 * @param {object} [fallback] 通常传全局参数，用于机位级继承
 */
export function normalizeGrade(raw, fallback = GRADE_DEFAULTS) {
  const base = { ...GRADE_DEFAULTS, ...(fallback || {}) };
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    enabled: src.enabled === undefined ? !!base.enabled : !!src.enabled,
    preset: typeof src.preset === 'string' && src.preset ? src.preset : (base.preset || 'neutral'),
  };
  for (const key of GRADE_KEYS) {
    out[key] = src[key] === undefined ? clampGradeValue(key, base[key]) : clampGradeValue(key, src[key]);
  }
  return out;
}

/** 参数是否全部为中性（不含 enabled） */
export function isNeutralGrade(grade) {
  if (!grade) return true;
  return GRADE_KEYS.every(k => !Number(grade[k]));
}

/** 由当前参数反推最接近的内置预设，用于面板高亮 */
export function matchPreset(grade) {
  if (!grade) return 'neutral';
  for (const p of GRADE_PRESETS) {
    const ok = GRADE_KEYS.every(k => clampGradeValue(k, grade[k] || 0) === clampGradeValue(k, p.values[k] || 0));
    if (ok) return p.id;
  }
  return 'custom';
}

/** 生成 CSS filter 串（只含 filter 能表达的部分） */
export function buildFilter(grade) {
  if (!grade || !grade.enabled) return '';
  const parts = [];
  const b = Number(grade.brightness) || 0;
  const c = Number(grade.contrast) || 0;
  const s = Number(grade.saturation) || 0;
  const h = Number(grade.hue) || 0;

  if (b) parts.push(`brightness(${(1 + (b / 100) * 0.6).toFixed(3)})`);
  if (c) parts.push(`contrast(${(1 + (c / 100) * 0.6).toFixed(3)})`);
  if (s) parts.push(`saturate(${(1 + s / 100).toFixed(3)})`);
  if (h) parts.push(`hue-rotate(${h}deg)`);
  return parts.join(' ');
}

/**
 * 生成叠加层描述（DOM 与 canvas 录制共用同一份结构）
 * @returns {Array<{kind:'tint'|'vignette', color?:string, opacity?:number, blend?:string, strength?:number}>}
 */
export function buildOverlays(grade) {
  if (!grade || !grade.enabled) return [];
  const layers = [];

  const temp = Number(grade.temperature) || 0;
  if (temp) {
    layers.push({
      kind: 'tint',
      color: temp > 0 ? '#ff9a3c' : '#4a9bff',
      opacity: Math.min(0.75, (Math.abs(temp) / 100) * 0.55),
      blend: 'soft-light',
    });
  }

  const tint = Number(grade.tint) || 0;
  if (tint) {
    layers.push({
      kind: 'tint',
      color: tint > 0 ? '#ff3cbe' : '#3cff7a',
      opacity: Math.min(0.75, (Math.abs(tint) / 100) * 0.5),
      blend: 'soft-light',
    });
  }

  const vig = Number(grade.vignette) || 0;
  if (vig > 0) {
    layers.push({ kind: 'vignette', strength: Math.min(1, vig / 100) });
  }

  return layers;
}

/** 叠加层 → DOM style（供 GradeVeil 使用） */
export function overlayStyle(layer) {
  if (layer.kind === 'vignette') {
    const a = (layer.strength * 0.85).toFixed(3);
    return {
      background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,${a}) 100%)`,
      mixBlendMode: 'normal',
    };
  }
  return {
    background: layer.color,
    opacity: layer.opacity,
    mixBlendMode: layer.blend || 'normal',
  };
}

/** #rrggbb → rgba(r,g,b,a)（canvas 录制用） */
export function hexToRgba(hex, alpha = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 取某一路画面最终生效的调色参数：
 * 机位覆盖存在则与全局合并（未写的字段继承全局），否则直接用全局。
 */
export function resolveGrade(config, streamKey) {
  const global = normalizeGrade(config);
  if (!streamKey) return global;
  const per = config?.sources?.[streamKey];
  if (!per) return global;
  return normalizeGrade(per, global);
}

/** 是否已有全局调色（面板徽标用） */
export function isGradeActive(config) {
  const g = normalizeGrade(config);
  return !!g.enabled && !isNeutralGrade(g);
}

/** 某一路是否被单独覆盖 */
export function hasSourceOverride(config, streamKey) {
  return !!config?.sources?.[streamKey];
}

/** 参数指纹：用于 memo / 变更判断 */
export function gradeSignature(grade) {
  if (!grade) return 'none';
  return [grade.enabled ? 1 : 0, ...GRADE_KEYS.map(k => grade[k] || 0)].join('|');
}
