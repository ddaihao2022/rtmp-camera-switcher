import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API = 'http://localhost:3001';

const POSITIONS = [
  { value: 'top-left',     label: '↖ 左上' },
  { value: 'top-right',    label: '↗ 右上' },
  { value: 'bottom-left',  label: '↙ 左下' },
  { value: 'bottom-right', label: '↘ 右下' },
  { value: 'center',       label: '⊙ 居中' },
];

const WM_DEFAULT = {
  enabled: false,
  type: 'text',
  text: '',
  imageUrl: '',
  position: 'bottom-right',
  opacity: 0.25,
  fontSize: 36,
  color: '#ffffff',
  padding: 28,
};

// ─── 水印分组 ─────────────────────────────────────────────────────────────────
function WatermarkSection() {
  const [cfg, setCfg] = useState(WM_DEFAULT);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/api/watermark`).then(r => r.json()).then(setCfg).catch(() => {});
    const socket = io(API);
    socketRef.current = socket;
    socket.on('watermark:update', setCfg);
    return () => socket.disconnect();
  }, []);

  const save = async (patch) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setSaving(true);
    try {
      await fetch(`${API}/api/watermark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
    } finally {
      setSaving(false);
    }
  };

  const set = (key, value) => save({ [key]: value });

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => save({ type: 'image', imageUrl: ev.target.result });
    reader.readAsDataURL(file);
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">
        🖼 水印
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
        <button className={`settings-pill ${cfg.type === 'text' ? 'active' : ''}`}
          onClick={() => set('type', 'text')}>文字</button>
        <button className={`settings-pill ${cfg.type === 'image' ? 'active' : ''}`}
          onClick={() => set('type', 'image')}>图片</button>
      </div>

      {cfg.type === 'text' ? (
        <>
          <textarea className="settings-textarea" rows={2} placeholder="水印文字内容..."
            value={cfg.text} onChange={e => set('text', e.target.value)} />
          <div className="settings-row">
            <span className="settings-label">颜色</span>
            <input type="color" value={cfg.color}
              onChange={e => set('color', e.target.value)} className="settings-color" />
            <span className="settings-muted">{cfg.color}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">字号 {cfg.fontSize}px</span>
            <input type="range" className="settings-slider" min="14" max="120" step="2"
              value={cfg.fontSize} onChange={e => set('fontSize', +e.target.value)} />
          </div>
        </>
      ) : (
        <>
          <input type="file" accept="image/*" ref={fileRef} style={{ display: 'none' }}
            onChange={handleImageUpload} />
          <button className="settings-btn-outline" onClick={() => fileRef.current?.click()}>
            📁 选择图片
          </button>
          {cfg.imageUrl && (
            <img src={cfg.imageUrl} alt="preview"
              style={{ width: '100%', maxHeight: 56, objectFit: 'contain',
                       background: '#0a0a0a', borderRadius: 4, marginTop: 6 }} />
          )}
          <div className="settings-row" style={{ marginTop: 8 }}>
            <span className="settings-label">显示大小 {cfg.fontSize * 3}px</span>
            <input type="range" className="settings-slider" min="14" max="120" step="2"
              value={cfg.fontSize} onChange={e => set('fontSize', +e.target.value)} />
          </div>
        </>
      )}

      <div className="settings-label" style={{ marginTop: 8, marginBottom: 4 }}>位置</div>
      <div className="settings-pos-grid">
        {POSITIONS.map(p => (
          <button key={p.value}
            className={`settings-pos-btn ${cfg.position === p.value ? 'active' : ''}`}
            onClick={() => set('position', p.value)}>{p.label}</button>
        ))}
      </div>

      <div className="settings-row">
        <span className="settings-label">透明度 {Math.round(cfg.opacity * 100)}%</span>
        <input type="range" className="settings-slider" min="0.05" max="0.95" step="0.05"
          value={cfg.opacity} onChange={e => set('opacity', +e.target.value)} />
      </div>

      <div className="settings-row">
        <span className="settings-label">边距 {cfg.padding}px</span>
        <input type="range" className="settings-slider" min="0" max="80" step="4"
          value={cfg.padding} onChange={e => set('padding', +e.target.value)} />
      </div>
    </section>
  );
}

