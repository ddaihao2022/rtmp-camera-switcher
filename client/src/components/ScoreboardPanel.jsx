import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { fileToDownscaledDataUrl } from '../utils/image';
import { DEFAULT_ATHLETE_PHOTO } from '../utils/athleteDefault';
import RosterImportBox from './RosterImportBox';

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
    unit: '',
    bib: '',
    pb: '',
    note: '',
    photo: '',
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
  // —— 选手介绍 ——
  introTitle: '选手介绍',
  introStyle: 'card',
  introIndex: 0,
  introVisible: true,
  introShowPhoto: true,
  introShowPb: true,
  introShowNote: true,
  introPerScreen: 3,
  introHold: 0,
  introAuto: false,
  introAutoMs: 8000,
};

const INTRO_STYLES = [
  ['card', '单人卡'],
  ['lower', '字幕条'],
  ['roster', '名册'],
];

/** 设置弹窗：田径 / 球队 / 选手介绍 三种叠加信息 */
export function ScoreboardSection() {
  const [cfg, setCfg] = useState(DEFAULT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [laneCount, setLaneCount] = useState(8);

  useEffect(() => {
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(d => {
      setCfg(prev => ({ ...DEFAULT, ...d }));
      if (Array.isArray(d?.athletes) && d.athletes.length) setLaneCount(d.athletes.length);
    }).catch(() => {});
    const socket = io(API);
    socket.on('scoreboard:update', d => {
      setCfg(prev => ({ ...DEFAULT, ...d }));
      // 名册被节目单/批量导入整体替换时，人数选择器跟着走
      if (Array.isArray(d?.athletes) && d.athletes.length) setLaneCount(d.athletes.length);
    });
    return () => socket.disconnect();
  }, []);

  // 保存失败后从服务端拉回真实状态，避免“界面上有照片、服务端没存上”
  const resync = () => {
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(d => {
      setCfg(prev => ({ ...DEFAULT, ...d }));
      if (Array.isArray(d?.athletes) && d.athletes.length) setLaneCount(d.athletes.length);
    }).catch(() => {});
  };

  const post = async (patch) => {
    setSaving(true);
    setSaveError('');
    try {
      const r = await fetch(`${API}/api/scoreboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const text = await r.text();
      let d = {};
      try { d = text ? JSON.parse(text) : {}; } catch { d = {}; }
      if (!r.ok || d?.ok === false) {
        setSaveError(d?.error || `保存失败（HTTP ${r.status}）`);
        resync();
        return null;
      }
      setCfg(prev => ({ ...DEFAULT, ...d }));
      return d;
    } catch (e) {
      setSaveError('保存失败：' + (e?.message || '网络错误'));
      resync();
      return null;
    } finally {
      setSaving(false);
    }
  };

  const save = (patch) => {
    setCfg(prev => ({ ...prev, ...patch }));
    return post(patch);
  };

  const set = (key, value) => save({ [key]: value });
  const bump = (key, delta) => save({ [key]: Math.max(0, (Number(cfg[key]) || 0) + delta) });

  const clockAction = (action) => save({ clockAction: action });

  /** 选手介绍：上一位 / 下一位 / 上屏 / 隐藏 */
  const introAction = (action) => post({ introAction: action });

  const resizeLanes = (n) => {
    const count = Math.max(1, Math.min(16, Number(n) || 8));
    setLaneCount(count);
    const prev = cfg.athletes || [];
    const athletes = Array.from({ length: count }, (_, i) => prev[i] || {
      lane: i + 1, name: '', place: '', result: '',
      unit: '', bib: '', pb: '', note: '', photo: '',
    }).map((a, i) => ({ ...a, lane: i + 1 }));
    save({ athletes });
  };

  /** 单名选手增量更新：只发变化的那一格，避免每次按键重传整份照片 */
  const patchAthlete = (idx, field, value) => {
    const athletes = (cfg.athletes || []).map((a, i) =>
      i === idx ? { ...a, [field]: value, lane: i + 1 } : a
    );
    setCfg(prev => ({ ...DEFAULT, ...prev, athletes }));
    return post({ athletePatch: { i: idx, [field]: value } });
  };

  const updateAthlete = patchAthlete;

  const onPhotoPick = async (idx, file) => {
    if (!file) return;
    try {
      const dataUrl = await fileToDownscaledDataUrl(file, { maxSide: 640, quality: 0.82 });
      await patchAthlete(idx, 'photo', dataUrl);
    } catch (e) {
      console.error('照片处理失败', e);
      setSaveError('照片处理失败：' + (e?.message || e));
    }
  };

  const isTeam = cfg.mode === 'team';
  const isIntro = cfg.mode === 'intro';
  const isTrack = !isTeam && !isIntro;

  const roster = cfg.athletes || [];
  // 名册口径与服务端一致：有姓名或照片才算一位选手（空道次跳过）
  const namedRoster = roster.filter(a => String(a.name || '').trim() || a.photo);
  const currentIntro = namedRoster[Math.min(cfg.introIndex || 0, Math.max(namedRoster.length - 1, 0))];

  return (
    <section className="settings-section">
      <div className="settings-section-title">
        🏁 赛事信息条
        {saving && <span className="settings-saving"> ●</span>}
      </div>

      {saveError && (
        <p className="settings-muted" style={{ color: '#fca5a5' }}>{saveError}</p>
      )}

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
        <button className={`settings-pill ${isTeam ? 'active' : ''}`}
          onClick={() => set('mode', 'team')}>球队</button>
        <button className={`settings-pill ${isIntro ? 'active' : ''}`}
          onClick={() => save({ mode: 'intro', enabled: true, introVisible: true })}>选手介绍</button>
      </div>

      {!isIntro && (
        <div className="settings-row">
          <span className="settings-label">位置</span>
          <button className={`settings-pill ${cfg.position === 'top' ? 'active' : ''}`}
            onClick={() => set('position', 'top')}>顶部</button>
          <button className={`settings-pill ${cfg.position === 'bottom' ? 'active' : ''}`}
            onClick={() => set('position', 'bottom')}>底部</button>
        </div>
      )}

      {!isIntro && (
        <div className="settings-row">
          <label className="settings-toggle">
            <input type="checkbox" checked={cfg.showClock}
              onChange={e => set('showClock', e.target.checked)} />
            <span className="settings-toggle-track" />
            <span className="settings-toggle-label">显示时钟</span>
          </label>
        </div>
      )}

      {isIntro ? (
        <>
          <div className="sb-grid">
            <label className="sb-field">
              <span>页眉标题</span>
              <input value={cfg.introTitle} onChange={e => set('introTitle', e.target.value)}
                placeholder="选手介绍 / 运动员出场" />
            </label>
            <label className="sb-field">
              <span>样式</span>
              <span className="intro-style-pills">
                {INTRO_STYLES.map(([value, label]) => (
                  <button key={value} type="button"
                    className={`settings-pill ${(cfg.introStyle || 'card') === value ? 'active' : ''}`}
                    onClick={() => set('introStyle', value)}>{label}</button>
                ))}
              </span>
            </label>
          </div>

          <div className="settings-row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            <span className="settings-label">上屏</span>
            <button className="settings-pill" onClick={() => introAction('prev')}>◀ 上一位</button>
            <button className="settings-pill" onClick={() => introAction('next')}>下一位 ▶</button>
            <button className={`settings-pill ${cfg.introVisible !== false ? 'active' : ''}`}
              onClick={() => set('introVisible', true)}>显示</button>
            <button className={`settings-pill ${cfg.introVisible === false ? 'active' : ''}`}
              onClick={() => set('introVisible', false)}>隐藏</button>
          </div>

          <div className="settings-row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            <span className="settings-label">当前</span>
            <select
              className="settings-select"
              style={{ width: 190, margin: 0 }}
              value={namedRoster.length ? Math.min(cfg.introIndex || 0, namedRoster.length - 1) : 0}
              onChange={e => save({ introIndex: Number(e.target.value) })}
              disabled={!namedRoster.length}
            >
              {!namedRoster.length && <option value={0}>暂无选手</option>}
              {namedRoster.map((a, i) => (
                <option key={`${a.lane}-${i}`} value={i}>
                  {a.lane} 道 · {a.name}{a.unit ? `（${a.unit}）` : ''}
                </option>
              ))}
            </select>
            <span className="intro-current-tag">
              {namedRoster.length ? `${Math.min((cfg.introIndex || 0) + 1, namedRoster.length)} / ${namedRoster.length}` : '0 / 0'}
              {currentIntro?.pb ? ` · PB ${currentIntro.pb}` : ''}
            </span>
          </div>

          <div className="settings-row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            <label className="settings-toggle">
              <input type="checkbox" checked={cfg.introShowPhoto !== false}
                onChange={e => set('introShowPhoto', e.target.checked)} />
              <span className="settings-toggle-track" />
              <span className="settings-toggle-label">照片</span>
            </label>
            <label className="settings-toggle">
              <input type="checkbox" checked={cfg.introShowPb !== false}
                onChange={e => set('introShowPb', e.target.checked)} />
              <span className="settings-toggle-track" />
              <span className="settings-toggle-label">最好成绩</span>
            </label>
            <label className="settings-toggle">
              <input type="checkbox" checked={cfg.introShowNote !== false}
                onChange={e => set('introShowNote', e.target.checked)} />
              <span className="settings-toggle-track" />
              <span className="settings-toggle-label">亮点</span>
            </label>
          </div>

          <div className="settings-row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            <label className="settings-toggle">
              <input type="checkbox" checked={!!cfg.introAuto}
                onChange={e => set('introAuto', e.target.checked)} />
              <span className="settings-toggle-track" />
              <span className="settings-toggle-label">自动轮播</span>
            </label>
            <span className="settings-label">间隔</span>
            <select className="settings-select" style={{ width: 92, margin: 0 }}
              value={String(cfg.introAutoMs || 8000)}
              onChange={e => set('introAutoMs', Number(e.target.value))}>
              {[5000, 8000, 12000, 20000, 30000].map(ms => (
                <option key={ms} value={ms}>{ms / 1000}s</option>
              ))}
            </select>
            <span className="settings-label">自动隐藏</span>
            <select className="settings-select" style={{ width: 92, margin: 0 }}
              value={String(cfg.introHold || 0)}
              onChange={e => set('introHold', Number(e.target.value))}>
              {[0, 5, 10, 15, 20, 30].map(s => (
                <option key={s} value={s}>{s === 0 ? '常显' : `${s}s`}</option>
              ))}
            </select>
            {(cfg.introStyle === 'roster') && (
              <>
                <span className="settings-label">每屏</span>
                <select className="settings-select" style={{ width: 92, margin: 0 }}
                  value={String(cfg.introPerScreen || 3)}
                  onChange={e => set('introPerScreen', Number(e.target.value))}>
                  {[1, 2, 3, 4, 6, 8].map(n => (
                    <option key={n} value={n}>{n} 人</option>
                  ))}
                </select>
              </>
            )}
          </div>

          <div className="settings-row">
            <span className="settings-label">选手人数</span>
            <select value={laneCount} onChange={e => resizeLanes(e.target.value)}
              className="settings-select" style={{ width: 88, margin: 0 }}>
              {[1, 2, 4, 6, 8, 10, 12, 16, 20, 24].map(n => (
                <option key={n} value={n}>{n} 人</option>
              ))}
            </select>
            <span className="intro-editor-hint">姓名 / 单位 / 号码 / 最好成绩 / 亮点，可上传照片</span>
          </div>

          <RosterImportBox
            existing={roster}
            lanes={laneCount}
            onImport={(athletes) => save({ athletes })}
          />

          <div className="track-editor intro-editor">
            {roster.map((a, i) => (
              <div key={i} className="intro-editor-row">
                <span className="track-editor-lane">{a.lane}</span>
                <div className="intro-editor-main">
                  <div className="intro-editor-line">
                    <input
                      className="intro-editor-name"
                      value={a.name}
                      placeholder="姓名"
                      onChange={e => updateAthlete(i, 'name', e.target.value)}
                    />
                    <input
                      className="intro-editor-unit"
                      value={a.unit || ''}
                      placeholder="单位 / 班级"
                      onChange={e => updateAthlete(i, 'unit', e.target.value)}
                    />
                    <label className={`intro-photo-btn ${a.photo ? 'has' : 'is-default'}`}
                      title={a.photo ? '更换照片' : '当前用默认队徽 · 点击上传个人照片'}>
                      <img src={a.photo || DEFAULT_ATHLETE_PHOTO} alt="" />
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={e => { onPhotoPick(i, e.target.files?.[0]); e.target.value = ''; }}
                      />
                    </label>
                    {a.photo ? (
                      <button type="button" className="intro-photo-clear"
                        title="移除照片"
                        onClick={() => updateAthlete(i, 'photo', '')}>×</button>
                    ) : null}
                  </div>
                  <div className="intro-editor-line">
                    <input
                      className="intro-editor-bib"
                      value={a.bib || ''}
                      placeholder="号码"
                      onChange={e => updateAthlete(i, 'bib', e.target.value)}
                    />
                    <input
                      className="intro-editor-pb"
                      value={a.pb || ''}
                      placeholder="PB 10.23"
                      onChange={e => updateAthlete(i, 'pb', e.target.value)}
                    />
                    <input
                      className="intro-editor-note"
                      value={a.note || ''}
                      placeholder="亮点（如：上届冠军 / 校纪录保持者）"
                      onChange={e => updateAthlete(i, 'note', e.target.value)}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : isTrack ? (
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
