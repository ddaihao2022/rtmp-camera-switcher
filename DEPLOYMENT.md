# 部署指南 · Deployment

本文档对应 **1.1.0** 的架构：Electron 桌面端 + 内置 Node 服务（node-media-server + Express + Socket.io）。
旧文档里提到的「Web 界面 :3000 / HLS 分片」已经不再使用，RTMP 播放走 HTTP-FLV（:8000）。

---

## 一、三种部署形态

### 形态 A：单机（默认，最简单）

控制端、服务端、HDMI 输出全部在同一台机器上。

```
摄像机 / OBS ──RTMP:1935──► 本机 server ──HTTP-FLV:8000──► 本机 Electron 界面
                                                              └──► HDMI 第二显示器
```

打包后的应用会自动在本机拉起服务端，**不需要任何配置**。

### 形态 B：服务端独立一台机器

一台机器专门收流，另一台机器做控制与输出。

```
摄像机 ──RTMP──► 收流机 (server + :1935/:8000/:3001) ──局域网──► 控制机 (Electron)
```

收流机上只跑 server：

```bash
npm install
npm run server
```

控制机上启动应用后，在 **⚙️ 设置 → 🌐 服务端地址** 里填收流机的内网 IP（例如 `192.168.1.50`），
点「保存并重载」。也可以直接用 URL 参数指定一次，之后会被记住：

```
index.html?server=192.168.1.50
```

> 地址解析规则见 `client/src/config.js`：`?server=` > `localStorage.rtmp.server` > 页面自身 host > `localhost`。
> API 端口默认 3001、FLV 端口默认 8000，可用 `?server=host:3001&flv=host:8000` 分别指定。

### 形态 C：nginx 托管 Web 端（浏览器访问，不用 Electron）

把 `client/dist` 挂到服务器上：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /path/to/client/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # API + Socket.io（WebSocket 必须透传）
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }

    # HTTP-FLV 播放
    location /live/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_buffering off;
        proxy_http_version 1.1;
    }
}
```

注意：页面由哪个 host 加载，前端就默认连该 host 的 3001 / 8000。
若 FLV 与 API 不在同一个 host/端口，用 `?flv=host:8000` 显式指定。

---

## 二、本地开发

```bash
# 1. 装依赖（仓库自带 .npmrc，已指向 npmmirror）
npm run install-all

# 2. 一条命令拉起 server + Vite + Electron
npm run dev
```

分开启动（便于单独看日志）：

```bash
npm run server   # 终端 1：RTMP / HTTP-FLV / API
npm run client   # 终端 2：Vite dev server (5173)
npm run electron # 终端 3：桌面端
```

> 开发模式下 Electron **不会**自己启动 server（见 `electron/main.js` 的 `isDev` 分支），
> 必须先有 `npm run server` 在跑。

---

## 三、打包

```bash
npm run build        # 出安装包：dist_electron/
npm run build:dir    # 只出免安装目录，快速验证
```

产物：

- Windows：`RTMP Camera Switcher Setup 1.1.0.exe`（NSIS）
- macOS：`.dmg`
- Linux：`.AppImage`

> `node-media-server` 已在 `package.json` 里**锁定为精确版本 4.2.4**。
> 原因：低延迟与诊断逻辑用到了它的内部私有结构（`NmsContext.broadcasts`、`broadcast.postPlay`、
> `session.rtmp.onPacketCallback` 等）。升级前请先在测试机验证推流播放、追播与日志诊断仍正常。

---

## 四、端口与防火墙

| 端口 | 用途 | 需要对外开放给 |
|---|---|---|
| 1935 | RTMP 推流接收 | 摄像机 / OBS 所在网段 |
| 8000 | HTTP-FLV 播放 | 控制端 / 浏览器 |
| 3001 | API + Socket.io | 控制端 / 浏览器 |
| 5173 | Vite 开发服务 | 仅本机（开发时） |

Windows 首次运行会弹防火墙提示，需允许**专用网络**入站，否则摄像设备连不上 1935。

---

## 五、摄像机 / OBS 配置

```
服务器：rtmp://<收流机内网 IP>:1935/live
串流密钥：设备名（例如 cam1）
```

完整地址即 `rtmp://192.168.1.50:1935/live/cam1`。必须保持 `app/stream` 两段式结构：
`live` 是固定 app 名，最后一段才是设备名（它会成为界面里显示的流名称）。

推荐推流参数（1080p）：

- 分辨率 1920×1080
- 码率 2500–5000 kbps
- 帧率 25–30 fps
- 关键帧间隔 1–2 秒（间隔越大，追播时跳帧越明显）

---

## 六、故障排查

### 推流连不上
1. `netstat -ano | findstr 1935` 确认端口在监听
2. 防火墙是否放行专用网络入站
3. 推流地址是否漏了 `/live/<设备名>` 这一段

### 界面能连上但画面不出现
- 先确认 8000 端口可达：浏览器访问 `http://<IP>:8000/live/cam1.flv`，正常会持续下载不结束
- 用仓库里的 `test-flv.js` 探针验证（改掉里面的 URL）：`node test-flv.js`

### 画面有延迟 / 越播越落后
- 降低推流关键帧间隔
- 主控窗口同时预览的路数越多，解码压力越大（预览可只看 1–2 路）
- 在设置里打开详细日志，观察 publisher 吞吐与广播包量

### 控制端连不上收流机
- 设置里的「服务端地址」是否填了内网 IP（不是 127.0.0.1）
- 收流机的 3001 是否对外开放
- 若地址填错导致界面空白：清掉 localStorage 的 `rtmp.server`，或用 `?server=正确IP` 重进

### 断流后 HDMI 黑屏
输出选择在断流后会保留 **30 秒**（`server/index.js` 的 `OUTPUT_RECONNECT_GRACE_MS`），
期间同一设备重连即自动续上；超过 30 秒仍未上线才会取消输出。

### HDMI 屏幕没有声音
默认输出窗口只出画面（避免与主窗口叠音）。需要展示端出声时：

1. 设置 → 📺 HDMI 输出 → 勾选「输出带声音」，然后重新开启输出
2. 到 🎚 音频混音台把该路**静音**：主窗口不出声，只由输出窗口出声
3. 若仍无声，检查系统默认播放设备是否指向那块 HDMI 显示器

### 录制文件只有画面没声音
- 录制的声音取自混音台的实际输出（推子 / 静音都会影响录制），确认该路未被静音
- 录制为 WebM（VP9/VP8 + Opus），请用支持 WebM 的播放器
