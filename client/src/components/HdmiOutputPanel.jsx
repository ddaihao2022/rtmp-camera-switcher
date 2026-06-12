import { useEffect, useState } from 'react';

function HdmiOutputPanel() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  const [displays, setDisplays] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [outputOpen, setOutputOpen] = useState(false);

  const refresh = async () => {
    if (!api) return;
    const list = await api.listDisplays();
    setDisplays(list);
    const status = await api.getOutputStatus();
    setOutputOpen(status.open);
    if (selectedId == null) {
      const target = list.find(d => !d.primary) || list[0];
      if (target) setSelectedId(target.id);
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

  if (!api) {
    return (
      <div className="hdmi-panel">
        <h3>HDMI 输出</h3>
        <p className="hint">请在桌面客户端中使用此功能</p>
      </div>
    );
  }

  const handleOpen = async () => { await api.openOutput(selectedId); setOutputOpen(true); };
  const handleClose = async () => { await api.closeOutput(); setOutputOpen(false); };

  return (
    <div className="hdmi-panel">
      <h3>HDMI 输出</h3>
      {displays.length === 0 ? (
        <p className="hint">未检测到显示器</p>
      ) : (
        <>
          <select
            className="hdmi-select"
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(Number(e.target.value))}
          >
            {displays.map(d => (
              <option key={d.id} value={d.id}>
                {d.label} {d.primary ? '(主)' : ''} {d.bounds.width}×{d.bounds.height}
              </option>
            ))}
          </select>
          <div className="hdmi-actions">
            {!outputOpen ? (
              <button className="hdmi-btn primary" onClick={handleOpen}>▶ 开启输出</button>
            ) : (
              <button className="hdmi-btn danger" onClick={handleClose}>■ 关闭输出</button>
            )}
          </div>
          <p className="hint">
            {outputOpen ? '输出窗口已在选中显示器上全屏运行' : '将在选中显示器上全屏播放当前主输出'}
          </p>
        </>
      )}
    </div>
  );
}

export default HdmiOutputPanel;
