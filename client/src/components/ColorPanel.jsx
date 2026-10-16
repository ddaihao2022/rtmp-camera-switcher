import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  GRADE_DEFAULTS, GRADE_KEYS, GRADE_LABELS, GRADE_PRESETS, GRADE_RANGES,
  buildFilter, clampGradeValue, matchPreset, normalizeGrade,
} from '../utils/color';

const API = 'http://localhost:3001';
const GLOBAL = 'global';

/**
 * 基础调色面板
 * Props:
 *   compact  - 侧栏紧凑版（默认 false）
 *   streams  - 可选，外部传入机位列表；不传则自行拉取
 */
export default function ColorPanel({ compact = false, streams: streamsProp = null }) {
  const [cfg, setCfg] = useState(() => normalizeGrade(null));
  const [sources, setSources] = useState([]);
  const [target, setTarget] = useState(GLOBAL);
  const [saving, setSaving] = useState(false);
  const socketRef = useRef(null);
  const savingTimer = useRef(null);

  // 拉取初始状态 + 订阅变更
  useEffect(() => {
    fetch(`${API}/api/color`).then(r => r.json()).then(d => setCfg(normalizeGrade(d))).catch(() => {});

    const socket = io(API);
    socketRef.current = socket;
    socket.on('color:update', (d) => setCfg(normalizeGrade(d)));
    return () => socket.disconnect();
  }, []);

  // 机位列表（用于单机位覆盖）
  useEffect(() => {
    if (streamsProp) { setSources(streamsProp); return undefined; }
    let alive = true;
    fetch(`${API}/api/streams`)
      .then(r => r.json())
      .then(d => { if (alive && Array.isArray(d)) setSources(d); })
      .catch(() => {});
    const socket = socketRef.current || io(API);
    const onUpdate = (list) => { if (Array.isArray(list)) setSources(list); };
    socket.on('streamUpdate', onUpdate);
    return () => { alive = false; socket.off('streamUpdate', onUpdate); };
  }, [streamsProp]);

  // 目标机位下线后回落到全局
  useEffect(() => {
    if (target === GLOBAL) return;
    if (!sources.some(s => s.streamKey === target)) setTarget(GLOBAL);
  }, [sources, target]);

  const flashSaving = useCallback(() => {
    setSaving(true);
    clearTimeout(savingTimer.current);
    savingTimer.current = setTimeout(() => setSaving(false), 600);
  }, []);

  useEffect(() => () => clearTimeout(savingTimer.current), []);

  const post = useCallback(async (body) => {
    flashSaving();
    try {
      // 只发请求；权威状态一律以 socket 广播为准，避免并发响应回退界面
      await fetch(`${API}/api/color`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // 忽略网络抖动：socket 广播会补齐状态
    }
  }, [flashSaving]);

  // 拖滑块会高频触发，合并同一参数的连续改动后再发请求
  const patchTimers = useRef(new Map());
  const postThrottled = useCallback((body, dedupeKey) => {
    const timers = patchTimers.current;
    clearTimeout(timers.get(dedupeKey));
    const t = setTimeout(() => {
      timers.delete(dedupeKey);
      post(body);
    }, 120);
    timers.set(dedupeKey, t);
  }, [post]);

  useEffect(() => () => {
    for (const t of patchTimers.current.values()) clearTimeout(t);
    patchTimers.current.clear();
  }, []);

  const globalGrade = useMemo(() => normalizeGrade(cfg), [cfg]);
  const override = target === GLOBAL ? null : cfg.sources?.[target];
  const effective = useMemo(
    () => (target === GLOBAL ? globalGrade : normalizeGrade(override, globalGrade)),
    [target, override, globalGrade]
  );

  const patch = useCallback((values) => {
    // 手动改参数即脱离预设，chip 高亮随之清空
    const withPreset = values.preset === undefined ? { preset: 'custom', ...values } : values;

    // 乐观更新：本地立即反馈，随后以服务端广播覆盖
    setCfg(prev => {
      const base = normalizeGrade(prev);
      if (target === GLOBAL) return { ...base, ...withPreset, sources: prev?.sources || {} };
      return {
        ...base,
        sources: {
          ...(prev?.sources || {}),
          [target]: { ...(prev?.sources?.[target] || {}), ...withPreset },
        },
      };
    });

    const body = { target, patch: withPreset };
    const keys = Object.keys(withPreset).sort().join(',');
    // 单参数（滑块/开关）节流；预设、重置等一次性操作立即生效
    if (keys.split(',').filter(k => k !== 'preset').length <= 1) {
      postThrottled(body, `${target}:${keys}`);
    } else {
      post(body);
    }
  }, [post, postThrottled, target]);

  const applyPreset = useCallback((preset) => {
    const next = { preset: preset.id };
    for (const key of GRADE_KEYS) next[key] = clampGradeValue(key, preset.values[key] || 0);
    post({ target, patch: { ...next, enabled: true } });
  }, [post, target]);

  const resetTarget = useCallback(() => {
    post({ target, reset: true });
  }, [post, target]);

  const copyGlobalToSource = useCallback(() => {
    const body = { target, patch: { preset: globalGrade.preset } };
    for (const key of GRADE_KEYS) body.patch[key] = globalGrade[key];
    post(body);
  }, [post, target, globalGrade]);

  const activePreset = effective.preset || matchPreset(effective);
  const previewGrade = { ...effective, enabled: true };
  const previewFilter = buildFilter(previewGrade) || 'none';

  const targetLabel = (key) => {
    if (key === GLOBAL) return '全局（所有画面）';
    const s = sources.find(x => x.streamKey === key);
    return `机位 · ${s?.fileName || key}`;
  };

  return (
    <div className={`cg-panel ${compact ? 'is-compact' : ''}`}>
      <div className="cg-head">
        <h3>🎨 基础调色{!compact && '（Color Grading）'}</h3>
        {saving && <span className="cg-saving" title="保存中">●</span>}
      </div>

      {/* 目标选择 */}
      <div className="cg-row">
        <label className="cg-label">作用范围</label>
        <select
          className="cg-select"
          value={target}
          onChange={e => setTarget(e.target.value)}
          title="全局影响所有画面；选择机位则只覆盖该路信号"
        >
          <option value={GLOBAL}>全局（所有画面）</option>
          {sources.map(s => (
            <option key={s.streamKey} value={s.streamKey}>
              机位 · {s.fileName || s.streamKey}
            </option>
          ))}
        </select>
      </div>

      {(override || target === GLOBAL) && (
        <p className="cg-hint">
          {target === GLOBAL
            ? '调色应用于预览、PGM 监看、HDMI 输出与录制文件'
            : override
              ? '该机位已单独覆盖，未调整的参数继续继承全局'
              : '该机位暂未覆盖，当前沿用全局参数'}
        </p>
      )}

      {/* 总开关 */}
      <div className="cg-row">
        <label className="cg-toggle">
          <input
            type="checkbox"
            checked={!!effective.enabled}
            onChange={e => patch({ enabled: e.target.checked })}
          />
          <span className="cg-toggle-track" />
          <span className="cg-toggle-label">{effective.enabled ? '调色已启用' : '调色已关闭'}</span>
        </label>
      </div>

      {/* 预设 */}
      <div className="cg-label cg-label--block">风格预设</div>
      <div className="cg-presets">
        {GRADE_PRESETS.map(p => (
          <button
            key={p.id}
            type="button"
            className={`cg-preset ${activePreset === p.id ? 'active' : ''}`}
            onClick={() => applyPreset(p)}
            title={`套用「${p.label}」`}
          >
            <span className="cg-preset-icon">{p.icon}</span>
            <span>{p.label}</span>
          </button>
        ))}
      </div>

      {/* 参数滑块 */}
      <div className="cg-sliders">
        {GRADE_KEYS.map(key => {
          const [min, max] = GRADE_RANGES[key];
          const value = Number(effective[key]) || 0;
          const changed = value !== 0;
          return (
            <div className="cg-slider-row" key={key}>
              <span
                className={`cg-slider-name ${changed ? 'on' : ''}`}
                title="双击归零"
                onDoubleClick={() => patch({ [key]: 0 })}
              >
                {GRADE_LABELS[key]}
              </span>
              <input
                type="range"
                className="cg-slider"
                min={min}
                max={max}
                step={1}
                value={value}
                onChange={e => patch({ [key]: Number(e.target.value) })}
              />
              <span className={`cg-val ${changed ? 'on' : ''}`}>
                {key === 'hue' ? `${value}°` : value}
              </span>
              <button
                type="button"
                className="cg-reset-one"
                onClick={() => patch({ [key]: 0 })}
                disabled={!changed}
                title={`${GRADE_LABELS[key]} 归零`}
              >↺</button>
            </div>
          );
        })}
      </div>

      {/* 实时预览 */}
      <div className="cg-preview">
        <div className="cg-preview-item">
          <span className="cg-preview-cap">原片</span>
          <div className="cg-swatch" />
        </div>
        <div className="cg-preview-item">
          <span className="cg-preview-cap">调色</span>
          <div className="cg-swatch" style={{ filter: previewFilter }} />
        </div>
      </div>

      {/* 操作 */}
      <div className="cg-actions">
        <button type="button" className="cg-btn" onClick={resetTarget}
          title={target === GLOBAL ? '所有参数归零' : '清除该机位覆盖，回到全局'}>
          {target === GLOBAL ? '重置全局' : '清除机位覆盖'}
        </button>
        {target !== GLOBAL && (
          <button type="button" className="cg-btn" onClick={copyGlobalToSource}
            title="把当前全局参数复制到该机位，再单独微调">
            复制全局 → 机位
          </button>
        )}
      </div>

      {!compact && (
        <p className="cg-hint">
          {targetLabel(target)} · 亮度/对比度/饱和度/色相为实时滤镜；
          色温、色调、暗角为叠加层。双击参数名可归零。
        </p>
      )}
    </div>
  );
}
