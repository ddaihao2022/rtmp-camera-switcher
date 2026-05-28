# 部署指南

## 本地开发环境

### 1. 安装依赖

```bash
# 安装服务器依赖
npm install

# 安装客户端依赖
cd client
npm install
cd ..
```

### 2. 启动服务

```bash
# 终端1: 启动RTMP服务器
npm run server

# 终端2: 启动Web界面
npm run dev
```

### 3. 访问系统

- Web管理界面: http://localhost:3000
- RTMP推流地址: rtmp://localhost:1935/live/[设备名称]

## 摄影设备配置

### OBS Studio配置

1. 打开OBS Studio
2. 设置 -> 推流
3. 服务: 自定义
4. 服务器: `rtmp://your-server-ip:1935/live`
5. 串流密钥: `camera1` (或其他设备名称)

### 硬件摄影机配置

大多数支持RTMP的摄影机可以在网络设置中配置:
- RTMP URL: `rtmp://your-server-ip:1935/live/camera1`
- 分辨率: 1920x1080 (推荐)
- 码率: 2500-5000 kbps
- 帧率: 25-30 fps

## 生产环境部署

### 使用PM2管理进程

```bash
# 安装PM2
npm install -g pm2

# 启动服务器
pm2 start server/index.js --name rtmp-server

# 构建客户端
cd client
npm run build

# 使用nginx或其他web服务器托管dist目录
```

### Nginx配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        root /path/to/client/dist;
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /socket.io {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

## 防火墙配置

确保以下端口开放:
- 1935 (RTMP)
- 8000 (HLS)
- 3000 (Web界面，开发环境)
- 3001 (API服务器)

## 性能优化建议

1. **服务器配置**: 至少2核CPU，4GB内存
2. **网络带宽**: 每路1080p流需要约5Mbps上行带宽
3. **FFmpeg优化**: 根据需要调整转码参数
4. **CDN加速**: 对于多用户观看，建议使用CDN

## 故障排查

### 推流失败
- 检查RTMP端口1935是否开放
- 确认推流地址格式正确
- 查看服务器日志

### 播放卡顿
- 检查网络带宽
- 降低推流码率
- 调整HLS分片大小

### 无法连接Web界面
- 确认所有服务都已启动
- 检查防火墙设置
- 查看浏览器控制台错误
