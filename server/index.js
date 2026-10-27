const NodeMediaServer = require('node-media-server');
const NmsContext = require('node-media-server/src/core/context');
const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const cors = require('cors');

// ─── 日志开关 ─────────────────────────────────────────────────────────────────
// 启动时可通过环境变量 VERBOSE_LOG=1 开启；运行时也可通过 API /api/log/toggle 切换
let verboseLog = process.env.VERBOSE_LOG === '1';

const logger = {
  info:    (...args) => console.log(...args),                          // 始终输出
  verbose: (...args) => { if (verboseLog) console.log('[VERBOSE]', ...args); },
  debug:   (...args) => { if (verboseLog) console.log('[DEBUG]', ...args); },
  isVerbose: () => verboseLog,
  setVerbose: (v) => {
    verboseLog = !!v;
    // 让诊断钩子随开关挂上/摘下，避免关闭日志后仍在收包热路径上做无谓计数
    syncDiagHooks();
    console.log(`[LOG] 详细日志已${verboseLog ? '开启' : '关闭'}`);
  }
};

// 获取本机内网 IPv4(优先选择常见的 192/10/172 段)
function getLanIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      candidates.push({ name, address: info.address });
    }
  }
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 3;
    if (ip.startsWith('10.')) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
    return 0;
  };
  candidates.sort((a, b) => score(b.address) - score(a.address));
  return candidates[0]?.address || '127.0.0.1';
}

// 诊断挂钩：仅在 verbose 开启时挂载。
// 这些钩子会包住 broadcastMessage / onPacketCallback —— 它们位于 RTMP 收包热路径上，
// 即使不输出日志，也会给每个 packet 增加一次函数调用和计数开销，因此默认不挂。
const broadcastStats = new Map();
const inBytesLast = new Map();
let diagPatchTimer = null;
let diagReportTimer = null;

function patchDiagHooks() {
  for (const [streamPath, broadcast] of NmsContext.broadcasts.entries()) {
    if (!broadcast.__patched__) {
      const orig = broadcast.broadcastMessage;
      const stat = { calls: 0, bytes: 0 };
      broadcastStats.set(streamPath, stat);
      broadcast.__origBroadcastMessage__ = orig;
      broadcast.broadcastMessage = (packet) => {
        stat.calls++;
        stat.bytes += packet?.data?.length || 0;
        stat.subs = broadcast.subscribers.size;
        return orig(packet);
      };
      broadcast.__patched__ = true;
      logger.verbose(`已挂钩 broadcast ${streamPath}`);
    }
  }
  for (const session of NmsContext.sessions.values()) {
    if (session.protocol === 'rtmp' && session.rtmp && !session.__patchedRtmp__) {
      const origCb = session.rtmp.onPacketCallback;
      let pktCount = 0;
      let pktBytes = 0;
      session.__origOnPacketCallback__ = origCb;
      session.rtmp.onPacketCallback = (packet) => {
        pktCount++;
        pktBytes += packet?.data?.length || 0;
        return origCb(packet);
      };
      session.__patchedRtmp__ = true;
      session.__getPktStats__ = () => {
        const s = { count: pktCount, bytes: pktBytes };
        pktCount = 0;
        pktBytes = 0;
        return s;
      };
      logger.verbose(`已挂钩 rtmp 协议层 ${session.id}`);
    }
  }
}

function reportDiag() {
  for (const [streamPath, broadcast] of NmsContext.broadcasts.entries()) {
    const pub = broadcast.publisher;
    if (!pub) continue;
    const cur = pub.inBytes || 0;
    const last = inBytesLast.get(pub.id) || 0;
    const delta = cur - last;
    inBytesLast.set(pub.id, delta ? cur : last);
    const stat = broadcastStats.get(streamPath) || { calls: 0, bytes: 0 };
    const rtmpStats = pub.__getPktStats__ ? pub.__getPktStats__() : { count: '?', bytes: 0 };
    const r = pub.rtmp || {};
    const pp = r.parserPacket || {};
    logger.debug(`[publisher] ${streamPath}: socket入 ${(delta / 1024).toFixed(1)} KB, rtmp解析 ${rtmpStats.count} 包/${(rtmpStats.bytes / 1024).toFixed(1)} KB, 广播 ${stat.calls} 包/${(stat.bytes / 1024).toFixed(1)} KB | parserState=${r.parserState} inChunk=${r.inChunkSize} pkt(type=${pp.header?.type} len=${pp.header?.length} bytes=${pp.bytes})`);
    stat.calls = 0;
    stat.bytes = 0;
  }
}

