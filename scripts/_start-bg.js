#!/usr/bin/env node
/**
 * 一次性后台启动器：把 server / client(vite) / electron 三个进程
 * 以 detached 模式拉起（脱离当前 shell/任务系统），日志落盘到
 * %TEMP%\rtmp-logs\，然后本脚本立即退出。
 *
 * 背景：在某些宿主环境里，挂在其「后台任务」上的长驻进程会随任务
 * 回收被连带杀掉；detached + unref 的进程不受影响。
 *
 * 用法：node scripts/_start-bg.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
const logDir = path.join(os.tmpdir(), 'rtmp-logs');
fs.mkdirSync(logDir, { recursive: true });

// 环境变量拷贝，清掉会让 electron 以 node 模式运行的坑
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const jobs = [
  { name: 'server', args: ['server/index.js'], cwd: root },
  { name: 'client', args: ['node_modules/vite/bin/vite.js'], cwd: path.join(root, 'client') },
  { name: 'electron', args: ['electron/launch.js'], cwd: root },
];

for (const j of jobs) {
  const outPath = path.join(logDir, `${j.name}.out.log`);
  const errPath = path.join(logDir, `${j.name}.err.log`);
  const out = fs.openSync(outPath, 'a');
  const err = fs.openSync(errPath, 'a');
  fs.appendFileSync(out, `\n==== start ${new Date().toLocaleString()} pid=待定 ====\n`);

  const child = spawn(process.execPath, j.args, {
    cwd: j.cwd,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    env,
  });
  fs.appendFileSync(out, `==== start ${new Date().toLocaleString()} pid=${child.pid} ====\n`);
  child.unref();
  console.log(`${j.name}: pid=${child.pid} -> ${outPath}`);
}
