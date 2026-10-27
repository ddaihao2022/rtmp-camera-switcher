import { Fragment, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { parseProgram } from '../utils/roster';

const API = 'http://localhost:3001';

const SAMPLE = [
  '# 10:30 男子100米 预赛 第1组',
  '3 张三 高一2班 1023 11.20',
  '4 李四 高一3班 1024 11.35',
  '# 10:36 男子100米 预赛 第2组',
  '3 王五 高二1班 1088 10.98',
  '4 赵六 高二2班 1089 11.45',
  '# 10:50 女子跳远 决赛',
  '王七 高三1班',
  '孙八 高三2班',
].join('\n');

/**
 * 节目单 —— 赛程紧凑时的省事开关
 *
 * 一次把整天节目单（项目 + 轮次 + 组次 + 该节名册）粘进来，现场只按「下一项」，
 * 项目名 / 轮次 / 组次 / 名册一次就位，不用再逐个敲名字。
 * 数据落在服务端 scoreboardConfig.program，主控、HDMI、录像、手机端都读同一份。
 */
export function ProgramSection() {
  const [cfg, setCfg] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [showSample, setShowSample] = useState(false);
  const [meets, setMeets] = useState([]);
  const [meetId, setMeetId] = useState('');

  useEffect(() => {
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(setCfg).catch(() => {});
    const socket = io(API);
    socket.on('scoreboard:update', setCfg);
    fetch(`${API}/api/meets`)
      .then(r => (r.ok ? r.json() : []))
      .then(list => {
        if (!Array.isArray(list) || !list.length) return;
        setMeets(list);
        setMeetId(prev => prev || list[0].id);
      })
      .catch(() => {});
    return () => socket.disconnect();
  }, []);

  const resync = () => {
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(setCfg).catch(() => {});
  };

  const post = async (patch) => {
    setBusy(true);
    setErr('');
    try {
      const r = await fetch(`${API}/api/scoreboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const raw = await r.text();
      let d = {};
      try { d = raw ? JSON.parse(raw) : {}; } catch { d = {}; }
      if (!r.ok || d?.ok === false) {
        setErr(d?.error || `操作失败（HTTP ${r.status}）`);
        resync();
        return null;
      }
      setCfg(d);
      return d;
    } catch (e) {
      setErr('操作失败：' + (e?.message || '网络错误'));
      resync();
      return null;
    } finally {
      setBusy(false);
    }
  };

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3000); };

  const parsed = useMemo(() => parseProgram(text), [text]);
  const program = cfg?.program || [];
  const current = Math.max(0, Math.min(program.length - 1, Number(cfg?.programIndex) || 0));
  const countText = (e) => {
    if (!e?.count) return '';
    return `${e.count} ${e.eventKind === 'relay' ? '队' : '人'}`;
  };

  const generate = async () => {
    if (!parsed.entries.length) { flash('没识别到节目，检查一下格式'); return; }
    if (program.length && !window.confirm(`将用 ${parsed.entries.length} 节新节目单覆盖现有 ${program.length} 节，继续？`)) return;
    const d = await post({ program: parsed.entries, programIndex: 0, applyFirst: true });
    if (!d) return;
    flash(`已生成 ${parsed.entries.length} 节节目单，并落到第 1 节`);
    setText('');
  };

  const loadMeet = async () => {
    if (!meetId) return;
    const meet = meets.find(m => m.id === meetId);
    const n = Number(meet?.stats?.programEntries) || 0;
    if (program.length && !window.confirm(
      `将用「${meet?.shortName || meetId}」的${n ? ` ${n} 节` : ''}赛程覆盖现有 ${program.length} 节节目单，继续？`
    )) return;

    setBusy(true);
    setErr('');
    try {
      const r = await fetch(`${API}/api/meets/${encodeURIComponent(meetId)}/program`);
      const raw = await r.text();
      let d = {};
      try { d = raw ? JSON.parse(raw) : {}; } catch { d = {}; }
      if (!r.ok || !Array.isArray(d?.program) || !d.program.length) {
        setErr(d?.error || `载入失败（HTTP ${r.status}）`);
        return;
      }
      const saved = await post({
        program: d.program,
        programIndex: 0,
        applyFirst: false,
      });
      if (!saved) return;
      flash(`已载入「${d.name || meet?.shortName || meetId}」 ${d.program.length} 节赛程，点「应用」开始`);
    } catch (e) {
      setErr('载入失败：' + (e?.message || '网络错误'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (i) => {
    const e = program[i];
    const label = e ? `${e.time ? e.time + ' ' : ''}${e.eventName || ''}` : `第 ${i + 1} 节`;
    if (!window.confirm(`删除「${label}」？删除后不能撤销。`)) return;

    const next = program.filter((_, k) => k !== i);
    // 删当前节：节目内容变了，必须把新当前节重新落到名册/项目上；
    // 删当前节之前的节：当前节内容不变，只需把下标减一。
    const deletingCurrent = i === current;
    const nextIndex = deletingCurrent
      ? Math.max(0, Math.min(next.length - 1, current))
      : (i < current ? current - 1 : current);

    const d = await post({
      program: next,
      programIndex: nextIndex,
      applyFirst: deletingCurrent && next.length > 0,
    });
    if (!d) return;
    if (!next.length) flash('已删除最后一节，节目单已空（当前名册保留）');
    else if (deletingCurrent) flash('已删除当前节，并切到新的当前节');
    else flash('已删除该节');
  };

  const clearAll = async () => {
    if (!window.confirm('清空整份节目单？当前名册会保留，但节目单不能撤销。')) return;
    const d = await post({ program: [], programIndex: 0, applyFirst: false });
    if (!d) return;
    flash('节目单已清空（当前名册保留）');
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">
        🗂 节目单（一键切项）
        {busy && <span className="settings-saving"> ●</span>}
      </div>

      <div className="settings-row">
        <span className="settings-label">
          当前：{program.length
            ? `${program[current]?.label || '—'}（${current + 1}/${program.length} · ${countText(program[current]) || '0 人'}）`
            : '未载入节目单'}
        </span>
      </div>

      <p className="settings-muted">
        把整天节目单（含每节名册）一次粘进来，现场只按 <b>下一项</b>（或 PageDown），
        项目 / 轮次 / 组次 / 名册一次就位，不用再手打名字；切换前会把当前道次名册存回该节。
      </p>

      {meets.length > 0 && (
        <div className="settings-row" style={{ gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="settings-select"
            style={{ margin: 0, flex: '1 1 12rem', minWidth: 0 }}
            value={meetId}
            onChange={e => setMeetId(e.target.value)}
            disabled={busy}
          >
            {meets.map(m => (
              <option key={m.id} value={m.id}>
                {m.shortName || m.name}
                {m.stats?.programEntries ? `（${m.stats.programEntries} 节）` : ''}
              </option>
            ))}
          </select>
          <button type="button" className="settings-btn-primary" disabled={busy || !meetId}
            onClick={loadMeet}>
            载入本届赛程
          </button>
        </div>
      )}
      {meets.length > 0 && (
        <p className="settings-muted">
          内置秩序册赛程，一键预置全部项目 / 轮次 / 组次 / 名册；只载入不切换，确认后点第 1 节的「应用」。
        </p>
      )}

      <textarea
        className="settings-textarea"
        rows={4}
        value={text}
        placeholder={'# 10:30 男子100米 预赛 第1组\n3 张三 高一2班 1023 11.20\n# 10:36 男子100米 预赛 第2组\n3 王五 高二1班 1088 10.98'}
        onChange={e => setText(e.target.value)}
      />

      <div className="settings-row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
        <button type="button" className="settings-pill" onClick={() => setShowSample(v => !v)}>
          {showSample ? '收起示例' : '看示例'}
        </button>
        <button type="button" className="settings-btn-primary" disabled={busy || !parsed.entries.length}
          onClick={generate}>
          生成节目单{parsed.entries.length ? `（${parsed.entries.length} 节 / ${parsed.entries.reduce((n, e) => n + e.count, 0)} 人）` : ''}
        </button>
        {program.length > 0 && (
          <button type="button" className="settings-btn-danger" disabled={busy}
            onClick={clearAll}>
            清空节目单
          </button>
        )}
      </div>

      {showSample && <pre className="roster-import-sample">{SAMPLE}</pre>}

      {parsed.warnings.length > 0 && (
        <p className="settings-muted">有 {parsed.warnings.length} 行没识别（已跳过）：{parsed.warnings[0].slice(0, 24)}</p>
      )}
      {msg && <p className="settings-muted" style={{ color: '#86efac' }}>{msg}</p>}
      {err && <p className="settings-muted" style={{ color: '#fca5a5' }}>{err}</p>}

      {program.length > 0 && (
        <div className="program-list">
          {program.map((e, i) => (
            <Fragment key={e.id || i}>
              {e.sessionLabel && e.sessionLabel !== program[i - 1]?.sessionLabel && (
                <div className="program-session">{e.sessionLabel}</div>
              )}
              <div className={`program-row ${i === current ? 'on' : ''}`}>
                <span className="program-row-idx">{i + 1}</span>
                <div className="program-row-main">
                  <strong>{e.time ? `${e.time} ` : ''}{e.eventName}</strong>
                  <span className="settings-muted">
                    {[e.round, e.heat].filter(Boolean).join(' · ')}{e.count ? ` · ${countText(e)}` : ''}
                  </span>
                </div>
                <button type="button" className="settings-pill" disabled={busy}
                  onClick={() => post({ programAction: 'apply', programIndex: i })}>应用</button>
                <button type="button" className="intro-photo-clear" title="移除该节"
                  disabled={busy} onClick={() => remove(i)}>×</button>
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

export default ProgramSection;
