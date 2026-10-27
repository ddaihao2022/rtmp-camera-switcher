# RTMP Camera Switcher · RTMP 多摄影设备管理系统

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-green" />
  <img src="https://img.shields.io/badge/electron-31-47848F" />
  <img src="https://img.shields.io/badge/react-18-61DAFB" />
</p>

> Copyright © 2026 ddaihao2022. 保留所有权利 · All rights reserved.  
> 本软件已完成软件著作权登记 · Software copyright registered.

---

## 简介 · Introduction

**中文：** 桌面级多路 RTMP 视频切换台。支持多台摄影设备同时推流并实时预览，任意一路画面可一键输出到 HDMI 显示器全屏显示。内置音频混音台、本地媒体导入、水印叠加和输出录制功能。

**English:** A desktop multi-camera RTMP switcher built with Electron + React. Manage multiple live streams simultaneously, switch outputs to HDMI displays in real time, mix audio, import local media files, overlay watermarks, and record your output — all from a single interface.

---

## 功能特性 · Features

| 功能 | Feature | 说明 |
|---|---|---|
| 多路预览 | Multi-stream preview | 单屏 / 网格视图，最多同时预览 4 路 |
| HDMI 输出切换 | HDMI output switching | 任意流全屏输出到第二显示器，切换实时生效 |
| 音频混音台 | Audio mixer | 独立窗口，VU 表 + 频谱 + 音量推子 + 静音，不额外拉流 |
| 本地媒体导入 | Local media import | 将本地视频/音频作为虚拟流，与直播流同等操作 |
| 水印叠加 | Watermark overlay | 文字或图片水印，低透明度叠在输出画面上 |
| 输出录制 | Output recording | 一次录制导出两份成片：无成绩条 / 有成绩条，WebM/MP4 格式 |
| 导播台数字快捷键 | Director hotkeys | 导播台按 1–9 把该机位切到预览(PVW)，Shift+1–9 直接切主输出(PGM) |
| 设置面板 | Settings panel | 统一管理 HDMI、水印、调试日志；可拉出为独立窗口，双屏一边调参一边监看 |
| 节目单预载 | Preloaded program | 一次粘贴整天节目单（项目/轮次/组次/名册），现场按 `下一项` 或 PageDown 一键换项，不用手打名字 |
| 名册批量导入 | Batch roster import | 秩序册、报名表、Excel 一列直接粘贴导入，自动识别道次/姓名/单位/号码/最好成绩/备注 |
| 调试日志窗口 | Debug log window | 实时日志查看，支持关键词过滤和文件导出 |
| 低延迟播放 | Low-latency playback | 禁用 GOP 缓存 + 自动追播，延迟 <1 秒 |

---

## 系统架构 · Architecture

```
┌───────────────────────────────────────────────────┐
│                  Electron Main Process             │
│                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────┐  │
│  │  主控窗口    │  │  HDMI 输出   │  │  音频   │  │
│  │ Control Win │  │  Output Win  │  │ Mixer   │  │
│  │  1400×880   │  │  全屏无边框   │  │ 720×480 │  │
│  └─────────────┘  └──────────────┘  └─────────┘  │
│                                                   │
│  ┌───────────────────────┐ ┌───────────────────┐  │
│  │  设置窗口 780×920      │ │  日志窗口 900×600  │  │
│  │  Settings (可拉出)     │ │  Log Window       │  │
│  └───────────────────────┘ └───────────────────┘  │
└───────────────────────────────────────────────────┘
           │ IPC / Socket.io
┌───────────────────────────────────────────────────┐
│               Node.js Server                      │
│  node-media-server  │  Express API  │  Socket.io  │
│  RTMP :1935         │  :3001        │  实时同步    │
│  HTTP-FLV :8000     │               │             │
└───────────────────────────────────────────────────┘
           ↑ RTMP push
  OBS / 摄像机 / 编码器
```

### 端口 · Ports

| 服务 Service | 端口 Port |
|---|---|
| RTMP 推流 ingest | **1935** |
| HTTP-FLV 播放 playback | **8000** |
| API + Socket.io | **3001** |
| Vite 开发服务 dev server | **5173** |

---

## 快速开始 · Quick Start

### 环境要求 · Prerequisites

- Node.js 18+
- npm 9+

### 安装依赖 · Install

```bash
npm run install-all
```

