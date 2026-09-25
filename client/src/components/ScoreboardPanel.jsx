import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const API = 'http://localhost:3001';

const DEFAULT = {
  enabled: false,
  mode: 'track',
  homeName: '主队',
  awayName: '客队',
  homeScore: 0,
  awayScore: 0,
  period: '第1节',
  eventName: '男子100米',
  round: '决赛',
  athletes: Array.from({ length: 8 }, (_, i) => ({
    lane: i + 1,
    name: '',
    place: '',
    result: '',
  })),
  showPlaces: true,
  showResults: false,
  clock: '',
  showClock: true,
  clockRunning: false,
  clockStartAt: null,
  clockOffsetMs: 0,
  position: 'bottom',
  homeColor: '#2563eb',
  awayColor: '#dc2626',
};

/** 设置弹窗：田径 / 球队叠加信息 */
export function ScoreboardSection() {
  const [cfg, setCfg] = useState(DEFAULT);
  const [saving, setSaving] = useState(false);
  const [laneCount, setLaneCount] = useState(8);

  useEffect(() => {
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(d => {
      setCfg(prev => ({ ...DEFAULT, ...d }));
      if (Array.isArray(d?.athletes) && d.athletes.length) setLaneCount(d.athletes.length);
    }).catch(() => {});
    const socket = io(API);
    socket.on('scoreboard:update', d => setCfg(prev => ({ ...DEFAULT, ...d })));
    return () => socket.disconnect();
  }, []);

  const save = async (patch) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setSaving(true);
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

  const clockAction = (action) => save({ clockAction: action });

  const resizeLanes = (n) => {
    const count = Math.max(1, Math.min(16, Number(n) || 8));
    setLaneCount(count);
    const prev = cfg.athletes || [];
    const athletes = Array.from({ length: count }, (_, i) => prev[i] || {
      lane: i + 1, name: '', place: '', result: '',
    }).map((a, i) => ({ ...a, lane: i + 1 }));
    save({ athletes });
  };

  const updateAthlete = (idx, field, value) => {
    const athletes = (cfg.athletes || []).map((a, i) =>
      i === idx ? { ...a, [field]: value, lane: i + 1 } : a
    );
    save({ athletes });
  };

  const isTrack = cfg.mode !== 'team';

  return (
    <section className="settings-section">
      <div className="settings-section-title">
        🏁 赛事信息条
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

      <div className="settings-row" style={{ gap: '0.4rem' }}>
        <span className="settings-label">模式</span>
        <button className={`settings-pill ${isTrack ? 'active' : ''}`}
          onClick={() => set('mode', 'track')}>田径</button>
        <button className={`settings-pill ${cfg.mode === 'team' ? 'active' : ''}`}
          onClick={() => set('mode', 'team')}>球队</button>
      </div>

      <div className="settings-row">
        <span className="settings-label">位置</span>
        <button className={`settings-pill ${cfg.position === 'top' ? 'active' : ''}`}
          onClick={() => set('position', 'top')}>顶部</button>
        <button className={`settings-pill ${cfg.position === 'bottom' ? 'active' : ''}`}
          onClick={() => set('position', 'bottom')}>底部</button>
      </div>

      <div className="settings-row">
        <label className="settings-toggle">
          <input type="checkbox" checked={cfg.showClock}
            onChange={e => set('showClock', e.target.checked)} />
          <span className="settings-toggle-track" />
          <span className="settings-toggle-label">显示时钟</span>
        </label>
      </div>

      {isTrack ? (
        <>
          <div className="sb-grid">
            <label className="sb-field">
              <span>项目</span>
              <input value={cfg.eventName} onChange={e => set('eventName', e.target.value)}
                placeholder="男子100米 / 女子跳远" />
            </label>
            <label className="sb-field">
              <span>轮次</span>
              <input value={cfg.round} onChange={e => set('round', e.target.value)}
                placeholder="预赛 / 半决赛 / 决赛" />
            </label>
          </div>

          <div className="settings-row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            <span className="settings-label">跑表</span>
            <button className="settings-pill" onClick={() => clockAction('start')}
              disabled={cfg.clockRunning}>{cfg.clockRunning ? '计时中' : '开始'}</button>
            <button className="settings-pill" onClick={() => clockAction('stop')}
              disabled={!cfg.clockRunning}>暂停</button>
            <button className="settings-pill" onClick={() => clockAction('reset')}>清零</button>
            <button className="settings-pill" onClick={() => clockAction('lap')}>记圈</button>
          </div>

          <div className="settings-row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            <label className="settings-toggle">
              <input type="checkbox" checked={cfg.showPlaces}
                onChange={e => set('showPlaces', e.target.checked)} />
              <span className="settings-toggle-track" />
              <span className="settings-toggle-label">显示名次</span>
            </label>
            <label className="settings-toggle">
              <input type="checkbox" checked={cfg.showResults}
                onChange={e => set('showResults', e.target.checked)} />
              <span className="settings-toggle-track" />
              <span className="settings-toggle-label">显示成绩</span>
            </label>
          </div>

          <div className="settings-row">
            <span className="settings-label">道次数量</span>
            <select value={laneCount} onChange={e => resizeLanes(e.target.value)}
              className="settings-select" style={{ width: 88, margin: 0 }}>
              {[1, 2, 4, 6, 8, 10, 12].map(n => (
                <option key={n} value={n}>{n} 道</option>
              ))}
            </select>
          </div>

          <div className="track-editor">
            {(cfg.athletes || []).map((a, i) => (
              <div key={i} className="track-editor-row">
                <span className="track-editor-lane">{a.lane}</span>
                <input
                  className="track-editor-name"
                  value={a.name}
                  placeholder="姓名 / 单位"
                  onChange={e => updateAthlete(i, 'name', e.target.value)}
                />
                <input
                  className="track-editor-place"
                  value={a.place}
                  placeholder="名次"
                  onChange={e => updateAthlete(i, 'place', e.target.value)}
                  title="名次，如 1 / 2 / 3 或 冠军"
                />
                <input
                  className="track-editor-result"
                  value={a.result}
                  placeholder="成绩"
                  onChange={e => updateAthlete(i, 'result', e.target.value)}
                  title="成绩，如 10.23 / 7.85m"
                />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
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
          </div>
          <div className="settings-row">
            <span className="settings-label">主队色</span>
            <input type="color" className="settings-color" value={cfg.homeColor}
              onChange={e => set('homeColor', e.target.value)} />
            <span className="settings-label" style={{ marginLeft: 8 }}>客队色</span>
            <input type="color" className="settings-color" value={cfg.awayColor}
              onChange={e => set('awayColor', e.target.value)} />
          </div>
        </>
      )}
    </section>
  );
}

export default ScoreboardSection;
