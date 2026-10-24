#!/usr/bin/env node
/**
 * Electron 启动包装器
 *
 * 背景：某些宿主环境（如 WorkBuddy 注入的 shell）会带 ELECTRON_RUN_AS_NODE=1，
 * 让 electron 二进制以「纯 Node 模式」运行而不是真正的 Electron 运行时。
 * 后果是内置 require('electron') 失效（解析成 npm 包的导出字符串），桌面端一启动就
 *   TypeError: Cannot read properties of undefined (reading 'isPackaged')
 * 这里在拉起 Electron 之前清掉该变量，保证它走真正的 GUI 运行时。
 *
 * 用法：package.json 的 "electron" 脚本改为 `node electron/launch.js`
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 关键：清掉导致 electron 以 node 模式运行的变量
delete process.env.ELECTRON_RUN_AS_NODE;

const projectRoot = path.join(__dirname, '..');

// 优先用与平台匹配的二进制，找不到再退回 .bin 软链（由 npm 解析）
let bin = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(bin)) {
  bin = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron');
}
if (!fs.existsSync(bin)) {
  bin = path.join(projectRoot, 'node_modules', '.bin', 'electron');
}

const child = spawn(bin, ['.'], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (err) => {
  console.error('[launch] 启动 Electron 失败:', err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
