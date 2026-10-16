const NodeMediaServer = require('node-media-server');
const NmsContext = require('node-media-server/src/core/context');
const express = require('express');
const http = require('http');
const os = require('os');
const dgram = require('dgram');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const timing = require('./timing');

// ─── 端口（可用环境变量覆盖，便于同机跑隔离测试实例，不占用现场的 3001/1935/8000）───
const PORT = Number(process.env.PORT) || 3001;          // 控制台 / API
const RTMP_PORT = Number(process.env.RTMP_PORT) || 1935; // 推流入口
const FLV_PORT = Number(process.env.FLV_PORT) || 8000;   // HTTP-FLV 播放

// ─── 日志开关 ─────────────────────────────────────────────────────────────────
// 启动时可通过环境变量 VERBOSE_LOG=1 开启；运行时也可通过 API /api/log/toggle 切换
let verboseLog = process.env.VERBOSE_LOG === '1';

const logger = {
  info:    (...args) => console.log(...args),                          // 始终输出
  warn:    (...args) => console.warn('[WARN]', ...args),               // 警告（配置加载失败等）
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
      rtmpBase: `rtmp://${c.address}:${RTMP_PORT}/live`,
    })),
    rtmpBase: `rtmp://${lanIp}:${RTMP_PORT}/live`,
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
    port: RTMP_PORT,
    chunk_size: 2048,  // 更小 chunk，降低分片延迟（体育赛事低延迟）
    gop_cache: false,  // 禁用 GOP 缓存
    ping: 30,
    ping_timeout: 60
  },
  http: { 
    port: FLV_PORT,
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

// ─── 静态页面：计时老师手机录入页 /timer/ · 裁判长监控页 /timer/monitor.html ───
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use('/timer', express.static(path.join(PUBLIC_DIR, 'timer'), {
  index: 'index.html',
  extensions: ['html'],
}));
app.get('/timer', (req, res) => res.redirect('/timer/'));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const activeStreams = new Map();
let selectedOutputStream = null;

// 专业转场预设（TAKE / 数字切源时生效）
let transitionConfig = {
  type: 'cut',        // cut | mix | wipe | dip | slide
  duration: 500,      // ms
  direction: 'left',  // wipe/slide: left | right | up | down
};

const TRANSITION_TYPES = ['cut', 'mix', 'wipe', 'dip', 'slide'];

function emitTransition(from, to) {
  if (!from || from === to) return;
  const t = transitionConfig;
  if (!t || t.type === 'cut') return;
  io.emit('outputTransition', {
    from,
    to,
    type: t.type,
    duration: Math.max(120, Math.min(3000, Number(t.duration) || 500)),
    direction: t.direction || 'left',
    at: Date.now(),
  });
}

// 音频状态：Map<streamKey, { volume, muted }>
const audioState = {};

// 叠加层配置（田径 / 球队两种模式）— 持久化到 data/scoreboard.json
const fsScore = (() => {
  try {
    const pathMod = require('path');
    const fsMod = require('fs');
    const dir = pathMod.join(process.cwd(), 'data');
    if (!fsMod.existsSync(dir)) fsMod.mkdirSync(dir, { recursive: true });
    return { path: pathMod.join(dir, 'scoreboard.json'), fs: fsMod };
  } catch {
    return null;
  }
})();

function defaultAthletes(n = 8) {
  return Array.from({ length: n }, (_, i) => ({
    lane: i + 1, name: '', place: '', result: '',
    // 选手介绍模式用到的扩展字段（与田径成绩共用同一份名册）
    unit: '', bib: '', pb: '', note: '', photo: '',
  }));
}

// 手动计时模块实例（register 后赋值，emitScoreboard 用它同步当前项目）
let timingApi = null;

let scoreboardConfig = {
  enabled: true,
  mode: 'track', // 'track' 田径 | 'team' 球队
  // —— 球队 ——
  homeName: '主队',
  awayName: '客队',
  homeScore: 0,
  awayScore: 0,
  period: '第1节',
  // —— 田径径赛 ——
  eventName: '男子100米',
  eventKind: 'sprint', // sprint | middle | long | relay | field
  category: '男子',
  round: '预赛',
  heat: '第1组',
  wind: '',            // 如 +0.8 / -1.2
  mr: '',              // 赛会纪录 10.23
  sb: '',              // 赛季最佳
  athletes: defaultAthletes(8),
  showPlaces: true,
  showResults: true,
  // —— 田赛 ——
  attempt: 1,
  attemptsTotal: 6,
  bestMark: '',
  // —— 成绩榜（决赛后前三）——
  showPodium: false,
  // —— 选手介绍 ——
  introTitle: '选手介绍',
  introStyle: 'card',   // 'card' 单人卡 | 'lower' 底部字幕条 | 'roster' 名册
  introIndex: 0,        // 当前第几位（0 基，指向 athletes 顺序）
  introVisible: true,   // 上屏开关（与 enabled 总开关叠加生效）
  introShowPhoto: true,
  introShowPb: true,
  introShowNote: true,
  introPerScreen: 3,    // 名册模式每屏人数
  introHold: 0,         // 自动隐藏秒数，0 = 常显
  introAuto: false,     // 自动轮播
  introAutoMs: 8000,    // 轮播间隔（毫秒）
  // —— 公共 ——
  clock: '',
  showClock: true,
  clockRunning: false,
  clockStartAt: null,
  clockOffsetMs: 0,
  laps: [],            // 记圈读数
  position: 'bottom',
  homeColor: '#2563eb',
  awayColor: '#dc2626',
  // —— 节目单：整场预载名册，现场一键切项 ——
  program: [],         // [{ id, label, time, eventName, category, round, heat, eventKind, athletes }]
  programIndex: 0,     // 当前应用到第几节
};

if (fsScore?.fs.existsSync(fsScore.path)) {
  try {
    const raw = JSON.parse(fsScore.fs.readFileSync(fsScore.path, 'utf8'));
    scoreboardConfig = { ...scoreboardConfig, ...raw, clockRunning: false, clockStartAt: null };
    logger.info('[田径] 已加载 scoreboard.json');
  } catch (e) {
    logger.warn('[田径] scoreboard.json 加载失败', e.message);
  }
}

function persistScoreboard() {
  if (!fsScore) return;
  try {
    const toSave = {
      ...scoreboardConfig,
      clockRunning: false,
      clockStartAt: null,
      clockOffsetMs: scoreboardConfig.clockRunning
        ? currentClockMs(scoreboardConfig)
        : scoreboardConfig.clockOffsetMs,
    };
    fsScore.fs.writeFileSync(fsScore.path, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (e) {
    logger.verbose('[田径] 持久化失败', e.message);
  }
}

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

// ─── 基础调色（Color Grading） ────────────────────────────────────────────────
// 全局一套参数 + 单机位覆盖；持久化到 data/color.json
// 亮度/对比度/饱和度/色相 → 前端 CSS filter；色温/色调/暗角 → 叠加层
const GRADE_RANGES = {
  brightness: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100],
  hue: [-180, 180],
  temperature: [-100, 100],
  tint: [-100, 100],
  vignette: [0, 100],
};
const GRADE_KEYS = Object.keys(GRADE_RANGES);

function defaultColorGrade() {
  return {
    enabled: false,
    preset: 'neutral',
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
    temperature: 0,
    tint: 0,
    vignette: 0,
  };
}

function clampGradeValue(key, value) {
  const [min, max] = GRADE_RANGES[key] || [-100, 100];
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, Math.round(n * 100) / 100));
}

