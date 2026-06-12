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

const DEFAULT = {
  enabled: false,
  type: 'text',
  text: '',
  imageUrl: '',
  position: 'bottom-right',
  opacity: 0.8,
  fontSize: 32,
  color: '#ffffff',
  padding: 24,
};

function WatermarkPanel() {
  const [cfg, setCfg] = useState(DEFAULT);
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

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => save({ type: 'image', imageUrl: ev.target.result });
    reader.readAsDataURL(file);
  };

  const set = (key, value) => save({ [key]: value });

  return (
    <div className="hdmi-panel wm-panel">
      <h3>
        水印
        {saving && <span className="wm-saving"> ●</span>}
      </h3>

      {/* 启用开关 */}
      <div className="wm-row">
        <label className="wm-toggle">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={e => set('enabled', e.target.checked)}
          />
          <span>{cfg.enabled ? '已启用' : '已关闭'}</span>
        </label>
      </div>

      {/* 类型切换 */}
      <div className="wm-row wm-type-row">
        <button
          className={`wm-type-btn ${cfg.type === 'text' ? 'active' : ''}`}
          onClick={() => set('type', 'text')}
        >
          文字
        </button>
        <button
          className={`wm-type-btn ${cfg.type === 'image' ? 'active' : ''}`}
          onClick={() => set('type', 'image')}
        >
          图片
        </button>
      </div>

      {cfg.type === 'text' ? (
        <>
          <textarea
            className="wm-textarea"
            placeholder="水印文字..."
            value={cfg.text}
            rows={2}
            onChange={e => set('text', e.target.value)}
          />
          <div className="wm-row">
            <label className="wm-label">颜色</label>
            <input
              type="color"
              value={cfg.color}
              onChange={e => set('color', e.target.value)}
              className="wm-color"
            />
            <span className="wm-val">{cfg.color}</span>
          </div>
          <div className="wm-row">
            <label className="wm-label">字号 {cfg.fontSize}px</label>
            <input
              type="range" min="16" max="120" step="2"
              value={cfg.fontSize}
              onChange={e => set('fontSize', Number(e.target.value))}
              className="wm-slider"
            />
          </div>
        </>
      ) : (
        <>
          <input
            type="file" accept="image/*" ref={fileRef} style={{ display: 'none' }}
            onChange={handleImageUpload}
          />
          <button className="hdmi-btn primary wm-upload-btn" onClick={() => fileRef.current?.click()}>
            📁 选择图片
          </button>
          {cfg.imageUrl && (
            <img src={cfg.imageUrl} alt="preview" className="wm-preview" />
          )}
          <div className="wm-row">
            <label className="wm-label">图片高度 {cfg.fontSize * 3}px</label>
            <input
              type="range" min="16" max="120" step="2"
              value={cfg.fontSize}
              onChange={e => set('fontSize', Number(e.target.value))}
              className="wm-slider"
            />
          </div>
        </>
      )}

      {/* 位置 */}
      <div className="wm-pos-grid">
        {POSITIONS.map(p => (
          <button
            key={p.value}
            className={`wm-pos-btn ${cfg.position === p.value ? 'active' : ''}`}
            onClick={() => set('position', p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* 透明度 */}
      <div className="wm-row">
        <label className="wm-label">透明度 {Math.round(cfg.opacity * 100)}%</label>
        <input
          type="range" min="0.05" max="1" step="0.05"
          value={cfg.opacity}
          onChange={e => set('opacity', Number(e.target.value))}
          className="wm-slider"
        />
      </div>

      {/* 边距 */}
      <div className="wm-row">
        <label className="wm-label">边距 {cfg.padding}px</label>
        <input
          type="range" min="0" max="80" step="4"
          value={cfg.padding}
          onChange={e => set('padding', Number(e.target.value))}
          className="wm-slider"
        />
      </div>
    </div>
  );
}

export default WatermarkPanel;
