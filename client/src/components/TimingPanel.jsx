import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { eventDisplayName } from '../utils/eventName';

const API = 'http://localhost:3001';

/**
 * 侧栏「计时录入」——手动计时老师扫码录成绩，去极值平均后一键回传叠加层
 * 老师端页面：http://<本机内网IP>:3001/timer/
 */
export default function TimingPanel() {
  const [timing, setTiming] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [lanIp, setLanIp] = useState('localhost');
  const [candidates, setCandidates] = useState([]);
  const [pickedIp, setPickedIp] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/timing`).then(r => r.json()).then(setTiming).catch(() => {});
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(setCfg).catch(() => {});
    fetch(`${API}/api/server-info`).then(r => r.json()).then(d => {
      if (d?.lanIp) setLanIp(d.lanIp);
      if (Array.isArray(d?.candidates)) setCandidates(d.candidates);
    }).catch(() => {});
    const socket = io(API);
    socket.on('timing:update', setTiming);
    socket.on('scoreboard:update', setCfg);
    return () => socket.disconnect();
  }, []);

  const activeIp = pickedIp || lanIp;
  const entryUrl = useMemo(() => `http://${activeIp}:3001/timer/`, [activeIp]);
  const monitorUrl = useMemo(() => `http://${activeIp}:3001/timer/monitor.html`, [activeIp]);
  const consoleUrl = useMemo(() => `http://${activeIp}:3001/console/`, [activeIp]);

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
    const filled = lanes.filter(l => l.finalMs != null).length;
    if (!filled) { flash('还没有可回传的成绩'); return; }
    if (!window.confirm(`将把 ${filled} 道成绩和名次覆盖到大屏，确定？`)) return;
    try {
      const d = await post('/api/timing/apply', { by: '导播台', withEvent: false });
      flash(`已回传 ${(d.written?.appliedLanes || []).length} 道成绩与名次`);
    } catch (e) { flash(e.message); }
  };

  const lanes = timing ? Object.values(timing.lanes || {}).sort((a, b) => a.lane - b.lane) : [];
  const st = timing?.stats || {};
  const laneCount = st.lanes || (cfg?.athletes || []).length || 8;
  const athletes = cfg?.athletes || [];
  const shortEvent = eventDisplayName(cfg?.eventName, cfg?.category);

  // 裁判提交情况：从各道读数反推每位老师最近一次提交，现场能看出谁掉线
  const judgeStatus = useMemo(() => {
    const byJudge = new Map();
    for (const l of lanes) {
      for (const v of l.values || []) {
        const cur = byJudge.get(v.judgeId) || { lanes: 0, last: 0 };
        cur.lanes += 1;
        cur.last = Math.max(cur.last, Number(v.at) || 0);
        byJudge.set(v.judgeId, cur);
      }
    }
    return (timing?.judges || [])
      .filter(j => j.active !== false)
      .map(j => ({ id: j.id, name: j.name, ...(byJudge.get(j.id) || { lanes: 0, last: 0 }) }));
  }, [timing]);

  return (
    <div className="timing-panel" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0, maxWidth: '100%' }}>
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

      {judgeStatus.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 11 }}>
          {judgeStatus.map(j => {
            const fresh = j.last && Date.now() - j.last < 3 * 60_000;
            return (
              <span key={j.id}
                title={j.last ? `最近提交 ${new Date(j.last).toLocaleTimeString('zh-CN')}` : '本轮还没有提交'}
                style={{
                  padding: '2px 7px', borderRadius: 999,
                  background: j.lanes ? (fresh ? 'rgba(34,197,94,.16)' : 'rgba(148,163,184,.14)') : 'rgba(148,163,184,.08)',
                  color: j.lanes ? (fresh ? '#86efac' : '#cbd5e1') : '#64748b',
                }}>
                {j.name}{j.lanes ? ` · ${j.lanes}道` : ' · 未交'}
              </span>
            );
          })}
        </div>
      )}

      {candidates.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>老师扫码地址</span>
          <select value={activeIp} onChange={e => setPickedIp(e.target.value)}
            style={{
              flex: 1, background: 'rgba(255,255,255,.06)', color: '#e5e7eb',
              border: '1px solid rgba(255,255,255,.16)', borderRadius: 6, padding: '3px 6px',
            }}>
            {candidates.map(c => (
              <option key={c.address} value={c.address}>
                {c.name} · {c.address}{c.virtual ? '（虚拟网卡）' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, minWidth: 0 }}>
        <div style={{
          display: 'grid', justifyItems: 'center', gap: 5, padding: 8, minWidth: 0,
          background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
          borderRadius: 10,
        }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>老师录成绩</span>
          <img
            src={`${API}/api/timing/qr.svg?size=180&data=${encodeURIComponent(entryUrl)}`}
            alt="计时录入页二维码"
            style={{ width: '100%', maxWidth: 150, aspectRatio: '1', height: 'auto', display: 'block', background: '#fff', borderRadius: 8, padding: 5 }}
          />
          <div style={{ textAlign: 'center', fontSize: 10.5, color: '#93c5fd', wordBreak: 'break-all', overflowWrap: 'anywhere', width: '100%', minWidth: 0 }}>{entryUrl}</div>
        </div>
        <div style={{
          display: 'grid', justifyItems: 'center', gap: 5, padding: 8, minWidth: 0,
          background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)',
          borderRadius: 10,
        }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>网页控台</span>
          <img
            src={`${API}/api/timing/qr.svg?size=180&data=${encodeURIComponent(consoleUrl)}`}
            alt="网页控台二维码"
            style={{ width: '100%', maxWidth: 150, aspectRatio: '1', height: 'auto', display: 'block', background: '#fff', borderRadius: 8, padding: 5 }}
          />
          <div style={{ textAlign: 'center', fontSize: 10.5, color: '#93c5fd', wordBreak: 'break-all', overflowWrap: 'anywhere', width: '100%', minWidth: 0 }}>{consoleUrl}</div>
          <button type="button" className="tp-btn" style={{ width: '100%' }}
            onClick={() => window.open(consoleUrl, '_blank')}>
            打开控台
          </button>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
        手机需与电脑连同一 Wi-Fi；扫码打不开时，检查 Windows 防火墙是否放行 3001 端口。
      </p>

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
        <button type="button" className="tp-btn" onClick={() => window.open(consoleUrl, '_blank')}>
          网页控台
        </button>
        <button type="button" className="tp-btn ghost" disabled={busy}
          onClick={() => {
            if (!window.confirm('清空本轮？所有老师本轮读数、名次和手动修正都会清空，且不会写入历史。')) return;
            post('/api/timing/reset', { scope: 'round' }).then(() => flash('本轮已清空')).catch(e => flash(e.message));
          }}>
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