// 只接受已知字段，其余忽略；用于 POST /api/color
function normalizeGradePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (patch.enabled !== undefined) out.enabled = !!patch.enabled;
  if (typeof patch.preset === 'string' && patch.preset) out.preset = patch.preset;
  for (const key of GRADE_KEYS) {
    if (patch[key] !== undefined) out[key] = clampGradeValue(key, patch[key]);
  }
  return out;
}

let colorGradeConfig = { ...defaultColorGrade(), sources: {} };

const fsColor = (() => {
  try {
    const pathMod = require('path');
    const fsMod = require('fs');
    const dir = pathMod.join(process.cwd(), 'data');
    if (!fsMod.existsSync(dir)) fsMod.mkdirSync(dir, { recursive: true });
    return { path: pathMod.join(dir, 'color.json'), fs: fsMod };
  } catch {
    return null;
  }
})();

if (fsColor?.fs.existsSync(fsColor.path)) {
  try {
    const raw = JSON.parse(fsColor.fs.readFileSync(fsColor.path, 'utf8'));
    const sources = {};
    for (const [key, val] of Object.entries(raw.sources || {})) {
      const patch = normalizeGradePatch(val);
      if (Object.keys(patch).length) sources[key] = patch;
    }
    colorGradeConfig = { ...defaultColorGrade(), ...normalizeGradePatch(raw), sources };
    logger.info('[调色] 已加载 color.json');
  } catch (e) {
    logger.warn('[调色] color.json 加载失败', e.message);
  }
}

function persistColor() {
  if (!fsColor) return;
  try {
    fsColor.fs.writeFileSync(fsColor.path, JSON.stringify(colorGradeConfig, null, 2), 'utf8');
  } catch (e) {
    logger.verbose('[调色] 持久化失败', e.message);
  }
}

// 拖滑块会上百次触发；写盘节流，但广播保持即时
let colorPersistTimer = null;
function schedulePersistColor() {
  if (colorPersistTimer) clearTimeout(colorPersistTimer);
  colorPersistTimer = setTimeout(() => {
    colorPersistTimer = null;
    persistColor();
  }, 400);
}

function emitColor() {
  schedulePersistColor();
  io.emit('color:update', colorGradeConfig);
}

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
    rtmpPort: RTMP_PORT,
    httpFlvPort: FLV_PORT,
    apiPort: PORT,
    rtmpBase: info.rtmpBase,
    candidates: info.candidates,
  });
});

app.get('/api/output', (req, res) => {
  res.json({ selectedStream: selectedOutputStream });
});

// 转场预设
app.get('/api/transition', (req, res) => {
  res.json({ ...transitionConfig, types: TRANSITION_TYPES });
});