// ─── HDMI 分组 ────────────────────────────────────────────────────────────────
function HdmiSection() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  const [displays, setDisplays] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [outputOpen, setOutputOpen] = useState(false);

  const refresh = async () => {
    if (!api) return;
    const list = await api.listDisplays();
    setDisplays(list);
    const s = await api.getOutputStatus();
    setOutputOpen(s.open);
    if (selectedId == null) {
      const t = list.find(d => !d.primary) || list[0];
      if (t) setSelectedId(t.id);
    }
  };

  useEffect(() => {
    if (!api) return;
    refresh();
    const offChanged = api.onDisplaysChanged(refresh);
    const offClosed = api.onOutputClosed(() => setOutputOpen(false));
    return () => { offChanged?.(); offClosed?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!api) return (
    <section className="settings-section">
      <div className="settings-section-title">📺 HDMI 输出</div>
      <p className="settings-muted">请在桌面客户端中使用此功能</p>
    </section>
  );

  return (
    <section className="settings-section">
      <div className="settings-section-title">📺 HDMI 输出</div>
      {displays.length === 0 ? (
        <p className="settings-muted">未检测到外接显示器</p>
      ) : (
        <>
          <select className="settings-select" value={selectedId ?? ''}
            onChange={e => setSelectedId(Number(e.target.value))}>
            {displays.map(d => (
              <option key={d.id} value={d.id}>
                {d.label} {d.primary ? '(主屏)' : ''} {d.bounds.width}×{d.bounds.height}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {!outputOpen ? (
              <button className="settings-btn-primary"
                onClick={async () => { await api.openOutput(selectedId); setOutputOpen(true); }}>
                ▶ 开启全屏输出
              </button>
            ) : (
              <button className="settings-btn-danger"
                onClick={async () => { await api.closeOutput(); setOutputOpen(false); }}>
                ■ 关闭输出
              </button>
            )}
          </div>
          <p className="settings-muted" style={{ marginTop: 6 }}>
            {outputOpen ? '输出窗口正在目标显示器上全屏运行' : '将在选中显示器上全屏播放当前主输出流'}
          </p>
        </>
      )}
    </section>
  );
}

// ─── 日志分组 ─────────────────────────────────────────────────────────────────
function LogSection() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  const [verbose, setVerbose] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        if (api) {
          const s = await api.getLogStatus();
          setVerbose(s.verbose);
          api.onLogStatusChanged(d => setVerbose(d.verbose));
        } else {
          const r = await fetch(`${API}/api/log/status`);
          const d = await r.json();
          setVerbose(d.verbose);
        }
      } catch {}
    };
    load();
  }, [api]);

  const toggle = async () => {
    const next = !verbose;
    setPending(true);
    try {
      if (api) {
        const r = await api.toggleLog(next);
        setVerbose(r.verbose);
      } else {
        const r = await fetch(`${API}/api/log/toggle`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verbose: next }),
        });
        const d = await r.json();
        setVerbose(d.verbose);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-title">🪲 调试日志</div>
      <div className="settings-row">
        <label className="settings-toggle">
          <input type="checkbox" checked={verbose} disabled={pending}
            onChange={toggle} />
          <span className="settings-toggle-track" />
          <span className="settings-toggle-label">
            {verbose ? '详细日志已开启' : '仅输出业务日志'}
          </span>
        </label>
      </div>
      <p className="settings-muted">
        {verbose
          ? '开启后额外输出 RTMP packet 诊断、publisher 吞吐统计，同时写入日志文件'
          : '关闭时仅记录推流上线/下线等关键事件'}
      </p>
    </section>
  );
}

// ─── 主弹窗 ───────────────────────────────────────────────────────────────────
export default function SettingsModal({ open, onClose }) {
  // 点击背景关闭
  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!open) return null;

  return (
    <div className="settings-backdrop" onClick={handleBackdrop}>
      <div className="settings-modal" role="dialog" aria-label="设置">
        <div className="settings-modal-header">
          <span>⚙️ 设置</span>
          <button className="settings-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="settings-modal-body">
          <HdmiSection />
          <WatermarkSection />
          <LogSection />
        </div>
      </div>
    </div>
  );
}
