import { useEffect, useMemo, useState } from 'react';
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
  const [showSample, setShowSample] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/scoreboard`).then(r => r.json()).then(setCfg).catch(() => {});
    const socket = io(API);
    socket.on('scoreboard:update', setCfg);
    return () => socket.disconnect();
  }, []);

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

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3000); };

  const parsed = useMemo(() => parseProgram(text), [text]);
  const program = cfg?.program || [];
  const current = Math.max(0, Math.min(program.length - 1, Number(cfg?.programIndex) || 0));

  const generate = async () => {
    if (!parsed.entries.length) { flash('没识别到节目，检查一下格式'); return; }
    await post({ program: parsed.entries, programIndex: 0, applyFirst: true });
    flash(`已生成 ${parsed.entries.length} 节节目单，并落到第 1 节`);
    setText('');
  };

  const remove = (i) => {
    const next = program.filter((_, k) => k !== i);
    post({ program: next, programIndex: Math.max(0, Math.min(next.length - 1, current)), applyFirst: false });
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
            ? `${program[current]?.label || '—'}（${current + 1}/${program.length} · ${program[current]?.count || 0} 人）`
            : '未载入节目单'}
        </span>
      </div>

      <p className="settings-muted">
        把整天节目单（含每节名册）一次粘进来，现场只按 <b>下一项</b>（或 PageDown），
        项目 / 轮次 / 组次 / 名册一次就位，不用再手打名字；切换前会把当前道次名册存回该节。
      </p>

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
            onClick={async () => { await post({ program: [], applyFirst: false }); flash('节目单已清空（当前名册保留）'); }}>
            清空节目单
          </button>
        )}
      </div>

      {showSample && <pre className="roster-import-sample">{SAMPLE}</pre>}

      {parsed.warnings.length > 0 && (
        <p className="settings-muted">有 {parsed.warnings.length} 行没识别（已跳过）：{parsed.warnings[0].slice(0, 24)}</p>
      )}
      {msg && <p className="settings-muted" style={{ color: '#86efac' }}>{msg}</p>}

      {program.length > 0 && (
        <div className="program-list">
          {program.map((e, i) => (
            <div key={e.id || i} className={`program-row ${i === current ? 'on' : ''}`}>
              <span className="program-row-idx">{i + 1}</span>
              <div className="program-row-main">
                <strong>{e.time ? `${e.time} ` : ''}{e.eventName}</strong>
                <span className="settings-muted">
                  {[e.round, e.heat].filter(Boolean).join(' · ')}{e.count ? ` · ${e.count} 人` : ''}
                </span>
              </div>
              <button type="button" className="settings-pill" disabled={busy}
                onClick={() => post({ programAction: 'apply', programIndex: i })}>应用</button>
              <button type="button" className="intro-photo-clear" title="移除该节"
                onClick={() => remove(i)}>×</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default ProgramSection;