> **国内下载 Electron 慢？Slow Electron download in China?**
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```

### 开发模式 · Development

```bash
npm run dev
```

同时启动后端服务、Vite 开发服务器和 Electron 应用。  
Starts the backend server, Vite dev server, and Electron app concurrently.

### 打包构建 · Build

```bash
npm run build
```

产物在 `dist_electron/`：
- **Windows**: `RTMP Camera Switcher Setup <version>.exe`（NSIS 安装包，当前 1.2.1）
- **macOS**: `.dmg`
- **Linux**: `.AppImage`

不打安装包，仅测试可执行文件 / Quick test without packaging:

```bash
npm run build:dir
# dist_electron/win-unpacked/RTMP Camera Switcher.exe
```

### 自测回归 · Regression Tests

```bash
npm run test:roster          # 名册 / 节目单文本解析（纯函数，16 项）
npm run test:program         # 节目单服务端语义：载入 / 切项 / 快照 / 落盘（18 项）
npm run test:port            # 端口被占用时的启动提示
npm run test:program:e2e     # 真机端到端：设置里贴节目单 → 点「下一项」/ PageDown 切项 → 名册批量导入
npm run test:settings-window # 设置独立窗口（Ctrl+, 拉出、分组、双向同步）
npm run test:package         # 打包后的成品 exe 冒烟（验证的是装出来的那个包）
```

说明：`test:program:e2e` / `test:settings-window` 的界面走的是写死的 `localhost:3001`，本机若已运行成品实例（占 3001/1935/8000/5173）会自动跳过并提示；`test:package` 会自动改用备用端口，进入「只读模式」避开正在运行的实例。

---

## 使用说明 · Usage

### 推流配置 · Streaming Setup (OBS example)

```
推流服务器 Server:  rtmp://<本机 LAN IP>:1935/live
串流密钥 Stream Key: 你的设备名 (e.g. camera1)
```

应用侧边栏会自动显示本机内网推流地址。  
The app displays the full push URL in the sidebar automatically.

### HDMI 输出工作流 · HDMI Output Workflow

1. 将第二块显示器接 HDMI / Connect a second display
2. 启动应用，推流上线后设备出现在左侧列表 / Start the app; streams appear in the sidebar
3. 点击流列表右侧 📡 按钮，或按 `Shift+数字`，选为主输出 / Click 📡 or press `Shift+number` to set as output
4. 在 **HDMI 输出** 面板下拉选中目标显示器，点 ▶ 开启输出 / Select display and click ▶
5. 输出窗口在目标显示器全屏打开 / Output window opens fullscreen on the target display
6. 切换主输出后 HDMI 窗口实时跟随，无需额外操作 / Switch source anytime — HDMI follows instantly

### 键盘快捷键 · Keyboard Shortcuts

| 按键 Key | 动作 Action |
|---|---|
| `1` – `9` | 导播台：切换第 N 路为预览 PVW（主输出不变）；单屏/网格视图：切第 N 路为输出<br>Director: set stream N as preview only; other views: set as output |
| `Shift+1` – `9` | 直接切换第 N 路为主输出 PGM，使用当前转场 / Cut stream N straight to PGM with current transition |
| `Enter` / `Space` | 导播台 TAKE：把当前预览切到主输出 / TAKE: cut preview to program |
| `T` / `Shift+T` | 田径跑表 开始·暂停 / 清零 / Track clock start-pause / reset |
| `PageDown` / `PageUp` | 节目单 下一项 / 上一项（名册自动就位）/ Program next / previous entry |
| `Ctrl+,` | 打开设置独立窗口 / Open the detached settings window |
| `Ctrl+Shift+A` | 打开音频混音台 / Open audio mixer |
| `Ctrl+Shift+L` | 开关详细日志 / Toggle verbose logging |
| `Ctrl+Shift+D` | 打开日志查看窗口 / Open log viewer |

> 输入框获焦时快捷键自动失效 / Shortcuts are disabled when a text input is focused.

### 音频混音台 · Audio Mixer

点击顶栏 **🎚 音频混音台** 或按 `Ctrl+Shift+A` 打开独立窗口。  
Click **🎚 Audio Mixer** in the header or press `Ctrl+Shift+A`.

- 每路流独立音量推子（0–150%）和静音按钮
- 实时 VU 表（RMS dB）+ 32 条频谱可视化
- 音频控制台本身**不拉流**，VU 数据由主窗口音频引擎推送，避免叠音
- 音量/静音状态通过 Socket.io 在所有窗口间实时同步

Each stream gets its own fader (0–150%) and mute button. The mixer window **does not pull a separate stream** — VU data is pushed from the main window's Web Audio engine to prevent audio doubling.

### 本地媒体 · Local Media

侧边栏 **📁 本地媒体** 面板点 **+ 添加** 导入文件（Electron 下打开系统文件对话框，支持多选）。  
Click **+ Add** in the **Local Media** panel to import files (native file dialog in Electron, multi-select supported).

支持格式 / Supported formats:
- **视频 Video**: MP4, MOV, MKV, AVI, WebM, M4V, TS, FLV, WMV
- **音频 Audio**: MP3, AAC, WAV, FLAC, M4A, OGG

导入的文件作为虚拟流注册，可点击播放、选为输出，在音频混音台中同等管理。  
Imported files are registered as virtual streams — play, select as output, and control audio just like live streams.

### 录制输出 · Recording

一次录制同时导出两份成片 / One take, two files — 停止后选一次保存目录，两份一起落盘：

| 文件 / File | 内容 / Content |
|---|---|
| `<base>_无成绩条.webm` | 输出机位原片（开启调色时为调色成片，与监看一致） |
| `<base>_有成绩条.webm` | 画面 + 叠加层烧录（田径信息条 / 比分条 / 选手介绍，与 PGM 监看一致） |

1. 先选择一路流作为输出 / Select an output stream first
2. 侧边栏 **⏺ 录制输出** 面板点 **⏺ 开始录制（同时导出 2 份）** / Click **⏺ Start Recording**
3. 点 **⏹ 停止并保存** → 选择保存目录 / Click **⏹ Stop & Save** → pick a folder

叠加层是 DOM，录制器抓不到，且媒体元素自身的 `captureStream` 在 Electron/Chromium 下不可靠
（图片素材的 `<img>` 没有该方法；flv.js 直播的 MSE `<video>` 录出来是空片），
所以两份成片都走画布合成管线：每帧 `画面 → 调色 → 叠加层`
（渲染逻辑见 `client/src/utils/scoreboardCanvas.js`、`introCanvas.js`），
音频从 Web Audio 图（`client/src/audio.js`）分出一路，音量跟随混音台推子 / 静音。
跑表读数按真实时间逐帧刷新，选手介绍的自动轮播进度也按同样节奏推进。
双路编码 CPU 占用较高；叠加层未启用（或选手介绍已隐藏）时会提示两份内容相同。

Both files are composited on a canvas — the overlay is DOM that MediaRecorder cannot capture,
and element-level `captureStream` is unreliable under Electron/Chromium (an `<img>` has no such
method, and an MSE `<video>` from flv.js records an empty file). Audio is tapped from the Web Audio
graph, so it follows the mixer's fader / mute. Two parallel encodes cost more CPU.

格式优先 WebM (VP9+Opus)，浏览器不支持时回退到 MP4。  
Format: WebM (VP9+Opus) preferred, MP4 as fallback.

### 设置 · Settings

所有设置集中在 **⚙️ 设置** 面板，分六组：赛事信息条 / 节目单 / 基础调色 / HDMI 多路输出 / 水印 / 调试日志。

把设置拉出为**独立窗口**（双屏时一边调参、一边在主控窗口监看），三种方式任选：

1. 顶栏 **⧉ 独立窗口** 按钮
2. 设置弹窗右上角 **⧉ 独立窗口** 按钮
3. 菜单 **工具 → ⚙️ 设置（独立窗口）**，或按 `Ctrl+,`

All settings live in one panel with six groups. Detach it into its own window so you can tune
parameters on a second monitor while the main window keeps showing the program feed.

- 独立窗口可自由缩放并拖到任意显示器；再点一次只聚焦已打开的窗口
- 独立窗口与主界面弹窗状态双向同步（Socket.io 广播服务端权威状态），两边修改互不覆盖
- 窗口越宽分组越多栏（≥680px 两栏、≥1120px 三栏），分组不跨栏断开
- 关闭主控窗口时独立设置窗口一并关闭

### 节目单与名册导入 · Program & Roster Import

赛程紧凑时没人有空逐个手打名字：把整天节目单**一次粘贴**进来，现场只按「下一项」。

设置 → **🗂 节目单（一键切项）** 里粘贴如下文本，点「生成节目单」：

```text
# 10:30 男子100米 预赛 第1组
3 张三 高一2班 1023 11.20
4 李四 高一3班 1024 11.35
# 10:36 男子100米 预赛 第2组
3 王五 高二1班 1088 10.98
```

- `#`、`【】`、`====` 开头的行作为**分节标题**，自动拆出时间 / 项目 / 轮次 / 组次，并推断项目类型（径赛/田赛/接力/中长跑）
- 分节标题可省略（如 `男子100米 预赛 第1组` 直接写一行）；每节内可自带一行表头（道次/姓名/单位/号码/最好成绩）
- 切项时当前道次名册会**先快照回该节**，现场补录的单位、照片、改名不会丢
- 侧栏 **田径直播** 面板出现节目单控制条：**◀ 上一项** / **下一项 ▶** / **全部 ▾**（点任意一节直接跳转）
- 快捷键 `PageDown` 下一项、`PageUp` 上一项（输入框获焦时不触发）
- 换项一次性生效：项目名、类别、轮次、组次、风速、名册全部就位，名次成绩清空、跑表归零

