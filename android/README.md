# RTMP CamSender · 安卓手机摄像头接入端

把这个 App 装到安卓手机上，手机就变成导播系统的一路无线机位：
**原相机 + 麦克风采集 → 手机内硬编码 H.264/AAC → 直接以 RTMP 推回电脑上的导播台**。

不依赖任何第三方推流 SDK，全部用系统 API 实现（Camera2 + MediaCodec + 自写 RTMP 客户端），
APK 体积小、无广告、无联网校验。

```
手机                                     电脑（本仓库）
┌───────────────────────────┐            ┌──────────────────────────────┐
│ Camera2 ──Surface──► H.264│            │ node-media-server            │
│ AudioRecord ─────► AAC    │  RTMP      │  1935  RTMP 接入             │
│      FLV 封装             │ ─────────► │  8000  HTTP-FLV 播放         │
│      自写 RTMP 客户端      │  :1935     │  3001  API + Socket.io       │
└───────────────────────────┘            │ Electron 导播台自动列出该机位 │
                                         └──────────────────────────────┘
```

---

## 一、编译

### 环境要求

| 项目 | 要求 |
| --- | --- |
| JDK | 17 或以上（本机验证用 Zulu 21） |
| Android SDK | Platform 34、Build-Tools 34.0.0（`local.properties` 里已指向本机 SDK） |
| Gradle | 8.11.1（本机验证版本，8.7+ 均可） |
| 手机 | Android 7.0 (API 24) 以上，需有摄像头 |

### 命令

```bash
cd android

# 编译 Debug 包（首次会自动下载 AGP / Kotlin 插件依赖）
gradle assembleDebug

# 产物
# app/build/outputs/apk/debug/app-debug.apk     ← 已随本次交付编译完成（5.86 MB）
# app/build/outputs/apk/release/app-release.apk ← 可选，debug 签名（4.26 MB）
```

> 本机验证环境：Gradle 8.11.1 + JDK 21。若 `services.gradle.org` 可访问，
> 也可以先生成 wrapper（`gradle wrapper --gradle-version 8.11.1`），
> 之后统一用 `./gradlew`（Windows 用 `gradlew.bat`）执行。
> 用 Android Studio 打开 `android/` 目录，IDE 也会自动补上 wrapper。

### 安装

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

或者把 APK 拷进手机点安装（首次需允许「安装未知来源应用」）。

> **路径含中文的说明**：本工程位于 `...\项目\RTMP\android`，AGP 默认会拒绝含非 ASCII 的
> 路径，因此 `gradle.properties` 里加了 `android.overridePathCheck=true`。
> 如果换到纯英文路径，这一行可以删掉。

### 正式签名包（可选）

在 `android/keystore.properties` 填：

```properties
storeFile=../keystore/release.jks
storePassword=xxxx
keyAlias=rtmp
keyPassword=xxxx
```

然后 `gradle assembleRelease`。没有该文件时会自动回退为 debug 签名，不影响测试。

> **内存不足时**：`assembleRelease` 会额外跑 `lintVitalRelease`，这一步很吃内存
> （本机实测在剩余内存不足时直接让 Gradle 守护进程 native OOM 退出）。
> 遇到这种情况用 `gradle assembleRelease -x lintVitalRelease` 跳过 lint 即可；
> 工程里已设置 `kotlin.compiler.execution.strategy=in-process`，少起一个编译进程。


---

## 二、手机端使用

