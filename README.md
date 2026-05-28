# RTMP 多摄影设备管理系统

桌面级 RTMP 多路视频切换台,支持把任意一路画面推到 HDMI 显示器全屏输出。

## 系统架构

- **RTMP 服务器**:基于 `node-media-server`,接收摄影/OBS 推流
- **HTTP-FLV / WebSocket**:低延迟分发到浏览器/桌面端
- **API + Socket.io**:Express 提供流列表、输出选择 API,实时推送状态
- **桌面端 (Electron)**:整合服务与界面,支持双窗口
  - 主控窗口:多路画面预览、设备列表、输出切换
  - HDMI 输出窗口:在指定显示器全屏显示当前选中画面
- **前端 (React + Vite)**:`flv.js` 解码低延迟直播流

## 功能

- 多台摄影设备同时推流并实时预览
- 单屏 / 网格视图、单路全屏播放
- 任意流选为「主输出」,所有终端实时同步
- HDMI 输出窗口独占第二显示器,主控切换时无缝切流
- 多显示器自动检测,支持热插拔

## 端口

| 服务 | 端口 |
| --- | --- |
| RTMP 推流 | 1935 |
| HTTP-FLV / WebSocket | 8000 |
| API + Socket.io | 3001 |
| Vite 开发服务 | 5173 |

## 快速开始

### 安装依赖

```bash
npm run install-all
```

如果在国内下载 Electron 二进制慢/失败:

```bash
# Windows PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

### 开发模式(带热更新)

```bash
npm run dev
```

会同时启动:
- 后端服务(SERVER)
- Vite 开发服务(CLIENT)
- Electron 桌面应用(APP)

### 仅启动后端 + 浏览器调试

```bash
npm run server      # 终端 A
npm run client      # 终端 B,访问 http://localhost:5173
```

## 编译打包(生成可安装软件)

```bash
npm run build
```

产物在 `dist_electron/`:
- Windows: `RTMP Camera Switcher Setup x.x.x.exe`(NSIS 安装包)
- macOS: `.dmg`
- Linux: `.AppImage`

只想跑一次看效果(不打安装包):

```bash
npm run build:dir
```

可执行文件会在 `dist_electron/win-unpacked/RTMP Camera Switcher.exe`。

## 推流地址

```
rtmp://<本机IP>:1935/live/<设备名>
```

例如 OBS 中:
- 服务器: `rtmp://localhost:1935/live`
- 串流密钥: `camera1`

## HDMI 输出工作流

1. 启动桌面应用,把第二块显示器接 HDMI
2. 推流上线后在主控窗口左侧设备列表中看到设备
3. 点击设备右侧 📡 图标选为「主输出」
4. 在侧边栏「HDMI 输出」面板下拉选中外接显示器,点 ▶ 开启输出
5. 在外接显示器上会自动全屏播放当前主输出
6. 之后切换主输出,HDMI 窗口实时跟随,无需操作输出端

## 注意事项

- 中继转码功能依赖 `ffmpeg`,可选;不安装不影响 RTMP 收流和 HTTP-FLV 播放
- 输出窗口为全屏无边框,按 `Alt+F4` 或在主控点「关闭输出」退出
- 浏览器自动播放被阻止时,首次需点击画面上的播放按钮
