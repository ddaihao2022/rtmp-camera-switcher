import { useState } from 'react';

const API = 'http://localhost:3001';

const RATE_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

function PlaySettingsPopover({ stream, onClose, onUpdate }) {
  const isImage = stream.fileType === 'image';
  const [loop, setLoop] = useState(stream.loop ?? false);
  const [autoplay, setAutoplay] = useState(stream.autoplay ?? true);
  const [playbackRate, setPlaybackRate] = useState(stream.playbackRate ?? 1.0);
  const [duration, setDuration] = useState(stream.duration ?? (isImage ? 5 : 0));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const keyPart = stream.streamKey.replace(/^local\//, '');
      const body = isImage
        ? { loop, autoplay, duration: Number(duration) || 0 }
        : { loop, autoplay, playbackRate };
      await fetch(`${API}/api/local/${encodeURIComponent(keyPart)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      onUpdate?.(body);
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="play-settings-popover" role="dialog" aria-label="播放设置" onClick={e => e.stopPropagation()}>
      <div className="play-settings-row">
        <label>
          <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />
          <span>{isImage ? '持续显示（不自动切换）' : '循环播放'}</span>
        </label>
      </div>
      <div className="play-settings-row">
        <label>
          <input type="checkbox" checked={autoplay} onChange={e => setAutoplay(e.target.checked)} />
          <span>自动播放</span>
        </label>
      </div>
      {isImage ? (
        <div className="play-settings-row">
          <span className="play-settings-label">停留秒数</span>
          <select value={duration} onChange={e => setDuration(Number(e.target.value))} disabled={loop}>
            <option value={0}>常驻</option>
            {[3, 5, 8, 10, 15, 20, 30].map(d => (
              <option key={d} value={d}>{d}s</option>
            ))}
          </select>
        </div>
      ) : (
        <div className="play-settings-row">
          <span className="play-settings-label">播放速率</span>
          <select value={playbackRate} onChange={e => setPlaybackRate(Number(e.target.value))}>
            {RATE_OPTIONS.map(r => (
              <option key={r} value={r}>{r}x</option>
            ))}
          </select>
        </div>
      )}
      <div className="play-settings-actions">
        <button className="play-settings-save" onClick={handleSave} disabled={saving}>
          {saving ? '…' : '保存'}
        </button>
        <button className="play-settings-cancel" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

export default function LocalMediaPanel({
  localStreams, onRemove, onSelect, selectedStream, outputStream, onSelectOutput, indexOffset = 0
}) {
  const [adding, setAdding] = useState(false);
  const [openSettings, setOpenSettings] = useState(null); // streamKey of open popover
  const [err, setErr] = useState('');

  const handleAdd = async () => {
    const api = window.electronAPI;
    let paths = null;

    if (api?.selectLocalFiles) {
      paths = await api.selectLocalFiles();
    } else {
      paths = await new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*,audio/*,image/*';
        input.multiple = true;
        input.onchange = () => {
          const files = Array.from(input.files || []).map(f => ({
            filePath: URL.createObjectURL(f),
            fileName: f.name,
            isBlob: true,
          }));
          resolve(files.length ? files : null);
        };
        input.click();
      });
    }

    if (!paths || paths.length === 0) return;
    setAdding(true);
    setErr('');
    try {
      const failed = [];
      for (const item of paths) {
        const filePath = typeof item === 'string' ? item : item.filePath;
        const fileName = typeof item === 'string'
          ? item.split(/[/\\]/).pop()
          : item.fileName;
        const r = await fetch(`${API}/api/local/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, fileName }),
        });
        if (!r.ok) failed.push(fileName || filePath);
      }
      if (failed.length) {
        setErr(`有 ${failed.length} 个文件没加上：${failed.slice(0, 2).join('、')}${failed.length > 2 ? '…' : ''}`);
      }
    } catch (e) {
      setErr('添加失败：' + (e?.message || '网络错误'));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (streamKey) => {
    const stream = localStreams.find(s => s.streamKey === streamKey);
    const name = stream?.fileName || streamKey;
    if (!window.confirm(`从本地媒体列表移除「${name}」？\n不会删除磁盘上的原文件，可重新添加。`)) return;

    setErr('');
    try {
      const keyPart = streamKey.replace(/^local\//, '');
      const r = await fetch(`${API}/api/local/${encodeURIComponent(keyPart)}`, { method: 'DELETE' });
      // 404 = 服务端已经没有这条了，按“已移除”处理，避免列表卡住删不掉
      if (!r.ok && r.status !== 404) {
        setErr(`移除「${name}」失败（HTTP ${r.status}）`);
        return;
      }
      onRemove?.(streamKey);
    } catch (e) {
      setErr(`移除「${name}」失败：` + (e?.message || '网络错误'));
    }
  };

  const toggleSettings = (e, streamKey) => {
    e.stopPropagation();
    setOpenSettings(prev => prev === streamKey ? null : streamKey);
  };

  return (
    <div className="local-panel">
      <div className="local-panel-head">
        <span>📁 本地媒体</span>
        <button className="local-add-btn" onClick={handleAdd} disabled={adding}>
          {adding ? '…' : '+ 添加'}
        </button>
      </div>
      {err && (
        <p className="local-error" style={{ color: '#fca5a5', fontSize: '0.75rem', margin: '0.2rem 0' }}>{err}</p>
      )}
      {localStreams.length === 0 ? null : (
        <ul className="local-list">
          {localStreams.map((s, i) => {
            const hotkey = indexOffset + i + 1;
            const isSettingsOpen = openSettings === s.streamKey;
            return (
              <li key={s.streamKey}
                className={`local-item ${selectedStream?.streamKey === s.streamKey ? 'local-item--active' : ''} ${outputStream === s.streamKey ? 'local-item--output' : ''}`}
                onClick={() => { onSelect?.(s); setOpenSettings(null); }}
              >
                <div className="local-item-row">
                  {hotkey <= 9 && (
                    <span className="stream-hotkey" title={`导播台：按 ${hotkey} 设为预览(PVW)，Shift+${hotkey} 直接切输出(PGM)`}>{hotkey}</span>
                  )}
                  <span className="local-icon">{s.fileType === 'audio' ? '🎵' : s.fileType === 'image' ? '🖼' : '🎬'}</span>
                  <span className="local-name" title={s.fileName}>{s.fileName}</span>
                  <div className="local-item-badges">
                    {s.loop && s.fileType !== 'image' && <span className="media-badge" title="循环播放">🔁</span>}
                    {s.fileType === 'image' && s.duration > 0 && (
                      <span className="media-badge" title="图片停留时长">{s.duration}s</span>
                    )}
                    {s.playbackRate && s.playbackRate !== 1.0 && s.fileType !== 'image' && (
                      <span className="media-badge" title="播放速率">{s.playbackRate}x</span>
                    )}
                  </div>
                  <button
                    className={`local-settings-btn ${isSettingsOpen ? 'active' : ''}`}
                    onClick={e => toggleSettings(e, s.streamKey)}
                    title="播放设置"
                  >⚙</button>
                  <button
                    className={`select-output-btn ${outputStream === s.streamKey ? 'output-active' : ''}`}
                    onClick={e => { e.stopPropagation(); onSelectOutput?.(s.streamKey); }}
                    title="选为输出"
                  >{outputStream === s.streamKey ? '✓' : '📡'}</button>
                  <button className="local-del" onClick={e => { e.stopPropagation(); handleRemove(s.streamKey); }} title="移除">✕</button>
                </div>
                {isSettingsOpen && (
                  <PlaySettingsPopover
                    stream={s}
                    onClose={() => setOpenSettings(null)}
                    onUpdate={() => {}}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