1. **同一局域网**：手机连的 Wi-Fi 要和电脑在同一个网段（电脑不要连 VPN/虚拟网卡网段）。
2. **电脑先启动导播台**：仓库根目录执行 `npm run server`（或整套 `npm start`）。
3. 打开 App：

   | 步骤 | 操作 |
   | --- | --- |
   | ① 找服务器 | 点 **自动发现**（扫描本机 `/24` 网段，约 10 秒拿到电脑 IP）；也可手填电脑 IP 后点 **测试连接** |
   | ② 填机位名 | **只能用英文/数字/下划线**，例如 `phone1`、`cam_b`。这个名字就是导播台左侧显示的设备名 |
   | ③ 选参数 | 分辨率（按机身能力枚举）/ 编码格式 / 帧率 / 码率 / 音频 / 方向 / 前后摄像头 |
   | ④ 开始推流 | 点 **开始推流**，预览框出现画面，导播台左侧立即多出一路机位 |
   | ⑤ 收工 | 点 **停止推流**（通知栏也有「停止推流」按钮） |

   界面会同时显示**本机能力**（相机最高分辨率 / H.264 上限 / H.265 上限）和当前生效的
   「编码格式 + 画幅 + 帧率 + 码率」，以及针对该画幅的码率建议。想跑到本机最高画幅
   （例如 8K）：把分辨率拉到最大 → 编码格式留「自动」→ 码率选「80 Mbps 8K」以上。
   换手机、切前后摄后如果列表没变，点 **重新检测分辨率**。

4. 推流地址格式：`rtmp://<电脑IP>:1935/live/<机位名>`，App 里会实时显示完整地址。

> **息屏继续推流**：推流走前台服务（`StreamService`），锁屏 / 切后台都不会断，
> 通知栏常驻「正在推流」。推流期间 App 会申请屏幕常亮，避免部分机型压帧。

### 预览与播出一致

预览框不是「再开一个相机」，而是**编码器输入 Surface 的同一路画面**（Camera2 的
`encoderSurface` 与 `previewSurface` 属于同一个 `CaptureSession`），并且按推流画幅等比
缩放 + 旋转，所以手机上看到什么，导播台里就是什么：

- 前置摄像头**不做镜像**，和播出一致；
- 预览框高度按 `旋转后的宽高比` 自动算，画幅切换不用手调。

---

## 三、参数说明

### 可选档位

| 参数 | 档位 |
| --- | --- |
| 分辨率 | **按机身实际能力动态生成**（相机输出 ∩ 编码器支持），最高到该机型的上限——支持 8K 的机型会列出 `7680×4320` |
| 编码格式 | 自动（按分辨率选）/ H.264 / H.265（HEVC） |
| 帧率 | 30 / 25 / 24 / 15 fps，另有 60 fps（需该尺寸下编码器支持） |
| 视频码率 | 1 / 1.5 / 2.5 / 4 / 6 / 8 / 12 / 20 / 40 / 60 / 80 / 120 Mbps（默认 4 Mbps，CBR） |
| 音频 | 128k 48kHz 立体声 / 96k 44.1kHz 单声道 / 64k 44.1kHz 单声道 |
| 方向 | 自动跟随手机方向 / 强制横屏 / 强制竖屏 |
| 摄像头 | 后置 / 前置（推流中可一键切换） |

「本机能力」那一行会直接写出三条硬上限：**相机最高分辨率 / H.264 编码上限 / H.265 编码上限**。
点「重新检测分辨率」可重新枚举；切换前后摄时会自动重跑（两个摄像头的传感器能力差异很大）。

### 最高能到 8K 吗

能不能出 8K 完全由**硬件**决定，App 不写死任何上限，而是算「相机能出 × 编码器能编」的交集：

1. **相机侧**：`CameraManager.getCameraCharacteristics(id)
   .SCALER_STREAM_CONFIGURATION_MAP.getOutputSizes(SurfaceTexture)` —— 传感器能输出哪些尺寸；
2. **编码器侧**：`MediaCodecList(REGULAR_CODECS)` 逐个查 `getCapabilitiesForType(mime)`，
   取 `VideoCapabilities` 的 `supportedWidths / supportedHeights` 与
   `getSupportedFrameRatesFor(w, h)`。

两个集合取交集后按像素数降序，就是下拉框里看到的档位（区间划分到 8K/5K/4K/2.5K/1080p/720p）。
实测参考：

| 机型档次 | 实际能推到的上限 |
| --- | --- |
| 骁龙 8 Gen 2/3、天玑 9200 级别（HEVC 编码器支持 8K） | **7680×4320（8K）@24/30fps** |
| 多数 2020 年后旗舰 | 3840×2160（4K）@30fps |
| 中低端 | 1080p / 720p |