function startDiagHooks() {
  if (diagPatchTimer) return;
  patchDiagHooks();
  diagPatchTimer = setInterval(patchDiagHooks, 1000);
  diagReportTimer = setInterval(reportDiag, 5000);
}

function stopDiagHooks() {
  if (diagPatchTimer) clearInterval(diagPatchTimer);
  if (diagReportTimer) clearInterval(diagReportTimer);
  diagPatchTimer = null;
  diagReportTimer = null;
  broadcastStats.clear();
  inBytesLast.clear();
  // 还原被替换的方法，彻底从热路径上摘下钩子
  for (const broadcast of NmsContext.broadcasts.values()) {
    if (!broadcast.__patched__) continue;
    if (broadcast.__origBroadcastMessage__) {
      broadcast.broadcastMessage = broadcast.__origBroadcastMessage__;
    }
    broadcast.__patched__ = false;
  }
  for (const session of NmsContext.sessions.values()) {
    if (!session.__patchedRtmp__) continue;
    if (session.__origOnPacketCallback__ && session.rtmp) {
      session.rtmp.onPacketCallback = session.__origOnPacketCallback__;
    }
    session.__patchedRtmp__ = false;
  }
}

function syncDiagHooks() {
  if (verboseLog) startDiagHooks();
  else stopDiagHooks();
}

// node-media-server v4 配置
const nmsConfig = {
  bind: '0.0.0.0',
  rtmp: { 
    port: 1935,
    chunk_size: 4096,  // 降低 chunk 大小以减少分片延迟
    gop_cache: false,  // 禁用 GOP 缓存
    ping: 30,
    ping_timeout: 60
  },
  http: { 
    port: 8000,
    allow_origin: '*',
    mediaroot: './media'
  },
  auth: { play: false, publish: false },
  // 传输配置优化
  trans: {
    ffmpeg: '/usr/bin/ffmpeg',
    tasks: []
  }
};

const nms = new NodeMediaServer(nmsConfig);

// 低延迟：为每个新建的 BroadcastServer 重写 postPlay，跳过 GOP 缓存重放
// （新订阅者从缓存 GOP 起点开始播，会白等一个 GOP 的时长）
const patchBroadcastsLowLatency = () => {
  for (const [streamPath, broadcast] of NmsContext.broadcasts.entries()) {
    if (broadcast.__lowLatencyPatched__) continue;
    const origPostPlay = broadcast.postPlay;
    broadcast.__origPostPlay__ = origPostPlay;
    broadcast.postPlay = (session) => {
      const flvGop = broadcast.flvGopCache;
      const rtmpGop = broadcast.rtmpGopCache;
      broadcast.flvGopCache = null;
      broadcast.rtmpGopCache = null;
      try {
        return origPostPlay(session);
      } finally {
        broadcast.flvGopCache = flvGop;
        broadcast.rtmpGopCache = rtmpGop;
      }
    };
    broadcast.__lowLatencyPatched__ = true;
    logger.verbose(`[低延迟] 已禁用 ${streamPath} 的 GOP 缓存重放`);
  }
};
// 定期兜底（新流上线时会立即补一次，见 postPublish）
setInterval(patchBroadcastsLowLatency, 500);

// Express 应用
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const activeStreams = new Map();
let selectedOutputStream = null;

// 输出选择在断流后的保留期（毫秒）：期间同一路重新上线则自动续上
const OUTPUT_RECONNECT_GRACE_MS = 30000;
let outputClearTimer = null;
let pendingOutputKey = null;

// 音频状态：Map<streamKey, { volume, muted }>
const audioState = {};

// 水印配置
let watermarkConfig = {
  enabled: false,
  type: 'text',       // 'text' | 'image'
  text: '',
  imageUrl: '',       // base64 data URL
  position: 'bottom-right', // top-left | top-right | bottom-left | bottom-right | center
  opacity: 0.8,
  fontSize: 32,
  color: '#ffffff',
  padding: 24,
};

