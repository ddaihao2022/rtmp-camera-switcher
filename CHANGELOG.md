# 变更记录 · Changelog

## 1.1.1

这一版集中在**现场稳定性**：断流能自己恢复，不用人工盯。

### 新增

- **直播播放器自动重连**
  摄像机重启、交换机抖动、OBS 换场景都会让 HTTP-FLV 连接断掉；旧实现只会弹一个「↻ 重连」按钮，
  现场得有人盯着点。现在：指数退避重连（2s → 4s → 8s → 15s，最多 8 次，约 90 秒），
  播起来立刻重置退避；连续失败到上限才转人工。
  另外加了 **12 秒卡死看门狗**：连接没断但画面不再推进时，flv.js 不一定报错，这种情况由看门狗主动重连。
  预览窗口、HDMI 输出窗口、PROGRAM 监视窗三处统一生效。
  相关文件：`client/src/useLivePlayer.js`（新增）、`VideoPlayer.jsx`、`OutputView.jsx`、`OutputMonitor.jsx`

- **网格视图支持 5–8 路**
  之前只定义了 `.grid-1..4`，超过 4 路布局会塌；现在补了 5–8 路的三列/四列布局。

### 修复

- **断流时不再清空预览选中**
  `streamUpdate` 原本在该流下线时把 `selectedStream` 置空，导致播放器组件被卸载 —— 播放器都没了，
  自动重连自然无从谈起。现在 RTMP 设备保留选中状态（本地媒体被移除才清空），
  恢复后无需人工再点一次。
  相关文件：`client/src/App.jsx`

- **帧率 / 码率统计口径修正**
  原代码读 `statisticsInfo.videoDataRate` / `audioDataRate`，但这两个字段属于 `MediaInfo` 而不是
  `statisticsInfo`，所以码率一直显示 0（`speed` 是 KB/s，才是对的来源）。
  帧率则改用 `requestVideoFrameCallback` 数真正呈现的帧 ——
  实测 `video.getVideoPlaybackQuality().totalVideoFrames` 在 Electron 31 的 MSE 播放链路上是死值
  （一直停在 212 不动），按它算差值永远得 0。
  相关文件：`client/src/components/VideoPlayer.jsx`

- **服务端清理音频状态**
  流下线 / 本地媒体移除时同步删掉 `audioState` 里的对应 key，避免长跑后无限增长，
  也避免同一设备重推时意外套用上次的音量。

### 重构

- 三个播放器（预览 / HDMI 输出 / PROGRAM 监视）原本各写一份 `createPlayer` 配置和追播定时器，
  参数还不一致（`stashInitialSize` 32 vs 128、`maxLatency` 0.5 vs 1.0…）。
  现在集中到 `client/src/flvPlayer.js`，播放器生命周期与重连逻辑收进 `client/src/useLivePlayer.js`。
- 删除两个从未被引用的组件：`AudioPanel.jsx`、`WatermarkPanel.jsx`
  （水印 UI 实际在 `SettingsModal` 里，混音 UI 在 `AudioView` 里）。

### 关于 Web Worker（这一版没能用上）

原本的计划是打开 `enableWorker`，把 FLV 解封装挪出主线程，减轻多路预览的 CPU 压力。
实测在 Vite 下开 `true` 会抛：

```
Uncaught TypeError: Cannot read properties of undefined (reading 'call')
```

原因是 flv.js 1.6.2 的 dist 用 `webworkify-webpack` 起 worker，依赖 webpack 运行时，
在非 webpack 打包器里初始化失败，transmuxer 永远拿不到数据（画面黑屏、`readyState` 一直是 0）。
所以这一版仍然保持 `enableWorker: false`，原因写在 `flvPlayer.js` 的注释里。
要真正用上 worker，需要换成 **mpegts.js**（flv.js 的活跃分支，原生支持 Worker 与 ESM），
那是一次播放库替换，必须重测追播与重连行为。

## 1.1.0

这一版集中在**可用性与稳定性**，没有改 UI 结构。

### 修复

- **录制改为流式写盘**（P0）
  旧实现把每 500ms 的分片全攒在渲染进程内存里，停止时 `arrayBuffer()` 一次性读进内存，
  再整个 `ArrayBuffer` 过 IPC 交给主进程 `writeFileSync`。几分钟 1080p 就会吃掉数 GB 内存、
  卡死界面。现在改为 `record:start` / `record:chunk` / `record:end` 三段式：
  开始时建好写入流，每片直接追加落盘，渲染进程不再持有历史数据。
  相关文件：`electron/main.js`、`electron/preload.js`、`client/src/components/RecordPanel.jsx`

