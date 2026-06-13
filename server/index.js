const NodeMediaServer = require('node-media-server');
const NmsContext = require('node-media-server/src/core/context');
const express = require('express');
const http = require('http');
const os = require('os');
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

// 诊断:监控所有 BroadcastServer，在每次广播 packet 时记录（仅 verbose 模式）
const broadcastStats = new Map();
setInterval(() => {
  for (const [path, broadcast] of NmsContext.broadcasts.entries()) {
    if (!broadcast.__patched__) {
      const orig = broadcast.broadcastMessage;
      const stat = { calls: 0, bytes: 0 };
      broadcastStats.set(path, stat);
      broadcast.broadcastMessage = (packet) => {
        stat.calls++;
        stat.bytes += packet?.data?.length || 0;
        stat.subs = broadcast.subscribers.size;
        return orig(packet);
      };
      broadcast.__patched__ = true;
      logger.verbose(`已挂钩 broadcast ${path}`);
    }
  }
  for (const session of NmsContext.sessions.values()) {
    if (session.protocol === 'rtmp' && session.rtmp && !session.__patchedRtmp__) {
      const origCb = session.rtmp.onPacketCallback;
      let pktCount = 0;
      let pktBytes = 0;
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
}, 200);

// 同时跟踪 publisher 实际吞吐（仅 verbose 模式输出）
const inBytesLast = new Map();
setInterval(() => {
  for (const [path, broadcast] of NmsContext.broadcasts.entries()) {
    const pub = broadcast.publisher;
    if (!pub) continue;
    const cur = pub.inBytes || 0;
    const last = inBytesLast.get(pub.id) || 0;
    const delta = cur - last;
    inBytesLast.set(pub.id, cur);
    const stat = broadcastStats.get(path) || { calls: 0, bytes: 0 };
    const rtmpStats = pub.__getPktStats__ ? pub.__getPktStats__() : { count: '?', bytes: 0 };
    const r = pub.rtmp || {};
    const pp = r.parserPacket || {};
    logger.debug(`[publisher] ${path}: socket入 ${(delta / 1024).toFixed(1)} KB, rtmp解析 ${rtmpStats.count} 包/${(rtmpStats.bytes / 1024).toFixed(1)} KB, 广播 ${stat.calls} 包/${(stat.bytes / 1024).toFixed(1)} KB | parserState=${r.parserState} inChunk=${r.inChunkSize} pkt(type=${pp.header?.type} len=${pp.header?.length} bytes=${pp.bytes})`);
    stat.calls = 0;
    stat.bytes = 0;
  }
}, 5000);

// node-media-server v4 配置
const nmsConfig = {
  bind: '0.0.0.0',
  rtmp: { port: 1935 },
  http: { port: 8000 },
  auth: { play: false, publish: false }
};

const nms = new NodeMediaServer(nmsConfig);

// 低延迟：为每个新建的 BroadcastServer 重写 postPlay，跳过 GOP 缓存重放
const patchBroadcastsLowLatency = () => {
  for (const [path, broadcast] of NmsContext.broadcasts.entries()) {
    if (broadcast.__lowLatencyPatched__) continue;
    const origPostPlay = broadcast.postPlay;
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
    logger.verbose(`[低延迟] 已禁用 ${path} 的 GOP 缓存重放`);
  }
};
setInterval(patchBroadcastsLowLatency, 200);

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

  logger.verbose('活跃流:', Array.from(activeStreams.keys()));
  io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
});

nms.on('donePublish', (session) => {
  const streamPath = session.streamPath;
  logger.info(`[donePublish] id=${session.id} streamPath=${streamPath}`);

  const streamKey = streamPath.replace(/^\/+|\/+$/g, '');
  activeStreams.delete(streamKey);

  if (selectedOutputStream === streamKey) {
    selectedOutputStream = null;
    io.emit('outputSelected', { streamKey: null });
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
    flac:'audio/flac', m4a:'audio/mp4', ogg:'audio/ogg' };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

// 注册本地文件为虚拟流
app.post('/api/local/add', (req, res) => {
  const { filePath, fileName } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  const ext = filePath.split('.').pop() || '';
  const fileType = ext.match(/^(mp3|aac|wav|flac|m4a|ogg)$/i) ? 'audio' : 'video';
  const key = 'local/' + fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  localFiles.set(key, {
    streamKey: key, filePath, fileName, fileType,
    startTime: new Date(), status: 'online', type: 'local',
    // 播放设置默认值
    loop: false,
    autoplay: true,
    playbackRate: 1.0,
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
  const allowed = ['loop', 'autoplay', 'playbackRate'];
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
  const { filePath, fileName } = item;
  const ext = filePath.split('.').pop() || '';
  const mime = mimeFromExt(ext);
  let stat;
  try { stat = require('fs').statSync(filePath); } catch { return res.status(404).json({ error: 'file not found' }); }
  const total = stat.size;
  const range = req.headers.range;
  if (range) {
    const [, startStr, endStr] = /bytes=(\d+)-(\d*)/.exec(range) || [];
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : total - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mime,
    });
    require('fs').createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    require('fs').createReadStream(filePath).pipe(res);
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