**为什么 8K 一定是 H.265**：手机上的 H.264 硬编码器普遍止步于 4096 宽
（`supportedWidths.upper` 常见 4080~4096），8K 需要 7680 宽，只有 HEVC 编码器给得出。
因此选 8K 时「编码格式」会走 H.265；反过来，若手动选了 H.264 又要 8K，App 不会硬编失败，
而是**退到该机型 H.264 能编的最大分辨率**（通常 4K）并在日志里写清原因。

### 帧率与码率会被自动夹到合法区间

- **帧率**：超过该分辨率的 `getSupportedFrameRatesFor(w,h).upper` 时自动下调（8K 常见上限 24~30fps）；
- **码率**：夹进编码器的 `bitrateRange`（不同机型在 4K/8K 下的上限差别很大）。

界面会提示「该画幅建议 ≥N Mbps」（例如 8K 建议 ≥80 Mbps），但**不会替你改设置**——
码率给低了画面就是会糊。建议值：

| 画幅 | 建议码率 |
| --- | --- |
| 8K (7680×4320) | 80~120 Mbps |
| 4K (3840×2160) | 40~60 Mbps |
| 1440p / 2.5K | 20 Mbps |
| 1080p | 8 Mbps |
| 720p | 4 Mbps |

### 8K / H.265 的四条实际限制（务必先看）

1. **导播台内置播放器放不了 H.265**。前端用 flv.js（MSE），浏览器不提供 HEVC 解码，
   导播台会把这一路标成 `browserPlayable: false` 并提示「编码为 H.265/HEVC，浏览器不能直接播放」。
   要直接在大屏看画面，请用 **H.264（≤4K）**；8K/H.265 这一路的码流本身是完整正确的，
   用 `ffplay` / VLC 拉 `http://<电脑IP>:8000/live/<机位名>.flv` 可以正常解码。
2. **网络要够快**。80 Mbps 已超过很多 2.4GHz Wi-Fi 的实际吞吐，8K 请用有线（USB 网卡）
   或 5GHz/6GHz 近距离；多机位同推按总带宽算。
3. **发热与耗电**。8K HEVC 编码 + 80 Mbps 无线发送会让 SoC 迅速升温，
   长时间直播建议降到 4K 或降低帧率，避免过热降频。
4. **部分机型对 8K 尺寸的 `MediaCodec` 更挑剔**。App 用「编码器输入 Surface 直连」
   （零拷贝，不占应用内存），并对档位做逐级降级（指定档位 → 默认档位 → 另一编码格式），
   失败时会给出明确错误而不是黑屏。

### 分辨率怎么选

| 场景 | 建议 |
| --- | --- |
| 普通 Wi-Fi（5GHz，同房间） | 1080p + 4~6 Mbps（H.264，导播台可直接看） |
| 2.4GHz 或隔墙、多机位同推 | 720p + 2.5~4 Mbps |
| 机位多 / 网络拥挤（>4 路） | 720p 或 480p + 1.5~2.5 Mbps |
| 只需要看构图、长时间待机 | 360p + 1 Mbps |
| 4K 监看（有线网 + 支持 HEVC 的播放器） | 3840×2160 + H.265 + 40 Mbps |
| 8K 监看/录制（有线网 + 高端机型） | 7680×4320 + H.265 + 80~120 Mbps，24/30fps |

### 方向设置

| 情况 | 选什么 |
| --- | --- |
| 手持、可能横竖切换 | 自动跟随手机方向 |
| 手机横装在三脚架/支架上 | 强制横屏（输出 16:9） |
| 手机竖装 | 强制竖屏（输出 9:16） |

旋转由 `GlRotateRenderer` 在 OpenGL 里完成：相机帧先进 GL 外部纹理（`GL_TEXTURE_EXTERNAL_OES`），
旋转后**直接渲染进编码器的输入 Surface**，编码器拿到的就是已经摆正的像素。
这样不依赖 `MediaFormat.KEY_ROTATION`——部分机型的硬编码器会静默忽略该参数，
只在 metadata 里留个标记，播放端画面就是歪的。