- **录制音轨取自 Web Audio 图**（P0）
  元素被 `createMediaElementSource` 接管后，`videoEl.captureStream()` 拿到的音轨通常是静音的。
  改为从 gain 之后取 `MediaStreamAudioDestinationNode` 的 stream，
  录到的就是混音台推子/静音之后的真实输出。
  相关文件：`client/src/audio.js`（`getRecordingAudioStream`）

- **HDMI 输出可以带声音**（P0）
  输出窗口此前固定 `hasAudio: false`，那块屏永远没声音，而文档没说明。
  现在可用「输出带声音」开关控制；开启后输出窗口自行出声，
  配合混音台把该路静音即可避免与主窗口叠音。
  相关文件：`client/src/OutputView.jsx`、`client/src/components/{HdmiOutputPanel,SettingsModal}.jsx`、`electron/main.js`

- **服务端地址不再硬编码**（P0）
  API / FLV 地址此前散落在 6 个组件里各写死一份 `http://localhost:xxxx`，
  导致「收流机与控制机分离」和「nginx 托管 Web 端」两种部署方式都不可用。
  现在统一由 `client/src/config.js` 解析：`?server=` > `localStorage` > 页面 host > `localhost`，
  并在设置面板里提供「服务端地址」入口。

- **断流不再立刻清除输出选择**（P1）
  RTMP 抖动或 OBS 重连会触发 `donePublish`，旧逻辑直接把输出清空，HDMI 屏黑成「未选择输出画面」。
  现在保留 30 秒宽限期（`OUTPUT_RECONNECT_GRACE_MS`），期间同一设备重新上线即自动续上。

- **诊断钩子只在 verbose 时挂载**（P1）
  旧代码用两个 `setInterval(200)` 无条件包装 `broadcastMessage` / `onPacketCallback`，
  即使关闭日志，每个 RTMP packet 仍要多一次函数调用与计数。
  现在随日志开关挂上/摘下，并在关闭时还原原方法；低延迟 patch 的轮询也从 200ms 放宽到 500ms，
  且新流上线时立即补打一次。

- **本地文件接口做了校验**（P1）
  `/api/local/add` 与 `/api/local/stream` 此前接受任意路径，配合全开 CORS 等于开了本机任意文件读取。
  现在要求：路径存在、是普通文件、扩展名属于受支持的媒体类型；
  range 请求也补了越界保护（416）。

- **输出窗口不再因无关流上下线而闪烁**
  `OutputView` / `OutputMonitor` 的播放器 effect 原本依赖整个 `streams` 数组，
  任何一路流变化都会重建播放器。现在只依赖该路自己的 FLV 地址。

### 其它

- `node-media-server` 锁定为精确版本 **4.2.4**：低延迟与诊断逻辑依赖其内部私有结构，
  放开 `^` 范围会导致升级后静默失效。
- 移除误提交的 `.git.zip`（14.4 MB）。
- `package.json` 的 license 由 `MIT` 改为 `GPL-3.0-only`，与 `LICENSE` 文件和 README 一致。
- 版本号统一为 1.1.0（根包 / client / README badge）。
- 重写 `DEPLOYMENT.md`：改为当前架构（Electron + HTTP-FLV），
  补充单机 / 分离部署 / nginx 托管三种形态、端口防火墙说明与故障排查。
- `client/src/config.js` 新增；`App.jsx`、`AudioView.jsx`、`OutputView.jsx`、
  `VideoPlayer.jsx`、`OutputMonitor.jsx`、`LocalMediaPanel.jsx`、`SettingsModal.jsx`、
  `WatermarkPanel.jsx` 全部改为使用统一地址解析。

### 已知未处理

- `AudioPanel.jsx`、`WatermarkPanel.jsx` 两个组件当前没有任何地方引用
  （水印 UI 实际在 `SettingsModal` 里，混音 UI 在 `AudioView` 里），属于历史遗留死代码。
- `enableWorker: false`：flv.js 解封装仍在主线程，多路 1080p 预览时 CPU 压力偏大，
  后续可以考虑开 worker 或加预览子码流。
- 同一条流会被主窗口预览、PROGRAM 监视、HDMI 输出各拉一份完整码流，局域网带宽与解码都是 3 倍。
- API 与 RTMP 仍无鉴权（`auth.publish: false`、CORS 全开），适合可信内网，不适合公网直接暴露。