名册也可以单独批量导入：设置 → 赛事信息条 → 选手介绍 → **📋 批量导入名册**。```text
5 钱九 高二4班 1099 11.02      ← 道次 姓名 单位 号码 最好成绩
6 周十 高二5班 1100 11.12
王七 高三1班                    ← 不写道次时按顺序落道
```

- 支持 Excel 直接粘贴（Tab 分隔）与逗号、顿号、空格、全角逗号分隔
- 带表头（道次/姓名/单位/号码/最好成绩/备注）时按列名对齐，列序随意
- 道次按行号落位，跳号自动留空行；**覆盖**整份名册或**填空道次**（只补空位，不动已录入的）
- 也可从 `.txt` / `.csv` 文件导入；导入前有识别预览与未识别行提示

### 全屏成绩公示 · Full-screen results

每个项目结束、按「下一项 ▶」时，刚结束项目的名次和成绩会自动**盖满输出画面**：HDMI 大屏、PROGRAM 监看、以及「有成绩条」那份录像同步一致。默认停留 12 秒后自动收起。

- 侧栏「田径直播」→「🏁 成绩」：手动上屏 / 收起当前项目成绩
- 节目单控制条：勾选「成绩自动上屏」，填「秒后收起」；填 `0` 表示常显，直到手动收起
- 手机控制台 →「成绩公示」页签：同样有「立即全屏展示 / 收起 / 自动展示 / 秒数」，并提供只读公示页 `/results/` 的二维码
- 公示板只带名次、成绩、姓名、单位、号码，**不含照片和备注**；现场补录成绩时板子会同步刷新
- 已切走的上一节成绩保持原样，不会被下一节的补录覆盖

