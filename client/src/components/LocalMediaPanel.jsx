import { useState } from 'react';

const API = 'http://localhost:3001';

const RATE_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

function PlaySettingsPopover({ stream, onClose, onUpdate }) {
  const [loop, setLoop] = useState(stream.loop ?? false);
  const [autoplay, setAutoplay] = useState(stream.autoplay ?? true);
  const [playbackRate, setPlaybackRate] = useState(stream.playbackRate ?? 1.0);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const keyPart = stream.streamKey.replace(/^local\//, '');
      await fetch(`${API}/api/local/${encodeURIComponent(keyPart)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loop, autoplay, playbackRate }),
      });
      onUpdate?.({ loop, autoplay, playbackRate });
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="play-settings-popover" onClick={e => e.stopPropagation()}>
      <div className="play-settings-row">
        <label>
          <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} />
          <span>循环播放</span>
        </label>
      </div>
      <div className="play-settings-row">
        <label>
          <input type="checkbox" checked={autoplay} onChange={e => setAutoplay(e.target.checked)} />
          <span>自动播放</span>
        </label>
      </div>
      <div className="play-settings-row">
        <span className="play-settings-label">播放速率</span>
        <select value={playbackRate} onChange={e => setPlaybackRate(Number(e.target.value))}>
          {RATE_OPTIONS.map(r => (
            <option key={r} value={r}>{r}x</option>
          ))}
        </select>
      </div>
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

  const handleAdd = async () => {
    const api = window.electronAPI;
    let paths = null;

    if (api?.selectLocalFiles) {
      paths = await api.selectLocalFiles();
    } else {
      paths = await new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*,audio/*';
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
    try {
      for (const item of paths) {
        const filePath = typeof item === 'string' ? item : item.filePath;
        const fileName = typeof item === 'string'
          ? item.split(/[/\\]/).pop()
          : item.fileName;
        await fetch(`${API}/api/local/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, fileName }),
        });
      }
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (streamKey) => {
    const keyPart = streamKey.replace(/^local\//, '');
    await fetch(`${API}/api/local/${encodeURIComponent(keyPart)}`, { method: 'DELETE' });
    onRemove?.(streamKey);
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
      {localStreams.length === 0 ? (
        <p className="local-empty">点击"+ 添加"导入音视频文件</p>
      ) : (
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
                    <span className="stream-hotkey" title={`按 ${hotkey} 切换输出，Shift+${hotkey} 仅预览`}>{hotkey}</span>
                  )}
                  <span className="local-icon">{s.fileType === 'audio' ? '🎵' : '🎬'}</span>
                  <span className="local-name" title={s.fileName}>{s.fileName}</span>
                  <div className="local-item-badges">
                    {s.loop && <span className="media-badge" title="循环播放">🔁</span>}
                    {s.playbackRate && s.playbackRate !== 1.0 && (
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