旋转 90°/270° 时 GL 的输出尺寸正是相机输入尺寸交换后的值，与相机输出尺寸 1:1 对应，
因此任意分辨率（含 8K）都不缩放、不裁切。代价是多一次 GPU 采样；
所以 8K 下建议手机横置并选「自动跟随」——此时旋转为 0°，代码直接跳过 GL 链路
（`if (rotationDegrees == 0)` 直接把编码器 Surface 给相机）。

### 导播台里能看到的信息

App 在 publish 成功后立刻发 `@setDataFrame/onMetaData`，所以导播台的机位信息
（分辨率、帧率、码率、编码格式、声道）都会正确显示。同一个机位在不同档位下的例子：

```jsonc
// 1080p / H.264（默认，导播台可直接播放）
{ "videoCodec": 7, "videoCodecLabel": "H.264", "browserPlayable": true,
  "videoWidth": 1920, "videoHeight": 1080, "videoFramerate": 30, "videoDatarate": 6000,
  "audioCodec": 10, "audioChannels": 1, "audioSamplerate": 44100 }

// 8K / H.265（导播台会提示「浏览器不能直接播放」，见上文限制 1）
{ "videoCodec": "hvc1", "videoCodecLabel": "H.265/HEVC", "browserPlayable": false,
  "videoWidth": 7680, "videoHeight": 4320, "videoFramerate": 30, "videoDatarate": 80000,
  "audioCodec": 10, "audioChannels": 2, "audioSamplerate": 48000 }
```

上面第二组数据就是本机自测里真实跑出来的（`gradle -p tools/rtmp-selftest run`）。

### 多机位

同一台手机换个机位名就能再开一路；多台手机填不同机位名即可。
每路都是独立 RTMP 连接，导播台自动汇总。

---

## 四、代码结构

```
android/
├── settings.gradle.kts / build.gradle.kts / gradle.properties   # 工程配置
├── local.properties                                             # 本机 SDK 路径（不入库）
├── app/
│   ├── build.gradle.kts                                         # 依赖、签名、viewBinding
│   └── src/main/
│       ├── AndroidManifest.xml                                  # 权限 + 前台服务声明
│       ├── java/com/rtmp/camsender/
│       │   ├── MainActivity.kt            界面：探测/参数/预览/启停/日志
│       │   ├── Prefs.kt                   参数持久化 + 机位名清洗
│       │   ├── net/ServerProbe.kt          /api/server-info 探测 + 局域网自动发现
│       │   ├── service/StreamService.kt    前台服务：通知栏、息屏推流、状态回调
│       │   ├── rtmp/Amf0.kt                AMF0 编解码
│       │   ├── rtmp/VideoCodec.kt          编码格式枚举（H.264 / H.265 + FourCC）
│       │   ├── rtmp/NalParse.kt            纯 Kotlin NAL 解析（Annex-B ⇄ AVCC、参数集提取）
│       │   ├── rtmp/FlvTag.kt              FLV Tag 封装（AVC / HEVC 增强头 / AAC / 元数据）
│       │   ├── rtmp/RtmpPublisher.kt       握手 + 分块收发 + 命令交互 + 看门狗
│       │   └── stream/
│       │       ├── StreamConfig.kt         配置与旋转/输出尺寸推导
│       │       ├── StreamPresets.kt        下拉档位表（帧率/码率/音频/方向/编码格式）
│       │       ├── CodecCaps.kt            硬编码器能力查询 + 「分辨率×编码格式」编排
│       │       ├── CameraSource.kt         Camera2 封装（尺寸枚举/帧率/前后切换）
│       │       ├── GlRotateRenderer.kt     GL 旋转（相机 OES 纹理 → 编码器 Surface）
│       │       ├── VideoEncoder.kt         MediaCodec H.264/H.265（Surface 输入、逐级降级）
│       │       ├── AudioEncoder.kt         AudioRecord + MediaCodec AAC
│       │       ├── OrientationMonitor.kt   设备方向监听
│       │       └── StreamEngine.kt         总调度：起停、重连、统计、失败收敛
│       └── res/                            深色主题 UI、图标、网络安全配置
└── tools/
    ├── make_icons.py                       生成各密度启动图标
    └── rtmp-selftest/                      纯 JVM 协议自测工程（见下）
```

