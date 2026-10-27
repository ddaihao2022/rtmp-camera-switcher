# 变更记录 · Changelog

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
