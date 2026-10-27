import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import VideoPlayer from './components/VideoPlayer';
import StreamList from './components/StreamList';
import HdmiOutputPanel from './components/HdmiOutputPanel';
import OutputMonitor from './components/OutputMonitor';
import SettingsModal from './components/SettingsModal';
import LocalMediaPanel from './components/LocalMediaPanel';
import RecordPanel from './components/RecordPanel';
import RecordSource from './components/RecordSource';
import TrackPanel from './components/TrackPanel';
import TimingPanel from './components/TimingPanel';
import SidebarSection from './components/SidebarSection';
import ColorPanel from './components/ColorPanel';
import { connectStream, disconnectStream, setVolume, setMute, onVuData } from './audio.js';
import { GRADE_KEYS, normalizeGrade, resolveGrade } from './utils/color';
import './App.css';
import './components/ScoreboardOverlay.css';

const socket = io('http://localhost:3001');

// 快捷键保护：输入框、弹窗里的任何控件都不应该被全局快捷键穿透
function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function isInsideDialog(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('[role="dialog"]'));
}

function isButtonLike(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'BUTTON' || tag === 'A' || el.getAttribute?.('role') === 'button';
}

function App() {
  const [streams, setStreams] = useState([]);
  const [selectedStream, setSelectedStream] = useState(null);
  const [serverStatus, setServerStatus] = useState('连接中...');
  const [viewMode, setViewMode] = useState('single'); // 'single' | 'grid' | 'director'
  const [outputStream, setOutputStream] = useState(null); // 选中作为输出的流
  const [serverInfo, setServerInfo] = useState(null); // { rtmpBase, candidates: [...] }
  const [pickedBase, setPickedBase] = useState(null); // 用户在多网卡间手动切换
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDetached, setSettingsDetached] = useState(false);
  const [scoreboard, setScoreboard] = useState(null);
  const [toast, setToast] = useState(null); // { text, tone }
  const toastTimerRef = useRef(null);
  // 改分：本地先加，再只 POST 一个字段；ref 保证连点不丢增量
  const scoreRef = useRef({ home: 0, away: 0 });
  const scoreQueueRef = useRef(Promise.resolve());
  const scoreSeqRef = useRef(0);
  const scoreInflightRef = useRef(0);
  const [colorGrade, setColorGrade] = useState(null); // 调色：全局 + 机位覆盖
  const [transition, setTransition] = useState({
    type: 'cut',
    duration: 500,
    direction: 'left',
  });
  const [pgmFx, setPgmFx] = useState(null);
  const videoRefsMap = useRef(new Map());
  const recordRefsMap = useRef(new Map());
  const audioStateRef = useRef({});
  const settingsPopupRef = useRef(null); // 浏览器（非 Electron）下弹出的设置窗口

  const showToast = useCallback((text, tone = 'error') => {
    setToast({ text, tone, id: Date.now() });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // 服务端比分变化时同步本地基数；本地改分请求在飞时不覆盖，避免连点回跳
  useEffect(() => {
    if (!scoreboard || scoreInflightRef.current > 0) return;
    scoreRef.current.home = Number(scoreboard.homeScore) || 0;
    scoreRef.current.away = Number(scoreboard.awayScore) || 0;
  }, [scoreboard?.homeScore, scoreboard?.awayScore]);

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

  // 录制专用隐藏源：与预览/网格互不影响，切视图也不会断录制画面
  const handleRecordVideoReady = useCallback((streamKey, el) => {
    recordRefsMap.current.set(streamKey, el);
  }, []);
  const handleRecordVideoUnmount = useCallback((streamKey) => {
    recordRefsMap.current.delete(streamKey);
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

  // 设置：已拉出为独立窗口时，点顶栏按钮聚焦那个窗口，不再叠一层弹窗
  const handleOpenSettings = () => {
    const api = window.electronAPI;
    if (settingsDetached && api?.openSettingsWindow) {
      api.openSettingsWindow();
      return;
    }
    setSettingsOpen(true);
  };

  // 把设置拉出为独立窗口（可拖到第二块屏幕，主窗口继续监看画面）
  const handleDetachSettings = () => {
    setSettingsOpen(false);
    const api = window.electronAPI;
    if (api?.openSettingsWindow) {
      api.openSettingsWindow();
      setSettingsDetached(true);
      return;
    }
    const { origin, pathname } = window.location;
    settingsPopupRef.current = window.open(`${origin}${pathname}?view=settings`, '_blank',
      'width=780,height=920,menubar=no,toolbar=no');
    setSettingsDetached(true);
  };

  // 浏览器（非 Electron）下没有主进程状态可查，轮询弹窗是否已关闭
  useEffect(() => {
    if (!settingsDetached || window.electronAPI?.getSettingsWindowStatus) return undefined;
    const timer = setInterval(() => {
      if (!settingsPopupRef.current || settingsPopupRef.current.closed) {
        setSettingsDetached(false);
        clearInterval(timer);
      }
    }, 800);
    return () => clearInterval(timer);
  }, [settingsDetached]);

  // 独立设置窗口开/关状态同步
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getSettingsWindowStatus) return undefined;
    api.getSettingsWindowStatus()
      .then(s => setSettingsDetached(!!s?.open))
      .catch(() => {});
    const offChanged = api.onSettingsWindowChanged?.(d => setSettingsDetached(!!d?.open));
    // 独立窗口点「收回主界面」→ 这里把弹窗重新打开
    const offRestore = api.onSettingsRestore?.(() => setSettingsOpen(true));
    return () => { offChanged?.(); offRestore?.(); };
  }, []);

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
    fetch('http://localhost:3001/api/transition')
      .then(r => r.json())
      .then(d => { if (d?.type) setTransition(d); })
      .catch(() => {});
    fetch('http://localhost:3001/api/color')
      .then(r => r.json())
      .then(d => setColorGrade(normalizeGrade(d)))
      .catch(() => {});
    // 成绩条：录制导出「有成绩条」那份要用它烧录叠加层
    fetch('http://localhost:3001/api/scoreboard')
      .then(r => r.json())
      .then(setScoreboard)
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

    socket.on('scoreboard:update', (d) => {
      // 本地改分请求在飞时先不用旧快照覆盖，避免比分闪回
      if (scoreInflightRef.current > 0) return;
      setScoreboard(d);
    });
    socket.on('transition:update', setTransition);
    // 调色参数变更（任意窗口修改后全网同步）
    socket.on('color:update', (d) => setColorGrade(normalizeGrade(d)));
    // 导播台 PGM 转场闪示
    socket.on('outputTransition', (payload) => {
      if (!payload || payload.type === 'cut') return;
      const id = payload.at || Date.now();
      setPgmFx({ ...payload, id });
      setTimeout(() => setPgmFx(null), (payload.duration || 500) + 100);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('streamUpdate');
      socket.off('outputSelected');
      socket.off('audio:stateUpdate');
      socket.off('scoreboard:update');
      socket.off('transition:update');
      socket.off('outputTransition');
      socket.off('color:update');
    };
  }, [refreshServerInfo]);

  // 将 VU 表数据广播给音频控制台窗口
  useEffect(() => {
    return onVuData((data) => {
      if (socket.connected) socket.emit('audio:vuData', data);
    });
  }, []);

  // 把预览(PVW)选择同步给服务端：输出/HDMI 窗口据此提前预热下一路，
  // TAKE 时只切显隐，不用等关键帧（否则会黑屏约 1 秒）。
  useEffect(() => {
    const send = () => socket.emit('preview:select', { streamKey: selectedStream?.streamKey || null });
    if (socket.connected) send();
    socket.on('connect', send);
    return () => socket.off('connect', send);
  }, [selectedStream?.streamKey]);

  const handleStreamSelect = (stream) => {
    setSelectedStream(stream);
    // 导播台模式下保持当前视图（多画面点击只改预览）
    setViewMode((m) => (m === 'director' ? m : 'single'));
  };

  // 数字快捷键（标准导播台语义）：
  //   导播台模式：1~9 = 把该路切到预览(PVW)，主输出(PGM)不动；Shift+1~9 = 直接切主输出
  //   其它视图：数字键沿用旧习惯（置预览 + 切主输出），避免单屏/网格操作员误操作
  useEffect(() => {
    const onKeyDown = (e) => {
      // 设置弹窗打开、焦点在输入框/弹窗里时，不拦截任何快捷键
      if (settingsOpen) return;
      const el = document.activeElement;
      if (isEditableTarget(el) || isInsideDialog(el)) return;
      if (e.isComposing || e.keyCode === 229) return;

      // 用物理键位 e.code：标准键盘 Shift+1 的 e.key 是 "!"，用 e.key 会直接失效
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
      if (!m) return;
      const num = Number(m[1]);

      const allStreams = streams; // liveStreams + localStreams 合并顺序
      const target = allStreams[num - 1];
      if (!target) return;

      e.preventDefault();
      if (e.shiftKey) {
        // Shift+数字 → 直接切换主输出（走当前转场），同时置为预览
        handleSelectOutput(target.streamKey);
        handleStreamSelect(target);
        return;
      }

      // 数字 → 仅置为预览(PVW)，不碰主输出
      handleStreamSelect(target);
      if (viewMode !== 'director') {
        // 非导播台视图没有 TAKE 按钮，保留"数字直接切输出"的旧行为
        handleSelectOutput(target.streamKey);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams, viewMode, settingsOpen]);

  // 导播台：Enter / Space = CUT；T = 跑表开始/暂停；Shift+T = 清零
  useEffect(() => {
    if (viewMode !== 'director') return;
    const onKey = (e) => {
      if (settingsOpen) return;
      const el = document.activeElement;
      if (isEditableTarget(el) || isInsideDialog(el)) return;
      if (e.key === 'Enter' || e.key === ' ') {
        // 焦点在按钮/链接上时，让 Enter/Space 去按那个按钮，不要偷偷 CUT
        if (isButtonLike(el)) return;
        e.preventDefault();
        handleCut();
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        if (e.shiftKey) clockAction('reset');
        else clockAction('toggle');
        return;
      }
      // 选手介绍模式：[ / ] 上一位·下一位，I 上屏/隐藏
      if (scoreboard?.mode === 'intro') {
        if (e.key === '[' || e.key === ']') {
          e.preventDefault();
          introAction(e.key === ']' ? 'next' : 'prev');
          return;
        }
        if (e.key === 'i' || e.key === 'I') {
          e.preventDefault();
          introAction('toggle');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, selectedStream, outputStream, streams, scoreboard, settingsOpen]);

  // 进入导播台时若无预览，自动选第一路作为 PVW
  useEffect(() => {
    if (viewMode !== 'director') return;
    if (!selectedStream && streams[0]) setSelectedStream(streams[0]);
    if (!outputStream && streams[0]) handleSelectOutput(streams[0].streamKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, streams]);

  // 节目单：PageDown = 下一项，PageUp = 上一项（一键换项 + 名册就位，现场不用打字）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'PageDown' && e.key !== 'PageUp') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (settingsOpen) return;
      const el = document.activeElement;
      if (isEditableTarget(el) || isInsideDialog(el)) return;
      e.preventDefault();
      programAction(e.key === 'PageDown' ? 'next' : 'prev');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

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

  // 导播台快捷改分：本地先加，只 POST 一个字段（不重传照片），并用队列保证连点顺序
  const bumpScore = (side, delta) => {
    const key = side === 'home' ? 'home' : 'away';
    const field = side === 'home' ? 'homeScore' : 'awayScore';
    scoreRef.current[key] = Math.max(0, (Number(scoreRef.current[key]) || 0) + delta);
    const value = scoreRef.current[key];
    const seq = ++scoreSeqRef.current;
    scoreInflightRef.current += 1;

    // 乐观更新：现场按下去立刻看到数字变化
    setScoreboard(prev => (prev ? { ...prev, [field]: value } : prev));

    scoreQueueRef.current = scoreQueueRef.current.then(async () => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch('http://localhost:3001/api/scoreboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (seq === scoreSeqRef.current) {
          scoreRef.current.home = Number(d.homeScore) || 0;
          scoreRef.current.away = Number(d.awayScore) || 0;
          setScoreboard(d);
        }
      } catch (e) {
        if (seq === scoreSeqRef.current) {
          const reason = e?.name === 'AbortError' ? '请求超时' : (e?.message || '网络错误');
          showToast('改分失败：' + reason);
          // 失败后拉回服务端真实比分，别让界面停在一个没存上的数字
          try {
            const r = await fetch('http://localhost:3001/api/scoreboard');
            const d = await r.json();
            scoreRef.current.home = Number(d.homeScore) || 0;
            scoreRef.current.away = Number(d.awayScore) || 0;
            setScoreboard(d);
          } catch { /* 网络断了，等下次同步 */ }
        }
      } finally {
        clearTimeout(timeout);
        scoreInflightRef.current = Math.max(0, scoreInflightRef.current - 1);
      }
    });
  };

  const clockAction = async (action) => {
    try {
      const r = await fetch('http://localhost:3001/api/scoreboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clockAction: action }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.error('跑表失败', e);
      showToast('跑表操作失败：' + (e?.message || '网络错误'));
    }
  };

  // 节目单：上一项 / 下一项 / 跳到第 N 项（赛程紧凑时一键换项，名册自动就位）
  const programAction = async (action, index) => {
    try {
      const r = await fetch('http://localhost:3001/api/scoreboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'apply' ? { programAction: 'apply', programIndex: index } : { programAction: action },
        ),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.error('节目单切换失败', e);
      showToast('节目单切换失败：' + (e?.message || '网络错误'));
    }
  };

  // 选手介绍：上一位 / 下一位 / 上屏 / 隐藏（服务端统一推进，HDMI 与监看同步）
  const introAction = async (action) => {
    try {
      const r = await fetch('http://localhost:3001/api/scoreboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ introAction: action }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.error('选手介绍切换失败', e);
      showToast('选手介绍切换失败：' + (e?.message || '网络错误'));
    }
  };

  const isTeamBoard = scoreboard && scoreboard.mode === 'team';
  const isIntroBoard = scoreboard && scoreboard.mode === 'intro';

  const updateTransition = async (patch) => {
    const next = { ...transition, ...patch };
    setTransition(next);
    try {
      await fetch('http://localhost:3001/api/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch (e) {
      console.error('转场设置失败', e);
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

  // ─── 调色 ───────────────────────────────────────────────────────────────────
  // 取某一路最终生效的参数（机位覆盖优先，未覆盖则用全局）
  const gradeFor = useCallback((streamKey) => resolveGrade(colorGrade, streamKey), [colorGrade]);

  const globalGrade = normalizeGrade(colorGrade);
  const gradeOn = !!globalGrade.enabled;
  const gradeTouched = GRADE_KEYS.some(k => Number(globalGrade[k]));
  const gradeOverrideCount = Object.keys(colorGrade?.sources || {}).length;

  const toggleGrade = async () => {
    const next = { ...globalGrade, enabled: !globalGrade.enabled };
    setColorGrade(prev => ({ ...(prev || {}), ...next }));
    try {
      await fetch('http://localhost:3001/api/color', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'global', patch: { enabled: next.enabled } }),
      });
    } catch (e) {
      console.error('调色开关失败', e);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">🏟</span>
          <span className="brand-text">
            <h1>田径赛事导播台</h1>
            <span className="brand-sub">LIVE SWITCHER · 多机位实时导播</span>
          </span>
        </div>
        <div className="header-controls">
          <div className={`status ${serverStatus === '已连接' ? 'is-online' : 'is-offline'}`}>
            <span className={`status-indicator ${serverStatus === '已连接' ? 'online' : 'offline'}`}></span>
            <span className="status-text">{serverStatus}</span>
            <span className="status-divider" aria-hidden="true" />
            <span className="stream-count">活跃设备 {streams.length}</span>
          </div>
          {streams.length > 0 && (
            <div className="header-group">
              <button className="view-mode-btn" onClick={toggleViewMode}>
                {viewMode === 'single' ? '📺 网格视图' : viewMode === 'grid' ? '🎬 导播台' : '🎯 单屏视图'}
              </button>
              {viewMode === 'director' && (
                <button className="view-mode-btn cut-btn" onClick={handleCut}
                  title={`将预览切到输出（Enter）· 当前转场：${transition.type}`}>
                  ▶ TAKE
                </button>
              )}
            </div>
          )}
          <div className="header-group">
            <button className="view-mode-btn audio-open-btn" onClick={handleOpenAudio}>
              🎚 音频混音台
            </button>
            <button
              className="view-mode-btn"
              onClick={() => {
                const host = serverInfo?.lanIp || 'localhost';
                window.open(`http://${host}:3001/console/`, '_blank');
              }}
              title="在浏览器打开手机 / 平板控台（需与电脑同一局域网）"
            >
              📱 网页控台
            </button>
          </div>
          <div className="header-group">
            <button
              className={`view-mode-btn grade-open-btn ${gradeOn ? 'is-on' : ''}`}
              onClick={toggleGrade}
              title={`全局调色：${gradeOn ? '已启用（点击关闭）' : '已关闭（点击启用）'} · 参数在左侧「画面调色」`}
            >
              🎨 调色 {gradeOn ? '开' : '关'}
            </button>
            <button className="view-mode-btn settings-btn" onClick={handleOpenSettings}
              title={settingsDetached
                ? '设置已在独立窗口中打开（点击聚焦该窗口）'
                : '打开设置弹窗'}>
              ⚙️ 设置
            </button>
            <button
              className={`view-mode-btn settings-popout-btn ${settingsDetached ? 'is-on' : ''}`}
              onClick={handleDetachSettings}
              title="把设置拉出为独立窗口：可拖到第二块屏幕，主窗口继续监看画面（Ctrl+,）"
            >
              ⧉ 独立窗口
            </button>
          </div>
        </div>
      </header>

      <div className="main-content">
        <aside className="sidebar">
          <div className="sidebar-scroll">
            {/* 赛事核心：田径置顶 */}
            <SidebarSection
              id="track"
              title="田径直播"
              icon="🏟"
              defaultOpen
            >
              <TrackPanel />
            </SidebarSection>

            {/* 手动计时：多位老师扫码录成绩 → 去极值平均 → 一键回传叠加层 */}
            <SidebarSection
              id="timing"
              title="计时录入"
              icon="⏱"
              badge="扫码录成绩"
              defaultOpen={false}
            >
              <TimingPanel />
            </SidebarSection>

            <SidebarSection
              id="sources"
              title="信号源"
              icon="📹"
              badge={liveStreams.length > 0 ? String(liveStreams.length) : ''}
              defaultOpen
            >
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
                onRemove={(key) => {
                  setStreams(s => s.filter(x => x.streamKey !== key));
                  // 被移除的素材可能正占着预览/输出，立即清掉，别让输出层指向空 key
                  setSelectedStream(prev => (prev?.streamKey === key ? null : prev));
                  setOutputStream(prev => (prev === key ? null : prev));
                }}
                onSelect={handleStreamSelect}
                selectedStream={selectedStream}
                outputStream={outputStream}
                onSelectOutput={handleSelectOutput}
                indexOffset={liveStreams.length}
              />
            </SidebarSection>

            <SidebarSection
              id="output"
              title="输出 / HDMI"
              icon="🖥"
              badge={outputStream || '未选'}
              defaultOpen
              keepMounted
            >
              {outputStream && (
                <div className="output-info output-info--bar">
                  <p className="output-stream">📡 PROGRAM · {outputStream}</p>
                </div>
              )}
              <HdmiOutputPanel streams={streams} />
              <RecordPanel
                outputStream={outputStream}
                grade={gradeFor(outputStream)}
                scoreboard={scoreboard}
                videoRefsMap={videoRefsMap.current}
                recordVideoRefsMap={recordRefsMap.current}
                onRequestProgram={(key) => {
                  const target = streams.find(s => s.streamKey === key);
                  if (target) handleStreamSelect(target);
                }}
              />
            </SidebarSection>

            <SidebarSection
              id="color"
              title="画面调色"
              icon="🎨"
              badge={
                gradeOverrideCount > 0
                  ? `${gradeOn ? '开' : '关'} ·${gradeOverrideCount}机位`
                  : (gradeOn ? '已启用' : '原片')
              }
              defaultOpen={false}
            >
              <ColorPanel compact streams={streams} />
            </SidebarSection>

            <SidebarSection
              id="rtmp"
              title="推流地址"
              icon="🔗"
              defaultOpen={false}
            >
              <div className="connection-info">
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
              </div>
            </SidebarSection>

            <div className="sidebar-end-spacer" />
          </div>
        </aside>

        <main className="video-area">
          {viewMode === 'director' && streams.length > 0 ? (
            <div className="director-layout">
              <section className="director-monitors">
                <div className="director-monitor director-pgm">
                  <div className="director-monitor-label pgm">PGM · PROGRAM</div>
                  {pgmFx && pgmFx.type !== 'cut' && (
                    <div
                      className={`pgm-fx pgm-fx-${pgmFx.type} pgm-fx-dir-${pgmFx.direction || 'left'}`}
                      style={{ '--fx-duration': `${pgmFx.duration || 500}ms` }}
                      aria-hidden="true"
                    />
                  )}
                  {(() => {
                    // PGM 池：当前输出 + 预览都保持挂载，切换时只切显隐，不重建播放器。
                    // 预览这一路在后台静音预热，TAKE 时立刻出画（关键帧已经拿到）。
                    const keys = [];
                    if (outputStream) keys.push(outputStream);
                    const pv = selectedStream?.streamKey;
                    if (pv && !keys.includes(pv)) keys.push(pv);
                    if (!keys.length) return <div className="director-empty">未设置输出</div>;
                    return keys.map((k) => {
                      const st = streams.find(s => s.streamKey === k);
                      const active = k === outputStream;
                      if (!st) {
                        return active ? <div key={k} className="director-empty">等待 {k}</div> : null;
                      }
                      return (
                        <div key={k} className={`pgm-layer ${active ? 'pgm-layer-on' : 'pgm-layer-off'}`}>
                          <VideoPlayer stream={st} compact={false} program preload={!active}
                            grade={gradeFor(k)} />
                        </div>
                      );
                    });
                  })()}
                </div>
                <div className="director-monitor director-pvw">
                  <div className="director-monitor-label pvw">PVW · 预览</div>
                  {selectedStream ? (
                    <VideoPlayer stream={selectedStream} compact={false} grade={gradeFor(selectedStream.streamKey)}
                      onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount} />
                  ) : (
                    <div className="director-empty">按数字键 1–9 或点击多画面选择预览</div>
                  )}
                </div>
              </section>
              <div className="director-toolbar">
                <button className="cut-btn cut-btn--lg" onClick={handleCut}
                  disabled={!selectedStream || selectedStream.streamKey === outputStream}
                  title="将预览切到输出（Enter），使用当前转场">
                  ▶ TAKE
                </button>

                <div className="transition-bar" role="group" aria-label="转场预设">
                  <span className="transition-bar-label">转场</span>
                  {[
                    ['cut', '硬切'],
                    ['mix', '叠化'],
                    ['wipe', '划像'],
                    ['dip', '黑场'],
                    ['slide', '滑动'],
                  ].map(([type, label]) => (
                    <button
                      key={type}
                      type="button"
                      className={`transition-chip ${transition.type === type ? 'active' : ''}`}
                      onClick={() => updateTransition({ type })}
                      title={
                        type === 'cut' ? '瞬时切换' :
                        type === 'mix' ? '交叉溶解' :
                        type === 'wipe' ? '按方向划入新画面' :
                        type === 'dip' ? '经黑场过渡' : '新画面推入'
                      }
                    >
                      {label}
                    </button>
                  ))}
                  <select
                    className="transition-select"
                    value={transition.direction || 'left'}
                    onChange={e => updateTransition({ direction: e.target.value })}
                    disabled={transition.type !== 'wipe' && transition.type !== 'slide'}
                    title="划像 / 滑动方向"
                  >
                    <option value="left">← 左</option>
                    <option value="right">→ 右</option>
                    <option value="up">↓ 上</option>
                    <option value="down">↑ 下</option>
                  </select>
                  <select
                    className="transition-select"
                    value={String(transition.duration || 500)}
                    onChange={e => updateTransition({ duration: Number(e.target.value) })}
                    disabled={transition.type === 'cut'}
                    title="转场时长"
                  >
                    <option value="300">300ms</option>
                    <option value="400">400ms</option>
                    <option value="500">500ms</option>
                    <option value="700">700ms</option>
                    <option value="1000">1000ms</option>
                    <option value="1500">1500ms</option>
                  </select>
                </div>

                <div className="director-score-quick" title="跑表 T/Shift+T · 球队改分 · 选手介绍 [ ]/I（模式见侧栏）">
                  <button type="button" onClick={() => clockAction('start')}>▶ 跑表</button>
                  <button type="button" onClick={() => clockAction('stop')}>⏸ 暂停</button>
                  <button type="button" onClick={() => clockAction('reset')}>↺ 清零</button>
                  <button type="button" onClick={() => clockAction('lap')}>⌗ 记圈</button>
                  {isTeamBoard && (
                    <>
                      <span className="director-score-divider" />
                      <button type="button" onClick={() => bumpScore('home', -1)}>主−</button>
                      <button type="button" onClick={() => bumpScore('home', 1)}>主+</button>
                      <button type="button" onClick={() => bumpScore('away', -1)}>客−</button>
                      <button type="button" onClick={() => bumpScore('away', 1)}>客+</button>
                    </>
                  )}
                  {isIntroBoard && (
                    <>
                      <span className="director-score-divider" />
                      <button type="button" onClick={() => introAction('prev')}>◀ 上一位</button>
                      <button type="button" onClick={() => introAction('next')}>下一位 ▶</button>
                      <button
                        type="button"
                        className={scoreboard?.introVisible === false ? '' : 'on'}
                        onClick={() => introAction('toggle')}
                        title="上屏 / 隐藏（I）"
                      >
                        {scoreboard?.introVisible === false ? '＋ 上屏' : '－ 隐藏'}
                      </button>
                      <span className="intro-quick-current">
                        {Number(scoreboard?.introIndex || 0) + 1}
                        {' / '}
                        {(scoreboard?.athletes || []).filter(a => String(a?.name || '').trim() || a?.photo).length}
                      </span>
                    </>
                  )}
                </div>

                <button
                  type="button"
                  className={`director-grade-btn ${gradeOn ? 'on' : ''}`}
                  onClick={toggleGrade}
                  title="一键开关全局调色（参数在左侧「画面调色」中调整）"
                >
                  🎨 调色 {gradeOn ? (gradeTouched ? '开' : '开·中性') : '关'}
                </button>
                <span className="director-hint">Enter/TAKE 用当前转场 · 数字键 1–9 选预览 · Shift+数字直切输出 · T 跑表{isIntroBoard ? ' · [ ] 切换选手 · I 上屏/隐藏' : ''}</span>
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
                        <VideoPlayer stream={stream} compact grade={gradeFor(stream.streamKey)}
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
                  <VideoPlayer stream={stream} compact={true} grade={gradeFor(stream.streamKey)}
                    onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount} />
                </div>
              ))}
            </div>
          ) : selectedStream ? (
            <VideoPlayer stream={selectedStream} compact={false} grade={gradeFor(selectedStream.streamKey)}
              onVideoReady={handleVideoReady} onVideoUnmount={handleVideoUnmount}
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
                <div className="placeholder-icon" aria-hidden="true">🎥</div>
                <h2>请选择一个摄影设备</h2>
                <p>从左侧「信号源」选择要监看的画面，或直接按数字键切换</p>
                <div className="placeholder-keys" aria-hidden="true">
                  <span><kbd>1</kbd>–<kbd>9</kbd> 选画面</span>
                  <span><kbd>Shift</kbd> + <kbd>数字</kbd> 切输出</span>
                  <span><kbd>Enter</kbd> TAKE</span>
                </div>
                {streams.length > 1 && (
                  <button className="grid-view-hint" onClick={toggleViewMode}>
                    切换到网格视图，同时监看所有设备 →
                  </button>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* 录制专用隐藏源：始终挂载输出流，录制时不必切走导播预览 */}
      <RecordSource
        streamKey={outputStream}
        stream={streams.find(s => s.streamKey === outputStream)}
        onReady={handleRecordVideoReady}
        onUnmount={handleRecordVideoUnmount}
      />

      {/* 导播台已有大 PGM 监看，隐藏右下角浮窗避免重复 */}
      {viewMode !== 'director' && (
        <OutputMonitor streamKey={outputStream} streams={streams} grade={gradeFor(outputStream)} />
      )}
      {toast && (
        <div className={`app-toast app-toast--${toast.tone || 'error'}`} role="status">
          {toast.text}
        </div>
      )}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onDetach={handleDetachSettings}
      />
    </div>
  );
}

export default App;