app.post('/api/transition', (req, res) => {
  const patch = req.body || {};
  if (patch.type && TRANSITION_TYPES.includes(patch.type)) {
    transitionConfig.type = patch.type;
  }
  if (patch.duration !== undefined) {
    transitionConfig.duration = Math.max(120, Math.min(3000, Number(patch.duration) || 500));
  }
  if (patch.direction && ['left', 'right', 'up', 'down'].includes(patch.direction)) {
    transitionConfig.direction = patch.direction;
  }
  io.emit('transition:update', transitionConfig);
  res.json(transitionConfig);
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
    const from = selectedOutputStream;
    selectedOutputStream = streamKey;
    emitTransition(from, streamKey);
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
  // 显式带 CORS：本地素材用 crossOrigin="anonymous" 加载，画布才不算跨域污染（录制带调色需要）
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
  };
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
      ...CORS_HEADERS,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mime,
    });
    require('fs').createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Length': total,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
    });
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

// ─── 基础调色 API ─────────────────────────────────────────────────────────────
app.get('/api/color', (req, res) => {
  res.json(colorGradeConfig);
});

// body: { target?: 'global' | streamKey, patch?: {...}, reset?: true }
app.post('/api/color', (req, res) => {
  const body = req.body || {};
  const target = (typeof body.target === 'string' && body.target) ? body.target : 'global';

  if (target === 'global') {
    if (body.reset) {
      colorGradeConfig = { ...defaultColorGrade(), sources: colorGradeConfig.sources };
    } else {
      colorGradeConfig = { ...colorGradeConfig, ...normalizeGradePatch(body.patch) };
    }
  } else if (body.reset) {
    // 清除该机位覆盖 → 回到全局参数
    const sources = { ...colorGradeConfig.sources };
    delete sources[target];
    colorGradeConfig = { ...colorGradeConfig, sources };
  } else {
    const patch = normalizeGradePatch(body.patch);
    if (Object.keys(patch).length) {
      colorGradeConfig = {
        ...colorGradeConfig,
        sources: {
          ...colorGradeConfig.sources,
          [target]: { ...(colorGradeConfig.sources[target] || {}), ...patch },
        },
      };
    }
  }

  emitColor();
  res.json(colorGradeConfig);
});

// ─── 叠加层 / 比分条 API（田径优先） ─────────────────────────────────────────
const TRACK_TEMPLATES = [
  { id: '100m', label: '100米', eventName: '男子100米', eventKind: 'sprint', category: '男子', lanes: 8, useClock: true },
  { id: '200m', label: '200米', eventName: '男子200米', eventKind: 'sprint', category: '男子', lanes: 8, useClock: true },
  { id: '400m', label: '400米', eventName: '男子400米', eventKind: 'sprint', category: '男子', lanes: 8, useClock: true },
  { id: '800m', label: '800米', eventName: '男子800米', eventKind: 'middle', category: '男子', lanes: 8, useClock: true },
  { id: '1500m', label: '1500米', eventName: '男子1500米', eventKind: 'middle', category: '男子', lanes: 0, useClock: true },
  { id: '5000m', label: '5000米', eventName: '男子5000米', eventKind: 'long', category: '男子', lanes: 0, useClock: true },
  { id: '10000m', label: '10000米', eventName: '男子10000米', eventKind: 'long', category: '男子', lanes: 0, useClock: true },
  { id: '4x100', label: '4×100接力', eventName: '男子4×100米接力', eventKind: 'relay', category: '男子', lanes: 8, useClock: true },
  { id: '4x400', label: '4×400接力', eventName: '男子4×400米接力', eventKind: 'relay', category: '男子', lanes: 8, useClock: true },
  { id: '110h', label: '110米栏', eventName: '男子110米栏', eventKind: 'sprint', category: '男子', lanes: 8, useClock: true },
  { id: 'lj', label: '跳远', eventName: '男子跳远', eventKind: 'field', category: '男子', lanes: 0, useClock: false },
  { id: 'tj', label: '三级跳远', eventName: '男子三级跳远', eventKind: 'field', category: '男子', lanes: 0, useClock: false },
  { id: 'hj', label: '跳高', eventName: '男子跳高', eventKind: 'field', category: '男子', lanes: 0, useClock: false },
  { id: 'pv', label: '撑竿跳高', eventName: '男子撑竿跳高', eventKind: 'field', category: '男子', lanes: 0, useClock: false },
  { id: 'sp', label: '铅球', eventName: '男子铅球', eventKind: 'field', category: '男子', lanes: 0, useClock: false },
  { id: 'dt', label: '铁饼', eventName: '男子铁饼', eventKind: 'field', category: '男子', lanes: 0, useClock: false },
  { id: 'ht', label: '链球', eventName: '男子链球', eventKind: 'field', category: '男子', lanes: 0, useClock: false },
  { id: 'jt', label: '标枪', eventName: '男子标枪', eventKind: 'field', category: '男子', lanes: 0, useClock: false },
];

