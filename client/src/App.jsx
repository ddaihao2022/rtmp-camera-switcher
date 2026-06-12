import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import VideoPlayer from './components/VideoPlayer';
import StreamList from './components/StreamList';
import HdmiOutputPanel from './components/HdmiOutputPanel';
import OutputMonitor from './components/OutputMonitor';
import SettingsModal from './components/SettingsModal';
import LocalMediaPanel from './components/LocalMediaPanel';
import RecordPanel from './components/RecordPanel';
import { connectStream, disconnectStream, setVolume, setMute, onVuData } from './audio.js';
import './App.css';

const socket = io('http://localhost:3001');

function App() {
  const [streams, setStreams] = useState([]);
  const [selectedStream, setSelectedStream] = useState(null);
  const [serverStatus, setServerStatus] = useState('连接中...');
  const [viewMode, setViewMode] = useState('single'); // 'single' or 'grid'
  const [outputStream, setOutputStream] = useState(null); // 选中作为输出的流
  const [rtmpBase, setRtmpBase] = useState('rtmp://localhost:1935/live');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const videoRefsMap = useRef(new Map());
  const audioStateRef = useRef({});

  const handleVideoReady = useCallback((streamKey, el) => {
    videoRefsMap.current.set(streamKey, el);
    connectStream(streamKey, el);
    const st = audioStateRef.current[streamKey];
    if (st) {
      if (st.muted) setMute(streamKey, true);
      else if (st.volume != null) setVolume(streamKey, st.volume);
    }
  }, []);

  const handleVideoUnmount = useCallback((streamKey) => {
    videoRefsMap.current.delete(streamKey);
    disconnectStream(streamKey);
  }, []);

  const liveStreams = streams.filter(s => s.type !== 'local');
  const localStreams = streams.filter(s => s.type === 'local');

  const handleOpenAudio = () => {
    if (window.electronAPI?.openAudioWindow) {
      window.electronAPI.openAudioWindow();
    } else {
      window.open('http://localhost:5173/?view=audio', '_blank', 'width=720,height=480');
    }
  };

  useEffect(() => {
    fetch('http://localhost:3001/api/audio/state')
      .then(r => r.json())
      .then(d => { audioStateRef.current = d; })
      .catch(() => {});

    // 拉取服务器内网信息,得到真实 LAN IP 推流地址
    fetch('http://localhost:3001/api/server-info')
      .then(r => r.json())
      .then(d => d.rtmpBase && setRtmpBase(d.rtmpBase))
      .catch(() => {});
  }, []);

  useEffect(() => {
    socket.on('connect', () => {
      setServerStatus('已连接');
      console.log('已连接到服务器');
    });

    socket.on('disconnect', () => {
      setServerStatus('已断开');
      console.log('与服务器断开连接');
    });

    socket.on('streamUpdate', (updatedStreams) => {
      setStreams(updatedStreams);
      // 当推流路径变化(server 升级、设备重推等)时,同步 selectedStream 到新对象;
      // 用 streamKey 匹配;若已下线则清空选中状态
      setSelectedStream(prev => {
        if (!prev) return prev;
        const fresh = updatedStreams.find(s => s.streamKey === prev.streamKey);
        return fresh || null;
      });
      console.log('流更新:', updatedStreams);
    });

    socket.on('outputSelected', (data) => {
      setOutputStream(data.streamKey);
      console.log('输出已选择:', data.streamKey);
    });

    socket.on('audio:stateUpdate', (state) => {
      audioStateRef.current = state;
      for (const [key, st] of Object.entries(state)) {
        if (!videoRefsMap.current.has(key)) continue;
        if (st.muted) setMute(key, true);
        else {
          setMute(key, false);
          if (st.volume != null) setVolume(key, st.volume);
        }
      }
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('streamUpdate');
      socket.off('outputSelected');
      socket.off('audio:stateUpdate');
    };
  }, []);

  // 将 VU 表数据广播给音频控制台窗口
  useEffect(() => {
    return onVuData((data) => {
      if (socket.connected) socket.emit('audio:vuData', data);
    });
  }, []);

  const handleStreamSelect = (stream) => {
    setSelectedStream(stream);
    setViewMode('single');
  };

  // 数字快捷键：1~9 切换预览，Shift+1~9 切换输出
  useEffect(() => {
    const onKeyDown = (e) => {
      // 输入框/textarea 获焦时不拦截
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const num = parseInt(e.key, 10);
      if (isNaN(num) || num < 1 || num > 9) return;

      const allStreams = streams; // liveStreams + localStreams 合并顺序
      const target = allStreams[num - 1];
      if (!target) return;

      e.preventDefault();
      if (e.shiftKey) {
        // Shift+数字 → 仅切换预览
        handleStreamSelect(target);
      } else {
        // 数字 → 直接切换输出（同时切换预览）
        handleSelectOutput(target.streamKey);
        handleStreamSelect(target);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams]);

  const toggleViewMode = () => {
    if (streams.length > 0) {
      setViewMode(viewMode === 'single' ? 'grid' : 'single');
    }
  };

  const handleSelectOutput = async (streamKey) => {
    try {
      const response = await fetch('http://localhost:3001/api/output/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamKey }),
      });
      const data = await response.json();
      if (data.success) {
        setOutputStream(streamKey);
      }
    } catch (error) {
      console.error('选择输出失败:', error);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>📹 RTMP多摄影设备管理系统</h1>
        <div className="header-controls">
          <div className="status">
            <span className={`status-indicator ${serverStatus === '已连接' ? 'online' : 'offline'}`}></span>
            <span>{serverStatus}</span>
            <span className="stream-count">活跃设备: {streams.length}</span>
          </div>
          {streams.length > 0 && (
            <button className="view-mode-btn" onClick={toggleViewMode}>
              {viewMode === 'single' ? '📺 网格视图' : '🎯 单屏视图'}
            </button>
          )}
          <button className="view-mode-btn audio-open-btn" onClick={handleOpenAudio}>
            🎚 音频混音台
          </button>
          <button className="view-mode-btn settings-btn" onClick={() => setSettingsOpen(true)}>
            ⚙️ 设置
          </button>
        </div>
      </header>

      <div className="main-content">
        <aside className="sidebar">
          <h2>摄影设备列表</h2>
          <div className="sidebar-scroll">
            <StreamList 
              streams={liveStreams} 
              selectedStream={selectedStream}
              outputStream={outputStream}
              onStreamSelect={handleStreamSelect}
              onSelectOutput={handleSelectOutput}
              indexOffset={0}
            />
            <LocalMediaPanel
              localStreams={localStreams}
              onRemove={(key) => setStreams(s => s.filter(x => x.streamKey !== key))}
              onSelect={handleStreamSelect}
              selectedStream={selectedStream}
              outputStream={outputStream}
              onSelectOutput={handleSelectOutput}
              indexOffset={liveStreams.length}
            />
          </div>

          <div className="sidebar-bottom">
            <div className="connection-info">
              <h3>推流地址</h3>
              <div className="rtmp-url">
                <code>{rtmpBase}/[设备名称]</code>
              </div>
              <p className="hint">使用OBS或摄影设备推流到上述地址</p>
              {outputStream && (
                <div className="output-info">
                  <h3>当前输出</h3>
                  <p className="output-stream">📡 {outputStream}</p>
                  <p className="hint">此画面已选为主输出</p>
                </div>
              )}
            </div>
            <HdmiOutputPanel />
            <RecordPanel outputStream={outputStream} videoRefsMap={videoRefsMap.current} />
          </div>
        </aside>

        <main className="video-area">
          {viewMode === 'grid' && streams.length > 0 ? (
            <div className={`video-grid grid-${Math.min(streams.length, 4)}`}>
              {streams.map((stream) => (
                <div key={stream.streamKey} className="grid-item">
                  <VideoPlayer stream={stream} compact={true} onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount} />
                </div>
              ))}
            </div>
          ) : selectedStream ? (
            <VideoPlayer stream={selectedStream} compact={false} onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount} />
          ) : (
            <div className="no-stream">
              <div className="placeholder">
                <h2>请选择一个摄影设备</h2>
                <p>从左侧列表中选择要观看的设备</p>
                {streams.length > 1 && (
                  <button className="grid-view-hint" onClick={toggleViewMode}>
                    或点击切换到网格视图同时观看所有设备
                  </button>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      <OutputMonitor streamKey={outputStream} streams={streams} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default App;
