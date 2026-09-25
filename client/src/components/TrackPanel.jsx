import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const API = 'http://localhost:3001';

/**
 * 侧栏「田径直播」——赛事中不打开设置即可换项、跑表、录名次
 * 默认紧凑：高级项（风速/名次/开关）折叠
 */
export default function TrackPanel() {
  const [cfg, setCfg] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [orderText, setOrderText] = useState('');
  const [wind, setWind] = useState('');
  const [liveMs, setLiveMs] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTpl, setShowTpl] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(setCfg).catch(() => {});
    fetch(`${API}/api/scoreboard/templates`).then(r => r.json()).then(setTemplates).catch(() => {});
    const socket = io(API);
    socket.on('scoreboard:update', d => setCfg(d));
    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    if (!cfg?.clockRunning || !cfg?.clockStartAt) return undefined;
    const base = Number(cfg.clockOffsetMs) || 0;
    const startAt = Number(cfg.clockStartAt);
    const tick = () => setLiveMs(base + (Date.now() - startAt));
    tick();
    const id = setInterval(tick, 50);
    return () => clearInterval(id);
  }, [cfg?.clockRunning, cfg?.clockStartAt, cfg?.clockOffsetMs]);

  const post = async (patch) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/scoreboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const d = await r.json();
      setCfg(d);
      return d;
    } finally {
      setBusy(false);
    }
  };

  const clockAction = (action) => post({ mode: 'track', clockAction: action });

  const applyTemplate = (id) => {
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return;
    setOrderText('');
    post({
      templateId: id,
      mode: 'track',
      enabled: true,
      eventName: tpl.eventName,
      category: '男子',
      round: cfg?.round || '预赛',
      wind: '',
    });
    setWind('');
  };

  const flipGender = () => {
    const next = cfg?.category === '女子' ? '男子' : '女子';
    const name = String(cfg?.eventName || '').replace(/^(男子|女子)/, next);
    post({ category: next, eventName: name });
  };

  const applyFinishOrder = () => {
    const order = orderText
      .split(/[\s,，、>→]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0);
    if (!order.length) return;
    post({ finishOrder: order, showPlaces: true, showResults: true });
    setOrderText('');
  };

  const applyWind = () => {
    let v = String(wind).trim();
    if (v && !/^[+-]/.test(v) && /^[\d.]+$/.test(v)) v = `+${v}`;
    post({ wind: v });
  };

  if (!cfg) {
    return (
      <div className="track-panel">
        <p className="local-empty">田径面板连接中…</p>
      </div>
    );
  }

  const isTeam = cfg.mode === 'team';
  const isField = cfg.eventKind === 'field';
  const shortEvent = `${cfg.category || ''}${String(cfg.eventName || '').replace(/^(男子|女子)/, '')}`;

  return (
    <div className="track-panel">
      <div className="track-panel-event">
        <strong title={cfg.eventName}>{shortEvent}</strong>
        <div className="track-panel-event-meta">
          <label className="track-panel-en" onClick={e => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={!!cfg.enabled}
              disabled={busy}
              onChange={e => post({ enabled: e.target.checked })}
            />
            <span>{cfg.enabled ? '上屏' : '关'}</span>
          </label>
          <button type="button" className="tp-chip" onClick={flipGender} disabled={busy}>
            {cfg.category === '女子' ? '女' : '男'}▾
          </button>
          <button
            type="button"
            className="tp-chip"
            disabled={busy}
            onClick={() => post({ round: nextRound(cfg.round) })}
            title="切换轮次"
          >
            {cfg.round || '轮次'}▸
          </button>
          {!isField && (
            <button
              type="button"
              className="tp-chip"
              disabled={busy}
              onClick={() => post({ heat: nextHeat(cfg.heat) })}
              title="切换组次"
            >
              {cfg.heat || '组次'}▸
            </button>
          )}
          <button
            type="button"
            className={`tp-chip tp-chip--more ${showTpl ? 'active' : ''}`}
            onClick={() => setShowTpl(v => !v)}
          >
            项目▾
          </button>
        </div>
      </div>

      {isTeam ? (
        <p className="local-empty">球队模式 · 设置中可切回田径</p>
      ) : (
        <>
          {showTpl && (
            <div className="track-panel-templates track-panel-templates--open">
              {templates.map(t => (
                <button
                  key={t.id}
                  type="button"
                  className={`tp-tpl ${cfg.eventName === t.eventName ? 'active' : ''}`}
                  onClick={() => { applyTemplate(t.id); setShowTpl(false); }}
                  disabled={busy}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <div className="track-panel-clock">
            <div className={`tp-clock ${cfg.clockRunning ? 'running' : ''}`}>
              {cfg.clockRunning ? formatMs(liveMs) : (cfg.clock || '0.00')}
            </div>
            <div className="tp-clock-btns">
              <button type="button" className="tp-btn primary" disabled={busy || cfg.clockRunning}
                onClick={() => clockAction('start')}>▶ 开始</button>
              <button type="button" className="tp-btn" disabled={busy || !cfg.clockRunning}
                onClick={() => clockAction('stop')}>⏸ 暂停</button>
              <button type="button" className="tp-btn" disabled={busy}
                onClick={() => clockAction('reset')}>清零</button>
              <button type="button" className="tp-btn" disabled={busy}
                onClick={() => clockAction('lap')}>记圈</button>
            </div>
          </div>

          {!isField && !showAdvanced && (
            <div className="track-panel-order">
              <div className="track-panel-order-row">
                <input
                  value={orderText}
                  placeholder="名次道次 4 5 3 1…"
                  onChange={e => setOrderText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') applyFinishOrder(); }}
                  disabled={busy}
                />
                <button type="button" className="tp-btn primary" onClick={applyFinishOrder}
                  disabled={busy || !orderText.trim()}>录</button>
              </div>
            </div>
          )}

          <button
            type="button"
            className={`tp-more ${showAdvanced ? 'active' : ''}`}
            onClick={() => setShowAdvanced(v => !v)}
          >
            {showAdvanced ? '收起高级 ▴' : '风速 / 名次 / 显示 ▾'}
          </button>

          {showAdvanced && (
            <>
              <div className="track-panel-wind">
                <input
                  value={wind}
                  placeholder="风速 +0.8"
                  onChange={e => setWind(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') applyWind(); }}
                  disabled={busy}
                />
                <button type="button" className="tp-btn" onClick={applyWind} disabled={busy}>风速</button>
                {cfg.wind && (
                  <button type="button" className="tp-btn ghost" disabled={busy}
                    onClick={() => { setWind(''); post({ wind: '' }); }}>清除</button>
                )}
              </div>

              {!isField && (
                <div className="track-panel-order">
                  <label>快速名次（道次先后）</label>
                  <div className="track-panel-order-row">
                    <input
                      value={orderText}
                      placeholder="4 5 3 2 1 6 7 8"
                      onChange={e => setOrderText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') applyFinishOrder(); }}
                      disabled={busy}
                    />
                    <button type="button" className="tp-btn primary" onClick={applyFinishOrder}
                      disabled={busy || !orderText.trim()}>录入</button>
                    <button type="button" className="tp-btn ghost" disabled={busy}
                      onClick={() => post({ clearPlaces: true })}>清</button>
                  </div>
                </div>
              )}

              <div className="track-panel-row">
                <label className="tp-toggle">
                  <input type="checkbox" checked={!!cfg.showPlaces} disabled={busy}
                    onChange={e => post({ showPlaces: e.target.checked })} />
                  <span>名次</span>
                </label>
                <label className="tp-toggle">
                  <input type="checkbox" checked={!!cfg.showResults} disabled={busy}
                    onChange={e => post({ showResults: e.target.checked })} />
                  <span>成绩</span>
                </label>
                <label className="tp-toggle">
                  <input type="checkbox" checked={!!cfg.showPodium} disabled={busy}
                    onChange={e => post({ showPodium: e.target.checked })} />
                  <span>成绩榜</span>
                </label>
                <label className="tp-toggle">
                  <input type="checkbox" checked={cfg.position === 'bottom'} disabled={busy}
                    onChange={e => post({ position: e.target.checked ? 'bottom' : 'top' })} />
                  <span>底部</span>
                </label>
              </div>

              {isField && (
                <div className="track-panel-field">
                  <span className="tp-label">试次</span>
                  <button type="button" className="tp-btn" disabled={busy || cfg.attempt <= 1}
                    onClick={() => post({ attempt: Math.max(1, (cfg.attempt || 1) - 1) })}>−</button>
                  <strong>{cfg.attempt}/{cfg.attemptsTotal}</strong>
                  <button type="button" className="tp-btn" disabled={busy}
                    onClick={() => post({ attempt: Math.min(cfg.attemptsTotal, (cfg.attempt || 1) + 1) })}>+</button>
                  <input
                    className="tp-best"
                    value={cfg.bestMark || ''}
                    placeholder="最佳 7.85m"
                    disabled={busy}
                    onChange={e => post({ bestMark: e.target.value })}
                  />
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function nextRound(r) {
  const cycle = ['预赛', '半决赛', '决赛', '第1轮', '第2轮', '第3轮', '资格赛'];
  const i = cycle.indexOf(r || '预赛');
  return cycle[(i + 1) % cycle.length];
}

function nextHeat(h) {
  const m = /第(\d+)组/.exec(h || '第1组');
  const n = m ? Number(m[1]) : 1;
  const next = n >= 8 ? 1 : n + 1;
  return `第${next}组`;
}

function formatMs(ms) {
  const total = Math.max(0, Math.floor(ms));
  const s = Math.floor(total / 1000);
  const cs = Math.floor((total % 1000) / 10);
  const m = Math.floor(s / 60);
  if (m > 0) {
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
  return `${s}.${String(cs).padStart(2, '0')}`;
}