### 关键实现点

- **零拷贝视频链路**：Camera2 直接把帧写进 `MediaCodec` 的输入 Surface，
  CPU 不参与像素搬运；预览是同一个 `CaptureSession` 的第二个输出面。
  需要旋转时中间插一层 `GlRotateRenderer`（GPU 采样，仍不占 CPU），不需要旋转则跳过。
- **编码格式与能力**：`CodecCaps` 用 `MediaCodecList(REGULAR_CODECS)` +
  `getCapabilitiesForType()` 问出真实上限，`CameraSource.videoSizes()` 问出相机输出尺寸，
  两者交集生成分辨率列表，并把「分辨率 + 编码格式 + 帧率 + 码率」编排成一个 `Plan`
  （`CodecCaps.plan()`）。UI 与推流引擎用的是同一个 `plan()`，所以界面上显示的就是实际会用的。
- **AVC 封装**：从 `csd-0/csd-1` 取 SPS/PPS 拼 AVCDecoderConfigurationRecord，
  帧数据从 Annex-B 转 AVCC（4 字节长度前缀）后按 FLV 规则打包。
- **HEVC 封装**：H.265 必须走**增强型 RTMP 扩展头**（FLV codecID 12 不是合法值，
  node-media-server 也只对 7 做旧式解析）：tag 首字节 = `0x80 | frameType<<4 | packetType`，
  后跟 FourCC `hvc1`；序列头是一份 hvcC（`1 | SPS[3..14] 的 12 字节 PTL | F0 00 FC FD F8 F8 00 00 | 03 | 03`，
  再跟 VPS/SPS/PPS 三个数组），帧头部另有 3 字节 CTS。
- **时间戳**：音频用 `elapsedRealtimeNanos`；视频以「首帧到达时刻」为锚点
  （`videoAnchorMs + (pts - 首帧pts)/1000`），保证音视频相对关系正确且不依赖时基假设。
- **背压**：发送队列上限 240 包，满了丢最旧并计数；看门狗在「队列有积压且 12 秒无写入进展」时判定断线并触发重连（最多 5 次）。
- **状态同步**：界面与服务同进程，通过 `StreamService.uiListener` 静态引用回调；
  重进界面会把历史日志补回来。

---

## 五、协议自测（不用手机也能验证）

`tools/rtmp-selftest` 把 App 里的 `rtmp` 包**原样编译到 JVM** 上，
对真实的 `node-media-server` 推两路合成码流（一路 H.264、一路 7680×4320 的 H.265），
再从 HTTP-FLV 拉回来校验。推流出问题先跑它，能立刻分清是「协议层」还是「相机层」的毛病。

```bash
# 1) 先启动导播台服务
cd ..            # 回到仓库根目录
npm run server

# 2) 另开一个终端跑自测
cd android
gradle -p tools/rtmp-selftest run
```

覆盖内容（共 65 项检查）：

| 检查 | 说明 |
| --- | --- |
| AMF0 往返 | 命令 / 对象 / `@setDataFrame` / ECMA 数组 |
| FLV 结构（AVC） | AVC 序列头、AVCC 记录字段、视频 CTS、音频头 |
| FLV 结构（HEVC） | 扩展头标志位（0x90/0x91/0xA1）、FourCC `hvc1`、hvcC 逐字节（PTL/chromaFormat/位深/lengthSize/VPS-SPS-PPS 数组顺序）、3 字节 CTS 偏移 |
| 元数据 | `videocodecid`：H.264 → 7，H.265 → `hvc1`；8K 宽高 7680×4320 |
| NAL 解析 | H.265 的 NAL 类型（VPS 32 / SPS 33 / PPS 34 / IDR 19）、参数集提取顺序与完整性、关键帧判定；H.264 回归 |
| 参数集指纹 | SPS 变化能被识别（决定是否重发序列头） |
| RTMP 链路 | 握手 → SetChunkSize → connect → createStream → publish |
| 服务器登记（AVC） | `/api/streams` 出现该机位，`videoCodecLabel: H.264`、`browserPlayable: true` |
| 服务器登记（H.265/8K） | `videoCodecLabel: H.265/HEVC`、`browserPlayable: false`、`videoWidth: 7680` |
| HTTP-FLV 回放 | FLV 头、`onMetaData`、编码器标识、AVC 序列头、H.265 的 `hvc1` + 扩展头序列头、8K 双精度宽高 |
| 下线清理 | 断开后服务器自动移除该流 |
| 非 ASCII 机位名 | 定点诊断服务端缺陷（见下） |

