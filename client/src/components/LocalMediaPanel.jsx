import { useState } from 'react';

const API = 'http://localhost:3001';

export default function LocalMediaPanel({ localStreams, onRemove, onSelect, selectedStream, outputStream, onSelectOutput, indexOffset = 0 }) {
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    const api = window.electronAPI;
    let paths = null;

    if (api?.selectLocalFiles) {
      // Electron：系统文件对话框
      paths = await api.selectLocalFiles();
    } else {
      // 浏览器：file input fallback
      paths = await new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*,audio/*';
        input.multiple = true;
        input.onchange = () => {
          // 浏览器无法访问绝对路径，用 blob URL 代替
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
            return (
              <li key={s.streamKey}
                className={`local-item ${selectedStream?.streamKey === s.streamKey ? 'local-item--active' : ''} ${outputStream === s.streamKey ? 'local-item--output' : ''}`}
                onClick={() => onSelect?.(s)}
              >
                {hotkey <= 9 && (
                  <span className="stream-hotkey" title={`按 ${hotkey} 切换输出，Shift+${hotkey} 仅预览`}>{hotkey}</span>
                )}
                <span className="local-icon">{s.fileType === 'audio' ? '🎵' : '🎬'}</span>
                <span className="local-name" title={s.fileName}>{s.fileName}</span>
                <button
                  className={`select-output-btn ${outputStream === s.streamKey ? 'output-active' : ''}`}
                  onClick={e => { e.stopPropagation(); onSelectOutput?.(s.streamKey); }}
                  title="选为输出"
                >{outputStream === s.streamKey ? '✓' : '📡'}</button>
                <button className="local-del" onClick={e => { e.stopPropagation(); handleRemove(s.streamKey); }} title="移除">✕</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
