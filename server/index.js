const NodeMediaServer = require('node-media-server');
const NmsContext = require('node-media-server/src/core/context');
const express = require('express');
const http = require('http');
const os = require('os');
const dgram = require('dgram');
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

// ─── 本机推流地址选择 ─────────────────────────────────────────────────────────
// 虚拟/VPN 网卡名特征：不作为默认推流地址（VMware/VBox/WSL/Docker 等常占 192.168 段）
const VIRTUAL_IFACE_RE = /vmware|vmnet|virtualbox|vbox|hyper-?v|vethernet|\bwsl\b|docker|tailscale|zerotier|nordlynx|wireguard|openvpn|\btap\d|\btun\d|bridge|veth|pangp|bluetooth|isatap|teredo/i;
// 物理网卡名特征：略优先（Wi-Fi / 以太网）
const PHYSICAL_IFACE_RE = /wi-?fi|wlan|ethernet|以太网|local area connection/i;

function listLanCandidates() {
  const ifaces = os.networkInterfaces();
  const seen = new Set();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue; // APIPA 无 DHCP，不可用
      if (seen.has(info.address)) continue;
      seen.add(info.address);
      out.push({ name, address: info.address, virtual: VIRTUAL_IFACE_RE.test(name) });
    }
  }
  return out;
}

// UDP connect 不发包，仅让系统按路由表选源地址 → 默认出口 IP
function detectDefaultRouteIp(timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ip) => {
      if (settled) return;
      settled = true;
      resolve(ip);
    };
    try {
      const sock = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        try { sock.close(); } catch {}
        finish(null);
      }, timeoutMs);
      sock.on('error', () => {
        clearTimeout(timer);
        try { sock.close(); } catch {}
        finish(null);
      });
      sock.connect(80, '223.5.5.5', () => {
        clearTimeout(timer);
        let ip = null;
        try { ip = sock.address().address; } catch {}
        try { sock.close(); } catch {}
        finish(ip);
      });
    } catch {
      finish(null);
    }
  });
}

function scoreCandidate(c, defaultRouteIp) {
  let s = 0;
  if (c.virtual) s -= 100;
  if (defaultRouteIp && c.address === defaultRouteIp) s += 50;
  if (PHYSICAL_IFACE_RE.test(c.name)) s += 20;
  if (c.address.startsWith('192.168.')) s += 3;
  else if (c.address.startsWith('10.')) s += 2;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) s += 1;
  return s;
}