实测结果（本机 Windows + Zulu 21 + node-media-server 4.2.4）：

```
PASS  flv hevc seq: 扩展头|关键帧|SequenceStart = 0x90 byte0=0x90
PASS  flv hevc config: 保留位/chromaFormat/位深/avgFrameRate 13..18=F0 00 FC FD F8 F8 00 00
PASS  flv hevc arrays 顺序 = VPS(0x20)/SPS(0x21)/PPS(0x22) 20 21 22
PASS  flv hevc keyframe: 3 字节 CTS 在 [5..7]，负载从第 8 字节起 size=16
PASS  onMetaData 8K 尺寸 w=7680.0 h=4320.0
PASS  nalparse hevc: 类型 = VPS(32)/SPS(33)/PPS(34)/IDR(19) [32, 33, 34, 19]
PASS  rtmp connect + publish
PASS  pushed frames frames=60 dropped=0 bytes=18714
PASS  server /api/streams contains key [... "videoWidth":1280,"videoHeight":720 ...]
PASS  http-flv has avc seq header
PASS  8K/H.265 推帧 frames=26 dropped=0 bytes=3184
PASS  服务端把该路识别为 H.265/HEVC [... "videoCodecLabel":"H.265/HEVC","browserPlayable":false,
      "videoWidth":7680,"videoHeight":4320,"videoDatarate":80000 ...]
PASS  HTTP-FLV(H.265) 含扩展头序列头（0x90 + hvc1） hvc1@171
PASS  8K 路断开后被清理
ALL TESTS PASSED
```

---

## 六、已知限制与注意

### 1. 机位名必须用 ASCII（重要）

`node-media-server` 的 AMF0 编码器有个缺陷：

```js
// node_modules/node-media-server/src/protocol/amf.js:287
function amf0encString(str) {
  let buf = Buffer.alloc(3);
  buf.writeUInt8(0x02, 0);
  buf.writeUInt16BE(str.length, 1);        // ← 写的是 UTF-16 码元数
  return Buffer.concat([buf, Buffer.from(str, "utf8")]);   // ← 装的却是 UTF-8 字节
}
```

对非 ASCII 字符串（如 `一号机位`），长度字段与实际字节数不一致，而服务端发回的
`onStatus` 描述里恰好包含机位名。自测实测（`description` 字段）：

```
description：声明长度=28 字节，实际长度=36 字节（含中文的路径）
/live/一号机位 is now published.   ← 28 是 JS 字符数，实际 UTF-8 是 36 字节
```

任何严格按 AMF0 解析的客户端都会在这里错位（我们的客户端会明确报
「解析服务器消息失败」并给出原始报文十六进制），推流握手因此无法完成。所以：

- App 会把机位名里的非 ASCII 字符替换成 `_`，并在你输入中文时弹提示，
  保证推流一路稳定（**这一条是硬性的，不是建议**）；
- 若确实要中文机位名，可自行把上面那行改成
  `buf.writeUInt16BE(Buffer.byteLength(str, "utf8"), 1)`，
  推流握手即可通过；之后导播台能否正常播放该路（浏览器会把 URL 里的中文
  百分比编码，与服务端登记的原始路径是否一致）需要另行确认。
  注意这属于改动 `node_modules`，`npm install` 后会被还原。

### 2. 其他