// RTMP 事件监听
nms.on('prePublish', (session) => {
  logger.verbose(`[prePublish] id=${session.id} streamPath=${session.streamPath}`);
});

nms.on('postPublish', (session) => {
  const streamPath = session.streamPath;
  logger.info(`[postPublish] id=${session.id} streamPath=${streamPath}`);

  const streamKey = streamPath.replace(/^\/+|\/+$/g, '');
  const flvPath = streamPath + '.flv';

  activeStreams.set(streamKey, {
    id: session.id,
    streamKey,
    streamPath,
    flvPath,
    startTime: new Date(),
    status: 'online'
  });

  // 新流上线：立刻给它的 BroadcastServer 打上低延迟补丁，再清掉可能待执行的输出取消
  patchBroadcastsLowLatency();
  if (outputClearTimer && pendingOutputKey === streamKey) {
    clearTimeout(outputClearTimer);
    outputClearTimer = null;
    pendingOutputKey = null;
    logger.info(`[输出] ${streamKey} 已重新上线，保留原有输出选择`);
  }

  logger.verbose('活跃流:', Array.from(activeStreams.keys()));
  io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
});

nms.on('donePublish', (session) => {
  const streamPath = session.streamPath;
  logger.info(`[donePublish] id=${session.id} streamPath=${streamPath}`);

  const streamKey = streamPath.replace(/^\/+|\/+$/g, '');
  activeStreams.delete(streamKey);

  // 断流不立刻取消输出：现场 RTMP 抖动、OBS 换场景重连都很常见，
  // 若此时把输出清空，HDMI 那块屏会直接黑成「未选择输出画面」，得人工再点一次。
  // 这里给一个宽限期，期间同一 streamKey 重新上线就自动续上；真下线了才清。
  if (selectedOutputStream === streamKey) {
    if (outputClearTimer) clearTimeout(outputClearTimer);
    pendingOutputKey = streamKey;
    outputClearTimer = setTimeout(() => {
      outputClearTimer = null;
      const key = pendingOutputKey;
      pendingOutputKey = null;
      if (key && selectedOutputStream === key && !activeStreams.has(key)) {
        selectedOutputStream = null;
        logger.info(`[输出] ${key} 超过 ${OUTPUT_RECONNECT_GRACE_MS / 1000}s 未重新上线，取消输出选择`);
        io.emit('outputSelected', { streamKey: null });
      }
    }, OUTPUT_RECONNECT_GRACE_MS);
    logger.verbose(`[输出] ${streamKey} 已断流，保留输出选择 ${OUTPUT_RECONNECT_GRACE_MS / 1000}s 等待重连`);
  }

  io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
});

nms.on('prePlay', (session) => {
  logger.verbose(`[prePlay] id=${session.id} streamPath=${session.streamPath}`);
});

nms.on('postPlay', (session) => {
  logger.verbose(`[postPlay] id=${session.id} streamPath=${session.streamPath}`);
});

// API 路由
app.get('/api/streams', (req, res) => {
  res.json(Array.from(activeStreams.values()));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeStreams: activeStreams.size });
});

app.get('/api/server-info', (req, res) => {
  const lanIp = getLanIp();
  res.json({
    lanIp,
    rtmpPort: 1935,
    httpFlvPort: 8000,
    apiPort: 3001,
    rtmpBase: `rtmp://${lanIp}:1935/live`
  });
});

app.get('/api/output', (req, res) => {
  res.json({ selectedStream: selectedOutputStream });
});

app.post('/api/output/select', (req, res) => {
  const { streamKey } = req.body;

  if (!streamKey) {
    selectedOutputStream = null;
    io.emit('outputSelected', { streamKey: null });
    return res.json({ success: true, message: '已取消输出选择' });
  }

  // 同时检查 RTMP 流和本地文件
  if (activeStreams.has(streamKey) || localFiles.has(streamKey)) {
    selectedOutputStream = streamKey;
    io.emit('outputSelected', { streamKey });
    res.json({ success: true, streamKey, message: `已选择 ${streamKey} 作为输出` });
  } else {
    res.status(404).json({ success: false, message: '流不存在' });
  }
});

