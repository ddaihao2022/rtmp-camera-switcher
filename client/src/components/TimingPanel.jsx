import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';

const API = 'http://localhost:3001';

/**
 * 侧栏「计时录入」——手动计时老师扫码录成绩，去极值平均后一键回传叠加层
 * 老师端页面：http://<本机内网IP>:3001/timer/
 */
export default function TimingPanel() {
  const [timing, setTiming] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [lanIp, setLanIp] = useState('localhost');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/timing`).then(r => r.json()).then(setTiming).catch(() => {});
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(setCfg).catch(() => {});
    fetch(`${API}/api/server-info`).then(r => r.json()).then(d => d?.lanIp && setLanIp(d.lanIp)).catch(() => {});
    const socket = io(API);
    socket.on('timing:update', setTiming);
    socket.on('scoreboard:update', setCfg);
    return () => socket.disconnect();
  }, []);

  const entryUrl = useMemo(() => `http://${lanIp}:3001/timer/`, [lanIp]);
  const monitorUrl = useMemo(() => `http://${lanIp}:3001/timer/monitor.html`, [lanIp]);

  const post = async (path, body) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw new Error(d.error || '请求失败');
      if (d.state) setTiming(d.state);
      return d;
    } finally {
      setBusy(false);
    }
  };

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 2600); };

  const applyAll = async () => {
    try {
      const d = await post('/api/timing/apply', { by: '导播台', withEvent: false });
      flash(`已回传 ${(d.written?.appliedLanes || []).length} 道成绩与名次`);
    } catch (e) { flash(e.message); }
  };

  const lanes = timing ? Object.values(timing.lanes || {}).sort((a, b) => a.lane - b.lane) : [];
  const st = timing?.stats || {};
  const laneCount = st.lanes || (cfg?.athletes || []).length || 8;
  const athletes = cfg?.athletes || [];
  const shortEvent = `${cfg?.category || ''}${String(cfg?.eventName || '').replace(/^(男子|女子)/, '')}`;

  return (
    <div className="timing-panel" style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={`${cfg?.eventName || ''} ${cfg?.round || ''} ${cfg?.heat || ''}`}>
          {shortEvent || '未设置项目'}{cfg?.round ? ` · ${cfg.round}` : ''}{cfg?.heat ? ` · ${cfg.heat}` : ''}
        </strong>
        <span style={{
          padding: '2px 8px', borderRadius: 999, fontWeight: 700, fontSize: 12,
          background: st.completed ? 'rgba(34,197,94,.18)' : 'rgba(148,163,184,.18)',
          color: st.completed ? '#86efac' : '#cbd5e1',
        }}>
          已录 {st.submittedLanes || 0}/{laneCount} 道 · {st.judgeCount || 0} 位老师
        </span>
      </div>

      <div style={{ background: '#fff', borderRadius: 10, padding: 6, justifySelf: 'center' }}>
        <img
          src={`${API}/api/timing/qr.svg?size=190&data=${encodeURIComponent(entryUrl)}`}
          alt="计时录入页二维码"
          style={{ width: 190, height: 190, display: 'block' }}
        />
      </div>
      <div style={{ textAlign: 'center', fontSize: 12, color: '#93c5fd', wordBreak: 'break-all' }}>{entryUrl}</div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button type="button" className="tp-btn primary" disabled={busy} onClick={applyAll}>
          回传成绩+名次
        </button>
        <button type="button" className="tp-btn" disabled={busy}
          onClick={() => { post('/api/timing/gun').then(() => flash('已发令，老师端跑表同步启动')).catch(e => flash(e.message)); }}>
          发令
        </button>
        <button type="button" className="tp-btn" onClick={() => window.open(monitorUrl, '_blank')}>
          汇总台
        </button>
        <button type="button" className="tp-btn ghost" disabled={busy}
          onClick={() => { post('/api/timing/reset', { scope: 'round' }).then(() => flash('本轮已清空')).catch(e => flash(e.message)); }}>
          清空本轮
        </button>
        <button type="button" className="tp-btn ghost" onClick={() => { navigator.clipboard?.writeText(entryUrl); flash('网址已复制'); }}>
          复制网址
        </button>
      </div>

      <button type="button" className={`tp-more ${showTable ? 'active' : ''}`} onClick={() => setShowTable(v => !v)}>
        {showTable ? '收起各道成绩 ▴' : '各道合成成绩（去极值平均）▾'}
      </button>

      {showTable && (
        <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          {lanes.map(l => {
            const a = athletes.find(x => Number(x.lane) === l.lane) || {};
            return (
              <div key={l.lane} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px', borderRadius: 6, background: 'rgba(148,163,184,.10)' }}>
                <span style={{ fontWeight: 800, width: 22 }}>{l.lane}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#94a3b8' }}>{a.name || ''}</span>
                <span style={{ color: l.count >= 3 ? '#86efac' : '#cbd5e1', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {l.finalText || '—'}
                </span>
                <span style={{ color: l.warned ? '#fcd34d' : '#64748b', width: 44, textAlign: 'right' }}>
                  {l.count ? `${l.count}人` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {msg && <div style={{ fontSize: 12, color: '#86efac' }}>{msg}</div>}
      <p style={{ margin: 0, fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
        计时的老师用手机扫上面的二维码 → 选自己的姓名 → 点「发令」开跑表，到终点按道次按钮抓成绩（也可手输 12.34 / 1:02.34）。
        老师提交后自动去极值平均；点「回传成绩+名次」即上屏。规则与名单在汇总台调整。
      </p>
    </div>
  );
}
