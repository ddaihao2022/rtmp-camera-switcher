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
| 输出录制 | Output recording | 录制当前输出画面，WebM/MP4 格式，系统对话框保存 |
| 数字快捷键 | Number key switching | 按 1–9 直接切换输出源 |
| 设置面板 | Settings panel | 统一的设置弹窗管理 HDMI、水印、调试日志 |
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
│  ┌─────────────────────────────────────────────┐  │
│  │       日志窗口 Log Window  900×600           │  │
│  └─────────────────────────────────────────────┘  │
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
- **Windows**: `RTMP Camera Switcher Setup 1.0.0.exe`（NSIS 安装包）
- **macOS**: `.dmg`
- **Linux**: `.AppImage`

不打安装包，仅测试可执行文件 / Quick test without packaging:

```bash
npm run build:dir
# dist_electron/win-unpacked/RTMP Camera Switcher.exe
```

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
3. 点击流列表右侧 📡 按钮，或按数字键，选为主输出 / Click 📡 or press a number key to set as output
4. 在 **HDMI 输出** 面板下拉选中目标显示器，点 ▶ 开启输出 / Select display and click ▶
5. 输出窗口在目标显示器全屏打开 / Output window opens fullscreen on the target display
6. 切换主输出后 HDMI 窗口实时跟随，无需额外操作 / Switch source anytime — HDMI follows instantly

### 键盘快捷键 · Keyboard Shortcuts

| 按键 Key | 动作 Action |
|---|---|
| `1` – `9` | 切换第 N 路为输出（同时切换预览）/ Switch stream N as output (also updates preview) |
| `Shift+1` – `9` | 仅切换预览，不改变输出 / Preview only, output unchanged |
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

1. 先选择一路流作为输出 / Select an output stream first
2. 侧边栏 **⏺ 录制输出** 面板点 **⏺ 开始录制** / Click **⏺ Start Recording**
3. 点 **⏹ 停止并保存** 后弹出系统保存对话框 / Click **⏹ Stop & Save** → system save dialog

格式优先 WebM (VP9+Opus)，浏览器不支持时回退到 MP4。  
Format: WebM (VP9+Opus) preferred, MP4 as fallback.

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