function formatTrackClock(ms) {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  if (m > 0) {
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
  return `${s}.${String(cs).padStart(2, '0')}`;
}

function currentClockMs(cfg = scoreboardConfig) {
  const base = Number(cfg.clockOffsetMs) || 0;
  if (cfg.clockRunning && cfg.clockStartAt) {
    return base + (Date.now() - Number(cfg.clockStartAt));
  }
  return base;
}

function applyClockAction(cfg, action) {
  if (action === 'start') {
    if (!cfg.clockRunning) {
      cfg.clockRunning = true;
      cfg.clockStartAt = Date.now();
      cfg.clock = formatTrackClock(currentClockMs(cfg));
    }
  } else if (action === 'stop' || action === 'pause') {
    if (cfg.clockRunning) {
      cfg.clockOffsetMs = currentClockMs(cfg);
      cfg.clockRunning = false;
      cfg.clockStartAt = null;
      cfg.clock = formatTrackClock(cfg.clockOffsetMs);
    }
  } else if (action === 'reset') {
    cfg.clockRunning = false;
    cfg.clockStartAt = null;
    cfg.clockOffsetMs = 0;
    cfg.clock = formatTrackClock(0);
    cfg.laps = [];
  } else if (action === 'lap' || action === 'split') {
    const reading = formatTrackClock(currentClockMs(cfg));
    cfg.clock = reading;
    cfg.laps = [...(cfg.laps || []), reading].slice(-8);
  } else if (action === 'toggle') {
    if (cfg.clockRunning) applyClockAction(cfg, 'stop');
    else applyClockAction(cfg, 'start');
  }
  return cfg;
}

// ─── 选手介绍：上一位 / 下一位 / 定位 / 上屏 ─────────────────────────────────
// 名册口径：有姓名或照片的道次才算「一位选手」，空道次自动跳过
// （前端 AthleteIntro / 侧栏面板 / 设置面板都用同一口径，索引才能对齐）
function introRoster(cfg) {
  return (cfg.athletes || []).filter(a => String(a?.name || '').trim() || a?.photo);
}

function clampIntroIndex(cfg) {
  const n = introRoster(cfg).length;
  if (n <= 0) return 0;
  const i = Math.floor(Number(cfg.introIndex) || 0);
  return Math.max(0, Math.min(n - 1, i));
}

function applyIntroAction(cfg, action, opt = {}) {
  const n = introRoster(cfg).length;
  const step = Math.max(1, Math.floor(Number(opt.introStep) || 1));
  const cur = clampIntroIndex(cfg);
  switch (action) {
    case 'next':  cfg.introIndex = n ? (cur + step) % n : 0; break;
    case 'prev':  cfg.introIndex = n ? ((cur - step) % n + n) % n : 0; break;
    case 'first': cfg.introIndex = 0; break;
    case 'last':  cfg.introIndex = Math.max(0, n - 1); break;
    case 'goto':  cfg.introIndex = Math.floor(Number(opt.introIndex) || 0); break;
    case 'show':  cfg.introVisible = true; cfg.mode = 'intro'; cfg.enabled = true; break;
    case 'hide':  cfg.introVisible = false; break;
    case 'toggle': {
      const show = !cfg.introVisible;
      cfg.introVisible = show;
      if (show) { cfg.mode = 'intro'; cfg.enabled = true; }
      break;
    }
    default: break;
  }
  cfg.introIndex = clampIntroIndex(cfg);
  return cfg;
}

function emitScoreboard() {
  // 项目/组次有变化时，手动计时模块自动换轮（旧数据入历史）
  try { timingApi?.syncEvent?.(scoreboardConfig); } catch (e) { logger.verbose('[计时] 换轮同步失败', e.message); }
  const payload = {
    ...scoreboardConfig,
    clock: scoreboardConfig.clockRunning
      ? formatTrackClock(currentClockMs())
      : scoreboardConfig.clock,
    clockMs: currentClockMs(),
  };
  io.emit('scoreboard:update', payload);
  persistScoreboard();
  return payload;
}

// ─── 节目单（整场预载名册，现场一键切项，零手打） ─────────────────────────────
// 现场节奏：粘一次整天节目单 → 之后只按「下一项」，项目名/轮次/组次/名册一次到位。
// 切换前会把当前道次名册快照回写当前节，现场补录的单位/照片不会丢。

/** 名册字段归一（与 POST /api/scoreboard 同一口径） */
function normAthletes(list) {
  return (Array.isArray(list) ? list : []).map((a, i) => ({
    lane: Number(a?.lane) || i + 1,
    name: String(a?.name ?? ''),
    place: String(a?.place ?? ''),
    result: String(a?.result ?? ''),
    unit: String(a?.unit ?? ''),
    bib: String(a?.bib ?? ''),
    pb: String(a?.pb ?? ''),
    note: String(a?.note ?? ''),
    photo: String(a?.photo ?? ''),
  }));
}

/**
 * 节目单名册按道次补齐空行（道次 = 行号）
 * 这样即便节目单是手机页面 / 脚本直接 POST 进来的（只写「道次 3」而没写空道），上屏道次也对得上。
 * 已按道次排好的名册（设置里粘贴生成的那种）走一遍结果是原样。
 */
function padProgramAthletes(list) {
  const src = Array.isArray(list) ? list : [];
  if (!src.length) return [];
  const maxLane = src.reduce((m, a) => Math.max(m, Number(a?.lane) || 0), 0);
  const total = Math.max(src.length, Math.min(24, maxLane));
  const rows = Array.from({ length: total }, (_, i) => ({
    lane: i + 1, name: '', place: '', result: '', unit: '', bib: '', pb: '', note: '', photo: '',
  }));
  const freeFrom = (start) => {
    for (let i = start; i < total; i += 1) if (!rows[i].name && !rows[i].photo) return i;
    for (let i = 0; i < total; i += 1) if (!rows[i].name && !rows[i].photo) return i;
    return -1;
  };
  src.forEach((a, i) => {
    const want = Math.max(1, Math.min(total, Number(a?.lane) || i + 1));
    let idx = want - 1;
    if (rows[idx].name || rows[idx].photo) idx = freeFrom(idx + 1);
    if (idx >= 0) rows[idx] = { ...a, lane: idx + 1 };
  });
  return rows;
}

function normProgram(list) {
  return (Array.isArray(list) ? list : []).slice(0, 200).map((e, i) => {
    const athletes = padProgramAthletes(normAthletes(e?.athletes));
    const eventName = String(e?.eventName ?? '').trim() || '未命名项目';
    const category = String(e?.category ?? '').trim()
      || (/女子/.test(eventName) ? '女子' : '男子');
    const round = String(e?.round ?? '').trim() || '预赛';
    const heat = String(e?.heat ?? '').trim();
    return {
      id: String(e?.id ?? `p${i + 1}`),
      time: String(e?.time ?? ''),
      label: String(e?.label ?? '').trim() || [eventName, round, heat].filter(Boolean).join(' '),
      eventName,
      category,
      round,
      heat,
      eventKind: String(e?.eventKind ?? '') || 'sprint',
      athletes,
      count: athletes.filter(a => a.name.trim() || a.photo).length,
    };
  });
}

/**
 * 把当前叠加层的项目信息 + 名册写回节目单第 idx 节
 * （idx 缺省用 cfg.programIndex；现场补录的单位/照片/改名靠它保住）
 */
function snapshotProgramEntry(cfg, idx) {
  const i = idx === undefined
    ? Math.floor(Number(cfg.programIndex) || 0)
    : Math.floor(Number(idx) || 0);
  const program = cfg.program || [];
  if (i < 0 || i >= program.length) return;
  program[i] = {
    ...program[i],
    eventName: cfg.eventName,
    category: cfg.category,
    round: cfg.round,
    heat: cfg.heat,
    eventKind: cfg.eventKind,
    athletes: normAthletes(cfg.athletes),
    count: introRoster(cfg).length,
  };
}

/**
 * 把第 idx 节节目单应用到当前叠加层
 * @param {object} cfg
 * @param {number} idx   目标节下标
 * @param {{ resetClock?: boolean, snapshot?: boolean, from?: number }} [opt]
 *        from = 当前所在节（缺省 cfg.programIndex）。必须传入「切换前」的下标：
 *        POST 处理时 programIndex 已被请求体覆盖，直接用会把当前名册写进目标节。
 */
function applyProgramEntry(cfg, idx, opt = {}) {
  if (!Array.isArray(cfg.program) || !cfg.program.length) return cfg;
  const i = Math.max(0, Math.min(cfg.program.length - 1, Math.floor(Number(idx) || 0)));

  // 离开当前节之前先把现场改动快照回该节；整表替换（opt.snapshot=false）时旧节目单已被换掉，不做快照
  if (opt.snapshot !== false) {
    snapshotProgramEntry(cfg, opt.from === undefined ? cfg.programIndex : opt.from);
  }
  // 快照会改写旧节，所以取目标节要放在快照之后
  const entry = cfg.program[i];
  if (!entry) return cfg;

  cfg.programIndex = i;
  if (cfg.mode === 'team') cfg.mode = 'track';
  cfg.eventName = entry.eventName;
  cfg.category = entry.category;
  cfg.round = entry.round;
  if (entry.heat) cfg.heat = entry.heat;
  cfg.eventKind = entry.eventKind || cfg.eventKind;
  cfg.wind = '';
  // 名册就位：姓名/单位/号码/PB 带上，名次成绩清空（新一节比赛）
  cfg.athletes = (entry.athletes?.length ? entry.athletes : defaultAthletes(8)).map((a, k) => ({
    lane: Number(a.lane) || k + 1,
    name: a.name || '', unit: a.unit || '', bib: a.bib || '',
    pb: a.pb || '', note: a.note || '', photo: a.photo || '',
    place: '', result: '',
  }));
  cfg.introIndex = 0;
  cfg.showPodium = false;
  if (opt.resetClock !== false) applyClockAction(cfg, 'reset');
  return cfg;
}

function getProgramIndex(cfg) {
  const n = (cfg.program || []).length;
  if (!n) return -1;
  return Math.max(0, Math.min(n - 1, Math.floor(Number(cfg.programIndex) || 0)));
}

app.get('/api/scoreboard/templates', (req, res) => {
  res.json(TRACK_TEMPLATES);
});

// 选手介绍：轮播 / 自动隐藏由服务端统一推进，保证 HDMI、PROGRAM 监看与录制同一帧
let introShownAt = Date.now();
let introPrevVisible = !!scoreboardConfig.introVisible;
setInterval(() => {
  const cfg = scoreboardConfig;
  const onAir = cfg.enabled && cfg.mode === 'intro' && cfg.introVisible;
  if (cfg.introVisible && !introPrevVisible) introShownAt = Date.now();
  introPrevVisible = !!cfg.introVisible;
  if (!onAir) return;

  const holdMs = Math.max(0, Number(cfg.introHold) || 0) * 1000;
  if (holdMs > 0 && Date.now() - introShownAt >= holdMs) {
    scoreboardConfig = applyIntroAction({ ...cfg }, 'hide');
    emitScoreboard();
    return;
  }

  const n = (cfg.athletes || []).length;
  if (!cfg.introAuto || n < 2) return;
  const gap = Math.max(2000, Number(cfg.introAutoMs) || 8000);
  if (Date.now() - introShownAt < gap) return;
  introShownAt = Date.now();
  scoreboardConfig = applyIntroAction({ ...cfg }, 'next');
  emitScoreboard();
}, 500);

app.get('/api/scoreboard', (req, res) => {
  res.json({
    ...scoreboardConfig,
    clockMs: currentClockMs(),
    clock: scoreboardConfig.clockRunning
      ? formatTrackClock(currentClockMs())
      : scoreboardConfig.clock,
  });
});

app.post('/api/scoreboard', (req, res) => {
  const patch = req.body || {};
  const next = { ...scoreboardConfig };
  // 注意：下面的通用拷贝会用请求体里的 programIndex 覆盖 next.programIndex，
  // 所以「当前在第几节」必须在拷贝之前先记下来，否则快照会写进目标节。
  const prevProgramIndex = getProgramIndex(scoreboardConfig);
  const keys = new Set([
    ...Object.keys(scoreboardConfig),
    'mode', 'eventName', 'eventKind', 'category', 'round', 'heat', 'wind', 'mr', 'sb',
    'athletes', 'showPlaces', 'showResults', 'showPodium',
    'attempt', 'attemptsTotal', 'bestMark',
    'clockAction', 'finishOrder', 'templateId', 'laneCount',
    'clearPlaces', 'clockAction',
    'introAction', 'introStep', 'introIndex',
    'athletePatch', 'athleteIndex',
    // 节目单（整场预载名册）
    'program', 'programIndex', 'programAction', 'programSnapshot',
  ]);
  for (const key of keys) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  next.homeScore = Math.max(0, Math.floor(Number(next.homeScore) || 0));
  next.awayScore = Math.max(0, Math.floor(Number(next.awayScore) || 0));
  next.attempt = Math.max(1, Math.floor(Number(next.attempt) || 1));
  next.attemptsTotal = Math.max(3, Math.floor(Number(next.attemptsTotal) || 6));

  if (Array.isArray(next.athletes)) {
    next.athletes = normAthletes(next.athletes);
  }

  // 节目单：整表替换 / 切项 / 单节快照（只在真的动节目单时归一，避免高频 patch 反复重建）
  const touchesProgram = patch.program !== undefined
    || patch.programAction !== undefined
    || patch.programSnapshot !== undefined;
  if (touchesProgram) {
    const program = Array.isArray(next.program) ? next.program : [];
    const cur = prevProgramIndex;

    if (patch.program !== undefined) {
      next.program = normProgram(patch.program);
      next.programIndex = Math.max(0, Math.min(Math.max(0, next.program.length - 1),
        Math.floor(Number(patch.programIndex ?? 0) || 0)));
      // 载入节目单后直接落到某一节，省掉现场再点一次
      // （整表替换时不做快照：旧节目单已被换掉，写回当前比赛信息会污染新载入的那一节）
      if (next.program.length && patch.applyFirst !== false) {
        applyProgramEntry(next, next.programIndex, { resetClock: false, snapshot: false });
      }
    } else if (patch.programAction === 'next') {
      applyProgramEntry(next, (cur < 0 ? 0 : cur + 1) % Math.max(1, program.length), { from: cur });
    } else if (patch.programAction === 'prev') {
      applyProgramEntry(next, (cur <= 0 ? Math.max(1, program.length) : cur) - 1, { from: cur });
    } else if (patch.programAction === 'apply' || patch.programAction === 'goto') {
      applyProgramEntry(next, patch.programIndex, { from: cur });
    } else if (patch.programSnapshot) {
      snapshotProgramEntry(next, cur);
    }

    next.program = normProgram(next.program);
    next.programIndex = Math.max(0, Math.min(Math.max(0, next.program.length - 1),
      Math.floor(Number(next.programIndex) || 0)));
    delete next.programAction;
    delete next.programSnapshot;
  }

  // 单名选手增量更新：现场只改一格时不必重传整份名册（照片很大）
  if (patch.athletePatch && typeof patch.athletePatch === 'object') {
    const p = patch.athletePatch;
    const list = next.athletes || [];
    const hasIndex = p.i !== undefined && p.i !== null && Number.isFinite(Number(p.i));
    const idx = hasIndex
      ? Number(p.i)
      : list.findIndex(a => Number(a.lane) === Number(p.lane));
    if (idx >= 0 && idx < list.length) {
      const fields = ['lane', 'name', 'place', 'result', 'unit', 'bib', 'pb', 'note', 'photo'];
      const merged = { ...list[idx] };
      for (const k of fields) {
        if (p[k] !== undefined) merged[k] = String(p[k] ?? '');
      }
      merged.lane = Number(merged.lane) || idx + 1;
      next.athletes = list.map((a, i) => (i === idx ? merged : a));
    }
    delete next.athletePatch;
    delete next.athleteIndex;
  }

  // 选手介绍：数值收敛
  next.introPerScreen = Math.max(1, Math.min(8, Math.floor(Number(next.introPerScreen) || 3)));
  next.introHold = Math.max(0, Math.min(600, Math.floor(Number(next.introHold) || 0)));
  next.introAutoMs = Math.max(2000, Math.min(120000, Math.floor(Number(next.introAutoMs) || 8000)));
  if (next.introStyle === undefined || next.introStyle === null) next.introStyle = 'card';
  next.introVisible = next.introVisible !== false;

  // 赛事模板：一键换项目并重置跑表/道次
  if (patch.templateId) {
    const tpl = TRACK_TEMPLATES.find(t => t.id === patch.templateId);
    if (tpl) {
      next.mode = 'track';
      next.eventName = patch.eventName || tpl.eventName;
      next.eventKind = tpl.eventKind;
      if (patch.category !== undefined) next.category = patch.category;
      else if (tpl.category) next.category = tpl.category;
      if (patch.round !== undefined) next.round = patch.round;
      next.wind = patch.wind !== undefined ? patch.wind : '';
      next.laps = [];
      applyClockAction(next, 'reset');
      if (tpl.lanes > 0) {
        next.athletes = defaultAthletes(tpl.lanes);
      } else {
        // 长距离/田赛：保留姓名列但清空名次成绩
        next.athletes = (next.athletes || defaultAthletes(8)).map((a, i) => ({
          lane: i + 1, name: a.name || '', place: '', result: '', unit: a.unit || '',
          bib: a.bib || '', pb: a.pb || '', note: a.note || '', photo: a.photo || '',
        }));
      }
      next.showPlaces = true;
      next.showResults = tpl.eventKind !== 'field';
      next.showPodium = false;
      if (tpl.eventKind === 'field') {
        next.attempt = 1;
        next.bestMark = '';
      }
    }
  }

  // 快速录入名次：finishOrder = [4,5,3,1,...] 表示道次先后
  if (Array.isArray(patch.finishOrder)) {
    const order = patch.finishOrder.map(n => Number(n)).filter(n => n > 0);
    const byLane = new Map((next.athletes || []).map(a => [Number(a.lane), a]));
    // 清空旧名次
    next.athletes = (next.athletes || []).map(a => ({ ...a, place: '', result: a.result || '' }));
    order.forEach((lane, idx) => {
      const a = byLane.get(lane);
      if (a) {
        const i = next.athletes.findIndex(x => Number(x.lane) === lane);
        if (i >= 0) next.athletes[i] = {
          ...next.athletes[i],
          place: String(idx + 1),
          result: patch.resultsByLane?.[String(lane)] || next.athletes[i].result || '',
        };
      }
    });
    next.showPlaces = true;
    delete next.finishOrder;
    delete next.resultsByLane;
  }

  if (patch.clearPlaces) {
    next.athletes = (next.athletes || []).map(a => ({ ...a, place: '' }));
    next.showPodium = false;
    delete next.clearPlaces;
  }

  if (patch.clockAction) applyClockAction(next, patch.clockAction);
  delete next.clockAction;
  delete next.templateId;
  delete next.laneCount;

  // 选手介绍：上一位 / 下一位 / 定位 / 上屏（上屏同时把模式切到「选手介绍」）
  if (patch.introAction) applyIntroAction(next, patch.introAction, patch);
  next.introIndex = clampIntroIndex(next);
  delete next.introAction;
  delete next.introStep;

  next.clockMs = currentClockMs(next);
  if (!next.clockRunning) next.clock = next.clock || formatTrackClock(next.clockMs);
  scoreboardConfig = next;
  emitScoreboard();
  res.json(scoreboardConfig);
});

// ─── 选手介绍：轻量控制接口（现场用手机 / 平板 / 快捷键驱动） ────────────────
app.get('/api/intro', (req, res) => {
  const list = introRoster(scoreboardConfig);
  const index = clampIntroIndex(scoreboardConfig);
  res.json({
    mode: scoreboardConfig.mode,
    enabled: scoreboardConfig.enabled,
    visible: scoreboardConfig.introVisible !== false,
    style: scoreboardConfig.introStyle,
    index,
    total: list.length,
    auto: !!scoreboardConfig.introAuto,
    autoMs: scoreboardConfig.introAutoMs,
    hold: scoreboardConfig.introHold,
    current: list[index] || null,
    roster: list.map((a, i) => ({ index: i, lane: a.lane, name: a.name, unit: a.unit, bib: a.bib, pb: a.pb })),
  });
});

app.post('/api/intro', (req, res) => {
  const body = req.body || {};
  const action = body.action || body.introAction;
  const next = { ...scoreboardConfig };
  for (const key of ['introStyle', 'introTitle', 'introAuto', 'introAutoMs', 'introHold',
    'introPerScreen', 'introShowPhoto', 'introShowPb', 'introShowNote', 'introVisible']) {
    if (body[key] !== undefined) next[key] = body[key];
  }
  if (action) applyIntroAction(next, action, { introIndex: body.index ?? body.introIndex, introStep: body.step });
  next.introIndex = clampIntroIndex(next);
  next.introPerScreen = Math.max(1, Math.min(8, Math.floor(Number(next.introPerScreen) || 3)));
  next.introHold = Math.max(0, Math.min(600, Math.floor(Number(next.introHold) || 0)));
  next.introAutoMs = Math.max(2000, Math.min(120000, Math.floor(Number(next.introAutoMs) || 8000)));
  scoreboardConfig = next;
  const payload = emitScoreboard();
  res.json({
    ok: true,
    index: payload.introIndex,
    total: introRoster(payload).length,
    visible: payload.introVisible !== false,
    mode: payload.mode,
  });
});

// ─── 手动计时录入：多位老师分头写成绩 → 去极值平均 → 回传叠加层 ────────────────
/**
 * 把计时模块合成出的成绩与名次写回叠加层配置，并即时推送到导播台 / HDMI 输出。
 * @param {{resultsByLane:Record<string,string>, placesByLane:Record<string,number>, meta?:object, by?:string}} payload
 */
function applyTimingToScoreboard({ resultsByLane = {}, placesByLane = {}, meta = null, by = '主裁判' } = {}) {
  const keyed = (obj, lane) => Object.prototype.hasOwnProperty.call(obj || {}, String(lane));
  const next = { ...scoreboardConfig };
  next.athletes = (next.athletes || []).map((a, i) => {
    const lane = Number(a.lane) || i + 1;
    const out = { ...a };
    if (keyed(resultsByLane, lane)) out.result = String(resultsByLane[lane]);
    if (keyed(placesByLane, lane)) out.place = String(placesByLane[lane]);
    return out;
  });

  if (meta) {
    if (meta.eventName) next.eventName = meta.eventName;
    if (meta.category) next.category = meta.category;
    if (meta.round) next.round = meta.round;
    if (meta.heat) next.heat = meta.heat;
  }
  if (Object.keys(resultsByLane).length) {
    next.mode = 'track';
    next.enabled = true;
    next.showResults = true;
    next.showPlaces = true;
  }

  scoreboardConfig = next;
  const line = Object.entries(resultsByLane).map(([l, r]) => `${l}道 ${r}`).join('  ');
  logger.info(`[计时] 成绩已回传（${by}）：${line || '无成绩'}`);
  const payload = emitScoreboard();
  return { ...payload, appliedLanes: Object.keys(resultsByLane) };
}

timingApi = timing.register({
  app,
  io,
  logger,
  applyResults: applyTimingToScoreboard,
  getScoreboard: () => scoreboardConfig,
  getLaneName: (lane) => (scoreboardConfig.athletes || []).find(a => Number(a.lane) === Number(lane))?.name || '',
});
// 启动时与当前项目对齐（换过项目则自动开新一轮）
timingApi.syncEvent(scoreboardConfig);

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

  // 同步调色参数（全局 + 机位覆盖）
  socket.emit('color:update', colorGradeConfig);

  // 同步比分条
  socket.emit('scoreboard:update', scoreboardConfig);

  // 同步转场预设
  socket.emit('transition:update', transitionConfig);

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

// 端口被占用时给一句人话，别让打包版双击后静默退出
// （打包后本进程就是 Electron 主进程，控制台看不到报错）
function reportPortConflict(err) {
  const port = Number(err?.port) || PORT;
  const msg = `${port} 端口已被占用：请先退出正在运行的旧实例`
    + `（任务管理器结束 “RTMP Camera Switcher”），或换个端口重启（PORT=${port + 1}）。`;
  logger.warn(`[端口] ${msg}`);
  console.error(`[端口] ${msg}`);
  try {
    const electron = require('electron');
    if (electron && typeof electron.dialog?.showErrorBox === 'function') {
      electron.dialog.showErrorBox('启动失败：端口被占用', msg);
    }
  } catch { /* 纯 node 运行时没有 electron，日志已经够了 */ }
}

server.on('error', (err) => {
  reportPortConflict(err);
  if (err?.code === 'EADDRINUSE') process.exit(1);
});

server.listen(PORT, async () => {
  const info = await getLanInfo();
  const lanIp = info.lanIp;
  logger.info('=================================');
  logger.info(`RTMP服务器运行在 rtmp://${lanIp}:${RTMP_PORT}`);
  logger.info(`HTTP-FLV服务器运行在 http://${lanIp}:${FLV_PORT}`);
  logger.info(`API服务器运行在 http://${lanIp}:${PORT}`);
  logger.info('=================================');
  logger.info('推流地址(必须 app/stream 两段式):');
  logger.info(`  rtmp://${lanIp}:${RTMP_PORT}/live/<设备名>`);
  logger.info(`  例:rtmp://${lanIp}:${RTMP_PORT}/live/cam1`);
  if (info.candidates.length > 1) {
    logger.info('其他可用内网地址:');
    for (const c of info.candidates.slice(1)) {
      logger.info(`  ${c.rtmpBase}/<设备名>  (${c.name}${c.virtual ? ', 虚拟网卡' : ''})`);
    }
  }
  logger.info(`详细日志: ${verboseLog ? '已开启' : '已关闭'} (可通过 POST /api/log/toggle 切换)`);
});
