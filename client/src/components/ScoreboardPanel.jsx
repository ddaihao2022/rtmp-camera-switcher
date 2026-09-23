import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API = 'http://localhost:3001';

const DEFAULT = {
  enabled: false,
  homeName: '主队',
  awayName: '客队',
  homeScore: 0,
  awayScore: 0,
  period: '第1节',
  clock: '',
  showClock: false,
  position: 'top',
  homeColor: '#2563eb',
  awayColor: '#dc2626',
};

/** 设置弹窗里的比分条分组 */
export function ScoreboardSection() {
  const [cfg, setCfg] = useState(DEFAULT);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(setCfg).catch(() => {});
    const socket = io(API);
    socket.on('scoreboard:update', setCfg);
    return () => socket.disconnect();
  }, []);

  const save = async (patch, { immediate = true } = {}) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    if (!immediate) return;
    setSaving(true);
    clearTimeout(debounceRef.current);
    try {
      await fetch(`${API}/api/scoreboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
    } finally {
      setSaving(false);
    }
  };

  const set = (key, value) => save({ [key]: value });
  const bump = (key, delta) => save({ [key]: Math.max(0, (Number(cfg[key]) || 0) + delta) });

  return (
    <section className="settings-section">
      <div className="settings-section-title">
        🏆 比分条
        {saving && <span className="settings-saving"> ●</span>}
      </div>

      <div className="settings-row">
        <label className="settings-toggle">
          <input type="checkbox" checked={cfg.enabled}
            onChange={e => set('enabled', e.target.checked)} />
          <span className="settings-toggle-track" />
          <span className="settings-toggle-label">{cfg.enabled ? '已启用' : '已关闭'}</span>
        </label>
      </div>

      <div className="sb-grid">
        <label className="sb-field">
          <span>主队</span>
          <input value={cfg.homeName} onChange={e => set('homeName', e.target.value)} />
        </label>
        <label className="sb-field">
          <span>客队</span>
          <input value={cfg.awayName} onChange={e => set('awayName', e.target.value)} />
        </label>
      </div>

      <div className="sb-grid">
        <div className="sb-score-row">
          <span className="sb-score-label" style={{ color: cfg.homeColor }}>主队分</span>
          <button type="button" className="sb-step" onClick={() => bump('homeScore', -1)}>−</button>
          <strong className="sb-score-val">{cfg.homeScore}</strong>
          <button type="button" className="sb-step" onClick={() => bump('homeScore', 1)}>+</button>
        </div>
        <div className="sb-score-row">
          <span className="sb-score-label" style={{ color: cfg.awayColor }}>客队分</span>
          <button type="button" className="sb-step" onClick={() => bump('awayScore', -1)}>−</button>
          <strong className="sb-score-val">{cfg.awayScore}</strong>
          <button type="button" className="sb-step" onClick={() => bump('awayScore', 1)}>+</button>
        </div>
      </div>

      <div className="sb-grid">
        <label className="sb-field">
          <span>节次 / 阶段</span>
          <input value={cfg.period} onChange={e => set('period', e.target.value)} placeholder="第1节" />
        </label>
        <label className="sb-field">
          <span>时钟</span>
          <input value={cfg.clock} onChange={e => set('clock', e.target.value)} placeholder="12:00" />
        </label>
      </div>

      <div className="settings-row">
        <label className="settings-toggle">
          <input type="checkbox" checked={cfg.showClock}
            onChange={e => set('showClock', e.target.checked)} />
          <span className="settings-toggle-track" />
          <span className="settings-toggle-label">显示时钟</span>
        </label>
      </div>

      <div className="settings-row">
        <span className="settings-label">位置</span>
        <button className={`settings-pill ${cfg.position === 'top' ? 'active' : ''}`}
          onClick={() => set('position', 'top')}>顶部</button>
        <button className={`settings-pill ${cfg.position === 'bottom' ? 'active' : ''}`}
          onClick={() => set('position', 'bottom')}>底部</button>
      </div>

      <div className="settings-row">
        <span className="settings-label">主队色</span>
        <input type="color" className="settings-color" value={cfg.homeColor}
          onChange={e => set('homeColor', e.target.value)} />
        <span className="settings-label" style={{ marginLeft: 8 }}>客队色</span>
        <input type="color" className="settings-color" value={cfg.awayColor}
          onChange={e => set('awayColor', e.target.value)} />
      </div>
    </section>
  );
}

/** 侧栏快捷比分条（可选嵌入） */
export default ScoreboardSection;
