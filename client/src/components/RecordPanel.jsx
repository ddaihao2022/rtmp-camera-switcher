import { useEffect, useRef, useState } from 'react';

/**
 * 录制面板
 * Props:
 *   outputStream  - 当前选为输出的 streamKey
 *   videoRefsMap  - Map<streamKey, HTMLVideoElement>，由 App 层维护
 */
export default function RecordPanel({ outputStream, videoRefsMap }) {
  const [status, setStatus] = useState('idle'); // idle | recording | saving
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [lastFile, setLastFile] = useState(null);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const startTimeRef = useRef(0);

  // 清理
  useEffect(() => () => {
    clearInterval(timerRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const getSupportedMime = () => {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    return candidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
  };

  const handleStart = () => {
    setError(null);
    const videoEl = videoRefsMap?.get(outputStream);
    if (!videoEl) {
      setError('未找到输出视频元素，请先选择输出画面并开始播放');
      return;
    }

    let stream;
    try {
      stream = videoEl.captureStream?.() || videoEl.mozCaptureStream?.();
    } catch (e) {
      setError('captureStream 失败：' + e.message);
      return;
    }
    if (!stream) {
      setError('此浏览器不支持 captureStream');
      return;
    }

    const mime = getSupportedMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    } catch (e) {
      setError('无法创建录制器：' + e.message);
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = (e) => {
      setError('录制出错：' + e.error?.message);
      setStatus('idle');
      clearInterval(timerRef.current);
    };

    recorder.start(500); // 每 500ms 收一次数据
    recorderRef.current = recorder;
    startTimeRef.current = Date.now();
    setStatus('recording');
    setDuration(0);

    timerRef.current = setInterval(() => {
      setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 500);
  };

  const handleStop = async () => {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') return;
    clearInterval(timerRef.current);
    setStatus('saving');

    await new Promise(resolve => {
      recorderRef.current.onstop = resolve;
      recorderRef.current.stop();
    });

    const mime = recorderRef.current.mimeType || 'video/webm';
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunksRef.current, { type: mime });

    const api = window.electronAPI;
    if (api?.saveRecording) {
      // Electron：弹出保存对话框
      const buf = await blob.arrayBuffer();
      const result = await api.saveRecording(buf, ext);
      if (result.success) {
        setLastFile(result.filePath);
      } else {
        setError('保存已取消');
      }
    } else {
      // 浏览器：触发下载
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `recording-${ts}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    chunksRef.current = [];
    recorderRef.current = null;
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
              录制当前输出画面，保存为 WebM 格式
            </p>
          )}
        </>
      )}
    </div>
  );
}
