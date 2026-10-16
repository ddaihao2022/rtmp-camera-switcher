import { useEffect } from 'react';
import { SettingsBody } from './components/SettingsModal';
import './App.css';
import './SettingsView.css';

/**
 * 独立设置窗口（?view=settings）
 * 与主窗口弹窗共用 SettingsBody：所有分组都以 Socket.io / HTTP 的服务端状态为准，
 * 因此两个窗口同时打开也不会互相覆盖，改任意一边都会广播到另一边。
 */
function SettingsView() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;

  useEffect(() => {
    document.body.classList.add('settings-mode');
    document.title = '设置 · 田径赛事导播台';
    return () => document.body.classList.remove('settings-mode');
  }, []);

  const close = () => {
    if (api?.closeSettingsWindow) {
      api.closeSettingsWindow();
      return;
    }
    if (window.opener) window.close();
  };

  // 收回主界面：关掉本窗口，主窗口重新打开设置弹窗
  const restore = () => {
    if (api?.restoreSettingsWindow) api.restoreSettingsWindow();
  };

  return (
    <div className="settings-window">
      <div className="settings-backdrop">
        <div className="settings-modal" role="dialog" aria-label="设置">
          <div className="settings-modal-header">
            <span>⚙️ 设置</span>
            <div className="settings-header-actions">
              <span className="settings-window-hint">独立窗口 · 可拖到另一块屏幕</span>
              {api?.restoreSettingsWindow && (
                <button className="settings-popout" onClick={restore}
                  title="关闭本窗口，并在主界面重新以弹窗打开设置">⤵ 收回主界面</button>
              )}
              <button className="settings-close" onClick={close} aria-label="关闭">✕</button>
            </div>
          </div>
          <div className="settings-modal-body settings-window-body">
            <SettingsBody />
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsView;
