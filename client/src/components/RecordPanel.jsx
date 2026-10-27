import { useEffect, useRef, useState } from 'react';
import { getRecordingAudioStream } from '../audio.js';

/**
 * 录制面板
 *
 * 两个关键点：
 * 1. 流式写盘。Electron 下用 record:start / record:chunk / record:end 三段式，
 *    每 500ms 的 chunk 直接追加到磁盘写入流，渲染进程不保留历史数据。
 *    （旧实现把整段录制攒成 blob 再一次性过 IPC，几分钟 1080p 就会 OOM。）
 * 2. 音频取自 Web Audio 图（gain 之后），而不是 videoEl.captureStream()。
 *    元素被 createMediaElementSource 接管后，captureStream 的音轨通常是静音的。
 *
 * Props:
 *   outputStream  - 当前选为输出的 streamKey
 *   videoRefsMap  - Map<streamKey, HTMLMediaElement>，由 App 层维护
 */

const CHUNK_INTERVAL_MS = 1000;

function pickSupportedMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

function extFromMime(mime) {
  return mime && mime.includes('mp4') ? 'mp4' : 'webm';
}

export default function RecordPanel({ outputStream, videoRefsMap }) {
  const [status, setStatus] = useState('idle'); // idle | recording | saving
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [lastFile, setLastFile] = useState(null);

  const recorderRef = useRef(null);
  const sessionRef = useRef(null);     // Electron 写入会话 id
  const writeChainRef = useRef(Promise.resolve());
  const chunksRef = useRef([]);        // 仅浏览器回退路径使用
  const timerRef = useRef(null);
  const startTimeRef = useRef(0);
  const stoppingRef = useRef(false);

  // 清理：面板卸载时把录制收尾，避免留下半截文件或无主句柄
  useEffect(() => () => {
    clearInterval(timerRef.current);
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* ignore */ }
    }
    const api = window.electronAPI;
    const sessionId = sessionRef.current;
    if (api?.cancelRecording && sessionId) {
      sessionRef.current = null;
      api.cancelRecording(sessionId).catch(() => {});
    }
  }, []);

  /** 组装录制用的 MediaStream：画面来自元素，声音优先取 Web Audio 图 */
  const buildRecordingStream = (mediaEl, streamKey) => {
    let elementStream;
    try {
      elementStream = mediaEl.captureStream?.() || mediaEl.mozCaptureStream?.();
    } catch (e) {
      return { error: 'captureStream 失败：' + e.message };
    }
    if (!elementStream) return { error: '此环境不支持 captureStream' };

    const videoTracks = elementStream.getVideoTracks();
    const audioStream = getRecordingAudioStream(streamKey);
    const audioTracks = audioStream ? audioStream.getAudioTracks() : [];

    // Web Audio 图里没有这一路时，退回元素自带的音轨
    const finalAudio = audioTracks.length > 0 ? audioTracks : elementStream.getAudioTracks();

    if (videoTracks.length === 0 && finalAudio.length === 0) {
      return { error: '该画面没有可录制的内容' };
    }
    return { stream: new MediaStream([...videoTracks, ...finalAudio]) };
  };

  const handleStart = async () => {
    setError(null);
    setLastFile(null);

    const mediaEl = videoRefsMap?.get(outputStream);
    if (!mediaEl) {
      setError('未找到该画面的播放器，请先在左侧选中并播放它');
      return;
    }

    const { stream, error: streamError } = buildRecordingStream(mediaEl, outputStream);
    if (streamError) {
      setError(streamError);
      return;
    }

    const mime = pickSupportedMime();
    const api = window.electronAPI;

    // Electron：先要保存路径，拿到会话 id 再开始录，避免录完还可能被取消对话框丢弃
    if (api?.startRecording) {
      let started;
      try {
        started = await api.startRecording(extFromMime(mime));
      } catch (e) {
        setError('无法创建录制文件：' + e.message);
        return;
      }
      if (!started?.success) {
        if (!started?.canceled) setError(started?.error || '保存路径选择失败');
        return;
      }
      sessionRef.current = started.sessionId;
      writeChainRef.current = Promise.resolve();
    } else {
      chunksRef.current = [];
    }

    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    } catch (e) {
      setError('无法创建录制器：' + e.message);
      if (api?.cancelRecording && sessionRef.current) {
        api.cancelRecording(sessionRef.current).catch(() => {});
        sessionRef.current = null;
      }
      return;
    }

    // 分块按顺序写入：arrayBuffer() 是异步的，串成链保证落盘顺序与录制顺序一致
    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      if (sessionRef.current && api?.writeRecordingChunk) {
        const sessionId = sessionRef.current;
        writeChainRef.current = writeChainRef.current
          .then(() => e.data.arrayBuffer())
          .then((buf) => api.writeRecordingChunk(sessionId, buf))
          .catch((err) => setError('写入录制数据失败：' + err.message));
      } else {
        chunksRef.current.push(e.data);
      }
    };

    recorder.onerror = (e) => {
      setError('录制出错：' + (e.error?.message || '未知错误'));
      clearInterval(timerRef.current);
      setStatus('idle');
    };

    recorder.start(CHUNK_INTERVAL_MS);
    recorderRef.current = recorder;
    startTimeRef.current = Date.now();
    stoppingRef.current = false;
    setStatus('recording');
    setDuration(0);

    timerRef.current = setInterval(() => {
      setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 500);
  };

  const handleStop = async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive' || stoppingRef.current) return;
    stoppingRef.current = true;
    clearInterval(timerRef.current);
    setStatus('saving');
    setError(null);

    await new Promise((resolve) => {
      recorder.onstop = resolve;
      try { recorder.stop(); } catch { resolve(); }
    });
    recorderRef.current = null;

    const api = window.electronAPI;
    const sessionId = sessionRef.current;

    if (api?.finishRecording && sessionId) {
      // 等所有分块真正写进 IPC，再让主进程收尾，否则尾部数据会丢
      await writeChainRef.current.catch(() => {});
      sessionRef.current = null;
      try {
        const result = await api.finishRecording(sessionId);
        if (result?.success) {
          setLastFile(result.filePath);
        } else {
          setError(result?.error || '保存失败');
        }
      } catch (e) {
        setError('保存失败：' + e.message);
      }
    } else {
      // 浏览器回退：一次性下载（浏览器没有流式落盘能力，只能这样）
      const mime = recorder.mimeType || 'video/webm';
      const ext = extFromMime(mime);
      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];
      if (blob.size === 0) {
        setError('没有录到任何数据');
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `recording-${ts}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setLastFile(`已下载 recording-${ts}.${ext}`);
      }
    }

    stoppingRef.current = false;
    setStatus('idle');
  };

  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const canRecord = !!outputStream;

  return (
    <div className="hdmi-panel record-panel">
      <h3>⏺ 录制输出</h3>

      {!canRecord && (
        <p className="hint">请先在流列表中选择一路画面作为输出</p>
      )}

      {canRecord && (
        <>
          <div className="record-source">
            <span className="record-dot" data-state={status} />
            <span className="hint" style={{ flex: 1 }}>
              {status === 'recording'
                ? `录制中 ${fmt(duration)}`
                : status === 'saving'
                  ? '保存中...'
                  : `准备录制 · ${outputStream}`}
            </span>
          </div>

          <div className="hdmi-actions" style={{ marginTop: 8 }}>
            {status === 'idle' ? (
              <button className="hdmi-btn primary" onClick={handleStart}>
                ⏺ 开始录制
              </button>
            ) : status === 'recording' ? (
              <button className="hdmi-btn danger" onClick={handleStop}>
                ⏹ 停止并保存
              </button>
            ) : (
              <button className="hdmi-btn" disabled>
                保存中...
              </button>
            )}
          </div>

          {error && <p className="hint" style={{ color: '#ef4444', marginTop: 6 }}>{error}</p>}
          {lastFile && (
            <p className="hint" style={{ marginTop: 6, wordBreak: 'break-all' }}>
              已保存：{lastFile}
            </p>
          )}
          {status === 'idle' && !error && (
            <p className="hint" style={{ marginTop: 6 }}>
              边录边写盘，长录制不再占用大量内存。声音取自混音台的实际输出（推子与静音都会影响录制）。
            </p>
          )}
        </>
      )}
    </div>
  );
}
