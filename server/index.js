const NodeMediaServer = require('node-media-server');
const NmsContext = require('node-media-server/src/core/context');
const express = require('express');
const http = require('http');
const os = require('os');
const dgram = require('dgram');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const timing = require('./timing');
const codecSniffer = require('./codec');
const hevcFix = require('./hevc-fix');
const { TranscodeManager, TRANSCODE_SUFFIX } = require('./transcode');

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
// 编码嗅探结果（按 streamPath 索引）：不依赖推流端 onMetaData，直接读码流
const bitstreamInfo = new Map();

// 挂钩一个 broadcast：统计吞吐 + 嗅探编码。
// 必须在 postPublish 里同步调用一次 —— 推流端的 metadata / AVC sequence header
// 往往在 publish 后几十毫秒内就发完了，只靠下面的轮询挂钩会漏掉 seq header，
// 导致分辨率解析不出来。
function installBroadcastHook(path, broadcast) {
  if (!broadcast || broadcast.__patched__) return;
  const orig = broadcast.broadcastMessage;
  const stat = { calls: 0, bytes: 0, rateKbps: 0, windowBytes: 0, windowStart: 0 };
  broadcastStats.set(path, stat);

  // 转码子流：postPublish 只代表 ffmpeg 连上了，必须等第一帧视频才算真正 ready。
  // 否则源流 NAL 损坏时，前端会切到一条永远没有画面的子流，显示 0 fps/0 kbps。
  const pathKey = String(path || '').replace(/^\/+/, '');
  const isTranscodeChild = Boolean(TRANSCODE_SUFFIX) && pathKey.endsWith(TRANSCODE_SUFFIX);
  const transcodeParentKey = isTranscodeChild
    ? pathKey.slice(0, -TRANSCODE_SUFFIX.length)
    : '';

  // 老式 FLV HEVC（codec id 12、无 sequence header）就地改写成标准 enhanced hvc1，
  // 否则 ffmpeg / flv.js 连分辨率都读不出来，转码直接失败。
  if (!broadcast.__hevcFixer__) broadcast.__hevcFixer__ = hevcFix.createFixer();
  const fixer = broadcast.__hevcFixer__;

  broadcast.broadcastMessage = (packet) => {
    stat.calls++;
    stat.lastPacketAt = Date.now();
    // 视频/关键帧分别记时间：只发音频或只发 P 帧的摄像机也算“没画面”，
    // 前端会一直等关键帧，看门狗和日志要能区分出来。
    if (packet?.codec_type === 9) {
      stat.lastVideoAt = stat.lastPacketAt;
      if (packet.flags === 3) stat.lastKeyAt = stat.lastPacketAt;
    }
    const len = packet?.data?.length || 0;
    stat.bytes += len;
    stat.subs = broadcast.subscribers.size;

    // 实时码率（kbps）：推流端不发 metadata 时 publisher.videoDatarate 恒为 0，
    // 导播台就显示成一堆 0，这里用实际广播字节数算
    const now = Date.now();
    if (!stat.windowStart) {
      stat.windowStart = now;
      stat.windowBytes = 0;
    }
    stat.windowBytes += len;
    const elapsed = now - stat.windowStart;
    if (elapsed >= 1000) {
      stat.rateKbps = Math.round((stat.windowBytes * 8) / elapsed);
      stat.windowBytes = 0;
      stat.windowStart = now;
    }

    try {
      // 关键帧前补发一次 sequence header：中途才连上来的播放器/ffmpeg 也能拿到参数集
      fixer.process(packet, (seqOrHvcC) => {
        if (!seqOrHvcC) return;
        orig(hevcFix.buildSequenceHeaderPacket(seqOrHvcC, packet?.dts ?? 0));
      });
    } catch (e) {
      logger.verbose('[hevc-fix] 改写失败', e.message);
    }
    try {
      codecSniffer.trackPacket(bitstreamInfo, path, packet);
    } catch (e) {
      logger.verbose('[编码嗅探] 解析失败', e.message);
    }

    // 子流关键帧 → 把父流标记为「转码就绪」。只等「有视频包」不够：P 帧先到时
    // 前端连上去仍要等下一个关键帧（黑屏几秒）。这里不做“只处理第一帧”的记忆，
    // 每个关键帧都尝试一次，由 onOutputReady 内部判断是否还是 pending —— 这样
    // 子流重连、转码重启都不会被历史状态卡住。
    if (isTranscodeChild && packet?.codec_type === 9 && packet.flags === 3) {
      if (transcode.onOutputReady(transcodeParentKey, pathKey)) {
        logger.info(`[转码] 子流首帧（关键帧）已到达: ${pathKey} → 父流 ${transcodeParentKey}`);
      }
    }

    const ret = orig(packet);
    // GOP 缓存现在用于新播放器秒开；异常流（长时间不出关键帧）要限制内存，
    // 900 帧约等于 30 秒，正常 1~5 秒 GOP 远远到不了。
    if (broadcast.flvGopCache && broadcast.flvGopCache.size > 900) broadcast.flvGopCache.clear();
    if (broadcast.rtmpGopCache && broadcast.rtmpGopCache.size > 900) broadcast.rtmpGopCache.clear();
    return ret;
  };
  broadcast.__patched__ = true;
  logger.verbose(`已挂钩 broadcast ${path}`);
}

