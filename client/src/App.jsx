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
  const [viewMode, setViewMode] = useState('single'); // 'single' | 'grid' | 'director'
  const [outputStream, setOutputStream] = useState(null); // 选中作为输出的流
  const [serverInfo, setServerInfo] = useState(null); // { rtmpBase, candidates: [...] }
  const [pickedBase, setPickedBase] = useState(null); // 用户在多网卡间手动切换
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

  // 定时拉取内网推流地址：IP 变化(换网/DHCP/开关VPN)后侧边栏能自动纠正
  const refreshServerInfo = useCallback(() => {
    fetch('http://localhost:3001/api/server-info')
      .then(r => r.json())
      .then(d => { if (d?.rtmpBase) setServerInfo(d); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('http://localhost:3001/api/audio/state')
      .then(r => r.json())
      .then(d => { audioStateRef.current = d; })
      .catch(() => {});

    refreshServerInfo();
    const timer = setInterval(refreshServerInfo, 10000);
    return () => clearInterval(timer);
  }, [refreshServerInfo]);

  useEffect(() => {
    socket.on('connect', () => {
      setServerStatus('已连接');
      console.log('已连接到服务器');
      refreshServerInfo();
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
  }, [refreshServerInfo]);

  // 将 VU 表数据广播给音频控制台窗口
  useEffect(() => {
    return onVuData((data) => {
      if (socket.connected) socket.emit('audio:vuData', data);
    });
  }, []);

  const handleStreamSelect = (stream) => {
    setSelectedStream(stream);
    // 导播台模式下保持当前视图（多画面点击只改预览）
    setViewMode((m) => (m === 'director' ? m : 'single'));
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

  // 导播台：Enter / Space = CUT（预览 → 输出）
  useEffect(() => {
    if (viewMode !== 'director') return;
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCut();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, selectedStream, outputStream, streams]);

  // 进入导播台时若无预览，自动选第一路作为 PVW
  useEffect(() => {
    if (viewMode !== 'director') return;
    if (!selectedStream && streams[0]) setSelectedStream(streams[0]);
    if (!outputStream && streams[0]) handleSelectOutput(streams[0].streamKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, streams]);

  const toggleViewMode = () => {
    if (streams.length > 0) {
      setViewMode((m) => (m === 'single' ? 'grid' : m === 'grid' ? 'director' : 'single'));
    }
  };

  // 导播台 CUT：把当前预览(selected)切到主输出(output)
  const handleCut = () => {
    if (!selectedStream) return;
    if (selectedStream.streamKey === outputStream) return;
    handleSelectOutput(selectedStream.streamKey);
  };

  // 导播台快捷改分（不打开设置）
  const bumpScore = async (side, delta) => {
    try {
      const r = await fetch('http://localhost:3001/api/scoreboard');
      const cfg = await r.json();
      const key = side === 'home' ? 'homeScore' : 'awayScore';
      const next = { ...cfg, [key]: Math.max(0, (Number(cfg[key]) || 0) + delta) };
      await fetch('http://localhost:3001/api/scoreboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
    } catch (e) {
      console.error('改分失败', e);
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

  // 多网卡：默认用服务端选中的地址；用户点选后优先展示所选，刷新时若该 IP 消失则回退
  const candidates = serverInfo?.candidates || [];
  const activeBase = (() => {
    if (pickedBase && candidates.some(c => c.rtmpBase === pickedBase)) return pickedBase;
    if (pickedBase && serverInfo?.rtmpBase === pickedBase) return pickedBase;
    return serverInfo?.rtmpBase || '';
  })();

  return (
    <div className="app">
      <header className="header">
        <h1>📹 RTMP 赛事导播台</h1>
        <div className="header-controls">
          <div className="status">
            <span className={`status-indicator ${serverStatus === '已连接' ? 'online' : 'offline'}`}></span>
            <span>{serverStatus}</span>
            <span className="stream-count">活跃设备: {streams.length}</span>
          </div>
          {streams.length > 0 && (
            <>
              <button className="view-mode-btn" onClick={toggleViewMode}>
                {viewMode === 'single' ? '📺 网格视图' : viewMode === 'grid' ? '🎬 导播台' : '🎯 单屏视图'}
              </button>
              {viewMode === 'director' && (
                <button className="view-mode-btn cut-btn" onClick={handleCut}
                  title="将预览切到输出（Enter）">
                  ✂ CUT
                </button>
              )}
            </>
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
                <code>{activeBase ? `${activeBase}/<设备名>` : '获取中…'}</code>
              </div>
              <p className="hint">OBS：服务器填 {activeBase || '上述地址'}，串流密钥填设备名（如 cam1）</p>
              {candidates.length > 1 && (
                <div className="rtmp-candidates">
                  <span className="hint">本机多网卡，连不上可切换：</span>
                  <div className="rtmp-candidate-list">
                    {candidates.map(c => (
                      <button
                        key={c.address}
                        type="button"
                        className={`rtmp-candidate ${c.virtual ? 'virtual' : ''} ${activeBase === c.rtmpBase ? 'active' : ''}`}
                        onClick={() => setPickedBase(c.rtmpBase)}
                        title={c.virtual ? `${c.name}（虚拟网卡，通常不可用）` : c.name}
                      >
                        {c.address}{c.virtual ? ' ·虚拟' : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {outputStream && (
                <div className="output-info">
                  <h3>当前输出</h3>
                  <p className="output-stream">📡 {outputStream}</p>
                  <p className="hint">此画面已选为主输出</p>
                </div>
              )}
            </div>
            <HdmiOutputPanel streams={streams} />
            <RecordPanel outputStream={outputStream} videoRefsMap={videoRefsMap.current} />
          </div>
        </aside>

        <main className="video-area">
          {viewMode === 'director' && streams.length > 0 ? (
            <div className="director-layout">
              <section className="director-monitors">
                <div className="director-monitor director-pgm">
                  <div className="director-monitor-label pgm">PGM · PROGRAM</div>
                  {outputStream ? (
                    (() => {
                      const pgm = streams.find(s => s.streamKey === outputStream);
                      return pgm ? (
                        <VideoPlayer stream={pgm} compact={false} program
                          onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount} />
                      ) : (
                        <div className="director-empty">等待 {outputStream}</div>
                      );
                    })()
                  ) : (
                    <div className="director-empty">未设置输出</div>
                  )}
                </div>
                <div className="director-monitor director-pvw">
                  <div className="director-monitor-label pvw">PVW · 预览</div>
                  {selectedStream ? (
                    <VideoPlayer stream={selectedStream} compact={false}
                      onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount} />
                  ) : (
                    <div className="director-empty">从下方多画面选择预览</div>
                  )}
                </div>
              </section>
              <div className="director-toolbar">
                <button className="cut-btn cut-btn--lg" onClick={handleCut}
                  disabled={!selectedStream || selectedStream.streamKey === outputStream}>
                  ✂ CUT / TAKE
                </button>
                <div className="director-score-quick" title="快捷改分（需在设置中启用比分条）">
                  <button type="button" onClick={() => bumpScore('home', -1)}>主−</button>
                  <button type="button" onClick={() => bumpScore('home', 1)}>主+</button>
                  <button type="button" onClick={() => bumpScore('away', -1)}>客−</button>
                  <button type="button" onClick={() => bumpScore('away', 1)}>客+</button>
                </div>
                <span className="director-hint">数字键切输出 · Shift+数字切预览 · Enter CUT · 多画面单击预览 / 双击上输出</span>
              </div>
              <section className="director-multiview">
                {streams.map((stream, i) => {
                  const isPgm = stream.streamKey === outputStream;
                  const isPvw = stream.streamKey === selectedStream?.streamKey;
                  return (
                    <div key={stream.streamKey} className="director-tile-wrap">
                      <span className="director-tile-idx">{i + 1}</span>
                      {(isPgm || isPvw) && (
                        <span className={`director-tile-badge ${isPgm ? 'pgm' : 'pvw'}`}>
                          {isPgm ? 'PGM' : 'PVW'}
                        </span>
                      )}
                      <div className={`director-tile ${isPgm ? 'on-pgm' : isPvw ? 'on-pvw' : ''}`}>
                        <VideoPlayer stream={stream} compact
                          onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount}
                          onSelectPreview={handleStreamSelect}
                          onTake={(s) => { handleStreamSelect(s); handleSelectOutput(s.streamKey); }}
                        />
                      </div>
                    </div>
                  );
                })}
              </section>
            </div>
          ) : viewMode === 'grid' && streams.length > 0 ? (
            <div className={`video-grid grid-${Math.min(streams.length, 4)}`}>
              {streams.map((stream) => (
                <div key={stream.streamKey} className="grid-item">
                  <VideoPlayer stream={stream} compact={true} onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount} />
                </div>
              ))}
            </div>
          ) : selectedStream ? (
            <VideoPlayer stream={selectedStream} compact={false} onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount}
              onEnded={(key) => {
                // 顺序播放：当前本地媒体播完后自动切换到下一条（不循环的前提下）
                const idx = localStreams.findIndex(s => s.streamKey === key);
                if (idx !== -1 && idx + 1 < localStreams.length) {
                  const next = localStreams[idx + 1];
                  handleStreamSelect(next);
                }
              }}
            />
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

      {/* 导播台已有大 PGM 监看，隐藏右下角浮窗避免重复 */}
      {viewMode !== 'director' && (
        <OutputMonitor streamKey={outputStream} streams={streams} />
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default App;