async function getLanInfo() {
  const candidates = listLanCandidates();
  const defaultRouteIp = await detectDefaultRouteIp();
  candidates.sort((a, b) => scoreCandidate(b, defaultRouteIp) - scoreCandidate(a, defaultRouteIp));
  const lanIp = candidates[0]?.address || '127.0.0.1';
  return {
    lanIp,
    defaultRouteIp,
    candidates: candidates.map(c => ({
      ...c,
      rtmpBase: `rtmp://${c.address}:1935/live`,
    })),
    rtmpBase: `rtmp://${lanIp}:1935/live`,
  };
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
  rtmp: {
    port: 1935,
    chunk_size: 2048,  // 更小 chunk，降低分片延迟（体育赛事低延迟）
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

// 比分条 / 计分叠加（体育赛事转播）
let scoreboardConfig = {
  enabled: false,
  homeName: '主队',
  awayName: '客队',
  homeScore: 0,
  awayScore: 0,
  period: '第1节',
  clock: '',
  showClock: false,
  position: 'top', // top | bottom
  homeColor: '#2563eb',
  awayColor: '#dc2626',
};

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

const FOURCC_HEVC = Buffer.from('hvc1').readUInt32BE(0);
const FOURCC_VP9 = Buffer.from('vp09').readUInt32BE(0);
const FOURCC_AV1 = Buffer.from('av01').readUInt32BE(0);

function getVideoCodecLabel(videoCodec) {
  if (videoCodec == null || videoCodec === '') return 'unknown';
  const raw = String(videoCodec).toLowerCase();
  if (videoCodec === 7 || raw === '7' || raw.includes('h264') || raw.includes('avc')) return 'H.264';
  if (videoCodec === FOURCC_HEVC || raw.includes('h265') || raw.includes('hevc') || raw.includes('hvc1')) return 'H.265/HEVC';
  if (videoCodec === FOURCC_VP9 || raw.includes('vp9') || raw.includes('vp09')) return 'VP9';
  if (videoCodec === FOURCC_AV1 || raw.includes('av1') || raw.includes('av01')) return 'AV1';
  return String(videoCodec);
}

function isBrowserPlayableVideoCodec(videoCodec) {
  const label = getVideoCodecLabel(videoCodec);
  return label === 'unknown' || label === 'H.264';
}

function getStreamDiagnostics(streamPath = '') {
  const normalizedPath = normalizeStreamPath(streamPath);
  const broadcast = NmsContext.broadcasts.get(normalizedPath);
  const publisher = broadcast?.publisher;
  const videoCodec = publisher?.videoCodec ?? null;
  const audioCodec = publisher?.audioCodec ?? null;

  return {
    videoCodec,
    videoCodecLabel: getVideoCodecLabel(videoCodec),
    browserPlayable: isBrowserPlayableVideoCodec(videoCodec),
    videoWidth: publisher?.videoWidth ?? 0,
    videoHeight: publisher?.videoHeight ?? 0,
    videoFramerate: publisher?.videoFramerate ?? 0,
    videoDatarate: publisher?.videoDatarate ?? 0,
    audioCodec,
    audioChannels: publisher?.audioChannels ?? 0,
    audioSamplerate: publisher?.audioSamplerate ?? 0,
  };
}

function emitStreamUpdate() {
  io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
}

function normalizeStreamPath(streamPath = '') {
  const normalized = String(streamPath)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');

  return normalized ? `/${normalized}` : '';
}

function getStreamMeta(streamPath = '') {
  const normalizedPath = normalizeStreamPath(streamPath);
  const streamKey = normalizedPath.replace(/^\/+/, '');

  return {
    streamKey,
    streamPath: normalizedPath,
    flvPath: streamKey ? `/${streamKey}.flv` : '',
  };
}

// RTMP 事件监听
nms.on('prePublish', (session) => {
  logger.verbose(`[prePublish] id=${session.id} streamPath=${session.streamPath}`);
});

nms.on('postPublish', (session) => {
  const rawStreamPath = session.streamPath;
  const { streamKey, streamPath, flvPath } = getStreamMeta(rawStreamPath);
  logger.info(`[postPublish] id=${session.id} streamPath=${rawStreamPath} normalized=${streamPath}`);

  activeStreams.set(streamKey, {
    id: session.id,
    streamKey,
    streamPath,
    flvPath,
    startTime: new Date(),
    status: 'online',
    ...getStreamDiagnostics(streamPath)
  });

  logger.verbose('活跃流:', Array.from(activeStreams.keys()));
  emitStreamUpdate();
});

nms.on('donePublish', (session) => {
  const rawStreamPath = session.streamPath;
  const { streamKey, streamPath } = getStreamMeta(rawStreamPath);
  logger.info(`[donePublish] id=${session.id} streamPath=${rawStreamPath} normalized=${streamPath}`);

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
setInterval(() => {
  let changed = false;
  for (const stream of activeStreams.values()) {
    const diagnostics = getStreamDiagnostics(stream.streamPath);
    const keys = Object.keys(diagnostics);
    if (keys.some((key) => stream[key] !== diagnostics[key])) {
      Object.assign(stream, diagnostics);
      changed = true;
    }
  }
  if (changed) emitStreamUpdate();
}, 1000);

app.get('/api/streams', (req, res) => {
  res.json(Array.from(activeStreams.values()));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeStreams: activeStreams.size });
});

app.get('/api/server-info', async (req, res) => {
  const info = await getLanInfo();
  res.json({
    lanIp: info.lanIp,
    rtmpPort: 1935,
    httpFlvPort: 8000,
    apiPort: 3001,
    rtmpBase: info.rtmpBase,
    candidates: info.candidates,
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

function detectLocalFileType(ext) {
  if (AUDIO_EXT_RE.test(ext)) return 'audio';
  if (IMAGE_EXT_RE.test(ext)) return 'image';
  return 'video';
}

// 注册本地文件为虚拟流
app.post('/api/local/add', (req, res) => {
  const { filePath, fileName } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  const ext = filePath.split('.').pop() || '';
  const fileType = detectLocalFileType(ext);
  const key = 'local/' + fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  localFiles.set(key, {
    streamKey: key, filePath, fileName, fileType,
    startTime: new Date(), status: 'online', type: 'local',
    // 播放设置默认值
    loop: false,
    autoplay: true,
    playbackRate: 1.0,
    // 图片：停留秒数（用于列表顺序切换；0/空 = 常驻）
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

// ─── 比分条 API ────────────────────────────────────────────────────────────────
app.get('/api/scoreboard', (req, res) => {
  res.json(scoreboardConfig);
});

app.post('/api/scoreboard', (req, res) => {
  const patch = req.body || {};
  const next = { ...scoreboardConfig };
  for (const key of Object.keys(scoreboardConfig)) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  // 分数保持非负整数
  next.homeScore = Math.max(0, Math.floor(Number(next.homeScore) || 0));
  next.awayScore = Math.max(0, Math.floor(Number(next.awayScore) || 0));
  scoreboardConfig = next;
  io.emit('scoreboard:update', scoreboardConfig);
  res.json(scoreboardConfig);
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

  // 同步比分条
  socket.emit('scoreboard:update', scoreboardConfig);

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
server.listen(3001, async () => {
  const info = await getLanInfo();
  const lanIp = info.lanIp;
  logger.info('=================================');
  logger.info(`RTMP服务器运行在 rtmp://${lanIp}:1935`);
  logger.info(`HTTP-FLV服务器运行在 http://${lanIp}:8000`);
  logger.info(`API服务器运行在 http://${lanIp}:3001`);
  logger.info('=================================');
  logger.info('推流地址(必须 app/stream 两段式):');
  logger.info(`  rtmp://${lanIp}:1935/live/<设备名>`);
  logger.info(`  例:rtmp://${lanIp}:1935/live/cam1`);
  if (info.candidates.length > 1) {
    logger.info('其他可用内网地址:');
    for (const c of info.candidates.slice(1)) {
      logger.info(`  ${c.rtmpBase}/<设备名>  (${c.name}${c.virtual ? ', 虚拟网卡' : ''})`);
    }
  }
  logger.info(`详细日志: ${verboseLog ? '已开启' : '已关闭'} (可通过 POST /api/log/toggle 切换)`);
});
