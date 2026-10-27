import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { eventDisplayName } from '../utils/eventName';

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
  const [showProgram, setShowProgram] = useState(false);
  // 名次输入错误提示（P2-6：非法道次不能静默吞掉）
  const [orderErr, setOrderErr] = useState('');
  // 最佳成绩：本地编辑，失焦 / 回车才提交，避免每敲一个字都 POST 一次
  const [bestMark, setBestMark] = useState('');
  const [bestEditing, setBestEditing] = useState(false);
  const skipBestCommit = useRef(false);
  // 全屏成绩自动收起秒数：本地编辑，失焦 / 回车才提交
  const [resultsSecs, setResultsSecs] = useState('0');
  const [resultsEditing, setResultsEditing] = useState(false);

  useEffect(() => {
    if (!bestEditing) setBestMark(cfg?.bestMark || '');
  }, [cfg?.bestMark, bestEditing]);

  useEffect(() => {
    if (!resultsEditing) setResultsSecs(String(Math.max(0, Number(cfg?.fullResultsDuration) || 0)));
  }, [cfg?.fullResultsDuration, resultsEditing]);

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

  const clockAction = (action) => {
    if (action === 'reset' && !window.confirm('清零跑表？当前计时和记圈会全部丢失。')) return;
    post({ mode: 'track', clockAction: action });
  };

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
    const name = String(cfg?.eventName || '').replace(/男子|女子/, next);
    post({ category: next, eventName: name });
  };

  const applyFinishOrder = () => {
    const tokens = orderText
      .split(/[\s,，、>→]+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (!tokens.length) { setOrderErr('请输入道次，例如 4 5 3 1'); return; }
    const bad = tokens.find((t) => !/^\d+$/.test(t) || Number(t) <= 0);
    if (bad) { setOrderErr(`“${bad}”不是有效道次，请只填 1、2、3…`); return; }
    const order = tokens.map(Number);
    setOrderErr('');
    post({ finishOrder: order, showPlaces: true, showResults: true });
    setOrderText('');
  };

  const applyWind = () => {
    let v = String(wind).trim();
    if (v && !/^[+-]/.test(v) && /^[\d.]+$/.test(v)) v = `+${v}`;
    post({ wind: v });
  };

  const commitBestMark = () => {
    setBestEditing(false);
    if (skipBestCommit.current) { skipBestCommit.current = false; return; }
    if (String(bestMark || '') === String(cfg?.bestMark || '')) return;
    post({ bestMark });
  };

  const commitResultsSecs = () => {
    setResultsEditing(false);
    const v = Math.max(0, Math.min(120, Math.floor(Number(resultsSecs) || 0)));
    setResultsSecs(String(v));
    if (v !== (Math.max(0, Number(cfg?.fullResultsDuration) || 0))) {
      post({ fullResultsDuration: v });
    }
  };

  if (!cfg) {
    return (
      <div className="track-panel">
        <p className="local-empty">田径面板连接中…</p>
      </div>
    );
  }

  const isTeam = cfg.mode === 'team';
  const isIntro = cfg.mode === 'intro';
  const isField = cfg.eventKind === 'field';
  const shortEvent = eventDisplayName(cfg.eventName, cfg.category);
  const introRoster = (cfg.athletes || []).filter(a => String(a.name || '').trim() || a.photo);
  const introIdx = Math.min(Math.max(0, Number(cfg.introIndex) || 0), Math.max(introRoster.length - 1, 0));
  const introCur = introRoster[introIdx];
  // 节目单：整场预载名册，现场一键切项（赛程紧凑时不用手打名字）
  const program = cfg.program || [];
  const programIdx = Math.max(0, Math.min(program.length - 1, Number(cfg.programIndex) || 0));
  const programCur = program[programIdx];

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
            className={`tp-chip ${cfg.fullResultsVisible ? 'active' : ''}`}
            disabled={busy}
            title={cfg.fullResultsVisible
              ? '收起全屏成绩，回到直播画面'
              : '把当前项目的名次成绩全屏盖到输出画面'}
            onClick={() => post({ resultsAction: 'toggle' })}
          >
            🏁 成绩
          </button>
          <button
            type="button"
            className={`tp-chip tp-chip--more ${showTpl ? 'active' : ''}`}
            onClick={() => setShowTpl(v => !v)}
          >
            项目▾
          </button>
        </div>
      </div>

      {program.length > 0 && (
        <div className="tp-program">
          <div className="tp-program-head">
            <span className="tp-program-tag">🗂 节目单</span>
            <strong title={programCur?.label || ''}>
              {programCur?.time ? `${programCur.time} ` : ''}{programCur?.eventName || '—'}
            </strong>
            <span className="tp-program-count">
              {programIdx + 1}/{program.length}
              {programCur?.heat ? ` · ${programCur.heat}` : ''}
              {programCur?.count ? ` · ${programCur.count}人` : ''}
            </span>
          </div>
          <div className="tp-program-btns">
            <button type="button" className="tp-btn"
              disabled={busy || programIdx <= 0}
              title={programIdx <= 0 ? '已经是第一节' : '回到上一节'}
              onClick={() => post({ programAction: 'prev' })}>◀ 上一项</button>
            <button type="button" className="tp-btn primary"
              disabled={busy || programIdx >= program.length - 1}
              title={programIdx >= program.length - 1
                ? '已经是最后一节'
                : '切到下一节：项目 / 轮次 / 组次 / 名册一次就位（快捷键 PageDown）'}
              onClick={() => post({ programAction: 'next' })}>下一项 ▶</button>
            <button type="button" className={`tp-btn ${showProgram ? 'active' : ''}`}
              onClick={() => setShowProgram(v => !v)}>{showProgram ? '收起 ▴' : '全部 ▾'}</button>
          </div>
          <div className="tp-program-results">
            <label className="tp-toggle" title="按「下一项 / 上一项」后，自动把刚结束项目的成绩全屏上屏">
              <input type="checkbox" checked={cfg.fullResultsAuto !== false} disabled={busy}
                onChange={e => post({ fullResultsAuto: e.target.checked })} />
              <span>成绩自动上屏</span>
            </label>
            <label className="tp-toggle tp-results-secs" title="自动收起秒数；0 = 一直显示，手动收起">
              <input
                type="number"
                min="0"
                max="120"
                step="1"
                value={resultsSecs}
                disabled={busy}
                onFocus={() => setResultsEditing(true)}
                onChange={e => setResultsSecs(e.target.value)}
                onBlur={commitResultsSecs}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <span>秒后收起</span>
            </label>
          </div>
          {showProgram && (
            <div className="track-panel-templates track-panel-templates--open">
              {program.map((e, i) => (
                <button key={e.id || i} type="button" disabled={busy}
                  className={`tp-tpl ${i === programIdx ? 'active' : ''}`}
                  onClick={() => post({ programAction: 'apply', programIndex: i })}>
                  {e.time ? `${e.time} ` : ''}{e.eventName}{e.heat ? ` ${e.heat}` : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isIntro ? (
        <div className="track-panel-intro">
          <div className="tp-intro-now">
            <span className="tp-intro-lane">{introCur?.lane ?? '—'}</span>
            <div className="tp-intro-body">
              <strong>{introCur?.name || '暂无选手'}</strong>
              <span>
                {[introCur?.unit, introCur?.bib && `No.${introCur.bib}`, introCur?.pb && `PB ${introCur.pb}`]
                  .filter(Boolean).join(' · ') || '在设置 → 赛事信息条 → 选手介绍 中录入'}
              </span>
            </div>
            <span className="tp-intro-count">
              {introRoster.length ? `${introIdx + 1}/${introRoster.length}` : '0/0'}
            </span>
          </div>

          <div className="tp-clock-btns">
            <button type="button" className="tp-btn" disabled={busy}
              onClick={() => post({ mode: 'intro', introAction: 'prev' })}>◀ 上一位</button>
            <button type="button" className="tp-btn primary" disabled={busy}
              onClick={() => post({ mode: 'intro', introAction: 'next' })}>下一位 ▶</button>
            <button type="button" className="tp-btn" disabled={busy}
              onClick={() => post({ mode: 'intro', introAction: 'toggle' })}>
              {cfg.introVisible === false ? '上屏' : '隐藏'}
            </button>
            <button type="button" className="tp-btn ghost" disabled={busy}
              onClick={() => post({ mode: 'track' })}>回田径</button>
          </div>

          <div className="track-panel-row">
            <label className="tp-toggle">
              <input type="checkbox" checked={!!cfg.introAuto} disabled={busy}
                onChange={e => post({ introAuto: e.target.checked })} />
              <span>自动轮播 {Math.round((Number(cfg.introAutoMs) || 8000) / 1000)}s</span>
            </label>
            <label className="tp-toggle">
              <input type="checkbox" checked={cfg.introVisible !== false} disabled={busy}
                onChange={e => post({ introVisible: e.target.checked })} />
              <span>上屏</span>
            </label>
            <label className="tp-toggle">
              <input type="checkbox" checked={cfg.introStyle === 'roster'} disabled={busy}
                onChange={e => post({ introStyle: e.target.checked ? 'roster' : 'card' })} />
              <span>名册</span>
            </label>
          </div>

          {introRoster.length > 0 && (
            <div className="track-panel-templates track-panel-templates--open">
              {introRoster.map((a, i) => (
                <button
                  key={`${a.lane}-${i}`}
                  type="button"
                  className={`tp-tpl ${i === introIdx ? 'active' : ''}`}
                  disabled={busy}
                  onClick={() => post({ mode: 'intro', introIndex: i, introVisible: true })}
                >
                  {a.lane}·{a.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : isTeam ? (
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
              {orderErr && <p className="hint" style={{ color: '#f59e0b', margin: '2px 0 0' }}>{orderErr}</p>}
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
                      onClick={() => {
                        if (window.confirm('清除所有名次？已录入的 1/2/3… 名次会被清空。')) post({ clearPlaces: true });
                      }}>清</button>
                  </div>
                  {orderErr && <p className="hint" style={{ color: '#f59e0b', margin: '2px 0 0' }}>{orderErr}</p>}
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
                    value={bestMark}
                    placeholder="最佳 7.85m"
                    onChange={e => { setBestEditing(true); setBestMark(e.target.value); }}
                    onFocus={() => setBestEditing(true)}
                    onBlur={commitBestMark}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.currentTarget.blur(); }
                      if (e.key === 'Escape') {
                        skipBestCommit.current = true;
                        setBestMark(cfg?.bestMark || '');
                        setBestEditing(false);
                        e.currentTarget.blur();
                      }
                    }}
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