### 水印 · Watermark

点顶栏 **⚙️ 设置** → **🖼 水印** 分组。  
Click **⚙️ Settings** in the header → **🖼 Watermark** section.

- 支持文字（颜色、字号）或图片（PNG/JPG，存储为 base64）
- 5 个预设位置：左上 / 右上 / 左下 / 右下 / 居中
- 透明度默认 25%，低透明度叠加在输出画面上，使用 `mix-blend-mode: screen`
- 修改即时生效到 HDMI 输出窗口

Supports text (color, font size) or image (PNG/JPG stored as base64). Default opacity 25%, rendered with `mix-blend-mode: screen` for natural blending.

---

## 技术栈 · Tech Stack

| 层 Layer | 技术 Technology |
|---|---|
| 桌面框架 Desktop | Electron 31 |
| 前端 Frontend | React 18 + Vite 5 |
| FLV 播放 Playback | flv.js 1.6 |
| RTMP 服务 Server | node-media-server 4 |
| 实时通信 Realtime | Socket.io 4 |
| HTTP API | Express 4 |
| 音频处理 Audio | Web Audio API |
| 录制 Recording | MediaRecorder API |

---

## 开源协议 · License

本项目基于 **GNU General Public License v3.0** 开源。  
This project is licensed under the **GNU General Public License v3.0**.

详见 [LICENSE](./LICENSE) · See [LICENSE](./LICENSE) for details.

- 允许学习、使用、修改和分发 / You may use, study, modify, and distribute
- 衍生作品必须同样采用 GPL-3.0 / Derivative works must also be GPL-3.0
- **商业使用需获得著作权人书面授权 / Commercial use requires written permission from the copyright holder**

Copyright © 2024 ddaihao2022 · 软件著作权已登记 Software copyright registered  
Contact: [github.com/ddaihao2022](https://github.com/ddaihao2022)
