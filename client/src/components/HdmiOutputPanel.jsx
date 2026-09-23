import { useEffect, useMemo, useState } from 'react';

/**
 * 多路 HDMI 输出面板
 * - 每块显示器可独立开/关
 * - 每路可跟随 PROGRAM，或固定某一路信号源（体育转播多屏分发）
 */
function HdmiOutputPanel({ streams = [] }) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  const [displays, setDisplays] = useState([]);
  const [outputs, setOutputs] = useState([]); // [{displayId, open, mode, source}]
  const [sources, setSources] = useState({}); // displayId -> '' | streamKey
  const [modes, setModes] = useState({});     // displayId -> 'fullscreen' | 'window'

  const sourceOptions = useMemo(() => {
    const list = streams.filter(s => s.streamKey).map(s => ({
      value: s.streamKey,
      label: s.streamKey,
    }));
    return [{ value: '', label: '跟随 PROGRAM' }, ...list];
  }, [streams]);

  const refresh = async () => {
    if (!api) return;
    try {
      const list = await api.listDisplays();
      setDisplays(list);
      const status = await api.getOutputStatus();
      setOutputs(status.outputs || (status.open ? [{ displayId: list.find(d => !d.primary)?.id ?? list[0]?.id, open: true, mode: status.mode, source: null }] : []));
    } catch (e) {
      console.error('刷新显示器失败', e);
    }
  };

  useEffect(() => {
    if (!api) return;
    refresh();
    const offChanged = api.onDisplaysChanged?.(refresh);
    const offOutputs = api.onOutputsChanged?.((outs) => setOutputs(outs || []));
    const offClosed = api.onOutputClosed?.(() => { refresh(); });
    return () => {
      offChanged?.();
      offOutputs?.();
      offClosed?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!api) {
    return (
      <div className="hdmi-panel">
        <h3>HDMI 多路输出</h3>
        <p className="hint">请在桌面客户端中使用此功能</p>
      </div>
    );
  }

  const outputFor = (displayId) => outputs.find(o => o.displayId === displayId);

  const handleOpen = async (displayId) => {
    const mode = modes[displayId] || 'fullscreen';
    const source = sources[displayId] || null;
    await api.openOutput(displayId, mode, { source });
    await refresh();
  };

  const handleClose = async (displayId) => {
    await api.closeOutput(displayId);
    await refresh();
  };

  const handleOpenAllSecondary = async () => {
    const secondary = displays.filter(d => !d.primary);
    const targets = secondary.length ? secondary : displays;
    const routes = targets.map(d => ({
      displayId: d.id,
      mode: modes[d.id] || 'fullscreen',
      source: sources[d.id] || null,
    }));
    await api.openMultiOutputs(routes);
    await refresh();
  };

  const handleCloseAll = async () => {
    await api.closeOutput();
    await refresh();
  };

  const openCount = outputs.filter(o => o.open).length;

  return (
    <div className="hdmi-panel">
      <h3>HDMI 多路输出</h3>
      {displays.length === 0 ? (
        <p className="hint">未检测到显示器</p>
      ) : (
        <>
          <div className="hdmi-multi-actions">
            <button className="hdmi-btn primary" onClick={handleOpenAllSecondary}>
              一键分发副屏 ({Math.max(displays.filter(d => !d.primary).length, displays.length)})
            </button>
            {openCount > 0 && (
              <button className="hdmi-btn danger" onClick={handleCloseAll}>
                全部关闭 ({openCount})
              </button>
            )}
          </div>

          <div className="hdmi-route-list">
            {displays.map((d) => {
              const out = outputFor(d.id);
              const open = !!out?.open;
              return (
                <div key={d.id} className={`hdmi-route ${open ? 'open' : ''}`}>
                  <div className="hdmi-route-head">
                    <span className="hdmi-route-name">
                      {d.label}
                      {d.primary && <em> 主屏</em>}
                    </span>
                    <span className={`hdmi-route-status ${open ? 'on' : ''}`}>
                      {open ? (out.source ? `固定 ${out.source}` : 'PROGRAM') : '关闭'}
                    </span>
                  </div>
                  <div className="hdmi-route-controls">
                    <select
                      className="hdmi-select hdmi-route-source"
                      value={sources[d.id] ?? (out?.source || '')}
                      onChange={(e) => setSources(s => ({ ...s, [d.id]: e.target.value }))}
                      disabled={open}
                      title={open ? '先关闭该路输出再改信号源' : '信号源'}
                    >
                      {sourceOptions.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <select
                      className="hdmi-select hdmi-route-mode"
                      value={modes[d.id] ?? 'fullscreen'}
                      onChange={(e) => setModes(m => ({ ...m, [d.id]: e.target.value }))}
                      disabled={open}
                    >
                      <option value="fullscreen">全屏</option>
                      <option value="window">窗口</option>
                    </select>
                    {open ? (
                      <button className="hdmi-btn danger hdmi-route-btn" onClick={() => handleClose(d.id)}>
                        关闭
                      </button>
                    ) : (
                      <button className="hdmi-btn primary hdmi-route-btn" onClick={() => handleOpen(d.id)}>
                        开启
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="hint">
            {openCount > 0
              ? `已开启 ${openCount} 路输出。每路可跟随 PROGRAM，或固定独立信号源（如回放机、机位特写）。`
              : '可同时向多块显示器分发画面：跟随主输出或各自固定信号源。'}
          </p>
        </>
      )}
    </div>
  );
}

export default HdmiOutputPanel;
