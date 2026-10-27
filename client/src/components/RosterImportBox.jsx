import { useMemo, useRef, useState } from 'react';
import { parseRoster } from '../utils/roster';

const SAMPLE = [
  '3 张三 高一2班 1023 11.20',
  '4 李四 高一3班 1024 11.35',
  '5 王五 高二1班 1088 10.98',
].join('\n');

function blankAthlete(lane) {
  return { lane, name: '', place: '', result: '', unit: '', bib: '', pb: '', note: '', photo: '' };
}

/**
 * 名册批量导入 —— 把秩序册 / 报名表 / Excel 一列直接粘进来，一次填满整组道次。
 *
 * 归一由 utils/roster.js 完成（前端解析，服务端只存结果）：
 *   3 张三 高一2班 1023 11.20 上届冠军
 *   只写姓名也行，按顺序落到 1、2、3 道
 *
 * @param {object}   props
 * @param {object[]} props.existing 当前名册（追加重填时用它判断哪些道次已有人）
 * @param {number}   props.lanes    当前道次数量（不够时补空道）
 * @param {(athletes: object[]) => Promise<any>} props.onImport 落库（父组件的 save）
 */
export default function RosterImportBox({ existing = [], lanes = 8, onImport }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('replace');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [showSample, setShowSample] = useState(false);
  const fileRef = useRef(null);

  const parsed = useMemo(() => parseRoster(text, { lanes }), [text, lanes]);
  const preview = parsed.athletes.filter(a => a.name || a.bib || a.pb).slice(0, 6);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 3000); };

  const readFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setText(String(ev.target?.result || ''));
    reader.readAsText(file, 'utf-8');
  };

  const apply = async () => {
    if (!parsed.count) { flash('没识别到选手，检查一下格式'); return; }
    setBusy(true);
    try {
      let athletes;
      if (mode === 'append') {
        // 只填空道次：现场补录漏掉的人，不动已录入的
        const total = Math.max(existing.length, parsed.athletes.length, lanes);
        athletes = Array.from({ length: total }, (_, i) => ({ ...(existing[i] || blankAthlete(i + 1)) }));
        parsed.athletes.forEach((src, i) => {
          if (!src) return;
          const slot = athletes[i] || (athletes[i] = blankAthlete(i + 1));
          if (String(slot.name || '').trim()) return;
          athletes[i] = {
            ...slot,
            name: src.name, unit: src.unit || slot.unit,
            bib: src.bib || slot.bib, pb: src.pb || slot.pb, note: src.note || slot.note,
          };
        });
      } else {
        athletes = parsed.athletes.map((src, i) => {
          const prev = existing[i];
          // 同姓名同道次 → 保留已上传的照片
          const keepPhoto = prev && prev.photo && String(prev.name || '').trim() === String(src.name || '').trim();
          return {
            ...blankAthlete(i + 1),
            name: src.name, unit: src.unit, bib: src.bib, pb: src.pb, note: src.note,
            photo: keepPhoto ? prev.photo : '',
          };
        });
      }
      const saved = await onImport(athletes);
      if (saved === null) {
        setErr('导入失败，未保存；原因见上方提示');
        return;
      }
      setErr('');
      flash(`已导入 ${parsed.count} 位选手（${mode === 'append' ? '填空道次' : '覆盖名册'}）`);
      setText('');
    } catch (e) {
      setErr('导入失败：' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="roster-import">
      <div className="roster-import-head">
        <span className="settings-label">📋 批量导入名册</span>
        <button type="button" className="roster-import-link"
          onClick={() => setShowSample(v => !v)}>{showSample ? '收起示例' : '看示例'}</button>
      </div>

      {showSample && (
        <pre className="roster-import-sample">{SAMPLE}
{''}
# 道次可省，只写姓名按顺序落道
# Excel 粘贴（Tab）与逗号、顿号分隔都认</pre>
      )}

      <textarea
        className="settings-textarea roster-import-text"
        rows={4}
        value={text}
        placeholder={'把秩序册/报名表直接粘进来，一行一人：\n3 张三 高一2班 1023 11.20\n4 李四 高一3班 1024 11.35'}
        onChange={e => setText(e.target.value)}
      />

      <div className="settings-row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
        <button type="button" className="settings-pill" onClick={() => fileRef.current?.click()}>
          📁 选文件
        </button>
        <input type="file" accept=".txt,.csv,.tsv,text/plain" ref={fileRef} hidden
          onChange={e => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
        <button type="button" className={`settings-pill ${mode === 'replace' ? 'active' : ''}`}
          onClick={() => setMode('replace')} title="整份替换当前名册">覆盖</button>
        <button type="button" className={`settings-pill ${mode === 'append' ? 'active' : ''}`}
          onClick={() => setMode('append')} title="只填当前空着的道次">填空道次</button>
        <button type="button" className="settings-btn-primary" disabled={busy || !parsed.count}
          onClick={apply}>
          {busy ? '导入中…' : `导入${parsed.count ? ` ${parsed.count} 人` : ''}`}
        </button>
      </div>

      {parsed.count > 0 && (
        <div className="roster-import-preview">
          {preview.map((a, i) => (
            <span key={i} className="roster-import-chip">
              <b>{a.lane}</b>{a.name}{a.unit ? ` · ${a.unit}` : ''}{a.pb ? ` · ${a.pb}` : ''}
            </span>
          ))}
          {parsed.count > preview.length && <span className="settings-muted">…共 {parsed.count} 人</span>}
        </div>
      )}

      {parsed.warnings.length > 0 && (
        <p className="settings-muted">
          有 {parsed.warnings.length} 行没识别出选手（已跳过）：{parsed.warnings[0].slice(0, 24)}
        </p>
      )}
      {err && <p className="settings-muted" style={{ color: '#fca5a5' }}>{err}</p>}
      {msg && <p className="settings-muted" style={{ color: '#86efac' }}>{msg}</p>}
    </div>
  );
}
