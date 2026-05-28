import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import VideoPlayer from './components/VideoPlayer';
import StreamList from './components/StreamList';
import HdmiOutputPanel from './components/HdmiOutputPanel';
import './App.css';

const socket = io('http://localhost:3001');

function App() {
  const [streams, setStreams] = useState([]);
  const [selectedStream, setSelectedStream] = useState(null);
  const [serverStatus, setServerStatus] = useState('连接中...');
  const [viewMode, setViewMode] = useState('single'); // 'single' or 'grid'
  const [outputStream, setOutputStream] = useState(null); // 选中作为输出的流

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

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('streamUpdate');
      socket.off('outputSelected');
    };
  }, []);

  const handleStreamSelect = (stream) => {
    setSelectedStream(stream);
    setViewMode('single');
  };

  const toggleViewMode = () => {
    if (streams.length > 0) {
      setViewMode(viewMode === 'single' ? 'grid' : 'single');
    }
  };

  const handleSelectOutput = async (streamKey) => {
    try {
      const response = await fetch('http://localhost:3001/api/output/select', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ streamKey }),
      });
      const data = await response.json();
      if (data.success) {
        setOutputStream(streamKey);
        alert(data.message);
      }
    } catch (error) {
      console.error('选择输出失败:', error);
      alert('选择输出失败');
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
        </div>
      </header>

      <div className="main-content">
        <aside className="sidebar">
          <h2>摄影设备列表</h2>
          <StreamList 
            streams={streams} 
            selectedStream={selectedStream}
            outputStream={outputStream}
            onStreamSelect={handleStreamSelect}
            onSelectOutput={handleSelectOutput}
          />
          
          <div className="connection-info">
            <h3>推流地址</h3>
            <div className="rtmp-url">
              <code>rtmp://localhost:1935/live/[设备名称]</code>
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
        </aside>

        <main className="video-area">
          {viewMode === 'grid' && streams.length > 0 ? (
            <div className={`video-grid grid-${Math.min(streams.length, 4)}`}>
              {streams.map((stream) => (
                <div key={stream.streamKey} className="grid-item">
                  <VideoPlayer stream={stream} compact={true} />
                </div>
              ))}
            </div>
          ) : selectedStream ? (
            <VideoPlayer stream={selectedStream} compact={false} />
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
    </div>
  );
}

export default App;
