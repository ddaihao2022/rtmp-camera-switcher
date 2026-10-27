/**
 * 统一的服务端地址解析
 *
 * 背景：此前 API / HTTP-FLV 地址在 6 个组件里各写死一份 `http://localhost:xxxx`，
 * 导致「把控制端放在另一台机器上」或「用 nginx 托管 Web 端」这两种部署方式都不可用。
 *
 * 默认行为（无需任何配置）：
 *  - 打包后的渲染进程跑在 file:// 下        → 指向 localhost
 *  - 开发模式跑在 http://localhost:5173     → 指向 localhost
 *  - 页面由服务器（例如 nginx）托管         → 自动指向该页面的 host
 *
 * 覆盖方式（按优先级从高到低）：
 *  1. URL 查询参数  ?server=192.168.1.50        （会被记住，之后无需再带）
 *                  ?flv=192.168.1.50:8001       （FLV 端口与 API 不同时用）
 *  2. localStorage  rtmp.server / rtmp.flv
 *  3. 上面的默认行为
 *
 * 示例：跑在一台机器上、服务在另一台 192.168.1.50
 *   file:///.../index.html?server=192.168.1.50
 */

const DEFAULT_API_PORT = 3001;
const DEFAULT_FLV_PORT = 8000;
const KEY_SERVER = 'rtmp.server';
const KEY_FLV = 'rtmp.flv';

function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* 隐私模式下忽略 */ }
}

function storageRemove(key) {
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}

/** "192.168.1.50" / "192.168.1.50:3001" / "http://192.168.1.50:3001" → {host, port, protocol} */
function parseEndpoint(raw, fallbackPort) {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (!value) return null;

  let protocol = null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(value);
  if (scheme) {
    protocol = `${scheme[1].toLowerCase()}:`;
    value = scheme[2];
  }

  value = value.replace(/\/+$/, '');
  if (!value) return null;

  let host;
  let port;

  // IPv6 字面量：[::1] 或 [::1]:3001
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (ipv6) {
    host = `[${ipv6[1]}]`;
    port = ipv6[2];
  } else {
    const colon = value.lastIndexOf(':');
    if (colon > -1 && /^\d+$/.test(value.slice(colon + 1))) {
      host = value.slice(0, colon);
      port = value.slice(colon + 1);
    } else {
      host = value;
    }
  }

  if (!host) return null;
  return { protocol, host, port: port ? Number(port) : fallbackPort };
}

// 查询参数里的覆盖值写进 localStorage，后续子窗口（?view=output 等）也能拿到
function absorbQueryOverrides() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const server = params.get('server');
    const flv = params.get('flv');
    if (server) storageSet(KEY_SERVER, server);
    if (flv) storageSet(KEY_FLV, flv);
  } catch { /* ignore */ }
}

/** 页面自身所在的 host；file:// 下没有 hostname，退回 localhost */
function defaultHost() {
  const location = window.location || {};
  if (!location.hostname || location.protocol === 'file:') return 'localhost';
  return location.hostname;
}

/** 页面自身使用的协议；https 页面不能直连 http，交给调用方自己覆盖 */
function defaultProtocol() {
  const protocol = (window.location || {}).protocol;
  return protocol === 'https:' || protocol === 'http:' ? protocol : 'http:';
}

absorbQueryOverrides();

const serverEndpoint =
  parseEndpoint(storageGet(KEY_SERVER), DEFAULT_API_PORT) ||
  parseEndpoint(defaultHost(), DEFAULT_API_PORT) ||
  { protocol: null, host: 'localhost', port: DEFAULT_API_PORT };

// FLV 默认与 API 同机，只换端口
const flvEndpoint =
  parseEndpoint(storageGet(KEY_FLV), DEFAULT_FLV_PORT) ||
  { protocol: null, host: serverEndpoint.host, port: DEFAULT_FLV_PORT };

const serverProtocol = serverEndpoint.protocol || defaultProtocol();
const flvProtocol = flvEndpoint.protocol || serverProtocol;

/** API + Socket.io 的基地址，例如 http://192.168.1.50:3001 */
export const API_HOST = `${serverProtocol}//${serverEndpoint.host}:${serverEndpoint.port}`;

/** HTTP-FLV 的基地址，例如 http://192.168.1.50:8000 */
export const FLV_HOST = `${flvProtocol}//${flvEndpoint.host}:${flvEndpoint.port}`;

/** Socket.io 连接地址（与 API 同源） */
export const SOCKET_URL = API_HOST;

/** 当前指向的服务端主机名，用于界面展示 */
export const SERVER_HOST = serverEndpoint.host;

/** 拼 API 地址：apiUrl('/api/streams') */
export function apiUrl(path = '') {
  const suffix = path && !path.startsWith('/') ? `/${path}` : path;
  return `${API_HOST}${suffix}`;
}

/** 拼 FLV 地址：flvUrl('/live/cam1.flv') */
export function flvUrl(path = '') {
  const suffix = path && !path.startsWith('/') ? `/${path}` : path;
  return `${FLV_HOST}${suffix}`;
}

/** 本地媒体文件的播放地址（blob: 由浏览器直接处理，其余走服务端 range 代理） */
export function localStreamUrl(stream) {
  if (!stream) return '';
  if (typeof stream.filePath === 'string' && /^blob:/i.test(stream.filePath)) {
    return stream.filePath;
  }
  const key = String(stream.streamKey || '').replace(/^local\//, '');
  return apiUrl(`/api/local/stream/${encodeURIComponent(key)}`);
}

/** 运行时切换服务端（写入 localStorage，需要重载窗口生效） */
export function setServer(value, { flv = null } = {}) {
  if (value) storageSet(KEY_SERVER, value);
  else storageRemove(KEY_SERVER);
  if (flv) storageSet(KEY_FLV, flv);
  else if (flv === null) storageRemove(KEY_FLV);
}

/** 恢复默认（清掉所有覆盖） */
export function resetServer() {
  storageRemove(KEY_SERVER);
  storageRemove(KEY_FLV);
}

/** 供设置面板展示当前生效的地址 */
export function describeServer() {
  return { api: API_HOST, flv: FLV_HOST, host: SERVER_HOST };
}

// ─── HDMI 输出是否带声音 ───────────────────────────────────────────────────────
// 默认关闭：主窗口已经通过 Web Audio 出声，输出窗口再放一遍会叠音。
// 打开后会随输出窗口一起出声，此时建议在混音台把该路静音（主窗口静音、输出窗口仍出声）。
const KEY_OUTPUT_AUDIO = 'rtmp.outputAudio';

export function getOutputAudio() {
  return storageGet(KEY_OUTPUT_AUDIO) === '1';
}

export function setOutputAudio(on) {
  storageSet(KEY_OUTPUT_AUDIO, on ? '1' : '0');
}
