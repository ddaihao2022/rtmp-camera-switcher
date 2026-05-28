const NodeMediaServer = require('node-media-server');
const NmsContext = require('node-media-server/src/core/context');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

// 诊断:监控所有 BroadcastServer,在每次广播 packet 时记录
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
      console.log(`[诊断] 已挂钩 broadcast ${path}`);
    }
  }
  // 监控所有 publisher 的 RTMP 协议解析,看是否在持续触发 onPacket
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
      console.log(`[诊断] 已挂钩 rtmp 协议层 ${session.id}`);
    }
  }
}, 200);

// 同时跟踪 publisher 实际吞吐(基于 BaseSession.inBytes)
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
    console.log(`[publisher] ${path}: socket入 ${(delta / 1024).toFixed(1)} KB, rtmp解析 ${rtmpStats.count} 包/${(rtmpStats.bytes / 1024).toFixed(1)} KB, 广播 ${stat.calls} 包/${(stat.bytes / 1024).toFixed(1)} KB | parserState=${r.parserState} inChunk=${r.inChunkSize} pkt(type=${pp.header?.type} len=${pp.header?.length} bytes=${pp.bytes})`);
    stat.calls = 0;
    stat.bytes = 0;
  }
}, 5000);

// node-media-server v4 配置
const nmsConfig = {
  bind: '0.0.0.0',
  rtmp: {
    port: 1935
  },
  http: {
    port: 8000
  },
  auth: {
    play: false,
    publish: false
  }
};

// 创建RTMP服务器
const nms = new NodeMediaServer(nmsConfig);

// Express应用
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 存储活跃的摄影设备
const activeStreams = new Map();
let selectedOutputStream = null; // 当前选中输出的流

// RTMP事件监听
nms.on('prePublish', (session) => {
  console.log('[prePublish]', `id=${session.id} streamPath=${session.streamPath}`);
});

nms.on('postPublish', (session) => {
  const streamPath = session.streamPath;
  console.log('[postPublish]', `id=${session.id} streamPath=${streamPath}`);

  // 清理用的 key (去掉首尾斜杠), 同时保存原始路径用于 FLV URL
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

  console.log('活跃流:', Array.from(activeStreams.keys()));
  io.emit('streamUpdate', Array.from(activeStreams.values()));
});

nms.on('donePublish', (session) => {
  const streamPath = session.streamPath;
  console.log('[donePublish]', `id=${session.id} streamPath=${streamPath}`);

  const streamKey = streamPath.replace(/^\/+|\/+$/g, '');
  activeStreams.delete(streamKey);

  if (selectedOutputStream === streamKey) {
    selectedOutputStream = null;
    io.emit('outputSelected', { streamKey: null });
  }

  io.emit('streamUpdate', Array.from(activeStreams.values()));
});

nms.on('prePlay', (session) => {
  console.log('[prePlay]', `id=${session.id} streamPath=${session.streamPath}`);
});

nms.on('postPlay', (session) => {
  console.log('[postPlay]', `id=${session.id} streamPath=${session.streamPath}`);
});

// API路由
app.get('/api/streams', (req, res) => {
  res.json(Array.from(activeStreams.values()));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeStreams: activeStreams.size });
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

  if (activeStreams.has(streamKey)) {
    selectedOutputStream = streamKey;
    io.emit('outputSelected', { streamKey });
    res.json({ success: true, streamKey, message: `已选择 ${streamKey} 作为输出` });
  } else {
    res.status(404).json({ success: false, message: '流不存在' });
  }
});

// Socket.io连接
io.on('connection', (socket) => {
  console.log('客户端连接:', socket.id);

  // 发送当前活跃流列表
  socket.emit('streamUpdate', Array.from(activeStreams.values()));
  if (selectedOutputStream) {
    socket.emit('outputSelected', { streamKey: selectedOutputStream });
  }

  socket.on('disconnect', () => {
    console.log('客户端断开:', socket.id);
  });
});

// 启动服务器
nms.run();
server.listen(3001, () => {
  console.log('=================================');
  console.log('RTMP服务器运行在 rtmp://localhost:1935');
  console.log('HTTP-FLV服务器运行在 http://localhost:8000');
  console.log('API服务器运行在 http://localhost:3001');
  console.log('=================================');
  console.log('推流地址(必须 app/stream 两段式):');
  console.log('  rtmp://<host>:1935/live/<设备名>');
  console.log('  例:rtmp://localhost:1935/live/cam1');
});
