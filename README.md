# RTMP Camera Switcher

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-green" />
  <img src="https://img.shields.io/badge/electron-31-47848F" />
</p>

A desktop multi-camera RTMP management system built with Electron + React. Manage multiple live streams, switch outputs to HDMI displays, mix audio, add watermarks, and record — all from a single interface.

> Copyright © 2024 ddaihao2022. All rights reserved.  
> This software has been registered for software copyright (软件著作权).

---

## Screenshots

| Main Control | Audio Mixer | HDMI Output |
|---|---|---|
| Multi-stream preview, device list, output selection | Per-channel VU meters, faders, mute | Full-screen output on secondary display |

---

## Features

- **Multi-stream preview** — Watch all RTMP sources simultaneously in grid or single view
- **HDMI output switching** — Send any stream to a secondary display in fullscreen, switch in real time
- **Audio mixer** — Dedicated mixer window with VU meters, frequency spectrum, per-channel volume and mute
- **Local media import** — Import local video/audio files as virtual sources; play and switch to output just like live streams
- **Watermark overlay** — Text or image watermark on the output, configurable position, opacity, size
- **Output recording** — Record the current output stream to WebM using the browser's MediaRecorder API
- **Number key switching** — Press `1`–`9` to instantly switch the output source; `Shift+1`–`9` for preview only
- **Settings panel** — Centralized settings modal for HDMI, watermark, and debug log
- **Debug log window** — Live log viewer with keyword filter, auto-scroll, and file export
- **Low-latency playback** — GOP cache bypass + buffer catch-up for sub-second latency

---

## Architecture

```
┌─────────────────────────────────────────┐
│              Electron Main              │
│  ┌──────────┐  ┌──────────┐  ┌───────┐ │
│  │ Control  │  │  HDMI    │  │ Audio │ │
│  │ Window   │  │  Output  │  │ Mixer │ │
│  │ (React)  │  │ (React)  │  │ Win   │ │
│  └──────────┘  └──────────┘  └───────┘ │
└─────────────────────────────────────────┘
         │ IPC / Socket.io
┌─────────────────────────────────────────┐
│            Node.js Server               │
│  ┌─────────────────┐  ┌──────────────┐ │
│  │ node-media-server│  │ Express API  │ │
│  │  RTMP :1935      │  │  + Socket.io │ │
│  │  HTTP-FLV :8000  │  │  :3001       │ │
│  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────┘
         ↑ RTMP push
  OBS / cameras / encoders
```

| Service | Port |
|---|---|
| RTMP ingest | 1935 |
| HTTP-FLV / WebSocket | 8000 |
| API + Socket.io | 3001 |
| Vite dev server | 5173 |

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+

### Install dependencies

```bash
npm run install-all
```

> **Slow Electron download in China?**
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```

### Development (with hot reload)

```bash
npm run dev
```

Starts the backend server, Vite dev server, and Electron app concurrently.

### Build installer

```bash
npm run build
```

Output in `dist_electron/`:
- **Windows**: `RTMP Camera Switcher Setup 1.0.0.exe` (NSIS installer)
- **macOS**: `.dmg`
- **Linux**: `.AppImage`

Quick test without packaging:

```bash
npm run build:dir
# Executable: dist_electron/win-unpacked/RTMP Camera Switcher.exe
```

---

## Usage

### Streaming setup (OBS example)

```
Server:     rtmp://<your-LAN-IP>:1935/live
Stream Key: camera1
```

The app auto-detects your LAN IP and shows the full push URL in the sidebar.

### HDMI output workflow

1. Connect a second display via HDMI
2. Start the app and push streams from your cameras/OBS
3. Click the 📡 button next to a stream to set it as the main output
4. In the **HDMI Output** panel, select the target display and click **▶ Start Output**
5. The output window opens fullscreen on the selected display
6. Switch output anytime — the HDMI window follows instantly

### Keyboard shortcuts

| Key | Action |
|---|---|
| `1` – `9` | Switch output to stream N (also updates preview) |
| `Shift+1` – `9` | Preview stream N without changing output |
| `Ctrl+Shift+A` | Open audio mixer window |
| `Ctrl+Shift+L` | Toggle verbose logging |
| `Ctrl+Shift+D` | Open log viewer window |

### Audio mixer

Open via the **🎚 Audio Mixer** button in the header or `Ctrl+Shift+A`.  
Each active stream gets its own channel strip with:
- Frequency spectrum visualizer
- VU meter with peak hold
- Vertical fader (0–150%)
- Per-channel mute

Volume/mute state syncs across all windows via Socket.io.

### Local media

Click **+ Add** in the **Local Media** section to import video or audio files.  
Imported files appear in the source list and can be selected as output just like live streams.

### Recording

Select an output stream first, then use the **⏺ Record Output** panel in the sidebar.  
Recordings are saved as `.webm` via a system save dialog.

### Watermark

Open **⚙️ Settings** → **Watermark**.  
Supports text (custom font size, color) or image (PNG/JPG), with position, opacity, and padding controls.  
Changes apply to the HDMI output window in real time.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 31 |
| Frontend | React 18 + Vite 5 |
| Streaming | node-media-server v4 |
| FLV playback | flv.js 1.6 |
| Realtime sync | Socket.io 4 |
| HTTP API | Express 4 |
| Audio processing | Web Audio API |
| Recording | MediaRecorder API |

---

## License

This project is licensed under the **GNU General Public License v3.0**.  
See [LICENSE](./LICENSE) for the full text.

Copyright © 2024 ddaihao2022. Software copyright registered.  
You may use, study, and modify this software under the terms of GPL-3.0.  
Any derivative work must also be distributed under GPL-3.0.  
**Commercial use without written permission from the copyright holder is not permitted.**