// ─── 本地媒体文件虚拟流 ────────────────────────────────────────────────────────
// Map<streamKey, { streamKey, filePath, fileName, fileType, startTime, status, type }>
const localFiles = new Map();

function mimeFromExt(ext) {
  const map = { mp4:'video/mp4', mov:'video/quicktime', mkv:'video/x-matroska',
    avi:'video/x-msvideo', webm:'video/webm', m4v:'video/mp4', ts:'video/mp2t',
    flv:'video/x-flv', wmv:'video/x-ms-wmv',
    mp3:'audio/mpeg', aac:'audio/aac', wav:'audio/wav',
    flac:'audio/flac', m4a:'audio/mp4', ogg:'audio/ogg',
    png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
    webp:'image/webp', bmp:'image/bmp', svg:'image/svg+xml', ico:'image/x-icon',
    avif:'image/avif' };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

const AUDIO_EXT_RE = /^(mp3|aac|wav|flac|m4a|ogg)$/i;
const IMAGE_EXT_RE = /^(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const MEDIA_EXT_RE = /\.(mp4|mov|mkv|avi|webm|m4v|ts|flv|wmv|mp3|aac|wav|flac|m4a|ogg|png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

function detectLocalFileType(ext) {
  if (AUDIO_EXT_RE.test(ext)) return 'audio';
  if (IMAGE_EXT_RE.test(ext)) return 'image';
  return 'video';
}

/**
 * 校验并规范化一个本地文件路径。
 *
 * 这个接口以前接受任意 filePath，配合全开 CORS + 无鉴权，等于给本机开了个任意文件读取口
 * （传 "C:\\Windows\\...\\xxx" 或 "/etc/passwd" 都能被 /api/local/stream 读出来）。
 * 现在至少要求：必须是存在的普通文件，且扩展名属于受支持的媒体类型。
 * 注意这仍不是白名单目录校验，只挡住非媒体文件与目录。
 */
function resolveLocalMediaPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { error: 'filePath required' };
  }
  const resolved = path.resolve(rawPath.trim());
  if (!MEDIA_EXT_RE.test(resolved)) {
    return { error: '不支持的媒体扩展名' };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { error: '文件不存在或无法访问' };
  }
  if (!stat.isFile()) return { error: '目标不是文件' };
  return { resolved, size: stat.size };
}

// 注册本地文件为虚拟流
app.post('/api/local/add', (req, res) => {
  const { filePath, fileName } = req.body;
  const checked = resolveLocalMediaPath(filePath);
  if (checked.error) return res.status(400).json({ error: checked.error });

  const ext = checked.resolved.split('.').pop() || '';
  const fileType = detectLocalFileType(ext);
  const displayName = String(fileName || path.basename(checked.resolved));
  const key = 'local/' + displayName.replace(/[^a-zA-Z0-9._-]/g, '_');
  localFiles.set(key, {
    streamKey: key, filePath: checked.resolved, fileName: displayName, fileType,
    startTime: new Date(), status: 'online', type: 'local',
    // 播放设置默认值
    loop: false,
    autoplay: true,
    playbackRate: 1.0,
    // 图片：停留秒数（用于列表顺序切换；0 = 常驻）
    duration: fileType === 'image' ? 5 : 0,
  });
  io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
  res.json({ streamKey: key });
});

// 更新本地文件播放设置
app.patch('/api/local/:key(*)', (req, res) => {
  const key = req.params.key;
  const fullKey = key.startsWith('local/') ? key : 'local/' + key;
  const item = localFiles.get(fullKey);
  if (!item) return res.status(404).json({ error: 'not found' });
  const allowed = ['loop', 'autoplay', 'playbackRate', 'duration'];
  for (const field of allowed) {
    if (req.body[field] !== undefined) item[field] = req.body[field];
  }
  io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
  res.json(item);
});

// 移除本地文件虚拟流
app.delete('/api/local/:key(*)', (req, res) => {
  const key = req.params.key;
  localFiles.delete(key);
  io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
  res.json({ success: true });
});

// HTTP 代理：将本地文件以 HTTP range 方式提供给渲染进程
app.get('/api/local/stream/:key(*)', (req, res) => {
  const key = req.params.key;
  const item = localFiles.get('local/' + key) || localFiles.get(key);
  if (!item) return res.status(404).json({ error: 'not found' });
  const { filePath } = item;
  const ext = filePath.split('.').pop() || '';
  const mime = mimeFromExt(ext);

  // 只提供注册时校验过的路径：重新 stat 一次，顺带防止文件在注册后被替换成目录
  const checked = resolveLocalMediaPath(filePath);
  if (checked.error) return res.status(404).json({ error: checked.error });

  const total = checked.size;
  const range = req.headers.range;
  if (range) {
    const [, startStr, endStr] = /bytes=(\d+)-(\d*)/.exec(range) || [];
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : total - 1;
    if (!Number.isFinite(start) || start < 0 || start >= total) {
      return res.status(416).json({ error: 'range not satisfiable' });
    }
    const safeEnd = Math.min(Number.isFinite(end) ? end : total - 1, total - 1);
    const chunkSize = safeEnd - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${safeEnd}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mime,
    });
    fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// 列出已注册的本地文件
app.get('/api/local/list', (req, res) => {
  res.json(Array.from(localFiles.values()));
});

// ─── 音频状态 API ──────────────────────────────────────────────────────────────
app.get('/api/audio/state', (req, res) => {
  res.json(audioState);
});

// ─── 水印 API ─────────────────────────────────────────────────────────────────
app.get('/api/watermark', (req, res) => {
  res.json(watermarkConfig);
});

app.post('/api/watermark', (req, res) => {
  watermarkConfig = { ...watermarkConfig, ...req.body };
  io.emit('watermark:update', watermarkConfig);
  res.json(watermarkConfig);
});

// ─── 日志开关 API ──────────────────────────────────────────────────────────────
app.get('/api/log/status', (req, res) => {
  res.json({ verbose: logger.isVerbose() });
});

app.post('/api/log/toggle', (req, res) => {
  const { verbose } = req.body;
  const newState = verbose !== undefined ? !!verbose : !logger.isVerbose();
  logger.setVerbose(newState);
  io.emit('logStatusChanged', { verbose: newState });
  res.json({ verbose: newState });
});

// Socket.io 连接
io.on('connection', (socket) => {
  logger.verbose(`客户端连接: ${socket.id}`);

  socket.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
  if (selectedOutputStream) {
    socket.emit('outputSelected', { streamKey: selectedOutputStream });
  }
  // 新连接时同步当前日志状态
  socket.emit('logStatusChanged', { verbose: logger.isVerbose() });

  // 同步音频状态
  socket.emit('audio:stateUpdate', audioState);

  // 同步水印配置
  socket.emit('watermark:update', watermarkConfig);

  // 接收音频控制指令并广播给所有客户端
  socket.on('audio:setState', ({ streamKey, volume, muted }) => {
    if (!audioState[streamKey]) audioState[streamKey] = {};
    audioState[streamKey].volume = volume;
    audioState[streamKey].muted = muted;
    io.emit('audio:stateUpdate', audioState);
  });

  // 主窗口 VU 表数据转发给音频控制台
  socket.on('audio:vuData', (data) => {
    socket.broadcast.emit('audio:vuData', data);
  });

  socket.on('disconnect', () => {
    logger.verbose(`客户端断开: ${socket.id}`);
  });
});

// 启动服务器
nms.run();
if (verboseLog) startDiagHooks();
server.listen(3001, () => {
  const lanIp = getLanIp();
  logger.info('=================================');
  logger.info(`RTMP服务器运行在 rtmp://${lanIp}:1935`);
  logger.info(`HTTP-FLV服务器运行在 http://${lanIp}:8000`);
  logger.info(`API服务器运行在 http://${lanIp}:3001`);
  logger.info('=================================');
  logger.info('推流地址(必须 app/stream 两段式):');
  logger.info(`  rtmp://${lanIp}:1935/live/<设备名>`);
  logger.info(`  例:rtmp://${lanIp}:1935/live/cam1`);
  logger.info(`详细日志: ${verboseLog ? '已开启' : '已关闭'} (可通过 POST /api/log/toggle 切换)`);
});