- **H.265 那一路导播台放不出画面（不是故障）**：前端 flv.js 走浏览器 MSE，
  浏览器不提供 HEVC 解码器，所以该路 `browserPlayable=false`，导播台画面位置显示
  「编码为 H.265/HEVC，浏览器不能直接播放」。码流本身正确，用 VLC / `ffplay`
  拉 `http://<电脑IP>:8000/live/<机位名>.flv` 可正常解码。
  想在大屏直接看就用 H.264（≤4K；8K 无法用 H.264 编码）。
- **分辨率列表随机型而变**：列表来自「相机输出 ∩ 编码器支持」的真实交集，
  换一台手机档位就会变（8K 机型才出现 7680×4320）。列表为空说明相机权限被拒。
- **首次推流约 1 秒出画面**：相机打开 + 编码器首帧同步需要一点时间，属正常。
- **前置摄像头不镜像**：保证「预览 = 播出」。如需镜像效果请在导播台侧处理。
- **切换摄像头会重建会话**：约 0.5~1 秒画面中断，导播台那一格会闪一下；
  前后摄可用的分辨率/编码格式不同，切完会重新编排档位。
- **码率过高会积压**：日志里的「丢帧 / 待发」持续增长说明上行不够，降码率或降分辨率
  （8K 需要 80 Mbps 以上，基本只能走有线或 5GHz/6GHz 近距离）。
- **不要在手机热点上跑多机位**：同一手机既做 AP 又推流，稳定性差。
- **Android 13+** 首次启动会请求通知权限，拒绝后仍可推流，但通知栏不会有常驻提示（后台被杀风险变高）。

---

## 七、常见问题排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 自动发现找不到电脑 | 确认同一网段；电脑防火墙放行 1935/3001/8000；有线网卡 + 无线网卡双连时填对 IP（App 会显示「服务器内网地址」） |
| 测试连接失败 | 只填 IP，不要带 `http://` 或端口；确认 `npm run server` 在跑 |
| 「连接中…」一直不变 | 电脑没有监听 1935，或中间有防火墙；看 App 日志里 `connect 成功` 是否出现 |
| 「推流被拒绝」 | 机位名被别的设备占用了（同名会顶掉旧连接），换一个名字 |
| 有画面没声音 | 手机静音/勿扰不影响采集；检查导播台该通道的音量是否被拉到 0 |
| 画面绿屏/花屏 | 个别机型 Baseline 档位异常，App 已内置逐级降级；仍不行就把分辨率降到 720p |
| 分辨率列表里没有 8K | 该机型的 H.265 编码器不支持 7680 宽，或该摄像头传感器上限不足 8K；看界面「本机能力」那行的真实上限 |
| 选了 8K，实际画幅变成了 4K | 编码格式被固定成了 H.264（硬编码上限通常 4096 宽）。把「编码格式」改成**自动**或 H.265；日志里会写明原因 |
| 8K 只有 24/30fps | 该尺寸下编码器 `getSupportedFrameRatesFor(w,h)` 的上限如此，App 自动夹住了帧率 |
| 8K 帧率/码率被改了 | 同上：帧率按编码器上限夹、码率按 `bitrateRange` 夹，日志会显示夹到多少 |
| 导播台该格黑屏、提示 H.265 | 见「六、已知限制 2」：浏览器不能解 HEVC，改用 H.264 或 VLC/`ffplay` 拉流 |
| 拉流端卡顿 | 降码率；确认电脑不是走 Wi-Fi 回传给播放端 |
| 息屏就断 | 检查是否给了「后台运行」权限；部分国产 ROM 需在电池设置里允许自启动/后台 |

---

## 八、与导播台的关系

本 App **不改动电脑端任何代码**，只用了导播台已有的两个接口：

- `GET /api/server-info` —— 拿 `lanIp / rtmpPort / httpFlvPort / apiPort`，用于自动配对；
- RTMP `publish`（`auth.publish = false`）—— 直接推流，无需鉴权。

机位在导播台里的身份就是 `streamKey`（`live/<机位名>`），
所以「机位名唯一」这一条和用 OBS 推流时是一样的。