setInterval(() => {
  for (const [path, broadcast] of NmsContext.broadcasts.entries()) {
    installBroadcastHook(path, broadcast);
  }
  for (const session of NmsContext.sessions.values()) {
    if (session.protocol === 'rtmp' && session.rtmp && !session.__patchedRtmp__) {
      // 建连后 200ms 内就挂上 ping 回应，不等 publish 命令；
      // 有些摄像机在 connect 阶段就开始发心跳。
      patchRtmpPing(session, logger);
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
    // 60 秒太紧：手机 Wi-Fi 短暂休眠/漫游时 pong 会晚到，NMS 会直接掐断 TCP，
    // 现场表现就是“推了一会儿自己掉”。放宽到 120 秒，卡死由上面的无数据看门狗兜底。
    ping_timeout: 120
  },
  http: { 
    port: FLV_PORT,
    allow_origin: '*',
    mediaroot: './media'
  },
  // 手机 App 分发：把 APK 放在 public/dl，走已放行的 8000 端口下载，
  // 不用再插 USB / 拷文件。地址：http://<本机IP>:8000/dl/camsender-1.0.1.apk
  static: {
    router: '/dl',
    root: path.join(__dirname, '..', 'public', 'dl'),
  },
  auth: { play: false, publish: false },
  // 传输配置优化
  trans: {
    ffmpeg: '/usr/bin/ffmpeg',
    tasks: []
  }
};

const nms = new NodeMediaServer(nmsConfig);

// 低延迟：曾经在这里把 postPlay 的 GOP 缓存重放整个跳过。
// 代价是每个新播放器（尤其是切镜头时新建的那一路）必须等下一个关键帧，
// 1080p/1 秒 GOP 就是约 1 秒黑屏。切换画面不黑屏比这 1 秒启动延迟重要：
// 恢复 NMS 默认行为，新播放器先收到「最近一个关键帧 + 该 GOP」立刻出画，
// 客户端 startCatchUp 会在缓冲超过阈值后自动追到直播点。

// Express 应用
const app = express();
app.use(cors());
// 名册照片 / 水印图片 / 整份配置都会走 JSON；默认 100 kB 在现场很容易 413
app.use(express.json({ limit: '8mb' }));

// ─── 静态页面：计时老师手机录入页 /timer/ · 裁判长监控页 /timer/monitor.html ───
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TIMER_DIR = path.join(PUBLIC_DIR, 'timer');
const CONSOLE_DIR = path.join(PUBLIC_DIR, 'console');
const RESULTS_DIR = path.join(PUBLIC_DIR, 'results');

app.use('/timer', express.static(TIMER_DIR, {
  index: 'index.html',
  extensions: ['html'],
}));
// 注意：Express 默认非严格路由，'/timer' 也会匹配 '/timer/'。
// 用一条路由分别处理，避免静态目录缺失时 '/timer/' → '/timer' → '/timer/' 无限重定向。
app.get(['/timer', '/timer/'], (req, res) => {
  if (!req.path.endsWith('/')) return res.redirect('/timer/');
  const file = path.join(TIMER_DIR, 'index.html');
  if (!fs.existsSync(file)) {
    return res.status(404).type('text/plain; charset=utf-8').send('计时录入页未随安装包发布');
  }
  res.sendFile(file);
});

// ─── 网页控台：手机 / 平板 / 另一台电脑用浏览器打开 ───────────────────────────
app.use('/console', express.static(CONSOLE_DIR, {
  index: 'index.html',
  extensions: ['html'],
}));
app.get(['/console', '/console/'], (req, res) => {
  if (!req.path.endsWith('/')) return res.redirect('/console/');
  const file = path.join(CONSOLE_DIR, 'index.html');
  if (!fs.existsSync(file)) {
    return res.status(404).type('text/plain; charset=utf-8').send('网页控台未随安装包发布');
  }
  res.sendFile(file);
});

// ─── 成绩公示：场内大屏 / 家长手机扫码查看，只读、不暴露任何主控操作 ─────────
app.use('/results', express.static(RESULTS_DIR, {
  index: 'index.html',
  extensions: ['html'],
}));
app.get(['/results', '/results/'], (req, res) => {
  if (!req.path.endsWith('/')) return res.redirect('/results/');
  const file = path.join(RESULTS_DIR, 'index.html');
  if (!fs.existsSync(file)) {
    return res.status(404).type('text/plain; charset=utf-8').send('成绩公示页未随安装包发布');
  }
  res.sendFile(file);
});
app.get('/', (req, res) => res.redirect('/console/'));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const activeStreams = new Map();
// 自动重试转码的冷却时间（按机位记；不要塞进 stream 对象，否则会被原样下发到前端）
const transcodeRetryAt = new Map();
// 连续失败次数：到上限就不再自动重试，避免“一直转码中”的死循环
const transcodeFailCount = new Map();
// 关键帧告警的冷却时间（按机位记）
const keyframeWarnAt = new Map();
let selectedOutputStream = null;
// 主控当前预览(PVW)的一路：输出/HDMI 窗口用它提前预热，TAKE 时不黑屏
let previewStreamKey = null;

// ─── 服务端实时转码 ─────────────────────────────────────────────────────────
// 把 HEVC/VP9/AV1 这类浏览器放不了的编码实时转成 H.264，再推回本机 NMS。
// 默认开启；设 TRANSCODE_DISABLED=1 可关掉（这种情况只能靠推流端改 H.264）。
const TRANSCODE_DISABLED = process.env.TRANSCODE_DISABLED === '1';
const transcode = new TranscodeManager({ rtmpHost: '127.0.0.1', rtmpPort: RTMP_PORT });
// 启动时就把 GPU 编码器探测好，避免第一路 HEVC 推流还要多等几秒
if (!TRANSCODE_DISABLED) void transcode.probeHw();

// 转码状态变化 → 同步到对应机位对象并推给前端
transcode.on('update', (parentKey, info) => {
  const stream = activeStreams.get(parentKey);
  if (!stream) return; // 父流已下线，忽略
  if (info.status === 'error') {
    transcodeFailCount.set(parentKey, (transcodeFailCount.get(parentKey) || 0) + 1);
  } else if (info.status === 'ready') {
    transcodeFailCount.delete(parentKey);
  }
  stream.transcodeStatus = info.status;          // pending | ready | stopped | error
  stream.transcodeMode = info.mode || '';        // hw | sw
  stream.transcodeError = info.status === 'error' ? String(info.error || '未知错误') : '';
  // 只有 ready 才暴露子流地址；error/stopped 时前端不能再去连一条已经没画面的流
  const ready = info.status === 'ready' && info.childKey;
  stream.transcodedStreamKey = ready ? info.childKey : null;
  stream.transcodedFlvPath = ready ? `/${info.childKey}.flv` : null;
  emitStreamUpdate();
});

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
  // 节目单刚载入、还没应用过任何一节时为 false：
  // 此时叠加层里仍是旧项目，切项时不能把旧项目快照回新节目单（会污染第 1 节）。
  programSynced: false,
  // —— 全屏成绩公示：每个项目结束后自动盖满 PGM / HDMI / 录像画面 ——
  fullResultsAuto: true,      // 按「下一项 / 上一项」时自动上屏
  fullResultsDuration: 12,    // 自动隐藏秒数，0 = 常显（手动关）
  fullResultsVisible: false,  // 运行时状态，不跨重启
  fullResultsHideAt: 0,       // 自动隐藏时间戳（0 = 不自动隐藏）
  fullResultsSnapshot: null,  // 当前公示的项目成绩快照
};

if (fsScore?.fs.existsSync(fsScore.path)) {
  try {
    const raw = JSON.parse(fsScore.fs.readFileSync(fsScore.path, 'utf8'));
    scoreboardConfig = {
      ...scoreboardConfig,
      ...raw,
      clockRunning: false,
      clockStartAt: null,
      // 全屏成绩是一次性的现场状态，重启后不要又把旧成绩盖在画面上
      fullResultsVisible: false,
      fullResultsHideAt: 0,
    };
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
      fullResultsVisible: false,
      fullResultsHideAt: 0,
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
  if (videoCodec == null || videoCodec === '' || videoCodec === 0 || videoCodec === '0') return 'unknown';
  const raw = String(videoCodec).toLowerCase();
  if (videoCodec === 7 || raw === '7' || raw.includes('h264') || raw.includes('avc')) return 'H.264';
  if (videoCodec === 12 || raw === '12') return 'H.265/HEVC'; // FLV 传统 HEVC codec id
  if (videoCodec === FOURCC_HEVC || raw.includes('h265') || raw.includes('hevc') || raw.includes('hvc1')) return 'H.265/HEVC';
  if (videoCodec === FOURCC_VP9 || raw.includes('vp9') || raw.includes('vp09')) return 'VP9';
  if (videoCodec === FOURCC_AV1 || raw.includes('av1') || raw.includes('av01')) return 'AV1';
  return String(videoCodec);
}

function isBrowserPlayableVideoCodec(videoCodec, diag = {}) {
  const label = getVideoCodecLabel(videoCodec);
  if (label === 'unknown') return true;
  if (label !== 'H.264') return false;
  // 浏览器/flv.js 只能稳定解 8-bit 4:2:0 的 H.264；
  // High10 / 4:2:2 / 4:4:4 必须走转码，否则会黑屏但编码 ID 仍是 7。
  const bitDepth = Number(diag.videoBitDepth) || 8;
  const chroma = Number(diag.videoChromaFormat) || 1;
  return bitDepth <= 8 && chroma === 1;
}

function getStreamDiagnostics(streamPath = '') {
  const normalizedPath = normalizeStreamPath(streamPath);
  const broadcast = NmsContext.broadcasts.get(normalizedPath);
  const publisher = broadcast?.publisher;
  const sniffed = bitstreamInfo.get(normalizedPath) || {};
  const fixerDims = broadcast?.__hevcFixer__?.dimensions || null;
  const stat = broadcastStats.get(normalizedPath) || {};

  // 码流里读到的编码最可信；metadata 只是补充（很多推流端根本不发 metadata，
  // 那样 publisher.videoCodec 会一直是初值 0，前端就会误判成"编码不支持"）
  const metaVideoCodec = publisher?.videoCodec;
  const hasMetaVideo = metaVideoCodec != null && metaVideoCodec !== '' && metaVideoCodec !== 0;
  const videoCodec = sniffed.videoCodec ?? (hasMetaVideo ? metaVideoCodec : null);
  const audioCodec = sniffed.audioCodec ?? (publisher?.audioCodec || null);
  const audioFourCC = sniffed.audioFourCC || '';
  // flv.js 只稳定支持 FLV 原生 AAC / MP3；enhanced Opus/FLAC 等要转 AAC
  const audioPlayable = !audioFourCC;
  const audioCodecLabel = audioFourCC === 'opus' ? 'Opus'
    : audioFourCC === 'flac' ? 'FLAC'
      : audioCodec === 10 ? 'AAC'
        : audioCodec === 2 ? 'MP3'
          : audioCodec ? `Audio ${audioCodec}` : '';
  const videoBitDepth = sniffed.videoBitDepth || 0;
  const videoChromaFormat = sniffed.videoChromaFormat || 0;
  const baseLabel = getVideoCodecLabel(videoCodec);
  const videoCodecLabel = baseLabel === 'H.264' && videoBitDepth > 8
    ? `H.264 ${videoBitDepth}-bit`
    : baseLabel;

  return {
    videoCodec,
    videoCodecLabel,
    videoBitDepth,
    videoChromaFormat,
    browserPlayable: isBrowserPlayableVideoCodec(videoCodec, { videoBitDepth, videoChromaFormat }),
    videoWidth: publisher?.videoWidth || sniffed.videoWidth || fixerDims?.width || 0,
    videoHeight: publisher?.videoHeight || sniffed.videoHeight || fixerDims?.height || 0,
    videoFramerate: publisher?.videoFramerate || sniffed.videoFramerate || 0,
    videoDatarate: publisher?.videoDatarate || stat.rateKbps || 0,
    audioCodec,
    audioCodecLabel,
    audioFourCC,
    audioPlayable,
    audioChannels: publisher?.audioChannels || 0,
    audioSamplerate: publisher?.audioSamplerate || 0,
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
// ─── 摄像机 RTMP 心跳回应 ───────────────────────────────────────────────────
// NMS v4 的 eventHandler 是空函数：摄像机发 User Control PingRequest 时它不回
// PingResponse，不少硬件编码器会按自身超时（常见 1~3 分钟）主动断流。
// 具体实现见 server/rtmp-ping.js。
const { patchRtmpPing } = require('./rtmp-ping');

nms.on('prePublish', (session) => {
  logger.verbose(`[prePublish] id=${session.id} streamPath=${session.streamPath}`);
  patchRtmpPing(session, logger);
});

nms.on('postPublish', (session) => {
  const rawStreamPath = session.streamPath;
  const { streamKey, streamPath, flvPath } = getStreamMeta(rawStreamPath);
  logger.info(`[postPublish] id=${session.id} streamPath=${rawStreamPath} normalized=${streamPath}`);

  // NMS 在「同一 streamKey 已有 publisher」时也会先触发 postPublish，再报错关闭新会话。
  // 不能让这个被拒绝的会话覆盖已有流/转码状态，否则机位会从「GPU 转码」变回「编码不兼容」。
  const broadcast = NmsContext.broadcasts.get(streamPath);
  const livePublisher = broadcast?.publisher;
  const existing = activeStreams.get(streamKey);
  if (existing) {
    // 用广播层最后一次真实收包时间判断，不能只看 activeStreams.lastPacketAt：
    // 那个字段只在建流/状态翻转时写，健康推流跑过 15 秒后会被误判成「无数据」。
    const stat = broadcastStats.get(streamPath);
    const lastPacketAt = Number(stat?.lastPacketAt)
      || Number(existing.lastPacketAt)
      || new Date(existing.startTime).getTime()
      || 0;
    const stale = lastPacketAt > 0 && Date.now() - lastPacketAt > 15000;
    // 只有 activeStreams 里记的会话确实是当前 publisher 时才算「真重复」。
    // 被 NMS 拒绝的会话会留下幽灵条目，必须允许新会话接管，否则真实推流被永久挡住。
    const isHealthyLive = Boolean(livePublisher) && !stale;
    if (isHealthyLive) {
      if (existing.id === livePublisher.id) {
        logger.warn(`[postPublish] ${streamKey} 已有推流，忽略重复会话 ${session.id}`);
        return;
      }
      // 机位表记的会话和真实推流对不上（历史遗留的幽灵条目）：
      // 以真实推流为准，只把表校正回来，绝不能踢掉正在健康出图的那一路
      logger.warn(`[postPublish] ${streamKey} 校正机位表：${existing.id} → ${livePublisher.id}，忽略重复会话 ${session.id}`);
      existing.id = livePublisher.id;
      existing.lastPacketAt = Number(stat?.lastPacketAt) || existing.lastPacketAt;
      existing.status = 'online';
      Object.assign(existing, getStreamDiagnostics(streamPath));
      emitStreamUpdate();
      return;
    }
    logger.warn(`[postPublish] ${streamKey} ${stale ? '旧推流 15 秒无数据' : `会话 ${existing.id} 已失效`}，按新会话 ${session.id} 接管`);
    try {
      // 关键：NMS 是在本回调返回之后才检查 broadcast.publisher 是否为空的。
      // 只 close 旧会话是异步的，检查那一刻旧 publisher 还在 → 新会话必被
      // “already has a publisher” 拒绝，于是形成永久踢人循环。这里必须先同步摘掉。
      if (broadcast?.publisher && broadcast.publisher.id !== session.id) {
        const stalePublisher = broadcast.publisher;
        broadcast.publisher = null;
        // 旧流的 metadata / 编码头必须一起清掉：新流可能是 HEVC，而中途接进来的
        // 播放器会先收到广播里残留的上一条 H.264 sequence header，直接解不出来。
        broadcast.rtmpMetaData = null;
        broadcast.rtmpVideoHeader = null;
        broadcast.rtmpAudioHeader = null;
        broadcast.flvMetaData = null;
        broadcast.flvVideoHeader = null;
        broadcast.flvAudioHeader = null;
        broadcast.flvGopCache?.clear?.();
        broadcast.rtmpGopCache?.clear?.();
        stalePublisher.close?.();
      }
    } catch { /* 已断开 */ }
    activeStreams.delete(streamKey);
    transcode.stop(streamKey);
  }

  bitstreamInfo.delete(streamPath); // 丢掉上一次推流残留的嗅探结果
  transcodeFailCount.delete(streamKey); // 新推流重新给 3 次转码机会
  transcodeRetryAt.delete(streamKey);
  // 立刻挂钩，抢在推流端发 metadata / AVC sequence header 之前（轮询挂钩会漏包）
  installBroadcastHook(streamPath, NmsContext.broadcasts.get(streamPath));

  // 转码子流（_h264 结尾）：不进机位列表，等广播钩子看到关键帧后再回传 ready
  if (TRANSCODE_SUFFIX && streamKey.endsWith(TRANSCODE_SUFFIX)) {
    const parentKey = streamKey.slice(0, -TRANSCODE_SUFFIX.length);
    logger.info(`[转码] 子流已连接，等待首帧: ${streamKey} → 父流 ${parentKey}`);
    return;
  }

  activeStreams.set(streamKey, {
    id: session.id,
    streamKey,
    streamPath,
    flvPath,
    startTime: new Date(),
    lastPacketAt: Date.now(),
    status: 'online',
    transcodeStatus: null, // pending | ready | stopped | error（由 transcode 事件异步填充）
    ...getStreamDiagnostics(streamPath)
  });

  logger.verbose('活跃流:', Array.from(activeStreams.keys()));
  emitStreamUpdate();

  // 延迟判定是否需要转码：等嗅探出真实编码（HEVC/VP9/AV1 才需要）。
  // 浏览器放不了的编码一律转成 H.264，前端会自动改播转码流。
  if (!TRANSCODE_DISABLED) {
    setTimeout(() => {
      const stream = activeStreams.get(streamKey);
      if (!stream) return; // 已经下线
      const diag = getStreamDiagnostics(streamPath);
      Object.assign(stream, diag); // 刷新一次编码/分辨率
      if (!diag.browserPlayable || !diag.audioPlayable) {
        const audioOnly = diag.browserPlayable && !diag.audioPlayable;
        logger.info(`[转码] ${streamKey} ${audioOnly
          ? `音频 ${diag.audioCodecLabel || '不兼容'} 需要转 AAC`
          : `编码 ${diag.videoCodecLabel} 浏览器放不了`}，启动实时转码 → ${streamKey}${TRANSCODE_SUFFIX}`);
        transcode.maybeStart(streamKey, {
          browserPlayable: diag.browserPlayable,
          audioOnly,
        });
      }
    }, 2000);
  }
});

nms.on('donePublish', (session) => {
  const rawStreamPath = session.streamPath;
  const { streamKey, streamPath } = getStreamMeta(rawStreamPath);
  logger.info(`[donePublish] id=${session.id} streamPath=${rawStreamPath} normalized=${streamPath}`);

  // 转码子流下线：父流的转码状态交给 ffmpeg 退出事件去清，这里不处理机位列表
  if (TRANSCODE_SUFFIX && streamKey.endsWith(TRANSCODE_SUFFIX)) {
    bitstreamInfo.delete(streamPath);
    return;
  }

  // 被 NMS 拒绝的重复会话关闭时不要误删当前正在推的那一路
  const existing = activeStreams.get(streamKey);
  if (existing && existing.id !== session.id) {
    logger.warn(`[donePublish] 忽略过期会话 ${session.id}（当前 ${existing.id}）`);
    return;
  }

  activeStreams.delete(streamKey);
  transcodeRetryAt.delete(streamKey);
  transcodeFailCount.delete(streamKey);
  keyframeWarnAt.delete(streamKey);
  bitstreamInfo.delete(streamPath);
  transcode.stop(streamKey); // 源流停了，杀掉转码进程

  if (selectedOutputStream === streamKey) {
    selectedOutputStream = null;
    io.emit('outputSelected', { streamKey: null });
  }

  io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
});

nms.on('prePlay', (session) => {
  logger.verbose(`[prePlay] id=${session.id} streamPath=${session.streamPath}`);
  patchRtmpPing(session, logger);
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

// ─── 赛事预设（data/meets/*.json）：秩序册赛程 + 节目单一键载入 ───────────────
const MEETS_DIR = (() => {
  const fromCwd = path.join(process.cwd(), 'data', 'meets');
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.join(__dirname, '..', 'data', 'meets');
})();

function readMeetFile(file) {
  const safe = path.basename(String(file || ''));
  if (!/^[\w.-]+\.json$/.test(safe)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(MEETS_DIR, safe), 'utf8'));
  } catch {
    return null;
  }
}

function listPresetMeets() {
  try {
    return fs.readdirSync(MEETS_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('-program.json'))
      .map((f) => readMeetFile(f))
      .filter((m) => m && m.id && m.name)
      .map((m) => ({
        id: m.id,
        name: m.name,
        shortName: m.shortName || m.name,
        school: m.school || '',
        edition: m.edition || '',
        dateRange: m.dateRange || '',
        venue: m.venue || '',
        sessions: m.sessions || [],
        stats: m.stats || null,
        notes: m.notes || [],
      }));
  } catch {
    return [];
  }
}

app.get('/api/meets', (req, res) => {
  res.json(listPresetMeets());
});

app.get('/api/meets/:id', (req, res) => {
  const meet = listPresetMeets().find((m) => m.id === req.params.id);
  if (!meet) return res.status(404).json({ error: 'meet not found' });
  const full = readMeetFile(`${req.params.id}.json`);
  if (!full) return res.status(404).json({ error: 'meet file missing' });
  res.json(full);
});

app.get('/api/meets/:id/program', (req, res) => {
  const full = readMeetFile(`${req.params.id}.json`);
  if (!full) return res.status(404).json({ error: 'meet not found' });
  const programFile = full.programFile || `${full.id}-program.json`;
  const program = readMeetFile(programFile);
  if (!Array.isArray(program)) return res.status(404).json({ error: 'program file missing' });
  res.json({ id: full.id, name: full.name, program: normProgram(program) });
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
  res.json({ selectedStream: selectedOutputStream, previewStream: previewStreamKey });
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
  const raw = req.params.key;
  const key = raw.startsWith('local/') ? raw : 'local/' + raw;
  if (!localFiles.delete(key)) {
    return res.status(404).json({ success: false, error: 'not found' });
  }
  // 正在输出的素材被删掉时，别让输出层继续指向一个已经不存在的 key
  if (selectedOutputStream === key) {
    selectedOutputStream = null;
    io.emit('outputSelected', { streamKey: null });
  }
  io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
  res.json({ success: true, streamKey: key });
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

// ─── 推流无数据看门狗 ─────────────────────────────────────────────────────────
// RTMP 会话可能还连着，但手机/相机已经不再发帧（切后台、锁屏、编码器卡死）。
// 12 秒没有任何 packet 就标记 stalled，前端显示「无画面」。
// 关键：只标记、不立刻断开。现场 Wi-Fi 抖动/手机休眠很常见，12 秒就杀会话会
// 逼手机整条重连（还要经历 NMS 的 publisher 抢占），表现就是“推流一会儿自己掉”。
// 给 60 秒恢复窗口：手机醒了继续用原会话，真死了才断开。
const STALL_MARK_MS = 12000;
const STALL_CLOSE_MS = 60000;
setInterval(() => {
  let changed = false;
  for (const [key, stream] of activeStreams) {
    const stat = broadcastStats.get(stream.streamPath);
    const last = Number(stat?.lastPacketAt) || Number(stream.lastPacketAt)
      || new Date(stream.startTime).getTime() || 0;
    const idle = Date.now() - last;
    if (idle > STALL_MARK_MS && stream.status !== 'stalled') {
      stream.status = 'stalled';
      stream.lastPacketAt = last;
      changed = true;
      logger.warn(`[流] ${key} 已 ${Math.round(idle / 1000)} 秒没有数据，标记为无画面（${Math.round(STALL_CLOSE_MS / 1000)} 秒内恢复会自动继续）`);
    } else if (idle < 5000 && stream.status === 'stalled') {
      stream.status = 'online';
      stream.lastPacketAt = last;
      changed = true;
      logger.info(`[流] ${key} 数据已恢复，继续使用原会话`);
    }

    // 长时间真死才断开，给手机留出休眠/漫游后的恢复窗口
    if (idle > STALL_CLOSE_MS && stream.status === 'stalled') {
      stream.lastPacketAt = last;
      logger.warn(`[流] ${key} 已 ${Math.round(idle / 1000)} 秒没有数据，断开旧会话等手机重连`);
      transcode.stop(key);
      try {
        const stale = [...NmsContext.sessions.values()].find(s => s.id === stream.id);
        stale?.close?.();
      } catch { /* 已断开 */ }
    }

    // 摄像机在出视频、但长时间没有关键帧：播放器会一直“等待关键帧”。
    // 这不是服务端能补的，必须让摄像机把 I 帧间隔调短；先给出明确告警。
    if (stream.status === 'online' && stat?.lastVideoAt && Date.now() - stat.lastVideoAt < 5000) {
      const lastKey = Number(stat.lastKeyAt) || 0;
      const keyAge = lastKey ? Date.now() - lastKey : Infinity;
      if (keyAge > 15000 && Date.now() - (keyframeWarnAt.get(key) || 0) > 30000) {
        keyframeWarnAt.set(key, Date.now());
        logger.warn(`[流] ${key} 视频在走但${Number.isFinite(keyAge) ? ` ${Math.round(keyAge / 1000)} 秒` : '一直'}没有关键帧，画面会一直等待；请把摄像机 I 帧间隔设为 1~2 秒`);
      }
    }

    // 源流恢复了但转码进程已经死掉 → 自动重新拉起，不用等下一次推流
    if (!TRANSCODE_DISABLED && stream.status === 'online'
        && stream.browserPlayable === false
        && Date.now() - last < 10000
        && !transcode.isRunning(key)
        && (stream.transcodeStatus === 'error' || stream.transcodeStatus === 'stopped' || stream.transcodeStatus == null)
        && (transcodeFailCount.get(key) || 0) < 3
        && Date.now() - (transcodeRetryAt.get(key) || 0) > 20000) {
      transcodeRetryAt.set(key, Date.now());
      logger.info(`[转码] ${key} 源流已恢复，自动重试转码`);
      void transcode.maybeStart(key, { browserPlayable: false }).catch(() => {});
    }
  }
  if (changed) {
    io.emit('streamUpdate', [...Array.from(activeStreams.values()), ...Array.from(localFiles.values())]);
  }
}, 5000);

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
  { id: 'sxq', label: '实心球', eventName: '男子实心球', eventKind: 'field', category: '男子', lanes: 0, useClock: false },
  { id: 'mini', label: '迷你马拉松', eventName: '教职工迷你马拉松', eventKind: 'long', category: '混合', lanes: 0, useClock: true },
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

// 全屏成绩自动隐藏：由服务端统一推进，HDMI / 监看 / 录像同时收起
setInterval(() => {
  if (!scoreboardConfig.fullResultsVisible) return;
  const hideAt = Number(scoreboardConfig.fullResultsHideAt) || 0;
  if (hideAt > 0 && Date.now() >= hideAt) {
    scoreboardConfig = {
      ...scoreboardConfig,
      fullResultsVisible: false,
      fullResultsHideAt: 0,
    };
    emitScoreboard();
  }
}, 300);

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
  return (Array.isArray(list) ? list : []).slice(0, 400).map((e, i) => {
    const athletes = padProgramAthletes(normAthletes(e?.athletes));
    const eventName = String(e?.eventName ?? '').trim() || '未命名项目';
    const category = String(e?.category ?? '').trim()
      || (/女子/.test(eventName) ? '女子' : '男子');
    const round = String(e?.round ?? '').trim() || '预赛';
    const heat = String(e?.heat ?? '').trim();
    return {
      id: String(e?.id ?? `p${i + 1}`),
      time: String(e?.time ?? ''),
      end: String(e?.end ?? ''),
      session: String(e?.session ?? ''),
      sessionLabel: String(e?.sessionLabel ?? ''),
      label: String(e?.label ?? '').trim() || [eventName, round, heat].filter(Boolean).join(' '),
      eventName,
      category,
      round,
      heat,
      eventKind: String(e?.eventKind ?? '') || 'sprint',
      athletes,
      count: athletes.filter(a => a.name.trim() || a.photo || a.unit.trim()).length,
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

  // 离开当前节之前先把现场改动快照回该节；整表替换（opt.snapshot=false）时旧节目单已被换掉，不做快照。
  // 刚载入、还没应用过任何一节时（programSynced === false），叠加层里是旧项目，也不能快照。
  if (opt.snapshot !== false && cfg.programSynced !== false) {
    snapshotProgramEntry(cfg, opt.from === undefined ? cfg.programIndex : opt.from);
  }
  // 快照会改写旧节，所以取目标节要放在快照之后
  const entry = cfg.program[i];
  if (!entry) return cfg;

  cfg.programSynced = true;
  cfg.programIndex = i;
  if (cfg.mode === 'team') cfg.mode = 'track';
  cfg.eventName = entry.eventName;
  cfg.category = entry.category;
  cfg.round = entry.round;
  // 单组/田赛节没有组次，必须清掉上一节的「第1组」，否则上屏会一直挂着旧组次
  cfg.heat = entry.heat || '';
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

// ─── 成绩公示 API：把节目单 / 当前叠加层整理成「只读、按名次排序」的成绩 ─────────
// 公示页只需要成绩，不返回照片、备注等现场资料，避免几 MB 的 base64 拖慢手机端。
function publicResultAthlete(a) {
  return {
    lane: Number(a?.lane) || 0,
    name: String(a?.name ?? '').trim(),
    unit: String(a?.unit ?? '').trim(),
    bib: String(a?.bib ?? '').trim(),
    pb: String(a?.pb ?? '').trim(),
    place: String(a?.place ?? '').trim(),
    result: String(a?.result ?? '').trim(),
  };
}

function hasPublishedResult(a) {
  return !!(a.place || a.result);
}

function placeRank(place) {
  const m = String(place ?? '').match(/\d+/);
  return m ? Number(m[0]) : 9999;
}

function publicResultEntry(e, index, live) {
  const all = (Array.isArray(e?.athletes) ? e.athletes : [])
    .map(publicResultAthlete)
    .filter(a => a.name || a.unit);
  const athletes = all
    .filter(hasPublishedResult)
    .sort((a, b) => placeRank(a.place) - placeRank(b.place) || (a.lane || 0) - (b.lane || 0));
  return {
    index: Number.isFinite(index) ? index : -1,
    id: String(e?.id ?? ''),
    eventName: String(e?.eventName ?? '').trim() || '未命名项目',
    category: String(e?.category ?? '').trim(),
    round: String(e?.round ?? '').trim(),
    heat: String(e?.heat ?? '').trim(),
    eventKind: String(e?.eventKind ?? '').trim() || 'sprint',
    time: String(e?.time ?? '').trim(),
    session: String(e?.session ?? '').trim(),
    sessionLabel: String(e?.sessionLabel ?? '').trim(),
    live: !!live,
    count: all.length,
    resultCount: athletes.length,
    athletes,
  };
}

/** 全屏成绩展示用的快照：只保留名次/成绩，不带照片、备注 */
function buildResultsSnapshot(cfg) {
  const entry = publicResultEntry({ ...cfg, athletes: cfg?.athletes }, getProgramIndex(cfg), false);
  return entry.resultCount > 0 ? entry : null;
}

/**
 * 现场补录 / 计时回传后再刷一次全屏成绩：
 * 只刷新「当前这一节」的板子；已经切走的上一节成绩保持原样，
 * 免得下一节的空名册把刚公示的成绩覆盖掉。
 */
function refreshFullResults(cfg) {
  if (!cfg.fullResultsVisible || !cfg.fullResultsSnapshot) return cfg;
  if (Number(cfg.fullResultsSnapshot.index) !== Number(getProgramIndex(cfg))) return cfg;
  const snap = buildResultsSnapshot(cfg);
  return snap
    ? { ...cfg, fullResultsSnapshot: snap }
    : { ...cfg, fullResultsVisible: false, fullResultsHideAt: 0 };
}

function buildResultsPayload(cfg = scoreboardConfig, meetId = '') {
  const program = Array.isArray(cfg.program) ? cfg.program : [];
  const idx = getProgramIndex(cfg);
  // 只载入、还没应用节目单时（programSynced === false），叠加层里仍是旧项目，
  // 不能把它当成节目单第 1 节的成绩，否则第一次公示会挂错项目。
  const useLive = idx >= 0 && cfg.programSynced !== false;
  const entries = [];
  let current = null;

  program.forEach((e, i) => {
    const isCurrent = useLive && i === idx;
    const src = isCurrent
      ? {
        ...e,
        eventName: cfg.eventName,
        category: cfg.category,
        round: cfg.round,
        heat: cfg.heat,
        eventKind: cfg.eventKind,
        athletes: cfg.athletes,
      }
      : e;
    const entry = publicResultEntry(src, i, isCurrent);
    if (isCurrent) current = entry;
    if (entry.resultCount > 0) entries.push(entry);
  });

  if (!current) {
    // 没有节目单（或节目单尚未应用）时，公示当前叠加层里的项目
    current = publicResultEntry({ id: 'current', ...cfg, athletes: cfg.athletes }, -1, true);
  }

  let meet = null;
  try {
    const list = listPresetMeets();
    meet = list.find(m => m.id === meetId) || list[0] || null;
  } catch { /* 赛程缺失时仍能公示 */ }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    title: meet?.name || '运动会成绩公示',
    meet: meet ? {
      id: meet.id,
      name: meet.name,
      shortName: meet.shortName,
      school: meet.school,
      edition: meet.edition,
      dateRange: meet.dateRange,
      venue: meet.venue,
      sessions: meet.sessions,
    } : null,
    programIndex: idx,
    current,
    // 历史成绩按节目单顺序返回，前端可从后往前展示（最新在前）
    entries,
  };
}

app.get('/api/results', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(buildResultsPayload(scoreboardConfig, String(req.query?.meet || '')));
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
    // 全屏成绩公示
    'fullResultsAuto', 'fullResultsDuration', 'fullResultsVisible', 'resultsAction',
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

  next.fullResultsDuration = Math.max(0, Math.min(120, Math.floor(Number(next.fullResultsDuration) || 0)));
  // 切项前先记住「刚结束的这一项」的成绩：节目单切走后当前名册会被下一节覆盖
  const outgoingResults = (patch.programAction === 'next' || patch.programAction === 'prev')
    ? buildResultsSnapshot(next)
    : null;

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
      } else {
        // 只载入、不切项：当前叠加层仍是旧项目，第一次「应用」不能把旧项目写回第 1 节
        next.programSynced = false;
      }
    } else if (patch.programAction === 'next') {
      // 到最后一节就停住：不能绕回第 1 节，否则会静默清零跑表、换错项目
      const target = cur < 0 ? 0 : Math.min(program.length - 1, cur + 1);
      if (program.length && target !== cur) applyProgramEntry(next, target, { from: cur });
    } else if (patch.programAction === 'prev') {
      const target = cur <= 0 ? 0 : cur - 1;
      if (program.length && target !== cur) applyProgramEntry(next, target, { from: cur });
    } else if (patch.programAction === 'apply' || patch.programAction === 'goto') {
      applyProgramEntry(next, patch.programIndex, { from: cur });
    } else if (patch.programSnapshot) {
      snapshotProgramEntry(next, cur);
      next.programSynced = true;
    }

    next.program = normProgram(next.program);
    next.programIndex = Math.max(0, Math.min(Math.max(0, next.program.length - 1),
      Math.floor(Number(next.programIndex) || 0)));
    delete next.programAction;
    delete next.programSnapshot;
  }

  // 全屏成绩公示：优先响应当次请求里的手动动作，否则在切项后自动上屏
  const resultsAction = patch.resultsAction ? String(patch.resultsAction) : '';
  const resultsSeconds = Math.max(0, Math.min(120, Math.floor(Number(next.fullResultsDuration) || 0)));
  next.fullResultsDuration = resultsSeconds;
  const nextHideAt = resultsSeconds > 0 ? Date.now() + resultsSeconds * 1000 : 0;
  if (resultsAction === 'hide' || (resultsAction === 'toggle' && scoreboardConfig.fullResultsVisible)) {
    next.fullResultsVisible = false;
    next.fullResultsHideAt = 0;
  } else if (resultsAction === 'show' || resultsAction === 'toggle' || resultsAction === 'next') {
    const snap = outgoingResults || buildResultsSnapshot(next);
    if (snap) {
      next.fullResultsVisible = true;
      next.fullResultsSnapshot = snap;
      next.fullResultsHideAt = nextHideAt;
    } else {
      next.fullResultsVisible = false;
      next.fullResultsHideAt = 0;
    }
  } else if (resultsAction === '') {
    // 自动：按「下一项 / 上一项」后，把刚结束项目的成绩盖满画面
    if (outgoingResults && next.fullResultsAuto !== false) {
      next.fullResultsVisible = true;
      next.fullResultsSnapshot = outgoingResults;
      next.fullResultsHideAt = nextHideAt;
    } else if (next.fullResultsVisible && patch.fullResultsDuration !== undefined) {
      // 板子已经在屏上时改「秒后收起」：按新时长从现在重新计时
      next.fullResultsHideAt = nextHideAt;
    }
  }
  delete next.resultsAction;

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
  scoreboardConfig = refreshFullResults(next);
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

  scoreboardConfig = refreshFullResults(next);
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
  if (previewStreamKey) {
    socket.emit('previewSelected', { streamKey: previewStreamKey });
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

  // 预览(PVW)选择 → 广播给输出/HDMI 窗口做预加载
  socket.on('preview:select', ({ streamKey } = {}) => {
    previewStreamKey = streamKey || null;
    io.emit('previewSelected', { streamKey: previewStreamKey });
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
